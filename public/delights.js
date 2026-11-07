// iszacka.dad delights: browser-only toys, with no server state and no network requests.
//
//   Achievements      kept in localStorage (or in memory when that's unavailable), toasted on
//                     unlock, listed on /achievements (the server renders an empty shell).
//   Screensaver       home page, 60 s without input: the answer bounces round DVD-style.
//   Other calendars   home panel: the due date in Hebrew, Islamic, Chinese, Persian, Julian,
//                     Discordian, stardate and Unix time (seconds, milliseconds, nanoseconds).
//   Night-feed mode   after YES, 02:00 to 05:00 UK time: body.night-feed, a dim red night-light.
//   Torch mode        the answer in Morse code, full screen, at most two flashes a second.
//   Away title        a status-appropriate tab title while hidden; it flashes on a live change.
//
// Loaded on every page after /app.js (module scripts run in order, so app.js has booted). Up
// front it does one localStorage read and adds a few listeners; everything else waits until it
// is needed. Hooks: window.iszacka (celebrate, announce, status) and the 'iszacka:konami' event.
// Status and due-date changes are watched on <html data-status data-due-date>, which app.js
// updates for the WebSocket and the polling fallback alike.
//
// The pure helpers are exported for test/delights-client.test.ts; boot() only runs in a browser.

// ─── Constants ──────────────────────────────────────────────────────────────

export const STORE_KEY = 'iszackadad:delights';
/** app.js's personal check counter: home page loads on this device. */
const CHECKS_KEY = 'iszackadad:checks';
export const IDLE_MS = 60_000;
export const MORSE_UNIT_MS = 250;
const PATIENCE_MS = 3_600_000;
const BACK_AGAIN_MS = 600_000;
const TOAST_MS = 7000;
const MAX_PAGES = 40;
const MAX_DAYS = 60;
/** How close (px) the other axis must be to its wall when one axis bounces to count as a corner. */
export const CORNER_TOLERANCE = 4;
const STATUSES = ['no', 'soon', 'yes'];
const FALLBACK_WORDS = { no: 'NO', soon: 'NOT YET', yes: 'YES' };

/** @typedef {{ id: string, emoji: string, name: string, description: string, hint?: string, secret?: boolean }} Achievement */

/** @type {readonly Achievement[]} */
export const ACHIEVEMENTS = Object.freeze([
	{ id: 'curious', emoji: '🥚', name: 'Curious', description: 'Asked the question for the first time. Got an answer, too.' },
	{ id: 'concerned-relative', emoji: '👵', name: 'Concerned Relative', description: 'Checked the answer 10 times.' },
	{ id: 'obsessed', emoji: '🌀', name: 'Obsessed', description: 'Checked the answer 100 times. Email updates exist, you know.' },
	{ id: 'season-ticket', emoji: '🎟️', name: 'Season Ticket', description: 'Checked on 7 different days.' },
	{ id: 'night-owl', emoji: '🦉', name: 'Night Owl', description: 'Checked between 02:00 and 05:00, your time. Go to bed.' },
	{ id: 'early-bird', emoji: '🐦', name: 'Early Bird', description: 'Checked between 05:00 and 07:00, your time, before the kettle had boiled.' },
	{ id: 'weekend-warrior', emoji: '🛋️', name: 'Weekend Warrior', description: 'Checked on a Saturday and on a Sunday. Rest is for other people.' },
	{ id: 'bookworm', emoji: '📚', name: 'Bookworm', description: 'Read 10 different pages of a website about one word.' },
	{ id: 'good-vibes', emoji: '💛', name: 'Good Vibes', description: 'Sent good vibes. Zack and Jess will not notice, but it counts.' },
	{ id: 'vibe-merchant', emoji: '🧺', name: 'Vibe Merchant', description: 'Sent 50 good vibes. Wholesale rates available on request.' },
	{ id: 'konami', emoji: '🎮', name: 'Cheat Code', description: 'Found the Konami code.', hint: 'A secret. Some 1980s video-game knowledge will help.', secret: true },
	{ id: 'was-here', emoji: '⚡', name: 'Was Here When It Flipped', description: 'Had the page open when the answer changed to NOT YET or YES.' },
	{ id: 'confirmed', emoji: '👶', name: 'Confirmed Sighting', description: 'Saw the answer YES with your own eyes.' },
	{ id: 'patience', emoji: '😇', name: 'Patience of a Saint', description: 'Kept a tab open for over an hour.' },
	{ id: 'back-again', emoji: '🔁', name: 'Back Again', description: 'Wandered off for ten minutes, then came straight back to check.' },
	{ id: 'terminal', emoji: '💻', name: 'Terminal Enthusiast', description: 'Opened the /live terminal dashboard in a browser, of all places.' },
	{ id: 'screensaver', emoji: '📺', name: 'Screensaver Survivor', description: 'Left the home page alone long enough for the screensaver, and lived.' },
	{ id: 'corner', emoji: '📐', name: 'It Hit the Corner', description: 'Saw the bouncing answer hit a corner exactly.', hint: 'A secret. Requires a screensaver and the patience of a saint.', secret: true },
	{ id: 'torchbearer', emoji: '🔦', name: 'Torchbearer', description: 'Flashed the answer in Morse code with torch mode.' },
	{ id: 'night-feed', emoji: '🌙', name: 'Night Feed', description: 'Was up for a night feed: after YES, between 02:00 and 05:00 UK time.', hint: 'A secret. Unlocks at an hour nobody chooses.', secret: true },
	{ id: 'achievement-hunter', emoji: '🏆', name: 'Achievement Hunter', description: 'Looked at the achievements page. Very meta.' },
	{ id: 'completionist', emoji: '💯', name: 'Completionist', description: 'Earned every other achievement. There is no prize. There was never going to be a prize.' },
]);

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const isStatus = (value) => STATUSES.includes(value);

/** A real calendar date as YYYY-MM-DD. */
export function isYmd(value) {
	return ymdParts(value) !== null;
}

function ymdParts(value) {
	const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
	if (!m) return null;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	const t = new Date(Date.UTC(y, mo - 1, d));
	if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
	return { y, m: mo, d };
}

