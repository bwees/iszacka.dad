#!/usr/bin/env bash
# smoke.sh: end-to-end smoke test for iszacka.dad.
#
# Walks the whole URL map in docs/ARCHITECTURE.md with curl, checking status codes, content
# types, headers and key strings; speaks MCP (JSON-RPC), WebSocket and SSE; and with
# --mutate logs in to /admin, presses the big red button (to NOT YET), checks that the API
# and an open WebSocket both noticed, then puts the answer back to NO.
#
# Usage:
#   bash scripts/smoke.sh <base-url> [--mutate]
#
#   bash scripts/smoke.sh http://localhost:8787 --mutate   # local dev / CI
#   bash scripts/smoke.sh https://iszacka.dad              # production, read-only
#
# Environment:
#   ADMIN_PASSWORD   admin password for --mutate (default: dev, as in .dev.vars.example)
#   SMOKE_TIMEOUT    per-request timeout in seconds (default: 20)
#   SMOKE_ORIGIN     Origin header for same-origin POSTs (default: what the server thinks it is)
#   SMOKE_ALLOW_PRODUCTION_MUTATION=1
#                    allow --mutate against a host that isn't localhost or *.workers.dev
#
# Needs bash, curl, jq and node 22+ (for the WebSocket check). xmllint or python3 make the
# XML checks stricter. Exits 0 when every check passes, 1 when any fails, 2 on usage errors.
#
# Coverage: every path in the ARCHITECTURE.md URL map appears in this file, either as a
# request or in the skip list below; test/infra-smoke-coverage.test.ts fails CI otherwise.
# Never exercised, because a smoke test shouldn't have side effects like these:
#   smoke:skip /admin/test-email   sends a real email
#   smoke:skip /admin/due-date     moves the countdown everyone is watching

set -euo pipefail

# The header comment above, as help text.
help_text() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

usage() {
	help_text >&2
	exit 2
}

BASE=""
MUTATE=0
for arg in "$@"; do
	case $arg in
		--mutate) MUTATE=1 ;;
		-h | --help)
			help_text
			exit 0
			;;
		-*)
			echo "smoke: unknown option: $arg" >&2
			usage
			;;
		*)
			if [[ -n $BASE ]]; then usage; fi
			BASE=$arg
			;;
	esac
