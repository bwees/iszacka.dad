// OWNER: feeds agent.
// A Model Context Protocol server, so that AI assistants can ask "is Zack a dad?" in the
// officially sanctioned way. Streamable HTTP, stateless, plain JSON responses (no SSE).
//
// Dual-era, per the 2026-07-28 spec's backward-compatibility rules:
//   * Modern (2026-07-28): no handshake. Every request carries its protocol version and
//     client capabilities in `params._meta`, mirrored into MCP-Protocol-Version /
//     Mcp-Method / Mcp-Name headers, which we validate. `server/discover` is supported.
//   * Legacy (2025-11-25, 2025-06-18, 2025-03-26): `initialize` negotiates a version,
//     `notifications/initialized` gets a 202, `ping` works, the MCP-Protocol-Version
//     header (absent means 2025-03-26) selects behaviour, and 2025-03-26 may batch.
// No sessions are minted; Mcp-Session-Id and Last-Event-ID are ignored.
//
// This module is pure: the route passes in the state and data accessors.

import type { SiteState, Status, Update } from '../types';
import { type PublicUpdate, publicUpdate } from './feeds-api';
import type { ForecastDay } from './forecast';
import type { BabySize } from './fruit';
import { SITE_NAME, STATUS_COPY } from './site';
import { daysBetween, formatLondon, formatLondonDate, formatNumber } from './time';

// ─── Versions & codes ────────────────────────────────────────────────────────

export const MCP_MODERN_VERSIONS = ['2026-07-28'] as const;
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [...MCP_MODERN_VERSIONS, ...MCP_LEGACY_VERSIONS];
/** What a legacy `initialize` gets when it asks for a version we don't speak. */
export const MCP_LATEST_LEGACY = '2025-11-25';
/** Legacy requests without an MCP-Protocol-Version header are treated as this (per spec). */
export const MCP_HEADERLESS_VERSION = '2025-03-26';

export const RPC = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	HEADER_MISMATCH: -32020,
	UNSUPPORTED_PROTOCOL_VERSION: -32022,
	/** Application-defined (outside the JSON-RPC reserved range): slow down. */
	RATE_LIMITED: -31429,
} as const;

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** Request bodies above this are refused. A JSON-RPC call to ask a yes/no question is small. */
export const MCP_MAX_BODY_BYTES = 64 * 1024;

/** Tool lists never change at runtime; clients may cache them for an hour. */
const LIST_TTL_MS = 3_600_000;

// ─── Types ───────────────────────────────────────────────────────────────────

type RequestId = string | number;
type JsonObject = Record<string, unknown>;

export interface RpcError {
	code: number;
	message: string;
	data?: unknown;
}

export type RpcResponse =
	| { jsonrpc: '2.0'; id: RequestId; result: JsonObject }
	| { jsonrpc: '2.0'; id?: RequestId | null; error: RpcError };

export interface McpDeps {
	state: SiteState;
	/** Today in Europe/London, 'YYYY-MM-DD'. */
	today: string;
	siteUrl: string;
	getChecks(): Promise<number>;
	listUpdates(opts: { limit: number; beforeId?: number }): Promise<Update[]>;
	forecast(dueDate: string | null, today: string, status: Status): ForecastDay[];
	babySize(dueDate: string | null, today: string): BabySize | null;
}

type Era = { kind: 'modern'; version: string } | { kind: 'legacy'; version: string };

