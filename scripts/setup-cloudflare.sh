#!/usr/bin/env bash
# setup-cloudflare.sh: the one-time Cloudflare + Resend hookup for iszacka.dad.
#
# Everything `wrangler deploy` can't do on its own:
#   1. finds the iszacka.dad zone (and checks its account)
#   2. finds or creates the iszacka.dad domain in Resend (eu-west-1, sending and
#      receiving), turning receiving on if it's off
#   3. turns off Cloudflare Email Routing and removes apex MX records that aren't
#      Resend's (inbound mail must reach Resend), printing everything it removes
#   4. upserts every DNS record Resend asks for (DKIM, SPF, the receiving MX), unproxied
#   5. asks Resend to verify the domain, and waits a couple of minutes for it
#   6. finds or creates the Resend webhook for ${SITE}/api/resend/webhook
#      (email.received, email.bounced, email.complained) and stores its signing
#      secret as the Worker secret RESEND_WEBHOOK_SECRET
#   7. finds or creates the managed Turnstile widget, and stores its keys as the Worker
#      secrets TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY
#   8. adds a _dmarc TXT record if there isn't one
#   9. prints a summary
#
# Idempotent: it checks before it changes anything, so run it as often as you like. Worker
# secrets are only written when they're missing or their source changed (a new webhook, a new
# widget), or with --force-secrets. Secret values are never printed. Steps 6 and 7 need the
# Worker to exist: deploy first (push to main), then run this. The GitHub "Setup" workflow
# (.github/workflows/setup.yml) runs it with the repository secrets.
#
# Environment:
#   CLOUDFLARE_API_TOKEN   the deploy token from docs/SETUP.md (or `npx wrangler login`)
#   CLOUDFLARE_ACCOUNT_ID  optional; must match the zone's account if set
#   RESEND_API_KEY         a full-access Resend API key (required)
#   ZONE (iszacka.dad), WORKER (iszacka-dad), SITE (https://$ZONE),
#   RESEND_REGION (eu-west-1), TURNSTILE_WIDGET_NAME ($ZONE),
#   DMARC_POLICY ("v=DMARC1; p=quarantine; adkim=r; aspf=r"),
#   VERIFY_WAIT_SECONDS (120), VERIFY_POLL_SECONDS (10)
# The tests also swap in CLOUDFLARE_API_BASE and RESEND_API_BASE (mock APIs) and WRANGLER
# (a fake wrangler).
#
# Usage:
#   bash scripts/setup-cloudflare.sh [--dry-run] [--force-secrets]
#
#   --dry-run        look, don't touch: report what would change
#   --force-secrets  re-store the webhook and Turnstile secrets on the Worker even if present
#
# Needs: bash, curl, jq, node/npx (for wrangler).
set -euo pipefail

ZONE=${ZONE:-${ZONE_NAME:-iszacka.dad}}
WORKER=${WORKER:-${WORKER_NAME:-iszacka-dad}}
SITE=${SITE:-https://$ZONE}
SITE=${SITE%/}
RESEND_REGION=${RESEND_REGION:-eu-west-1}
TURNSTILE_WIDGET_NAME=${TURNSTILE_WIDGET_NAME:-$ZONE}
DMARC_POLICY=${DMARC_POLICY:-v=DMARC1; p=quarantine; adkim=r; aspf=r}
VERIFY_WAIT_SECONDS=${VERIFY_WAIT_SECONDS:-120}
VERIFY_POLL_SECONDS=${VERIFY_POLL_SECONDS:-10}
CF_API=${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}
RESEND_API=${RESEND_API_BASE:-https://api.resend.com}
WEBHOOK_URL="$SITE/api/resend/webhook"
WEBHOOK_EVENTS='["email.received","email.bounced","email.complained"]'
USER_AGENT="iszacka.dad-setup/1.0 (+$SITE)"

DRY_RUN=0
FORCE_SECRETS=0
for arg in "$@"; do
	case $arg in
		--dry-run) DRY_RUN=1 ;;
		--force-secrets) FORCE_SECRETS=1 ;;
		-h | --help)
			awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
			exit 0
			;;
		*)
			echo "setup-cloudflare: unknown option: $arg (try --help)" >&2
			exit 2
			;;
	esac
done

for tool in curl jq; do
	if ! command -v "$tool" >/dev/null; then
		echo "setup-cloudflare: $tool is required" >&2
		exit 2
	fi
done

cd "$(dirname "$0")/.."
read -r -a WRANGLER <<<"${WRANGLER:-npx --no-install wrangler}"

