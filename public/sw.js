// iszacka.dad service worker.
//
// Three jobs:
//   1. Offline: pages are network-first and fall back to /offline.html. Pages
//      themselves are never cached: a stale "NO" is worse than no answer.
//   2. Push: pushes arrive without a payload. On each one we ask /api/status
//      what's going on and show that as the notification.
//   3. Housekeeping: versioned caches, old ones deleted on activate.

// Bump whenever offline.html or anything else in PRECACHE changes, so installed workers
// re-precache it (navigations also refresh /offline.html in the background).
const VERSION = 'v2';
const CACHE_PREFIX = 'iszackadad-';
const CACHE = `${CACHE_PREFIX}shell-${VERSION}`;

// What the offline page needs to look like itself. Missing files are skipped.
const PRECACHE = [
	'/offline.html',
	'/styles.css',
	'/favicon-no.svg',
	'/favicon-soon.svg',
	'/favicon-yes.svg',
	'/icons/icon-192.png',
	'/icons/icon-512.png',
	'/icons/maskable-512.png',
	'/icons/apple-touch-icon.png',
	'/fonts/anybody-latin.woff2',
	'/fonts/atkinson-next-latin.woff2',
	'/fonts/martian-mono-latin.woff2',
];

// Never touched by the service worker: live data, sockets, admin and machine endpoints.
const BYPASS = [/^\/api(\/|$)/, /^\/ws(\/|$)/, /^\/admin(\/|$)/, /^\/mcp(\/|$)/];

const NOTIFICATION_TAG = 'iszackadad-status';
const ICON = '/icons/icon-192.png';
const BADGE = '/icons/icon-192.png';

const COPY = {
	yes: {
		title: 'Zack is a dad! 👶',
		body: 'The baby is here. That is all the detail you are getting, and it is plenty.',
	},
	soon: {
		title: "It's happening! 🐣",
		body: 'Labour has started. Zack is not a dad yet, but it is very much under way.',
	},
	no: {
		title: 'Zack is not a dad. 🥚',
		body: 'Still no. As you were.',
	},
};

const GENERIC = {
	title: 'Is Zack a dad? Something happened.',
	body: "We couldn't check what, because the internet is being coy. Tap to find out.",
};

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await Promise.all(
				PRECACHE.map(async (url) => {
					try {
						const res = await fetch(new Request(url, { cache: 'reload' }));
						if (res.ok) await cache.put(url, await unredirected(res));
					} catch {
						// A missing or unreachable file shouldn't stop the worker installing.
					}
				}),
			);
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys();
			await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE).map((name) => caches.delete(name)));
			if (self.registration.navigationPreload) {
				try {
					await self.registration.navigationPreload.enable();
				} catch {
					// Not supported here; plain fetch it is.
				}
			}
			await self.clients.claim();
		})(),
	);
});

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (BYPASS.some((pattern) => pattern.test(url.pathname))) return;

	if (request.mode === 'navigate') {
		event.respondWith(navigate(event));
		return;
	}
	if (PRECACHE.includes(url.pathname)) {
		event.respondWith(networkFirst(request, url.pathname));
	}
});

