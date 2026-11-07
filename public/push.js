// Push notification opt-in for every [data-push-widget] on the page.
//
// States: unsupported (with an iOS "add to Home Screen first" hint where that's
// the fix), blocked, off, on, and busy. Subscribing is the standard dance:
// permission → service worker → pushManager.subscribe(VAPID key) → robot check (Turnstile,
// rendered explicitly into [data-push-turnstile] when the site has it) → POST to us.

const SW_URL = '/sw.js';

const isIos = () =>
	/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isStandalone = () =>
	window.matchMedia?.('(display-mode: standalone)').matches === true || navigator.standalone === true;

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function base64UrlToBytes(value) {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function sameKey(buffer, bytes) {
	if (!buffer) return false;
	const a = new Uint8Array(buffer);
	return a.length === bytes.length && a.every((value, i) => value === bytes[i]);
}

async function postJson(url, body) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify(body),
	});
	let data = {};
	try {
		data = await res.json();
	} catch {
		// Not JSON. The status code will have to do.
	}
	if (!res.ok || data.ok === false) {
		const err = new Error(data.error || `The server said ${res.status}.`);
		err.status = res.status;
		throw err;
	}
	return data;
}

/** window.turnstile, once the (async) script has loaded. */
async function waitForTurnstile(timeoutMs = 15_000) {
	const started = Date.now();
	while (!window.turnstile) {
		if (Date.now() - started > timeoutMs) throw new Error("the robot check didn't load. Try again in a moment.");
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return window.turnstile;
}

let keyPromise = null;
function serverKey() {
	keyPromise ??= fetch('/api/push/key', { headers: { Accept: 'application/json' } })
		.then((res) => {
			if (!res.ok) throw new Error(`Couldn't fetch the push key (${res.status}).`);
			return res.json();
		})
		.then(({ publicKey }) => base64UrlToBytes(publicKey))
		.catch((err) => {
			keyPromise = null;
			throw err;
		});
	return keyPromise;
}

async function registration() {
	const existing = await navigator.serviceWorker.getRegistration('/');
	if (!existing) await navigator.serviceWorker.register(SW_URL, { scope: '/' });
	return navigator.serviceWorker.ready;
}

class PushWidget {
	constructor(root) {
		this.root = root;
		this.status = root.querySelector('[data-push-status]') ?? this.make('p', 'push-status', { 'data-push-status': '' });
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		this.actions = root.querySelector('[data-push-actions]') ?? this.make('div', 'cluster', { 'data-push-actions': '' });
		this.hint = root.querySelector('[data-push-hint]') ?? this.make('p', 'hint', { 'data-push-hint': '' });
		this.check = root.querySelector('[data-push-turnstile]');
		this.widgetId = undefined;
		this.subscription = null;
	}

	/** A fresh Turnstile token, or null when the site doesn't use Turnstile. Tokens are single-use. */
	async turnstileToken() {
		const sitekey = this.check?.dataset.sitekey;
		if (!sitekey) return null;
		const turnstile = await waitForTurnstile();
		this.dropCheck();
		this.check.hidden = false;
		return new Promise((resolve, reject) => {
			this.widgetId = turnstile.render(this.check, {
				sitekey,
				action: 'push',
				callback: (token) => resolve(token),
				'error-callback': () => reject(new Error("the robot check didn't pass.")),
				'expired-callback': () => reject(new Error('the robot check expired.')),
				'timeout-callback': () => reject(new Error('the robot check timed out.')),
			});
		});
	}

	dropCheck() {
		if (this.widgetId !== undefined) {
			try {
				window.turnstile?.remove(this.widgetId);
			} catch {
				// Already gone.
			}
			this.widgetId = undefined;
		}
		if (this.check) this.check.hidden = true;
	}

	make(tag, className, attrs) {
		const el = document.createElement(tag);
		el.className = className;
		for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
		this.root.append(el);
		return el;
	}

	button(label, variant, onClick) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = `btn ${variant}`;
		btn.textContent = label;
		btn.addEventListener('click', onClick);
		return btn;
	}

	render(message, buttons = [], hint = '') {
		this.status.textContent = message;
		this.actions.replaceChildren(...buttons);
		this.hint.textContent = hint;
		this.root.dataset.pushState = this.state;
	}

	busy(message) {
		this.root.setAttribute('aria-busy', 'true');
		for (const btn of this.actions.querySelectorAll('button')) btn.disabled = true;
		this.status.textContent = message;
	}

	idle() {
		this.root.removeAttribute('aria-busy');
	}

	async init() {
		if (!supported()) {
			this.state = 'unsupported';
			if (isIos() && !isStandalone()) {
				this.render(
					'On iPhone and iPad, notifications only work once this site is on your Home Screen.',
					[],
					'Tap the Share button, choose "Add to Home Screen", open Is Zack a Dad? from there, and come back to this page.',
				);
			} else {
				this.render(
					"This browser can't do push notifications.",
					[],
					'Email, RSS and webhooks are all available instead. So is refreshing the page a lot.',
				);
			}
			return;
		}
		if (Notification.permission === 'denied') {
			this.showBlocked();
			return;
		}
		try {
			const reg = await registration();
			let sub = await reg.pushManager.getSubscription();
			if (sub && Notification.permission === 'granted') {
				const key = await serverKey();
				if (!sameKey(sub.options?.applicationServerKey, key)) {
					// Subscribed with an old key (the server's keys changed): quietly start again.
					await sub.unsubscribe().catch(() => {});
					sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
				}
				// Re-sync our keys with the server. Without a robot check this can't revive a
				// subscription the server gave up on, so in that case offer the button again.
				let synced = null;
				try {
					synced = await postJson('/api/push/subscribe', sub.toJSON());
				} catch (err) {
					if (err?.status === 403) synced = { active: false };
				}
				this.subscription = sub;
				if (synced?.active === false) {
					this.showOff();
					this.status.textContent = 'Notifications stopped reaching this device. Turn them on again to resume.';
					return;
				}
				this.showOn();
				return;
			}
		} catch {
			// Fall through to "off": the button will try again properly.
		}
		this.showOff();
	}

	showOff(error) {
		this.state = 'off';
		this.idle();
		this.render(
			error ? `That didn't work: ${error}` : 'Notifications are off on this device.',
			[this.button(error ? 'Try again' : 'Turn on notifications', 'btn-primary', () => this.enable())],
			isIos() ? 'On iPhone and iPad this works from the Home Screen app.' : '',
		);
	}

	showOn(message) {
		this.state = 'on';
		this.idle();
		this.render(
			message ?? "Notifications are on. You'll hear when labour starts and when Zack is a dad.",
			[this.button('Send a test', 'btn-ghost', () => this.test()), this.button('Turn off', 'btn-ghost', () => this.disable())],
		);
	}

	showBlocked() {
		this.state = 'blocked';
		this.idle();
		this.render(
			'Notifications are blocked for this site.',
			[],
			"Changed your mind? Allow notifications in your browser's site settings, then reload this page.",
		);
	}

	async enable() {
		this.busy('Asking your browser nicely…');
		try {
			// Ask first, while we still have the click: Safari insists on it.
			const permission = await Notification.requestPermission();
			if (permission === 'denied') return this.showBlocked();
			if (permission !== 'granted') return this.showOff('permission was not granted.');
			const [reg, key] = await Promise.all([registration(), serverKey()]);
			this.busy('Telling the stork…');
			let sub = await reg.pushManager.getSubscription();
			if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
				await sub.unsubscribe().catch(() => {});
				sub = null;
			}
			sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
			try {
				this.busy('Checking you are not a robot…');
				const token = await this.turnstileToken();
				this.busy('Telling the stork…');
				const data = await postJson('/api/push/subscribe', { ...sub.toJSON(), ...(token ? { 'cf-turnstile-response': token } : {}) });
				this.subscription = sub;
				this.showOn(data.message);
			} catch (err) {
				await sub.unsubscribe().catch(() => {});
				throw err;
			} finally {
				this.dropCheck();
			}
		} catch (err) {
			this.showOff(err instanceof Error ? err.message : String(err));
		}
	}

	async disable() {
		this.busy('Turning it off…');
		try {
			const reg = await registration();
			const sub = this.subscription ?? (await reg.pushManager.getSubscription());
			if (sub) {
				const { endpoint } = sub;
				await sub.unsubscribe().catch(() => {});
				await postJson('/api/push/unsubscribe', { endpoint }).catch(() => {});
			}
			this.subscription = null;
			this.showOff();
			this.status.textContent = 'Notifications are off. You will have to keep refreshing, like an animal.';
		} catch (err) {
			this.showOn(`Couldn't turn it off: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async test() {
		this.busy('Sending a test…');
		try {
			const reg = await registration();
			const sub = this.subscription ?? (await reg.pushManager.getSubscription());
			if (!sub) return this.showOff();
			const data = await postJson('/api/push/test', { endpoint: sub.endpoint });
			this.showOn(data.message);
		} catch (err) {
			this.showOn(`The test didn't work: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

for (const root of document.querySelectorAll('[data-push-widget]')) {
	new PushWidget(root).init();
}