interface Outcome {
	status: number;
	body: RpcResponse | null;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
	return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function isModernVersion(v: string): boolean {
	return (MCP_MODERN_VERSIONS as readonly string[]).includes(v);
}

function isLegacyVersion(v: string): boolean {
	return (MCP_LEGACY_VERSIONS as readonly string[]).includes(v);
}

/** Features that arrived in 2025-06-18: tool titles, output schemas, structured content. */
function hasStructuredOutput(era: Era): boolean {
	return era.kind === 'modern' || era.version >= '2025-06-18';
}

/** Implementation icons / description / websiteUrl arrived in 2025-11-25. */
function hasRichServerInfo(era: Era): boolean {
	return era.kind === 'modern' || era.version >= '2025-11-25';
}

function ok(id: RequestId, result: JsonObject): RpcResponse {
	return { jsonrpc: '2.0', id, result };
}

function fail(id: RequestId | null | undefined, code: number, message: string, data?: unknown): RpcResponse {
	const error: RpcError = data === undefined ? { code, message } : { code, message, data };
	return id === undefined ? { jsonrpc: '2.0', error } : { jsonrpc: '2.0', id, error };
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/** A JSON-RPC error body that isn't tied to a request (rate limits, transport errors). */
export function mcpTransportError(code: number, message: string, modern: boolean): RpcResponse {
	return fail(modern ? undefined : null, code, message);
}

/** Decode the `=?base64?…?=` header sentinel (Mcp-Name, Mcp-Param-*). Null if malformed. */
export function decodeMcpHeaderValue(value: string): string | null {
	const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
	if (!match) return value.startsWith('=?base64?') ? null : value;
	try {
		const bytes = Uint8Array.from(atob(match[1] ?? ''), (c) => c.charCodeAt(0));
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return null;
	}
}

/**
 * Origin validation (DNS-rebinding protection). This is a public, read-only,
 * unauthenticated server, so any well-formed web origin is welcome; opaque ("null")
 * and malformed origins are not.
 */
export function isAcceptableOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		return (url.protocol === 'https:' || url.protocol === 'http:') && url.pathname === '/' && !url.search && !url.hash && !url.username;
	} catch {
		return false;
	}
}

function acceptsJson(accept: string | null): boolean {
	if (!accept || !accept.trim()) return true;
	return accept.split(',').some((part) => {
		const type = (part.split(';')[0] ?? '').trim().toLowerCase();
		return type === 'application/json' || type === 'application/*' || type === '*/*';
	});
}

// ─── Server identity ─────────────────────────────────────────────────────────

export const MCP_SERVER_NAME = 'iszacka-dad';
export const MCP_SERVER_VERSION = '1.0.0';

const INSTRUCTIONS =
	'This server answers one question: is Zack a dad yet? Call is_zack_a_dad for the answer, ' +
	'get_due_date_info for the due date, get_recent_updates for the update stream and ' +
	'get_dad_forecast for a seven-day outlook. The site deliberately knows only the status ' +
	'(no, soon meaning labour has started, or yes), when it last changed, and the due date. ' +
	'Never invent names, weights, birth details or locations, and refer to Zack, Jess and the ' +
	'baby by name or as "the baby", without gendered pronouns.';

