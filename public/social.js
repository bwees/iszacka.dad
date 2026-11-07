// iszacka.dad live & social panels on the home page: DADCON, the global anxiety meter, the live
// world map, the "who just checked" feed and milestone toasts. An ES module with no
// dependencies, loaded after /app.js; it listens to app.js's 'iszacka:live' events (one per live
// message) and uses window.iszacka for announcements. The server already rendered every panel,
// so all of this is enhancement: without it the panels still say something sensible.

const doc = document;
const root = doc.documentElement;
const $ = (selector, scope = doc) => scope.querySelector(selector);
const $$ = (selector, scope = doc) => Array.from(scope.querySelectorAll(selector));
const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const reducedMotion = () => Boolean(motionQuery && motionQuery.matches);
const COUNTRY_RE = /^(?:[A-Z]{2}|T1)$/;
const STATUSES = ['no', 'soon', 'yes'];

const status = () => {
	const fromApp = window.iszacka && typeof window.iszacka.status === 'function' ? window.iszacka.status() : null;
	if (STATUSES.includes(fromApp)) return fromApp;
	return STATUSES.includes(root.dataset.status) ? root.dataset.status : 'no';
};
const announce = (text) => {
	if (window.iszacka && typeof window.iszacka.announce === 'function') window.iszacka.announce(text);
};

// Built once each, on first use (Intl objects aren't free, even in a browser).
let numbers = null;
const formatNumber = (n) => {
	numbers ??= new Intl.NumberFormat('en-GB');
	return numbers.format(n);
};
let clockFormat = null;
const clockTime = (date) => {
	clockFormat ??= new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	return clockFormat.format(date);
};
let londonDay = null;
const londonToday = () => {
	londonDay ??= new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
	return londonDay.format(new Date());
};

// ─── Country names (ISO 3166-1 alpha-2 → "in the UK") ───────────────────────

let regionNames;
function regionName(code) {
	if (regionNames === undefined) {
		try {
			regionNames = new Intl.DisplayNames(['en-GB'], { type: 'region' });
		} catch {
			regionNames = null;
		}
	}
	try {
		return (regionNames && regionNames.of(code)) || code;
	} catch {
		return code;
	}
}

const SHORT_NAMES = { GB: 'UK', US: 'US', AE: 'UAE' };
const DEFINITE = new Set(['GB', 'US', 'AE', 'NL', 'PH', 'BS', 'GM', 'CD', 'CG', 'DO', 'CF', 'KY', 'MV', 'MH', 'SB', 'SC', 'FK', 'FO', 'VA', 'IM', 'TC', 'VG', 'VI', 'KM', 'CZ']);

/** Where someone is, as a phrase: "in the UK", "in Portugal", "on Tor", "somewhere undisclosed". */
export function where(code) {
	if (code === 'T1') return 'on Tor';
	if (!COUNTRY_RE.test(code) || code === 'XX') return 'somewhere undisclosed';
	const name = SHORT_NAMES[code] || regionName(code);
	return `in ${DEFINITE.has(code) ? 'the ' : ''}${name}`;
}

const ordinal = (n) => {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return 'th';
	return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
};

const sanitiseItems = (items) =>
	(Array.isArray(items) ? items : [])
		.filter((it) => it && typeof it.country === 'string' && COUNTRY_RE.test(it.country) && Number.isInteger(it.n) && it.n > 0)
		.slice(0, 12);

// ─── DADCON ─────────────────────────────────────────────────────────────────
// Mirrors dadconLevel() in src/lib/dadcon.ts.

const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const ymdUtc = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));

export function dadconLevel(s, dueDate, today) {
	if (s === 'yes') return 0;
	if (s === 'soon') return 1;
	if (!isYmd(dueDate) || !isYmd(today)) return 5;
	const days = Math.round((ymdUtc(dueDate) - ymdUtc(today)) / 86_400_000);
	if (days < 0) return 2;
	if (days <= 7) return 3;
	if (days <= 28) return 4;
	return 5;
}