done
if [[ -z $BASE ]]; then usage; fi
BASE=${BASE%/}
if [[ ! $BASE =~ ^(https?)://([^/:]+)(:[0-9]+)?$ ]]; then
	echo "smoke: base URL must look like http(s)://host[:port] with no path, got: $BASE" >&2
	exit 2
fi
SCHEME=${BASH_REMATCH[1]}
HOSTNAME_ONLY=${BASH_REMATCH[2]}
HOST_PORT=${BASH_REMATCH[2]}${BASH_REMATCH[3]}
WS_BASE=${BASE/#http/ws}

for tool in curl jq node; do
	if ! command -v "$tool" >/dev/null; then
		echo "smoke: $tool is required" >&2
		exit 2
	fi
done

TIMEOUT=${SMOKE_TIMEOUT:-20}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-dev}
BROWSER_UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) iszacka.dad-smoke/1.0'
HTML_ACCEPT='text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
BOGUS=smoke-not-a-real-token
EVIL_ORIGIN=https://evil.example

WORK=$(mktemp -d "${TMPDIR:-/tmp}/iszackadad-smoke.XXXXXX")
HEADERS=$WORK/headers
BODY=$WORK/body
CURL_ERR=$WORK/curl-error
JAR=$WORK/cookies

PASSED=0
FAILED=0
SKIPPED=0
FAILURES=()
STATUS=000
CURL_EXIT=0
ALLOW_CURL_EXIT="" # curl exit codes that are fine for the current request (space-separated)
CHECK=""
ERRORS=""
FLIPPED=0
WATCHER_PID=""

# ─── Output ────────────────────────────────────────────────────────────────────

section() { printf '\n── %s ──\n' "$1"; }

pass() {
	PASSED=$((PASSED + 1))
	printf '✅ %s\n' "$1"
}

fail() {
	FAILED=$((FAILED + 1))
	FAILURES+=("$1")
	printf '❌ %s\n   %s\n' "$1" "$2"
	if [[ -s $BODY ]]; then
		printf '   body: %s\n' "$(LC_ALL=C tr -cd '[:print:]\t' <"$BODY" | head -c 240)"
	fi
}

skip() {
	SKIPPED=$((SKIPPED + 1))
	printf '⏭️  %s (%s)\n' "$1" "$2"
}

# ─── HTTP ──────────────────────────────────────────────────────────────────────

# request METHOD PATH [curl args...]: sets STATUS and CURL_EXIT; headers in $HEADERS, body in $BODY.
request() {
	local method=$1 path=$2
	shift 2
	: >"$HEADERS"
	: >"$BODY"
	: >"$CURL_ERR"
	CURL_EXIT=0
	STATUS=$(curl --silent --show-error --max-time "$TIMEOUT" --request "$method" \
		--user-agent "$BROWSER_UA" --dump-header "$HEADERS" --output "$BODY" \
		--write-out '%{http_code}' "$@" "$BASE$path" 2>"$CURL_ERR") || CURL_EXIT=$?
	[[ $STATUS =~ ^[0-9]{3}$ ]] || STATUS=000
}

# header NAME: a response header's value. With redirects followed, only the final response counts.
header() {
	local name
	name=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
	tr -d '\r' <"$HEADERS" | awk -v want="$name" '
		/^HTTP\// { found = ""; next }
		{ i = index($0, ":"); if (i > 0 && tolower(substr($0, 1, i - 1)) == want) { v = substr($0, i + 1); sub(/^[ \t]+/, "", v); found = v } }
		END { print found }'
}

content_type() { header content-type | tr '[:upper:]' '[:lower:]'; }

# ─── Assertions (they collect problems; finish reports the check) ─────────────

begin() {
	CHECK=$1
	ERRORS=""
	: >"$BODY"
}

problem() { ERRORS="${ERRORS:+$ERRORS; }$1"; }

finish() {
	if [[ -z $ERRORS ]]; then pass "$CHECK"; else fail "$CHECK" "$ERRORS"; fi
}

# expect_status CODE...: any of the given codes; "4xx" style classes allowed.
expect_status() {
	local want
	if [[ $CURL_EXIT != 0 && " $ALLOW_CURL_EXIT " != *" $CURL_EXIT "* ]]; then
		problem "curl failed (exit $CURL_EXIT): $(tr -d '\n' <"$CURL_ERR")"
		return 0
	fi
	for want in "$@"; do
		if [[ $want == ?xx && ${STATUS:0:1} == "${want:0:1}" ]]; then return 0; fi
		if [[ $STATUS == "$want" ]]; then return 0; fi
	done
	problem "HTTP $STATUS, wanted $*"
}

expect_type() {
	local ct
	ct=$(content_type)
	if [[ ! $ct =~ $1 ]]; then problem "content-type '${ct:-none}' doesn't match /$1/"; fi
}

expect_header() {
	local value
	value=$(header "$1")
	if [[ ! $value =~ $2 ]]; then problem "$1 '${value:-missing}' doesn't match /$2/"; fi
}

expect_body() {
	if ! grep -Eq -- "$1" "$BODY"; then problem "body doesn't match /$1/"; fi
}

expect_body_i() {
	if ! grep -Eiq -- "$1" "$BODY"; then problem "body doesn't match /$1/i"; fi
}

expect_no_body_i() {
	if grep -Eiq -- "$1" "$BODY"; then problem "body unexpectedly matches /$1/i"; fi
}

expect_nonempty() {
	if [[ ! -s $BODY ]]; then problem "empty body"; fi
}

# expect_json FILTER [jq options...]: the body is JSON and FILTER is truthy.
expect_json() {
	local filter=$1
	shift
	if ! jq empty "$BODY" >/dev/null 2>&1; then
		problem "body isn't valid JSON"
		return 0
	fi
	if ! jq -e "$@" "$filter" "$BODY" >/dev/null 2>&1; then problem "JSON check failed: $filter"; fi
}

# expect_xml ROOT_REGEX: the body is well-formed XML and mentions ROOT_REGEX.
expect_xml() {
	if command -v xmllint >/dev/null; then
		if ! xmllint --noout --nonet "$BODY" 2>/dev/null; then problem "body isn't well-formed XML (xmllint)"; fi
	elif command -v python3 >/dev/null; then
		if ! python3 -I -c 'import sys, xml.dom.minidom; xml.dom.minidom.parse(sys.argv[1])' "$BODY" 2>/dev/null; then
			problem "body isn't well-formed XML (python3)"
		fi
	elif ! grep -Eq '^[[:space:]]*<' "$BODY"; then
		problem "body doesn't look like XML"
	fi
	expect_body "$1"
}

# The headers the root middleware puts on every dynamic response.
expect_dynamic_headers() {
	expect_header x-is-zack-a-dad "^${EXPECTED_HEADER_RE}\$"
	if ! tr -d '\r' <"$HEADERS" | grep -Eiq '^server-timing:.*app;dur='; then problem "Server-Timing lacks app;dur="; fi
	expect_header strict-transport-security 'max-age=[0-9]+'
	expect_header x-content-type-options '^nosniff$'
}

expect_csp() {
	local csp
	csp=$(header content-security-policy)
	if [[ -z $csp ]]; then
		problem "no Content-Security-Policy"
		return 0
	fi
	# Either the site-wide policy or something stricter (the OG card allows nothing at all).
	if [[ $csp == *"default-src 'none'"* ]]; then
		:
	elif [[ $csp == *"default-src 'self'"* ]]; then
		if [[ $csp != *"object-src 'none'"* ]]; then problem "CSP lacks object-src 'none'"; fi
	else
		problem "CSP default-src is neither 'self' nor 'none'"
	fi
	if [[ $csp =~ script-src[^\;]*unsafe-inline ]]; then problem "CSP allows inline scripts"; fi
}

# ─── Check helpers ─────────────────────────────────────────────────────────────

# html_page PATH [BODY_REGEX]: a server-rendered page.
html_page() {
	begin "GET $1 is an HTML page"
	request GET "$1" --header "Accept: $HTML_ACCEPT"
	expect_status 200
	expect_type '^text/html'
	expect_dynamic_headers
	expect_csp
	if [[ -n ${2:-} ]]; then expect_body_i "$2"; fi
	finish
}

# asset PATH TYPE_REGEX: a static file from public/. Redirects are followed, because the asset
# server sends /offline.html to /offline (html_handling) and that's fine.
asset() {
	begin "GET $1 ($2)"
	request GET "$1" --location
	expect_status 200
	expect_type "$2"
	expect_nonempty
	finish
}

# json_endpoint PATH [FILTER [jq options...]]
json_endpoint() {
	local path=$1
	shift
	begin "GET $path is JSON"
	request GET "$path" --header 'Accept: application/json'
	expect_status 200
	expect_type 'json'
	expect_dynamic_headers
	if [[ $# -gt 0 ]]; then expect_json "$@"; else expect_json 'type == "object" or type == "array"'; fi
	finish
}

# needs_login PATH: an admin page that bounces anonymous visitors to the login form.
needs_login() {
	begin "GET $1 without a session redirects to the login page"
	request GET "$1"
	expect_status 302 303 307
	expect_header location '/admin/login'
	finish
}

# refuses_anonymous PATH: an admin action that does nothing for anonymous visitors.
refuses_anonymous() {
	begin "POST $1 without a session is refused"
	request POST "$1" --header "Origin: $ORIGIN" --data 'status=smoke-test-not-a-status'
	expect_status 302 303 401 403
	if [[ ${STATUS:0:1} == 3 ]]; then expect_header location '/admin/login'; fi
	finish
}

# survives NAME METHOD PATH [curl args...]: nonsense input gets a 2xx-4xx answer, never a crash.
survives() {
	local name=$1 method=$2 path=$3
	shift 3
	begin "$name"
	request "$method" "$path" "$@"
	expect_status 2xx 3xx 4xx
	finish
}

# ─── Live (WebSocket / SSE) ────────────────────────────────────────────────────

# node: connect to the WebSocket, expect a hello for $2 (status); with $3 == vibe, send a
# vibe and wait for the vibes broadcast; with $3 == watch:<status>, touch the ready file $4
# after the hello and wait for a state message with that status.
# shellcheck disable=SC2016 # JavaScript, not shell.
WS_SCRIPT='
const [url, expected, mode = "", readyFile = ""] = process.argv.slice(1);
const fs = require("node:fs");
const limit = mode.startsWith("watch:") ? 30000 : 10000;
let stage = "hello";
const fail = (message) => { console.error(message); process.exit(1); };
const timer = setTimeout(() => fail(`timed out waiting for ${stage} after ${limit / 1000}s`), limit);
const ws = new WebSocket(url);
const done = (note) => {
	stage = "done";
	clearTimeout(timer);
	console.log(note);
	ws.close();
	setTimeout(() => process.exit(0), 50);
};
ws.addEventListener("error", (event) => fail(`WebSocket error${event.message ? `: ${event.message}` : ""}`));
ws.addEventListener("close", (event) => { if (stage !== "done") fail(`closed during ${stage} (code ${event.code})`); });
ws.addEventListener("message", (event) => {
	let msg;
	try { msg = JSON.parse(String(event.data)); } catch { return fail(`non-JSON message: ${String(event.data).slice(0, 80)}`); }
	if (stage === "hello") {
		if (msg.type !== "hello") return fail(`first message was "${msg.type}", not "hello"`);
		if (msg.state?.status !== expected) return fail(`hello says "${msg.state?.status}", expected "${expected}"`);
		for (const key of ["viewers", "vibes", "checks"]) if (typeof msg[key] !== "number") return fail(`hello.${key} is not a number`);
		if (typeof msg.reloadNonce !== "string") return fail("hello.reloadNonce is missing");
		if (mode === "vibe") { stage = "vibes"; ws.send(JSON.stringify({ type: "vibe", emoji: "\u{1F37C}" })); return; }
		if (mode.startsWith("watch:")) { stage = "state"; if (readyFile) fs.writeFileSync(readyFile, "ready"); return; }
		return done(`hello: ${msg.viewers} viewer(s), ${msg.vibes} vibe(s), ${msg.checks} check(s)`);
	}
	if (stage === "vibes" && msg.type === "vibes" && typeof msg.vibes === "number") return done(`vibes now ${msg.vibes}`);
	if (stage === "state" && msg.type === "state" && msg.state?.status === mode.slice(6)) return done(`saw state ${msg.state.status}`);
});
'

websocket_check() { # name expected-status [mode]
	local out
	begin "$1"
	if out=$(node -e "$WS_SCRIPT" "$WS_BASE/ws" "$2" "${3:-}" 2>&1); then
		CHECK="$1 ($out)"
	else
		problem "$out"
	fi
	finish
}

# ─── Bookkeeping ───────────────────────────────────────────────────────────────

# If --mutate pressed the button and something went wrong before it was put back, put it back.
restore_status() {
	if [[ $FLIPPED == 1 ]]; then
		echo "Putting the answer back to NO…"
		if curl --silent --max-time "$TIMEOUT" --cookie "$JAR" --header "Origin: $ORIGIN" \
			--header 'Accept: application/json' --data 'status=no&confirm=NO' \
			"$BASE/admin/status" | jq -e '.ok == true' >/dev/null 2>&1; then
			echo "Restored."
		else
			echo "⚠️  Couldn't restore the answer to NO. Fix it by hand in /admin." >&2
		fi
	fi
}

cleanup() {
	local code=$?
	restore_status || true
	if [[ -n $WATCHER_PID ]]; then kill "$WATCHER_PID" 2>/dev/null || true; fi
	rm -rf "$WORK"
	exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Wait for one-second state caches (per isolate) to expire after a write.
settle() { sleep 1.2; }

# ─── First contact ─────────────────────────────────────────────────────────────

echo "Smoke testing $BASE$([[ $MUTATE == 1 ]] && echo ' (with --mutate)')"

request GET /
if [[ $STATUS == 000 ]]; then
	echo "❌ Can't reach $BASE: $(tr -d '\n' <"$CURL_ERR")" >&2
	exit 1
fi

case $(header x-is-zack-a-dad) in
	no) CURRENT=no ;;
	'not yet (it is happening)') CURRENT=soon ;;
	yes) CURRENT=yes ;;
	*) CURRENT=unknown ;;