// The asset server may redirect /offline.html to /offline. Browsers refuse to
// answer a navigation with a response that was redirected, so store a clean copy.
async function unredirected(res) {
	if (!res.redirected) return res;
	return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function navigate(event) {
	try {
		const preloaded = await event.preloadResponse;
		const res = preloaded ?? (await fetch(event.request));
		// Online: keep the offline page's copy current, so edits reach installed workers too.
		event.waitUntil(refreshOfflinePage());
		return res;
	} catch {
		const offline = await caches.match('/offline.html');
		return (
			offline ??
			new Response("You're offline, so we can't check whether Zack is a dad. Try again when you're back online.", {
				status: 503,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			})
		);
	}
}

/** Re-store /offline.html, at most once an hour per worker. Never throws. */
let offlineRefreshedAt = 0;
async function refreshOfflinePage() {
	if (Date.now() - offlineRefreshedAt < 3_600_000) return;
	offlineRefreshedAt = Date.now();
	try {
		const res = await fetch(new Request('/offline.html', { cache: 'no-cache' }));
		if (res.ok) await (await caches.open(CACHE)).put('/offline.html', await unredirected(res));
	} catch {
		// Offline again, or the file moved: the cached copy will do.
	}
}

async function networkFirst(request, key) {
	try {
		const res = await fetch(request);
		if (res.ok) {
			const copy = res.clone();
			caches
				.open(CACHE)
				.then((cache) => cache.put(key, copy))
				.catch(() => {});
		}
		return res;
	} catch (err) {
		const cached = await caches.match(key);
		if (cached) return cached;
		throw err;
	}
}

// ── Push ────────────────────────────────────────────────────────────────────

/** Pull 'no' | 'soon' | 'yes' out of whatever /api/status returns. */
function statusFrom(data) {
	const candidates = [data?.status, data?.state?.status, data?.answer?.status, data?.answer];
	for (const value of candidates) {
		if (typeof value !== 'string') continue;
		const status = value.trim().toLowerCase();
		if (status === 'no' || status === 'soon' || status === 'yes') return status;
	}
	return null;
}

async function currentStatus() {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		// ?poll=1: a service worker asking isn't a person checking (it isn't counted).
		const res = await fetch('/api/status?poll=1', {
			headers: { Accept: 'application/json' },
			cache: 'no-store',
			signal: controller.signal,
		});
		if (!res.ok) return null;
		return statusFrom(await res.json());
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function showStatusNotification() {
	const status = await currentStatus();
	const copy = status ? COPY[status] : GENERIC;
	await self.registration.showNotification(copy.title, {
		body: copy.body,
		icon: ICON,
		badge: BADGE,
		tag: NOTIFICATION_TAG,
		renotify: true,
		lang: 'en-GB',
		timestamp: Date.now(),
		data: { url: '/', status },
	});
}

self.addEventListener('push', (event) => {
	// userVisibleOnly: every push must show something, so the fallback always does.
	event.waitUntil(
		showStatusNotification().catch(() =>
			self.registration.showNotification(GENERIC.title, {
				body: GENERIC.body,
				icon: ICON,
				badge: BADGE,
				tag: NOTIFICATION_TAG,
				renotify: true,
				data: { url: '/' },
			}),
		),
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const target = new URL(event.notification.data?.url || '/', self.location.origin);
	event.waitUntil(
		(async () => {
			// Match by path, ignoring the query and hash: the installed app starts at
			// /?source=pwa, and the hero links to /#mission-control. matchAll lists the most
			// recently focused first. Other tabs (a half-written guess on /pool, say) are never
			// navigated away: if no window is already on the target, a new one opens.
			const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const home = windows.find((client) => {
				try {
					return client.frameType !== 'nested' && new URL(client.url).pathname === target.pathname;
				} catch {
					return false;
				}
			});
			if (home) {
				try {
					// The page keeps itself live over a WebSocket (or polling): focusing is enough.
					await home.focus();
					return;
				} catch {
					// Not allowed to focus it; open a fresh window instead.
				}
			}
			await self.clients.openWindow(target.href);
		})(),
	);
});

// The browser rotated the subscription (expiry, key change): swap it on the server.
self.addEventListener('pushsubscriptionchange', (event) => {
	event.waitUntil(
		(async () => {
			const old = event.oldSubscription;
			let fresh = event.newSubscription;
			if (!fresh) {
				const res = await fetch('/api/push/key', { headers: { Accept: 'application/json' } });
				const { publicKey } = await res.json();
				fresh = await self.registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: base64UrlToBytes(publicKey),
				});
			}
			await fetch('/api/push/subscribe', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				body: JSON.stringify(fresh.toJSON()),
			});
			if (old && old.endpoint !== fresh.endpoint) {
				await fetch('/api/push/unsubscribe', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
					body: JSON.stringify({ endpoint: old.endpoint }),
				});
			}
		})().catch(() => {}),
	);
});

function base64UrlToBytes(value) {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