function renderDadcon() {
	const panel = $('[data-dadcon]');
	if (!panel) return;
	const level = dadconLevel(status(), root.dataset.dueDate || null, londonToday());
	const previous = Number(panel.dataset.level);
	if (previous === level) return;
	const tile = $(`[data-dc="${level}"]`, panel);
	if (!tile) return;
	panel.dataset.level = String(level);
	for (const t of $$('[data-dc]', panel)) {
		const active = t === tile;
		t.classList.toggle('is-active', active);
		if (active) t.setAttribute('aria-current', 'step');
		else t.removeAttribute('aria-current');
	}
	const readout = $('[data-dadcon-readout]', panel);
	if (readout && tile.dataset.headline) readout.textContent = tile.dataset.headline;
	const desc = $('[data-dadcon-desc]', panel);
	if (desc && tile.dataset.desc) desc.textContent = tile.dataset.desc;
	if (Number.isFinite(previous) && level < previous) {
		panel.classList.remove('is-escalating');
		void panel.offsetWidth; // restart the animation
		panel.classList.add('is-escalating');
		announce(`${tile.dataset.headline || `DADCON ${level}`}.`);
	}
}

function setupDadcon() {
	if (!$('[data-dadcon]')) return;
	// app.js mirrors every state change (live or polled) onto <html>, so watching it is enough.
	new MutationObserver(renderDadcon).observe(root, { attributes: true, attributeFilter: ['data-status', 'data-due-date'] });
	// London's date moves on at midnight whether or not anything else happens.
	window.setInterval(renderDadcon, 60_000);
	renderDadcon();
}

// ─── Global anxiety meter ───────────────────────────────────────────────────
// gaugeAngle mirrors src/lib/social.ts.

const ANXIETY_LEVELS = ['calm', 'elevated', 'frantic', 'meltdown'];
const ANXIETY_STARTS = [0, 3, 15, 50, 100]; // checks in five minutes

export function gaugeAngle(level, perMinute) {
	const count = Math.max(0, (Number(perMinute) || 0) * 5);
	const index = Math.max(0, ANXIETY_LEVELS.indexOf(level));
	const lo = ANXIETY_STARTS[index];
	const hi = ANXIETY_STARTS[index + 1];
	const within = Math.min(1, Math.max(0, (count - lo) / (hi - lo || 1)));
	return Math.round((-90 + 45 * (index + 0.1 + within * 0.8)) * 10) / 10;
}

export function formatRate(perMinute) {
	if (!Number.isFinite(perMinute) || perMinute <= 0) return '0';
	const tenths = Math.round(perMinute * 10);
	return tenths % 10 ? `${formatNumber(Math.floor(tenths / 10))}.${tenths % 10}` : formatNumber(tenths / 10);
}

let anxietyCopy = null;
function setAnxiety(reading) {
	const panel = $('[data-anxiety]');
	if (!panel || !reading || !ANXIETY_LEVELS.includes(reading.level)) return;
	const perMinute = Number(reading.perMinute);
	if (anxietyCopy === null) {
		try {
			anxietyCopy = JSON.parse(panel.dataset.anxietyCopy || '{}');
		} catch {
			anxietyCopy = {};
		}
	}
	const copy = anxietyCopy[reading.level] || {};
	panel.dataset.level = reading.level;
	panel.style.setProperty('--angle', `${gaugeAngle(reading.level, perMinute)}deg`);
	const label = $('[data-anxiety-label]', panel);
	if (label && copy.label) label.textContent = copy.label;
	const rate = $('[data-anxiety-rate]', panel);
	if (rate) rate.textContent = formatRate(perMinute);
	const desc = $('[data-anxiety-desc]', panel);
	if (desc && copy.description) desc.textContent = copy.description;
}

// ─── Live world map ─────────────────────────────────────────────────────────

const map = {
	el: null,
	stage: null,
	svg: null,
	width: 1000,
	height: 435,
	visible: false,
	loading: false,
	/** ISO code → the shapes (paths, or dots for the smallest countries) drawn for it. */
	shapes: new Map(),
	/** ISO code → all-time checks (from /api/countries, plus what the feed has seen since). */
	counts: new Map(),
	max: 0,
	countsLoaded: false,
};

function setupMap() {
	map.el = $('[data-world-map]');
	if (!map.el) return;
	map.stage = $('[data-wm-stage]', map.el);
	if (!map.stage || !('DOMParser' in window)) return;
	const fallback = $('.wm-fallback', map.stage);
	if (fallback) fallback.textContent = 'The map unfolds when you scroll down to it.';
	if (!('IntersectionObserver' in window)) {
		map.visible = true;
		loadMap();
		return;
	}
	// Below the fold, so only fetched when someone gets near it; then only animated while in view.
	const near = new IntersectionObserver(
		(entries) => {
			if (!entries.some((e) => e.isIntersecting)) return;
			near.disconnect();
			loadMap();
		},
		{ rootMargin: '400px 0px' },
	);
	near.observe(map.el);
	new IntersectionObserver((entries) => {
		for (const e of entries) map.visible = e.isIntersecting;
	}).observe(map.el);
}

