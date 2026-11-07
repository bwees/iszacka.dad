// /is-zack-a-grandad: counts down to the estimate, to the second, which is the most precise
// way of being wrong available. The estimate itself comes from the server (data-grandad-at).

const YEAR_S = 31_557_600; // a Julian year, for want of a better one
const pad = (n) => String(n).padStart(2, '0');

const el = document.querySelector('[data-grandad-at]');
const at = el ? Date.parse(el.getAttribute('data-grandad-at') || '') : Number.NaN;

if (el && Number.isFinite(at)) {
	const tick = () => {
		let s = Math.max(0, Math.floor((at - Date.now()) / 1000));
		if (s === 0) {
			el.textContent = 'Any second now, statistically.';
			return;
		}
		const years = Math.floor(s / YEAR_S);
		s -= years * YEAR_S;
		const days = Math.floor(s / 86_400);
		s %= 86_400;
		const clock = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
		el.textContent = `${years} year${years === 1 ? '' : 's'}, ${days} day${days === 1 ? '' : 's'} and ${clock} to go. Approximately.`;
	};
	tick();
	setInterval(tick, 1000);
}
