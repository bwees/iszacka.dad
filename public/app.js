// iszacka.dad client. An ES module with no dependencies, loaded on every page.
//
// Everything here is progressive enhancement: the server already rendered the
// answer. This file keeps it live (WebSocket, falling back to polling), adds the
// toys (vibes, drumroll, speech, confetti) and no-ops cleanly on any page that
// lacks the relevant elements.

const doc = document;
const root = doc.documentElement;
const $ = (selector, scope = doc) => scope.querySelector(selector);
const $$ = (selector, scope = doc) => Array.from(scope.querySelectorAll(selector));

const STATUSES = ['no', 'soon', 'yes'];
const isStatus = (value) => STATUSES.includes(value);
const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const reducedMotion = () => Boolean(motionQuery && motionQuery.matches);
const numberFormat = new Intl.NumberFormat('en-GB');
const STORAGE_PREFIX = 'iszackadad:';

function readJson(id) {
	const el = doc.getElementById(id);
	if (!el) return null;
	try {
		return JSON.parse(el.textContent || 'null');
	} catch {
		return null;
	}
}

function storageGet(key) {
	try {
		return window.localStorage.getItem(STORAGE_PREFIX + key);
	} catch {
		return null;
	}
}

function storageSet(key, value) {
	try {
		window.localStorage.setItem(STORAGE_PREFIX + key, value);
	} catch {
		/* private mode or storage disabled: fine */
	}
}

const site = readJson('site-copy') || {
	siteName: 'Is Zack a Dad?',
	copy: {
		no: { word: 'NO', short: 'No.', headline: 'Zack is not a dad.', sentence: 'Zack is not a dad. Yet.', emoji: '🥚', header: 'no' },
		soon: { word: 'NOT YET', short: 'Not yet.', headline: "It's happening.", sentence: "It's happening right now.", emoji: '🐣', header: 'not yet (it is happening)' },
		yes: { word: 'YES', short: 'Yes!', headline: 'Zack is a dad!', sentence: 'Zack is a dad!', emoji: '👶', header: 'yes' },
	},
};

/** What this tab currently believes. Seeded from the server render. */
const state = {
	status: isStatus(root.dataset.status) ? root.dataset.status : 'no',
	statusChangedAt: root.dataset.changedAt || '',
	dueDate: root.dataset.dueDate || null,
};
const isHome = root.dataset.page === 'home';
const titleBase = root.dataset.titleBase || doc.title;

// ─── Accessibility: one polite live region for everything ───────────────────

let announceTimer = 0;
function announce(text) {
	const region = $('[data-announcer]');
	if (!region || !text) return;
	region.textContent = '';
	clearTimeout(announceTimer);
	// A fresh text node after a tick makes screen readers re-announce identical text.
	announceTimer = window.setTimeout(() => {
		region.textContent = text;
	}, 80);
}

// ─── Time helpers (mirror src/routes/pages.ts) ──────────────────────────────

const LONDON_YMD = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const LONDON_HOUR = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' });
const LONDON_LONG_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const LONDON_SHORT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const LONDON_FULL = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const isYmd = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const ymdToUtc = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
const daysBetween = (from, to) => Math.round((ymdToUtc(to) - ymdToUtc(from)) / 86_400_000);
const londonMidnight = (ymd) => {
	const guess = ymdToUtc(ymd);
	return guess - (Number(LONDON_HOUR.format(new Date(guess))) % 24) * 3_600_000;
};
const pad2 = (n) => String(n).padStart(2, '0');

