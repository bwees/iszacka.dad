// OWNER: community agent.
// /ready, /wall, /names (+ voting) and their moderation pages /admin/checklist, /admin/wall, /admin/names.
//
// Every public write: RL_FORMS → Turnstile → honeypot → validation (trimmed, length-limited)
// → per-visitor queue cap → D1. Every form works without JS (POST renders the page again
// with a notice); `Accept: application/json` gets JSON instead. Admin pages sit behind
// requireAdmin (session + same-origin check) and redirect back with a fixed flash key.

import type { Context } from 'hono';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderAdminPage, requireAdmin } from '../lib/admin';
import {
	CHECKLIST_LABEL_MAX,
	NAME_HTML_PATTERN,
	NAME_MAX,
	NAMES_LIST_LIMIT,
	SUGGESTED_BY_MAX,
	SUGGESTED_CHECKLIST,
	WALL_MESSAGE_MAX,
	WALL_NAME_MAX,
	addChecklistItem,
	cleanLine,
	cleanMultiline,
	competitionRanks,
	dadcon,
	deleteChecklistItem,
	isModerationAction,
	listApprovedNames,
	listApprovedWall,
	listChecklist,
	listPendingNames,
	listPendingWall,
	looksLikeLink,
	missingSuggestions,
	moderateName,
	moderateWall,
	moveChecklistItem,
	nameCounts,
	normaliseSuggestedName,
	parseId,
	plural,
	readinessCommentary,
	seedChecklist,
	setChecklistDone,
	submitNameSuggestion,
	submitWallMessage,
	summariseReadiness,
	validateChecklistLabel,
	validateNameSuggestion,
	validateWallEntry,
	voteForName,
	votedSuggestionIds,
	wallCounts,
	type ChecklistItem,
	type FieldErrors,
	type ModerationAction,
	type ModerationCounts,
	type NameSuggestion,
	type Readiness,
	type WallMessage,
} from '../lib/community';
import type { Html } from '../lib/layout';
import { renderPage } from '../lib/layout';
import {
	allow,
	clientIp,
	clientKey,
	hashIdentifier,
	turnstileEnabled,
	turnstileWidget,
	verifyTurnstile,
	wantsJson,
} from '../lib/security';
import { DAD, PARENTS, STATUS_COPY } from '../lib/site';
import { daysBetween, formatLondon, formatLondonDate, formatNumber, londonDate } from '../lib/time';
import type { AppEnv, SiteState, Status } from '../types';

type Ctx = Context<AppEnv>;

export const communityRoutes = new Hono<AppEnv>();