function serverInfo(era: Era, siteUrl: string): JsonObject {
	const info: JsonObject = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
	if (hasStructuredOutput(era)) info.title = SITE_NAME;
	if (hasRichServerInfo(era)) {
		info.description = 'Answers "Is Zack a dad?" with considerably more infrastructure than the question deserves.';
		info.websiteUrl = `${siteUrl}/`;
		info.icons = [{ src: `${siteUrl}/icons/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'] }];
	}
	return info;
}

const CAPABILITIES = { tools: { listChanged: false } };

/** Modern results carry resultType and identify the server in _meta. */
function finishResult(era: Era, result: JsonObject, siteUrl: string): JsonObject {
	if (era.kind !== 'modern') return result;
	const meta = isObject(result._meta) ? result._meta : {};
	return { resultType: 'complete', ...result, _meta: { ...meta, [META_SERVER_INFO]: serverInfo(era, siteUrl) } };
}

// ─── Tools ───────────────────────────────────────────────────────────────────

type JsonSchema = JsonObject;

type ToolResult = { ok: true; text: string; structured: JsonObject } | { ok: false; text: string };

interface IntegerArg {
	type: 'integer';
	minimum: number;
	maximum: number;
	default?: number;
	description: string;
}

interface ToolDef {
	name: string;
	title: string;
	description: string;
	args: Record<string, IntegerArg>;
	outputSchema: JsonSchema;
	run(args: Record<string, number | undefined>, deps: McpDeps): Promise<ToolResult>;
}

const STATUS_SCHEMA = { type: 'string', enum: ['no', 'soon', 'yes'], description: "'no', 'soon' (labour has started) or 'yes'." };
const NULLABLE_DATE = { type: ['string', 'null'], description: "'YYYY-MM-DD' (Europe/London) or null." };

function pct(probability: number): string {
	return `${Math.round(probability * 100)}%`;
}

function plural(n: number, word: string): string {
	return `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;
}

function dueSummary(state: SiteState, today: string): { summary: string; days: number | null } {
	if (state.status === 'yes') {
		return {
			summary: state.dueDate
				? `The baby has arrived, so the due date (${formatLondonDate(state.dueDate)}) is now trivia.`
				: 'The baby has arrived; the due date no longer matters.',
			days: state.dueDate ? daysBetween(today, state.dueDate) : null,
		};
	}
	if (!state.dueDate) return { summary: 'No due date has been announced.', days: null };
	const days = daysBetween(today, state.dueDate);
	const when = formatLondonDate(state.dueDate);
	const prefix = state.status === 'soon' ? 'Labour has started. ' : '';
	if (days > 0) return { summary: `${prefix}Due ${when}: ${plural(days, 'day')} to go.`, days };
	if (days === 0) return { summary: `${prefix}Due today (${when}).`, days };
	return { summary: `${prefix}Due ${when}: ${plural(-days, 'day')} overdue.`, days };
}

let toolDefs: readonly ToolDef[] | undefined;

/** The tools, built on first use (only /mcp needs them; module scope runs on every cold isolate). */
export const mcpTools = (): readonly ToolDef[] => (toolDefs ??= [
	{
		name: 'is_zack_a_dad',
		title: 'Is Zack a dad?',
		description:
			'Answers the only question that matters: is Zack a dad yet? Returns the status (no, soon meaning labour has started, or yes), the one-word answer, a full sentence, when the status last changed and how many times people have asked.',
		args: {},
		outputSchema: {
			type: 'object',
			properties: {
				isZackADad: { type: 'boolean' },
				status: STATUS_SCHEMA,
				answer: { type: 'string', description: 'NO, NOT YET or YES.' },
				sentence: { type: 'string' },
				statusChangedAt: { type: 'string', format: 'date-time' },
				checks: { type: 'integer', minimum: 0, description: 'Times anyone has asked.' },
			},
			required: ['isZackADad', 'status', 'answer', 'sentence', 'statusChangedAt', 'checks'],
			additionalProperties: false,
		},
		async run(_args, deps) {
			const { state } = deps;
			const copy = STATUS_COPY[state.status];
			const checks = await deps.getChecks().catch(() => 0);
			return {
				ok: true,
				text: `${copy.short} ${copy.sentence} (Status "${state.status}" since ${formatLondon(state.statusChangedAt)}, London time. Asked ${plural(checks, 'time')}.)`,
				structured: {
					isZackADad: state.status === 'yes',
					status: state.status,
					answer: copy.word,
					sentence: copy.sentence,
					statusChangedAt: state.statusChangedAt,
					checks,
				},
			};
		},
	},
	{
		name: 'get_due_date_info',
		title: 'Due date information',
		description:
			'The estimated due date, how many days remain (negative when overdue), and the traditional fruit-based size comparison. Due dates are estimates; babies have not read them.',
		args: {},
		outputSchema: {
			type: 'object',
			properties: {
				status: STATUS_SCHEMA,
				dueDate: NULLABLE_DATE,
				daysUntilDue: { type: ['integer', 'null'], description: 'Negative when overdue; null without a due date.' },
				overdue: { type: 'boolean' },
				babySize: {
					type: ['object', 'null'],
					properties: {
						week: { type: 'integer' },
						day: { type: 'integer' },
						fruit: { type: 'string' },
						emoji: { type: 'string' },
					},
					required: ['week', 'day', 'fruit', 'emoji'],
				},
				summary: { type: 'string' },
			},
			required: ['status', 'dueDate', 'daysUntilDue', 'overdue', 'babySize', 'summary'],
			additionalProperties: false,
		},
		async run(_args, deps) {
			const { state, today } = deps;
			const { summary, days } = dueSummary(state, today);
			const size = state.status === 'yes' ? null : deps.babySize(state.dueDate, today);
			const babySize = size ? { week: size.week, day: size.day, fruit: size.fruit, emoji: size.emoji } : null;
			const sizeText = babySize ? ` Size estimate: ${babySize.fruit} ${babySize.emoji} (week ${babySize.week}, day ${babySize.day}).` : '';
			return {
				ok: true,
				text: `${summary}${sizeText}`,
				structured: {
					status: state.status,
					dueDate: state.dueDate,
					daysUntilDue: days,
					overdue: state.status !== 'yes' && days !== null && days < 0,
					babySize,
					summary,
				},
			};
		},
	},
	{
		name: 'get_recent_updates',
		title: 'Recent updates',
		description:
			'The latest posts from the update stream, newest first: status changes, the daily "still no" bulletin and announcements. Paginate with `before` (an update id).',
		args: {
			limit: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: 'How many updates to return (1 to 20, default 5).' },
			before: {
				type: 'integer',
				minimum: 1,
				maximum: Number.MAX_SAFE_INTEGER,
				description: 'Only return updates with an id lower than this (for pagination).',
			},
		},
		outputSchema: {
			type: 'object',
			properties: {
				updates: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: { type: 'integer' },
							kind: { type: 'string', enum: ['status', 'daily', 'system'] },
							title: { type: 'string' },
							body: { type: 'string' },
							status: STATUS_SCHEMA,
							createdAt: { type: 'string', format: 'date-time' },
							url: { type: 'string', format: 'uri' },
						},
						required: ['id', 'kind', 'title', 'body', 'status', 'createdAt', 'url'],
					},
				},
				nextBefore: { type: ['integer', 'null'], description: 'Pass as `before` to get the next page; null at the end.' },
			},
			required: ['updates', 'nextBefore'],
			additionalProperties: false,
		},
		async run(args, deps) {
			const limit = args.limit ?? 5;
			const rows = await deps.listUpdates({ limit, ...(args.before ? { beforeId: args.before } : {}) });
			const updates: PublicUpdate[] = rows.map((u) => publicUpdate(u, deps.siteUrl));
			const last = updates.at(-1);
			const nextBefore = updates.length === limit && last ? last.id : null;
			const text = updates.length
				? updates
						.map((u) => {
							const body = u.body.trim() && u.body.trim() !== u.title ? `\n  ${u.body.trim().replace(/\s*\n\s*/g, ' ')}` : '';
							return `#${u.id} · ${formatLondon(u.createdAt)} · ${u.title}${body}\n  ${u.url}`;
						})
						.join('\n')
				: 'No updates yet. The silence is deafening.';
			return { ok: true, text, structured: { updates, nextBefore } };
		},
	},
	{
		name: 'get_dad_forecast',
		title: 'Seven-day dad forecast',
		description:
			'A weather-style seven-day forecast of the chance that Zack becomes a dad on each day, given it has not happened yet. Statistically motivated, emotionally unreliable.',
		args: {},
		outputSchema: {
			type: 'object',
			properties: {
				status: STATUS_SCHEMA,
				dueDate: NULLABLE_DATE,
				today: { type: 'string', description: "'YYYY-MM-DD' in Europe/London." },
				days: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							date: { type: 'string' },
							probability: { type: 'number', minimum: 0, maximum: 1 },
							label: { type: 'string' },
							emoji: { type: 'string' },
						},
						required: ['date', 'probability', 'label', 'emoji'],
					},
				},
				summary: { type: 'string' },
			},
			required: ['status', 'dueDate', 'today', 'days', 'summary'],
			additionalProperties: false,
		},
		async run(_args, deps) {
			const { state, today } = deps;
			const days = deps.forecast(state.dueDate, today, state.status).map((d) => ({
				date: d.date,
				probability: Number.isFinite(d.probability) ? Math.min(1, Math.max(0, d.probability)) : 0,
				label: d.label,
				emoji: d.emoji,
			}));
			let summary: string;
			if (state.status === 'yes') summary = 'Forecast: 100% dad, every day, indefinitely. The event has already happened.';
			else if (!days.length) summary = state.dueDate ? 'No forecast available right now.' : 'No forecast without a due date. Outlook: uncertain, with a chance of nappies.';
			else {
				const best = days.reduce((a, b) => (b.probability > a.probability ? b : a));
				summary = `Most likely day this week: ${formatLondonDate(best.date)} (${pct(best.probability)}).${state.status === 'soon' ? ' Labour has started, so the forecast is mostly a formality.' : ''}`;
			}
			const lines = days.map((d) => `${formatLondonDate(d.date)}: ${pct(d.probability)} · ${d.label} ${d.emoji}`.trim());
			return {
				ok: true,
				text: [summary, ...lines].join('\n'),
				structured: { status: state.status, dueDate: state.dueDate, today, days, summary },
			};
		},
	},
]);

