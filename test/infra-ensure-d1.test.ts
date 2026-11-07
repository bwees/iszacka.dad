// .github/scripts/ensure-d1.sh: resolves (or creates) a D1 database by name and injects its
// id into exactly one wrangler.toml placeholder. Exercised against a fake `wrangler`.

import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ROOT, run, scratchDir, writeExecutable } from './infra-helpers';

const SCRIPT = join(ROOT, '.github/scripts/ensure-d1.sh');
const PROD_ID = '11111111-1111-4111-8111-111111111111';
const PREVIEW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CREATED_ID = '22222222-2222-4222-8222-222222222222';
const RACED_ID = '33333333-3333-4333-8333-333333333333';

const scratch = scratchDir('ensure-d1');
afterAll(scratch.cleanup);

// A fake wrangler that keeps its "account" in a JSON file and logs every call.
const FAKE_WRANGLER = writeExecutable(
	join(scratch.dir, 'fake-wrangler'),
	`#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$FAKE_LOG"
case "$1 $2" in
	"d1 list")
		if [[ -n \${FAKE_BANNER:-} ]]; then echo "$FAKE_BANNER"; fi
		cat "$FAKE_STATE"
		;;
	"d1 create")
		if [[ -n \${FAKE_CREATE_RACES:-} ]]; then
			jq --arg n "$3" '. + [{"uuid": "${RACED_ID}", "name": $n}]' "$FAKE_STATE" >"$FAKE_STATE.tmp"
			mv "$FAKE_STATE.tmp" "$FAKE_STATE"
			echo "A database with that name already exists" >&2
			exit 1
		fi
		jq --arg n "$3" '. + [{"uuid": "${CREATED_ID}", "name": $n}]' "$FAKE_STATE" >"$FAKE_STATE.tmp"
		mv "$FAKE_STATE.tmp" "$FAKE_STATE"
		echo "Created database $3"
		;;
	*)
		echo "fake wrangler: unexpected command: $*" >&2
		exit 64
		;;
esac
`,
);

let n = 0;
let paths: { config: string; state: string; log: string; output: string };

function setUp(databases: Array<{ uuid: string; name: string }>): void {
	n += 1;
	paths = {
		config: join(scratch.dir, `wrangler-${n}.toml`),
		state: join(scratch.dir, `state-${n}.json`),
		log: join(scratch.dir, `calls-${n}.log`),
		output: join(scratch.dir, `github-output-${n}`),
	};
	copyFileSync(join(ROOT, 'wrangler.toml'), paths.config);
	writeFileSync(paths.state, JSON.stringify(databases));
	writeFileSync(paths.log, '');
}

function ensure(name: string, placeholder: string, env: Record<string, string> = {}) {
	return run('bash', [SCRIPT, name, placeholder, paths.config], {
		env: {
			WRANGLER: `bash ${FAKE_WRANGLER}`,
			FAKE_STATE: paths.state,
			FAKE_LOG: paths.log,
			GITHUB_OUTPUT: paths.output,
			GITHUB_ACTIONS: '',
			...env,
		},
	});
}

const config = () => readFileSync(paths.config, 'utf8');
const calls = () => readFileSync(paths.log, 'utf8');

describe('ensure-d1.sh', () => {
	beforeEach(() => {
		setUp([
			{ uuid: PROD_ID, name: 'iszackadad' },
			{ uuid: PREVIEW_ID, name: 'iszackadad_preview' },
			{ uuid: '44444444-4444-4444-8444-444444444444', name: 'someone-elses-db' },
		]);
	});

	it('injects the production id and leaves the preview placeholder alone', async () => {
		const result = await ensure('iszackadad', 'PLACEHOLDER_D1_ID');
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(PROD_ID);
		expect(config()).toContain(`database_id = "${PROD_ID}"`);
		expect(config()).toContain('"PLACEHOLDER_D1_PREVIEW_ID"');
		expect(config()).not.toContain('"PLACEHOLDER_D1_ID"');
		expect(calls()).not.toContain('d1 create');
	});

	it('injects the preview id and leaves the production placeholder alone', async () => {
		const result = await ensure('iszackadad_preview', 'PLACEHOLDER_D1_PREVIEW_ID');
		expect(result.code, result.stderr).toBe(0);
		expect(config()).toContain(`database_id = "${PREVIEW_ID}"`);
		expect(config()).toContain('"PLACEHOLDER_D1_ID"');
	});

	it('only changes the one placeholder line', async () => {
		const before = config().split('\n');
		await ensure('iszackadad', 'PLACEHOLDER_D1_ID');
		const after = config().split('\n');
		expect(after).toHaveLength(before.length);
		const changed = after.filter((line, i) => line !== before[i]);
		expect(changed).toEqual([`database_id = "${PROD_ID}"`]);
	});

	it('exposes the id as a GitHub Actions step output', async () => {
		await ensure('iszackadad', 'PLACEHOLDER_D1_ID');
		expect(readFileSync(paths.output, 'utf8')).toBe(`id=${PROD_ID}\n`);
	});

	it('creates the database on first deploy, with a European location hint', async () => {
		setUp([]);
		const result = await ensure('iszackadad', 'PLACEHOLDER_D1_ID');
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(CREATED_ID);
		expect(calls()).toContain('d1 create iszackadad --location weur');
		expect(config()).toContain(`database_id = "${CREATED_ID}"`);
	});

	it('survives losing a creation race to a parallel run', async () => {
		setUp([]);
		const result = await ensure('iszackadad_preview', 'PLACEHOLDER_D1_PREVIEW_ID', { FAKE_CREATE_RACES: '1' });
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(RACED_ID);
	});

	it('ignores chatter that wrangler prints before the JSON', async () => {
		const result = await ensure('iszackadad', 'PLACEHOLDER_D1_ID', { FAKE_BANNER: '▲ [WARNING] You are using a fancy new wrangler' });
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(PROD_ID);
	});

	it('refuses to run twice on the same file', async () => {
		expect((await ensure('iszackadad', 'PLACEHOLDER_D1_ID')).code).toBe(0);
		const snapshot = config();
		const again = await ensure('iszackadad', 'PLACEHOLDER_D1_ID');
		expect(again.code).toBe(1);
		expect(again.stderr).toContain('exactly once');
		expect(config()).toBe(snapshot);
	});

	it('rejects names and placeholders that could smuggle in sed syntax', async () => {
		expect((await ensure('bad/name', 'PLACEHOLDER_D1_ID')).code).toBe(1);
		expect((await ensure('iszackadad', 'PLACEHOLDER/D1')).code).toBe(1);
		expect(config()).toContain('"PLACEHOLDER_D1_ID"');
	});

	it('fails loudly when wrangler hands back something that is not an id', async () => {
		setUp([{ uuid: 'not-a-uuid; rm -rf /', name: 'iszackadad' }]);
		const result = await ensure('iszackadad', 'PLACEHOLDER_D1_ID');
		expect(result.code).toBe(1);
		expect(config()).toContain('"PLACEHOLDER_D1_ID"');
	});

	it('prints usage for the wrong number of arguments', async () => {
		const result = await run('bash', [SCRIPT, 'only-one']);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain('usage:');
	});

	it('leaves no temporary files behind', async () => {
		await ensure('iszackadad', 'PLACEHOLDER_D1_ID');
		expect(readdirSync(scratch.dir).filter((name) => name.includes('.ensure-d1.'))).toEqual([]);
	});
});