/** The local calendar date of `date` as YYYY-MM-DD (the visitor's own time zone). */
export function localYmd(date) {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD date. */
function weekdayOf(ymd) {
	const p = ymdParts(ymd);
	return p ? new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() : -1;
}

/** A path as one page: no trailing slash (except the root), capped in length. */
export function normalisePath(pathname) {
	let p = typeof pathname === 'string' && pathname.startsWith('/') ? pathname : '/';
	if (p.length > 1) p = p.replace(/\/+$/, '') || '/';
	return p.slice(0, 200);
}

export function isLivePath(path) {
	return path === '/live' || path.startsWith('/live/');
}

export function blankStore() {
	return { v: 1, unlocked: {}, queue: [], vibes: 0, pages: [], days: [] };
}

/** Whatever was in localStorage, made safe: unknown ids dropped, lists de-duplicated and capped. */
export function sanitiseStore(raw) {
	const s = blankStore();
	if (!raw || typeof raw !== 'object') return s;
	if (raw.unlocked && typeof raw.unlocked === 'object') {
		for (const [id, at] of Object.entries(raw.unlocked)) {
			if (BY_ID.has(id) && typeof at === 'string' && at.length <= 40) s.unlocked[id] = at;
		}
	}
	if (Array.isArray(raw.queue)) s.queue = [...new Set(raw.queue.filter((id) => typeof id === 'string' && s.unlocked[id]))].slice(-10);
	if (Number.isSafeInteger(raw.vibes) && raw.vibes > 0) s.vibes = Math.min(raw.vibes, 1e9);
	if (Array.isArray(raw.pages)) {
		s.pages = [...new Set(raw.pages.filter((p) => typeof p === 'string' && p.startsWith('/') && p.length <= 200))].slice(-MAX_PAGES);
	}
	if (Array.isArray(raw.days)) s.days = [...new Set(raw.days.filter(isYmd))].slice(-MAX_DAYS);
	return s;
}

/** The achievements a page load qualifies for (already-earned ones are filtered out later). */
export function visitAchievements({ checks, days, pages, hour, status, path }) {
	const ids = ['curious'];
	if (checks >= 10) ids.push('concerned-relative');
	if (checks >= 100) ids.push('obsessed');
	if (days.length >= 7) ids.push('season-ticket');
	if (hour >= 2 && hour < 5) ids.push('night-owl');
	if (hour >= 5 && hour < 7) ids.push('early-bird');
	const weekdays = new Set(days.map(weekdayOf));
	if (weekdays.has(6) && weekdays.has(0)) ids.push('weekend-warrior');
	if (pages.length >= 10) ids.push('bookworm');
	if (status === 'yes') ids.push('confirmed');
	if (isLivePath(path)) ids.push('terminal');
	if (path === '/achievements') ids.push('achievement-hunter');
	return ids;
}

export function vibeAchievements(vibes) {
	const ids = [];
	if (vibes >= 1) ids.push('good-vibes');
	if (vibes >= 50) ids.push('vibe-merchant');
	return ids;
}

/** Completionist is due once every other achievement is unlocked. */
export function completionistDue(unlocked) {
	return ACHIEVEMENTS.every((a) => a.id === 'completionist' || Boolean(unlocked[a.id]));
}

/**
 * Record `ids` as unlocked at `at` (ISO), plus Completionist if that completes the set.
 * Mutates the store; returns the ids that are new.
 */
export function applyUnlocks(store, ids, at) {
	const added = [];
	for (const id of ids) {
		if (BY_ID.has(id) && !store.unlocked[id]) {
			store.unlocked[id] = at;
			added.push(id);
		}
	}
	if (added.length && !store.unlocked.completionist && completionistDue(store.unlocked)) {
		store.unlocked.completionist = at;
		added.push('completionist');
	}
	return added;
}

/** The hour (0–23) in Europe/London, without Intl: GMT, or BST between the last Sundays of March and October (01:00 UTC). */
export function londonHour(date) {
	const t = date.getTime();
	const y = date.getUTCFullYear();
	const bst = t >= lastSundayUtc(y, 2) + 3_600_000 && t < lastSundayUtc(y, 9) + 3_600_000;
	return (date.getUTCHours() + (bst ? 1 : 0)) % 24;
}

function lastSundayUtc(year, month) {
	const last = new Date(Date.UTC(year, month + 1, 0));
	return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay());
}

export function isNightFeed(status, hour) {
	return status === 'yes' && hour >= 2 && hour < 5;
}

const AWAY = { no: '(still no)', soon: '(any minute now)', yes: '(still yes)' };

/** The tab title while the tab is hidden. */
export function awayTitle(status, siteName) {
	return `${AWAY[status] ?? AWAY.no} ${siteName}`;
}

/** The title to flash when the answer changes while the tab is hidden, or null if it isn't news. */
export function flashTitle(status, siteName) {
	if (status === 'yes') return `‼️ YES — ${siteName}`;
	if (status === 'soon') return `🐣 IT'S HAPPENING — ${siteName}`;
	return null;
}

const MORSE = {
	A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
	N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
	0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
	'?': '..--..', '!': '-.-.--', '.': '.-.-.-', ',': '--..--',
};

function morseWords(text) {
	return String(text)
		.toUpperCase()
		.split(/\s+/)
		.map((word) => [...word].map((ch) => MORSE[ch]).filter(Boolean))
		.filter((letters) => letters.length);
}

/** Morse for display: letters separated by spaces, words by " / ". */
export function morse(text) {
	return morseWords(text)
		.map((letters) => letters.join(' '))
		.join(' / ');
}

/**
 * The on/off schedule for `text`: dot 1 unit, dash 3, 1 between symbols, 3 between letters,
 * 7 between words (and after the last, so a loop reads cleanly). With a 250 ms unit the
 * quickest cycle is a dot and a gap, 500 ms: two flashes a second, under WCAG 2.3.1's three.
 */
