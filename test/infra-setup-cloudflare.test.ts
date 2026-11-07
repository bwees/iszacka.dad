// scripts/setup-cloudflare.sh against mock Cloudflare and Resend APIs and a fake wrangler: does
// the right things the first time, nothing the second time, nothing at all in --dry-run, and
// never prints a secret.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROOT, run, scratchDir, writeExecutable } from './infra-helpers';

const SCRIPT = join(ROOT, 'scripts/setup-cloudflare.sh');
const TOKEN = 'test-token-not-a-real-one';
const RESEND_KEY = 're_test_key_not_a_real_one';
const ZONE_ID = 'zone0000000000000000000000000001';
const ACCOUNT_ID = 'acct0000000000000000000000000001';
const SITE_KEY = '0x4AAAAAAAsmoketestsitekey';
const TURNSTILE_SECRET = '0x4AAAAAAAsmoketestsecret';
const ROTATED_SECRET = '0x4AAAAAAArotatedsecret';
const WEBHOOK_SECRET = 'whsec_dGVzdC1zaWduaW5nLXNlY3JldA==';
const WEBHOOK_URL = 'https://iszacka.dad/api/resend/webhook';
const DKIM = 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDtestkeyAB';

interface DnsRecord {
	id: string;
	type: string;
	name: string;
	content: string;
	priority?: number;
	proxied?: boolean;
}

interface MockState {
	routingEnabled: boolean;
	dns: DnsRecord[];
	domain: null | {
		id: string;
		status: string;
		region: string;
		capabilities: { sending: string; receiving: string };
	};
	webhooks: Array<{ id: string; endpoint: string; events: string[]; status: string; signing_secret: string }>;
	/** Resend's retrieve endpoint leaves the secret out (to test delete + recreate). */
	hideWebhookSecret: boolean;
	widgets: Array<{ sitekey: string; secret: string; name: string; domains: string[] }>;
	/** Cloudflare's widget details leave the secret out (to test rotation). */
	hideWidgetSecret: boolean;
	/** Whether POST /domains/{id}/verify succeeds straight away. */
	verifies: boolean;
	workerExists: boolean;
}

interface Request {
	api: 'cf' | 'resend';
	method: string;
	path: string;
	body: unknown;
	authorization: string | undefined;
	userAgent: string | undefined;
}

let state: MockState;
let requests: Request[] = [];
let server: Server;
let cfBase = '';
let resendBase = '';
let nextId = 100;

const scratch = scratchDir('setup-cloudflare');