esac

header_re_for() {
	case $1 in
		no) printf 'no' ;;
		soon) printf 'not yet \\(it is happening\\)' ;;
		yes) printf 'yes' ;;
		*) printf '(no|yes|not yet \\(it is happening\\))' ;;
	esac
}
EXPECTED_HEADER_RE=$(header_re_for "$CURRENT")
echo "The site currently says: $CURRENT"

# What origin does the Worker think it's serving? (Plain `wrangler dev` pretends every request
# arrived at the first route, iszacka.dad, unless run with --infer-origin-from-routes=false.)
SERVER_HOST=$(header content-security-policy | sed -n 's/.*connect-src[^;]*wss:\/\/\([^ ;]*\).*/\1/p')
SERVER_ORIGIN=$BASE
if [[ -n $SERVER_HOST && $SERVER_HOST != "$HOST_PORT" ]]; then
	if header content-security-policy | grep -q "ws://$SERVER_HOST"; then
		SERVER_ORIGIN="http://$SERVER_HOST"
	else
		SERVER_ORIGIN="https://$SERVER_HOST"
	fi
	echo "ℹ️  The Worker thinks it is $SERVER_ORIGIN (start wrangler dev with --infer-origin-from-routes=false to fix)."
fi
ORIGIN=${SMOKE_ORIGIN:-$SERVER_ORIGIN}

