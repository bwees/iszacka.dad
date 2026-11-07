// OWNER: feeds agent.
// /openapi.json: an OpenAPI 3.1 description of the public, machine-friendly endpoints.
// Kept next to the implementation and checked by tests, so it stays honest.

import { BADGE_LABEL_MAX, BADGE_STYLES } from './feeds-badge';
import { UPDATES_DEFAULT_LIMIT, UPDATES_MAX_LIMIT } from './feeds-api';
import { MCP_SUPPORTED_VERSIONS } from './feeds-mcp';
import { FORMATS } from './formats';
import { SITE_NAME } from './site';

type Doc = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Doc, example?: unknown) => ({ 'application/json': example === undefined ? { schema } : { schema, example } });
const text = (type: string, description?: string) => ({ [type]: { schema: { type: 'string', ...(description ? { description } : {}) } } });

const RATE_LIMITED = { $ref: '#/components/responses/RateLimited' };
const NOT_MODIFIED = { $ref: '#/components/responses/NotModified' };
const IF_NONE_MATCH = { $ref: '#/components/parameters/IfNoneMatch' };

function feed(summary: string, description: string, type: string, operationId: string): Doc {
	return {
		get: {
			tags: ['Feeds'],
			summary,
			description: `${description} Cached for 60 seconds; send If-None-Match with the ETag to get a 304.`,
			operationId,
			parameters: [IF_NONE_MATCH],
			responses: {
				'200': { description: 'The feed.', headers: { ETag: { $ref: '#/components/headers/ETag' } }, content: text(type) },
				'304': NOT_MODIFIED,
			},
		},
	};
}