function freshState(): MockState {
	return {
		routingEnabled: true,
		dns: [
			{ id: 'mx1', type: 'MX', name: 'iszacka.dad', content: 'route1.mx.cloudflare.net', priority: 13 },
			{ id: 'mx2', type: 'MX', name: 'iszacka.dad', content: 'route2.mx.cloudflare.net', priority: 86 },
			{ id: 'mx3', type: 'MX', name: 'iszacka.dad', content: 'route3.mx.cloudflare.net', priority: 24 },
			{ id: 'mx4', type: 'MX', name: 'iszacka.dad', content: 'mx.old-provider.example', priority: 50 },
			{ id: 'spf', type: 'TXT', name: 'iszacka.dad', content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' },
		],
		domain: null,
		webhooks: [],
		hideWebhookSecret: false,
		widgets: [],
		hideWidgetSecret: false,
		verifies: true,
		workerExists: true,
	};
}

/** The records Resend lists for the domain: a mix of relative, "@" and fully qualified names. */
function resendRecords(capabilities: { receiving: string }) {
	const records: Array<Record<string, unknown>> = [
		{ record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: DKIM, ttl: 'Auto', status: 'not_started' },
		{ record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10, ttl: 'Auto', status: 'not_started' },
		{ record: 'SPF', name: 'send.iszacka.dad', type: 'TXT', value: '"v=spf1 include:amazonses.com ~all"', ttl: 'Auto', status: 'not_started' },
	];
	if (capabilities.receiving === 'enabled') {
		records.push({ record: 'Receiving', name: '@', type: 'MX', value: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10, ttl: 'Auto', status: 'not_started' });
	}
	return records;
}

const cfOk = (result: unknown) => ({ success: true, errors: [], messages: [], result });
const cfNotFound = { success: false, errors: [{ code: 10007, message: 'not found' }], messages: [], result: null };

function cloudflare(method: string, url: URL, path: string, body: unknown): [number, unknown] {
	const zone = `/zones/${ZONE_ID}`;
	const account = `/accounts/${ACCOUNT_ID}`;

	if (method === 'GET' && path === '/zones') {
		const zones = [{ id: ZONE_ID, name: 'iszacka.dad', status: 'active', account: { id: ACCOUNT_ID, name: 'Test' } }];
		return [200, cfOk(zones.filter((z) => z.name === url.searchParams.get('name')))];
	}
	if (method === 'GET' && path === `${account}/workers/services/iszacka-dad`) {
		return state.workerExists ? [200, cfOk({ id: 'iszacka-dad' })] : [404, cfNotFound];
	}
	if (method === 'GET' && path === `${zone}/email/routing`) {
		return [200, cfOk({ enabled: state.routingEnabled, name: 'iszacka.dad' })];
	}
	if (method === 'DELETE' && path === `${zone}/email/routing/dns`) {
		// Disabling Email Routing takes its own MX records with it.
		state.routingEnabled = false;
		state.dns = state.dns.filter((r) => !(r.type === 'MX' && r.content.endsWith('.mx.cloudflare.net')));
		return [200, cfOk({ enabled: false })];
	}
	if (path === `${zone}/dns_records`) {
		if (method === 'GET') {
			const type = url.searchParams.get('type');
			const name = url.searchParams.get('name');
			return [200, cfOk(state.dns.filter((r) => (!type || r.type === type) && (!name || r.name === name)))];
		}
		if (method === 'POST') {
			const record = { id: `rec${nextId++}`, proxied: false, ...(body as Omit<DnsRecord, 'id'>) };
			state.dns.push(record);
			return [200, cfOk(record)];
		}
	}
	const recordMatch = new RegExp(`^${zone}/dns_records/([\\w-]+)$`).exec(path);
	if (recordMatch) {
		const index = state.dns.findIndex((r) => r.id === recordMatch[1]);
		if (index < 0) return [404, cfNotFound];
		if (method === 'DELETE') {
			state.dns.splice(index, 1);
			return [200, cfOk({ id: recordMatch[1] })];
		}
		if (method === 'PUT' || method === 'PATCH') {
			state.dns[index] = { ...(state.dns[index] as DnsRecord), ...(body as object) };
			return [200, cfOk(state.dns[index])];
		}
	}
	if (path === `${account}/challenges/widgets`) {
		if (method === 'GET') return [200, cfOk(state.widgets.map(({ secret: _secret, ...rest }) => rest))];
		if (method === 'POST') {
			const { name, domains } = body as { name: string; domains: string[] };
			const widget = { sitekey: SITE_KEY, secret: TURNSTILE_SECRET, name, domains };
			state.widgets.push(widget);
			return [200, cfOk(widget)];
		}
	}
	if (method === 'GET' && path === `${account}/challenges/widgets/${SITE_KEY}`) {
		const widget = state.widgets.find((w) => w.sitekey === SITE_KEY);
		if (!widget) return [404, cfNotFound];
		return [200, cfOk(state.hideWidgetSecret ? { ...widget, secret: undefined } : widget)];
	}
	if (method === 'POST' && path === `${account}/challenges/widgets/${SITE_KEY}/rotate_secret`) {
		const widget = state.widgets.find((w) => w.sitekey === SITE_KEY);
		if (!widget) return [404, cfNotFound];
		widget.secret = ROTATED_SECRET;
		return [200, cfOk(widget)];
	}
	return [404, { success: false, errors: [{ code: 7003, message: `mock has no ${method} ${path}` }], messages: [] }];
}

function resend(method: string, path: string, body: unknown): [number, unknown] {
	const error = (status: number, name: string) => [status, { statusCode: status, name, message: name }] as [number, unknown];
	if (path === '/domains') {
		if (method === 'GET') {
			const d = state.domain;
			return [200, { object: 'list', has_more: false, data: d ? [{ id: d.id, name: 'iszacka.dad', status: d.status, region: d.region, capabilities: d.capabilities }] : [] }];
		}
		if (method === 'POST') {
			const b = body as { name: string; region: string; capabilities: MockState['domain'] extends null ? never : { sending: string; receiving: string } };
			state.domain = { id: 'dom-1', status: 'not_started', region: b.region, capabilities: { ...b.capabilities } };
			return [201, { id: 'dom-1', name: b.name, status: 'not_started', records: resendRecords(b.capabilities) }];
		}
	}
	if (state.domain && path === `/domains/${state.domain.id}`) {
		const d = state.domain;
		if (method === 'GET') {
			return [200, { object: 'domain', id: d.id, name: 'iszacka.dad', status: d.status, region: d.region, capabilities: d.capabilities, records: resendRecords(d.capabilities) }];
		}
		if (method === 'PATCH') {
			d.capabilities = { ...d.capabilities, ...(body as { capabilities: object }).capabilities };
			return [200, { object: 'domain', id: d.id }];
		}
	}
	if (state.domain && method === 'POST' && path === `/domains/${state.domain.id}/verify`) {
		state.domain.status = state.verifies ? 'verified' : 'pending';
		return [200, { object: 'domain', id: state.domain.id }];
	}
	if (path === '/webhooks') {
		if (method === 'GET') return [200, { object: 'list', has_more: false, data: state.webhooks.map(({ signing_secret: _s, ...rest }) => rest) }];
		if (method === 'POST') {
			const b = body as { endpoint: string; events: string[] };
			const hook = { id: `hook-${nextId++}`, endpoint: b.endpoint, events: b.events, status: 'enabled', signing_secret: WEBHOOK_SECRET };
			state.webhooks.push(hook);
			return [201, { object: 'webhook', id: hook.id, signing_secret: hook.signing_secret }];
		}
	}
	const hookMatch = /^\/webhooks\/([\w-]+)$/.exec(path);
	if (hookMatch) {
		const index = state.webhooks.findIndex((h) => h.id === hookMatch[1]);
		if (index < 0) return error(404, 'not_found');
		const hook = state.webhooks[index] as MockState['webhooks'][number];
		if (method === 'GET') return [200, { object: 'webhook', ...hook, signing_secret: state.hideWebhookSecret ? undefined : hook.signing_secret }];
		if (method === 'PATCH') {
			Object.assign(hook, body);
			return [200, { object: 'webhook', id: hook.id }];
		}
		if (method === 'DELETE') {
			state.webhooks.splice(index, 1);
			return [200, { object: 'webhook', id: hook.id, deleted: true }];
		}
	}
	return error(404, `mock has no ${method} ${path}`);
}

function handle(req: IncomingMessage, res: ServerResponse): void {
	let raw = '';
	req.on('data', (chunk) => (raw += chunk));
	req.on('end', () => {
		const url = new URL(req.url ?? '/', 'http://mock');
		let body: unknown = null;
		try {
			body = raw ? JSON.parse(raw) : null;
		} catch {
			body = raw;
		}
		const method = req.method ?? 'GET';
		const api = url.pathname.startsWith('/resend') ? 'resend' : 'cf';
		const path = url.pathname.replace(/^\/client\/v4|^\/resend/, '');
		requests.push({ api, method, path: path + url.search, body, authorization: req.headers.authorization, userAgent: req.headers['user-agent'] });
		const [status, payload] = api === 'resend' ? resend(method, path, body) : cloudflare(method, url, path, body);
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(payload));
	});
}