export function morseTimeline(text, unit = MORSE_UNIT_MS) {
	const steps = [];
	for (const letters of morseWords(text)) {
		letters.forEach((code, li) => {
			[...code].forEach((symbol, si) => {
				if (si > 0) steps.push({ on: false, ms: unit });
				steps.push({ on: true, ms: symbol === '-' ? 3 * unit : unit });
			});
			if (li < letters.length - 1) steps.push({ on: false, ms: 3 * unit });
		});
		steps.push({ on: false, ms: 7 * unit });
	}
	return steps;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Friday 20 November 2026", without Intl. */
export function gregorianLong(ymd) {
	const p = ymdParts(ymd);
	if (!p) return '';
	return `${WEEKDAYS[weekdayOf(ymd)]} ${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/** Julian Day Number of a (proleptic) Gregorian date. */
function julianDayNumber(y, m, d) {
	const a = Math.floor((14 - m) / 12);
	const yy = y + 4800 - a;
	const mm = m + 12 * a - 3;
	return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

/** The same day in the Julian calendar (Old Style), as {year, month, day}. */
export function julianDate(ymd) {
	const p = ymdParts(ymd);
	if (!p) return null;
	const c = julianDayNumber(p.y, p.m, p.d) + 32082;
	const d = Math.floor((4 * c + 3) / 1461);
	const e = c - Math.floor((1461 * d) / 4);
	const m = Math.floor((5 * e + 2) / 153);
	return {
		year: d - 4800 + Math.floor(m / 10),
		month: m + 3 - 12 * Math.floor(m / 10),
		day: e - Math.floor((153 * m + 2) / 5) + 1,
	};
}

export function julianText(ymd) {
	const j = julianDate(ymd);
	return j ? `${j.day} ${MONTHS[j.month - 1]} ${j.year}` : '';
}

const SEASONS = ['Chaos', 'Discord', 'Confusion', 'Bureaucracy', 'The Aftermath'];
const DISCORDIAN_WEEKDAYS = ['Sweetmorn', 'Boomtime', 'Pungenday', 'Prickle-Prickle', 'Setting Orange'];
const APOSTLE_HOLYDAYS = ['Mungday', 'Mojoday', 'Syaday', 'Zaraday', 'Maladay'];
const SEASON_HOLYDAYS = ['Chaoflux', 'Discoflux', 'Confuflux', 'Bureflux', 'Afflux'];

/** The Discordian (Erisian) date: five 73-day seasons, a five-day week, St. Tib's Day on 29 February. */
export function discordian(ymd) {
	const p = ymdParts(ymd);
	if (!p) return '';
	const yold = p.y + 1166;
	const leap = (p.y % 4 === 0 && p.y % 100 !== 0) || p.y % 400 === 0;
	if (leap && p.m === 2 && p.d === 29) return `St. Tib's Day, ${yold} YOLD`;
	let doy = Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(p.y, 0, 1)) / 86_400_000);
	if (leap && doy > 59) doy -= 1;
	const season = Math.floor(doy / 73);
	const day = (doy % 73) + 1;
	const holyday = day === 5 ? APOSTLE_HOLYDAYS[season] : day === 50 ? SEASON_HOLYDAYS[season] : '';
	return `${DISCORDIAN_WEEKDAYS[doy % 5]}, ${SEASONS[season]} ${day}, ${yold} YOLD${holyday ? ` (${holyday})` : ''}`;
}

/**
 * A TNG-era stardate by the common fan formula (as popularised by TrekGuide): 1,000 units a year
 * and stardate 0 at the start of 2323, so anything this century comes out negative.
 */
export function stardate(ymd) {
	const p = ymdParts(ymd);
	if (!p) return Number.NaN;
	const start = Date.UTC(p.y, 0, 1);
	const fraction = (Date.UTC(p.y, p.m - 1, p.d) - start) / (Date.UTC(p.y + 1, 0, 1) - start);
	return 1000 * (p.y - 2323) + 1000 * fraction;
}

export function stardateText(ymd) {
	const n = stardate(ymd);
	return Number.isFinite(n) ? n.toFixed(1).replace('-', '−') : '';
}

/**
 * The due date as Unix time: midnight UTC at the start of the day (the instant the stardate
 * counts from too), in whole seconds, milliseconds and nanoseconds. Strings, not numbers:
 * nanoseconds outgrow Number.MAX_SAFE_INTEGER, so they're done in BigInt.
 */
export function unixTimes(ymd) {
	const p = ymdParts(ymd);
	if (!p) return null;
	const ms = Date.UTC(p.y, p.m - 1, p.d);
	return {
		seconds: String(ms / 1000),
		milliseconds: String(ms),
		nanoseconds: (BigInt(ms) * 1_000_000n).toString(),
	};
}

const STEMS = { jia: 'Wood', yi: 'Wood', bing: 'Fire', ding: 'Fire', wu: 'Earth', ji: 'Earth', geng: 'Metal', xin: 'Metal', ren: 'Water', gui: 'Water' };
const BRANCHES = { zi: 'Rat', chou: 'Ox', yin: 'Tiger', mao: 'Rabbit', chen: 'Dragon', si: 'Snake', wu: 'Horse', wei: 'Goat', shen: 'Monkey', you: 'Rooster', xu: 'Dog', hai: 'Pig' };

/** "bing-wu" → "Fire Horse": the sexagenary year name as an element and an animal. */
export function chineseYear(yearName) {
	const [stem = '', branch = ''] = String(yearName).toLowerCase().split('-');
	const element = Object.hasOwn(STEMS, stem) ? STEMS[stem] : '';
	const animal = Object.hasOwn(BRANCHES, branch) ? BRANCHES[branch] : '';
	return element && animal ? `${element} ${animal}` : '';
}

/**
 * One animation step of the bouncing answer: move by velocity × dt, reflect off the walls of
 * [0, maxX] × [0, maxY]. A corner is one axis bouncing while the other is within `tolerance`
 * of a wall: close enough to look exact, and rare enough to deserve the confetti.
 */
export function bounceStep(s, dt, maxX, maxY, tolerance = CORNER_TOLERANCE) {
	let x = s.x + s.vx * dt;
	let y = s.y + s.vy * dt;
	let vx = s.vx;
	let vy = s.vy;
	let hitX = false;
	let hitY = false;
	if (x <= 0) {
		x = 0;
		vx = Math.abs(vx);
		hitX = true;
	} else if (x >= maxX) {
		x = maxX;
		vx = -Math.abs(vx);
		hitX = true;
	}
	if (y <= 0) {
		y = 0;
		vy = Math.abs(vy);
		hitY = true;
	} else if (y >= maxY) {
		y = maxY;
		vy = -Math.abs(vy);
		hitY = true;
	}
	const nearX = x <= tolerance || x >= maxX - tolerance;
	const nearY = y <= tolerance || y >= maxY - tolerance;
	return { x, y, vx, vy, hitX, hitY, corner: (hitX && nearY) || (hitY && nearX) };
}

// ─── Browser runtime ────────────────────────────────────────────────────────

let root;
let storageOk = true;
let memory = null;
let siteCopy = null;
let onAchievementsPage = false;
const bootAt = Date.now();

function h(tag, attrs, ...children) {
	const el = document.createElement(tag);
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value === false || value === null || value === undefined) continue;
			if (key === 'class') el.className = String(value);
			else el.setAttribute(key, value === true ? '' : String(value));
		}
	}
	for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
	return el;
}

const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function currentStatus() {
	let status = null;
	try {
		status = window.iszacka?.status?.();
	} catch {
		status = null;
	}
	if (!isStatus(status)) status = root.dataset.status;
	return isStatus(status) ? status : 'no';
}