# ─── Pages ─────────────────────────────────────────────────────────────────────

section "Pages"

begin "GET / answers the question"
request GET /
expect_status 200
expect_type '^text/html'
expect_dynamic_headers
expect_csp
expect_header referrer-policy '.'
expect_body_i 'zack'
finish

if [[ $CURRENT == unknown ]]; then
	begin "X-Is-Zack-A-Dad is one of the three answers"
	problem "got '$(header x-is-zack-a-dad)'"
	finish
fi

begin "GET / with Accept-Language: de still answers"
request GET / --header 'Accept-Language: de-DE,de;q=0.9'
expect_status 200
expect_type '^text/html'
finish

begin "curl gets ASCII art on /"
request GET / --user-agent 'curl/8.11.1'
expect_status 200
expect_type '^text/plain'
expect_dynamic_headers
expect_no_body_i '<html|<!doctype'
expect_body '[^[:space:]]'
finish

html_page /updates
begin "GET /updates/999999999 is a 404"
request GET /updates/999999999
expect_status 404
expect_type '^text/html'
finish
html_page /everything
html_page '/og/card?status=yes'
html_page /stats
html_page /pool
html_page /status
html_page /certificate
html_page /poster
html_page /ready
html_page /wall
html_page /names
html_page /ledger
html_page /subscribe '<form'
html_page /api

begin "Unknown pages get a 404 page"
request GET /smoke-test-this-page-does-not-exist
expect_status 404
expect_type '^text/html'
expect_body_i 'noindex'
finish

if [[ $HOSTNAME_ONLY == www.* || $HOSTNAME_ONLY == *.workers.dev || $HOSTNAME_ONLY =~ ^[0-9.]+$ ]]; then
	skip "www. redirect" "no www. host here"
elif [[ $HOSTNAME_ONLY =~ ^(localhost|127\.[0-9.]+|\[::1\])$ ]]; then
	if [[ $SERVER_ORIGIN != "$BASE" ]]; then
		skip "www. redirect" "wrangler dev is rewriting the Host header"
	else
		begin "www. redirects to the bare domain"
		request GET '/smoke-www?x=1' --header "Host: www.$HOST_PORT"
		expect_status 301 308
		expect_header location "^https://$HOSTNAME_ONLY/smoke-www\\?x=1\$"
		finish
	fi
else
	begin "www.$HOSTNAME_ONLY redirects to $HOSTNAME_ONLY"
	STATUS=$(curl --silent --show-error --max-time "$TIMEOUT" --dump-header "$HEADERS" --output "$BODY" \
		--write-out '%{http_code}' "$SCHEME://www.$HOST_PORT/smoke-www?x=1" 2>"$CURL_ERR") || CURL_EXIT=$?
	expect_status 301 308
	expect_header location "^https://$HOSTNAME_ONLY/smoke-www\\?x=1\$"
	finish
	CURL_EXIT=0
fi

# ─── Static assets ─────────────────────────────────────────────────────────────

section "Static assets"

asset /styles.css '^text/css'
asset /app.js 'javascript'
for path in /favicon-no.svg /favicon-soon.svg /favicon-yes.svg; do
	asset "$path" '^image/svg\+xml'
done
for path in /icons/icon-192.png /icons/icon-512.png /icons/maskable-512.png /icons/apple-touch-icon.png; do
	asset "$path" '^image/png'
done
for path in /og/no.png /og/soon.png /og/yes.png; do
	asset "$path" '^image/png'
done
asset /embed.js 'javascript'
asset /push.js 'javascript'
asset /sw.js 'javascript'
asset /offline.html '^text/html'
asset /social.js 'javascript'
asset /social.css '^text/css'
asset /world-map.LICENSE.txt '^text/plain'