# ─── Output ────────────────────────────────────────────────────────────────────

SUMMARY=()
ATTENTION=0

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
info() { printf '   %s\n' "$1"; }
ok() {
	printf '   ✅ %s\n' "$1"
	SUMMARY+=("✅ $1")
}
changed() {
	printf '   🔧 %s\n' "$1"
	SUMMARY+=("🔧 $1")
}
would() {
	printf '   📝 Would %s (dry run)\n' "$1"
	SUMMARY+=("📝 Would $1")
}
note() {
	printf '   ⏳ %s\n' "$1"
	SUMMARY+=("⏳ $1")
}
attention() {
	printf '   ⚠️  %s\n' "$1"
	SUMMARY+=("⚠️  $1")
	ATTENTION=1
}
die() {
	printf '\n❌ %s\n' "$1" >&2
	exit 1
}

# ─── API helpers ───────────────────────────────────────────────────────────────
# Tokens go to curl through a file descriptor, so they never show up in `ps`.

# cf METHOD PATH [JSON_BODY]: prints the response JSON; returns 1 unless .success is true.
cf() {
	local method=$1 path=$2 body=${3:-} response
	local args=(--silent --show-error --max-time 30 --request "$method" --header 'Content-Type: application/json')
	if [[ -n $body ]]; then args+=(--data "$body"); fi
	if ! response=$(curl "${args[@]}" --header @<(printf 'Authorization: Bearer %s\n' "$CF_TOKEN") "$CF_API$path"); then
		jq -cn --arg path "$path" '{success: false, errors: [{message: "request to \($path) failed"}]}'
		return 1
	fi
	printf '%s\n' "$response"
	jq -e '.success == true' >/dev/null 2>&1 <<<"$response"
}

# The first error message in a Cloudflare API response.
cf_error() { jq -r '[.errors[]? | "\(.message) (code \(.code // "?"))"] | first // "unknown error"' 2>/dev/null <<<"$1" || echo "unknown error"; }