for (const path of ['/admin/checklist/*', '/admin/wall/*', '/admin/names/*']) {
	communityRoutes.use(path, requireAdmin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────────

interface Notice {
	kind: 'ok' | 'error';
	text: string;
	/** Links to the fields that need attention (error summary). */
	links?: Array<{ href: string; text: string }>;
}

interface FormState<F extends string> {
	values: Record<F, string>;
	errors: FieldErrors<F>;
}

function noticeHtml(notice: Notice | undefined): Html | string {
	if (!notice) return '';
	const role = notice.kind === 'error' ? 'alert' : 'status';
	return html`<div class="notice notice-${notice.kind}" role="${role}">
		<p>${notice.text}</p>
		${notice.links?.length ? html`<ul>${notice.links.map((l) => html`<li><a href="${l.href}">${l.text}</a></li>`)}</ul>` : ''}
	</div>`;
}

/** Error summary notice pointing at each invalid field (ids are `${prefix}-${field}`). */
function errorSummary<F extends string>(prefix: string, errors: FieldErrors<F>): Notice {
	const links = (Object.entries(errors) as Array<[F, string | undefined]>)
		.filter((entry): entry is [F, string] => typeof entry[1] === 'string')
		.map(([field, text]) => ({ href: `#${prefix}-${field}`, text }));
	return { kind: 'error', text: 'Nearly. Please fix the following:', links };
}

interface FieldOptions {
	id: string;
	name: string;
	label: string;
	value: string;
	maxLength: number;
	hint?: string;
	error?: string;
	required?: boolean;
	multiline?: boolean;
	rows?: number;
	autocomplete?: string;
	pattern?: string;
}

function field(o: FieldOptions): Html {
	const describedBy = [o.hint ? `${o.id}-hint` : '', o.error ? `${o.id}-error` : ''].filter(Boolean).join(' ');
	const attrs = html`id="${o.id}" name="${o.name}" maxlength="${o.maxLength}"${o.required ? html` required` : ''}${
		describedBy ? html` aria-describedby="${describedBy}"` : ''
	}${o.error ? html` aria-invalid="true"` : ''}${o.autocomplete ? html` autocomplete="${o.autocomplete}"` : ''}`;
	const control = o.multiline
		? html`<textarea ${attrs} rows="${o.rows ?? 5}">${o.value}</textarea>`
		: html`<input type="text" ${attrs} value="${o.value}"${o.pattern ? html` pattern="${o.pattern}"` : ''}>`;
	return html`<div class="field">
		<label for="${o.id}">${o.label}${o.required ? '' : html` <span class="muted">(optional)</span>`}</label>
		${control}
		${o.hint ? html`<p class="hint" id="${o.id}-hint">${o.hint}</p>` : ''}
		${o.error ? html`<p class="notice notice-error tiny" id="${o.id}-error">${o.error}</p>` : ''}
	</div>`;
}

/** Off-screen field that only bots fill in. Filled → we smile, say thanks, and store nothing. */
function honeypot(prefix: string): Html {
	return html`<div aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden">
		<label for="${prefix}-website">Leave this empty</label>
		<input type="text" id="${prefix}-website" name="website" tabindex="-1" autocomplete="off" value="">
	</div>`;
}

function meter(percent: number, label: string): Html {
	return html`<div class="meter" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${percent}%"><span style="width:${percent}%"></span></div>`;
}

function timeTag(iso: string, opts: Intl.DateTimeFormatOptions = {}): Html {
	return html`<time datetime="${iso}">${formatLondon(iso, opts)}</time>`;
}

const DATE_ONLY: Intl.DateTimeFormatOptions = { weekday: undefined, hour: undefined, minute: undefined };

const MAX_BODY_BYTES = 32 * 1024;

/** Form or JSON body as string fields. null if the body is too large to bother with. */
async function readForm(c: Ctx): Promise<Record<string, string> | null> {
	const length = Number(c.req.header('content-length') ?? '0');
	if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
	try {
		const type = c.req.header('content-type') ?? '';
		const data: unknown = type.includes('application/json') ? await c.req.json() : await c.req.parseBody();
		const out: Record<string, string> = {};
		if (data && typeof data === 'object' && !Array.isArray(data)) {
			for (const [key, value] of Object.entries(data)) if (typeof value === 'string') out[key] = value;
		}
		return out;
	} catch {
		return {};
	}
}

interface GuardFailure {
	status: 413 | 429 | 403;
	error: string;
	text: string;
}

/** Size limit, rate limit and Turnstile, in that order. */
async function guardPublicWrite(c: Ctx, feature: string, body: Record<string, string> | null): Promise<GuardFailure | null> {
	if (body === null) {
		return { status: 413, error: 'too-large', text: 'That was rather a lot of form. Please send something shorter.' };
	}
	const ip = clientIp(c);
	if (!(await allow(c.env.RL_FORMS, `${feature}:${clientKey(c)}`))) {
		return {
			status: 429,
			error: 'rate-limited',
			text: 'Steady on. Too many submissions in a short time; please wait a minute and try again.',
		};
	}
	if (!(await verifyTurnstile(c.env, body['cf-turnstile-response'], ip))) {
		return {
			status: 403,
			error: 'turnstile',
			text: "We couldn't confirm you're a human (no offence). Please complete the check and try again.",
		};
	}
	return null;
}

const isBot = (body: Record<string, string>) => (body.website ?? '').trim() !== '';

function relativeDays(days: number): string {
	if (days === 0) return 'today';
	if (days === 1) return 'tomorrow';
	if (days === -1) return 'yesterday';
	return days > 0 ? `in ${plural(days, 'day')}` : `${plural(-days, 'day')} ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// /ready: the Dad Readiness Index
// ─────────────────────────────────────────────────────────────────────────────

communityRoutes.get('/ready', async (c) => {
	const items = await listChecklist(c.env);
	const readiness = summariseReadiness(items);
	const status = c.get('state').status;
	const commentary = readinessCommentary(readiness, status);
	const level = dadcon(readiness.percent);
	if (wantsJson(c)) return c.json({ ...readiness, commentary, dadcon: level });

	return renderPage(c, {
		title: 'Dad readiness',
		description:
			readiness.total === 0
				? `How ready is ${DAD} to be a dad? The checklist is still being written.`
				: `${DAD} is ${readiness.percent}% ready to be a dad, according to a ${readiness.total}-item checklist.`,
		body: readyBody(items, readiness, commentary, level, status),
	});
});

function readyBody(
	items: ChecklistItem[],
	readiness: Readiness,
	commentary: string,
	level: ReturnType<typeof dadcon>,
	status: Status,
): Html {
	const heading = status === 'yes' ? `Was ${DAD} ready?` : `Is ${DAD} ready?`;
	return html`<div class="wrap section stack">
		<header class="page-head">
			<p class="kicker">The Dad Readiness Index</p>
			<h1>${heading}</h1>
			<p class="lede">An objective, scientific<a href="#ready-footnote" aria-label="(see footnote)">*</a> measure of how prepared ${DAD} is for fatherhood.</p>
		</header>
		${
			readiness.total === 0
				? html`<div class="empty stack">
						<p>${commentary}</p>
						<p class="muted">Readiness will be measured as soon as there is something to measure.</p>
					</div>`
				: html`<section class="card stack" aria-labelledby="ready-score-title">
							<h2 class="card-title" id="ready-score-title">Overall readiness</h2>
							<p class="big-number">${readiness.percent}%</p>
							${meter(readiness.percent, 'Dad readiness')}
							<p>${commentary}</p>
							<div class="stats">
								<div class="stat"><span class="stat-value">${readiness.done}</span><span class="stat-label">done</span></div>
								<div class="stat">
									<span class="stat-value">${readiness.total - readiness.done}</span><span class="stat-label">to go</span>
								</div>
								<div class="stat">
									<span class="stat-value">DADCON ${level.level}</span><span class="stat-label">${level.label}</span>
								</div>
							</div>
						</section>
						<section class="stack" aria-labelledby="ready-list-title">
							<h2 id="ready-list-title">The checklist</h2>
							<ul class="stack" role="list" style="list-style:none;padding-left:0">
								${items.map(
									(item) =>
										html`<li class="cluster">
											<span role="img" aria-label="${item.done ? 'Done' : 'Not done yet'}">${item.done ? '✅' : '❌'}</span>
											<span>${item.label}</span>
											${item.done && item.doneAt ? html`<span class="muted tiny">ticked off ${timeTag(item.doneAt, DATE_ONLY)}</span>` : ''}
										</li>`,
								)}
							</ul>
						</section>`
		}
		<p class="muted tiny" id="ready-footnote">
			* Not scientific. The checklist is kept by the management, is entirely universal, and contains nothing personal.
			The baby has not been consulted.
		</p>
		<p class="cluster">
			<a class="btn btn-ghost" href="/wall">Congratulations wall</a>
			<a class="btn btn-ghost" href="/names">Name suggestion box</a>
		</p>
	</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// /wall: congratulations (opens on YES)
// ─────────────────────────────────────────────────────────────────────────────

type WallField = 'name' | 'message';

interface WallPageOptions {
	notice?: Notice;
	form?: FormState<WallField>;
	httpStatus?: number;
	before?: number | null;
}

const WALL_DESCRIPTION = `Leave a message of congratulations for ${PARENTS}. It opens when ${DAD} is a dad.`;

communityRoutes.get('/wall', async (c) => {
	const before = parseId(c.req.query('before'));
	if (wantsJson(c)) {
		if (c.get('state').status !== 'yes') {
			return c.json({ open: false, awaitingApproval: 0, messages: [], nextBefore: null });
		}
		const [{ messages, nextBefore }, counts] = await Promise.all([
			listApprovedWall(c.env, { beforeId: before }),
			wallCounts(c.env),
		]);
		return c.json({
			open: true,
			awaitingApproval: counts.pending,
			messages: messages.map(({ id, name, message, createdAt }) => ({ id, name, message, createdAt })),
			nextBefore,
		});
	}
	return renderWallPage(c, { before });
});

communityRoutes.post('/wall', async (c) => {
	const json = wantsJson(c);
	if (c.get('state').status !== 'yes') {
		const text = `The wall isn't open yet. It opens when ${DAD} is a dad, which hasn't happened. Yet.`;
		if (json) return c.json({ ok: false, error: 'closed', message: text }, 425);
		return renderWallPage(c, { notice: { kind: 'error', text }, httpStatus: 425 });
	}

	const body = await readForm(c);
	const guard = await guardPublicWrite(c, 'wall', body);
	if (guard) {
		if (json) return c.json({ ok: false, error: guard.error, message: guard.text }, guard.status);
		const values = { name: cleanLine(body?.name), message: cleanMultiline(body?.message) };
		return renderWallPage(c, { notice: { kind: 'error', text: guard.text }, form: { values, errors: {} }, httpStatus: guard.status });
	}
	const fields = body ?? {};

	const thanks = 'Thank you! Your message is awaiting approval, and will appear once a moderator has read it and stopped welling up.';
	if (isBot(fields)) {
		if (json) return c.json({ ok: true, outcome: 'queued', message: thanks });
		return renderWallPage(c, { notice: { kind: 'ok', text: thanks } });
	}

	const result = validateWallEntry({ name: fields.name, message: fields.message });
	if (!result.ok) {
		if (json) return c.json({ ok: false, error: 'invalid', errors: result.errors }, 400);
		return renderWallPage(c, {
			notice: errorSummary('wall', result.errors),
			form: { values: result.input, errors: result.errors },
			httpStatus: 400,
		});
	}

	const outcome = await submitWallMessage(c.env, result.value, await hashIdentifier(c.env, clientKey(c)));
	if (outcome === 'queue-full') {
		const text =
			'You already have several messages waiting for approval. Let the moderators catch up, then try again. They read slowly, for effect.';
		if (json) return c.json({ ok: false, error: 'queue-full', message: text }, 429);
		return renderWallPage(c, { notice: { kind: 'error', text }, form: { values: result.input, errors: {} }, httpStatus: 429 });
	}
	if (json) return c.json({ ok: true, outcome, message: thanks });
	return renderWallPage(c, { notice: { kind: 'ok', text: thanks } });
});

async function renderWallPage(c: Ctx, opts: WallPageOptions): Promise<Response> {
	const state = c.get('state');
	if (state.status !== 'yes') {
		return renderPage(c, {
			title: 'Congratulations wall',
			description: WALL_DESCRIPTION,
			path: '/wall',
			status: opts.httpStatus,
			body: wallClosedBody(state, opts.notice),
		});
	}
	const [{ messages, nextBefore }, counts] = await Promise.all([
		listApprovedWall(c.env, { beforeId: opts.before ?? null }),
		wallCounts(c.env),
	]);
	const form = opts.form ?? { values: { name: '', message: '' }, errors: {} };
	return renderPage(c, {
		title: 'Congratulations wall',
		description: WALL_DESCRIPTION,
		path: '/wall',
		status: opts.httpStatus,
		turnstile: turnstileEnabled(c.env),
		body: html`<div class="wrap section stack">
			<header class="page-head">
				<p class="kicker">Congratulations wall</p>
				<h1 class="h1-fit">Congratulations, ${PARENTS}!</h1>
				<p class="lede">
					${DAD} is a dad. Leave a few words for the new parents. Messages appear once a moderator has checked them for
					decency and, where possible, spelling.
				</p>
			</header>
			${noticeHtml(opts.notice)}
			<section class="card stack" aria-labelledby="wall-form-title">
				<h2 class="card-title" id="wall-form-title">Leave a message</h2>
				<form class="form stack" method="post" action="/wall">
					${field({
						id: 'wall-name',
						name: 'name',
						label: 'Your name',
						value: form.values.name,
						maxLength: WALL_NAME_MAX,
						required: true,
						autocomplete: 'name',
						hint: `Up to ${WALL_NAME_MAX} characters. Shown with your message.`,
						error: form.errors.name,
					})}
					${field({
						id: 'wall-message',
						name: 'message',
						label: 'Your message',
						value: form.values.message,
						maxLength: WALL_MESSAGE_MAX,
						required: true,
						multiline: true,
						rows: 5,
						hint: `Up to ${WALL_MESSAGE_MAX} characters. Please keep it kind, and keep the baby's details out of it.`,
						error: form.errors.message,
					})}
					${honeypot('wall')} ${turnstileWidget(c.env)}
					<div class="cluster"><button class="btn btn-primary" type="submit">Send congratulations</button></div>
				</form>
			</section>
			<section class="stack" aria-labelledby="wall-messages-title">
				<h2 id="wall-messages-title">Messages</h2>
				<p class="muted">
					${plural(counts.approved, 'message')} on the wall. ${plural(counts.pending, 'message')} awaiting approval.
				</p>
				${
					messages.length
						? html`<div class="grid">${messages.map(wallCard)}</div>`
						: html`<div class="empty">
								<p>${opts.before ? 'No older messages. This is where the wall began.' : 'No messages on the wall yet. Be the first; it will be framed (metaphorically).'}</p>
							</div>`
				}
				${
					opts.before || nextBefore
						? html`<nav class="cluster" aria-label="Wall pages">
								${opts.before ? html`<a class="btn btn-ghost" href="/wall#wall-messages-title">Newest messages</a>` : ''}
								${nextBefore ? html`<a class="btn btn-ghost" href="/wall?before=${nextBefore}#wall-messages-title">Older messages</a>` : ''}
							</nav>`
						: ''
				}
			</section>
		</div>`,
	});
}

function wallCard(m: WallMessage): Html {
	return html`<article class="card stack" id="message-${m.id}">
		<p style="white-space:pre-line;overflow-wrap:anywhere">${m.message}</p>
		<p class="muted tiny">From <strong>${m.name}</strong> · ${timeTag(m.createdAt)}</p>
	</article>`;
}

function wallClosedBody(state: SiteState, notice: Notice | undefined): Html {
	const days = state.dueDate ? daysBetween(londonDate(), state.dueDate) : null;
	return html`<div class="wrap section stack">
		<header class="page-head">
			<p class="kicker">Congratulations wall</p>
			<h1>The wall is closed.</h1>
			<p class="lede">
				It opens when ${DAD} is a dad. Congratulating people in advance is how jinxes work, and nobody wants that.
			</p>
		</header>
		${noticeHtml(notice)}
		<div class="card stack">
			<p class="big-number" aria-hidden="true">🧱</p>
			<p>Current answer: <span class="badge badge-${state.status}">${STATUS_COPY[state.status].short}</span></p>
			${
				state.status === 'soon'
					? html`<p><strong>Labour has started.</strong> The wall opens the moment there's news. Start drafting.</p>`
					: state.dueDate && days !== null
						? html`<p>
								The due date ${days < 0 ? 'was' : 'is'} ${formatLondonDate(state.dueDate)} (${relativeDays(days)}). Babies are famously
								punctual, so plan accordingly.
							</p>`
						: ''
			}
			<p>Want to know the moment it opens? <a href="/everything">Get notified</a>.</p>
		</div>
	</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// /names: the baby name suggestion box (all suggestions will be ignored)
// ─────────────────────────────────────────────────────────────────────────────

type NameField = 'name' | 'suggestedBy';

interface NamesPageOptions {
	notice?: Notice;
	form?: FormState<NameField>;
	httpStatus?: number;
}

const NAMES_DESCRIPTION = 'Suggest a name for the baby. All suggestions will be ignored.';

communityRoutes.get('/names', async (c) => {
	if (wantsJson(c)) {
		const [counts, names] = await Promise.all([nameCounts(c.env), listApprovedNames(c.env)]);
		const ranks = competitionRanks(names.map((n) => n.votes));
		return c.json({
			received: counts.total,
			used: 0,
			awaitingApproval: counts.pending,
			names: names.map((n, i) => ({ rank: ranks[i], id: n.id, name: n.name, suggestedBy: n.suggestedBy, votes: n.votes })),
		});
	}
	return renderNamesPage(c, { notice: flashNotice(c, NAMES_DONE, NAMES_ERRORS) });
});

/** After a vote (no JS): fixed messages only; `n` is the new vote count. */
const NAMES_DONE: FlashTable = {
	counted: (n) => `Vote counted. That name now has ${plural(n ?? 1, 'vote')}, ${n === 1 ? 'which' : 'all of which'} will be ignored.`,
	already: () => "You've already voted for that one. One vote per person: this is a democracy, not a raffle.",
};

const NAMES_ERRORS: FlashTable = {
	'not-found': () => "That name isn't on the leaderboard (any more). Your vote has been ignored slightly earlier than usual.",
	'rate-limited': () => 'Steady on. Too many submissions in a short time; please wait a minute and try again.',
	turnstile: () => "We couldn't confirm you're a human (no offence). Please complete the check and try again.",
	'too-large': () => 'That was rather a lot of form. Please send something shorter.',
};

// A vote is a POST; its address isn't a page. Anyone who ends up there (a bookmark, a
// refresh after the redirect) is sent to the leaderboard.
communityRoutes.get('/names/:id/vote', (c) => c.redirect('/names', 303));

communityRoutes.post('/names', async (c) => {
	const json = wantsJson(c);
	const body = await readForm(c);
	const guard = await guardPublicWrite(c, 'names', body);
	if (guard) {
		if (json) return c.json({ ok: false, error: guard.error, message: guard.text }, guard.status);
		const values = { name: normaliseSuggestedName(body?.name), suggestedBy: cleanLine(body?.suggestedBy) };
		return renderNamesPage(c, { notice: { kind: 'error', text: guard.text }, form: { values, errors: {} }, httpStatus: guard.status });
	}
	const fields = body ?? {};

	const received = (name: string) => `Received. “${name}” has been filed, and will be ignored in due course.`;
	if (isBot(fields)) {
		const text = received(normaliseSuggestedName(fields.name) || 'Your suggestion');
		if (json) return c.json({ ok: true, outcome: 'queued', message: text });
		return renderNamesPage(c, { notice: { kind: 'ok', text } });
	}

	const result = validateNameSuggestion({ name: fields.name, suggestedBy: fields.suggestedBy });
	if (!result.ok) {
		if (json) return c.json({ ok: false, error: 'invalid', errors: result.errors }, 400);
		return renderNamesPage(c, {
			notice: errorSummary('names', result.errors),
			form: { values: result.input, errors: result.errors },
			httpStatus: 400,
		});
	}

	const outcome = await submitNameSuggestion(c.env, result.value, await hashIdentifier(c.env, clientKey(c)));
	let text: string;
	let kind: Notice['kind'] = 'ok';
	let status = 200;
	switch (outcome.kind) {
		case 'queued':
			text = received(result.value.name);
			break;
		case 'duplicate-pending':
			text = `Great minds: “${result.value.name}” is already in the queue. It will be ignored exactly once.`;
			break;
		case 'duplicate-approved':
			if (outcome.vote.kind === 'counted') {
				text = `“${outcome.name}” is already on the leaderboard, so we've counted your suggestion as a vote. It now has ${plural(outcome.vote.votes, 'vote')}.`;
			} else if (outcome.vote.kind === 'already') {
				text = `“${outcome.name}” is already on the leaderboard, and you've already voted for it. Your enthusiasm has been noted.`;
			} else {
				text = received(result.value.name);
			}
			break;
		case 'queue-full':
			kind = 'error';
			status = 429;
			text = 'You already have plenty of suggestions waiting. Let the moderators catch up; they ignore things carefully.';
			break;
	}
	if (json) {
		return c.json(
			{ ok: kind === 'ok', outcome: outcome.kind, message: text },
			status as 200 | 429,
		);
	}
	return renderNamesPage(c, {
		notice: { kind, text },
		form: kind === 'error' ? { values: result.input, errors: {} } : undefined,
		httpStatus: status,
	});
});

communityRoutes.post('/names/:id/vote', async (c) => {
	const json = wantsJson(c);
	const id = parseId(c.req.param('id'));
	const body = await readForm(c);
	const guard = await guardPublicWrite(c, 'names-vote', body);
	if (guard) {
		if (json) return c.json({ ok: false, error: guard.error, message: guard.text }, guard.status);
		// Post/redirect/get: the address bar ends up on /names, not on a POST-only URL.
		return c.redirect(`/names?error=${encodeURIComponent(guard.error)}`, 303);
	}

	const outcome = id === null ? ({ kind: 'not-found' } as const) : await voteForName(c.env, id, await hashIdentifier(c.env, clientKey(c)));
	if (outcome.kind === 'not-found') {
		const text = "That name isn't on the leaderboard (any more). Your vote has been ignored slightly earlier than usual.";
		if (json) return c.json({ ok: false, error: 'not-found', message: text }, 404);
		return c.redirect('/names?error=not-found', 303);
	}
	if (json) {
		const text =
			outcome.kind === 'counted'
				? `Vote counted. “${outcome.name}” now has ${plural(outcome.votes, 'vote')}, ${outcome.votes === 1 ? 'which' : 'all of which'} will be ignored.`
				: `You've already voted for “${outcome.name}”. One vote per person: this is a democracy, not a raffle.`;
		return c.json({ ok: true, outcome: outcome.kind, id, votes: outcome.votes, message: text });
	}
	return c.redirect(`/names?done=${outcome.kind}&n=${outcome.votes}#name-${id}`, 303);
});

async function renderNamesPage(c: Ctx, opts: NamesPageOptions): Promise<Response> {
	const status = c.get('state').status;
	const [counts, names, voted] = await Promise.all([
		nameCounts(c.env),
		listApprovedNames(c.env),
		hashIdentifier(c.env, clientKey(c)).then((hash) => votedSuggestionIds(c.env, hash)),
	]);
	const form = opts.form ?? { values: { name: '', suggestedBy: '' }, errors: {} };
	return renderPage(c, {
		title: 'Baby name suggestion box',
		description: NAMES_DESCRIPTION,
		path: '/names',
		status: opts.httpStatus,
		turnstile: turnstileEnabled(c.env),
		body: html`<div class="wrap section stack">
			<header class="page-head">
				<p class="kicker">Baby name suggestion box</p>
				<h1>All suggestions will be ignored.</h1>
				<p class="lede">${plural(counts.total, 'suggestion')} received. 0 will be used.</p>
			</header>
			${noticeHtml(opts.notice)}
			<section class="card stack" aria-labelledby="names-form-title">
				<h2 class="card-title" id="names-form-title">Suggest a name</h2>
				<p class="muted">
					${
						status === 'yes'
							? 'The baby has arrived and, exactly as promised, every suggestion was ignored. The box remains open for historical reasons.'
							: 'Every suggestion is read by a moderator, considered with a straight face, and then ignored. It is the thought that counts, and the thought is counted.'
					}
				</p>
				<form class="form stack" method="post" action="/names">
					${field({
						id: 'names-name',
						name: 'name',
						label: 'Name suggestion',
						value: form.values.name,
						maxLength: NAME_MAX,
						required: true,
						autocomplete: 'off',
						pattern: NAME_HTML_PATTERN,
						hint: `Up to ${NAME_MAX} characters: letters (accents welcome), spaces, hyphens and apostrophes.`,
						error: form.errors.name,
					})}
					${field({
						id: 'names-suggestedBy',
						name: 'suggestedBy',
						label: 'Suggested by',
						value: form.values.suggestedBy,
						maxLength: SUGGESTED_BY_MAX,
						autocomplete: 'nickname',
						hint: `Optional. Shown publicly next to the name on the leaderboard, so a first name or nickname is plenty (up to ${SUGGESTED_BY_MAX} characters).`,
						error: form.errors.suggestedBy,
					})}
					${honeypot('names')} ${turnstileWidget(c.env)}
					<div class="cluster"><button class="btn btn-primary" type="submit">Submit for ignoring</button></div>
				</form>
			</section>
			<section class="stack" aria-labelledby="names-board-title">
				<h2 id="names-board-title">The leaderboard</h2>
				<p class="muted">
					Approved suggestions, by votes. One vote per person per name. Votes will also be ignored, but more democratically.
				</p>
				${names.length ? leaderboard(c, names, voted) : html`<div class="empty"><p>No approved suggestions yet. The ignoring has not yet begun in earnest.</p></div>`}
				${counts.approved > names.length ? html`<p class="muted tiny">Showing the top ${names.length} of ${plural(counts.approved, 'approved name')}.</p>` : ''}
			</section>
			<p class="muted tiny">
				None of these is the baby's name. This site doesn't know the baby's name, and wouldn't say if it did.
			</p>
		</div>`,
	});
}

function leaderboard(c: Ctx, names: NameSuggestion[], voted: Set<number>): Html {
	const ranks = competitionRanks(names.map((n) => n.votes));
	const tied = (i: number) => ranks[i - 1] === ranks[i] || ranks[i + 1] === ranks[i];
	return html`<form class="stack" method="post" action="/names">
		${turnstileEnabled(c.env) ? html`<p class="hint">Complete the human check once, then vote for as many names as you like.</p>` : ''}
		${turnstileWidget(c.env)}
		<div class="table-wrap">
			<table class="table">
				<caption class="muted tiny" style="text-align:start">Top ${names.length} suggested names, most votes first</caption>
				<thead>
					<tr>
						<th scope="col">Rank</th>
						<th scope="col">Name</th>
						<th scope="col">Suggested by</th>
						<th scope="col">Votes</th>
						<th scope="col">Vote</th>
					</tr>
				</thead>
				<tbody>
					${names.map(
						(n, i) => html`<tr id="name-${n.id}">
							<td class="mono">${tied(i) ? '=' : ''}${ranks[i]}</td>
							<th scope="row">${n.name}</th>
							<td>${n.suggestedBy ?? html`<span class="muted">anonymous</span>`}</td>
							<td class="mono">${n.votes}</td>
							<td>
								${
									voted.has(n.id)
										? html`<button class="btn btn-ghost" type="button" disabled aria-label="You voted for ${n.name}">✓ Voted</button>`
										: html`<button class="btn" type="submit" formaction="/names/${n.id}/vote" aria-label="Vote for ${n.name}">▲ Vote</button>`
								}
							</td>
						</tr>`,
					)}
				</tbody>
			</table>
		</div>
	</form>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: shared
// ─────────────────────────────────────────────────────────────────────────────

/** Flash notices are fixed keys (never reflected text), so the URL can't put words in our mouth. */
type FlashTable = Record<string, (n: number | null) => string>;

function flashNotice(c: Ctx, done: FlashTable, errors: FlashTable): Notice | undefined {
	const nRaw = c.req.query('n');
	const n = nRaw !== undefined && /^\d{1,6}$/.test(nRaw) ? Number(nRaw) : null;
	const errorKey = c.req.query('error');
	if (errorKey && Object.hasOwn(errors, errorKey)) return { kind: 'error', text: (errors[errorKey] as FlashTable[string])(n) };
	const doneKey = c.req.query('done');
	if (doneKey && Object.hasOwn(done, doneKey)) return { kind: 'ok', text: (done[doneKey] as FlashTable[string])(n) };
	return undefined;
}

/** After an admin action: 303 back to the page with a flash key, or JSON. */
function adminResult(
	c: Ctx,
	path: string,
	result: { ok: true; done: string; n?: number } | { ok: false; error: string; status: 400 | 404 | 409 },
	extra: Record<string, unknown> = {},
): Response {
	if (wantsJson(c)) {
		return result.ok
			? c.json({ ok: true, done: result.done, ...extra })
			: c.json({ ok: false, error: result.error, ...extra }, result.status);
	}
	const params = new URLSearchParams(result.ok ? { done: result.done } : { error: result.error });
	if (result.ok && result.n !== undefined) params.set('n', String(result.n));
	return c.redirect(`${path}?${params}`, 303);
}

const MODERATION_DONE: FlashTable = {
	approve: () => 'Approved. It is now public.',
	reject: () => 'Rejected. Nobody will ever know.',
	remove: () => 'Removed from public view.',
};

const MODERATION_ERRORS: FlashTable = {
	missing: () => 'That item has already been dealt with (or never existed). Nothing changed.',
};

function stats(entries: Array<[string, number]>): Html {
	return html`<div class="stats">
		${entries.map(
			([label, value]) =>
				html`<div class="stat"><span class="stat-value">${formatNumber(value)}</span><span class="stat-label">${label}</span></div>`,
		)}
	</div>`;
}

/** A one-button POST form. Danger buttons ask first (admin.js reads the form's data-confirm). */
function actionButton(action: string, label: string, ariaLabel: string, variant: 'primary' | 'danger' | 'ghost'): Html {
	return html`<form method="post" action="${action}" style="display:inline;margin:0"${
		variant === 'danger' ? html` data-confirm="${ariaLabel}?"` : ''
	}>
		<button class="btn btn-${variant}" type="submit" aria-label="${ariaLabel}">${label}</button>
	</form>`;
}

async function moderationPost(
	c: Ctx,
	path: string,
	moderate: (env: Env, id: number, action: ModerationAction) => Promise<boolean>,
): Promise<Response> {
	const id = parseId(c.req.param('id'));
	const action = c.req.param('action');
	if (id === null || !isModerationAction(action)) return c.notFound();
	const ok = await moderate(c.env, id, action);
	return adminResult(c, path, ok ? { ok: true, done: action } : { ok: false, error: 'missing', status: 404 }, { id, action });
}

// ─────────────────────────────────────────────────────────────────────────────
// /admin/checklist
// ─────────────────────────────────────────────────────────────────────────────

const CHECKLIST_DONE: FlashTable = {
	added: () => 'Item added to the bottom of the list.',
	updated: () => 'Item updated.',
	moved: () => 'Item moved.',
	deleted: () => 'Item deleted. It was probably optional anyway.',
	seeded: (n) =>
		n ? `Added ${plural(n, 'suggested item')}. Readiness has dropped accordingly.` : 'Every suggested item is already on the list.',
};

const CHECKLIST_ERRORS: FlashTable = {
	missing: () => "That item doesn't exist (any more). Nothing changed.",
	edge: () => "That item can't move any further in that direction.",
	direction: () => 'Up or down only. Sideways is not supported.',
};

communityRoutes.get('/admin/checklist', async (c) => {
	const items = await listChecklist(c.env);
	if (wantsJson(c)) return c.json({ items, readiness: summariseReadiness(items) });
	return renderChecklistAdmin(c, items, { notice: flashNotice(c, CHECKLIST_DONE, CHECKLIST_ERRORS) });
});

communityRoutes.post('/admin/checklist', async (c) => {
	const body = (await readForm(c)) ?? {};
	const label = validateChecklistLabel(body.label);
	if (!label.ok) {
		if (wantsJson(c)) return c.json({ ok: false, error: 'label', message: label.error }, 400);
		return renderChecklistAdmin(c, await listChecklist(c.env), {
			notice: { kind: 'error', text: label.error },
			label: cleanLine(body.label),
			labelError: label.error,
			httpStatus: 400,
		});
	}
	const id = await addChecklistItem(c.env, label.value);
	return adminResult(c, '/admin/checklist', { ok: true, done: 'added' }, { id });
});

communityRoutes.post('/admin/checklist/seed', async (c) => {
	const added = await seedChecklist(c.env);
	return adminResult(c, '/admin/checklist', { ok: true, done: 'seeded', n: added }, { added });
});

communityRoutes.post('/admin/checklist/:id/toggle', async (c) => {
	const id = parseId(c.req.param('id'));
	if (id === null) return c.notFound();
	const body = (await readForm(c)) ?? {};
	const done = body.done === '1' ? true : body.done === '0' ? false : undefined;
	const ok = await setChecklistDone(c.env, id, done);
	return adminResult(c, '/admin/checklist', ok ? { ok: true, done: 'updated' } : { ok: false, error: 'missing', status: 404 }, { id });
});

communityRoutes.post('/admin/checklist/:id/move', async (c) => {
	const id = parseId(c.req.param('id'));
	if (id === null) return c.notFound();
	const body = (await readForm(c)) ?? {};
	const direction = body.direction;
	if (direction !== 'up' && direction !== 'down') {
		return adminResult(c, '/admin/checklist', { ok: false, error: 'direction', status: 400 }, { id });
	}
	const ok = await moveChecklistItem(c.env, id, direction);
	return adminResult(c, '/admin/checklist', ok ? { ok: true, done: 'moved' } : { ok: false, error: 'edge', status: 409 }, { id });
});

communityRoutes.post('/admin/checklist/:id/delete', async (c) => {
	const id = parseId(c.req.param('id'));
	if (id === null) return c.notFound();
	const ok = await deleteChecklistItem(c.env, id);
	return adminResult(c, '/admin/checklist', ok ? { ok: true, done: 'deleted' } : { ok: false, error: 'missing', status: 404 }, { id });
});

function renderChecklistAdmin(
	c: Ctx,
	items: ChecklistItem[],
	opts: { notice?: Notice; label?: string; labelError?: string; httpStatus?: number },
): Promise<Response> {
	const readiness = summariseReadiness(items);
	const missing = missingSuggestions(items.map((item) => item.label));
	return renderAdminPage(c, {
		title: 'Readiness checklist',
		status: opts.httpStatus,
		body: html`<header class="page-head">
				<h1>Readiness checklist</h1>
				<p class="lede">
					${readiness.total ? `${readiness.percent}% ready: ${readiness.done} of ${plural(readiness.total, 'item')} done.` : 'No items yet.'}
					<a href="/ready">View the public page</a>.
				</p>
			</header>
			${noticeHtml(opts.notice)} ${readiness.total ? meter(readiness.percent, 'Dad readiness') : ''}
			<section class="card stack" aria-labelledby="checklist-add-title">
				<h2 class="card-title" id="checklist-add-title">Add an item</h2>
				<form class="form stack" method="post" action="/admin/checklist">
					${field({
						id: 'checklist-label',
						name: 'label',
						label: 'Item',
						value: opts.label ?? '',
						maxLength: CHECKLIST_LABEL_MAX,
						required: true,
						autocomplete: 'off',
						hint: `Up to ${CHECKLIST_LABEL_MAX} characters. Public, so keep it universal: nothing personal about anyone.`,
						error: opts.labelError,
					})}
					<div class="cluster"><button class="btn btn-primary" type="submit">Add item</button></div>
				</form>
			</section>
			<section class="stack" aria-labelledby="checklist-items-title">
				<h2 id="checklist-items-title">Items</h2>
				${
					items.length
						? html`<div class="table-wrap">
								<table class="table">
									<thead>
										<tr>
											<th scope="col">#</th>
											<th scope="col">Item</th>
											<th scope="col">Done?</th>
											<th scope="col">Actions</th>
										</tr>
									</thead>
									<tbody>
										${items.map((item, i) => checklistRow(item, i, items.length))}
									</tbody>
								</table>
							</div>`
						: html`<div class="empty"><p>The checklist is empty. Add an item above, or seed the suggested ones below.</p></div>`
				}
			</section>
			<section class="card stack" aria-labelledby="checklist-seed-title">
				<h2 class="card-title" id="checklist-seed-title">Suggested items</h2>
				${
					missing.length
						? html`<p>
									Adds ${plural(missing.length, 'universal, non-personal item')} that ${missing.length === 1 ? "isn't" : "aren't"} on the list
									yet (of ${SUGGESTED_CHECKLIST.length} suggestions):
								</p>
								<ul>
									${missing.map((label) => html`<li>${label}</li>`)}
								</ul>`
						: html`<p class="muted">All ${SUGGESTED_CHECKLIST.length} suggested items are already on the list.</p>`
				}
				<form method="post" action="/admin/checklist/seed">
					<button class="btn" type="submit"${missing.length ? '' : html` disabled`}>Seed suggested items</button>
				</form>
			</section>`,
	});
}

function checklistRow(item: ChecklistItem, index: number, count: number): Html {
	const base = `/admin/checklist/${item.id}`;
	return html`<tr id="item-${item.id}">
		<td class="mono">${index + 1}</td>
		<td>${item.label}</td>
		<td>
			<span role="img" aria-label="${item.done ? 'Done' : 'Not done'}">${item.done ? '✅' : '❌'}</span>
			${item.done && item.doneAt ? html`<span class="muted tiny">${timeTag(item.doneAt)}</span>` : ''}
		</td>
		<td>
			<div class="cluster">
				<form method="post" action="${base}/toggle" style="display:inline;margin:0">
					<input type="hidden" name="done" value="${item.done ? '0' : '1'}">
					<button class="btn${item.done ? ' btn-ghost' : ' btn-primary'}" type="submit" aria-label="${item.done ? 'Mark not done' : 'Mark done'}: ${item.label}">
						${item.done ? 'Undo' : 'Done'}
					</button>
				</form>
				<form method="post" action="${base}/move" style="display:inline;margin:0">
					<button class="btn btn-ghost" type="submit" name="direction" value="up" aria-label="Move up: ${item.label}"${index === 0 ? html` disabled` : ''}>↑</button>
					<button class="btn btn-ghost" type="submit" name="direction" value="down" aria-label="Move down: ${item.label}"${index === count - 1 ? html` disabled` : ''}>↓</button>
				</form>
				${actionButton(`${base}/delete`, 'Delete', `Delete: ${item.label}`, 'danger')}
			</div>
		</td>
	</tr>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// /admin/wall
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_LIST_LIMIT = 100;

communityRoutes.get('/admin/wall', async (c) => {
	const [pending, approved, counts] = await Promise.all([
		listPendingWall(c.env),
		listApprovedWall(c.env, { limit: ADMIN_LIST_LIMIT }),
		wallCounts(c.env),
	]);
	if (wantsJson(c)) return c.json({ counts, pending, approved: approved.messages });
	const open = c.get('state').status === 'yes';
	return renderAdminPage(c, {
		title: 'Congratulations wall',
		body: html`<header class="page-head">
				<h1 class="h1-fit">Congratulations wall</h1>
				<p class="lede">
					${open
						? `The wall is open: ${DAD} is a dad.`
						: `The wall is closed to the public until ${DAD} is a dad. Moderation works regardless.`}
					<a href="/wall">View the wall</a>.
				</p>
			</header>
			${noticeHtml(flashNotice(c, MODERATION_DONE, MODERATION_ERRORS))}
			${stats([
				['awaiting approval', counts.pending],
				['on the wall', counts.approved],
				['rejected or removed', counts.rejected],
			])}
			<section class="stack" aria-labelledby="wall-pending-title">
				<h2 id="wall-pending-title">Awaiting approval</h2>
				${
					pending.length
						? html`<p class="muted">Oldest first.${counts.pending > pending.length ? ` Showing ${pending.length} of ${counts.pending}.` : ''}</p>
								<div class="stack">${pending.map((m) => wallAdminCard(m, 'pending'))}</div>`
						: html`<div class="empty"><p>Nothing to moderate. Enjoy the silence.</p></div>`
				}
			</section>
			<section class="stack" aria-labelledby="wall-approved-title">
				<h2 id="wall-approved-title">On the wall</h2>
				${
					approved.messages.length
						? html`<p class="muted">
									Newest first.${counts.approved > approved.messages.length ? ` Showing the latest ${approved.messages.length} of ${counts.approved}.` : ''}
								</p>
								<div class="stack">${approved.messages.map((m) => wallAdminCard(m, 'approved'))}</div>`
						: html`<div class="empty"><p>No approved messages yet.</p></div>`
				}
			</section>`,
	});
});

communityRoutes.post('/admin/wall/:id/:action', (c) => moderationPost(c, '/admin/wall', moderateWall));

function wallAdminCard(m: WallMessage, state: 'pending' | 'approved'): Html {
	const base = `/admin/wall/${m.id}`;
	return html`<article class="card stack" id="wall-${m.id}">
		<p class="cluster">
			<strong>${m.name}</strong>
			<span class="muted tiny">${timeTag(m.createdAt)}</span>
			${looksLikeLink(m.message) || looksLikeLink(m.name) ? html`<span class="pill">contains a link</span>` : ''}
		</p>
		<p style="white-space:pre-line;overflow-wrap:anywhere">${m.message}</p>
		<div class="cluster">
			${
				state === 'pending'
					? html`${actionButton(`${base}/approve`, 'Approve', `Approve message from ${m.name}`, 'primary')}
						${actionButton(`${base}/reject`, 'Reject', `Reject message from ${m.name}`, 'danger')}`
					: actionButton(`${base}/remove`, 'Remove', `Remove message from ${m.name}`, 'danger')
			}
		</div>
	</article>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// /admin/names
// ─────────────────────────────────────────────────────────────────────────────

communityRoutes.get('/admin/names', async (c) => {
	const [pending, approved, counts] = await Promise.all([
		listPendingNames(c.env),
		listApprovedNames(c.env, Math.max(NAMES_LIST_LIMIT, 500)),
		nameCounts(c.env),
	]);
	if (wantsJson(c)) return c.json({ counts, pending, approved });
	return renderAdminPage(c, {
		title: 'Name suggestions',
		body: html`<header class="page-head">
				<h1>Name suggestions</h1>
				<p class="lede">All suggestions will be ignored, but some will be ignored in public. <a href="/names">View the box</a>.</p>
			</header>
			${noticeHtml(flashNotice(c, MODERATION_DONE, MODERATION_ERRORS))} ${namesStats(counts)}
			<section class="stack" aria-labelledby="names-pending-title">
				<h2 id="names-pending-title">Awaiting approval</h2>
				${
					pending.length
						? namesTable(pending, 'pending', counts.pending)
						: html`<div class="empty"><p>No suggestions waiting. The public has run out of ideas, briefly.</p></div>`
				}
			</section>
			<section class="stack" aria-labelledby="names-approved-title">
				<h2 id="names-approved-title">On the leaderboard</h2>
				${
					approved.length
						? namesTable(approved, 'approved', counts.approved)
						: html`<div class="empty"><p>Nothing approved yet.</p></div>`
				}
			</section>`,
	});
});

communityRoutes.post('/admin/names/:id/:action', (c) => moderationPost(c, '/admin/names', moderateName));

function namesStats(counts: ModerationCounts): Html {
	return stats([
		['received', counts.total],
		['awaiting approval', counts.pending],
		['on the leaderboard', counts.approved],
		['rejected or removed', counts.rejected],
		['will be used', 0],
	]);
}

function namesTable(rows: NameSuggestion[], state: 'pending' | 'approved', total: number): Html {
	return html`${total > rows.length ? html`<p class="muted">Showing ${rows.length} of ${total}.</p>` : ''}
		<div class="table-wrap">
			<table class="table">
				<thead>
					<tr>
						<th scope="col">Name</th>
						<th scope="col">Suggested by</th>
						<th scope="col">${state === 'pending' ? 'Received' : 'Votes'}</th>
						<th scope="col">Actions</th>
					</tr>
				</thead>
				<tbody>
					${rows.map((n) => {
						const base = `/admin/names/${n.id}`;
						return html`<tr id="suggestion-${n.id}">
							<th scope="row">${n.name}</th>
							<td>${n.suggestedBy ?? html`<span class="muted">anonymous</span>`}</td>
							<td>${state === 'pending' ? timeTag(n.createdAt) : html`<span class="mono">${n.votes}</span>`}</td>
							<td>
								<div class="cluster">
									${
										state === 'pending'
											? html`${actionButton(`${base}/approve`, 'Approve', `Approve ${n.name}`, 'primary')}
												${actionButton(`${base}/reject`, 'Reject', `Reject ${n.name}`, 'danger')}`
											: actionButton(`${base}/remove`, 'Remove', `Remove ${n.name}`, 'danger')
									}
								</div>
							</td>
						</tr>`;
					})}
				</tbody>
			</table>
		</div>`;
}