begin "GET /world-map.svg is a world map keyed by country"
request GET /world-map.svg
expect_status 200
expect_type '^image/svg\+xml'
expect_body '<svg'
expect_body 'data-cc="GB"'
expect_body 'Natural Earth'
if [[ $(wc -c <"$BODY") -gt 153600 ]]; then problem "bigger than 150 KB"; fi
finish

begin "GET /manifest.webmanifest is a web app manifest"
request GET /manifest.webmanifest
expect_status 200
expect_type 'json'
expect_json '(.name | type == "string") and (.icons | length > 0) and (.start_url | type == "string")'
finish

# ─── Feeds & machine-readable bits ─────────────────────────────────────────────

section "Feeds"

for path in /feed.xml /rss.xml; do
	begin "GET $path is RSS"
	request GET "$path"
	expect_status 200
	expect_type 'xml'
	expect_xml '<rss[[:space:]]'
	expect_body '<channel>'
	finish
done

begin "GET /atom.xml is Atom"
request GET /atom.xml
expect_status 200
expect_type 'xml'
expect_xml '<feed[[:space:]][^>]*xmlns="http://www.w3.org/2005/Atom"'
finish

begin "GET /feed.json is a JSON Feed"
request GET /feed.json
expect_status 200
expect_type 'json'
expect_json '(.version | startswith("https://jsonfeed.org/version/1")) and (.title | type == "string") and (.items | type == "array")'
finish

begin "GET /calendar.ics is iCalendar"
request GET /calendar.ics
expect_status 200
expect_type '^text/calendar'
expect_body '^BEGIN:VCALENDAR'
expect_body '^VERSION:2\.0'
expect_body '^END:VCALENDAR'
finish

begin "GET /badge.svg is an SVG badge"
request GET /badge.svg
expect_status 200
expect_type '^image/svg\+xml'
expect_xml '<svg[[:space:]]'
finish

begin "GET /embed can be framed anywhere"
request GET /embed
expect_status 200
expect_type '^text/html'
expect_header content-security-policy 'frame-ancestors \*'
finish

begin "GET /sitemap.xml is a sitemap"
request GET /sitemap.xml
expect_status 200
expect_type 'xml'
expect_xml '<urlset[[:space:]]'
expect_body '<loc>'
finish

begin "GET /robots.txt"
request GET /robots.txt
expect_status 200
expect_type '^text/plain'
expect_body_i '^user-agent:'
expect_body_i '^sitemap:[[:space:]]*https?://'
finish

begin "GET /.well-known/security.txt follows RFC 9116"
request GET /.well-known/security.txt
expect_status 200
expect_type '^text/plain'
expect_body_i '^contact:'
expect_body_i '^expires:'
finish

begin "GET /llms.txt"
request GET /llms.txt
expect_status 200
expect_type '^text/(plain|markdown)'
expect_body '^# '
finish

begin "GET /humans.txt"
request GET /humans.txt
expect_status 200
expect_type '^text/plain'
expect_nonempty
finish

# ─── API ───────────────────────────────────────────────────────────────────────

section "API"

# shellcheck disable=SC2016 # $s is a jq variable, not a shell one.
for path in /api/status /api/status.json; do
	json_endpoint "$path" \
		'.status == $s and .isZackADad == ($s == "yes") and (.statusChangedAt | type == "string")' \
		--arg s "$CURRENT"
done

begin "GET /api/status.txt"
request GET /api/status.txt
expect_status 200
expect_type '^text/plain'
case $CURRENT in
	no) expect_body_i '(^|[^a-z])no([^a-z]|$)' ;;
	soon) expect_body_i 'not yet|happening' ;;
	yes) expect_body_i '(^|[^a-z])yes([^a-z]|$)' ;;
esac
finish

json_endpoint /api/history
json_endpoint /api/updates
json_endpoint /api/live

begin "GET /api/countries counts checks per country, cached, for anyone"
request GET /api/countries --header 'Accept: application/json' --header 'Origin: https://example.com'
expect_status 200
expect_type 'json'
expect_dynamic_headers
expect_header access-control-allow-origin '^\*$'
expect_header cache-control 'max-age=[0-9]+'
expect_json '(.countries | type == "array") and (.total | type == "number") and all(.countries[]; (.country | test("^([A-Z]{2}|T1)$")) and (.n | type == "number") and (.name | type == "string"))'
finish

begin "GET / has the social panels (DADCON, anxiety, map, feed)"
request GET / --header "Accept: $HTML_ACCEPT"
expect_status 200
expect_body 'data-dadcon'
expect_body 'DADCON [0-5]'
expect_body 'data-anxiety data-level="(calm|elevated|frantic|meltdown)"'
expect_body 'data-world-map'
expect_body 'data-checkfeed'
expect_body 'src="/social\.js"'
finish

begin "GET /api/dad is $([[ $CURRENT == yes ]] && echo '201 Created' || echo '425 Too Early')"
request GET /api/dad --header 'Accept: application/json'
if [[ $CURRENT == yes ]]; then expect_status 201; else expect_status 425; fi
expect_dynamic_headers
finish

begin "GET /openapi.json is an OpenAPI 3 document"
request GET /openapi.json
expect_status 200
expect_type 'json'
expect_json '(.openapi | startswith("3")) and (.paths["/api/status"] != null)'
finish

# ─── MCP ───────────────────────────────────────────────────────────────────────

section "MCP"