# rs METHOD PATH [JSON_BODY]: a Resend API call. Prints the response JSON; returns 1 unless
# the status is 2xx. Rate limits (429, 10 requests/second) are retried with a pause.
rs() {
	local method=$1 path=$2 body=${3:-} out code attempt
	local args=(--silent --show-error --max-time 30 --request "$method" --header 'Content-Type: application/json'
		--header "User-Agent: $USER_AGENT" --write-out '\n%{http_code}')
	if [[ -n $body ]]; then args+=(--data "$body"); fi
	for attempt in 1 2 3 4; do
		if ! out=$(curl "${args[@]}" --header @<(printf 'Authorization: Bearer %s\n' "$RESEND_API_KEY") "$RESEND_API$path"); then
			jq -cn --arg path "$path" '{name: "network_error", message: "request to \($path) failed"}'
			return 1
		fi
		code=${out##*$'\n'}
		out=${out%$'\n'*}
		if [[ $code == 429 && $attempt -lt 4 ]]; then
			sleep "$attempt"
			continue
		fi
		break
	done
	printf '%s\n' "${out:-null}"
	[[ $code =~ ^2[0-9][0-9]$ ]]
}

# "name: message" from a Resend error response.
rs_error() { jq -r '"\(.name // "error"): \(.message // "unknown error")"' 2>/dev/null <<<"$1" || echo "unknown error"; }

# In GitHub Actions, hide a secret we discovered (GitHub only masks its own secrets) from the log.
mask() { if [[ ${GITHUB_ACTIONS:-} == true && -n $1 ]]; then printf '::add-mask::%s\n' "$1"; fi; }

# wrangler_secret NAME VALUE: store a Worker secret. The value goes in on stdin.
wrangler_secret() {
	printf '%s' "$2" | "${WRANGLER[@]}" secret put "$1" --name "$WORKER" >/dev/null
}

# Fully qualified DNS name for a record name Resend gives relative ("send"), as "@", or in full.
fqdn() {
	local name=${1%.}
	if [[ -z $name || $name == "@" || $name == "$ZONE" ]]; then
		printf '%s' "$ZONE"
	elif [[ $name == *".$ZONE" ]]; then
		printf '%s' "$name"
	else
		printf '%s.%s' "$name" "$ZONE"
	fi
}

# jq: normalise DNS content for comparison. TXT keeps its case but loses quotes and chunking;
# hostnames lose case and the trailing dot. ($type is jq's, not the shell's.)
# shellcheck disable=SC2016
JQ_NORM='def norm($type): if $type == "TXT" then (gsub("\" +\""; "") | gsub("\""; "")) else (ascii_downcase | rtrimstr(".")) end;'

# ─── 0. Credentials ────────────────────────────────────────────────────────────

step "0. Credentials"
if [[ -n ${CLOUDFLARE_API_TOKEN:-} ]]; then
	CF_TOKEN=$CLOUDFLARE_API_TOKEN
	info "Cloudflare: using CLOUDFLARE_API_TOKEN."
else
	if ! CF_TOKEN=$("${WRANGLER[@]}" auth token --json 2>/dev/null | jq -r '.token // empty'); then CF_TOKEN=""; fi
	if [[ -z $CF_TOKEN ]]; then
		die "No Cloudflare credentials. Export CLOUDFLARE_API_TOKEN (see docs/SETUP.md), or run 'npx wrangler login' first."
	fi
	info "Cloudflare: using your wrangler login (OAuth)."
fi
if [[ -z ${RESEND_API_KEY:-} ]]; then
	die "RESEND_API_KEY isn't set. It needs a full-access Resend API key (docs/SETUP.md)."
fi
info "Resend: using RESEND_API_KEY."
if [[ $DRY_RUN == 1 ]]; then info "Dry run: nothing will be changed."; fi

# ─── 1. Zone ───────────────────────────────────────────────────────────────────

step "1. Zone $ZONE"
if ! zones=$(cf GET "/zones?name=$ZONE&per_page=5"); then
	die "Couldn't list zones: $(cf_error "$zones"). Does the token have Zone Read on $ZONE?"
fi
ZONE_ID=$(jq -r --arg name "$ZONE" '[.result[] | select(.name == $name) | .id] | first // empty' <<<"$zones")
if [[ -z $ZONE_ID ]]; then
	die "$ZONE isn't a zone this token can see. Add the domain to Cloudflare first (docs/SETUP.md, step 1)."
fi
ZONE_ACCOUNT=$(jq -r --arg id "$ZONE_ID" '.result[] | select(.id == $id) | .account.id' <<<"$zones")
ZONE_STATUS=$(jq -r --arg id "$ZONE_ID" '.result[] | select(.id == $id) | .status' <<<"$zones")
if [[ -n ${CLOUDFLARE_ACCOUNT_ID:-} && $CLOUDFLARE_ACCOUNT_ID != "$ZONE_ACCOUNT" ]]; then
	die "$ZONE belongs to account $ZONE_ACCOUNT, but CLOUDFLARE_ACCOUNT_ID is $CLOUDFLARE_ACCOUNT_ID."
fi
export CLOUDFLARE_ACCOUNT_ID=$ZONE_ACCOUNT
ACCOUNT_ID=$ZONE_ACCOUNT
ok "Zone $ZONE found (zone $ZONE_ID, account $ACCOUNT_ID)"
if [[ $ZONE_STATUS != active ]]; then
	attention "The zone is '$ZONE_STATUS', not 'active': point the registrar's nameservers at Cloudflare and wait for it to activate."
fi

WORKER_EXISTS=0
if cf GET "/accounts/$ACCOUNT_ID/workers/services/$WORKER" >/dev/null; then WORKER_EXISTS=1; fi

# ─── 2. Resend domain ──────────────────────────────────────────────────────────

step "2. Resend domain $ZONE (sending + receiving)"
DOMAIN_ID=""
DOMAIN_JSON=""
if ! domains=$(rs GET "/domains"); then
	die "Couldn't list Resend domains: $(rs_error "$domains"). RESEND_API_KEY needs full access, not sending only."
fi
DOMAIN_ID=$(jq -r --arg name "$ZONE" '[.data[]? | select(.name == $name) | .id] | first // empty' <<<"$domains")
if [[ -z $DOMAIN_ID ]]; then
	if [[ $DRY_RUN == 1 ]]; then
		would "create the Resend domain $ZONE in $RESEND_REGION with sending and receiving"
	else
		body=$(jq -cn --arg name "$ZONE" --arg region "$RESEND_REGION" \
			'{name: $name, region: $region, capabilities: {sending: "enabled", receiving: "enabled"}}')
		if created=$(rs POST "/domains" "$body"); then
			DOMAIN_ID=$(jq -r '.id // empty' <<<"$created")
			changed "Created the Resend domain $ZONE ($RESEND_REGION, sending + receiving)"
		else
			die "Couldn't create the Resend domain: $(rs_error "$created")"
		fi
	fi
else
	ok "Resend already has $ZONE"
fi

if [[ -n $DOMAIN_ID ]]; then
	if ! DOMAIN_JSON=$(rs GET "/domains/$DOMAIN_ID"); then
		die "Couldn't read the Resend domain: $(rs_error "$DOMAIN_JSON")"
	fi
	region=$(jq -r '.region // "unknown"' <<<"$DOMAIN_JSON")
	if [[ $region != "$RESEND_REGION" ]]; then
		info "It sends from $region rather than $RESEND_REGION. That works; changing it means deleting and re-adding the domain in Resend."
	fi
	update=$(jq -c '[(.capabilities // {}) | to_entries[] | select(.value != "enabled") | .key]
		| if length == 0 then empty else {capabilities: (map({key: ., value: "enabled"}) | from_entries)} end' <<<"$DOMAIN_JSON")
	if [[ -z $update ]]; then
		ok "Sending and receiving are both enabled"
	elif [[ $DRY_RUN == 1 ]]; then
		would "enable $(jq -r '.capabilities | keys | join(" and ")' <<<"$update") on the Resend domain"
	elif response=$(rs PATCH "/domains/$DOMAIN_ID" "$update"); then
		changed "Enabled $(jq -r '.capabilities | keys | join(" and ")' <<<"$update") on the Resend domain"
		# Enabling receiving adds the MX record to the domain's records.
		DOMAIN_JSON=$(rs GET "/domains/$DOMAIN_ID") || die "Couldn't re-read the Resend domain: $(rs_error "$DOMAIN_JSON")"
	else
		attention "Couldn't enable $(jq -r '.capabilities | keys | join(" and ")' <<<"$update"): $(rs_error "$response"). Toggle it on the domain's page in Resend."
	fi
fi

# Resend's records, as {type, name (FQDN), content, priority}.
RECORDS=()
if [[ -n $DOMAIN_JSON ]]; then
	while IFS= read -r line; do
		name=$(jq -r '.name' <<<"$line")
		RECORDS+=("$(jq -c --arg fqdn "$(fqdn "$name")" '. + {name: $fqdn}' <<<"$line")")
	done < <(jq -c "$JQ_NORM"'.records[]? | (.type // "" | ascii_upcase) as $t | {type: $t, name: (.name // ""),
		content: ((.value // "") | norm($t)), priority: (.priority // null), record: (.record // "")}' <<<"$DOMAIN_JSON")
fi
RESEND_APEX_MX=$(printf '%s\n' "${RECORDS[@]}" | jq -r --arg zone "$ZONE" 'select(.type == "MX" and .name == $zone) | .content' 2>/dev/null || true)
if [[ -n $DOMAIN_JSON && -z $RESEND_APEX_MX ]]; then
	attention "Resend lists no MX record for $ZONE yet, so inbound mail can't reach it. Is receiving enabled on the domain?"
fi

# ─── 3. Email Routing off, stray MX records out ───────────────────────────────

step "3. Inbound mail goes to Resend, not Cloudflare Email Routing"
if routing=$(cf GET "/zones/$ZONE_ID/email/routing"); then
	if jq -e '.result.enabled == true' >/dev/null <<<"$routing"; then
		if [[ $DRY_RUN == 1 ]]; then
			would "disable Cloudflare Email Routing on $ZONE"
		elif cf DELETE "/zones/$ZONE_ID/email/routing/dns" >/dev/null || cf POST "/zones/$ZONE_ID/email/routing/disable" '{}' >/dev/null; then
			changed "Disabled Cloudflare Email Routing on $ZONE (Resend receives the mail now)"
		else
			attention "Couldn't disable Cloudflare Email Routing. Do it by hand: dashboard > $ZONE > Email > Email Routing > Settings > Disable."
		fi
	else
		ok "Cloudflare Email Routing is off"
	fi
else
	info "Couldn't read the Email Routing settings ($(cf_error "$routing")); if it's on, any of its MX records are removed below, or disable it in the dashboard."
fi

if ! mx=$(cf GET "/zones/$ZONE_ID/dns_records?type=MX&name=$ZONE&per_page=100"); then
	attention "Couldn't read the MX records for $ZONE: $(cf_error "$mx")"
	mx='{"result": []}'
fi
stray=$(jq -c --arg keep "$RESEND_APEX_MX" "$JQ_NORM"'[.result[]? | select((.content | norm("MX")) as $c | ($keep | split("\n") | index($c)) | not)] | .[]' <<<"$mx")
if [[ -z $RESEND_APEX_MX ]]; then
	info "Leaving the existing MX records alone until Resend's MX record is known."
elif [[ -z $stray ]]; then
	ok "No MX records for $ZONE other than Resend's"
else
	while IFS= read -r record; do
		[[ -n $record ]] || continue
		id=$(jq -r '.id' <<<"$record")
		label="MX $ZONE → $(jq -r '.content' <<<"$record") (priority $(jq -r '.priority // "?"' <<<"$record"))"
		if [[ $DRY_RUN == 1 ]]; then
			would "remove $label"
		elif response=$(cf DELETE "/zones/$ZONE_ID/dns_records/$id"); then
			changed "Removed $label"
		else
			attention "Couldn't remove $label: $(cf_error "$response"). Delete it by hand, or mail for $ZONE may go to the wrong place."
		fi
	done <<<"$stray"
fi

# ─── 4. Resend's DNS records ───────────────────────────────────────────────────

step "4. DNS records for Resend (DKIM, SPF, receiving MX)"
if [[ ${#RECORDS[@]} -eq 0 ]]; then
	info "No records to add yet (the Resend domain doesn't exist; this is a dry run or it couldn't be created)."
fi
for record in "${RECORDS[@]}"; do
	type=$(jq -r '.type' <<<"$record")
	name=$(jq -r '.name' <<<"$record")
	content=$(jq -r '.content' <<<"$record")
	priority=$(jq -r '.priority // empty' <<<"$record")
	label="$type $name${priority:+ (priority $priority)}"
	case $type in
		TXT | MX | CNAME) ;;
		*)
			attention "Resend wants a $type record at $name, which this script doesn't manage. Add it by hand: $content"
			continue
			;;
	esac
	if ! existing=$(cf GET "/zones/$ZONE_ID/dns_records?type=$type&name=$name&per_page=100"); then
		attention "Couldn't read DNS records for $name: $(cf_error "$existing")"
		continue
	fi
	# Exact match (same content, same priority for MX, not proxied)?
	if jq -e --arg content "$content" --arg priority "$priority" --arg type "$type" "$JQ_NORM"'
		any(.result[]?; (.content | norm($type)) == $content
			and ($priority == "" or ((.priority // "") | tostring) == $priority)
			and (.proxied // false) == false)' >/dev/null <<<"$existing"; then
		ok "$label is in place"
		continue
	fi
	# Something to update in place: the CNAME at that name, Resend's MX host with another
	# priority or proxied, the one SPF record at a name, or a DKIM key at Resend's selector.
	replace=$(jq -r --arg content "$content" --arg type "$type" --arg name "$name" "$JQ_NORM"'
		[.result[]? | select(
			($type == "CNAME")
			or ($type == "MX" and (.content | norm("MX")) == $content)
			or ($type == "TXT" and (($content | startswith("v=spf1")) and ((.content | norm("TXT")) | startswith("v=spf1"))))
			or ($type == "TXT" and ($name | test("_domainkey\\.")) and ((.content | norm("TXT")) | test("^(v=DKIM1;)?.*p=")))
		) | .id] | first // empty' <<<"$existing")
	body=$(jq -cn --arg type "$type" --arg name "$name" --arg content "$content" --arg priority "$priority" '
		{type: $type, name: $name, ttl: 1, comment: "Resend (scripts/setup-cloudflare.sh)"}
		+ (if $type == "TXT" then {content: ([range(0; ($content | length); 255) as $i | $content[$i:$i + 255]] | map("\"" + . + "\"") | join(" "))} else {content: $content} end)
		+ (if $type == "MX" then {priority: ($priority | tonumber? // 10)} else {} end)
		+ (if $type == "CNAME" then {proxied: false} else {} end)')
	if [[ $DRY_RUN == 1 && -n $replace ]]; then
		would "update $label"
	elif [[ $DRY_RUN == 1 ]]; then
		would "add $label"
	elif [[ -n $replace ]] && response=$(cf PUT "/zones/$ZONE_ID/dns_records/$replace" "$body"); then
		changed "Updated $label"
	elif [[ -z $replace ]] && response=$(cf POST "/zones/$ZONE_ID/dns_records" "$body"); then
		changed "Added $label"
	else
		attention "Couldn't write $label: $(cf_error "$response")"
	fi
done

# ─── 5. Verification ───────────────────────────────────────────────────────────

step "5. Resend domain verification"
if [[ -z $DOMAIN_JSON ]]; then
	info "Nothing to verify yet."
else
	status=$(jq -r '.status // "unknown"' <<<"$DOMAIN_JSON")
	if [[ $status == verified ]]; then
		ok "Resend has verified $ZONE"
	elif [[ $DRY_RUN == 1 ]]; then
		would "ask Resend to verify $ZONE (it's '$status')"
	else
		if response=$(rs POST "/domains/$DOMAIN_ID/verify"); then
			info "Asked Resend to check the DNS records (status was '$status')."
		else
			info "Couldn't trigger verification ($(rs_error "$response")); Resend checks on its own anyway."
		fi
		waited=0
		while :; do
			if current=$(rs GET "/domains/$DOMAIN_ID"); then status=$(jq -r '.status // "unknown"' <<<"$current"); fi
			if [[ $status == verified || $status == failed || $waited -ge $VERIFY_WAIT_SECONDS ]]; then break; fi
			sleep "$VERIFY_POLL_SECONDS"
			waited=$((waited + VERIFY_POLL_SECONDS))
		done
		case $status in
			verified) ok "Resend has verified $ZONE" ;;
			failed) attention "Resend says verification failed. Check the records above in the Cloudflare dashboard, then run this again." ;;
			*) note "Resend says '$status' for now. DNS can take a while; Resend keeps checking for 72 hours. Run this again later to see." ;;
		esac
	fi
fi

# ─── Worker secrets: what's already there ──────────────────────────────────────

WORKER_SECRETS=""
SECRETS_KNOWN=0
if [[ $WORKER_EXISTS == 1 ]]; then
	if list=$("${WRANGLER[@]}" secret list --name "$WORKER" --format json 2>/dev/null) &&
		WORKER_SECRETS=$(jq -r '.[]?.name' <<<"$list" 2>/dev/null); then
		SECRETS_KNOWN=1
	fi
fi
has_secret() { [[ $SECRETS_KNOWN == 1 ]] && grep -qx "$1" <<<"$WORKER_SECRETS"; }

# put_secret NAME VALUE REASON: store a Worker secret, unless this is a dry run or there's no Worker.
put_secret() {
	if [[ $WORKER_EXISTS != 1 ]]; then
		attention "The $WORKER Worker doesn't exist yet (or this token can't see it), so $1 can't be stored. Deploy first (push to main), then run this again."
	elif [[ $DRY_RUN == 1 ]]; then
		would "store the Worker secret $1 ($3)"
	elif wrangler_secret "$1" "$2"; then
		changed "Stored the Worker secret $1 ($3; value not shown)"
	else
		attention "Couldn't store the Worker secret $1. Run: npx wrangler secret put $1 --name $WORKER"
	fi
}

# ─── 6. Resend webhook ─────────────────────────────────────────────────────────

step "6. Resend webhook → $WEBHOOK_URL"
WEBHOOK_ID=""
WEBHOOK_SECRET=""
WEBHOOK_NEW=0
SKIP_WEBHOOK=0
if ! hooks=$(rs GET "/webhooks?limit=100"); then
	attention "Couldn't list Resend webhooks: $(rs_error "$hooks")"
	SKIP_WEBHOOK=1
else
	WEBHOOK_ID=$(jq -r --arg url "$WEBHOOK_URL" '[.data[]? | select(.endpoint == $url) | .id] | first // empty' <<<"$hooks")
	if [[ -n $WEBHOOK_ID ]] && ! hook=$(rs GET "/webhooks/$WEBHOOK_ID"); then
		attention "Couldn't read the existing webhook: $(rs_error "$hook"). Left it alone."
		WEBHOOK_ID=""
		SKIP_WEBHOOK=1
	fi
	if [[ -n $WEBHOOK_ID ]]; then
		update=$(jq -c --argjson want "$WEBHOOK_EVENTS" '
			((.events // []) as $have | ($want - $have)) as $missing
			| if ($missing | length) > 0 or (.status // "enabled") != "enabled"
				then {events: (((.events // []) + $want) | unique), status: "enabled"} else empty end' <<<"$hook")
		if [[ -z $update ]]; then
			ok "The webhook exists, is enabled and has the right events"
		elif [[ $DRY_RUN == 1 ]]; then
			would "enable the webhook and subscribe it to $(jq -r '.events | join(", ")' <<<"$update")"
		elif response=$(rs PATCH "/webhooks/$WEBHOOK_ID" "$update"); then
			changed "Updated the webhook: enabled, events $(jq -r '.events | join(", ")' <<<"$update")"
		else
			attention "Couldn't update the webhook: $(rs_error "$response")"
		fi
		WEBHOOK_SECRET=$(jq -r '.signing_secret // empty' <<<"$hook")
		mask "$WEBHOOK_SECRET"
		# Only recreate (new secret) when the secret is unreadable AND the Worker needs it.
		if [[ -z $WEBHOOK_SECRET ]] && { [[ $FORCE_SECRETS == 1 ]] || ! has_secret RESEND_WEBHOOK_SECRET; }; then
			if [[ $DRY_RUN == 1 ]]; then
				would "delete and recreate the webhook (Resend didn't return its signing secret)"
			elif rs DELETE "/webhooks/$WEBHOOK_ID" >/dev/null; then
				changed "Deleted the webhook to recreate it (Resend didn't return its signing secret)"
				WEBHOOK_ID=""
			else
				attention "Resend didn't return the webhook's signing secret, and it couldn't be deleted to start over. Copy the secret from the Resend dashboard: npx wrangler secret put RESEND_WEBHOOK_SECRET --name $WORKER"
			fi
		fi
	fi
	if [[ -z $WEBHOOK_ID && $SKIP_WEBHOOK == 0 ]]; then
		if [[ $DRY_RUN == 1 ]]; then
			would "create the webhook for email.received, email.bounced and email.complained"
		else
			body=$(jq -cn --arg url "$WEBHOOK_URL" --argjson events "$WEBHOOK_EVENTS" '{endpoint: $url, events: $events}')
			if created=$(rs POST "/webhooks" "$body"); then
				WEBHOOK_ID=$(jq -r '.id // empty' <<<"$created")
				WEBHOOK_SECRET=$(jq -r '.signing_secret // empty' <<<"$created")
				mask "$WEBHOOK_SECRET"
				WEBHOOK_NEW=1
				changed "Created the webhook (email.received, email.bounced, email.complained)"
			else
				attention "Couldn't create the webhook: $(rs_error "$created")"
			fi
		fi
	fi
fi
if [[ $SKIP_WEBHOOK == 1 ]]; then
	info "Not touching RESEND_WEBHOOK_SECRET, since the webhook couldn't be read."
elif [[ $WEBHOOK_NEW == 1 || $FORCE_SECRETS == 1 ]] || ! has_secret RESEND_WEBHOOK_SECRET; then
	reason="missing on the Worker"
	if [[ $FORCE_SECRETS == 1 ]]; then reason="--force-secrets"; fi
	if [[ $WEBHOOK_NEW == 1 ]]; then reason="new webhook"; fi
	if [[ -n $WEBHOOK_SECRET ]]; then
		put_secret RESEND_WEBHOOK_SECRET "$WEBHOOK_SECRET" "$reason"
	elif [[ $DRY_RUN == 1 ]]; then
		would "store the Worker secret RESEND_WEBHOOK_SECRET"
	elif [[ -n $WEBHOOK_ID ]]; then
		attention "No signing secret to store for the webhook. Copy it from the Resend dashboard: npx wrangler secret put RESEND_WEBHOOK_SECRET --name $WORKER"
	fi
else
	ok "The Worker already has RESEND_WEBHOOK_SECRET"
fi

# ─── 7. Turnstile ──────────────────────────────────────────────────────────────

step "7. Turnstile widget '$TURNSTILE_WIDGET_NAME'"
SITE_KEY=""
TURNSTILE_SECRET=""
WIDGET_NEW=0
if ! widgets=$(cf GET "/accounts/$ACCOUNT_ID/challenges/widgets?per_page=100"); then
	attention "Couldn't list Turnstile widgets: $(cf_error "$widgets"). Does the token have Turnstile Edit?"
else
	SITE_KEY=$(jq -r --arg name "$TURNSTILE_WIDGET_NAME" '[.result[]? | select(.name == $name) | .sitekey] | first // empty' <<<"$widgets")
	if [[ -n $SITE_KEY ]]; then
		ok "The Turnstile widget exists (site key $SITE_KEY)"
		if ! jq -e --arg name "$TURNSTILE_WIDGET_NAME" --arg zone "$ZONE" \
			'any(.result[]?; .name == $name and ((.domains // []) | index($zone)))' >/dev/null <<<"$widgets"; then
			attention "The widget doesn't list $ZONE as a domain; add it in the dashboard (Turnstile > $TURNSTILE_WIDGET_NAME)."
		fi
	elif [[ $DRY_RUN == 1 ]]; then
		would "create a managed Turnstile widget for $ZONE"
	else
		body=$(jq -cn --arg name "$TURNSTILE_WIDGET_NAME" --arg zone "$ZONE" '{name: $name, domains: [$zone], mode: "managed"}')
		if widget=$(cf POST "/accounts/$ACCOUNT_ID/challenges/widgets" "$body"); then
			SITE_KEY=$(jq -r '.result.sitekey // empty' <<<"$widget")
			TURNSTILE_SECRET=$(jq -r '.result.secret // empty' <<<"$widget")
			mask "$TURNSTILE_SECRET"
			WIDGET_NEW=1
			changed "Created the managed Turnstile widget (site key $SITE_KEY)"
		else
			attention "Couldn't create the Turnstile widget: $(cf_error "$widget")"
		fi
	fi
fi
if [[ -n $SITE_KEY ]]; then
	if [[ $WIDGET_NEW == 1 || $FORCE_SECRETS == 1 ]] || ! has_secret TURNSTILE_SITE_KEY || ! has_secret TURNSTILE_SECRET_KEY; then
		reason="missing on the Worker"
		if [[ $FORCE_SECRETS == 1 ]]; then reason="--force-secrets"; fi
		if [[ $WIDGET_NEW == 1 ]]; then reason="new widget"; fi
		if [[ -z $TURNSTILE_SECRET ]] && widget=$(cf GET "/accounts/$ACCOUNT_ID/challenges/widgets/$SITE_KEY"); then
			TURNSTILE_SECRET=$(jq -r '.result.secret // empty' <<<"$widget")
			mask "$TURNSTILE_SECRET"
		fi
		if [[ -z $TURNSTILE_SECRET && $DRY_RUN == 1 ]]; then
			would "rotate the widget's secret to get one"
		elif [[ -z $TURNSTILE_SECRET ]]; then
			# Keep the old secret valid for its two-hour grace period: nothing is using it yet.
			if widget=$(cf POST "/accounts/$ACCOUNT_ID/challenges/widgets/$SITE_KEY/rotate_secret" '{"invalidate_immediately": false}'); then
				TURNSTILE_SECRET=$(jq -r '.result.secret // empty' <<<"$widget")
				mask "$TURNSTILE_SECRET"
				changed "Rotated the widget's secret (the API didn't return the current one)"
			else
				attention "Couldn't read or rotate the widget's secret: $(cf_error "$widget")"
			fi
		fi
		if [[ -n $TURNSTILE_SECRET || $DRY_RUN == 1 ]]; then
			put_secret TURNSTILE_SITE_KEY "$SITE_KEY" "$reason"
			put_secret TURNSTILE_SECRET_KEY "$TURNSTILE_SECRET" "$reason"
		fi
	else
		ok "The Worker already has TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY"
	fi
fi

# ─── 8. DMARC ──────────────────────────────────────────────────────────────────

step "8. DMARC record (_dmarc.$ZONE)"
if ! records=$(cf GET "/zones/$ZONE_ID/dns_records?type=TXT&name=_dmarc.$ZONE&per_page=20"); then
	attention "Couldn't read DNS records ($(cf_error "$records")). Add a TXT record _dmarc.$ZONE = \"$DMARC_POLICY\" by hand."
elif existing=$(jq -r '[.result[]? | .content | select(test("v=DMARC1"; "i"))] | first // empty' <<<"$records") && [[ -n $existing ]]; then
	ok "DMARC record already exists: $existing"
elif [[ $DRY_RUN == 1 ]]; then
	would "add TXT _dmarc.$ZONE = \"$DMARC_POLICY\""
else
	body=$(jq -cn --arg name "_dmarc.$ZONE" --arg content "\"$DMARC_POLICY\"" \
		'{type: "TXT", name: $name, content: $content, ttl: 1, comment: "Added by scripts/setup-cloudflare.sh"}')
	if response=$(cf POST "/zones/$ZONE_ID/dns_records" "$body"); then
		changed "Added TXT _dmarc.$ZONE = \"$DMARC_POLICY\""
	else
		attention "Couldn't add the DMARC record ($(cf_error "$response")). Add TXT _dmarc.$ZONE = \"$DMARC_POLICY\" by hand."
	fi
fi

# ─── 9. Summary ────────────────────────────────────────────────────────────────

step "9. Summary"
printf '   %s\n' "${SUMMARY[@]}"

cat <<EOF

Then check it by hand:
   • Email ask@$ZONE from a real inbox and wait for the auto-reply.
   • /admin → "Send a test email" to your own address.
   • Smoke-test production: bash scripts/smoke.sh $SITE
EOF

if [[ $ATTENTION == 1 ]]; then
	printf '\n⚠️  Some steps need attention (see above). Fix them and run this again; it only changes what it must.\n'
	exit 1
fi
printf '\n✅ Cloudflare and Resend are set up. Is Zack a dad? The infrastructure is ready to say so.\n'