function formatDuration(ms) {
	const total = Math.max(0, Math.floor(ms / 1000));
	const d = Math.floor(total / 86_400);
	const h = Math.floor((total % 86_400) / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return `${d > 0 ? `${d}d ` : ''}${pad2(h)}h ${pad2(m)}m ${pad2(s)}s`;
}

function countdown(now) {
	const changed = Date.parse(state.statusChangedAt);
	const since = Number.isNaN(changed) ? 0 : now - changed;
	if (state.status === 'yes') {
		return { label: 'Dad for', value: formatDuration(since), note: 'and counting. Sleep last seen at around the same time.' };
	}
	if (state.status === 'soon') {
		return { label: 'Labour in progress for', value: formatDuration(since), note: 'Updates the moment there is one. Please stop asking Zack.' };
	}
	if (!isYmd(state.dueDate)) {
		return { label: 'Due date', value: 'Classified', note: 'No due date on file, so the countdown is standing by.' };
	}
	const days = daysBetween(LONDON_YMD.format(new Date(now)), state.dueDate);
	const dueText = LONDON_LONG_DATE.format(new Date(`${state.dueDate}T12:00:00Z`));
	const midnight = londonMidnight(state.dueDate);
	if (days > 0) {
		return { label: 'T-minus', value: formatDuration(midnight - now), note: `until the due date, ${dueText}. Due dates are, famously, suggestions.` };
	}
	if (days === 0) {
		return { label: 'Due today', value: formatDuration(now - midnight), note: 'into the due date. Any minute now. Or not.' };
	}
	const overdue = -days;
	return {
		label: `${overdue} ${overdue === 1 ? 'day' : 'days'} overdue`,
		value: formatDuration(now - midnight),
		note: `since the due date (${dueText}). The baby is clearly running on Zack's schedule.`,
	};
}

function tickClocks() {
	const clocks = $$('[data-clock]');
	if (!clocks.length) return;
	const c = countdown(Date.now());
	for (const clock of clocks) {
		const label = $('[data-clock-label]', clock);
		const value = $('[data-clock-value]', clock);
		const note = $('[data-clock-note]', clock);
		if (label && label.textContent !== c.label) label.textContent = c.label;
		if (value) value.textContent = c.value;
		if (note && note.textContent !== c.note) note.textContent = c.note;
	}
}

const LOCAL_ASOF = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
let lastSync = 0;

function tickAsOf() {
	const els = $$('[data-asof]');
	if (!els.length) return;
	// Only claim "now" while the feed has proved itself recently: a half-open socket still
	// reports OPEN, so "connected" alone isn't proof.
	const fresh = live.connected && navigator.onLine && Date.now() - live.lastFrameAt <= PING_MS * 2 + 5000;
	const at = fresh ? Date.now() : Math.max(live.lastFrameAt, lastSync);
	if (!at) return;
	const d = new Date(at);
	for (const el of els) {
		el.dateTime = d.toISOString();
		el.textContent = LOCAL_ASOF.format(d);
	}
}

function renderLocalTimes() {
	const els = $$('[data-local-time]');
	if (!els.length) return;
	let zone = '';
	try {
		zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
	} catch {
		zone = '';
	}
	const local = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
	for (const el of els) {
		const iso = el.getAttribute('data-local-time') || state.statusChangedAt;
		const t = Date.parse(iso);
		if (Number.isNaN(t) || t <= 0) {
			el.textContent = '';
			continue;
		}
		el.textContent =
			zone === 'Europe/London'
				? ', which is also your time zone, as it happens'
				: `, which is ${local.format(new Date(t))} where you are${zone ? ` (${zone.replace(/_/g, ' ')})` : ''}`;
	}
}

// ─── Applying a new state ───────────────────────────────────────────────────

function renderAnswer(el, word) {
	const words = word.split(' ');
	el.replaceChildren(
		...words.flatMap((w, i) => {
			const span = doc.createElement('span');
			span.className = 'answer-word';
			span.textContent = w;
			return i > 0 ? [doc.createTextNode(' '), span] : [span];
		}),
	);
	revealAnswer(el);
}

function revealAnswer(el) {
	if (!el || reducedMotion()) return;
	el.classList.remove('is-revealing');
	void el.offsetWidth; // restart the animation
	el.classList.add('is-revealing');
	el.addEventListener('animationend', () => el.classList.remove('is-revealing'), { once: true });
}

function updateFavicon() {
	const link = $('link[data-favicon]');
	if (!link) return;
	const href = `/favicon-${state.status}.svg`;
	if (link.getAttribute('href') === href) return;
	// Some browsers only notice a favicon change when the <link> is replaced.
	const fresh = link.cloneNode();
	fresh.setAttribute('href', href);
	link.replaceWith(fresh);
}

function updateThemeColour() {
	const colour = getComputedStyle(root).getPropertyValue('--hero-bg').trim();
	if (!colour) return;
	const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
	const meta = $(`meta[name="theme-color"][media*="${dark ? 'dark' : 'light'}"]`) || $('meta[name="theme-color"]');
	if (meta) meta.setAttribute('content', colour);
}

function updateTitle(changed) {
	const copy = site.copy[state.status];
	if (!copy) return;
	if (isHome) doc.title = `${site.siteName} ${copy.short}`;
	else if (changed) doc.title = `${copy.emoji} ${copy.word} · ${titleBase}`;
}

function applyState(next) {
	if (!next || typeof next !== 'object' || !isStatus(next.status)) return;
	const previous = state.status;
	state.status = next.status;
	if (typeof next.statusChangedAt === 'string') state.statusChangedAt = next.statusChangedAt;
	state.dueDate = isYmd(next.dueDate) ? next.dueDate : null;
	const changed = previous !== state.status;

	root.dataset.status = state.status;
	if (doc.body) doc.body.dataset.status = state.status;
	root.dataset.changedAt = state.statusChangedAt;
	root.dataset.dueDate = state.dueDate || '';

	const copy = site.copy[state.status];
	if (copy) {
		for (const el of $$('[data-live="word"]')) el.textContent = copy.word;
		for (const el of $$('[data-live="short"]')) el.textContent = copy.short;
		for (const el of $$('[data-live="sentence"]')) el.textContent = copy.sentence;
		for (const el of $$('[data-live="headline"]')) el.textContent = copy.headline;
		if (changed) for (const el of $$('[data-live="answer"]')) renderAnswer(el, copy.word);
	}
	for (const el of $$('[data-by-status]')) {
		const value = el.getAttribute(`data-${state.status}`);
		if (value !== null && el.textContent !== value) el.textContent = value;
	}
	for (const el of $$('[data-live-badge]')) {
		el.classList.remove('badge-no', 'badge-soon', 'badge-yes');
		el.classList.add(`badge-${state.status}`);
	}
	// Server-rendered panels with one block per status (forecast, fruit): show the current one.
	for (const el of $$('[data-status-variant]')) el.hidden = el.dataset.statusVariant !== state.status;
	// "The answer last changed …": the server rendered the old time.
	const changedAt = Date.parse(state.statusChangedAt);
	if (!Number.isNaN(changedAt)) {
		for (const el of $$('[data-live-changed-at]')) {
			if (el.getAttribute('datetime') === state.statusChangedAt) continue;
			el.setAttribute('datetime', state.statusChangedAt);
			el.textContent = LONDON_FULL.format(new Date(changedAt));
		}
	}

	updateFavicon();
	updateTitle(changed);
	updateThemeColour();
	tickClocks();
	renderLocalTimes();

	if (changed && copy) {
		announce(`The answer has changed. ${copy.sentence}`);
		if (state.status === 'yes') celebrate();
	}
}

// ─── Live counters ──────────────────────────────────────────────────────────

function setCount(name, value) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
	const text = numberFormat.format(Math.floor(value));
	for (const el of $$(`[data-live="${name}"]`)) el.textContent = text;
	for (const el of $$(`[data-plural="${name}"]`)) {
		const form = Math.floor(value) === 1 ? el.dataset.one : el.dataset.other;
		if (form) el.textContent = form;
	}
}

// ─── The live connection: WebSocket, with polling as the fallback ───────────

const PING_MS = 25_000;
const POLL_MS = 30_000;

