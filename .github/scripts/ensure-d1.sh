#!/usr/bin/env bash
# ensure-d1.sh: find (or create) a D1 database by name and write its id into wrangler.toml.
#
#   .github/scripts/ensure-d1.sh <database-name> <placeholder> [config-file]
#
#   .github/scripts/ensure-d1.sh iszackadad PLACEHOLDER_D1_ID
#   .github/scripts/ensure-d1.sh iszackadad_preview PLACEHOLDER_D1_PREVIEW_ID
#
# wrangler.toml never contains real database ids. CI looks the id up by name (creating
# the database on the very first deploy) and swaps it in for exactly one quoted
# placeholder, e.g. "PLACEHOLDER_D1_ID", leaving every other placeholder alone. The id is
# printed on stdout and, inside GitHub Actions, exposed as the step output `id`.
#
# Auth: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (or a local `wrangler login`).
# Knobs: D1_LOCATION (location hint for new databases, default weur: the baby is British),
#        WRANGLER (the wrangler command; tests swap in a fake one).
set -euo pipefail

die() {
	if [[ -n ${GITHUB_ACTIONS:-} ]]; then
		echo "::error title=ensure-d1::$*" >&2
	else
		echo "ensure-d1: $*" >&2
	fi
	exit 1
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
	echo "usage: $0 <database-name> <placeholder> [config-file]" >&2
	exit 2
fi

name=$1
placeholder=$2
config=${3:-wrangler.toml}
location=${D1_LOCATION:-weur}
read -r -a wrangler <<<"${WRANGLER:-npx --no-install wrangler}"

[[ $name =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "'$name' doesn't look like a D1 database name"
[[ $placeholder =~ ^[A-Z][A-Z0-9_]*$ ]] || die "'$placeholder' doesn't look like a placeholder (UPPER_SNAKE_CASE)"
[[ -f $config ]] || die "config file '$config' not found"
command -v jq >/dev/null || die "jq is required"

# The placeholder must appear exactly once, as a quoted TOML string, so we know which
# database_id we are filling in (and never touch a different environment's placeholder).
count=$(grep -c "\"$placeholder\"" "$config" || true)
[[ $count == 1 ]] || die "expected \"$placeholder\" exactly once in $config, found it $count time(s)"

# Prints the uuid of the database called $name, or nothing if there isn't one.
lookup() {
	local out
	out=$("${wrangler[@]}" d1 list --json) || return 1
	# Wrangler occasionally prints a banner or warning before the JSON; start at the array.
	printf '%s\n' "$out" | sed -n '/^[[:space:]]*\[/,$p' |
		jq -r --arg name "$name" '[.[] | select(.name == $name) | .uuid] | first // ""'
}

id=$(lookup) || die "couldn't list D1 databases (is CLOUDFLARE_API_TOKEN set, with D1 Edit?)"

if [[ -z $id ]]; then
	echo "D1 database '$name' doesn't exist yet; creating it (location hint: $location)." >&2
	if ! "${wrangler[@]}" d1 create "$name" --location "$location" >&2; then
		# Two first-ever runs racing each other: the other one may have just created it.
		echo "d1 create failed; checking whether it exists anyway." >&2
	fi
	# The listing is eventually consistent; give a brand new database a moment to show up.
	for attempt in 1 2 3 4 5; do
		id=$(lookup) || die "couldn't list D1 databases after creating '$name'"
		[[ -n $id ]] && break
		sleep "$attempt"
	done
	[[ -n $id ]] || die "D1 database '$name' still isn't listed after creating it"
fi

[[ $id =~ ^[0-9a-fA-F-]{32,36}$ ]] || die "wrangler returned an unexpected id for '$name': $id"

# Both values are validated above, so neither can smuggle sed metacharacters in.
tmp="$config.ensure-d1.$$"
sed "s/\"$placeholder\"/\"$id\"/" "$config" >"$tmp"
mv "$tmp" "$config"

grep -q "\"$id\"" "$config" || die "failed to write the id into $config"
if grep -q "\"$placeholder\"" "$config"; then die "\"$placeholder\" is still in $config"; fi

echo "Using D1 database '$name' ($id) for \"$placeholder\" in $config." >&2
if [[ -n ${GITHUB_OUTPUT:-} ]]; then
	echo "id=$id" >>"$GITHUB_OUTPUT"
fi
printf '%s\n' "$id"
