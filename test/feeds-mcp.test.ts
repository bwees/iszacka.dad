import { describe, expect, it } from 'vitest';
import { MCP_SUPPORTED_VERSIONS, type McpDeps, mcpTools, RPC, decodeMcpHeaderValue, handleMcpHttp, isAcceptableOrigin } from '../src/lib/feeds-mcp';
import type { SiteState, Update } from '../src/types';
import { validate } from './feeds-schema-helper';

const SITE = 'https://iszacka.dad';
const MODERN = '2026-07-28';

const UPDATES: Update[] = Array.from({ length: 12 }, (_, i) => {
	const id = 12 - i;
	return {
		id,
		kind: 'daily',
		title: `Day ${id}: still no.`,
		body: id % 2 ? 'Nothing to report.' : '',
		status: 'no',
		audience: 'daily',
		createdAt: `2026-11-${String(id).padStart(2, '0')}T09:00:00.000Z`,
		notifiedAt: null,
	};
});

function deps(over: Partial<McpDeps> & { state?: SiteState } = {}): McpDeps {
	return {
		state: { status: 'no', statusChangedAt: '2026-11-01T09:00:00.000Z', dueDate: '2026-11-20' },
		today: '2026-11-06',
		siteUrl: SITE,
		getChecks: async () => 1234,
		listUpdates: async ({ limit, beforeId }) => UPDATES.filter((u) => !beforeId || u.id < beforeId).slice(0, limit),
		forecast: (_due, today) => [
			{ date: today, probability: 0.05, label: 'Mostly calm', emoji: '☀' },
			{ date: '2026-11-07', probability: 0.12, label: 'Scattered contractions', emoji: '⛅' },
		],
		babySize: () => ({ week: 38, day: 0, fruit: 'pumpkin', emoji: '🎃' }),
		...over,
	};
}

type Json = Record<string, any>;

async function post(body: unknown, headers: Record<string, string> = {}, d: McpDeps = deps()) {
	const res = await handleMcpHttp(
		new Request(`${SITE}/mcp`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
			body: typeof body === 'string' ? body : JSON.stringify(body),
		}),
		d,
	);
	const text = await res.text();
	return { res, text, json: (text ? JSON.parse(text) : null) as Json };
}

const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };

/** A well-formed 2026-07-28 request: body _meta plus the mirrored headers. */
function modern(method: string, params: Json = {}, id: number | string = 1) {
	const headers: Record<string, string> = { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method };
	if (method === 'tools/call') headers['Mcp-Name'] = String(params.name);
	return post({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }, headers);
}