// A fake wrangler: `secret list` answers from a file, `secret put` records name=value there.
const SECRETS_FILE = join(scratch.dir, 'worker-secrets.txt');
const WRANGLER_LOG = join(scratch.dir, 'wrangler-calls.log');
const FAKE_WRANGLER = writeExecutable(
	join(scratch.dir, 'fake-wrangler'),
	`#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"${WRANGLER_LOG}"
case "$1 $2" in
	"secret list")
		printf '['
		sep=""
		while IFS='=' read -r name _; do
			[[ -n $name ]] || continue
			printf '%s{"name":"%s","type":"secret_text"}' "$sep" "$name"
			sep=","
		done <"${SECRETS_FILE}"
		printf ']\\n'
		;;
	"secret put")
		value=$(cat)
		grep -v "^$3=" "${SECRETS_FILE}" >"${SECRETS_FILE}.new" || true
		printf '%s=%s\\n' "$3" "$value" >>"${SECRETS_FILE}.new"
		mv "${SECRETS_FILE}.new" "${SECRETS_FILE}"
		echo "Success! Uploaded secret $3"
		;;
	*) echo "fake wrangler: unexpected: $*" >&2; exit 64 ;;
esac
`,
);

function workerSecrets(): Record<string, string> {
	return Object.fromEntries(
		readFileSync(SECRETS_FILE, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
	);
}

function setup(args: string[] = [], env: Record<string, string> = {}) {
	return run('bash', [SCRIPT, ...args], {
		env: {
			CLOUDFLARE_API_TOKEN: TOKEN,
			CLOUDFLARE_ACCOUNT_ID: '',
			RESEND_API_KEY: RESEND_KEY,
			CLOUDFLARE_API_BASE: cfBase,
			RESEND_API_BASE: resendBase,
			WRANGLER: `bash ${FAKE_WRANGLER}`,
			VERIFY_WAIT_SECONDS: '0',
			VERIFY_POLL_SECONDS: '0',
			GITHUB_ACTIONS: '',
			...env,
		},
		timeoutMs: 60_000,
	});
}

const mutations = () => requests.filter((r) => r.method !== 'GET');
const wranglerPuts = () => readFileSync(WRANGLER_LOG, 'utf8').split('\n').filter((line) => line.startsWith('secret put'));
const apexMx = () => state.dns.filter((r) => r.type === 'MX' && r.name === 'iszacka.dad').map((r) => r.content);

beforeAll(async () => {
	server = createServer(handle);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	cfBase = `${base}/client/v4`;
	resendBase = `${base}/resend`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	scratch.cleanup();
});

beforeEach(() => {
	state = freshState();
	requests = [];
	writeFileSync(WRANGLER_LOG, '');
	writeFileSync(SECRETS_FILE, 'ADMIN_PASSWORD=x\nRESEND_API_KEY=y\n');
});

describe('setup-cloudflare.sh', () => {
	it('is valid bash', async () => {
		expect((await run('bash', ['-n', SCRIPT])).code).toBe(0);
	});

	it('sets everything up on a fresh account', async () => {
		const result = await setup();
		expect(result.code, result.stdout + result.stderr).toBe(0);

		// Resend domain: eu-west-1, both capabilities, verification asked for.
		const created = requests.find((r) => r.api === 'resend' && r.method === 'POST' && r.path === '/domains');
		expect(created?.body).toEqual({ name: 'iszacka.dad', region: 'eu-west-1', capabilities: { sending: 'enabled', receiving: 'enabled' } });
		expect(requests.some((r) => r.method === 'POST' && r.path === '/domains/dom-1/verify')).toBe(true);
		expect(state.domain?.status).toBe('verified');

		// Email Routing off; only Resend's MX left at the apex; the stray one was removed and reported.
		expect(state.routingEnabled).toBe(false);
		expect(apexMx()).toEqual(['inbound-smtp.eu-west-1.amazonaws.com']);
		expect(result.stdout).toContain('Removed MX iszacka.dad → mx.old-provider.example (priority 50)');

		// Every Resend record, at the right FQDN, unproxied, MX with priority, TXT quoted.
		expect(state.dns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'TXT', name: 'resend._domainkey.iszacka.dad', content: `"${DKIM}"` }),
				expect.objectContaining({ type: 'MX', name: 'send.iszacka.dad', content: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 }),
				expect.objectContaining({ type: 'TXT', name: 'send.iszacka.dad', content: '"v=spf1 include:amazonses.com ~all"' }),
				expect.objectContaining({ type: 'MX', name: 'iszacka.dad', content: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }),
				expect.objectContaining({ type: 'TXT', name: '_dmarc.iszacka.dad', content: '"v=DMARC1; p=quarantine; adkim=r; aspf=r"' }),
			]),
		);
		expect(state.dns.every((r) => r.proxied !== true)).toBe(true);

		// Webhook with the three events, its secret on the Worker.
		expect(state.webhooks).toEqual([
			expect.objectContaining({ endpoint: WEBHOOK_URL, events: ['email.received', 'email.bounced', 'email.complained'] }),
		]);
		// Turnstile widget, both halves on the Worker.
		const widgetRequest = requests.find((r) => r.method === 'POST' && r.path.endsWith('/challenges/widgets'));
		expect(widgetRequest?.body).toEqual({ name: 'iszacka.dad', domains: ['iszacka.dad'], mode: 'managed' });
		expect(workerSecrets()).toMatchObject({
			RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
			TURNSTILE_SITE_KEY: SITE_KEY,
			TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
		});
		expect(wranglerPuts().every((line) => line.endsWith('--name iszacka-dad'))).toBe(true);
	});

	it('never prints a secret or a token', async () => {
		const result = await setup();
		const output = result.stdout + result.stderr;
		for (const secret of [TOKEN, RESEND_KEY, WEBHOOK_SECRET, TURNSTILE_SECRET]) expect(output).not.toContain(secret);
	});

	it('masks the secrets it discovers when running in GitHub Actions', async () => {
		const result = await setup([], { GITHUB_ACTIONS: 'true' });
		expect(result.stdout).toContain(`::add-mask::${WEBHOOK_SECRET}`);
		expect(result.stdout).toContain(`::add-mask::${TURNSTILE_SECRET}`);
		expect(result.stdout.split(WEBHOOK_SECRET)).toHaveLength(2);
	});

	it('authenticates every call, and sends Resend a User-Agent', async () => {
		await setup();
		expect(requests.length).toBeGreaterThan(10);
		for (const r of requests) {
			expect(r.authorization).toBe(`Bearer ${r.api === 'cf' ? TOKEN : RESEND_KEY}`);
			if (r.api === 'resend') expect(r.userAgent).toMatch(/^iszacka\.dad-setup\//);
		}
	});

	it('changes nothing the second time round', async () => {
		await setup();
		requests = [];
		writeFileSync(WRANGLER_LOG, '');
		const again = await setup();
		expect(again.code, again.stdout + again.stderr).toBe(0);
		expect(mutations()).toEqual([]);
		expect(wranglerPuts()).toEqual([]);
		expect(again.stdout).toContain('Cloudflare and Resend are set up');
		expect(state.dns.filter((r) => r.name === '_dmarc.iszacka.dad')).toHaveLength(1);
	});

	it('only looks in --dry-run', async () => {
		const result = await setup(['--dry-run']);
		expect(result.code, result.stdout + result.stderr).toBe(0);
		expect(mutations()).toEqual([]);
		expect(wranglerPuts()).toEqual([]);
		expect(result.stdout).toContain('Would create the Resend domain iszacka.dad in eu-west-1');
		expect(result.stdout).toContain('Would disable Cloudflare Email Routing');
		expect(result.stdout).toContain('Would create the webhook');
		expect(result.stdout).toContain('Would create a managed Turnstile widget');
		expect(result.stdout).toContain('Would add TXT _dmarc.iszacka.dad');
	});

	it('turns receiving on for an existing domain, then adds its MX', async () => {
		state.domain = { id: 'dom-1', status: 'verified', region: 'eu-west-1', capabilities: { sending: 'enabled', receiving: 'disabled' } };
		const result = await setup();
		expect(result.code, result.stdout + result.stderr).toBe(0);
		const patch = requests.find((r) => r.api === 'resend' && r.method === 'PATCH');
		expect(patch).toMatchObject({ path: '/domains/dom-1', body: { capabilities: { receiving: 'enabled' } } });
		expect(apexMx()).toEqual(['inbound-smtp.eu-west-1.amazonaws.com']);
		expect(requests.some((r) => r.api === 'resend' && r.method === 'POST' && r.path === '/domains')).toBe(false);
	});

	it('fixes a wrong MX priority and a stale SPF record in place', async () => {
		await setup();
		const mx = state.dns.find((r) => r.type === 'MX' && r.name === 'send.iszacka.dad') as DnsRecord;
		mx.priority = 20;
		const spf = state.dns.find((r) => r.type === 'TXT' && r.name === 'send.iszacka.dad') as DnsRecord;
		spf.content = '"v=spf1 -all"';
		requests = [];
		const again = await setup();
		expect(again.code, again.stdout + again.stderr).toBe(0);
		expect(mutations().map((r) => `${r.method} ${r.path}`)).toEqual([`PUT /zones/${ZONE_ID}/dns_records/${mx.id}`, `PUT /zones/${ZONE_ID}/dns_records/${spf.id}`]);
		expect(state.dns.filter((r) => r.name === 'send.iszacka.dad')).toHaveLength(2);
		expect(state.dns.find((r) => r.id === mx.id)?.priority).toBe(10);
		expect(state.dns.find((r) => r.id === spf.id)?.content).toBe('"v=spf1 include:amazonses.com ~all"');
	});

	it('recreates a webhook whose secret it cannot read, when the Worker lacks it', async () => {
		state.webhooks.push({ id: 'hook-old', endpoint: WEBHOOK_URL, events: ['email.received'], status: 'disabled', signing_secret: 'whsec_b2xk' });
		state.hideWebhookSecret = true;
		const result = await setup();
		expect(result.code, result.stdout + result.stderr).toBe(0);
		expect(requests.some((r) => r.method === 'PATCH' && r.path === '/webhooks/hook-old')).toBe(true);
		expect(requests.some((r) => r.method === 'DELETE' && r.path === '/webhooks/hook-old')).toBe(true);
		expect(state.webhooks).toEqual([expect.objectContaining({ endpoint: WEBHOOK_URL, signing_secret: WEBHOOK_SECRET })]);
		expect(workerSecrets().RESEND_WEBHOOK_SECRET).toBe(WEBHOOK_SECRET);
	});

	it('uses a readable webhook secret without recreating anything', async () => {
		state.webhooks.push({ id: 'hook-old', endpoint: WEBHOOK_URL, events: ['email.received', 'email.bounced', 'email.complained'], status: 'enabled', signing_secret: 'whsec_b2xk' });
		const result = await setup();
		expect(result.code, result.stdout + result.stderr).toBe(0);
		expect(requests.some((r) => r.api === 'resend' && r.path.startsWith('/webhooks') && r.method !== 'GET')).toBe(false);
		expect(workerSecrets().RESEND_WEBHOOK_SECRET).toBe('whsec_b2xk');
	});

	it('rotates the Turnstile secret when the widget exists but its secret is unreadable and the Worker lacks it', async () => {
		state.widgets.push({ sitekey: SITE_KEY, secret: TURNSTILE_SECRET, name: 'iszacka.dad', domains: ['iszacka.dad'] });
		state.hideWidgetSecret = true;
		const result = await setup();
		expect(result.code, result.stdout + result.stderr).toBe(0);
		const rotate = requests.find((r) => r.path.endsWith('/rotate_secret'));
		expect(rotate?.body).toEqual({ invalidate_immediately: false });
		expect(workerSecrets()).toMatchObject({ TURNSTILE_SITE_KEY: SITE_KEY, TURNSTILE_SECRET_KEY: ROTATED_SECRET });
		expect(result.stdout).not.toContain(ROTATED_SECRET);
	});

	it('leaves Turnstile alone when the widget and both secrets exist', async () => {
		state.widgets.push({ sitekey: SITE_KEY, secret: TURNSTILE_SECRET, name: 'iszacka.dad', domains: ['iszacka.dad'] });
		writeFileSync(SECRETS_FILE, 'TURNSTILE_SITE_KEY=a\nTURNSTILE_SECRET_KEY=b\n');
		await setup();
		expect(wranglerPuts().filter((line) => line.includes('TURNSTILE'))).toEqual([]);
		expect(requests.some((r) => r.path.endsWith('/rotate_secret'))).toBe(false);
	});

	it('re-stores secrets with --force-secrets', async () => {
		await setup();
		writeFileSync(WRANGLER_LOG, '');
		await setup(['--force-secrets']);
		expect(wranglerPuts().map((line) => line.split(' ')[2]).sort()).toEqual(['RESEND_WEBHOOK_SECRET', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY']);
	});

	it('waits for the Worker before storing secrets, but does the rest', async () => {
		state.workerExists = false;
		const result = await setup();
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("doesn't exist yet");
		expect(wranglerPuts()).toEqual([]);
		expect(state.domain).not.toBeNull();
	});

	it("reports a domain that hasn't verified yet without failing", async () => {
		state.verifies = false;
		const result = await setup();
		expect(result.code, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain("Resend says 'pending' for now");
	});

	it('leaves an existing DMARC record alone', async () => {
		state.dns.push({ id: 'dmarc', type: 'TXT', name: '_dmarc.iszacka.dad', content: '"v=DMARC1; p=reject"' });
		await setup();
		expect(requests.some((r) => r.method === 'POST' && (r.body as { name?: string } | null)?.name === '_dmarc.iszacka.dad')).toBe(false);
	});

	it('needs RESEND_API_KEY', async () => {
		const result = await setup([], { RESEND_API_KEY: '' });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("RESEND_API_KEY isn't set");
		expect(requests).toEqual([]);
	});

	it('stops early when the zone is missing', async () => {
		const result = await setup([], { ZONE: 'not-our-zone.example' });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("isn't a zone this token can see");
		expect(mutations()).toEqual([]);
	});

	it('refuses a zone from a different account than CLOUDFLARE_ACCOUNT_ID', async () => {
		const result = await setup([], { CLOUDFLARE_ACCOUNT_ID: 'some-other-account' });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('belongs to account');
		expect(mutations()).toEqual([]);
	});
});
