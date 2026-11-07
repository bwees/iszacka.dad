// Admin niceties. Everything in /admin works without this file; it only adds polish:
//   * the status buttons stay disarmed until the matching confirmation word is typed
//   * Enter in the confirmation box presses the armed button (not the first one in the form)
//   * a live countdown for the 60-second undo window
//   * a character counter on the public note
//   * confirm() prompts on forms marked data-confirm
//   * double-submit protection on every admin form
// The server validates everything again; none of this is a security boundary.
//
// Screen readers: live regions only change on transitions (armed/disarmed, the undo window
// nearly over and closed, the note crossing a few length thresholds), never every second or
// every keystroke. Ticking text lives in elements that aren't announced.

const normalise = (value) => value.trim().replace(/\s+/g, ' ').toUpperCase();

/** Say something once through the page's polite announcer (if there is one). */
function announce(message) {
	const region = document.querySelector('[data-announcer]');
	if (!region) return;
	region.textContent = '';
	// A fresh text node after a tick, so the same words twice are still read.
	setTimeout(() => {
		region.textContent = message;
	}, 50);
}

function setupStatusForm(form) {
	const input = form.querySelector('[data-confirm-input]');
	const buttons = [...form.querySelectorAll('button[data-confirm-word]')];
	const armedText = form.querySelector('[data-armed]');
	if (!input || buttons.length === 0) return;

	const label = (button) => button.querySelector('span')?.textContent?.trim() || button.value;
	// Keystroke-by-keystroke feedback goes in a quiet element; the live one only hears about
	// a button being armed or disarmed.
	let hint = null;
	if (armedText) {
		hint = document.createElement('p');
		hint.className = 'tiny muted';
		hint.setAttribute('aria-live', 'off');
		armedText.insertAdjacentElement('afterend', hint);
	}
	let previous; // undefined until the first update, then the armed button or null

	const update = () => {
		const typed = normalise(input.value);
		let armed = null;
		for (const button of buttons) {
			if (button.hasAttribute('data-current')) continue; // the current answer stays disabled
			const match = typed !== '' && typed === button.dataset.confirmWord;
			button.disabled = !match;
			if (match) armed = button;
		}
		if (armedText && armed !== previous) {
			if (armed) armedText.textContent = `Armed: ${label(armed)}. Press it if you mean it.`;
			else armedText.textContent = previous ? 'Disarmed.' : 'Type a confirmation word to arm a button.';
		}
		if (hint) hint.textContent = !armed && typed !== '' ? `"${typed}" doesn't arm anything.` : '';
		previous = armed;
		return armed;
	};

	input.addEventListener('input', update);
	input.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter') return;
		// Implicit submission would use the first button in the form, which may not be the
		// one you meant. Press the armed button instead, or nothing.
		event.preventDefault();
		update()?.click();
	});
	update();
}

function setupUndoCountdown(el) {
	const until = Date.parse(el.dataset.undoUntil || '');
	if (!Number.isFinite(until) || !el.querySelector('p')) return;
	// The server-rendered sentence (with the London time) stays as it is. The seconds tick in
	// a separate element outside any live region; only the transitions are announced.
	el.removeAttribute('role');
	const ticker = document.createElement('p');
	ticker.className = 'tiny';
	ticker.setAttribute('aria-live', 'off');
	el.append(ticker);
	let warned = false;
	const tick = () => {
		const left = Math.ceil((until - Date.now()) / 1000);
		if (left > 0) {
			ticker.textContent = `Notifications go out in ${left} second${left === 1 ? '' : 's'}.`;
			if (left <= 10 && !warned) {
				warned = true;
				announce('Undo window: 10 seconds left.');
			}
			setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
		} else {
			ticker.textContent = 'Undo window closed. Notifications are on their way (or have already arrived).';
			announce('Undo window closed. Notifications are on their way.');
		}
	};
	tick();
}

let counterIds = 0;

function setupCounter(field) {
	const max = Number(field.getAttribute('maxlength'));
	if (!Number.isFinite(max) || max <= 0) return;
	const counter = document.createElement('p');
	counter.className = 'tiny muted';
	counter.id = `char-counter-${++counterIds}`;
	field.insertAdjacentElement('afterend', counter);
	// Read with the field (on focus, or on request), not after every keystroke.
	const describedBy = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
	field.setAttribute('aria-describedby', [...describedBy, counter.id].join(' '));
	const thresholds = [50, 20, 0].filter((n) => n < max);
	const bucket = (left) => thresholds.filter((n) => left <= n).length;
	let lastBucket = null;
	const update = () => {
		const left = max - field.value.length;
		counter.textContent = `${left} of ${max} characters left`;
		const now = bucket(left);
		// Announce once per threshold crossed on the way down.
		if (lastBucket !== null && now > lastBucket) announce(left <= 0 ? 'No characters left.' : `${left} characters left.`);
		lastBucket = now;
	};
	field.addEventListener('input', update);
	update();
}

function setupForm(form) {
	form.addEventListener('submit', (event) => {
		if (form.dataset.busy === '1') {
			event.preventDefault();
			return;
		}
		const message = form.dataset.confirm;
		if (message && !window.confirm(message)) {
			event.preventDefault();
			return;
		}
		// Don't disable the submitter synchronously: disabled buttons are dropped from the
		// form data, and the status form needs to know which button was pressed.
		form.dataset.busy = '1';
		form.setAttribute('aria-busy', 'true');
		// If the page comes back from the bfcache, let the form be used again.
		window.addEventListener(
			'pageshow',
			() => {
				delete form.dataset.busy;
				form.removeAttribute('aria-busy');
			},
			{ once: true },
		);
	});
}

function init() {
	if (!document.body.classList.contains('admin')) return;
	for (const form of document.querySelectorAll('form[data-status-form]')) setupStatusForm(form);
	for (const el of document.querySelectorAll('[data-undo-until]')) setupUndoCountdown(el);
	for (const field of document.querySelectorAll('textarea[data-counter][maxlength]')) setupCounter(field);
	for (const form of document.querySelectorAll('form')) {
		const action = form.getAttribute('action') || '';
		if (action.startsWith('/admin')) setupForm(form);
	}
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
