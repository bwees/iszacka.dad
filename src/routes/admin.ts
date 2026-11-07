// OWNER: admin agent.
// Mounted at /admin. Login/logout, dashboard, the big red button, due date, stats,
// recent updates (+ notification re-runs), reload-every-browser, test sends, OG + DNS.
// Every POST: requireAdmin (session + same-origin check), then a 303 back to /admin with the
// outcome in a one-shot flash cookie (or JSON when the client sends Accept: application/json).
// No page renders text taken from its URL: the login page only knows fixed ?done= codes.

import { Hono, type Context } from 'hono';
import { html } from 'hono/html';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
	CONFIRM_WORDS,
	MAX_PASSWORD_LENGTH,
	SESSION_TTL_SECONDS,
	adminCookieName,
	adminEnabled,
	adminFlash,
	confirmMatches,
	confirmWordFor,
	crossSiteRefused,
	currentSessionExpiry,
	endAllSessions,
	endSession,
	flashRedirect,
	formatDuration,
	isAdmin,
	normaliseConfirmWord,
	passwordMatches,
	renderAdminPage,
	renderAdminPublicPage,
	requireAdmin,
	safeNextPath,
	sameOrigin,
	startSession,
} from '../lib/admin';
import { getCheckTotal } from '../lib/counters';
import { deliverySummary, type DeliverySummary } from '../lib/deliveries';
import type { Html } from '../lib/layout';
import { getLedger, type LedgerEntry } from '../lib/ledger';
import { broadcast, liveStats } from '../lib/live';
import { renderOgImage } from '../lib/og';
import {
	allow,
	clientIp,
	clientKey,
	isValidEmail,
	randomToken,
	turnstileEnabled,
	turnstileWidget,
	verifyTurnstile,
	wantsJson,
} from '../lib/security';
import { STATUS_COPY, siteUrl } from '../lib/site';
import { getState, setDueDate, setSetting, setStatus } from '../lib/state';
import { addDays, daysBetween, formatLondon, formatLondonDate, isYmd, londonDate, nowIso } from '../lib/time';
import { getUpdate, listUpdates, startAnnouncement } from '../lib/updates';
import { updateAnswerRecord } from '../notify/dns';
import { emailDailyLimit, emailSendsToday, sendTestEmail } from '../notify/email';
import { STATUSES, isStatus, type AppEnv, type SiteState, type Status, type Update } from '../types';

export const adminRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

// Hono routes strictly, so "/admin/" would otherwise 404. Everything else passes through.
adminRoutes.use('/*', async (c, next) => {
	if (c.req.method === 'GET' && new URL(c.req.url).pathname === '/admin/') return c.redirect('/admin', 301);
	await next();
});

/** Status notifications wait this long before going out (see AnnounceWorkflow). */
const UNDO_WINDOW_MS = 60_000;
const MAX_NOTE_LENGTH = 500;
const RECENT_UPDATES = 10;
const LEDGER_HEAD = 5;

const numberFormat = new Intl.NumberFormat('en-GB');

// ─── Small helpers ──────────────────────────────────────────────────────────

/** Form (urlencoded / multipart) or JSON body, string values only. Never throws. */
async function readForm(c: Ctx): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	try {
		const type = c.req.header('content-type') ?? '';
		const body: Record<string, unknown> = type.includes('application/json')
			? ((await c.req.json()) as Record<string, unknown>)
			: await c.req.parseBody();
		if (body && typeof body === 'object') {
			for (const [key, value] of Object.entries(body)) if (typeof value === 'string') out[key] = value;
		}
	} catch {
		// Malformed body: treat as empty, the handler will complain about missing fields.
	}
	return out;
}

/** Finish an admin action: JSON for API clients, otherwise a 303 back to /admin with a flash. */
function respond(
	c: Ctx,
	ok: boolean,
	message: string,
	opts: { status?: ContentfulStatusCode; data?: Record<string, unknown> } = {},
): Response {
	if (wantsJson(c)) return c.json({ ok, message, ...opts.data }, opts.status ?? (ok ? 200 : 400));
	return flashRedirect(c, ok ? 'ok' : 'err', message);
}

function errorMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	// Keep addresses out of flash URLs and logs.
	return message.replace(/[^\s@<>"']+@[^\s@<>"']+/g, '[address]').slice(0, 200);
}

/** Wrap a POST handler so an unexpected failure becomes an error flash instead of a 500 page. */
function action(name: string, handler: (c: Ctx) => Promise<Response>) {
	return async (c: Ctx): Promise<Response> => {
		try {
			return await handler(c);
		} catch (err) {
			console.error(`admin ${name} failed:`, err);
			return respond(c, false, `${name} failed: ${errorMessage(err)}`, { status: 500 });
		}
	};
}

function fmt(n: number | null): string {
	return n === null ? '?' : numberFormat.format(n);
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${numberFormat.format(n)} ${n === 1 ? one : many}`;
}

function relativeDays(days: number): string {
	if (days === 0) return 'today';
	if (days === 1) return 'tomorrow';
	if (days === -1) return 'yesterday, so officially overdue';
	if (days > 1) return `in ${plural(days, 'day')}`;
	return `${plural(-days, 'day')} ago, so officially overdue`;
}

// ─── Data for the dashboard ─────────────────────────────────────────────────

interface DashboardStats {
	subscribersBig: number | null;
	subscribersDaily: number | null;
	subscribersPending: number | null;
	subscribersUnsubscribed: number | null;
	push: number | null;
	webhooks: number | null;
	guesses: number | null;
	guessesHidden: number | null;
	wallPending: number | null;
	namesPending: number | null;
	checks: number | null;
	viewers: number | null;
}

/** One COUNT(*) query. Returns null (shown as "?") if the table isn't there or D1 hiccups. */
async function count(env: Env, sql: string): Promise<number | null> {
	try {
		const row = await env.DB.prepare(sql).first<{ n: number }>();
		return Number(row?.n ?? 0);
	} catch (err) {
		console.error('admin stat failed:', sql, err);
		return null;
	}
}

async function loadStats(env: Env): Promise<DashboardStats> {
	const [
		subscribersBig,
		subscribersDaily,
		subscribersPending,
		subscribersUnsubscribed,
		push,
		webhooks,
		guesses,
		guessesHidden,
		wallPending,
		namesPending,
		checks,
		live,
	] = await Promise.all([
		count(
			env,
			"SELECT COUNT(*) AS n FROM subscribers WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL AND frequency = 'big'",
		),
		count(
			env,
			"SELECT COUNT(*) AS n FROM subscribers WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL AND frequency = 'daily'",
		),
		count(env, 'SELECT COUNT(*) AS n FROM subscribers WHERE confirmed_at IS NULL AND unsubscribed_at IS NULL'),
		count(env, 'SELECT COUNT(*) AS n FROM subscribers WHERE unsubscribed_at IS NOT NULL'),
		count(env, 'SELECT COUNT(*) AS n FROM push_subscriptions WHERE disabled_at IS NULL'),
		count(env, 'SELECT COUNT(*) AS n FROM webhooks WHERE disabled_at IS NULL'),
		count(env, 'SELECT COUNT(*) AS n FROM guesses WHERE hidden = 0'),
		count(env, 'SELECT COUNT(*) AS n FROM guesses WHERE hidden != 0'),
		count(env, 'SELECT COUNT(*) AS n FROM wall WHERE approved_at IS NULL AND rejected_at IS NULL'),
		count(env, 'SELECT COUNT(*) AS n FROM name_suggestions WHERE approved_at IS NULL AND rejected_at IS NULL'),
		getCheckTotal(env).catch((err: unknown) => {
			console.error('admin check total failed:', err);
			return null;
		}),
		liveStats(env),
	]);
	return {
		subscribersBig,
		subscribersDaily,
		subscribersPending,
		subscribersUnsubscribed,
		push,
		webhooks,
		guesses,
		guessesHidden,
		wallPending,
		namesPending,
		checks,
		viewers: live.viewers,
	};
}

interface WorkflowView {
	id: string;
	/** InstanceStatus status, or 'not found' when the instance doesn't exist (or can't be read). */
	status: string;
	error?: string;
}

async function workflowStatus(env: Env, id: string): Promise<WorkflowView> {
	try {
		const instance = await env.ANNOUNCE.get(id);
		const status = await instance.status();
		return { id, status: status.status, error: status.error?.message };
	} catch {
		return { id, status: 'not found' };
	}
}

interface UpdateView {
	update: Update;
	deliveries: DeliverySummary[] | null;
	workflow: WorkflowView;
	attempts: number;
	rerun: WorkflowView | null;
}

/** Re-run attempt counters (settings `rerun:<id>`) for a set of updates. */
async function rerunAttempts(env: Env, ids: number[]): Promise<Map<number, number>> {
	const out = new Map<number, number>();
	if (ids.length === 0) return out;
	try {
		const keys = ids.map((id) => `rerun:${id}`);
		const { results } = await env.DB.prepare(
			`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`,
		)
			.bind(...keys)
			.all<{ key: string; value: string }>();
		for (const row of results) {
			const n = Number.parseInt(row.value, 10);
			if (Number.isSafeInteger(n) && n > 0) out.set(Number(row.key.slice('rerun:'.length)), n);
		}
	} catch (err) {
		console.error('admin rerun counters failed:', err);
	}
	return out;
}

/** Atomically bump `rerun:<id>` and return the new attempt number (1, 2, 3...). */
async function nextRerunAttempt(env: Env, updateId: number): Promise<number> {
	const row = await env.DB.prepare(
		`INSERT INTO settings (key, value, updated_at) VALUES (?1, '1', ?2)
		 ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at
		 RETURNING value`,
	)
		.bind(`rerun:${updateId}`, nowIso())
		.first<{ value: string }>();
	const attempt = Number.parseInt(row?.value ?? '', 10);
	if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Could not record the re-run attempt');
	return attempt;
}

async function loadUpdates(env: Env): Promise<UpdateView[]> {
	const updates = await listUpdates(env, { limit: RECENT_UPDATES }).catch((err: unknown) => {
		console.error('admin listUpdates failed:', err);
		return [] as Update[];
	});
	const attempts = await rerunAttempts(
		env,
		updates.map((u) => u.id),
	);
	return Promise.all(
		updates.map(async (update): Promise<UpdateView> => {
			const n = attempts.get(update.id) ?? 0;
			const [deliveries, workflow, rerun] = await Promise.all([
				deliverySummary(env, update.id).catch(() => null),
				workflowStatus(env, `update-${update.id}`),
				n > 0 ? workflowStatus(env, `update-${update.id}-r${n}`) : Promise.resolve(null),
			]);
			return { update, deliveries, workflow, attempts: n, rerun };
		}),
	);
}

async function loadLedgerHead(env: Env): Promise<LedgerEntry[] | null> {
	try {
		const entries = await getLedger(env, { limit: 500 });
		return entries.slice(-LEDGER_HEAD).reverse();
	} catch (err) {
		console.error('admin ledger failed:', err);
		return null;
	}
}

// ─── Dashboard fragments ────────────────────────────────────────────────────

const STATUS_BUTTONS: ReadonlyArray<{ status: Status; detail: string; className: string }> = [
	{ status: 'no', detail: 'Not a dad. Back to waiting.', className: 'btn' },
	{ status: 'soon', detail: 'Labour has started.', className: 'btn btn-primary' },
	{ status: 'yes', detail: 'Zack is a dad.', className: 'btn btn-danger' },
];

function statusBadge(status: Status): Html {
	return html`<span class="badge badge-${status}">${STATUS_COPY[status].word}</span>`;
}

function bigRedButton(state: SiteState, now: number): Html {
	const changedAt = Date.parse(state.statusChangedAt);
	const undoUntil = Number.isFinite(changedAt) ? changedAt + UNDO_WINDOW_MS : 0;
	const undoOpen = undoUntil > now;
	const since = Number.isFinite(changedAt) ? formatDuration(now - changedAt) : null;

	return html`<section class="card stack" aria-labelledby="status-h">
		<h2 id="status-h" class="card-title">The big red button</h2>
		<p>
			Right now the answer is ${statusBadge(state.status)}
			${since
				? html`and has been since <time datetime="${state.statusChangedAt}">${formatLondon(state.statusChangedAt)}</time>
						(${since}).`
				: ''}
		</p>
		${undoOpen
			? html`<div class="notice" role="status" data-undo-until="${new Date(undoUntil).toISOString()}">
					<p>
						<strong>Undo window open</strong> until
						<time datetime="${new Date(undoUntil).toISOString()}">${formatLondon(new Date(undoUntil).toISOString(), {
							second: '2-digit',
						})}</time>. Notifications for this change haven't gone out yet. Flip it back before then and they're
						cancelled.
					</p>
				</div>`
			: ''}

		<form method="post" action="/admin/status" class="form stack" data-status-form>
			<div class="field">
				<label for="confirm">Confirmation word</label>
				<input
					id="confirm"
					name="confirm"
					type="text"
					required
					maxlength="16"
					autocomplete="off"
					autocapitalize="characters"
					spellcheck="false"
					class="mono"
					aria-describedby="confirm-hint"
					data-confirm-input
				/>
				<p class="hint" id="confirm-hint">
					Type <strong class="mono">${CONFIRM_WORDS.yes}</strong> to press YES,
					<strong class="mono">${CONFIRM_WORDS.soon}</strong> for NOT YET (labour has started), or
					<strong class="mono">${CONFIRM_WORDS.no}</strong> to go back to NO. Not case-sensitive. Extremely
					consequence-sensitive.
				</p>
			</div>

			<div class="field">
				<label for="note">Public note <span class="muted">(optional)</span></label>
				<textarea
					id="note"
					name="note"
					rows="3"
					maxlength="${MAX_NOTE_LENGTH}"
					aria-describedby="note-hint"
					data-counter
				></textarea>
				<p class="hint" id="note-hint">
					<strong>This is public.</strong> It goes into the Dad Ledger (signed and hash-chained, so effectively
					forever), the update, every feed, and every email, push and webhook. No names, weights, photos, places or
					hospitals. Leave it blank for the standard line, e.g. "${STATUS_COPY.yes.ledgerNote}" Up to
					${MAX_NOTE_LENGTH} characters.
				</p>
			</div>

			<div class="grid" role="group" aria-label="Set the answer">
				${STATUS_BUTTONS.map(({ status, detail, className }) => {
					const current = status === state.status;
					return html`<button
						type="submit"
						name="status"
						value="${status}"
						class="${className}"
						data-confirm-word="${confirmWordFor(status)}"
						${current ? html`disabled data-current aria-describedby="status-current"` : ''}
						style="display:block;width:100%;min-height:7rem;padding:1rem;text-align:center"
					>
						<span style="display:block;font-size:2rem;font-weight:800;line-height:1.1">${STATUS_COPY[status].word}</span>
						<span style="display:block;margin-top:.35rem">${detail}</span>
						<span style="display:block;margin-top:.35rem" class="tiny"
							>${current ? 'Current answer' : html`Type <span class="mono">${confirmWordFor(status)}</span>`}</span
						>
					</button>`;
				})}
			</div>
			<p class="tiny muted" id="status-current">
				The button for the current answer is disabled: pressing it would change nothing, slowly.
			</p>
			<p class="tiny" aria-live="polite" data-armed></p>
		</form>

		<div class="stack">
			<h3>The 60-second undo window</h3>
			<p class="hint">
				A status change hits the site, the live viewers, the feeds and the Dad Ledger immediately. Notifications
				(email, push, webhooks, the DNS record) wait 60 seconds first. If the answer has changed again by then, they
				quietly stand down. So if you fat-finger YES, flip it straight back and nobody's phone buzzes. The ledger
				will still remember, because that's what ledgers are for.
			</p>
		</div>
	</section>`;
}

function ledgerHead(entries: LedgerEntry[] | null): Html {
	return html`<section class="card stack" aria-labelledby="ledger-h">
		<h2 id="ledger-h" class="card-title">Dad Ledger head</h2>
		${entries === null
			? html`<p class="notice notice-error">The ledger couldn't be read just now.</p>`
			: entries.length === 0
				? html`<p class="empty">The ledger is empty. It gets its genesis entry on the first status change.</p>`
				: html`<div class="table-wrap">
						<table class="table">
							<caption class="tiny muted" style="text-align:start">Newest first</caption>
							<thead>
								<tr>
									<th scope="col">Seq</th>
									<th scope="col">When</th>
									<th scope="col">Status</th>
									<th scope="col">Note</th>
									<th scope="col">Hash</th>
								</tr>
							</thead>
							<tbody>
								${entries.map(
									(e) => html`<tr>
										<td class="mono">${e.seq}</td>
										<td><time datetime="${e.at}">${formatLondon(e.at)}</time></td>
										<td>${statusBadge(e.status)}</td>
										<td>${e.note}</td>
										<td class="mono tiny" title="${e.hash}">${e.hash.slice(0, 16)}…</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`}
		<p class="tiny"><a href="/ledger">The whole ledger</a> · <a href="/.well-known/dad-ledger.json">JSON</a></p>
	</section>`;
}

function dueDateCard(state: SiteState, today: string): Html {
	const due = state.dueDate;
	return html`<section class="card stack" aria-labelledby="due-h">
		<h2 id="due-h" class="card-title">Due date</h2>
		<p>
			${due
				? html`Currently <strong>${formatLondonDate(due)}</strong>, ${relativeDays(daysBetween(today, due))}.`
				: html`<span class="muted">Not set. The countdown, the forecast and the fruit maths are sulking.</span>`}
		</p>
		<form method="post" action="/admin/due-date" class="form stack">
			<div class="field">
				<label for="due_date">Due date (Europe/London)</label>
				<input
					type="date"
					id="due_date"
					name="due_date"
					value="${due ?? ''}"
					min="${addDays(today, -366)}"
					max="${addDays(today, 366)}"
					aria-describedby="due-hint"
				/>
				<p class="hint" id="due-hint">
					Public: it drives the countdown, the forecast and the fruit-based size estimates. It's an estimate; the baby
					has not agreed to it.
				</p>
			</div>
			<div class="cluster">
				<button type="submit" name="action" value="set" class="btn btn-primary">Save due date</button>
				${due
					? html`<button type="submit" name="action" value="clear" class="btn btn-ghost" formnovalidate>
							Clear it
						</button>`
					: ''}
			</div>
		</form>
	</section>`;
}

function stat(value: string, label: string, detail?: Html | string): Html {
	return html`<div class="stat">
		<div class="stat-value">${value}</div>
		<div class="stat-label">${label}</div>
		${detail ? html`<div class="tiny muted">${detail}</div>` : ''}
	</div>`;
}

function statsSection(s: DashboardStats): Html {
	const confirmed = s.subscribersBig === null || s.subscribersDaily === null ? null : s.subscribersBig + s.subscribersDaily;
	return html`<section class="section stack" aria-labelledby="stats-h">
		<h2 id="stats-h">Numbers</h2>
		<div class="stats">
			${stat(fmt(confirmed), 'Confirmed subscribers', `${fmt(s.subscribersBig)} big news only · ${fmt(s.subscribersDaily)} daily`)}
			${stat(fmt(s.subscribersPending), 'Pending confirmation', 'Purged after 7 days')}
			${stat(fmt(s.subscribersUnsubscribed), 'Unsubscribed', 'No hard feelings')}
			${stat(fmt(s.push), 'Active push subscriptions')}
			${stat(fmt(s.webhooks), 'Active webhooks')}
			${stat(fmt(s.guesses), 'Pool guesses', s.guessesHidden ? `${fmt(s.guessesHidden)} hidden` : undefined)}
			${stat(fmt(s.wallPending), 'Wall messages to moderate', html`<a href="/admin/wall">Moderate</a>`)}
			${stat(fmt(s.namesPending), 'Name suggestions to moderate', html`<a href="/admin/names">Moderate</a>`)}
			${stat(fmt(s.checks), 'Total checks', 'Times someone asked')}
			${stat(fmt(s.viewers), 'Watching live right now')}
		</div>
	</section>`;
}

function deliveryCell(deliveries: DeliverySummary[] | null): Html {
	if (deliveries === null) return html`<span class="muted">unavailable</span>`;
	if (deliveries.length === 0) return html`<span class="muted">none yet</span>`;
	return html`<ul style="margin:0;padding-inline-start:1rem">
		${deliveries.map(
			(d) => html`<li>
				<span class="mono">${d.channel}</span>: ${fmt(Number(d.ok))} ok${Number(d.failed) > 0
					? html`, <strong>${fmt(Number(d.failed))} failed</strong>`
					: ''}
			</li>`,
		)}
	</ul>`;
}

function workflowCell(view: WorkflowView): Html {
	return html`<span class="pill">${view.status}</span>
		<span class="mono tiny" style="display:block">${view.id}</span>
		${view.error ? html`<span class="tiny" style="display:block">${view.error}</span>` : ''}`;
}

function updatesSection(views: UpdateView[]): Html {
	return html`<section class="section stack" aria-labelledby="updates-h">
		<h2 id="updates-h">Last ${RECENT_UPDATES} updates</h2>
		<p class="hint">
			Re-running notifications starts a fresh workflow instance for the update. Every delivery is logged per
			recipient, so re-runs only fill gaps: nobody hears the same news twice, however enthusiastically you click.
			Status updates still get the undo check, so re-running one the answer has since moved on from does nothing.
		</p>
		${views.length === 0
			? html`<p class="empty">No updates yet. The first one appears when the status changes or the daily post runs.</p>`
			: html`<div class="table-wrap">
					<table class="table">
						<thead>
							<tr>
								<th scope="col">#</th>
								<th scope="col">Update</th>
								<th scope="col">Audience</th>
								<th scope="col">Notified</th>
								<th scope="col">Deliveries</th>
								<th scope="col">Workflow</th>
								<th scope="col">Action</th>
							</tr>
						</thead>
						<tbody>
							${views.map(
								(v) => html`<tr>
									<td class="mono"><a href="/updates/${v.update.id}">${v.update.id}</a></td>
									<td>
										<strong>${v.update.title}</strong>
										<span class="tiny muted" style="display:block">
											${v.update.kind} · ${statusBadge(v.update.status)} ·
											<time datetime="${v.update.createdAt}">${formatLondon(v.update.createdAt)}</time>
										</span>
									</td>
									<td>${v.update.audience}</td>
									<td>
										${v.update.notifiedAt
											? html`<time datetime="${v.update.notifiedAt}">${formatLondon(v.update.notifiedAt)}</time>`
											: html`<span class="muted">not yet</span>`}
									</td>
									<td>${deliveryCell(v.deliveries)}</td>
									<td>
										${workflowCell(v.workflow)}
										${v.rerun
											? html`<span class="tiny" style="display:block;margin-top:.5rem">Re-run ${v.attempts}:</span>
													${workflowCell(v.rerun)}`
											: ''}
									</td>
									<td>
										${v.update.audience === 'none'
											? html`<span class="tiny muted">Audience "none": nobody to notify.</span>`
											: html`<form
													method="post"
													action="/admin/updates/${v.update.id}/rerun"
													data-confirm="Re-run notifications for update #${v.update.id}? Only recipients who haven't had it yet will get it."
												>
													<button type="submit" class="btn btn-ghost">Re-run notifications</button>
												</form>`}
									</td>
								</tr>`,
							)}
						</tbody>
					</table>
				</div>`}
	</section>`;
}

function toolsSection(env: Env, viewers: number | null): Html {
	return html`<section class="section stack" aria-labelledby="tools-h">
		<h2 id="tools-h">Buttons of lesser consequence</h2>
		<div class="grid">
			<form
				method="post"
				action="/admin/reload"
				class="card form stack"
				data-confirm="Force every open browser to reload? They'll lose their scroll position (and possibly their composure)."
			>
				<h3 class="card-title">Reload every browser</h3>
				<p class="hint">
					Sets a new reload nonce and tells every connected page to refresh itself. Handy after a deploy.
					${viewers === null ? '' : `${plural(viewers, 'browser')} connected right now.`}
				</p>
				<button type="submit" class="btn">Reload them all</button>
			</form>

			<form method="post" action="/admin/test-email" class="card form stack">
				<h3 class="card-title">Send a test email</h3>
				<div class="field">
					<label for="test-to">Address</label>
					<input id="test-to" name="to" type="email" required maxlength="254" autocomplete="email" />
					<p class="hint">One plain message from ${env.EMAIL_FROM || 'the configured sender'}. The address isn't stored.</p>
				</div>
				<button type="submit" class="btn">Send test</button>
			</form>

			<form method="post" action="/admin/og/render" class="card form stack">
				<h3 class="card-title">Re-render the social card</h3>
				<p class="hint">
					Browser Rendering screenshots the current card into <code>/og.png</code>. Takes a few seconds and a small
					amount of someone else's electricity.
				</p>
				<button type="submit" class="btn">Render /og.png</button>
			</form>

			<form method="post" action="/admin/dns/sync" class="card form stack">
				<h3 class="card-title">Sync the DNS answer</h3>
				<p class="hint">
					Upserts the TXT record ${env.DNS_RECORD_NAME ? html`<code>${env.DNS_RECORD_NAME}</code>` : '(none configured)'}
					so <code>dig TXT</code> knows too.
					${env.DNS_API_TOKEN ? '' : html`<strong>No DNS_API_TOKEN, so this will politely skip.</strong>`}
				</p>
				<button type="submit" class="btn">Sync DNS</button>
			</form>
		</div>
	</section>`;
}

function onOff(on: boolean, onText = 'On', offText = 'Off'): Html {
	return on ? html`<span class="pill">✓ ${onText}</span>` : html`<span class="pill">✗ ${offText}</span>`;
}

function configSection(c: Ctx, sessionExp: number | null): Html {
	const env = c.env;
	const version = env.CF_VERSION;
	return html`<section class="section stack" aria-labelledby="config-h">
		<h2 id="config-h">Configuration</h2>
		<div class="table-wrap">
			<table class="table">
				<thead>
					<tr>
						<th scope="col">Thing</th>
						<th scope="col">State</th>
						<th scope="col">Notes</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">Turnstile</th>
						<td>${onOff(turnstileEnabled(env), 'Configured', 'Not configured')}</td>
						<td class="tiny">
							${turnstileEnabled(env)
								? 'Public forms show the Turnstile widget and verify it server-side.'
								: 'Public forms rely on rate limits alone. Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY to add the robot check.'}
						</td>
					</tr>
					<tr>
						<th scope="row">DNS token</th>
						<td>${onOff(Boolean(env.DNS_API_TOKEN), 'Configured', 'Not configured')}</td>
						<td class="tiny">
							Record: ${env.DNS_RECORD_NAME ? html`<code>${env.DNS_RECORD_NAME}</code>` : 'none'} · Zone:
							${env.DNS_ZONE_ID ? 'id override set' : html`looked up from <code>${env.ZONE_NAME}</code>`}
						</td>
					</tr>
					<tr>
						<th scope="row">Email sender</th>
						<td><code>${env.EMAIL_FROM}</code></td>
						<td class="tiny">${env.EMAIL_FROM_NAME}</td>
					</tr>
					<tr>
						<th scope="row">Environment</th>
						<td><code>${env.ENVIRONMENT}</code></td>
						<td class="tiny">${siteUrl(env)}</td>
					</tr>
					<tr>
						<th scope="row">Version</th>
						<td><code>${version?.id ? version.id.slice(0, 8) : 'unknown'}</code></td>
						<td class="tiny">
							${version?.tag ? html`Tag <code>${version.tag}</code> · ` : ''}${version?.timestamp
								? html`uploaded ${formatLondon(version.timestamp)}`
								: 'no upload timestamp'}
						</td>
					</tr>
					<tr>
						<th scope="row">Your session</th>
						<td><code>${adminCookieName(c.req.url)}</code></td>
						<td class="tiny">
							${sessionExp
								? html`Expires ${formatLondon(new Date(sessionExp * 1000).toISOString())}.`
								: `Lasts ${SESSION_TTL_SECONDS / 86_400} days.`}
							Changing ADMIN_PASSWORD logs everyone out.
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<form
			method="post"
			action="/admin/logout"
			class="cluster"
			data-confirm="Log out every admin session on every device, including this one?"
		>
			<input type="hidden" name="everywhere" value="1" />
			<button type="submit" class="btn btn-ghost">Log out everywhere</button>
			<span class="hint">Lost a phone? This voids every session without changing the password.</span>
		</form>
	</section>`;
}

// ─── Login / logout ─────────────────────────────────────────────────────────

function renderDisabled(c: Ctx): Promise<Response> {
	if (wantsJson(c)) return Promise.resolve(c.json({ ok: false, error: 'Admin is disabled (no ADMIN_PASSWORD set)' }, 503));
	return renderAdminPublicPage(c, {
		title: 'Admin disabled',
		status: 503,
		body: html`<header class="page-head">
				<p class="kicker">Admin</p>
				<h1>Admin is switched off</h1>
				<p class="lede">
					No ADMIN_PASSWORD is set, so there's no big red button to press. This is the safest possible configuration,
					and also the least useful.
				</p>
			</header>
			<div class="card stack">
				<p>To switch it on, set the secret and come back:</p>
				<pre class="code">npx wrangler secret put ADMIN_PASSWORD</pre>
				<p class="hint">For local development, put <code>ADMIN_PASSWORD=…</code> in <code>.dev.vars</code>.</p>
			</div>`,
	});
}

/** The only notices the public login page will show: fixed copy, picked by ?done=. */
const LOGIN_DONE: Readonly<Record<string, string>> = {
	'logged-out': 'Logged out. The big red button is safe from you for now.',
	'logged-out-everywhere': 'Logged out everywhere. Every admin session on every device is now void.',
};

function loginNotice(c: Ctx) {
	const done = c.req.query('done');
	if (!done || !Object.hasOwn(LOGIN_DONE, done)) return '';
	return html`<div class="notice notice-ok" role="status"><p>${LOGIN_DONE[done]}</p></div>`;
}

function renderLogin(
	c: Ctx,
	opts: { next: string; error?: string; status?: number; crossSite?: boolean },
): Promise<Response> {
	return renderAdminPublicPage(c, {
		title: 'Log in',
		status: opts.status,
		turnstile: turnstileEnabled(c.env),
		body: html`<header class="page-head">
				<p class="kicker">Admin</p>
				<h1>Authorised parents only</h1>
				<p class="lede">
					This is where the big red button lives. If you're not Jess or Zack, the rest of the site is much more fun.
				</p>
			</header>
			${loginNotice(c)}
			${opts.error ? html`<div class="notice notice-error" role="alert"><p>${opts.error}</p></div>` : ''}
			${opts.crossSite
				? html`<div class="notice" role="status">
						<p>
							Arrived from a link on another site? The admin cookie is SameSite=Strict, so it stayed at home. If
							you're already logged in, <a href="${opts.next}">carry on to the admin panel</a>.
						</p>
					</div>`
				: ''}
			<form method="post" action="/admin/login" class="card form stack" style="max-width:28rem">
				<input type="hidden" name="next" value="${opts.next}" />
				<div class="field">
					<label for="password">Password</label>
					<input
						id="password"
						name="password"
						type="password"
						required
						maxlength="${MAX_PASSWORD_LENGTH}"
						autocomplete="current-password"
						autofocus
					/>
				</div>
				${turnstileWidget(c.env)}
				<button type="submit" class="btn btn-primary">Log in</button>
				<p class="hint">Sessions last ${SESSION_TTL_SECONDS / 86_400} days. Wrong guesses are rate limited.</p>
			</form>`,
	});
}

adminRoutes.get('/login', async (c) => {
	if (!adminEnabled(c.env)) return renderDisabled(c);
	const next = safeNextPath(c.req.query('next'));
	if (await isAdmin(c)) return c.redirect(next, 303);
	// SameSite=Strict cookies aren't sent on navigations that start on another site, so a
	// logged-in admin following a link from (say) an email lands here. A same-site link fixes it.
	const crossSite = (c.req.header('sec-fetch-site') ?? '').toLowerCase() === 'cross-site';
	return renderLogin(c, { next, crossSite });
});

adminRoutes.post('/login', async (c) => {
	if (!adminEnabled(c.env)) return renderDisabled(c);
	if (!sameOrigin(c)) return crossSiteRefused(c);

	const form = await readForm(c);
	const next = safeNextPath(form.next);
	const fail = (error: string, status: ContentfulStatusCode) =>
		wantsJson(c) ? c.json({ ok: false, error }, status) : renderLogin(c, { next, error, status });

	if (!(await allow(c.env.RL_FORMS, `admin-login:${clientKey(c)}`))) {
		return fail('Too many attempts. Have a cup of tea and try again in a minute.', 429);
	}
	if (!(await verifyTurnstile(c.env, form['cf-turnstile-response'], clientIp(c)))) {
		return fail('The robot check failed. Please try again.', 400);
	}
	if (!(await passwordMatches(c.env.ADMIN_PASSWORD, form.password))) {
		return fail("That's not the password.", 401);
	}

	await startSession(c);
	if (wantsJson(c)) return c.json({ ok: true, next });
	return c.redirect(next, 303);
});

adminRoutes.post('/logout', async (c) => {
	if (!sameOrigin(c)) return crossSiteRefused(c);
	const form = await readForm(c);
	let done = 'logged-out';
	if (form.everywhere === '1' && (await isAdmin(c))) {
		await endAllSessions(c.env);
		done = 'logged-out-everywhere';
	}
	endSession(c);
	if (wantsJson(c)) return c.json({ ok: true, message: LOGIN_DONE[done] });
	return c.redirect(`/admin/login?done=${done}`, 303);
});

// ─── Dashboard ──────────────────────────────────────────────────────────────

adminRoutes.get('/', requireAdmin, async (c) => {
	const env = c.env;
	const now = Date.now();
	const today = londonDate();
	const [state, stats, updates, ledger] = await Promise.all([
		getState(env, { fresh: true }),
		loadStats(env),
		loadUpdates(env),
		loadLedgerHead(env),
	]);

	if (wantsJson(c)) {
		return c.json({
			state,
			stats,
			updates: updates.map((v) => ({
				id: v.update.id,
				kind: v.update.kind,
				title: v.update.title,
				audience: v.update.audience,
				createdAt: v.update.createdAt,
				notifiedAt: v.update.notifiedAt,
				deliveries: v.deliveries,
				workflow: v.workflow,
				reruns: v.attempts,
				rerun: v.rerun,
			})),
			ledger,
			config: { turnstile: turnstileEnabled(env), dnsToken: Boolean(env.DNS_API_TOKEN) },
		});
	}

	return renderAdminPage(c, {
		title: 'Dashboard',
		body: html`<header class="page-head">
				<p class="kicker">Mission control</p>
				<h1>Dashboard</h1>
				<p class="lede">
					Every inbox, phone, browser tab, webhook, DNS resolver and social card that cares whether Zack is a dad
					is waiting on the form below. No pressure.
				</p>
			</header>
			${adminFlash(c)} ${bigRedButton(state, now)}
			<div class="grid">${dueDateCard(state, today)} ${ledgerHead(ledger)}</div>
			${statsSection(stats)} ${updatesSection(updates)} ${toolsSection(env, stats.viewers)}
			${configSection(c, currentSessionExpiry(c))}`,
	});
});

// ─── Actions ────────────────────────────────────────────────────────────────

/** Normalise a public note: unify newlines, drop control characters, trim. */
function cleanNote(value: string | undefined): string {
	return (value ?? '')
		.replace(/\r\n?/g, '\n')
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
		.trim();
}

adminRoutes.post(
	'/status',
	requireAdmin,
	action('Status change', async (c) => {
		const form = await readForm(c);
		const status = form.status;
		if (!isStatus(status)) return respond(c, false, `Pick one of ${STATUSES.map((s) => STATUS_COPY[s].word).join(', ')}.`);

		const word = confirmWordFor(status);
		if (!confirmMatches(status, form.confirm)) {
			const typed = normaliseConfirmWord(form.confirm);
			return respond(
				c,
				false,
				typed
					? `To press ${STATUS_COPY[status].word}, type ${word}. You typed "${typed.slice(0, 16)}". Nothing changed.`
					: `To press ${STATUS_COPY[status].word}, type ${word} in the confirmation box first. Nothing changed.`,
				{ status: 422 },
			);
		}

		const note = cleanNote(form.note);
		if (note.length > MAX_NOTE_LENGTH) {
			return respond(c, false, `The note is ${note.length} characters; the limit is ${MAX_NOTE_LENGTH}. Nothing changed.`, {
				status: 422,
			});
		}

		const result = await setStatus(c.env, status, { note: note || undefined });
		if (!result) {
			return respond(c, true, `It was already ${STATUS_COPY[status].word}. Nothing happened, very efficiently.`, {
				data: { changed: false },
			});
		}
		return respond(
			c,
			true,
			`The answer is now ${STATUS_COPY[status].word}. Update #${result.update.id} is out; notifications follow in 60 seconds unless you flip it back.`,
			{ data: { changed: true, state: result.state, updateId: result.update.id } },
		);
	}),
);

adminRoutes.post(
	'/due-date',
	requireAdmin,
	action('Due date', async (c) => {
		const form = await readForm(c);
		if (form.action === 'clear') {
			const cleared = await setDueDate(c.env, null);
			// The DNS TXT record carries `due=`; keep it in step (never throws, skips without a token).
			await updateAnswerRecord(c.env, cleared);
			return respond(c, true, 'Due date cleared. The baby will arrive when the baby arrives.', { data: { dueDate: null } });
		}
		const value = (form.due_date ?? '').trim();
		if (!value) return respond(c, false, 'Pick a date first (or press "Clear it").');
		if (!isYmd(value)) return respond(c, false, 'That date needs to be a real date in YYYY-MM-DD form.', { status: 422 });
		const today = londonDate();
		if (Math.abs(daysBetween(today, value)) > 366) {
			return respond(c, false, "That's more than a year away from today. Gestation doesn't work like that.", {
				status: 422,
			});
		}
		const state = await setDueDate(c.env, value);
		await updateAnswerRecord(c.env, state); // never throws; skips without a token
		return respond(c, true, `Due date set to ${formatLondonDate(value)} (${relativeDays(daysBetween(today, value))}).`, {
			data: { dueDate: state.dueDate },
		});
	}),
);

adminRoutes.post(
	'/reload',
	requireAdmin,
	action('Reload', async (c) => {
		const { viewers } = await liveStats(c.env);
		const nonce = randomToken(8);
		await setSetting(c.env, 'reload_nonce', nonce);
		await broadcast(c.env, { type: 'reload', nonce });
		return respond(c, true, `Reload sent (nonce ${nonce}). ${plural(viewers, 'open browser')} should refresh now.`, {
			data: { nonce, viewers },
		});
	}),
);

const EMAIL_ERROR_HINTS: Record<string, string> = {
	no_api_key: "RESEND_API_KEY isn't set on the Worker.",
	missing_api_key: "Resend didn't get an API key. RESEND_API_KEY isn't set on the Worker.",
	restricted_api_key: 'The Resend API key is invalid or restricted. Check it on resend.com/api-keys.',
	suspended_api_key: 'The Resend API key is suspended. Check it on resend.com/api-keys.',
	validation_error: 'Resend rejected the message as invalid (check the sender domain is verified).',
	daily_quota_exceeded: 'The daily send quota is used up. Try again tomorrow.',
	quota_reserve: "Only the emails kept in reserve for real news are left today, and this isn't news. Try again tomorrow.",
	invalid_idempotent_request: 'Resend saw this exact send recently with different content and refused it. Try again in a minute.',
	rate_limit_exceeded: 'Resend rate limit hit. Try again shortly.',
};

adminRoutes.post(
	'/test-email',
	requireAdmin,
	action('Test email', async (c) => {
		const form = await readForm(c);
		const to = (form.to ?? '').trim();
		if (!isValidEmail(to)) return respond(c, false, "That doesn't look like an email address.", { status: 422 });
		if (!(await allow(c.env.RL_EMAIL, 'admin-test-email'))) {
			return respond(c, false, 'Easy, tiger. Test emails are rate limited; try again in a minute.', { status: 429 });
		}
		const state = c.get('state');
		const result = await sendTestEmail(c.env, to, state);
		if (result.ok) {
			return respond(c, true, `Test email sent. Message id: ${result.messageId || 'not reported'}.`, {
				data: { messageId: result.messageId },
			});
		}
		console.error('admin test email failed:', result.code, result.detail);
		const hint = result.code ? EMAIL_ERROR_HINTS[result.code] : undefined;
		return respond(c, false, `Test email not sent: ${result.code ?? 'error'}. ${hint ?? result.detail ?? 'unknown error'}`, {
			status: 502,
			data: { code: result.code },
		});
	}),
);

adminRoutes.post(
	'/updates/:id{[0-9]+}/rerun',
	requireAdmin,
	action('Re-run', async (c) => {
		const id = Number(c.req.param('id'));
		if (!Number.isSafeInteger(id) || id <= 0) return respond(c, false, 'No such update.', { status: 404 });
		const update = await getUpdate(c.env, id);
		if (!update) return respond(c, false, `There's no update #${id}.`, { status: 404 });
		if (update.audience === 'none') {
			return respond(c, false, `Update #${id} has audience "none", so there's nobody to notify.`, { status: 409 });
		}
		const attempt = await nextRerunAttempt(c.env, id);
		const instanceId = await startAnnouncement(c.env, id, attempt);
		const workflow = await workflowStatus(c.env, instanceId);
		if (workflow.status === 'not found') {
			return respond(c, false, `Re-run ${attempt} for update #${id} didn't start (workflow ${instanceId} not found).`, {
				status: 502,
				data: { attempt, instanceId },
			});
		}
		return respond(c, true, `Re-running notifications for update #${id}: workflow ${instanceId} is ${workflow.status}.`, {
			data: { attempt, instanceId, workflow },
		});
	}),
);

adminRoutes.post(
	'/og/render',
	requireAdmin,
	action('OG render', async (c) => {
		// Browser Rendering limits are shared across the account; one session can't hog them.
		if (!(await allow(c.env.RL_EMAIL, 'admin-og-render'))) {
			return respond(c, false, 'The social card was rendered moments ago. Give the headless browser a minute.', { status: 429 });
		}
		const result = await renderOgImage(c.env);
		const detail = result.detail ? ` (${result.detail})` : '';
		return result.ok
			? respond(c, true, `Social card re-rendered${detail}.`, { data: { result } })
			: respond(c, false, `Social card render failed${detail}.`, { status: 502, data: { result } });
	}),
);

adminRoutes.post(
	'/dns/sync',
	requireAdmin,
	action('DNS sync', async (c) => {
		const state = await getState(c.env, { fresh: true });
		const result = await updateAnswerRecord(c.env, state);
		const detail = result.detail ? ` (${result.detail})` : '';
		return result.ok
			? respond(c, true, `DNS answer synced to ${STATUS_COPY[state.status].word}${detail}.`, { data: { result } })
			: respond(c, false, `DNS sync failed${detail}.`, { status: 502, data: { result } });
	}),
);