function inputSchema(tool: ToolDef): JsonSchema {
	const properties: JsonObject = {};
	for (const [name, arg] of Object.entries(tool.args)) {
		properties[name] = { ...arg };
	}
	return { type: 'object', properties, additionalProperties: false };
}

function describeTool(tool: ToolDef, era: Era): JsonObject {
	const def: JsonObject = {
		name: tool.name,
		description: tool.description,
		inputSchema: inputSchema(tool),
		annotations: { title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	};
	if (hasStructuredOutput(era)) {
		def.title = tool.title;
		def.outputSchema = tool.outputSchema;
	}
	return def;
}

function validateToolArgs(tool: ToolDef, raw: JsonObject): { ok: true; values: Record<string, number | undefined> } | { ok: false; error: string } {
	const values: Record<string, number | undefined> = {};
	for (const key of Object.keys(raw)) {
		if (!Object.hasOwn(tool.args, key)) {
			const allowed = Object.keys(tool.args);
			return {
				ok: false,
				error: `Unexpected argument "${key}". ${allowed.length ? `This tool accepts: ${allowed.join(', ')}.` : 'This tool takes no arguments.'}`,
			};
		}
	}
	for (const [name, spec] of Object.entries(tool.args)) {
		const value = raw[name];
		if (value === undefined || value === null) {
			values[name] = spec.default;
			continue;
		}
		if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.minimum || value > spec.maximum) {
			return { ok: false, error: `"${name}" must be a whole number from ${spec.minimum} to ${spec.maximum}.` };
		}
		values[name] = value;
	}
	return { ok: true, values };
}