export function buildOpenApi(siteUrl: string): Doc {
	return {
		openapi: '3.1.0',
		info: {
			title: `${SITE_NAME} API`,
			version: '1.0.0',
			summary: 'One question, answered with considerably more API than it needs.',
			description:
				'Public, read-only, unauthenticated. Every `/api/*` endpoint sends `Access-Control-Allow-Origin: *`, answers CORS preflights, and is rate-limited to 120 requests a minute per IP (exceed it and you get a `429` with a JSON body and `Retry-After`). Every response also carries an `X-Is-Zack-A-Dad` header, because why not.',
			contact: { name: SITE_NAME, url: `${siteUrl}/api` },
		},
		servers: [{ url: siteUrl }],
		externalDocs: { description: 'Human-readable documentation', url: `${siteUrl}/api` },
		tags: [
			{ name: 'Status', description: 'The answer, in various levels of verbosity.' },
			{ name: 'Updates', description: 'History and the update stream.' },
			{ name: 'Feeds', description: 'Syndication formats for people who still use feed readers (correctly).' },
			{ name: 'Widgets', description: 'Badges and embeds.' },
			{ name: 'Machines', description: 'MCP, OpenAPI and the various .txt files robots like.' },
			{ name: 'Terminal', description: 'For people who live in a terminal: a live dashboard, a .plan file, and the long view.' },
		],
		paths: {
			'/api/status': {
				get: {
					tags: ['Status'],
					summary: 'The answer, as JSON (or whatever your Accept header asks for)',
					description:
						'JSON by default. Send an `Accept` header for another format (q-values honoured): `application/xml`, `application/yaml`, `application/toml`, `text/csv`, `text/markdown`, `application/sql`, `text/plain` or `text/html`. Browsers (whose Accept lists `application/xhtml+xml`), wildcards and unrecognised types get JSON. Responses carry `Vary: Accept`.',
					operationId: 'getStatus',
					responses: {
						'200': {
							description: 'The current answer.',
							headers: { 'Cache-Control': { $ref: '#/components/headers/NoStore' } },
							content: {
								...json(ref('Status')),
								...Object.fromEntries(
									FORMATS.filter((f) => f.ext !== 'json' && f.accepts[0]).map((f) => [f.accepts[0] as string, { schema: { type: 'string' } }]),
								),
							},
						},
						'429': RATE_LIMITED,
					},
				},
			},
			'/api/status.{format}': {
				get: {
					tags: ['Status'],
					summary: 'The answer, in a format of your choosing',
					description: `One URL per format: ${FORMATS.filter((f) => f.ext !== 'json' && f.ext !== 'txt')
						.map((f) => `\`${f.ext}\``)
						.join(', ')}. \`/api/formats\` lists them all with their content types. The encodings (Morse, Braille, binary, hex, NATO, Base64, ROT13) encode the one-line answer.`,
					operationId: 'getStatusFormat',
					parameters: [
						{
							name: 'format',
							in: 'path',
							required: true,
							schema: { type: 'string', enum: FORMATS.filter((f) => f.ext !== 'json' && f.ext !== 'txt').map((f) => f.ext) },
						},
					],
					responses: {
						'200': { description: 'The answer, in that format.', content: { 'text/plain': { schema: { type: 'string' }, example: '-. ---\n' } } },
						'429': RATE_LIMITED,
					},
				},
			},
			'/api/formats': {
				get: {
					tags: ['Status'],
					summary: 'Every format the answer comes in',
					operationId: 'listFormats',
					responses: { '200': { description: 'The catalogue.', content: json(ref('Formats')) }, '429': RATE_LIMITED },
				},
			},
			'/live': {
				get: {
					tags: ['Terminal'],
					summary: 'A live dashboard for your terminal',
					description:
						'`curl -N` gets a never-ending `text/plain` stream of whole-screen ANSI frames, redrawn whenever anything changes (and every 5 seconds for the clocks), for up to 15 minutes. A WebSocket upgrade (`websocat wss://iszacka.dad/live`) gets the same frames as text messages. Browsers get a page explaining all this. 50 terminals at once; beyond that, 503 with `Retry-After`.',
					operationId: 'getLive',
					responses: {
						'101': { description: 'Switching to a WebSocket of ANSI frames.' },
						'200': { description: 'The stream (or, for browsers, a how-to page).', content: { ...text('text/plain'), ...text('text/html') } },
						'429': { description: 'Too many terminals from one network, or too many reconnects.', content: text('text/plain') },
						'503': { description: 'Every terminal seat is taken.', headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } }, content: text('text/plain') },
					},
				},
			},
			'/.plan': {
				get: {
					tags: ['Terminal'],
					summary: "Zack's Unix .plan file",
					description: 'Plan, progress bar (from the due date) and ETA. Once Zack is a dad, the plan is complete and a new one begins: sleep.',
					operationId: 'getPlan',
					responses: { '200': { description: 'The plan.', content: text('text/plain') } },
				},
			},
			'/is-zack-a-grandad': {
				get: {
					tags: ['Terminal'],
					summary: 'Is Zack a grandad?',
					description: 'Not yet. An estimate one generation (30 years) after the YES moment, or the due date until then, give or take 15 years. HTML for browsers, ASCII for curl.',
					operationId: 'getGrandad',
					responses: { '200': { description: 'The estimate.', content: { ...text('text/html'), ...text('text/plain') } } },
				},
			},
			'/api/status.json': {
				get: {
					tags: ['Status'],
					summary: 'The answer, as JSON (with a file extension, for the traditionalists)',
					description: 'Identical to `/api/status`.',
					operationId: 'getStatusJson',
					responses: { '200': { description: 'The current answer.', content: json(ref('Status')) }, '429': RATE_LIMITED },
				},
			},
			'/api/status.txt': {
				get: {
					tags: ['Status'],
					summary: 'The answer, as one line of plain text',
					description: 'Exactly one of `no`, `not yet` or `yes`, followed by a newline.',
					operationId: 'getStatusText',
					responses: {
						'200': { description: 'The answer.', content: { 'text/plain': { schema: { type: 'string', enum: ['no\n', 'not yet\n', 'yes\n'] }, example: 'no\n' } } },
						'429': RATE_LIMITED,
					},
				},
			},
			'/api/history': {
				get: {
					tags: ['Updates'],
					summary: 'Every status the site has ever had, oldest first',
					operationId: 'getHistory',
					responses: { '200': { description: 'Status history.', content: json(ref('History')) }, '429': RATE_LIMITED },
				},
			},
			'/api/updates': {
				get: {
					tags: ['Updates'],
					summary: 'The update stream, newest first',
					operationId: 'listUpdates',
					parameters: [
						{
							name: 'limit',
							in: 'query',
							description: 'How many updates to return.',
							schema: { type: 'integer', minimum: 1, maximum: UPDATES_MAX_LIMIT, default: UPDATES_DEFAULT_LIMIT },
						},
						{ name: 'before', in: 'query', description: 'Only updates with an id lower than this (pagination cursor).', schema: { type: 'integer', minimum: 1 } },
					],
					responses: {
						'200': { description: 'A page of updates.', content: json(ref('UpdatePage')) },
						'400': { description: 'Invalid query parameters.', content: json(ref('Error')) },
						'429': RATE_LIMITED,
					},
				},
			},
			'/api/dad': {
				get: {
					tags: ['Status'],
					summary: 'Request one dad',
					description:
						'Returns `425 Too Early` (RFC 8470) until Zack is a dad, with a `Retry-After` computed from the due date when one is known (hourly once overdue, every minute during labour). Once Zack is a dad: `201 Created` with `Location: /`. POST works identically, for the semantically minded.',
					operationId: 'getDad',
					responses: {
						'201': {
							description: 'Zack is a dad.',
							headers: { Location: { description: 'Always `/`.', schema: { type: 'string', const: '/' } } },
							content: json(ref('DadCreated')),
						},
						'425': {
							description: 'Too early. Zack is not a dad yet.',
							headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } },
							content: json(ref('DadTooEarly')),
						},
						'429': RATE_LIMITED,
					},
				},
				post: {
					tags: ['Status'],
					summary: 'Request one dad (POST)',
					description: 'Same as GET. No request body is needed or read.',
					operationId: 'postDad',
					responses: {
						'201': { description: 'Zack is a dad.', content: json(ref('DadCreated')) },
						'425': { description: 'Too early.', headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } }, content: json(ref('DadTooEarly')) },
						'429': RATE_LIMITED,
					},
				},
			},
			'/api/stream': {
				get: {
					tags: ['Status'],
					summary: 'Live updates as Server-Sent Events',
					description:
						'A long-lived `text/event-stream`. Each event carries a JSON live message: `hello` on connect, then `state`, `update`, `viewers`, `vibes`, `checks` and `reload` as they happen. Try `curl -N`.',
					operationId: 'streamLive',
					responses: { '200': { description: 'An endless stream of suspense.', content: text('text/event-stream') } },
				},
			},
			'/feed.xml': feed('RSS 2.0 feed', 'The latest 50 updates.', 'application/rss+xml', 'getRss'),
			'/rss.xml': feed('RSS 2.0 feed (alias)', 'The same RSS feed as `/feed.xml`.', 'application/rss+xml', 'getRssAlias'),
			'/atom.xml': feed('Atom 1.0 feed', 'The latest 50 updates.', 'application/atom+xml', 'getAtom'),
			'/feed.json': feed('JSON Feed 1.1', 'The latest 50 updates.', 'application/feed+json', 'getJsonFeed'),
			'/calendar.ics': feed(
				'iCalendar subscription',
				'The due date as an all-day event, plus "It\'s happening" and "Zack became a dad" events at the moment they happen. Asks calendar apps to refresh hourly.',
				'text/calendar',
				'getCalendar',
			),
			'/badge.svg': {
				get: {
					tags: ['Widgets'],
					summary: 'A shields.io-style status badge',
					operationId: 'getBadge',
					parameters: [
						{ name: 'style', in: 'query', schema: { type: 'string', enum: [...BADGE_STYLES], default: 'flat' } },
						{
							name: 'label',
							in: 'query',
							description: `Left-hand text (default "is zack a dad?"). Trimmed to ${BADGE_LABEL_MAX} characters; empty hides it.`,
							schema: { type: 'string', maxLength: BADGE_LABEL_MAX },
						},
						IF_NONE_MATCH,
					],
					responses: { '200': { description: 'The badge.', content: text('image/svg+xml') }, '304': NOT_MODIFIED },
				},
			},
			'/embed': {
				get: {
					tags: ['Widgets'],
					summary: 'A tiny widget page for iframes',
					description: 'Frameable from anywhere (`frame-ancestors *`). Refreshes itself every 60 seconds.',
					operationId: 'getEmbed',
					parameters: [{ name: 'theme', in: 'query', schema: { type: 'string', enum: ['auto', 'light', 'dark'], default: 'auto' } }],
					responses: { '200': { description: 'HTML.', content: text('text/html') } },
				},
			},
			'/embed.js': {
				get: {
					tags: ['Widgets'],
					summary: 'Script-tag embed',
					description:
						'Renders a widget in a shadow DOM next to the script tag, polling `/api/status` every 60 seconds. Configure with `data-theme` (auto, light, dark), `data-size` (small, medium, large), `data-target` (CSS selector to render into) and `data-link` ("false" to drop the link).',
					operationId: 'getEmbedScript',
					responses: { '200': { description: 'JavaScript.', content: text('text/javascript') } },
				},
			},
			'/mcp': {
				post: {
					tags: ['Machines'],
					summary: 'Model Context Protocol (Streamable HTTP)',
					description: `Stateless MCP server with JSON responses. Supported protocol versions: ${MCP_SUPPORTED_VERSIONS.join(', ')}. Modern (2026-07-28) clients send per-request \`_meta\` plus \`MCP-Protocol-Version\`, \`Mcp-Method\` and \`Mcp-Name\` headers; legacy clients call \`initialize\` first. Tools: \`is_zack_a_dad\`, \`get_due_date_info\`, \`get_recent_updates\`, \`get_dad_forecast\`.`,
					operationId: 'mcp',
					parameters: [
						{ name: 'MCP-Protocol-Version', in: 'header', schema: { type: 'string', enum: [...MCP_SUPPORTED_VERSIONS] } },
						{ name: 'Mcp-Method', in: 'header', description: 'Required for 2026-07-28 requests; must equal the body `method`.', schema: { type: 'string' } },
						{ name: 'Mcp-Name', in: 'header', description: 'Required for 2026-07-28 `tools/call`; must equal `params.name`.', schema: { type: 'string' } },
					],
					requestBody: {
						required: true,
						content: json(ref('JsonRpcMessage'), {
							jsonrpc: '2.0',
							id: 1,
							method: 'tools/call',
							params: {
								name: 'is_zack_a_dad',
								arguments: {},
								_meta: {
									'io.modelcontextprotocol/protocolVersion': '2026-07-28',
									'io.modelcontextprotocol/clientCapabilities': {},
								},
							},
						}),
					},
					responses: {
						'200': { description: 'A JSON-RPC response (or, for 2025-03-26 batches, an array of them).', content: json(ref('JsonRpcResponse')) },
						'202': { description: 'Notification accepted. No body.' },
						'400': { description: 'Malformed request, header mismatch or unsupported protocol version.', content: json(ref('JsonRpcResponse')) },
						'403': { description: 'Invalid Origin header.', content: json(ref('JsonRpcResponse')) },
						'404': { description: 'Unknown method (2026-07-28 requests).', content: json(ref('JsonRpcResponse')) },
						'406': { description: 'Accept excludes application/json.', content: json(ref('JsonRpcResponse')) },
						'413': { description: 'Body over 64 KiB.', content: json(ref('JsonRpcResponse')) },
						'415': { description: 'Content-Type is not application/json.', content: json(ref('JsonRpcResponse')) },
						'429': { description: 'Rate limited.', headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } }, content: json(ref('JsonRpcResponse')) },
					},
				},
				get: {
					tags: ['Machines'],
					summary: 'Not supported',
					description: 'Stateless server: there is no SSE stream to GET.',
					operationId: 'mcpGet',
					responses: { '405': { description: 'Method Not Allowed.', content: json(ref('JsonRpcResponse')) } },
				},
			},
			'/openapi.json': {
				get: {
					tags: ['Machines'],
					summary: 'This document',
					operationId: 'getOpenApi',
					responses: { '200': { description: 'OpenAPI 3.1.', content: json({ type: 'object' }) } },
				},
			},
			'/llms.txt': {
				get: { tags: ['Machines'], summary: 'llms.txt', operationId: 'getLlmsTxt', responses: { '200': { description: 'Markdown, per llmstxt.org.', content: text('text/plain') } } },
			},
			'/humans.txt': {
				get: { tags: ['Machines'], summary: 'humans.txt', operationId: 'getHumansTxt', responses: { '200': { description: 'Credits.', content: text('text/plain') } } },
			},
			'/robots.txt': {
				get: { tags: ['Machines'], summary: 'robots.txt', operationId: 'getRobotsTxt', responses: { '200': { description: 'Crawler rules.', content: text('text/plain') } } },
			},
			'/sitemap.xml': {
				get: { tags: ['Machines'], summary: 'XML sitemap', operationId: 'getSitemap', responses: { '200': { description: 'Every public page.', content: text('application/xml') } } },
			},
			'/.well-known/security.txt': {
				get: {
					tags: ['Machines'],
					summary: 'security.txt (RFC 9116)',
					operationId: 'getSecurityTxt',
					responses: { '200': { description: 'How to report vulnerabilities (in the website).', content: text('text/plain') } },
				},
			},
		},
		components: {
			schemas: {
				StatusValue: { type: 'string', enum: ['no', 'soon', 'yes'], description: '`soon` means labour has started.' },
				Status: {
					type: 'object',
					required: ['isZackADad', 'status', 'answer', 'sentence', 'statusChangedAt', 'dueDate', 'daysUntilDue', 'checks', 'links'],
					properties: {
						isZackADad: { type: 'boolean' },
						status: ref('StatusValue'),
						answer: { type: 'string', enum: ['NO', 'NOT YET', 'YES'] },
						sentence: { type: 'string' },
						statusChangedAt: { type: 'string', format: 'date-time' },
						dueDate: { type: ['string', 'null'], format: 'date' },
						daysUntilDue: { type: ['integer', 'null'], description: 'Negative when overdue. Null without a due date.' },
						checks: { type: 'integer', minimum: 0, description: 'How many times anyone has asked.' },
						links: { type: 'object', additionalProperties: { type: 'string', format: 'uri' } },
					},
					example: {
						isZackADad: false,
						status: 'no',
						answer: 'NO',
						sentence: 'Zack is not a dad. Yet.',
						statusChangedAt: '2026-11-06T09:00:00.000Z',
						dueDate: '2026-11-20',
						daysUntilDue: 14,
						checks: 4096,
						links: { self: `${siteUrl}/api/status`, html: `${siteUrl}/` },
					},
				},
				Formats: {
					type: 'object',
					required: ['formats', 'negotiation'],
					properties: {
						formats: {
							type: 'array',
							items: {
								type: 'object',
								required: ['ext', 'name', 'contentType', 'url', 'accept', 'description'],
								properties: {
									ext: { type: 'string' },
									name: { type: 'string' },
									contentType: { type: 'string' },
									url: { type: 'string', format: 'uri' },
									accept: { type: ['string', 'null'], description: 'The Accept type that selects it on /api/status, if any.' },
									description: { type: 'string' },
								},
							},
						},
						negotiation: { type: 'string' },
					},
				},
				History: {
					type: 'object',
					required: ['current', 'history'],
					properties: {
						current: ref('StatusValue'),
						history: {
							type: 'array',
							items: { type: 'object', required: ['status', 'at'], properties: { status: ref('StatusValue'), at: { type: 'string', format: 'date-time' } } },
						},
					},
				},
				Update: {
					type: 'object',
					required: ['id', 'kind', 'title', 'body', 'status', 'createdAt', 'url'],
					properties: {
						id: { type: 'integer' },
						kind: { type: 'string', enum: ['status', 'daily', 'system'] },
						title: { type: 'string' },
						body: { type: 'string', description: 'Plain text; may contain newlines.' },
						status: ref('StatusValue'),
						createdAt: { type: 'string', format: 'date-time' },
						url: { type: 'string', format: 'uri' },
					},
				},
				UpdatePage: {
					type: 'object',
					required: ['updates', 'nextBefore', 'next'],
					properties: {
						updates: { type: 'array', items: ref('Update') },
						nextBefore: { type: ['integer', 'null'], description: 'Pass as `before` for the next page. Null on the last page.' },
						next: { type: ['string', 'null'], format: 'uri' },
					},
				},
				DadTooEarly: {
					type: 'object',
					required: ['error', 'status', 'isZackADad', 'message', 'dueDate', 'retryAfterSeconds', 'retryAt'],
					properties: {
						error: { const: 'too_early' },
						status: { type: 'string', enum: ['no', 'soon'] },
						isZackADad: { const: false },
						message: { type: 'string' },
						dueDate: { type: ['string', 'null'], format: 'date' },
						retryAfterSeconds: { type: ['integer', 'null'] },
						retryAt: { type: ['string', 'null'], format: 'date-time' },
					},
				},
				DadCreated: {
					type: 'object',
					required: ['status', 'isZackADad', 'message', 'createdAt', 'location'],
					properties: {
						status: { const: 'yes' },
						isZackADad: { const: true },
						message: { type: 'string' },
						createdAt: { type: 'string', format: 'date-time' },
						location: { const: '/' },
					},
				},
				Error: {
					type: 'object',
					required: ['error', 'message'],
					properties: { error: { type: 'string' }, message: { type: 'string' } },
				},
				JsonRpcMessage: {
					type: 'object',
					required: ['jsonrpc', 'method'],
					properties: {
						jsonrpc: { const: '2.0' },
						id: { type: ['string', 'integer'] },
						method: { type: 'string' },
						params: { type: 'object' },
					},
				},
				JsonRpcResponse: {
					type: 'object',
					required: ['jsonrpc'],
					properties: {
						jsonrpc: { const: '2.0' },
						id: { type: ['string', 'integer', 'null'] },
						result: { type: 'object' },
						error: {
							type: 'object',
							required: ['code', 'message'],
							properties: { code: { type: 'integer' }, message: { type: 'string' }, data: {} },
						},
					},
				},
			},
			parameters: {
				IfNoneMatch: { name: 'If-None-Match', in: 'header', description: 'An ETag from a previous response.', schema: { type: 'string' } },
			},
			headers: {
				ETag: { description: 'Entity tag for conditional requests.', schema: { type: 'string' } },
				RetryAfter: { description: 'Seconds to wait before asking again.', schema: { type: 'integer', minimum: 0 } },
				NoStore: { description: 'Always `no-store`: the answer could change at any moment.', schema: { type: 'string' } },
			},
			responses: {
				NotModified: { description: 'Not modified since the ETag you sent.' },
				RateLimited: {
					description: 'Too many requests (over 120 a minute from one IP).',
					headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } },
					content: json(ref('Error')),
				},
			},
		},
	};
}