MCP_SESSION=""
MCP_VERSION=""
mcp_post() {
	local args=(--header 'Content-Type: application/json' --header 'Accept: application/json, text/event-stream' --data "$1")
	if [[ -n $MCP_SESSION ]]; then args+=(--header "Mcp-Session-Id: $MCP_SESSION"); fi
	if [[ -n $MCP_VERSION ]]; then args+=(--header "MCP-Protocol-Version: $MCP_VERSION"); fi
	request POST /mcp "${args[@]}"
	# Streamable HTTP may answer with an SSE stream: keep the last JSON-RPC message in it.
	if [[ $(content_type) == text/event-stream* ]]; then
		tr -d '\r' <"$BODY" | sed -n 's/^data: \{0,1\}//p' | tail -n 1 >"$BODY.json"
		mv "$BODY.json" "$BODY"
	fi
}

begin "MCP initialize"
mcp_post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"iszacka.dad smoke test","version":"1.0.0"}}}'
expect_status 200
expect_json '.jsonrpc == "2.0" and .id == 1 and (.result.protocolVersion | type == "string") and (.result.serverInfo.name | type == "string") and (.result.capabilities.tools != null)'
MCP_SESSION=$(header mcp-session-id)
MCP_VERSION=$(jq -r '.result.protocolVersion // empty' "$BODY" 2>/dev/null || true)
finish

begin "MCP notifications/initialized is accepted"
mcp_post '{"jsonrpc":"2.0","method":"notifications/initialized"}'
expect_status 200 202 204
finish

begin "MCP tools/list"
mcp_post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
expect_status 200
expect_json '(.result.tools | length > 0) and all(.result.tools[]; (.name | type == "string") and (.inputSchema | type == "object"))'
MCP_TOOL=$(jq -r '[.result.tools[]? | select(((.inputSchema.required // []) | length) == 0) | .name] | first // empty' "$BODY" 2>/dev/null || true)
finish

if [[ -n $MCP_TOOL ]]; then
	begin "MCP tools/call $MCP_TOOL"
	mcp_post "$(jq -cn --arg name "$MCP_TOOL" '{jsonrpc: "2.0", id: 3, method: "tools/call", params: {name: $name, arguments: {}}}')"
	expect_status 200
	expect_json '(.result.content | type == "array" and length > 0) and (.result.isError != true)'
	finish
else
	skip "MCP tools/call" "no tool without required arguments"
fi

begin "MCP rejects an unknown method"
mcp_post '{"jsonrpc":"2.0","id":4,"method":"smoke/not-a-method"}'
expect_status 200 400 404
expect_json '.error.code == -32601'
finish

begin "MCP rejects malformed JSON"
mcp_post '{"jsonrpc": "2.0", "id": 5, "method": '
expect_status 200 400
expect_json '.error.code == -32700'
finish

# ─── Live ──────────────────────────────────────────────────────────────────────

section "Live"

websocket_check "WebSocket /ws says hello" "$CURRENT"

# node: connect, expect the hello to carry the anxiety meter, then check (GET /) and wait for the
# checkfeed broadcast that says someone (us) just did.
# shellcheck disable=SC2016 # JavaScript, not shell.
SOCIAL_WS_SCRIPT='
const [url, base, ua] = process.argv.slice(1);
let stage = "hello";
let anxiety = null;
const fail = (message) => { console.error(message); process.exit(1); };
const timer = setTimeout(() => fail(`timed out waiting for ${stage}`), 15000);
const ws = new WebSocket(url);
ws.addEventListener("error", () => fail("WebSocket error"));
ws.addEventListener("close", (event) => { if (stage !== "done") fail(`closed during ${stage} (code ${event.code})`); });
ws.addEventListener("message", async (event) => {
	let msg;
	try { msg = JSON.parse(String(event.data)); } catch { return fail("non-JSON message"); }
	if (stage === "hello") {
		if (msg.type !== "hello") return fail(`first message was "${msg.type}", not "hello"`);
		anxiety = msg.anxiety;
		if (!anxiety || !["calm", "elevated", "frantic", "meltdown"].includes(anxiety.level) || typeof anxiety.perMinute !== "number") return fail("hello.anxiety is missing or malformed");
		stage = "checkfeed";
		try { await (await fetch(`${base}/`, { headers: { "user-agent": ua, accept: "text/html" } })).arrayBuffer(); } catch (err) { fail(`GET / failed: ${err}`); }
		return;
	}
	if (stage === "checkfeed" && msg.type === "checkfeed") {
		const ok = Array.isArray(msg.items) && msg.items.length > 0 && msg.items.every((i) => /^([A-Z]{2}|T1)$/.test(i.country) && Number.isInteger(i.n) && i.n > 0);
		if (!ok) return fail(`malformed checkfeed: ${JSON.stringify(msg).slice(0, 120)}`);
		stage = "done";
		clearTimeout(timer);
		console.log(`anxiety ${anxiety.level}; checkfeed ${msg.items.map((i) => `${i.n}×${i.country}`).join(", ")}`);
		ws.close();
		setTimeout(() => process.exit(0), 50);
	}
});
'

begin "WebSocket hello carries the anxiety meter, and a check shows up in the check feed"
if out=$(node -e "$SOCIAL_WS_SCRIPT" "$WS_BASE/ws" "$BASE" "$BROWSER_UA" 2>&1); then
	CHECK="$CHECK ($out)"
else
	problem "$out"
fi
finish