function legacy(method: string, params: Json | undefined, version?: string, id: number | string = 1) {
	return post({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, version ? { 'MCP-Protocol-Version': version } : {});
}

describe('legacy lifecycle (initialize-based)', () => {
	it('negotiates a supported version and describes itself', async () => {
		const { res, json } = await legacy('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(res.headers.get('mcp-session-id')).toBeNull();
		expect(json.result.protocolVersion).toBe('2025-06-18');
		expect(json.result.capabilities).toEqual({ tools: { listChanged: false } });
		expect(json.result.serverInfo).toMatchObject({ name: 'iszacka-dad', version: '1.0.0', title: 'Is Zack a Dad?' });
		expect(json.result.instructions).toMatch(/is_zack_a_dad/);
		expect(json.result.resultType).toBeUndefined();
	});

	it.each(['2025-03-26', '2025-06-18', '2025-11-25'])('echoes %s', async (version) => {
		const { json } = await legacy('initialize', { protocolVersion: version, capabilities: {} });
		expect(json.result.protocolVersion).toBe(version);
	});

	it('offers its latest legacy version for anything else', async () => {
		const { json } = await legacy('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
		expect(json.result.protocolVersion).toBe('2025-11-25');
		expect(json.result.serverInfo.websiteUrl).toBe(`${SITE}/`);
	});

	it('keeps 2025-03-26 serverInfo minimal', async () => {
		const { json } = await legacy('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
		expect(json.result.serverInfo).toEqual({ name: 'iszacka-dad', version: '1.0.0' });
	});

	it('rejects initialize without a protocol version', async () => {
		const { res, json } = await legacy('initialize', {});
		expect(res.status).toBe(400);
		expect(json.error.code).toBe(RPC.INVALID_PARAMS);
	});

	it('accepts notifications/initialized with 202 and no body', async () => {
		const { res, text } = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'MCP-Protocol-Version': '2025-06-18' });
		expect(res.status).toBe(202);
		expect(text).toBe('');
	});

	it('answers ping', async () => {
		const { res, json } = await legacy('ping', undefined, '2025-11-25', 'p1');
		expect(res.status).toBe(200);
		expect(json).toEqual({ jsonrpc: '2.0', id: 'p1', result: {} });
	});

	it('treats a missing MCP-Protocol-Version header as 2025-03-26 (no output schemas)', async () => {
		const { json } = await legacy('tools/list', {});
		expect(json.result.tools.map((t: Json) => t.name)).toEqual(['is_zack_a_dad', 'get_due_date_info', 'get_recent_updates', 'get_dad_forecast']);
		expect(json.result.tools[0].outputSchema).toBeUndefined();
		expect(json.result.tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
	});

	it('includes titles and output schemas from 2025-06-18', async () => {
		const { json } = await legacy('tools/list', {}, '2025-06-18');
		for (const tool of json.result.tools) {
			expect(tool.title).toBeTypeOf('string');
			expect(tool.outputSchema.type).toBe('object');
			expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
		}
		expect(json.result.ttlMs).toBeUndefined();
	});

	it('rejects an unknown MCP-Protocol-Version header with the supported list', async () => {
		const { res, json } = await legacy('tools/list', {}, '1999-01-01');
		expect(res.status).toBe(400);
		expect(json.error.code).toBe(RPC.UNSUPPORTED_PROTOCOL_VERSION);
		expect(json.error.data).toEqual({ supported: [...MCP_SUPPORTED_VERSIONS], requested: '1999-01-01' });
	});

	it('returns -32601 for unknown methods', async () => {
		const { res, json } = await legacy('resources/list', {}, '2025-06-18');
		expect(res.status).toBe(200);
		expect(json.error.code).toBe(RPC.METHOD_NOT_FOUND);
	});
});

describe('modern (2026-07-28, per-request metadata)', () => {
	it('implements server/discover', async () => {
		const { res, json } = await modern('server/discover');
		expect(res.status).toBe(200);
		expect(json.result).toMatchObject({
			resultType: 'complete',
			supportedVersions: [...MCP_SUPPORTED_VERSIONS],
			capabilities: { tools: { listChanged: false } },
			cacheScope: 'public',
		});
		expect(json.result.ttlMs).toBeGreaterThan(0);
		expect(json.result._meta['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'iszacka-dad' });
	});

	it('lists tools with caching hints and resultType', async () => {
		const { json } = await modern('tools/list');
		expect(json.result.resultType).toBe('complete');
		expect(json.result.cacheScope).toBe('public');
		expect(json.result.ttlMs).toBe(3_600_000);
		expect(json.result.tools).toHaveLength(4);
		expect(json.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('iszacka-dad');
	});

	it('rejects a cursor it never issued', async () => {
		const { res, json } = await modern('tools/list', { cursor: 'abc' });
		expect(res.status).toBe(400);
		expect(json.error.code).toBe(RPC.INVALID_PARAMS);
	});

	it('no longer supports ping (404, -32601)', async () => {
		const { res, json } = await modern('ping');
		expect(res.status).toBe(404);
		expect(json.error.code).toBe(RPC.METHOD_NOT_FOUND);
	});

	it('requires the MCP-Protocol-Version header to match _meta', async () => {
		let r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, { 'Mcp-Method': 'tools/list' });
		expect(r.res.status).toBe(400);
		expect(r.json.error.code).toBe(RPC.HEADER_MISMATCH);
		r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, { 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Method': 'tools/list' });
		expect(r.res.status).toBe(400);
		expect(r.json.error.code).toBe(RPC.HEADER_MISMATCH);
	});

	it('requires Mcp-Method to match the body', async () => {
		let r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, { 'MCP-Protocol-Version': MODERN });
		expect(r.json.error.code).toBe(RPC.HEADER_MISMATCH);
		r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call' });
		expect(r.res.status).toBe(400);
		expect(r.json.error.message).toMatch(/Mcp-Method/);
	});

	it('requires Mcp-Name on tools/call, accepting the base64 sentinel', async () => {
		const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'is_zack_a_dad', arguments: {}, _meta: meta } };
		const base = { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call' };
		expect((await post(body, base)).json.error.code).toBe(RPC.HEADER_MISMATCH);
		expect((await post(body, { ...base, 'Mcp-Name': 'get_dad_forecast' })).json.error.code).toBe(RPC.HEADER_MISMATCH);
		const encoded = `=?base64?${btoa('is_zack_a_dad')}?=`;
		const ok = await post(body, { ...base, 'Mcp-Name': encoded });
		expect(ok.res.status).toBe(200);
		expect(ok.json.result.isError).toBe(false);
	});

	it('rejects unsupported versions with -32022 and the supported list', async () => {
		const { res, json } = await post(
			{ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } },
			{ 'MCP-Protocol-Version': '1900-01-01', 'Mcp-Method': 'tools/list' },
		);
		expect(res.status).toBe(400);
		expect(json).toEqual({
			jsonrpc: '2.0',
			id: 9,
			error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [...MCP_SUPPORTED_VERSIONS], requested: '1900-01-01' } },
		});
	});

	it('rejects requests missing required _meta fields with 400 / -32602', async () => {
		let r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' });
		expect(r.res.status).toBe(400);
		expect(r.json.error.code).toBe(RPC.INVALID_PARAMS);
		r = await post(
			{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } },
			{ 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' },
		);
		expect(r.res.status).toBe(400);
		expect(r.json.error.message).toMatch(/clientCapabilities/);
	});

	it('returns 404 for unknown methods', async () => {
		const { res, json } = await modern('prompts/list');
		expect(res.status).toBe(404);
		expect(json.error.code).toBe(RPC.METHOD_NOT_FOUND);
	});
});

describe('tools', () => {
	const schemaOf = (name: string) => mcpTools().find((t) => t.name === name)?.outputSchema ?? {};

	it('is_zack_a_dad answers, with structured content matching its schema', async () => {
		const { json } = await modern('tools/call', { name: 'is_zack_a_dad', arguments: {} });
		const result = json.result;
		expect(result.resultType).toBe('complete');
		expect(result.isError).toBe(false);
		expect(result.content[0].text).toMatch(/^No\. Zack is not a dad\. Yet\./);
		expect(JSON.parse(result.content[1].text)).toEqual(result.structuredContent);
		expect(result.structuredContent).toEqual({
			isZackADad: false,
			status: 'no',
			answer: 'NO',
			sentence: 'Zack is not a dad. Yet.',
			statusChangedAt: '2026-11-01T09:00:00.000Z',
			checks: 1234,
		});
		expect(validate(result.structuredContent, schemaOf('is_zack_a_dad'))).toEqual([]);
	});

	it('get_due_date_info counts down and compares the baby to produce', async () => {
		const { json } = await modern('tools/call', { name: 'get_due_date_info' });
		const s = json.result.structuredContent;
		expect(s).toMatchObject({ dueDate: '2026-11-20', daysUntilDue: 14, overdue: false, babySize: { fruit: 'pumpkin' } });
		expect(json.result.content[0].text).toMatch(/14 days to go/);
		expect(validate(s, schemaOf('get_due_date_info'))).toEqual([]);
	});

	it('get_due_date_info copes without a due date', async () => {
		const { json } = await post(
			{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_due_date_info', arguments: {} } },
			{ 'MCP-Protocol-Version': '2025-06-18' },
			deps({ state: { status: 'no', statusChangedAt: '2026-11-01T09:00:00.000Z', dueDate: null }, babySize: () => null }),
		);
		expect(json.result.structuredContent).toMatchObject({ dueDate: null, daysUntilDue: null, overdue: false, babySize: null });
		expect(validate(json.result.structuredContent, schemaOf('get_due_date_info'))).toEqual([]);
	});

	it('get_recent_updates paginates', async () => {
		const first = await modern('tools/call', { name: 'get_recent_updates', arguments: { limit: 5 } });
		const s = first.json.result.structuredContent;
		expect(s.updates.map((u: Json) => u.id)).toEqual([12, 11, 10, 9, 8]);
		expect(s.nextBefore).toBe(8);
		expect(s.updates[0].url).toBe(`${SITE}/updates/12`);
		expect(validate(s, schemaOf('get_recent_updates'))).toEqual([]);
		const last = await modern('tools/call', { name: 'get_recent_updates', arguments: { limit: 20, before: 3 } });
		expect(last.json.result.structuredContent).toMatchObject({ nextBefore: null });
		expect(last.json.result.structuredContent.updates.map((u: Json) => u.id)).toEqual([2, 1]);
	});

	it('get_recent_updates defaults to five', async () => {
		const { json } = await modern('tools/call', { name: 'get_recent_updates' });
		expect(json.result.structuredContent.updates).toHaveLength(5);
	});

	it.each([{ limit: 0 }, { limit: 21 }, { limit: 2.5 }, { limit: '5' }, { before: 0 }, { colour: 'blue' }])(
		'reports invalid arguments %j as a tool error',
		async (args) => {
			const { res, json } = await modern('tools/call', { name: 'get_recent_updates', arguments: args });
			expect(res.status).toBe(200);
			expect(json.result.isError).toBe(true);
			expect(json.result.content[0].text).toBeTypeOf('string');
		},
	);

	it('rejects arguments on tools that take none', async () => {
		const { json } = await modern('tools/call', { name: 'is_zack_a_dad', arguments: { please: 1 } });
		expect(json.result.isError).toBe(true);
		expect(json.result.content[0].text).toMatch(/takes no arguments/);
	});

	it('get_dad_forecast uses the forecast and fits its schema', async () => {
		const { json } = await modern('tools/call', { name: 'get_dad_forecast' });
		const s = json.result.structuredContent;
		expect(s.days).toHaveLength(2);
		expect(s.summary).toMatch(/Most likely day this week/);
		expect(json.result.content[0].text).toMatch(/12%/);
		expect(validate(s, schemaOf('get_dad_forecast'))).toEqual([]);
	});

	it('get_dad_forecast is sure of itself once Zack is a dad', async () => {
		const d = deps({ state: { status: 'yes', statusChangedAt: '2026-11-10T09:00:00.000Z', dueDate: '2026-11-20' }, forecast: () => [] });
		const { json } = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_dad_forecast' } }, { 'MCP-Protocol-Version': '2025-11-25' }, d);
		expect(json.result.structuredContent.summary).toMatch(/100% dad/);
	});

	it('returns -32602 for unknown tools', async () => {
		const { json } = await modern('tools/call', { name: 'make_zack_a_dad' });
		expect(json.error).toEqual({ code: -32602, message: 'Unknown tool: make_zack_a_dad' });
	});

	it('turns data-source failures into tool errors rather than exceptions', async () => {
		const d = deps({ listUpdates: async () => Promise.reject(new Error('D1 is napping')) });
		const { res, json } = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_recent_updates' } }, {}, d);
		expect(res.status).toBe(200);
		expect(json.result.isError).toBe(true);
	});

	it('omits structuredContent for 2025-03-26 clients but keeps the JSON text', async () => {
		const { json } = await legacy('tools/call', { name: 'is_zack_a_dad' });
		expect(json.result.structuredContent).toBeUndefined();
		expect(JSON.parse(json.result.content[1].text).status).toBe('no');
	});
});

describe('transport', () => {
	const req = (init: RequestInit) => handleMcpHttp(new Request(`${SITE}/mcp`, init), deps());

	it('returns 405 for GET and DELETE', async () => {
		for (const method of ['GET', 'DELETE']) {
			const res = await req({ method });
			expect(res.status).toBe(405);
			expect(res.headers.get('allow')).toBe('POST, OPTIONS');
		}
	});

	it('rejects malformed JSON with -32700', async () => {
		const { res, json } = await post('{"jsonrpc": "2.0",');
		expect(res.status).toBe(400);
		expect(json).toEqual({ jsonrpc: '2.0', id: null, error: { code: RPC.PARSE_ERROR, message: expect.any(String) } });
	});

	it('rejects non-JSON content types (415) and Accept headers without JSON (406)', async () => {
		expect((await req({ method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
		expect((await req({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/html' }, body: '{}' })).status).toBe(406);
	});

	it('rejects bodies over 64 KiB', async () => {
		const { res } = await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70_000) } });
		expect(res.status).toBe(413);
	});

	it('validates Origin', async () => {
		expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'null' })).res.status).toBe(403);
		expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://example.com' })).res.status).toBe(200);
		expect(isAcceptableOrigin('https://example.com')).toBe(true);
		expect(isAcceptableOrigin('http://localhost:3000')).toBe(true);
		expect(isAcceptableOrigin('null')).toBe(false);
		expect(isAcceptableOrigin('file://')).toBe(false);
		expect(isAcceptableOrigin('https://example.com/path')).toBe(false);
	});

	it('rejects invalid JSON-RPC envelopes', async () => {
		expect((await post({ id: 1, method: 'ping' })).json.error.code).toBe(RPC.INVALID_REQUEST);
		expect((await post({ jsonrpc: '2.0', id: null, method: 'ping' })).json.error.code).toBe(RPC.INVALID_REQUEST);
		expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: [1] })).json.error.code).toBe(RPC.INVALID_PARAMS);
		expect((await post(42)).res.status).toBe(400);
	});

	it('accepts stray client responses with 202', async () => {
		expect((await post({ jsonrpc: '2.0', id: 5, result: {} })).res.status).toBe(202);
	});

	it('supports JSON-RPC batches for 2025-03-26 only', async () => {
		const batch = [
			{ jsonrpc: '2.0', id: 1, method: 'ping' },
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
		];
		const ok = await post(batch);
		expect(ok.res.status).toBe(200);
		expect(ok.json.map((r: Json) => r.id)).toEqual([1, 2]);
		const notificationsOnly = await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
		expect(notificationsOnly.res.status).toBe(202);
		const rejected = await post(batch, { 'MCP-Protocol-Version': '2025-06-18' });
		expect(rejected.res.status).toBe(400);
		expect(rejected.json.error.code).toBe(RPC.INVALID_REQUEST);
		const withInit = await post([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }]);
		expect(withInit.json[0].error.code).toBe(RPC.INVALID_REQUEST);
		expect((await post([])).res.status).toBe(400);
	});

	it('ignores session headers and never mints one', async () => {
		const { res } = await legacy('tools/list', {}, '2025-06-18');
		expect(res.headers.get('mcp-session-id')).toBeNull();
		expect(res.headers.get('cache-control')).toBe('no-store');
	});
});

describe('decodeMcpHeaderValue', () => {
	it('passes plain values through and decodes the base64 sentinel', () => {
		expect(decodeMcpHeaderValue('is_zack_a_dad')).toBe('is_zack_a_dad');
		expect(decodeMcpHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
		expect(decodeMcpHeaderValue('=?base64?!!!?=')).toBeNull();
	});
});