async function callTool(era: Era, params: JsonObject, deps: McpDeps): Promise<{ result: JsonObject } | { error: RpcError }> {
	const name = params.name;
	if (typeof name !== 'string' || !name) return { error: { code: RPC.INVALID_PARAMS, message: 'tools/call needs a tool "name".' } };
	const tool = mcpTools().find((t) => t.name === name);
	if (!tool) return { error: { code: RPC.INVALID_PARAMS, message: `Unknown tool: ${name}` } };
	const rawArgs = params.arguments ?? {};
	if (!isObject(rawArgs)) return { error: { code: RPC.INVALID_PARAMS, message: '"arguments" must be an object.' } };

	const toolError = (text: string) => ({ result: { content: [{ type: 'text', text }], isError: true } });
	const checked = validateToolArgs(tool, rawArgs);
	if (!checked.ok) return toolError(checked.error);

	let outcome: ToolResult;
	try {
		outcome = await tool.run(checked.values, deps);
	} catch (err) {
		console.error(`mcp tool ${tool.name} failed:`, err);
		outcome = { ok: false, text: 'Something went wrong fetching that. Even the server needs a nap sometimes; please try again shortly.' };
	}
	if (!outcome.ok) return toolError(outcome.text);

	const result: JsonObject = {
		content: [
			{ type: 'text', text: outcome.text },
			{ type: 'text', text: JSON.stringify(outcome.structured) },
		],
		isError: false,
	};
	if (hasStructuredOutput(era)) result.structuredContent = outcome.structured;
	return { result };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

interface HttpContext {
	headerVersion: string | null;
	method: string | null;
	name: string | null;
	inBatch: boolean;
}

function discoverResult(era: Era, deps: McpDeps): JsonObject {
	return {
		supportedVersions: [...MCP_SUPPORTED_VERSIONS],
		capabilities: CAPABILITIES,
		instructions: INSTRUCTIONS,
		ttlMs: LIST_TTL_MS,
		cacheScope: 'public',
		_meta: { [META_SERVER_INFO]: serverInfo(era, deps.siteUrl) },
	};
}

async function dispatch(era: Era, id: RequestId, method: string, params: JsonObject, deps: McpDeps): Promise<Outcome> {
	const modern = era.kind === 'modern';
	const done = (result: JsonObject): Outcome => ({ status: 200, body: ok(id, finishResult(era, result, deps.siteUrl)) });

	switch (method) {
		case 'ping':
			// Removed in 2026-07-28; still part of every legacy revision.
			if (!modern) return done({});
			break;
		case 'server/discover':
			if (modern) return done(discoverResult(era, deps));
			break;
		case 'tools/list': {
			if (params.cursor !== undefined) {
				return { status: modern ? 400 : 200, body: fail(id, RPC.INVALID_PARAMS, 'Invalid cursor: the tool list has a single page.') };
			}
			const result: JsonObject = { tools: mcpTools().map((t) => describeTool(t, era)) };
			if (modern) Object.assign(result, { ttlMs: LIST_TTL_MS, cacheScope: 'public' });
			return done(result);
		}
		case 'tools/call': {
			const outcome = await callTool(era, params, deps);
			if ('error' in outcome) return { status: 200, body: fail(id, outcome.error.code, outcome.error.message) };
			return done(outcome.result);
		}
		default:
			break;
	}
	return { status: modern ? 404 : 200, body: fail(id, RPC.METHOD_NOT_FOUND, `Method not found: ${method}`) };
}

function initialize(id: RequestId, params: JsonObject, deps: McpDeps): Outcome {
	const requested = params.protocolVersion;
	if (typeof requested !== 'string' || !requested) {
		return { status: 400, body: fail(id, RPC.INVALID_PARAMS, 'initialize needs a "protocolVersion".') };
	}
	const version = isLegacyVersion(requested) ? requested : MCP_LATEST_LEGACY;
	const era: Era = { kind: 'legacy', version };
	return {
		status: 200,
		body: ok(id, { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: serverInfo(era, deps.siteUrl), instructions: INSTRUCTIONS }),
	};
}

async function handleMessage(message: unknown, http: HttpContext, deps: McpDeps): Promise<Outcome> {
	const idOf = (m: unknown): RequestId | null => (isObject(m) && isRequestId(m.id) ? m.id : null);
	if (!isObject(message) || message.jsonrpc !== '2.0') {
		return { status: 400, body: fail(idOf(message), RPC.INVALID_REQUEST, 'Expected a JSON-RPC 2.0 message.') };
	}
	const hasId = Object.hasOwn(message, 'id');
	if (typeof message.method !== 'string') {
		// A response to a request we never sent: accept politely and ignore.
		if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) return { status: 202, body: null };
		return { status: 400, body: fail(idOf(message), RPC.INVALID_REQUEST, 'Expected a "method".') };
	}
	const method = message.method;
	// Notifications (notifications/initialized and friends) are accepted with no reply.
	if (!hasId) return { status: 202, body: null };
	if (!isRequestId(message.id)) return { status: 400, body: fail(null, RPC.INVALID_REQUEST, 'Request ids must be strings or numbers.') };
	const id = message.id;
	const params = message.params ?? {};
	if (!isObject(params)) return { status: 400, body: fail(id, RPC.INVALID_PARAMS, '"params" must be an object.') };

	if (method === 'initialize') {
		if (http.inBatch) return { status: 400, body: fail(id, RPC.INVALID_REQUEST, 'initialize must not be part of a batch.') };
		return initialize(id, params, deps);
	}

	const meta = isObject(params._meta) ? params._meta : undefined;
	const metaVersion = meta?.[META_VERSION];
	const modernHeader = http.headerVersion !== null && isModernVersion(http.headerVersion);

	if (metaVersion !== undefined || modernHeader) {
		// ── Modern (2026-07-28): per-request metadata, mirrored headers. ──
		if (typeof metaVersion !== 'string' || !metaVersion) {
			return { status: 400, body: fail(id, RPC.INVALID_PARAMS, `Missing required _meta["${META_VERSION}"].`) };
		}
		if (!isModernVersion(metaVersion)) {
			return {
				status: 400,
				body: fail(id, RPC.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: [...MCP_SUPPORTED_VERSIONS], requested: metaVersion }),
			};
		}
		if (http.headerVersion === null) return { status: 400, body: fail(id, RPC.HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing.') };
		if (http.headerVersion !== metaVersion) {
			return {
				status: 400,
				body: fail(id, RPC.HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version header value '${http.headerVersion}' does not match body value '${metaVersion}'.`),
			};
		}
		if (http.method === null) return { status: 400, body: fail(id, RPC.HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is missing.') };
		if (http.method !== method) {
			return { status: 400, body: fail(id, RPC.HEADER_MISMATCH, `Header mismatch: Mcp-Method header value '${http.method}' does not match body value '${method}'.`) };
		}
		if (method === 'tools/call' && typeof params.name === 'string') {
			if (http.name === null) return { status: 400, body: fail(id, RPC.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is missing.') };
			const decoded = decodeMcpHeaderValue(http.name);
			if (decoded === null) return { status: 400, body: fail(id, RPC.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is not valid base64.') };
			if (decoded !== params.name) {
				return { status: 400, body: fail(id, RPC.HEADER_MISMATCH, `Header mismatch: Mcp-Name header value '${decoded}' does not match body value '${params.name}'.`) };
			}
		}
		if (!isObject(meta?.[META_CAPABILITIES])) {
			return { status: 400, body: fail(id, RPC.INVALID_PARAMS, `Missing required _meta["${META_CAPABILITIES}"].`) };
		}
		return dispatch({ kind: 'modern', version: metaVersion }, id, method, params, deps);
	}

	// ── Legacy (2025-03-26 … 2025-11-25): the header names the negotiated version. ──
	const version = http.headerVersion ?? MCP_HEADERLESS_VERSION;
	if (!isLegacyVersion(version)) {
		return {
			status: 400,
			body: fail(id, RPC.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: [...MCP_SUPPORTED_VERSIONS], requested: version }),
		};
	}
	return dispatch({ kind: 'legacy', version }, id, method, params, deps);
}

// ─── HTTP entry point ────────────────────────────────────────────────────────

/**
 * Handle one HTTP request to /mcp. CORS and rate limiting are the route's job.
 * Never throws: every failure becomes a JSON-RPC error with a sensible HTTP status.
 */
export async function handleMcpHttp(request: Request, deps: McpDeps): Promise<Response> {
	const headerVersion = request.headers.get('mcp-protocol-version')?.trim() || null;
	const modern = headerVersion !== null && isModernVersion(headerVersion);
	const transportError = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
		jsonResponse(status, mcpTransportError(code, message, modern), headers);

	try {
		if (request.method !== 'POST') {
			return transportError(405, RPC.INVALID_REQUEST, 'This MCP server is stateless: POST JSON-RPC messages here. There is no SSE stream to GET and no session to DELETE.', {
				Allow: 'POST, OPTIONS',
			});
		}
		const origin = request.headers.get('origin');
		if (origin !== null && !isAcceptableOrigin(origin)) return transportError(403, RPC.INVALID_REQUEST, 'Forbidden: invalid Origin header.');

		const contentType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
		if (contentType !== 'application/json') return transportError(415, RPC.INVALID_REQUEST, 'Content-Type must be application/json.');
		if (!acceptsJson(request.headers.get('accept'))) return transportError(406, RPC.INVALID_REQUEST, 'Accept must include application/json.');

		const declared = Number(request.headers.get('content-length') ?? '0');
		if (declared > MCP_MAX_BODY_BYTES) return transportError(413, RPC.INVALID_REQUEST, 'Request body too large.');
		const text = await request.text();
		if (new TextEncoder().encode(text).length > MCP_MAX_BODY_BYTES) return transportError(413, RPC.INVALID_REQUEST, 'Request body too large.');

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return transportError(400, RPC.PARSE_ERROR, 'Parse error: the body is not valid JSON.');
		}

		const http: HttpContext = {
			headerVersion,
			method: request.headers.get('mcp-method')?.trim() || null,
			name: request.headers.get('mcp-name')?.trim() || null,
			inBatch: false,
		};

		if (Array.isArray(parsed)) {
			// JSON-RPC batches existed only in 2025-03-26.
			if (headerVersion !== null && headerVersion !== '2025-03-26') {
				return transportError(400, RPC.INVALID_REQUEST, `Batching is not supported in protocol version ${headerVersion}.`);
			}
			if (parsed.length === 0) return transportError(400, RPC.INVALID_REQUEST, 'Empty batch.');
			if (parsed.length > 20) return transportError(400, RPC.INVALID_REQUEST, 'Batches are limited to 20 messages.');
			const outcomes: Outcome[] = [];
			for (const message of parsed) outcomes.push(await handleMessage(message, { ...http, inBatch: true }, deps));
			const bodies = outcomes.map((o) => o.body).filter((b): b is RpcResponse => b !== null);
			return bodies.length ? jsonResponse(200, bodies) : new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
		}

		const outcome = await handleMessage(parsed, http, deps);
		if (outcome.body === null) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
		return jsonResponse(outcome.status, outcome.body);
	} catch (err) {
		console.error('mcp request failed:', err);
		return transportError(500, RPC.INTERNAL_ERROR, 'Internal error.');
	}
}