begin "SSE /api/stream sends hello first"
# The stream never ends, so curl stops it (28); a server that rotates or restarts the stream
# may also close it first (18). Either is fine once the first event has arrived.
ALLOW_CURL_EXIT="18 28"
request GET /api/stream --no-buffer --max-time 3 --header 'Accept: text/event-stream'
expect_status 200
ALLOW_CURL_EXIT=""
expect_type '^text/event-stream'
FIRST_EVENT=$(tr -d '\r' <"$BODY" | sed -n 's/^data: \{0,1\}//p' | head -n 1)
if ! printf '%s' "$FIRST_EVENT" | jq -e --arg s "$CURRENT" '.type == "hello" and .state.status == $s' >/dev/null 2>&1; then
	problem "first data: line isn't a hello for '$CURRENT': ${FIRST_EVENT:0:120}"
fi
finish

# ─── Notifications ─────────────────────────────────────────────────────────────

section "Notifications"

begin "GET /api/push/key"
request GET /api/push/key
expect_status 200
expect_type 'json|text/plain'
expect_nonempty
finish

survives "GET /confirm/<bogus> is handled" GET "/confirm/$BOGUS"
survives "GET /unsubscribe/<bogus> is handled" GET "/unsubscribe/$BOGUS"
survives "POST /unsubscribe/<bogus> (one-click) is handled" POST "/unsubscribe/$BOGUS" \
	--data 'List-Unsubscribe=One-Click'
survives "POST /subscribe with a nonsense address is handled" POST /subscribe \
	--header "Origin: $ORIGIN" --data 'email=not-an-email-address'

begin "POST /api/push/subscribe rejects an empty subscription"
request POST /api/push/subscribe --header 'Content-Type: application/json' --header "Origin: $ORIGIN" --data '{}'
expect_status 4xx
finish
survives "POST /api/push/unsubscribe with nothing is handled" POST /api/push/unsubscribe \
	--header 'Content-Type: application/json' --header "Origin: $ORIGIN" --data '{}'

survives "POST /webhooks with a nonsense URL is handled" POST /webhooks \
	--header "Origin: $ORIGIN" --data 'url=not-a-url&kind=generic'
begin "GET /webhooks/<bogus> is a 4xx"
request GET "/webhooks/$BOGUS"
expect_status 4xx
finish
survives "POST /webhooks/<bogus>/test is handled" POST "/webhooks/$BOGUS/test" --header "Origin: $ORIGIN"
survives "POST /webhooks/<bogus>/delete is handled" POST "/webhooks/$BOGUS/delete" --header "Origin: $ORIGIN"
survives "POST /names/999999999/vote is handled" POST /names/999999999/vote --header "Origin: $ORIGIN"

# Unsigned, so it's rejected before anything happens: 401 once RESEND_WEBHOOK_SECRET is set
# (production), 503 without it (wrangler dev, CI).
begin "POST /api/resend/webhook refuses an unsigned delivery"
request POST /api/resend/webhook --header 'Content-Type: application/json' \
	--data '{"type":"email.received","data":{"email_id":"smoke"}}'
expect_status 401 503
expect_type 'json'
finish

# ─── Dad Ledger ────────────────────────────────────────────────────────────────

section "Dad Ledger"

json_endpoint /api/ledger
json_endpoint /.well-known/dad-ledger.json

begin "GET /og.png is a PNG"
request GET /og.png --location
expect_status 200
expect_type '^image/png'
expect_nonempty
finish

# ─── Admin (anonymous) ─────────────────────────────────────────────────────────

section "Admin (anonymous)"

begin "GET /admin/login shows a password form"
request GET /admin/login
expect_status 200
expect_type '^text/html'
expect_body_i 'type="password"'
expect_body_i 'noindex'
finish

for path in /admin /admin/checklist /admin/wall /admin/names /admin/pool; do
	needs_login "$path"
done
for path in /admin/status /admin/reload /admin/og/render /admin/dns/sync /admin/updates/999999999/rerun; do
	refuses_anonymous "$path"
done

begin "POST /admin/logout without a session is harmless"
request POST /admin/logout --header "Origin: $ORIGIN"
expect_status 3xx 401 403
finish

# ─── Admin (with --mutate) ─────────────────────────────────────────────────────