const live = {
	ws: null,
	connected: false,
	retry: 0,
	failures: 0,
	reconnectTimer: 0,
	pingTimer: 0,
	stableTimer: 0,
	paused: false,
	pollTimer: 0,
	bootNonce: null,
	outbox: [],
	/** When the last frame (any message, pong included) arrived: proof the socket is alive. */
	lastFrameAt: 0,
	/** When the last ping went out; no frame since then by the next one means a dead socket. */
	pingSentAt: 0,
	probeTimer: 0,
};

const CONN_TEXT = {
	connecting: { hero: 'connecting to the live feed…', panel: 'Telemetry: acquiring signal' },
	live: { hero: 'live', panel: 'Telemetry: live' },
	polling: { hero: 'checking every 30 seconds', panel: 'Telemetry: polling every 30s' },
	offline: { hero: 'offline, showing the last known answer', panel: 'Telemetry: offline' },
};

function setConn(mode) {
	if (root.dataset.conn === mode) return;
	root.dataset.conn = mode;
	const text = CONN_TEXT[mode];
	for (const el of $$('[data-conn-text]')) el.textContent = text.hero;
	for (const el of $$('[data-conn-label]')) el.textContent = text.panel;
}

function send(msg) {
	if (live.ws && live.ws.readyState === WebSocket.OPEN) {
		try {
			live.ws.send(JSON.stringify(msg));
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

function connect() {
	clearTimeout(live.reconnectTimer);
	if (!('WebSocket' in window)) {
		startPolling();
		return;
	}
	if (live.ws && (live.ws.readyState === WebSocket.OPEN || live.ws.readyState === WebSocket.CONNECTING)) return;

	const url = new URL('/ws', window.location.href);
	url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	let ws;
	try {
		ws = new WebSocket(url.href);
	} catch {
		live.failures++;
		scheduleReconnect();
		return;
	}
	live.ws = ws;
	let opened = false;
	if (!live.connected && !live.pollTimer) setConn('connecting');

	ws.addEventListener('open', () => {
		if (live.ws !== ws) return;
		opened = true;
		live.connected = true;
		live.failures = 0;
		live.lastFrameAt = Date.now();
		live.pingSentAt = 0;
		// Only forgive the backoff once the socket has proved stable, so a server that accepts
		// and immediately drops connections can't put every tab into a one-second reconnect loop.
		clearTimeout(live.stableTimer);
		live.stableTimer = window.setTimeout(() => {
			live.retry = 0;
		}, 15_000);
		stopPolling();
		setConn('live');
		clearInterval(live.pingTimer);
		live.pingTimer = window.setInterval(pingTick, PING_MS);
		while (live.outbox.length) send(live.outbox.shift());
		tickAsOf();
	});
	ws.addEventListener('message', (event) => {
		if (live.ws !== ws) return;
		// Any frame proves the socket is alive (a pong included), before anything is parsed.
		live.lastFrameAt = Date.now();
		if (live.connected && root.dataset.conn !== 'live') setConn('live');
		if (typeof event.data !== 'string' || event.data.length > 100_000) return;
		let msg;
		try {
			msg = JSON.parse(event.data);
		} catch {
			return;
		}
		handleMessage(msg);
	});
	ws.addEventListener('close', () => {
		// A socket already dropped as dead can report its close minutes later: by then a new
		// socket owns the timers and the state, so leave them alone.
		if (live.ws !== ws) return;
		clearInterval(live.pingTimer);
		clearTimeout(live.stableTimer);
		clearTimeout(live.probeTimer);
		live.ws = null;
		if (live.connected) lastSync = live.lastFrameAt || Date.now();
		live.connected = false;
		if (!opened) live.failures++;
		scheduleReconnect();
	});
	// 'error' is always followed by 'close', which does the work.
}

/** Every PING_MS: if the last ping got nothing back, the socket is dead; else ping again. */
function pingTick() {
	if (live.pingSentAt && live.lastFrameAt < live.pingSentAt) {
		dropDeadSocket(false);
		return;
	}
	live.pingSentAt = Date.now();
	send({ type: 'ping' });
}

/**
 * Give up on a socket that has stopped delivering (half-open after a network change or sleep:
 * browsers can take many minutes to notice). Don't wait for its 'close'.
 */
function dropDeadSocket(now) {
	const old = live.ws;
	if (!old) return;
	lastSync = live.lastFrameAt || lastSync;
	live.connected = false;
	live.ws = null;
	live.pingSentAt = 0;
	clearInterval(live.pingTimer);
	clearTimeout(live.stableTimer);
	clearTimeout(live.probeTimer);
	try {
		old.close(4000, 'stale');
	} catch {
		/* already closing */
	}
	tickAsOf();
	if (now) reconnectNow();
	else scheduleReconnect();
}

/** Back online, or back in view: make sure the socket still answers, within 5 seconds. */
function probe() {
	const ws = live.ws;
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		if (!ws) reconnectNow();
		return;
	}
	const sent = Date.now();
	send({ type: 'ping' });
	clearTimeout(live.probeTimer);
	live.probeTimer = window.setTimeout(() => {
		if (live.ws === ws && live.lastFrameAt < sent) dropDeadSocket(true);
	}, 5000);
}

function scheduleReconnect() {
	clearTimeout(live.reconnectTimer);
	if (live.paused) return;
	if (!navigator.onLine) {
		setConn('offline');
		return; // the 'online' event reconnects
	}
	// WebSockets keep failing (proxy, firewall, ancient browser)? Poll meanwhile, keep trying.
	if (live.failures >= 2) startPolling();
	else if (!live.pollTimer) setConn('connecting');
	const base = Math.min(60_000, 1000 * 2 ** live.retry);
	live.retry = Math.min(live.retry + 1, 8);
	live.reconnectTimer = window.setTimeout(connect, base * (0.75 + Math.random() * 0.5));
}

function reconnectNow() {
	live.paused = false;
	live.retry = 0;
	connect();
}

function startPolling() {
	if (live.pollTimer) return;
	setConn('polling');
	live.pollTimer = window.setInterval(pollOnce, POLL_MS);
	pollOnce();
}

function stopPolling() {
	clearInterval(live.pollTimer);
	live.pollTimer = 0;
}

async function pollOnce() {
	if (doc.hidden || live.connected) return;
	try {
		const res = await fetch('/api/live', { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		if (data && typeof data === 'object') {
			// /api/live may carry only counters. Every response also carries the answer in the
			// X-Is-Zack-A-Dad header, so a flip is never missed (and polling never counts as a check).
			if (!data.state) {
				const status = statusFromHeader(res.headers.get('x-is-zack-a-dad'));
				if (status && status !== state.status) {
					applyState({ status, statusChangedAt: new Date().toISOString(), dueDate: state.dueDate });
				}
			}
			handleSnapshot(data);
		}
		lastSync = Date.now();
		tickAsOf();
		if (!live.connected) setConn('polling');
	} catch {
		if (!live.connected) setConn(navigator.onLine ? 'polling' : 'offline');
	}
}

function statusFromHeader(value) {
	if (!value) return null;
	const v = value.trim().toLowerCase();
	return STATUSES.find((s) => site.copy[s] && String(site.copy[s].header || '').toLowerCase() === v) || null;
}

/** A full snapshot: the WebSocket `hello`, or a /api/live poll response. */
function handleSnapshot(data) {
	if (data.state) applyState(data.state);
	setCount('viewers', data.viewers);
	setCount('vibes', data.vibes);
	setCount('checks', data.checks);
	if (typeof data.reloadNonce === 'string') {
		// The first snapshot sets the baseline (even '' = never bumped). A different nonce later
		// means we missed a reload broadcast while disconnected (or we only poll): catch up now.
		if (live.bootNonce === null) live.bootNonce = data.reloadNonce;
		else if (data.reloadNonce !== live.bootNonce) scheduleReload();
	}
}

function handleMessage(msg) {
	if (!msg || typeof msg !== 'object') return;
	// Extension point: every live message is re-dispatched as a DOM event, so feature modules
	// (delights.js, social.js, ...) can react without editing this file.
	document.dispatchEvent(new CustomEvent('iszacka:live', { detail: msg }));
	switch (msg.type) {
		case 'hello':
			handleSnapshot(msg);
			break;
		case 'state':
			applyState(msg.state);
			break;
		case 'update':
			addUpdate(msg.update);
			break;
		case 'viewers':
			setCount('viewers', msg.viewers);
			break;
		case 'vibes':
			setCount('vibes', msg.vibes);
			receiveVibe(msg.emoji);
			break;
		case 'checks':
			setCount('checks', msg.checks);
			break;
		case 'reload':
			if (typeof msg.nonce === 'string' && msg.nonce !== live.bootNonce) scheduleReload();
			break;
		default:
			break;
	}
}

let reloadScheduled = false;
function scheduleReload() {
	if (reloadScheduled) return;
	// Never loop: at most one forced reload per 30 seconds per tab.
	let last = 0;
	try {
		last = Number(window.sessionStorage.getItem(`${STORAGE_PREFIX}reloaded-at`) || 0);
		if (Date.now() - last < 30_000) return;
		window.sessionStorage.setItem(`${STORAGE_PREFIX}reloaded-at`, String(Date.now()));
	} catch {
		/* no sessionStorage: still reload, once */
	}
	reloadScheduled = true;
	// Spread a site-wide reload over a few seconds so thousands of tabs don't stampede.
	window.setTimeout(() => window.location.reload(), Math.random() * 3000);
}

// ─── Updates arriving live ──────────────────────────────────────────────────

function addUpdate(update) {
	if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.id)) return;
	const labels = readJson('update-labels') || { kinds: {}, badges: {} };
	const href = `/updates/${update.id}`;
	let added = false;
	for (const list of $$('[data-updates-list]')) {
		if ($(`a[href="${href}"]`, list)) continue;
		const variant = list.dataset.updatesList === 'full' ? 'full' : 'mini';
		const template = doc.getElementById(`tpl-update-${variant}`);
		const node = template && template.content.firstElementChild ? template.content.firstElementChild.cloneNode(true) : null;
		if (!node) continue;
		const created = Date.parse(update.createdAt);
		for (const el of $$('[data-field]', node)) {
			switch (el.dataset.field) {
				case 'link':
					el.setAttribute('href', href);
					break;
				case 'title':
					el.textContent = String(update.title || '');
					break;
				case 'time':
					if (!Number.isNaN(created)) {
						el.setAttribute('datetime', new Date(created).toISOString());
						el.textContent = (variant === 'mini' ? LONDON_SHORT : LONDON_FULL).format(new Date(created));
					}
					break;
				case 'badge':
					if (isStatus(update.status)) {
						el.classList.add(`badge-${update.status}`);
						el.textContent = labels.badges[update.status] || update.status;
					}
					break;
				case 'kind':
					el.textContent = labels.kinds[update.kind] || String(update.kind || '');
					break;
				case 'body': {
					const paragraphs = String(update.body || '')
						.replace(/\r\n?/g, '\n')
						.split(/\n{2,}/)
						.map((p) => p.trim())
						.filter(Boolean);
					if (!paragraphs.length) el.remove();
					for (const text of paragraphs) {
						const p = doc.createElement('p');
						text.split('\n').forEach((line, i) => {
							if (i > 0) p.append(doc.createElement('br'));
							p.append(line);
						});
						el.append(p);
					}
					break;
				}
				default:
					break;
			}
		}
		list.prepend(node);
		const limit = Number(list.dataset.limit) || 50;
		while (list.children.length > limit && list.lastElementChild) list.lastElementChild.remove();
		for (const empty of $$('[data-updates-empty]', list.parentElement || doc)) empty.hidden = true;
		added = true;
	}
	// Status updates are already announced by the 'state' message.
	if (added && update.kind !== 'status') announce(`New update: ${update.title}`);
}

// ─── Cooldowns that keep keyboard focus ─────────────────────────────────────
// Setting `disabled` on the focused button would throw focus back to <body>, so
// cooling-down buttons are marked aria-disabled and their clicks ignored instead.

function coolDown(buttons, ms) {
	for (const b of buttons) b.setAttribute('aria-disabled', 'true');
	window.setTimeout(() => {
		for (const b of buttons) b.removeAttribute('aria-disabled');
	}, ms);
}

const isCooling = (button) => button.getAttribute('aria-disabled') === 'true';

// ─── Good vibes ─────────────────────────────────────────────────────────────

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const pendingOwnVibes = [];

function floatEmoji(emoji) {
	const layer = $('[data-vibe-layer]');
	if (!layer || layer.childElementCount > 45) return;
	const el = doc.createElement('span');
	el.className = 'vibe-float';
	el.textContent = emoji;
	el.style.left = `${4 + Math.random() * 90}%`;
	el.style.setProperty('--size', `${1.6 + Math.random() * 1.6}rem`);
	if (reducedMotion()) {
		el.classList.add('is-static');
		el.style.setProperty('--y', `${15 + Math.random() * 65}%`);
		layer.append(el);
		window.setTimeout(() => {
			el.style.opacity = '0';
		}, 900);
		window.setTimeout(() => el.remove(), 1500);
		return;
	}
	el.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 180)}px`);
	el.style.setProperty('--spin', `${Math.round((Math.random() - 0.5) * 70)}deg`);
	el.style.setProperty('--dur', `${(2.8 + Math.random() * 1.6).toFixed(2)}s`);
	el.addEventListener('animationend', () => el.remove(), { once: true });
	window.setTimeout(() => el.remove(), 7000);
	layer.append(el);
}

function receiveVibe(emoji) {
	const safeEmoji = typeof emoji === 'string' && emoji.length <= 16 && EMOJI_RE.test(emoji) ? emoji : '💛';
	const own = pendingOwnVibes.indexOf(safeEmoji);
	if (own !== -1) {
		pendingOwnVibes.splice(own, 1); // we already floated our own
		return;
	}
	floatEmoji(safeEmoji);
}

function setupVibes() {
	const buttons = $$('[data-vibe]');
	if (!buttons.length) return;
	const status = $('[data-vibe-status]');
	const say = (text) => {
		if (status) status.textContent = text;
	};
	for (const button of buttons) {
		button.addEventListener('click', () => {
			if (isCooling(button)) return;
			const emoji = button.dataset.vibe && EMOJI_RE.test(button.dataset.vibe) ? button.dataset.vibe : '💛';
			floatEmoji(emoji);
			const msg = { type: 'vibe', emoji };
			if (send(msg)) {
				pendingOwnVibes.push(emoji);
				window.setTimeout(() => {
					const i = pendingOwnVibes.indexOf(emoji);
					if (i !== -1) pendingOwnVibes.splice(i, 1);
				}, 5000);
				say('Vibes transmitted. Zack and Jess will not notice, but they would appreciate it.');
			} else {
				if (live.outbox.length < 5) live.outbox.push(msg);
				say('Vibes queued. Reconnecting to the vibe-o-meter.');
			}
			// A little friction, so holding Enter doesn't DDoS the good will.
			coolDown(buttons, 650);
		});
	}
}

// ─── Personal check counter ─────────────────────────────────────────────────

function personalCounter() {
	const countEl = $('[data-personal-count]');
	const lineEl = $('[data-personal-line]');
	if (!countEl && !lineEl) return;
	let n = 1;
	const stored = Number.parseInt(storageGet('checks') || '0', 10);
	if (Number.isFinite(stored) && stored >= 0) n = stored + 1;
	if (isHome) storageSet('checks', String(n));
	if (countEl) countEl.textContent = numberFormat.format(n);
	if (!lineEl) return;
	let lines = null;
	try {
		lines = JSON.parse(lineEl.dataset.lines || 'null');
	} catch {
		lines = null;
	}
	if (!lines) return;
	const template = n === 1 ? lines.first : n < 5 ? lines.few : n < 20 ? lines.many : n < 100 ? lines.lots : lines.absurd;
	if (typeof template === 'string') lineEl.textContent = template.replace('{n}', numberFormat.format(n));
}

// ─── Listen (speech synthesis, entirely in the browser) ─────────────────────

function setupSpeech() {
	const buttons = $$('[data-speak]');
	if (!buttons.length || !('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') return;
	for (const button of buttons) {
		button.hidden = false;
		button.setAttribute('aria-pressed', 'false');
		button.addEventListener('click', () => {
			const synth = window.speechSynthesis;
			if (synth.speaking) {
				synth.cancel();
				button.setAttribute('aria-pressed', 'false');
				return;
			}
			const copy = site.copy[state.status];
			const english = new SpeechSynthesisUtterance(`Is Zack a dad? ${copy ? copy.short : ''}`);
			english.lang = 'en-GB';
			const voices = synth.getVoices();
			const british = voices.find((v) => v.lang === 'en-GB') || voices.find((v) => v.lang && v.lang.startsWith('en'));
			if (british) english.voice = british;
			english.rate = 0.92;
			const queue = [english];
			const lang = button.dataset.speakLang;
			const word = button.getAttribute(`data-speak-word-${state.status}`);
			if (lang && lang !== 'en' && word) {
				const foreign = new SpeechSynthesisUtterance(word);
				foreign.lang = lang;
				const voice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(lang.toLowerCase().split('-')[0]));
				if (voice) foreign.voice = voice;
				queue.push(foreign);
			}
			const last = queue[queue.length - 1];
			last.addEventListener('end', () => button.setAttribute('aria-pressed', 'false'));
			last.addEventListener('error', () => button.setAttribute('aria-pressed', 'false'));
			button.setAttribute('aria-pressed', 'true');
			for (const u of queue) synth.speak(u);
		});
	}
}

// ─── Drumroll (Web Audio synthesis, no audio files) ─────────────────────────

let audioContext = null;
let noiseBuffer = null;

function getAudio() {
	const Ctor = window.AudioContext || window.webkitAudioContext;
	if (!Ctor) return null;
	if (!audioContext) audioContext = new Ctor();
	if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
	if (!noiseBuffer) {
		noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 2, audioContext.sampleRate);
		const data = noiseBuffer.getChannelData(0);
		for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
	}
	return audioContext;
}

function snare(ctx, out, t, level) {
	const src = ctx.createBufferSource();
	src.buffer = noiseBuffer;
	const band = ctx.createBiquadFilter();
	band.type = 'bandpass';
	band.frequency.value = 1800 + Math.random() * 400;
	band.Q.value = 0.7;
	const gain = ctx.createGain();
	gain.gain.setValueAtTime(0.0001, t);
	gain.gain.exponentialRampToValueAtTime(Math.max(0.001, level), t + 0.004);
	gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
	src.connect(band).connect(gain).connect(out);
	src.start(t, Math.random() * 1.5);
	src.stop(t + 0.12);

	const body = ctx.createOscillator();
	body.type = 'triangle';
	body.frequency.setValueAtTime(230, t);
	body.frequency.exponentialRampToValueAtTime(150, t + 0.05);
	const bodyGain = ctx.createGain();
	bodyGain.gain.setValueAtTime(Math.max(0.001, level * 0.45), t);
	bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
	body.connect(bodyGain).connect(out);
	body.start(t);
	body.stop(t + 0.07);
}

function crash(ctx, out, t) {
	const src = ctx.createBufferSource();
	src.buffer = noiseBuffer;
	src.loop = true;
	const high = ctx.createBiquadFilter();
	high.type = 'highpass';
	high.frequency.value = 4500;
	const gain = ctx.createGain();
	gain.gain.setValueAtTime(0.0001, t);
	gain.gain.exponentialRampToValueAtTime(0.7, t + 0.01);
	gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
	src.connect(high).connect(gain).connect(out);
	src.start(t);
	src.stop(t + 2.7);

	const kick = ctx.createOscillator();
	kick.type = 'sine';
	kick.frequency.setValueAtTime(160, t);
	kick.frequency.exponentialRampToValueAtTime(42, t + 0.18);
	const kickGain = ctx.createGain();
	kickGain.gain.setValueAtTime(1, t);
	kickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
	kick.connect(kickGain).connect(out);
	kick.start(t);
	kick.stop(t + 0.55);
}

function setupDrumroll() {
	const buttons = $$('[data-drumroll]');
	if (!buttons.length || !(window.AudioContext || window.webkitAudioContext)) return;
	for (const button of buttons) {
		button.hidden = false;
		button.addEventListener('click', () => {
			if (isCooling(button)) return;
			const ctx = getAudio();
			if (!ctx) return;
			const out = ctx.createDynamicsCompressor();
			out.connect(ctx.destination);
			const t0 = ctx.currentTime + 0.06;
			const roll = 2.6;
			let t = t0;
			let i = 0;
			while (t < t0 + roll) {
				const progress = (t - t0) / roll;
				snare(ctx, out, t, (0.12 + 0.6 * progress ** 1.6) * (i % 2 ? 0.82 : 1));
				t += (0.075 - 0.042 * progress) * (0.92 + Math.random() * 0.16);
				i++;
			}
			const hit = t0 + roll + 0.1;
			crash(ctx, out, hit);
			coolDown(buttons, 4200);
			announce('Drumroll…');
			window.setTimeout(
				() => {
					const copy = site.copy[state.status];
					revealAnswer($('[data-live="answer"]'));
					if (copy) announce(`The answer is: ${copy.short}`);
					if (state.status === 'yes') celebrate();
				},
				Math.max(0, (hit - ctx.currentTime) * 1000),
			);
		});
	}
}

// ─── Celebration: confetti + fireworks on a canvas ──────────────────────────

const CONFETTI_COLOURS = ['#ffb000', '#14864a', '#e2491f', '#2257d8', '#f6f1e6', '#ff5fa2', '#7c4dff', '#3fd58a'];

let celebratePending = false;

/** Remember that this browser has seen the celebration for the current YES. */
function markCelebrated() {
	if (state.status === 'yes' && state.statusChangedAt) storageSet('celebrated', state.statusChangedAt);
}

function celebrate() {
	if (reducedMotion()) {
		announce(`${site.copy.yes ? site.copy.yes.sentence : 'Zack is a dad!'} Confetti withheld, as you prefer reduced motion.`);
		markCelebrated();
		return;
	}
	if ($('canvas.celebration')) return;
	// Background tabs don't animate (requestAnimationFrame is paused), and most tabs left open
	// for days are in the background: save the show for when someone is looking.
	if (doc.hidden) {
		if (!celebratePending) {
			celebratePending = true;
			const go = () => {
				if (doc.hidden) return;
				doc.removeEventListener('visibilitychange', go);
				celebratePending = false;
				try {
					celebrate();
				} catch (err) {
					console.error('app.js: celebration failed', err);
				}
			};
			doc.addEventListener('visibilitychange', go);
		}
		return;
	}
	const canvas = doc.createElement('canvas');
	canvas.className = 'celebration';
	canvas.setAttribute('aria-hidden', 'true');
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	doc.body.append(canvas);
	markCelebrated();

	let width = 0;
	let height = 0;
	const resize = () => {
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		width = window.innerWidth;
		height = window.innerHeight;
		canvas.width = Math.floor(width * dpr);
		canvas.height = Math.floor(height * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	};
	resize();
	window.addEventListener('resize', resize);

	const rand = (a, b) => a + Math.random() * (b - a);
	const pick = (list) => list[Math.floor(Math.random() * list.length)];
	const particles = [];
	const confettiCount = Math.min(260, Math.round(width / 5));
	for (let i = 0; i < confettiCount; i++) {
		particles.push({
			kind: 'confetti',
			x: rand(0, width),
			y: rand(-height * 0.8, -10),
			vx: rand(-1.2, 1.2),
			vy: rand(1.6, 4.2),
			rot: rand(0, Math.PI * 2),
			vr: rand(-0.18, 0.18),
			w: rand(6, 11),
			h: rand(9, 17),
			wobble: rand(0, Math.PI * 2),
			color: pick(CONFETTI_COLOURS),
		});
	}
	const burst = () => {
		const x = rand(width * 0.12, width * 0.88);
		const y = rand(height * 0.1, height * 0.45);
		const color = pick(CONFETTI_COLOURS);
		const n = 64;
		for (let i = 0; i < n; i++) {
			const angle = (i / n) * Math.PI * 2 + rand(-0.05, 0.05);
			const speed = rand(1.6, 5.2);
			particles.push({ kind: 'spark', x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, age: 0, life: rand(55, 85), color });
		}
	};
	let bursts = 0;
	let burstTimer = 0;

	// The 12 seconds start at the first frame actually drawn, with the fireworks alongside.
	let started = 0;
	const frame = (now) => {
		if (!started) {
			started = now;
			burst();
			burstTimer = window.setInterval(() => {
				burst();
				if (++bursts >= 10) clearInterval(burstTimer);
			}, 380);
		}
		ctx.clearRect(0, 0, width, height);
		for (let i = particles.length - 1; i >= 0; i--) {
			const p = particles[i];
			if (p.kind === 'confetti') {
				p.wobble += 0.08;
				p.x += p.vx + Math.sin(p.wobble) * 0.6;
				p.y += p.vy;
				p.rot += p.vr;
				if (p.y > height + 20) {
					particles.splice(i, 1);
					continue;
				}
				ctx.save();
				ctx.translate(p.x, p.y);
				ctx.rotate(p.rot);
				ctx.scale(1, Math.cos(p.wobble));
				ctx.fillStyle = p.color;
				ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
				ctx.restore();
			} else {
				p.age++;
				p.vx *= 0.975;
				p.vy = p.vy * 0.975 + 0.055;
				p.x += p.vx;
				p.y += p.vy;
				if (p.age >= p.life) {
					particles.splice(i, 1);
					continue;
				}
				ctx.globalAlpha = 1 - p.age / p.life;
				ctx.fillStyle = p.color;
				ctx.beginPath();
				ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
				ctx.fill();
				ctx.globalAlpha = 1;
			}
		}
		if (particles.length && now - started < 12_000) {
			window.requestAnimationFrame(frame);
		} else {
			clearInterval(burstTimer);
			window.removeEventListener('resize', resize);
			canvas.remove();
		}
	};
	window.requestAnimationFrame(frame);
}

/** First visit after the big moment: celebrate once per browser per change. */
function celebrateOnFirstYesVisit() {
	if (!isHome || state.status !== 'yes' || !state.statusChangedAt) return;
	if (storageGet('celebrated') === state.statusChangedAt) return;
	// celebrate() records the key once the show actually starts (or is announced).
	window.setTimeout(celebrate, 700);
}

// ─── Konami code: Dad Mode (simulated) ──────────────────────────────────────

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
const DAD_JOKES = [
	"I'm reading a book about anti-gravity. It's impossible to put down.",
	'Why do eggs never tell jokes? They would crack each other up.',
	'I only know 25 letters of the alphabet. I don\'t know y.',
	'What do you call a fake noodle? An impasta.',
	"I'd tell a joke about paper, but it's tearable.",
	'Did you hear about the restaurant on the moon? Great food, no atmosphere.',
	"I'm worried about the calendar. Its days are numbered.",
	'What do you call a sleeping dinosaur? A dino-snore. Soon to be a household sound.',
	'How do you organise a space party? You planet.',
	'Why did the nappy go to the doctor? It was feeling a bit run down. And full.',
];

function chiptune() {
	const ctx = getAudio();
	if (!ctx) return;
	const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5];
	notes.forEach((freq, i) => {
		const t = ctx.currentTime + 0.05 + i * 0.09;
		const osc = ctx.createOscillator();
		osc.type = 'square';
		osc.frequency.value = freq;
		const gain = ctx.createGain();
		gain.gain.setValueAtTime(0.06, t);
		gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.085 + (i === notes.length - 1 ? 0.3 : 0));
		osc.connect(gain).connect(ctx.destination);
		osc.start(t);
		osc.stop(t + 0.45);
	});
}

let konamiOpen = false;
function konami() {
	document.dispatchEvent(new CustomEvent('iszacka:konami'));
	if (konamiOpen) return;
	konamiOpen = true;
	const copy = site.copy[state.status];
	const alreadyDad = state.status === 'yes';
	const joke = DAD_JOKES[Math.floor(Math.random() * DAD_JOKES.length)];
	const lines = alreadyDad
		? ['> Cheat code accepted.', '> Dad Mode is already active. Attempting Grandad Mode…', '> Checking prerequisites… 0 of 1 grandchildren found.', '> ERROR: Grandad Mode is roughly thirty years early.', '> Consolation prize, one dad joke:', `> ${joke}`]
		: [
				'> Cheat code accepted.',
				'> Loading Dad Mode (simulation)…',
				'> Calibrating dad jokes… done',
				'> Installing sensible shoes… done',
				'> Routing all difficult questions to Jess… done',
				'> Simulating sleep deprivation… 97%',
				'> ERROR: simulation cannot substitute for an actual baby.',
				'> Consolation prize, one dad joke:',
				`> ${joke}`,
			];

	chiptune();
	for (let i = 0; i < 14; i++) window.setTimeout(() => floatEmoji(i % 3 ? '🍼' : '🧦'), i * 120);
	if (!reducedMotion()) root.classList.add('is-konami');

	const dialog = doc.createElement('dialog');
	if (typeof dialog.showModal !== 'function') {
		announce(`Cheat code accepted. ${joke} Nothing has actually changed: ${copy ? copy.sentence : ''}`);
		window.setTimeout(() => root.classList.remove('is-konami'), 6000);
		konamiOpen = false;
		return;
	}
	dialog.className = 'konami';
	dialog.setAttribute('aria-labelledby', 'konami-title');
	const inner = doc.createElement('div');
	inner.className = 'konami-inner';
	const kicker = doc.createElement('p');
	kicker.className = 'kicker';
	kicker.textContent = '↑ ↑ ↓ ↓ ← → ← → B A';
	const title = doc.createElement('h2');
	title.className = 'konami-title';
	title.id = 'konami-title';
	title.textContent = alreadyDad ? 'Grandad Mode' : 'Dad Mode';
	const log = doc.createElement('pre');
	log.className = 'konami-log';
	log.setAttribute('aria-live', 'polite');
	const note = doc.createElement('p');
	note.className = 'tiny muted';
	note.textContent = `This was a simulation. Nothing has actually changed: ${copy ? copy.sentence : ''}`;
	const close = doc.createElement('button');
	close.type = 'button';
	close.className = 'btn btn-primary';
	close.textContent = 'Resume waiting';
	close.addEventListener('click', () => dialog.close());
	inner.append(kicker, title, log, note, close);
	dialog.append(inner);
	doc.body.append(dialog);

	const timers = [];
	dialog.addEventListener('close', () => {
		timers.forEach((t) => clearTimeout(t));
		root.classList.remove('is-konami');
		dialog.remove();
		konamiOpen = false;
	});
	dialog.showModal();
	if (reducedMotion()) {
		log.textContent = lines.join('\n');
	} else {
		lines.forEach((line, i) => {
			timers.push(
				window.setTimeout(() => {
					log.textContent += (i ? '\n' : '') + line;
				}, 350 + i * 520),
			);
		});
	}
}

function setupKonami() {
	let position = 0;
	window.addEventListener('keydown', (event) => {
		const target = event.target;
		if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
		const key = event.key && event.key.length === 1 ? event.key.toLowerCase() : event.key;
		if (key === KONAMI[position]) {
			position++;
			if (position === KONAMI.length) {
				position = 0;
				konami();
			}
		} else {
			position = key === KONAMI[0] ? 1 : 0;
		}
	});
}

// ─── Small utilities: copy buttons, install prompt, service worker ──────────

function setupCopyButtons() {
	const buttons = $$('[data-copy]');
	if (!buttons.length || !navigator.clipboard || !window.isSecureContext) return;
	for (const button of buttons) {
		const target = $(button.dataset.copy || '');
		if (!target) continue;
		button.hidden = false;
		const label = button.textContent;
		button.setAttribute('aria-label', `Copy: ${(target.textContent || '').trim().slice(0, 80)}`);
		button.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText((target.textContent || '').trim());
				button.textContent = 'Copied';
				announce('Copied to the clipboard.');
			} catch {
				button.textContent = 'Press Ctrl+C';
			}
			window.setTimeout(() => {
				button.textContent = label;
			}, 1800);
		});
	}
}

function setupInstall() {
	const buttons = $$('[data-install]');
	if (!buttons.length) return;
	let deferred = null;
	window.addEventListener('beforeinstallprompt', (event) => {
		event.preventDefault();
		deferred = event;
		for (const b of buttons) b.hidden = false;
	});
	window.addEventListener('appinstalled', () => {
		deferred = null;
		for (const b of buttons) b.hidden = true;
		announce('Installed. One icon, one bit of information.');
	});
	for (const button of buttons) {
		button.addEventListener('click', async () => {
			if (!deferred) return;
			deferred.prompt();
			try {
				await deferred.userChoice;
			} catch {
				/* dismissed */
			}
			deferred = null;
			for (const b of buttons) b.hidden = true;
		});
	}
}

function registerServiceWorker() {
	if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
	const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
	if (doc.readyState === 'complete') register();
	else window.addEventListener('load', register, { once: true });
}

function revealJsOnly() {
	// Feature-specific controls are revealed by their own setup once support is confirmed.
	for (const el of $$('[data-js-only]')) {
		if (!el.matches('[data-speak], [data-drumroll], [data-copy], [data-install]')) el.hidden = false;
	}
}

function lifecycle() {
	doc.addEventListener('visibilitychange', () => {
		if (doc.hidden) return;
		probe();
		if (live.pollTimer) pollOnce();
		tickClocks();
	});
	window.addEventListener('online', () => {
		live.paused = false;
		probe();
	});
	window.addEventListener('offline', () => {
		// Say so even if the socket still looks open: it can't be delivering anything now.
		setConn('offline');
		tickAsOf();
	});
	// Open sockets keep pages out of the back/forward cache; close on the way out, reopen on return.
	window.addEventListener('pagehide', () => {
		live.paused = true;
		clearTimeout(live.reconnectTimer);
		if (live.ws) live.ws.close(1000, 'pagehide');
	});
	window.addEventListener('pageshow', (event) => {
		if (event.persisted) reconnectNow();
	});
}

// ─── Boot ───────────────────────────────────────────────────────────────────

function boot() {
	const steps = [
		revealJsOnly,
		personalCounter,
		setupVibes,
		setupSpeech,
		setupDrumroll,
		setupCopyButtons,
		setupInstall,
		setupKonami,
		registerServiceWorker,
		renderLocalTimes,
		tickClocks,
		celebrateOnFirstYesVisit,
		lifecycle,
		connect,
	];
	for (const step of steps) {
		try {
			step();
		} catch (err) {
			console.error(`app.js: ${step.name} failed`, err);
		}
	}
	window.setInterval(() => {
		tickClocks();
		tickAsOf();
	}, 1000);
}

boot();

// ─── Extension API for feature modules ──────────────────────────────────────
// Feature modules (loaded after this one) use these instead of reaching into app.js internals.
// Events on document: 'iszacka:live' (detail: LiveMessage), 'iszacka:konami'.
window.iszacka = Object.freeze({
	/** The full celebration (confetti + fireworks), honouring reduced motion. */
	celebrate: () => celebrate(),
	/** Say something through the polite aria-live region. */
	announce: (text) => announce(String(text)),
	/** The current status: 'no' | 'soon' | 'yes'. */
	status: () => state.status,
});