function copy() {
	if (!siteCopy) {
		try {
			siteCopy = JSON.parse(document.getElementById('site-copy')?.textContent || 'null');
		} catch {
			siteCopy = null;
		}
		if (!siteCopy || typeof siteCopy !== 'object') siteCopy = {};
	}
	return siteCopy;
}

const siteName = () => (typeof copy().siteName === 'string' ? copy().siteName : 'Is Zack a Dad?');

function currentWord() {
	const status = currentStatus();
	const word = copy().copy?.[status]?.word;
	return typeof word === 'string' && word ? word : FALLBACK_WORDS[status];
}

function announce(text) {
	try {
		window.iszacka?.announce?.(text);
	} catch {
		/* app.js missing: the toast is still visible */
	}
}

// ─── Storage: localStorage, or memory for this tab when it's unavailable ────

function load() {
	if (storageOk) {
		let raw = null;
		try {
			raw = window.localStorage.getItem(STORE_KEY);
		} catch {
			storageOk = false;
		}
		if (storageOk) {
			let parsed = null;
			try {
				parsed = raw ? JSON.parse(raw) : null;
			} catch {
				parsed = null;
			}
			return sanitiseStore(parsed);
		}
	}
	return sanitiseStore(memory);
}

function save(store) {
	memory = store;
	if (!storageOk) return;
	try {
		window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
	} catch {
		storageOk = false; // private mode, quota, or disabled: carry on in memory
	}
}