if [[ $MUTATE == 1 ]]; then
	section "Admin (--mutate)"

	if [[ ! $HOSTNAME_ONLY =~ ^(localhost|127\.[0-9.]+|\[::1\])$ && $HOSTNAME_ONLY != *.workers.dev &&
		${SMOKE_ALLOW_PRODUCTION_MUTATION:-} != 1 ]]; then
		begin "--mutate is allowed against $HOSTNAME_ONLY"
		problem "refusing to press the big red button on what looks like production; set SMOKE_ALLOW_PRODUCTION_MUTATION=1 if you really mean it"
		finish
	elif [[ $CURRENT != no ]]; then
		begin "--mutate only runs while the answer is NO"
		problem "the site says '$CURRENT'; flipping it now would un-dad someone, so the button stays unpressed"
		finish
	else
		# The Turnstile dummy token passes Cloudflare's test keys (previews); it's ignored when
		# Turnstile isn't configured (local dev, CI).
		TURNSTILE_DUMMY='XXXX.DUMMY.TOKEN.XXXX'

		begin "Admin login with the wrong password is refused"
		request POST /admin/login --cookie-jar "$WORK/wrong-jar" --header "Origin: $ORIGIN" \
			--data-urlencode 'password=definitely-not-the-password' --data-urlencode "cf-turnstile-response=$TURNSTILE_DUMMY"
		expect_status 400 401 403 429
		finish

		begin "Admin login from another origin is refused"
		request POST /admin/login --cookie-jar "$WORK/evil-jar" --header "Origin: $EVIL_ORIGIN" \
			--data-urlencode "password=$ADMIN_PASSWORD" --data-urlencode "cf-turnstile-response=$TURNSTILE_DUMMY"
		expect_status 403
		finish

		begin "Admin login"
		request POST /admin/login --cookie-jar "$JAR" --cookie "$JAR" --header "Origin: $ORIGIN" \
			--data-urlencode "password=$ADMIN_PASSWORD" --data-urlencode "cf-turnstile-response=$TURNSTILE_DUMMY"
		expect_status 302 303
		expect_header location '^(https?://[^/]+)?/admin'
		if [[ $(header location) == */admin/login* ]]; then problem "redirected back to the login page"; fi
		if ! grep -Eq '^(#HttpOnly_)?[^#[:space:]]' "$JAR" 2>/dev/null; then problem "no session cookie was set"; fi
		finish

		begin "GET /admin with a session shows the dashboard"
		request GET /admin --cookie "$JAR"
		expect_status 200
		expect_type '^text/html'
		expect_csp
		expect_no_body_i 'type="password"'
		finish

		begin "The retired live OG render says so (410 for JSON)"
		request POST /admin/og/render --cookie "$JAR" --header "Origin: $ORIGIN" --header 'Accept: application/json'
		expect_status 410
		expect_json '.ok == false'
		finish

		begin "A cross-site button press is refused"
		request POST /admin/status --cookie "$JAR" --header "Origin: $EVIL_ORIGIN" --header 'Accept: application/json' \
			--data 'status=soon&confirm=SOON'
		expect_status 403
		finish

		begin "Pressing NOT YET without typing the confirmation word does nothing"
		request POST /admin/status --cookie "$JAR" --header "Origin: $ORIGIN" --header 'Accept: application/json' \
			--data 'status=soon'
		expect_status 4xx
		expect_json '.ok == false'
		finish

		# Watch the live socket while the button is pressed.
		READY_FILE=$WORK/watcher-ready
		node -e "$WS_SCRIPT" "$WS_BASE/ws" no watch:soon "$READY_FILE" >"$WORK/watcher.out" 2>&1 &
		WATCHER_PID=$!
		for _ in $(seq 1 50); do
			if [[ -e $READY_FILE ]] || ! kill -0 "$WATCHER_PID" 2>/dev/null; then break; fi
			sleep 0.2
		done

		begin "Press the big red button: NOT YET"
		request POST /admin/status --cookie "$JAR" --header "Origin: $ORIGIN" --header 'Accept: application/json' \
			--data 'status=soon&confirm=SOON&note=Smoke+test.+Nothing+to+see+here.'
		expect_status 200
		expect_json '.ok == true and .changed == true'
		if [[ $STATUS == 200 ]]; then FLIPPED=1; fi
		finish

		begin "An open WebSocket hears about it"
		if wait "$WATCHER_PID"; then
			CHECK="$CHECK ($(tr -d '\n' <"$WORK/watcher.out"))"
		else
			problem "$(tr -d '\n' <"$WORK/watcher.out")"
		fi
		WATCHER_PID=""
		finish

		settle
		EXPECTED_HEADER_RE=$(header_re_for soon)
		begin "GET /api/status now says NOT YET"
		request GET /api/status --header 'Accept: application/json'
		expect_status 200
		expect_dynamic_headers
		expect_json '.status == "soon" and .isZackADad == false'
		finish
		begin "GET /api/dad is still 425 Too Early"
		request GET /api/dad
		expect_status 425
		finish

		begin "Put it back: NO"
		request POST /admin/status --cookie "$JAR" --header "Origin: $ORIGIN" --header 'Accept: application/json' \
			--data 'status=no&confirm=NO'
		expect_status 200
		expect_json '.ok == true'
		if [[ $STATUS == 200 ]]; then FLIPPED=0; fi
		finish

		settle
		EXPECTED_HEADER_RE=$(header_re_for no)
		begin "GET /api/status says NO again"
		request GET /api/status --header 'Accept: application/json'
		expect_status 200
		expect_dynamic_headers
		expect_json '.status == "no" and .isZackADad == false'
		finish

		websocket_check "A good-vibes button press is broadcast" no vibe

		begin "Log out"
		request POST /admin/logout --cookie "$JAR" --cookie-jar "$JAR" --header "Origin: $ORIGIN"
		expect_status 302 303
		finish

		begin "After logging out, /admin wants the password again"
		request GET /admin --cookie "$JAR"
		expect_status 302 303 307
		expect_header location '/admin/login'
		finish
	fi
fi

# ─── Summary ───────────────────────────────────────────────────────────────────

printf '\n%d passed, %d failed, %d skipped against %s\n' "$PASSED" "$FAILED" "$SKIPPED" "$BASE"
if [[ $FAILED -gt 0 ]]; then
	printf '\n❌ Failed:\n'
	printf '   • %s\n' "${FAILURES[@]}"
	exit 1
fi
case $CURRENT in
	no) echo "✅ All good. Is Zack a dad? Still no." ;;
	soon) echo "✅ All good. Is Zack a dad? Not yet, but it's happening." ;;
	yes) echo "✅ All good. Is Zack a dad? Yes!" ;;
	*) echo "✅ All good." ;;
esac