async function loadMap() {
	if (map.loading || map.svg) return;
	map.loading = true;
	map.stage.dataset.state = 'loading';
	try {
		const res = await fetch(map.el.dataset.src || '/world-map.svg', { credentials: 'same-origin' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const parsed = new DOMParser().parseFromString(await res.text(), 'image/svg+xml');
		const svg = parsed.documentElement;
		if (!svg || svg.nodeName.toLowerCase() !== 'svg' || parsed.getElementsByTagName('parsererror').length) throw new Error('not an SVG');
		const node = doc.importNode(svg, true);
		node.removeAttribute('width');
		node.removeAttribute('height');
		const box = node.viewBox && node.viewBox.baseVal;
		if (box && box.width && box.height) {
			map.width = box.width;
			map.height = box.height;
		}
		for (const shape of node.querySelectorAll('[data-cc]')) {
			const code = shape.getAttribute('data-cc');
			if (!map.shapes.has(code)) map.shapes.set(code, []);
			map.shapes.get(code).push(shape);
		}
		const ripples = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
		ripples.setAttribute('class', 'wm-ripples');
		node.append(ripples);
		map.svg = node;
		map.stage.replaceChildren(node);
		map.stage.dataset.state = 'ready';
		shadeAll();
		loadCounts();
	} catch (err) {
		map.stage.dataset.state = 'error';
		const p = doc.createElement('p');
		p.className = 'wm-fallback';
		p.textContent = 'The map failed to unfold. Cartography is hard.';
		map.stage.replaceChildren(p);
		console.error('social.js: map failed', err);
	} finally {
		map.loading = false;
	}
}

async function loadCounts() {
	try {
		const res = await fetch('/api/countries', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		for (const row of Array.isArray(data && data.countries) ? data.countries : []) {
			if (row && typeof row.country === 'string' && COUNTRY_RE.test(row.country) && Number.isFinite(row.n) && row.n > 0) {
				// Keep anything the live feed added while this was in flight.
				map.counts.set(row.country, Math.max(row.n, map.counts.get(row.country) || 0));
			}
		}
		map.countsLoaded = true;
		shadeAll();
	} catch (err) {
		console.error('social.js: /api/countries failed', err);
	}
}

/** 0 (never) to 5 (the busiest), on a log scale, so one keen country doesn't wash out the rest. */
function heat(n) {
	if (!n || n <= 0 || map.max <= 0) return 0;
	return Math.max(1, Math.min(5, Math.ceil((5 * Math.log1p(n)) / Math.log1p(map.max))));
}

function shadeAll() {
	map.max = 0;
	for (const n of map.counts.values()) if (n > map.max) map.max = n;
	for (const [code, shapes] of map.shapes) {
		const h = String(heat(map.counts.get(code) || 0));
		for (const s of shapes) if (s.getAttribute('data-heat') !== h) s.setAttribute('data-heat', h);
	}
}

/** Where a country is on the map, in viewBox units: its label point, else the middle of its box. */
function anchor(code) {
	const shapes = map.shapes.get(code);
	const first = shapes && shapes[0];
	if (!first) return null;
	const x = Number(first.getAttribute('data-x') ?? first.getAttribute('cx'));
	const y = Number(first.getAttribute('data-y') ?? first.getAttribute('cy'));
	if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
	try {
		const b = first.getBBox();
		return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	} catch {
		return null;
	}
}

function pulseCountry(code) {
	const shapes = map.shapes.get(code);
	if (!map.svg || !shapes || !map.visible || doc.hidden) return;
	for (const s of shapes) {
		s.classList.remove('is-pulse');
		void s.getBoundingClientRect(); // restart the animation
		s.classList.add('is-pulse');
		window.setTimeout(() => s.classList.remove('is-pulse'), 1700);
	}
	if (reducedMotion()) return;
	const point = anchor(code);
	const layer = $('.wm-ripples', map.svg);
	if (!point || !layer || layer.childElementCount > 24) return;
	const ring = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
	ring.setAttribute('class', 'wm-ripple');
	ring.setAttribute('cx', String(point.x));
	ring.setAttribute('cy', String(point.y));
	ring.setAttribute('r', '6');
	ring.addEventListener('animationend', () => ring.remove(), { once: true });
	window.setTimeout(() => ring.remove(), 2500);
	layer.append(ring);
}

function countChecks(items) {
	let rescale = false;
	for (const { country, n } of items) {
		const total = (map.counts.get(country) || 0) + n;
		map.counts.set(country, total);
		if (total > map.max) rescale = true;
		else {
			const h = String(heat(total));
			for (const s of map.shapes.get(country) || []) s.setAttribute('data-heat', h);
		}
	}
	if (rescale) shadeAll();
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** A vibe takes off from the sender's country (or the middle of the map, if we don't know it). */
function floatVibe(emoji, country) {
	const layer = $('[data-wm-vibes]');
	if (!map.svg || !layer || !map.visible || doc.hidden || layer.childElementCount > 30) return;
	if (typeof emoji !== 'string' || emoji.length > 16 || !EMOJI_RE.test(emoji)) return;
	const point = (typeof country === 'string' && COUNTRY_RE.test(country) && anchor(country)) || { x: map.width / 2, y: map.height / 2 };
	const el = doc.createElement('span');
	el.className = 'wm-vibe';
	el.textContent = emoji;
	el.style.left = `${((point.x / map.width) * 100).toFixed(2)}%`;
	el.style.top = `${((point.y / map.height) * 100).toFixed(2)}%`;
	el.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 40)}px`);
	if (reducedMotion()) el.classList.add('is-static');
	el.addEventListener('animationend', () => el.remove(), { once: true });
	window.setTimeout(() => el.remove(), 4000);
	layer.append(el);
}

// ─── Who just checked ───────────────────────────────────────────────────────

const FEED_MAX = 8;
const TAILS = {
	no: ['Still no.', 'Still no.', 'Still no.', 'The answer remains no.', 'No. Again.'],
	soon: ['Not yet. Very nearly.', "Still not yet. It's happening, though."],
	yes: ['Yes! Still yes.', "It's yes. They can stop now."],
};

/** "3 people in the UK and 1 in Portugal just checked." */
export function feedSentence(items, more = 0) {
	const parts = items.map((item, i) => {
		const place = where(item.country);
		if (item.n === 1) return `${i === 0 ? 'Someone' : 'someone'} ${place}`;
		return i === 0 ? `${formatNumber(item.n)} people ${place}` : `${formatNumber(item.n)} ${place}`;
	});
	if (more > 0) parts.push(`${formatNumber(more)} elsewhere`);
	const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
	return `${list} just checked.`;
}

function tail() {
	const options = TAILS[status()] || TAILS.no;
	return options[Math.floor(Math.random() * options.length)];
}

function addFeedLine(items, more) {
	const list = $('[data-checkfeed]');
	if (!list || !items.length) return;
	const idle = $('[data-checkfeed-idle]', list);
	if (idle) idle.remove();
	const li = doc.createElement('li');
	li.className = 'cf-item is-new';
	const time = doc.createElement('time');
	const now = new Date();
	time.className = 'cf-time';
	time.dateTime = now.toISOString();
	time.textContent = clockTime(now);
	const text = doc.createElement('span');
	text.className = 'cf-text';
	text.textContent = `${feedSentence(items, more)} `;
	const tailEl = doc.createElement('span');
	tailEl.className = 'cf-tail';
	tailEl.textContent = tail();
	text.append(tailEl);
	li.append(time, text);
	list.prepend(li);
	while (list.children.length > FEED_MAX) list.lastElementChild.remove();
}

function setFeedIdle() {
	const idle = $('[data-checkfeed-idle]');
	if (!idle) return;
	const conn = root.dataset.conn;
	idle.textContent =
		conn === 'polling' || conn === 'offline'
			? 'Feed paused: no live connection, so no gossip. The answer above still updates.'
			: "Listening for checks. It's quiet. Too quiet.";
}

function setupFeed() {
	if (!$('[data-checkfeed]')) return;
	setFeedIdle();
	new MutationObserver(setFeedIdle).observe(root, { attributes: true, attributeFilter: ['data-conn'] });
}

// ─── Milestones: a toast and a small confetti burst ─────────────────────────

const BURST_COLOURS = ['#ffb000', '#14864a', '#e2491f', '#2257d8', '#ff5fa2', '#7c4dff', '#3fd58a'];

export function milestoneText(n, country) {
	const who = country === 'XX' || !COUNTRY_RE.test(country) ? 'Someone, somewhere,' : `Someone ${where(country)}`;
	return `${who} was the ${formatNumber(n)}${ordinal(n)} check!`;
}

function toast(text) {
	let el = $('.social-toast');
	if (!el) {
		el = doc.createElement('div');
		el.className = 'social-toast';
		el.setAttribute('aria-hidden', 'true'); // announced through the shared live region instead
		el.addEventListener('click', () => el.classList.remove('is-shown'));
		doc.body.append(el);
	}
	el.textContent = text;
	el.classList.remove('is-shown');
	void el.offsetWidth;
	el.classList.add('is-shown');
	window.clearTimeout(toast.timer);
	toast.timer = window.setTimeout(() => el.classList.remove('is-shown'), 7000);
}

/** A modest burst from the bottom of the screen: the full show is for the big YES. */
function burst() {
	if (reducedMotion() || doc.hidden || $('canvas.social-confetti') || $('canvas.celebration')) return;
	const canvas = doc.createElement('canvas');
	canvas.className = 'social-confetti';
	canvas.setAttribute('aria-hidden', 'true');
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	const width = window.innerWidth;
	const height = window.innerHeight;
	canvas.width = Math.floor(width * dpr);
	canvas.height = Math.floor(height * dpr);
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	doc.body.append(canvas);
	const rand = (a, b) => a + Math.random() * (b - a);
	const particles = [];
	const count = Math.min(110, Math.round(width / 9));
	for (let i = 0; i < count; i++) {
		const angle = rand(-Math.PI * 0.85, -Math.PI * 0.15);
		const speed = rand(6, 13);
		particles.push({
			x: width / 2 + rand(-40, 40),
			y: height - 40,
			vx: Math.cos(angle) * speed,
			vy: Math.sin(angle) * speed,
			rot: rand(0, Math.PI * 2),
			vr: rand(-0.25, 0.25),
			w: rand(5, 9),
			h: rand(8, 13),
			color: BURST_COLOURS[i % BURST_COLOURS.length],
		});
	}
	let started = 0;
	const frame = (now) => {
		started ||= now;
		const t = now - started;
		ctx.clearRect(0, 0, width, height);
		ctx.globalAlpha = t > 1800 ? Math.max(0, 1 - (t - 1800) / 700) : 1;
		for (const p of particles) {
			p.vy += 0.28;
			p.vx *= 0.99;
			p.x += p.vx;
			p.y += p.vy;
			p.rot += p.vr;
			ctx.save();
			ctx.translate(p.x, p.y);
			ctx.rotate(p.rot);
			ctx.fillStyle = p.color;
			ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
			ctx.restore();
		}
		if (t < 2500) window.requestAnimationFrame(frame);
		else canvas.remove();
	};
	window.requestAnimationFrame(frame);
}

function celebrateMilestone(n, country) {
	const text = milestoneText(n, country);
	announce(text);
	const show = () => {
		toast(text);
		burst();
	};
	if (!doc.hidden) {
		show();
		return;
	}
	// A background tab gets the toast when someone looks, if that's soon enough to still be news.
	const at = Date.now();
	const onVisible = () => {
		if (doc.hidden) return;
		doc.removeEventListener('visibilitychange', onVisible);
		if (Date.now() - at < 120_000) show();
	};
	doc.addEventListener('visibilitychange', onVisible);
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

function onLive(event) {
	const msg = event.detail;
	if (!msg || typeof msg !== 'object') return;
	switch (msg.type) {
		case 'hello':
			if (msg.anxiety) setAnxiety(msg.anxiety);
			break;
		case 'anxiety':
			setAnxiety(msg);
			break;
		case 'checkfeed': {
			const items = sanitiseItems(msg.items);
			const more = Number.isInteger(msg.more) && msg.more > 0 ? msg.more : 0;
			if (!items.length) break;
			addFeedLine(items, more);
			countChecks(items);
			for (const { country } of items) pulseCountry(country);
			break;
		}
		case 'milestone':
			if (Number.isSafeInteger(msg.n) && msg.n > 0) celebrateMilestone(msg.n, typeof msg.country === 'string' ? msg.country : 'XX');
			break;
		case 'vibes':
			floatVibe(msg.emoji, msg.country);
			break;
		default:
			break;
	}
}

function boot() {
	if (!$('[data-dadcon], [data-anxiety], [data-world-map], [data-checkfeed]')) return;
	for (const step of [setupDadcon, setupMap, setupFeed]) {
		try {
			step();
		} catch (err) {
			console.error(`social.js: ${step.name} failed`, err);
		}
	}
	doc.addEventListener('iszacka:live', (event) => {
		try {
			onLive(event);
		} catch (err) {
			console.error('social.js: live message failed', err);
		}
	});
}

boot();