function readChecks() {
	try {
		const n = Number.parseInt(window.localStorage.getItem(CHECKS_KEY) || '0', 10);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}

/** Unlock achievements. `defer` leaves the toast for the next page (the visitor is navigating away). */
function unlock(ids, { defer = false } = {}) {
	const store = load();
	const added = applyUnlocks(store, ids, new Date(Date.now()).toISOString());
	if (!added.length) return added;
	store.queue.push(...added);
	save(store);
	// A hidden tab keeps its toasts for when someone is looking (see the visibilitychange handler).
	if (!defer && !document.hidden) flushToasts();
	if (onAchievementsPage) renderAchievementsPage();
	return added;
}

// ─── Toasts ─────────────────────────────────────────────────────────────────

let toastHost = null;

function flushToasts() {
	const store = load();
	if (!store.queue.length) return;
	const ids = store.queue.splice(0);
	save(store);
	if (!toastHost || !toastHost.isConnected) {
		// The live region exists before anything goes in it, so screen readers announce the toasts.
		toastHost = h('div', { class: 'dl-toasts', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
		document.body.append(toastHost);
	}
	ids.forEach((id, i) => window.setTimeout(() => showToast(id), 150 + i * 650));
}

function showToast(id) {
	const a = BY_ID.get(id);
	if (!a || !toastHost) return;
	const close = h('button', { class: 'dl-toast-close', type: 'button', 'aria-label': 'Dismiss' }, '×');
	const toast = h(
		'div',
		{ class: 'dl-toast' },
		h('span', { class: 'dl-toast-emoji', 'aria-hidden': 'true' }, a.emoji),
		h(
			'div',
			{ class: 'dl-toast-body' },
			h('p', { class: 'dl-toast-kicker' }, 'Achievement unlocked'),
			h('p', { class: 'dl-toast-name' }, h('a', { href: '/achievements' }, a.name)),
			h('p', { class: 'dl-toast-desc' }, a.description),
		),
		close,
	);
	let timer = 0;
	let held = false;
	const dismiss = () => {
		clearTimeout(timer);
		if (!toast.isConnected) return;
		if (reducedMotion()) {
			toast.remove();
			return;
		}
		toast.classList.add('is-leaving');
		window.setTimeout(() => toast.remove(), 260);
	};
	const arm = () => {
		clearTimeout(timer);
		if (!held) timer = window.setTimeout(dismiss, TOAST_MS);
	};
	// Hovering or focusing a toast keeps it, so nobody has to read against the clock.
	const hold = () => {
		held = true;
		clearTimeout(timer);
	};
	const release = () => {
		held = toast.matches(':hover') || toast.contains(document.activeElement);
		arm();
	};
	toast.addEventListener('pointerenter', hold);
	toast.addEventListener('pointerleave', release);
	toast.addEventListener('focusin', hold);
	toast.addEventListener('focusout', () => window.setTimeout(release, 0));
	close.addEventListener('click', dismiss);
	toastHost.append(toast);
	while (toastHost.childElementCount > 3 && toastHost.firstElementChild) toastHost.firstElementChild.remove();
	arm();
}

// ─── Visits, vibes, Konami, /live ───────────────────────────────────────────

function recordVisit(path) {
	const store = load();
	const now = new Date(Date.now());
	const today = localYmd(now);
	let dirty = false;
	if (!store.pages.includes(path)) {
		store.pages = [...store.pages, path].slice(-MAX_PAGES);
		dirty = true;
	}
	if (!store.days.includes(today)) {
		store.days = [...store.days, today].slice(-MAX_DAYS);
		dirty = true;
	}
	if (dirty) save(store);
	unlock(visitAchievements({ checks: readChecks(), days: store.days, pages: store.pages, hour: now.getHours(), status: currentStatus(), path }));
	if (!document.hidden) flushToasts(); // anything left over from the previous page
}

function onClickCapture(event) {
	const target = event.target instanceof Element ? event.target : null;
	if (!target) return;
	// Capture phase: this runs before app.js's handler marks the buttons as cooling down.
	const vibe = target.closest('[data-vibe]');
	if (vibe && vibe.getAttribute('aria-disabled') !== 'true') {
		const store = load();
		store.vibes += 1;
		save(store);
		unlock(vibeAchievements(store.vibes));
	}
	const link = target.closest('a[href]');
	if (link instanceof HTMLAnchorElement) {
		try {
			const url = new URL(link.href, window.location.href);
			if (url.origin === window.location.origin && isLivePath(normalisePath(url.pathname))) unlock(['terminal'], { defer: true });
		} catch {
			/* not a URL we care about */
		}
	}
}

// ─── Status changes, away title, night feed ─────────────────────────────────

const away = { saved: '', lastSet: '', timer: 0, flashing: false };

function setTitle(text) {
	away.lastSet = text;
	document.title = text;
}

function stopFlash() {
	clearInterval(away.timer);
	away.flashing = false;
}

function awayHide() {
	away.saved = document.title;
	setTitle(awayTitle(currentStatus(), siteName()));
}

function awayShow() {
	stopFlash();
	// Put the title back, unless app.js has written a newer one in the meantime.
	if (away.saved && document.title === away.lastSet) document.title = away.saved;
	away.saved = '';
	away.lastSet = '';
}

/** app.js rewrites the title on some live messages; while hidden, keep its version for later. */
function awayReassert() {
	if (!away.lastSet || document.title === away.lastSet) return;
	away.saved = document.title;
	if (!away.flashing) setTitle(awayTitle(currentStatus(), siteName()));
}

function awayStatusChanged(status) {
	if (!document.hidden || !away.lastSet) return;
	if (document.title !== away.lastSet) away.saved = document.title;
	const flash = flashTitle(status, siteName());
	stopFlash();
	if (!flash) {
		setTitle(awayTitle(status, siteName()));
		return;
	}
	// Flash until the tab is looked at. Background tabs run timers at most once a second.
	away.flashing = true;
	let on = true;
	setTitle(flash);
	away.timer = window.setInterval(() => {
		on = !on;
		setTitle(on ? flash : awayTitle(currentStatus(), siteName()));
	}, 1000);
}

let nightTimer = 0;
let whisper = null;

function updateNightFeed() {
	clearTimeout(nightTimer);
	const status = currentStatus();
	const on = isNightFeed(status, londonHour(new Date(Date.now())));
	document.body.classList.toggle('night-feed', on);
	if (on && !whisper) {
		whisper = h(
			'p',
			{ class: 'dl-whisper', role: 'note' },
			h('span', { 'aria-hidden': 'true' }, '🤫 '),
			"shh. It's night-feed o'clock in London. Lights dimmed; please check quietly.",
		);
		document.body.append(whisper);
		unlock(['night-feed']);
	} else if (!on && whisper) {
		whisper.remove();
		whisper = null;
	}
	// London's offset is whole hours, so its hours turn over with UTC's: one check per hour.
	if (status === 'yes') nightTimer = window.setTimeout(updateNightFeed, 3_600_000 - (Date.now() % 3_600_000) + 1000);
}

function watchStatus(isHome) {
	let lastStatus = currentStatus();
	let lastDue = root.dataset.dueDate || '';
	// app.js sets data-status on every state it applies (WebSocket or polling), after the title.
	new MutationObserver(() => {
		const status = currentStatus();
		if (status !== lastStatus) {
			lastStatus = status;
			if (status === 'soon' || status === 'yes') unlock(['was-here']);
			if (status === 'yes') unlock(['confirmed']);
			awayStatusChanged(status);
			updateNightFeed();
			saverWord();
		} else if (document.hidden) {
			awayReassert();
		}
		const due = root.dataset.dueDate || '';
		if (due !== lastDue) {
			lastDue = due;
			if (isHome) renderCalendars();
		}
	}).observe(root, { attributes: true, attributeFilter: ['data-status', 'data-due-date'] });
}

// ─── Screensaver ────────────────────────────────────────────────────────────

const SAVER_COLOURS = ['#ff5fa2', '#3fd58a', '#ffb000', '#82a8ff', '#ff7448', '#b388ff', '#f6f1e6', '#5ce1e6'];
const idle = { last: Date.now(), timer: 0 };
const saver = { running: false, el: null, logo: null, answer: null, raf: 0, x: 0, y: 0, vx: 0, vy: 0, maxX: 0, maxY: 0, lastT: 0, colour: -1, lastColourAt: 0, lastCornerAt: 0, startedAt: 0, origin: null };

function scheduleIdle() {
	clearTimeout(idle.timer);
	idle.timer = window.setTimeout(checkIdle, Math.max(1000, IDLE_MS - (Date.now() - idle.last)));
}

function checkIdle() {
	if (saver.running) return;
	if (Date.now() - idle.last < IDLE_MS) {
		scheduleIdle();
		return;
	}
	const busy = document.hidden || torch.active || document.fullscreenElement || document.querySelector('dialog[open]') || reducedMotion();
	if (busy || !startScreensaver()) {
		idle.last = Date.now();
		scheduleIdle();
	}
}

function onInput(event) {
	idle.last = Date.now();
	if (!saver.running) return;
	if (event.type === 'pointermove') {
		// Mice jitter: only a real wiggle counts.
		if (!saver.origin) {
			saver.origin = { x: event.clientX, y: event.clientY };
			return;
		}
		if (Math.hypot(event.clientX - saver.origin.x, event.clientY - saver.origin.y) < 12) return;
	}
	stopScreensaver();
}

function measureSaver() {
	if (!saver.logo) return;
	saver.maxX = Math.max(0, window.innerWidth - saver.logo.offsetWidth);
	saver.maxY = Math.max(0, window.innerHeight - saver.logo.offsetHeight);
	saver.x = Math.min(saver.x, saver.maxX);
	saver.y = Math.min(saver.y, saver.maxY);
}

function nextSaverColour() {
	let next = Math.floor(Math.random() * SAVER_COLOURS.length);
	if (next === saver.colour) next = (next + 1) % SAVER_COLOURS.length;
	saver.colour = next;
	if (saver.logo) saver.logo.style.color = SAVER_COLOURS[next];
}

function saverWord() {
	if (saver.answer) saver.answer.textContent = currentWord();
	if (saver.running) measureSaver();
}

function startScreensaver() {
	saver.answer = h('span', { class: 'dl-saver-a' }, currentWord());
	saver.logo = h('div', { class: 'dl-saver-logo' }, h('span', { class: 'dl-saver-q' }, siteName()), saver.answer);
	saver.el = h('div', { class: 'dl-saver', 'aria-hidden': 'true' }, saver.logo, h('p', { class: 'dl-saver-hint' }, 'Screensaver. Any key or wiggle resumes the waiting.'));
	document.body.append(saver.el);
	measureSaver();
	// A space too small to bounce in would mean frantic colour changes: don't bother.
	if (saver.maxX < 60 || saver.maxY < 60) {
		saver.el.remove();
		saver.el = saver.logo = saver.answer = null;
		return false;
	}
	saver.running = true;
	saver.origin = null;
	saver.startedAt = Date.now();
	saver.x = Math.random() * saver.maxX;
	saver.y = Math.random() * saver.maxY;
	const speed = Math.min(220, Math.max(90, Math.min(window.innerWidth, window.innerHeight) / 4));
	saver.vx = speed * (Math.random() < 0.5 ? -1 : 1);
	saver.vy = speed * (Math.random() < 0.5 ? -1 : 1);
	saver.lastT = performance.now();
	saver.lastColourAt = 0;
	nextSaverColour();
	window.addEventListener('resize', measureSaver);
	saver.raf = window.requestAnimationFrame(saverFrame);
	return true;
}

function saverFrame(t) {
	if (!saver.running) return;
	const dt = Math.min(0.05, Math.max(0, (t - saver.lastT) / 1000));
	saver.lastT = t;
	const step = bounceStep(saver, dt, saver.maxX, saver.maxY);
	saver.x = step.x;
	saver.y = step.y;
	saver.vx = step.vx;
	saver.vy = step.vy;
	// At most one colour change per 400 ms, whatever the geometry: no strobing.
	if ((step.hitX || step.hitY) && t - saver.lastColourAt > 400) {
		saver.lastColourAt = t;
		nextSaverColour();
	}
	if (step.corner && t - saver.lastCornerAt > 1500) {
		saver.lastCornerAt = t;
		cornerHit();
	}
	saver.logo.style.transform = `translate3d(${saver.x.toFixed(1)}px, ${saver.y.toFixed(1)}px, 0)`;
	saver.raf = window.requestAnimationFrame(saverFrame);
}

/** A small local burst of confetti in the corner it hit (the full window.iszacka.celebrate is for YES). */
function cornerHit() {
	if (!saver.el) return;
	const cx = saver.x > saver.maxX / 2 ? window.innerWidth : 0;
	const cy = saver.y > saver.maxY / 2 ? window.innerHeight : 0;
	// Fire into the screen, away from the corner.
	const sx = cx ? -1 : 1;
	const sy = cy ? -1 : 1;
	const burst = h('div', { class: 'dl-burst' });
	burst.style.left = `${cx}px`;
	burst.style.top = `${cy}px`;
	for (let i = 0; i < 36; i++) {
		const theta = Math.random() * (Math.PI / 2);
		const dist = 80 + Math.random() * 220;
		const bit = h('span');
		bit.style.setProperty('--dx', `${(Math.cos(theta) * dist * sx).toFixed(0)}px`);
		bit.style.setProperty('--dy', `${(Math.sin(theta) * dist * sy).toFixed(0)}px`);
		bit.style.setProperty('--r', `${Math.round(Math.random() * 720 - 360)}deg`);
		bit.style.background = SAVER_COLOURS[i % SAVER_COLOURS.length];
		burst.append(bit);
	}
	saver.el.append(burst);
	window.setTimeout(() => burst.remove(), 1400);
	const label = h('p', { class: 'dl-saver-corner' }, 'CORNER!');
	saver.el.append(label);
	window.setTimeout(() => label.remove(), 1600);
	unlock(['corner']);
}

function stopScreensaver() {
	if (!saver.running) return;
	saver.running = false;
	window.cancelAnimationFrame(saver.raf);
	window.removeEventListener('resize', measureSaver);
	const el = saver.el;
	saver.el = saver.logo = saver.answer = null;
	if (el) {
		// Keep catching the pointer for a moment, so the wake-up tap doesn't click what's underneath.
		el.classList.add('is-leaving');
		window.setTimeout(() => el.remove(), 250);
	}
	if (Date.now() - saver.startedAt >= 3000) unlock(['screensaver']);
	idle.last = Date.now();
	scheduleIdle();
}

function setupScreensaver() {
	const opts = { passive: true, capture: true };
	for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) window.addEventListener(type, onInput, opts);
	const motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
	motion?.addEventListener?.('change', () => {
		if (motion.matches) stopScreensaver();
	});
	scheduleIdle();
}

// ─── Torch mode ─────────────────────────────────────────────────────────────

const torch = { active: false, el: null, word: null, code: null, timer: 0, steps: [], i: 0, button: null, wake: null };

function insertTorchButton() {
	const cluster = document.getElementById('panel-instruments')?.closest('.panel')?.querySelector('.cluster');
	if (!cluster || cluster.querySelector('[data-torch]')) return;
	const button = h('button', { class: 'btn', type: 'button', 'data-torch': true }, h('span', { 'aria-hidden': 'true' }, '🔦'), ' Torch mode');
	button.addEventListener('click', () => confirmTorch(button));
	cluster.append(button);
}

const TORCH_NOTICE =
	'Torch mode turns your screen into a lamp and flashes the answer in Morse code: full-screen white flashes, never more than two a second (the safety limit is three). If flashing light affects you, please give this one a miss.';

function confirmTorch(button) {
	if (typeof HTMLDialogElement !== 'function' || typeof HTMLDialogElement.prototype.showModal !== 'function') {
		if (window.confirm(`Photosensitivity notice. ${TORCH_NOTICE}`)) startTorch(button);
		return;
	}
	const cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, 'Cancel');
	const start = h('button', { class: 'btn btn-primary', type: 'button' }, 'Start flashing');
	const dialog = h(
		'dialog',
		{ class: 'dl-dialog', 'aria-labelledby': 'dl-torch-title', 'aria-describedby': 'dl-torch-desc' },
		h(
			'div',
			{ class: 'dl-dialog-inner' },
			h('p', { class: 'kicker' }, h('span', { 'aria-hidden': 'true' }, '⚠️ '), 'Photosensitivity notice'),
			h('h2', { class: 'dl-dialog-title', id: 'dl-torch-title' }, 'Torch mode'),
			h('p', { id: 'dl-torch-desc' }, TORCH_NOTICE),
			h('p', { class: 'tiny muted' }, 'Press Esc or tap anywhere to stop. Best enjoyed from a window, pointed at the neighbours.'),
			h('div', { class: 'cluster' }, start, cancel),
		),
	);
	cancel.addEventListener('click', () => dialog.close());
	start.addEventListener('click', () => {
		dialog.close();
		startTorch(button); // still inside the click, so fullscreen is allowed
	});
	dialog.addEventListener('close', () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
	cancel.focus();
}

function startTorch(button) {
	if (torch.active) return;
	stopScreensaver();
	torch.active = true;
	torch.button = button;
	torch.word = h('p', { class: 'dl-torch-word' }, currentWord());
	torch.code = h('p', { class: 'dl-torch-morse mono' }, morse(currentWord()));
	torch.el = h(
		'div',
		{ class: 'dl-torch', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Torch mode: the answer in Morse code. Press Escape or tap to stop.', tabindex: '-1' },
		torch.word,
		torch.code,
		h('p', { class: 'dl-torch-hint' }, 'Esc or tap to stop'),
	);
	torch.el.addEventListener('click', stopTorch);
	document.addEventListener('keydown', torchKey, true);
	document.addEventListener('fullscreenchange', torchFullscreenChange);
	document.body.append(torch.el);
	torch.el.focus();
	try {
		const request = torch.el.requestFullscreen || torch.el.webkitRequestFullscreen;
		const pending = request?.call(torch.el, { navigationUI: 'hide' });
		pending?.catch?.(() => {});
	} catch {
		/* no fullscreen (iPhone Safari): the overlay still fills the window */
	}
	navigator.wakeLock
		?.request('screen')
		.then((lock) => {
			if (torch.active) torch.wake = lock;
			else lock.release().catch(() => {});
		})
		.catch(() => {});
	unlock(['torchbearer']);
	announce('Torch mode on. Press Escape or tap to stop.');
	torch.steps = [{ on: false, ms: 900 }]; // a beat before the first flash
	torch.i = 0;
	torchStep();
}

function torchStep() {
	if (!torch.active || !torch.el) return;
	if (torch.i >= torch.steps.length) {
		const word = currentWord();
		torch.word.textContent = word;
		torch.code.textContent = morse(word);
		torch.steps = morseTimeline(word);
		torch.i = 0;
	}
	const step = torch.steps[torch.i++];
	torch.el.classList.toggle('is-on', step.on);
	// setTimeout only ever runs late, so a gap can stretch but never shrink below one unit.
	torch.timer = window.setTimeout(torchStep, step.ms);
}

function torchKey(event) {
	if (!torch.active) return;
	if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
		event.preventDefault();
		event.stopPropagation();
		stopTorch();
	} else if (event.key === 'Tab') {
		// A modal overlay: keep focus on it rather than on the page hidden underneath.
		event.preventDefault();
		torch.el?.focus();
	}
}

function torchFullscreenChange() {
	if (torch.active && !document.fullscreenElement) stopTorch();
}

function stopTorch() {
	if (!torch.active) return;
	torch.active = false;
	clearTimeout(torch.timer);
	document.removeEventListener('keydown', torchKey, true);
	document.removeEventListener('fullscreenchange', torchFullscreenChange);
	const el = torch.el;
	torch.el = torch.word = torch.code = null;
	if (el && document.fullscreenElement === el) document.exitFullscreen?.().catch?.(() => {});
	el?.remove();
	torch.wake?.release?.().catch?.(() => {});
	torch.wake = null;
	torch.button?.focus();
	announce('Torch mode off.');
	idle.last = Date.now();
}

// ─── The due date in other calendars ────────────────────────────────────────

const INTL_CALENDARS = [
	{ name: 'Hebrew', calendars: ['hebrew'] },
	{ name: 'Islamic (Umm al-Qura)', calendars: ['islamic-umalqura', 'islamic'] },
	{ name: 'Persian (Solar Hijri)', calendars: ['persian'] },
];

function intlDate(calendar, date, options) {
	try {
		const format = new Intl.DateTimeFormat(`en-GB-u-ca-${calendar}`, { timeZone: 'UTC', ...options });
		// An unsupported calendar quietly falls back to Gregorian: treat that as "not available".
		return format.resolvedOptions().calendar === calendar ? format : null;
	} catch {
		return null;
	}
}

function chineseText(date) {
	const format = intlDate('chinese', date, { year: 'numeric', month: 'long', day: 'numeric' });
	if (!format) return '';
	const parts = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
	if (!parts.month || !parts.day) return '';
	const animal = chineseYear(parts.yearName || '');
	const year = animal ? `year of the ${animal}` : parts.relatedYear ? `year ${parts.relatedYear}` : '';
	return `Day ${parts.day} of the ${parts.month}${year ? `, ${year}` : ''}`;
}

export function calendarRows(ymd) {
	const p = ymdParts(ymd);
	if (!p) return [];
	const date = new Date(Date.UTC(p.y, p.m - 1, p.d, 12));
	const rows = [];
	const tryRow = (name, fn) => {
		try {
			const value = fn();
			if (value) rows.push({ name, value });
		} catch {
			/* that calendar is having a day off */
		}
	};
	for (const { name, calendars } of INTL_CALENDARS) {
		tryRow(name, () => {
			for (const calendar of calendars) {
				const format = intlDate(calendar, date, { year: 'numeric', month: 'long', day: 'numeric' });
				if (format) return format.format(date);
			}
			return '';
		});
	}
	tryRow('Chinese', () => chineseText(date));
	tryRow('Julian (Old Style)', () => julianText(ymd));
	tryRow('Discordian', () => discordian(ymd));
	tryRow('Stardate', () => stardateText(ymd));
	const unix = unixTimes(ymd);
	tryRow('Unix seconds', () => unix?.seconds);
	tryRow('Unix milliseconds', () => unix?.milliseconds);
	tryRow('Unix nanoseconds', () => unix?.nanoseconds);
	return rows;
}

function renderCalendars() {
	const due = root.dataset.dueDate || '';
	let panel = document.querySelector('[data-delights-calendars]');
	if (!isYmd(due)) {
		if (panel) panel.hidden = true;
		return;
	}
	const grid = document.querySelector('.mc-grid');
	if (!panel) {
		if (!grid) return;
		panel = h(
			'section',
			{ class: 'panel span-12 dl-calendars', 'aria-labelledby': 'panel-calendars', 'data-delights-calendars': true },
			h(
				'header',
				{ class: 'panel-head' },
				h('h3', { class: 'panel-label', id: 'panel-calendars' }, h('span', { class: 'panel-ch' }, 'CH-16'), ' Due date, other calendars'),
				h('span', { class: 'led', 'aria-hidden': 'true' }),
			),
			h('div', { class: 'panel-body stack' }),
		);
		// CH-16 comes after the last numbered panel (the social group's CH-12 to CH-15).
		grid.append(panel);
	}
	const body = panel.querySelector('.panel-body');
	const rows = calendarRows(due);
	body.replaceChildren(
		h('p', null, 'Due ', h('strong', null, gregorianLong(due)), ', by the Gregorian calendar. For anyone keeping time some other way:'),
		h('dl', { class: 'dl-cal-grid' }, ...rows.map((r) => h('div', { class: 'dl-cal' }, h('dt', null, r.name), h('dd', null, r.value)))),
		h(
			'p',
			{ class: 'tiny muted' },
			"The Hebrew, Islamic, Persian and Chinese dates come from your browser's own calendars (an Islamic month can begin a day earlier or later than the tables say, moon permitting). Julian and Discordian are worked out here. The stardate uses the common fan formula for TNG-era stardates (1,000 a year, from stardate 0 at the start of 2323, as popularised by TrekGuide), hence the minus sign. The Unix times count from 1 January 1970 to midnight UTC at the start of the due date. The due date remains approximate in every calendar known to science.",
		),
	);
	panel.hidden = false;
}

// ─── /achievements ──────────────────────────────────────────────────────────

let earnedFormat = null;

function formatEarned(iso) {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return '';
	try {
		earnedFormat ??= new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
		return earnedFormat.format(new Date(t));
	} catch {
		return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
	}
}

export function summaryLine(earned, total) {
	if (earned === 0) return 'Nothing yet. Everyone starts somewhere; most people start by checking again.';
	if (earned >= total) return 'Every single one. There is no prize. There was never going to be a prize.';
	if (earned < 4) return 'A promising start. Keep refreshing, purely for the trophies.';
	if (earned < total / 2) return 'Respectable. Some would say concerning.';
	return 'Seriously committed. Please also remember to drink water.';
}

function achievementCard(a, at) {
	const earned = Boolean(at);
	return h(
		'li',
		{ class: `card dl-ach ${earned ? 'is-earned' : 'is-locked'}` },
		h('span', { class: 'dl-ach-emoji', 'aria-hidden': 'true' }, earned ? a.emoji : '🔒'),
		h(
			'div',
			{ class: 'dl-ach-text' },
			h('h3', { class: 'dl-ach-name' }, a.name, earned ? null : h('span', { class: 'sr-only' }, ' (locked)')),
			h('p', { class: 'dl-ach-desc' }, earned || !a.secret ? a.description : a.hint || 'A secret.'),
			earned ? h('p', { class: 'tiny muted' }, 'Earned ', h('time', { datetime: at }, formatEarned(at))) : null,
		),
	);
}

function renderAchievementsPage() {
	const host = document.querySelector('[data-achievements]');
	if (!host) return;
	const store = load();
	const earned = ACHIEVEMENTS.filter((a) => store.unlocked[a.id]).sort((a, b) => (store.unlocked[b.id] > store.unlocked[a.id] ? 1 : -1));
	const locked = ACHIEVEMENTS.filter((a) => !store.unlocked[a.id]);
	const total = ACHIEVEMENTS.length;
	const pct = Math.round((earned.length / total) * 100);
	const fill = h('span');
	fill.style.width = `${pct}%`;

	const reset = h('button', { class: 'btn btn-ghost', type: 'button' }, 'Forget my achievements');
	let disarm = 0;
	reset.addEventListener('click', () => {
		if (reset.dataset.armed !== '1') {
			reset.dataset.armed = '1';
			reset.textContent = 'Really? Press again to forget them all';
			disarm = window.setTimeout(() => {
				reset.dataset.armed = '';
				reset.textContent = 'Forget my achievements';
			}, 5000);
			return;
		}
		clearTimeout(disarm);
		save(blankStore());
		renderAchievementsPage();
		announce('Achievements forgotten. The trophy cabinet is empty.');
		document.querySelector('[data-achievements] .dl-ach-summary')?.focus();
	});

	const children = [
		storageOk
			? null
			: h(
					'div',
					{ class: 'notice', role: 'status' },
					"This browser isn't letting the site store anything (private browsing, perhaps), so achievements only last as long as this tab.",
				),
		h(
			'div',
			{ class: 'card stack dl-ach-summary', tabindex: '-1' },
			h('p', { class: 'big-number' }, String(earned.length), h('span', { class: 'unit' }, ` / ${total}`)),
			h('p', null, `${earned.length === 1 ? 'achievement' : 'achievements'} earned in this browser. ${summaryLine(earned.length, total)}`),
			h('div', { class: 'meter', role: 'img', 'aria-label': `${pct}% complete` }, fill),
		),
		h('h2', null, 'Earned'),
		earned.length
			? h('ul', { class: 'grid dl-ach-grid' }, ...earned.map((a) => achievementCard(a, store.unlocked[a.id])))
			: h('p', { class: 'empty' }, 'No trophies yet. Reload the home page a few times; it is, after all, what you came here to do.'),
		h('h2', null, locked.length ? 'Still locked' : 'Still locked: nothing'),
		locked.length ? h('ul', { class: 'grid dl-ach-grid' }, ...locked.map((a) => achievementCard(a, null))) : null,
		h(
			'div',
			{ class: 'cluster dl-ach-reset' },
			reset,
			h('p', { class: 'tiny muted' }, 'The ones based on how often you check come straight back: the home page keeps its own count.'),
		),
	];
	// replaceChildren() would print a null as the text "null": drop the optional ones.
	host.replaceChildren(...children.filter(Boolean));
}

// ─── Boot ───────────────────────────────────────────────────────────────────

function whenIdle(fn) {
	const run = () => {
		try {
			fn();
		} catch (err) {
			console.error('delights.js: deferred step failed', err);
		}
	};
	if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 2000 });
	else window.setTimeout(run, 200);
}

