/*!
 * iszacka.dad embed (OWNER: feeds agent).
 *
 *   <script src="https://iszacka.dad/embed.js" data-theme="auto" data-size="medium" async></script>
 *
 * Renders a small "Is Zack a dad?" widget in a shadow DOM right after the script tag
 * (your styles and ours never meet), then polls /api/status (CORS) every 60 seconds,
 * pausing while the tab is hidden. Only the first fetch of a mount counts as someone checking;
 * the timer's refreshes ask /api/status?poll=1, which the "times checked" counter ignores.
 *
 * data-theme   auto | light | dark          (default auto: follows the reader's system)
 * data-size    small | medium | large       (default medium)
 * data-target  CSS selector to render into (default: right after this script tag)
 * data-link    "false" to render without the link back to the site
 *
 * Also used with data-mode="page" by the /embed iframe page, where it keeps the
 * server-rendered widget live instead of building a new one.
 */
(() => {
	'use strict';

	const REFRESH_MS = 60_000;
	const MAX_BACKOFF_MS = 10 * 60_000;
	const MIN_VISIBLE_REFRESH_MS = 10_000;
	const STATUSES = ['no', 'soon', 'yes'];
	const ANSWERS = { no: 'NO', soon: 'NOT YET', yes: 'YES' };

	const script = document.currentScript;
	if (!(script instanceof HTMLScriptElement) || script.hasAttribute('data-iszackadad-mounted')) return;
	script.setAttribute('data-iszackadad-mounted', '');

	let origin;
	try {
		origin = new URL(script.src, location.href).origin;
	} catch {
		return;
	}

	const londonDate = (iso) => {
		const t = Date.parse(iso);
		if (Number.isNaN(t)) return null;
		try {
			return new Date(t).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
		} catch {
			return new Date(t).toDateString();
		}
	};

	/** The small grey line under the answer. Mirrors embedMetaLine() in src/routes/feeds.ts. */
	const metaLine = (data) => {
		if (data.status === 'yes') {
			const when = londonDate(data.statusChangedAt);
			return when ? `Since ${when}` : 'Zack is a dad';
		}
		if (data.status === 'soon') return 'Labour in progress';
		const days = data.daysUntilDue;
		if (typeof days !== 'number' || !Number.isFinite(days)) return 'Due date not announced';
		if (days > 1) return `Due in ${days} days`;
		if (days === 1) return 'Due tomorrow';
		if (days === 0) return 'Due today';
		return days === -1 ? '1 day overdue' : `${-days} days overdue`;
	};

	/** Validate and normalise an /api/status payload. Everything ends up as text, never HTML. */
	const describe = (data) => {
		if (!data || typeof data !== 'object' || !STATUSES.includes(data.status)) return null;
		return {
			status: data.status,
			answer: typeof data.answer === 'string' && data.answer ? data.answer : ANSWERS[data.status],
			sentence: typeof data.sentence === 'string' ? data.sentence : '',
			meta: metaLine(data),
		};
	};

	/**
	 * Fetch the status now and every minute after. Backs off exponentially on errors,
	 * stops while the page is hidden and catches up as soon as it's visible again.
	 */
	const poll = (render, { immediate }) => {
		let timer = 0;
		let failures = 0;
		let lastFetch = 0;
		let inFlight = false;
		// A script-tag mount's first fetch is a reader looking; everything after is the timer.
		// Page mode already shows a server-rendered answer, so all its fetches are refreshes.
		let counted = !immediate;

		const schedule = () => {
			clearTimeout(timer);
			if (document.hidden) return;
			const delay = failures ? Math.min(REFRESH_MS * 2 ** (failures - 1), MAX_BACKOFF_MS) : REFRESH_MS;
			timer = setTimeout(tick, delay);
		};

		const tick = async () => {
			if (inFlight) return;
			inFlight = true;
			lastFetch = Date.now();
			try {
				const url = counted ? `${origin}/api/status?poll=1` : `${origin}/api/status`;
				counted = true;
				const res = await fetch(url, {
					mode: 'cors',
					credentials: 'omit',
					cache: 'no-store',
					headers: { Accept: 'application/json' },
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const view = describe(await res.json());
				if (!view) throw new Error('Unexpected response');
				failures = 0;
				render(view);
			} catch {
				failures++;
				render(null);
			} finally {
				inFlight = false;
				schedule();
			}
		};

		document.addEventListener('visibilitychange', () => {
			if (document.hidden) clearTimeout(timer);
			else if (Date.now() - lastFetch >= MIN_VISIBLE_REFRESH_MS) tick();
			else schedule();
		});

		if (immediate) tick();
		else {
			lastFetch = Date.now();
			schedule();
		}
	};

	/** Shared renderer: fills [data-field] elements, flags staleness, announces changes. */
	const renderer = (fields, statusHost, onChange) => {
		let current = statusHost.getAttribute('data-status');
		return (view) => {
			if (!view) {
				statusHost.setAttribute('data-stale', '');
				return;
			}
			statusHost.removeAttribute('data-stale');
			fields.answer.textContent = view.answer;
			fields.sentence.textContent = view.sentence;
			fields.meta.textContent = view.meta;
			if (view.status !== current) {
				const announce = current !== null && current !== 'unknown';
				current = view.status;
				statusHost.setAttribute('data-status', view.status);
				if (announce && fields.live) fields.live.textContent = `Update: ${view.sentence}`;
				onChange?.(view);
			}
		};
	};

	// ─── The /embed iframe page: keep the server-rendered widget live. ───
	if (script.dataset.mode === 'page') {
		const start = () => {
			const root = document.querySelector('[data-embed-root]');
			if (!root) return;
			const field = (name) => document.querySelector(`[data-field="${name}"]`);
			const fields = { answer: field('answer'), sentence: field('sentence'), meta: field('meta'), live: field('live') };
			if (!fields.answer || !fields.sentence || !fields.meta) return;
			const render = renderer(fields, document.documentElement, (view) => {
				document.title = `Is Zack a Dad? ${view.status === 'yes' ? 'Yes!' : view.status === 'soon' ? 'Not yet, but it is happening.' : 'No.'}`;
			});
			poll(render, { immediate: false });
		};
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
		else start();
		return;
	}

	// ─── Script-tag widget in a shadow DOM. ───
	const ds = script.dataset;
	const theme = ['auto', 'light', 'dark'].includes(ds.theme) ? ds.theme : 'auto';
	const size = ['small', 'medium', 'large'].includes(ds.size) ? ds.size : 'medium';
	const withLink = ds.link !== 'false';

	const CSS = `
:host{all:initial;display:inline-block;max-width:100%;vertical-align:middle}
.frame{--bg:#fff;--fg:#1b1b1b;--muted:#595959;--border:#e2e2e2;--no:#c62828;--soon:#b45309;--yes:#2e7d32;--ring:#1b1b1b;font:16px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--fg)}
.frame[data-theme=dark]{--bg:#151515;--fg:#f3f3f3;--muted:#b8b8b8;--border:#353535;--no:#ff7b72;--soon:#f6c453;--yes:#7ee2a8;--ring:#f3f3f3}
@media (prefers-color-scheme:dark){.frame[data-theme=auto]{--bg:#151515;--fg:#f3f3f3;--muted:#b8b8b8;--border:#353535;--no:#ff7b72;--soon:#f6c453;--yes:#7ee2a8;--ring:#f3f3f3}}
.widget{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;background:var(--bg);color:var(--fg);text-decoration:none;border:1px solid var(--border);border-radius:14px;padding:12px 18px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.widget:focus-visible{outline:3px solid var(--ring);outline-offset:2px}
a.widget:hover .sentence{text-decoration:underline}
.kicker{font-size:.72rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.answer{font-size:2.75rem;line-height:1;font-weight:900;letter-spacing:-.02em;color:var(--muted)}
.frame[data-status=no] .answer{color:var(--no)}
.frame[data-status=soon] .answer{color:var(--soon)}
.frame[data-status=yes] .answer{color:var(--yes)}
.sentence{font-size:.95rem;max-width:30ch}
.meta{font-size:.8rem;color:var(--muted)}
.frame[data-size=small] .widget{padding:8px 12px;gap:2px}
.frame[data-size=small] .answer{font-size:1.75rem}
.frame[data-size=small] .sentence{font-size:.85rem}
.frame[data-size=large] .widget{padding:18px 26px}
.frame[data-size=large] .answer{font-size:4.25rem}
.frame[data-size=large] .sentence{font-size:1.1rem}
.frame[data-stale] .widget{opacity:.8}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (prefers-reduced-motion:no-preference){.answer{transition:color .4s ease}}
`;

	const el = (tag, className, text) => {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text) node.textContent = text;
		return node;
	};

	const mount = () => {
		let host = null;
		if (ds.target) {
			try {
				host = document.querySelector(ds.target);
			} catch {
				host = null;
			}
		}
		if (!host) {
			host = document.createElement('div');
			if (script.closest('head') || !script.parentNode) document.body.append(host);
			else script.after(host);
		}

		let root;
		try {
			root = host.attachShadow({ mode: 'open' });
		} catch {
			return; // Already has a shadow root, or can't host one.
		}

		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(CSS);
			root.adoptedStyleSheets = [sheet];
		} catch {
			root.append(el('style', '', CSS));
		}

		const frame = el('div', 'frame');
		frame.dataset.theme = theme;
		frame.dataset.size = size;
		frame.dataset.status = 'unknown';

		const card = el(withLink ? 'a' : 'div', 'widget');
		card.setAttribute('part', 'widget');
		if (withLink) {
			card.href = `${origin}/`;
			card.target = '_blank';
			card.rel = 'noopener';
		}
		const fields = {
			answer: el('strong', 'answer', '…'),
			sentence: el('span', 'sentence', 'Checking with the authorities…'),
			meta: el('span', 'meta', ''),
			live: el('span', 'sr-only'),
		};
		fields.live.setAttribute('role', 'status');
		fields.live.setAttribute('aria-live', 'polite');
		card.append(el('span', 'kicker', 'Is Zack a dad?'), fields.answer, fields.sentence, fields.meta);
		frame.append(card, fields.live);
		root.append(frame);

		poll(renderer(fields, frame), { immediate: true });
	};

	if (document.body) mount();
	else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