function boot() {
	root = document.documentElement;
	const path = normalisePath(window.location.pathname);
	const isHome = root.dataset.page === 'home';
	onAchievementsPage = path === '/achievements';
	let hiddenAt = 0;

	const steps = [
		() => recordVisit(path),
		() => document.addEventListener('iszacka:konami', () => unlock(['konami'])),
		() => document.addEventListener('click', onClickCapture, true),
		() =>
			document.addEventListener('visibilitychange', () => {
				if (document.hidden) {
					hiddenAt = Date.now();
					awayHide();
					stopScreensaver();
					stopTorch();
					return;
				}
				awayShow();
				const ids = [];
				if (hiddenAt && Date.now() - hiddenAt >= BACK_AGAIN_MS) ids.push('back-again');
				if (Date.now() - bootAt >= PATIENCE_MS) ids.push('patience');
				hiddenAt = 0;
				unlock(ids);
				flushToasts();
				updateNightFeed();
				if (isHome) scheduleIdle();
			}),
		() => watchStatus(isHome),
		() => {
			// Opened in a background tab: no visibilitychange until it's looked at, so start away.
			if (document.hidden) awayHide();
		},
		() => window.setTimeout(() => unlock(['patience']), PATIENCE_MS),
		() => updateNightFeed(),
		() => {
			if (isHome) insertTorchButton();
		},
		() => {
			if (isHome) setupScreensaver();
		},
		() => {
			if (isHome) whenIdle(renderCalendars);
		},
		() => {
			if (onAchievementsPage) renderAchievementsPage();
		},
		() =>
			window.addEventListener('storage', (event) => {
				if (event.key === STORE_KEY && onAchievementsPage) renderAchievementsPage();
			}),
	];
	for (const step of steps) {
		try {
			step();
		} catch (err) {
			console.error('delights.js: boot step failed', err);
		}
	}
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.documentElement) boot();
