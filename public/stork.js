// Catch the Stork (/stork): a canvas catcher game. The stork flies back and forth dropping
// things; you move the basket. Everything is drawn with canvas shapes, no image assets.
//
// - Keyboard (← → / A D, Space or P to pause, M for sound), touch or mouse (drag along the
//   canvas) and the on-screen buttons all move the basket.
// - Sound is off until asked for (Web Audio beeps, nothing downloaded).
// - The game pauses when the tab is hidden or the window loses focus.
// - prefers-reduced-motion: no screen shake, no drifting clouds, no particle bursts.
// - Scores need a game token from POST /api/stork/start (asked for when a game starts) and go to
//   POST /api/stork/score. The spawn rules here are what keep real scores under the server's
//   plausibility cap (src/lib/stork.ts MAX_POINTS_PER_SECOND): at most one drop every
//   MIN_DROP_INTERVAL seconds, and nothing worth more than 3. Change them together.

const W = 480;
const H = 560;
const GROUND = H - 34;
const STORK_Y = 104;
const MIN_DROP_INTERVAL = 0.45;
const MAX_LIVES = 3;
const STORAGE = 'iszackadad:';

const POINTS = { bundle: 1, bottle: 3, coffee: 0, advice: 0 };
const ADVICE = [
	'Sleep now!',
	'Just you wait…',
	'In my day…',
	'Have you tried…',
	'Enjoy every second!',
	'They grow up fast',
	'Rookie mistake',
	"You'll see",
	'Read this book',
];
const GAME_OVER = [
	'The stork has taken early retirement.',
	'Delivery failed. Please contact the sender.',
	'The stork would like a word with your manager.',
	'Parcel left with a neighbour.',
	'The stork is filing a complaint.',
];

const stage = document.querySelector('[data-stork]');
if (stage instanceof HTMLElement) init(stage);

function store(key, value) {
	try {
		if (value === undefined) return window.localStorage.getItem(STORAGE + key);
		window.localStorage.setItem(STORAGE + key, value);
	} catch {
		/* private mode: no memory, no problem */
	}
	return null;
}

function init(stage) {
	const canvas = stage.querySelector('[data-stork-canvas]');
	if (!(canvas instanceof HTMLCanvasElement)) return;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;

	const $ = (sel) => document.querySelector(sel);
	const overlay = $('[data-stork-overlay]');
	const titleEl = $('[data-stork-title]');
	const kickerEl = $('[data-stork-kicker]');
	const messageEl = $('[data-stork-message]');
	const startBtn = $('[data-stork-start]');
	const pauseBtn = $('[data-stork-pause]');
	const soundBtn = $('[data-stork-sound]');
	const leftBtn = $('[data-stork-left]');
	const rightBtn = $('[data-stork-right]');
	const bestEl = $('[data-stork-best]');
	const form = $('[data-stork-form]');
	const fieldset = $('[data-stork-fieldset]');
	const hint = $('[data-stork-form-hint]');
	const tokenInput = $('[data-stork-token]');
	const scoreInput = $('[data-stork-score]');
	const initialsInput = $('#stork-initials');
	const notice = $('[data-stork-form-notice]');

	stage.hidden = false;
	for (const el of document.querySelectorAll('[data-stork-bar]')) el.hidden = false;
	if (window.matchMedia('(pointer: coarse)').matches && messageEl) {
		messageEl.textContent = 'Drag along the game to move the basket, or hold the arrows underneath.';
	}

	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	let colours = readColours();
	const scheme = window.matchMedia('(prefers-color-scheme: dark)');
	const recolour = () => {
		colours = readColours();
		if (game.mode !== 'playing') draw();
	};
	scheme.addEventListener?.('change', recolour);
	document.addEventListener('iszacka:live', (e) => {
		if (e.detail?.type === 'state' || e.detail?.type === 'hello') window.setTimeout(recolour, 50);
	});

	// ── Canvas sizing: logical 480×560, backed at device pixel ratio ──────────
	function resize() {
		const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
		const cssWidth = canvas.getBoundingClientRect().width || W;
		const scale = (cssWidth / W) * dpr;
		canvas.width = Math.round(W * scale);
		canvas.height = Math.round(H * scale);
		ctx.setTransform(scale, 0, 0, scale, 0, 0);
		draw();
	}
	if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
	else window.addEventListener('resize', resize);

	// ── State ──────────────────────────────────────────────────────────────────
	const game = {
		mode: 'ready', // ready | playing | paused | over
		score: 0,
		lives: MAX_LIVES,
		time: 0,
		drops: 0,
		nextDrop: 1.2,
		basket: { x: W / 2, w: 78, h: 30, v: 0 },
		stork: { x: 60, dir: 1, flap: 0 },
		items: [],
		floaters: [],
		particles: [],
		clouds: makeClouds(),
		shake: 0,
		flash: 0,
		token: null,
		tokenPending: null,
		lastFrame: 0,
		raf: 0,
	};
	const input = { left: false, right: false, pointerX: null, buttonDir: 0 };
	let best = Number.parseInt(store('stork-best') || '0', 10) || 0;
	showBest();

	// ── Sound (off by default) ─────────────────────────────────────────────────
	let soundOn = store('stork-sound') === '1';
	let audio = null;
	function setSound(on) {
		soundOn = on;
		store('stork-sound', on ? '1' : '0');
		if (soundBtn) {
			soundBtn.textContent = on ? 'Sound: on' : 'Sound: off';
			soundBtn.setAttribute('aria-pressed', String(on));
		}
		if (on) beep(880, 0.06);
	}
	function beep(freq, duration, type = 'sine', delay = 0) {
		if (!soundOn) return;
		try {
			audio ??= new (window.AudioContext || window.webkitAudioContext)();
			if (audio.state === 'suspended') audio.resume();
			const at = audio.currentTime + delay;
			const osc = audio.createOscillator();
			const gain = audio.createGain();
			osc.type = type;
			osc.frequency.setValueAtTime(freq, at);
			gain.gain.setValueAtTime(0.0001, at);
			gain.gain.exponentialRampToValueAtTime(0.12, at + 0.01);
			gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
			osc.connect(gain).connect(audio.destination);
			osc.start(at);
			osc.stop(at + duration + 0.02);
		} catch {
			/* no audio: silence was the default anyway */
		}
	}
	// The stored preference is only honoured after a click (browsers insist), so show it as is.
	if (soundBtn) {
		soundBtn.textContent = soundOn ? 'Sound: on' : 'Sound: off';
		soundBtn.setAttribute('aria-pressed', String(soundOn));
		soundBtn.addEventListener('click', () => setSound(!soundOn));
	}

	// ── Game flow ──────────────────────────────────────────────────────────────
	function requestToken() {
		game.token = null;
		game.tokenPending = fetch('/api/stork/start', { method: 'POST', headers: { Accept: 'application/json' } })
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				game.token = data && typeof data.token === 'string' ? data.token : null;
			})
			.catch(() => {
				game.token = null;
			});
	}

	function start() {
		colours = readColours();
		Object.assign(game, {
			score: 0,
			lives: MAX_LIVES,
			time: 0,
			drops: 0,
			nextDrop: 1.2,
			items: [],
			floaters: [],
			particles: [],
			shake: 0,
			flash: 0,
		});
		game.basket.x = W / 2;
		game.basket.v = 0;
		game.stork.x = 60;
		game.stork.dir = 1;
		setMode('playing');
		requestToken();
		resetForm('Game in progress. Lodge it when it ends.');
		overlay.hidden = true;
		if (pauseBtn) {
			pauseBtn.disabled = false;
			pauseBtn.textContent = 'Pause';
		}
		beep(520, 0.08);
		beep(780, 0.1, 'sine', 0.09);
		bringIntoView();
		loop();
	}

	function setMode(mode) {
		game.mode = mode;
		// Only swallow touch gestures (scrolling) on the canvas while a game is running.
		stage.classList.toggle('is-playing', mode === 'playing');
	}

	/** Scroll so the whole field and its buttons are on screen (the field's top wins if not both). */
	function bringIntoView() {
		const top = stage.getBoundingClientRect().top;
		const bottom = (document.querySelector('.stork-bar') || stage).getBoundingClientRect().bottom;
		let dy = 0;
		if (bottom > window.innerHeight) dy = bottom - window.innerHeight + 12;
		if (top - dy < 0 || top < 0) dy = top - 12;
		if (Math.abs(dy) > 2) window.scrollBy({ top: dy, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
	}

	function pause(reason) {
		if (game.mode !== 'playing') return;
		setMode('paused');
		cancelAnimationFrame(game.raf);
		showOverlay('Paused', reason || 'Tea break', 'The stork is circling. It will wait.', 'Resume');
		if (pauseBtn) pauseBtn.textContent = 'Resume';
		draw();
	}

	function resume() {
		if (game.mode !== 'paused') return;
		setMode('playing');
		overlay.hidden = true;
		if (pauseBtn) pauseBtn.textContent = 'Pause';
		loop();
	}

	function gameOver() {
		setMode('over');
		cancelAnimationFrame(game.raf);
		game.shake = 0;
		game.flash = 0;
		if (pauseBtn) pauseBtn.disabled = true;
		const newBest = game.score > best;
		if (newBest) {
			best = game.score;
			store('stork-best', String(best));
			showBest();
		}
		const line = GAME_OVER[Math.floor(Math.random() * GAME_OVER.length)];
		const summary = `${game.score} ${game.score === 1 ? 'point' : 'points'}${newBest && game.score > 0 ? ', a new personal best' : ''}.`;
		showOverlay(`Final score: ${game.score}`, 'Game over', `${line} ${summary}`, 'Play again');
		window.iszacka?.announce?.(`Game over. ${summary}`);
		beep(392, 0.12, 'triangle');
		beep(262, 0.24, 'triangle', 0.13);
		draw();
		offerScore();
	}

	function showOverlay(title, kicker, message, button) {
		titleEl.textContent = title;
		kickerEl.textContent = kicker;
		messageEl.textContent = message;
		startBtn.textContent = button;
		overlay.hidden = false;
	}

	function showBest() {
		if (bestEl) bestEl.textContent = best > 0 ? String(best) : 'none yet';
	}

	// ── Loop ───────────────────────────────────────────────────────────────────
	function loop() {
		cancelAnimationFrame(game.raf);
		game.lastFrame = performance.now();
		const frame = (now) => {
			if (game.mode !== 'playing') return;
			const dt = Math.min(0.05, Math.max(0, (now - game.lastFrame) / 1000));
			game.lastFrame = now;
			update(dt);
			draw();
			if (game.mode === 'playing') game.raf = requestAnimationFrame(frame);
		};
		game.raf = requestAnimationFrame(frame);
	}

	function update(dt) {
		game.time += dt;
		const level = Math.min(game.drops, 60);
		const calm = reducedMotion.matches;

		// Basket: pointer target if there is one, else keys/buttons.
		const b = game.basket;
		const half = b.w / 2;
		if (input.pointerX !== null) {
			const delta = input.pointerX - b.x;
			const step = Math.sign(delta) * Math.min(Math.abs(delta), 900 * dt);
			b.v = step / dt;
			b.x += step;
		} else {
			const dir = (input.left ? -1 : 0) + (input.right ? 1 : 0) + input.buttonDir;
			const target = Math.sign(dir) * 430;
			b.v += (target - b.v) * Math.min(1, dt * 14);
			b.x += b.v * dt;
		}
		b.x = Math.max(half + 4, Math.min(W - half - 4, b.x));

		// Stork: back and forth, faster as the shift goes on.
		const s = game.stork;
		const storkSpeed = 90 + level * 2.6;
		s.x += s.dir * storkSpeed * dt;
		if (s.x > W - 50) {
			s.x = W - 50;
			s.dir = -1;
		} else if (s.x < 50) {
			s.x = 50;
			s.dir = 1;
		}
		s.flap += dt * (calm ? 5 : 9);

		// Drops: never more often than MIN_DROP_INTERVAL (see the header comment).
		game.nextDrop -= dt;
		if (game.nextDrop <= 0) {
			drop(level);
			game.nextDrop = Math.max(MIN_DROP_INTERVAL, 1.25 - level * 0.018);
		}

		// Items.
		const top = GROUND - b.h;
		for (const it of game.items) {
			it.vy += 70 * dt;
			it.y += it.vy * dt;
			it.x += it.vx * dt;
			if (it.x < it.r || it.x > W - it.r) it.vx = -it.vx;
			it.rot += it.vr * dt;
			if (!it.done && it.y + it.r >= top && it.y - it.r < top + 12 && Math.abs(it.x - b.x) < half + it.r * 0.35) {
				it.done = true;
				catchItem(it);
			} else if (!it.done && it.y - it.r > GROUND) {
				it.done = true;
				missItem(it);
			}
		}
		game.items = game.items.filter((it) => !it.done);

		// Clouds drift (unless motion is reduced), floaters rise, particles fall.
		if (!calm) for (const c of game.clouds) c.x = ((c.x + c.speed * dt + 140) % (W + 280)) - 140;
		for (const f of game.floaters) {
			f.y -= 34 * dt;
			f.life -= dt;
		}
		game.floaters = game.floaters.filter((f) => f.life > 0);
		for (const p of game.particles) {
			p.vy += 400 * dt;
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.life -= dt;
		}
		game.particles = game.particles.filter((p) => p.life > 0);
		game.shake = Math.max(0, game.shake - dt * 30);
		game.flash = Math.max(0, game.flash - dt * 2.5);

		if (game.lives <= 0) gameOver();
	}

	function drop(level) {
		game.drops++;
		const roll = Math.random();
		const adviceShare = game.drops > 6 ? Math.min(0.2, 0.08 + level * 0.002) : 0;
		let kind = 'bundle';
		if (roll < adviceShare) kind = 'advice';
		else if (roll < adviceShare + 0.12) kind = 'bottle';
		else if (roll < adviceShare + 0.18 && game.lives < MAX_LIVES) kind = 'coffee';
		const s = game.stork;
		const item = {
			kind,
			x: Math.max(24, Math.min(W - 24, s.x + s.dir * 60)),
			y: STORK_Y + 18,
			vx: s.dir * (10 + Math.random() * 20),
			vy: 70 + Math.min(level, 45) * 4.5,
			r: kind === 'advice' ? 15 : 13,
			rot: 0,
			vr: (Math.random() - 0.5) * (kind === 'bundle' ? 3 : 1.2),
			text: kind === 'advice' ? ADVICE[Math.floor(Math.random() * ADVICE.length)] : '',
			done: false,
		};
		game.items.push(item);
	}

	function catchItem(it) {
		const b = game.basket;
		if (it.kind === 'advice') {
			game.lives--;
			game.shake = 8;
			game.flash = 1;
			float(`“${it.text}” −1 life`, b.x, GROUND - 60, colours.error);
			beep(180, 0.18, 'square');
			return;
		}
		if (it.kind === 'coffee') {
			game.lives = Math.min(MAX_LIVES, game.lives + 1);
			float('Caffeinated: +1 life', b.x, GROUND - 60, colours.yes);
			beep(660, 0.08);
			beep(990, 0.12, 'sine', 0.08);
			return;
		}
		const points = POINTS[it.kind];
		game.score += points;
		float(`+${points}`, it.x, GROUND - 56, it.kind === 'bottle' ? colours.soon : colours.ink);
		burst(it.x, GROUND - 34, it.kind === 'bottle' ? colours.soon : colours.accent);
		beep(it.kind === 'bottle' ? 880 : 640, 0.07);
	}

	function missItem(it) {
		if (it.kind !== 'bundle') return; // only bundles matter; let the advice fall
		game.lives--;
		game.shake = 6;
		float('Dropped!', it.x, GROUND - 24, colours.error);
		beep(150, 0.2, 'sawtooth');
	}

	function float(text, x, y, colour) {
		game.floaters.push({ text, x: Math.max(60, Math.min(W - 60, x)), y, colour, life: 1.1 });
	}

	function burst(x, y, colour) {
		if (reducedMotion.matches) return;
		for (let i = 0; i < 8; i++) {
			game.particles.push({ x, y, vx: (Math.random() - 0.5) * 220, vy: -120 - Math.random() * 160, colour, life: 0.6 + Math.random() * 0.3 });
		}
	}

	// ── Drawing ────────────────────────────────────────────────────────────────
	function draw() {
		const c = colours;
		ctx.save();
		if (game.shake > 0 && !reducedMotion.matches) ctx.translate((Math.random() - 0.5) * game.shake, (Math.random() - 0.5) * game.shake);

		// Graph paper.
		ctx.fillStyle = c.paper;
		ctx.fillRect(-10, -10, W + 20, H + 20);
		ctx.lineWidth = 1;
		for (let x = 0; x <= W; x += 24) {
			ctx.strokeStyle = x % 120 === 0 ? c.rule : c.grid;
			line(x + 0.5, 0, x + 0.5, GROUND);
		}
		for (let y = 0; y <= GROUND; y += 24) {
			ctx.strokeStyle = y % 120 === 0 ? c.rule : c.grid;
			line(0, y + 0.5, W, y + 0.5);
		}

		for (const cl of game.clouds) cloud(cl.x, cl.y, cl.s);

		// Ground, hatched like a technical drawing.
		ctx.fillStyle = c.paper2;
		ctx.fillRect(0, GROUND, W, H - GROUND);
		ctx.strokeStyle = c.ink3;
		ctx.lineWidth = 1;
		for (let x = -H; x < W; x += 12) line(x, H, x + (H - GROUND), GROUND);
		ctx.strokeStyle = c.ink;
		ctx.lineWidth = 3;
		line(0, GROUND, W, GROUND);

		stork(game.stork.x, STORK_Y, game.stork.dir, game.stork.flap, game.mode !== 'over' && game.nextDrop < 0.5);
		for (const it of game.items) item(it);
		basket(game.basket.x, GROUND - game.basket.h, game.basket.w, game.basket.h);

		for (const p of game.particles) {
			ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
			ctx.fillStyle = p.colour;
			ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
		}
		ctx.globalAlpha = 1;
		for (const f of game.floaters) {
			ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.5));
			ctx.fillStyle = f.colour;
			ctx.font = '700 15px "Martian Mono", ui-monospace, monospace';
			ctx.textAlign = 'center';
			ctx.fillText(f.text, f.x, f.y);
		}
		ctx.globalAlpha = 1;

		hud();
		if (game.flash > 0) {
			ctx.globalAlpha = game.flash * 0.18;
			ctx.fillStyle = c.error;
			ctx.fillRect(-10, -10, W + 20, H + 20);
			ctx.globalAlpha = 1;
		}
		ctx.restore();
	}

	function line(x1, y1, x2, y2) {
		ctx.beginPath();
		ctx.moveTo(x1, y1);
		ctx.lineTo(x2, y2);
		ctx.stroke();
	}

	function hud() {
		const c = colours;
		ctx.textBaseline = 'alphabetic';
		ctx.font = '600 13px "Martian Mono", ui-monospace, monospace';
		ctx.textAlign = 'left';
		ctx.fillStyle = c.ink2;
		ctx.fillText('SCORE', 14, 24);
		ctx.font = '800 24px "Anybody", "Arial Black", sans-serif';
		ctx.fillStyle = c.ink;
		ctx.fillText(String(game.score).padStart(4, '0'), 14, 50);
		ctx.textAlign = 'right';
		ctx.font = '600 13px "Martian Mono", ui-monospace, monospace';
		ctx.fillStyle = c.ink2;
		ctx.fillText('LIVES', W - 14, 24);
		for (let i = 0; i < MAX_LIVES; i++) egg(W - 22 - i * 22, 40, 8, i < game.lives);
	}

	function egg(x, y, r, full) {
		ctx.beginPath();
		ctx.moveTo(x, y - r * 1.25);
		ctx.bezierCurveTo(x + r * 0.95, y - r * 1.25, x + r * 1.05, y + r, x, y + r);
		ctx.bezierCurveTo(x - r * 1.05, y + r, x - r * 0.95, y - r * 1.25, x, y - r * 1.25);
		ctx.closePath();
		ctx.fillStyle = full ? colours.accent : 'transparent';
		ctx.fill();
		ctx.strokeStyle = colours.ink;
		ctx.lineWidth = 2;
		ctx.stroke();
	}

	function cloud(x, y, s) {
		ctx.save();
		ctx.translate(x, y);
		ctx.scale(s, s);
		ctx.beginPath();
		ctx.arc(-22, 6, 16, Math.PI * 0.5, Math.PI * 1.5);
		ctx.arc(-4, -6, 20, Math.PI, Math.PI * 1.9);
		ctx.arc(20, 2, 15, Math.PI * 1.3, Math.PI * 0.5);
		ctx.closePath();
		ctx.fillStyle = colours.panel;
		ctx.fill();
		ctx.strokeStyle = colours.ink3;
		ctx.lineWidth = 1.5 / s;
		ctx.stroke();
		ctx.restore();
	}

	function stork(x, y, dir, flap, carrying) {
		const c = colours;
		const lift = Math.sin(flap) * 14;
		ctx.save();
		ctx.translate(x, y);
		ctx.scale(dir, 1);
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		// Legs, trailing.
		ctx.strokeStyle = c.beak;
		ctx.lineWidth = 2.5;
		line(-16, 6, -46, 12);
		line(-16, 9, -46, 17);
		// Far wing.
		wing(-lift * 0.6, true);
		// Body and tail.
		ctx.fillStyle = c.feather;
		ctx.strokeStyle = c.outline;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.ellipse(0, 0, 26, 12, -0.08, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = c.outline;
		ctx.beginPath();
		ctx.moveTo(-22, -4);
		ctx.lineTo(-34, -2);
		ctx.lineTo(-23, 5);
		ctx.closePath();
		ctx.fill();
		// Neck: an outlined thick stroke.
		ctx.strokeStyle = c.outline;
		ctx.lineWidth = 9;
		ctx.beginPath();
		ctx.moveTo(18, -4);
		ctx.quadraticCurveTo(30, -6, 34, -16);
		ctx.stroke();
		ctx.strokeStyle = c.feather;
		ctx.lineWidth = 5.5;
		ctx.stroke();
		// Head, eye, beak.
		ctx.fillStyle = c.feather;
		ctx.strokeStyle = c.outline;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(36, -18, 7, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = c.outline;
		ctx.beginPath();
		ctx.arc(38.5, -20, 1.6, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = c.beak;
		ctx.beginPath();
		ctx.moveTo(41, -21);
		ctx.lineTo(64, -13);
		ctx.lineTo(41, -15);
		ctx.closePath();
		ctx.fill();
		ctx.lineWidth = 1.5;
		ctx.stroke();
		// Near wing.
		wing(lift, false);
		// The next delivery, dangling.
		if (carrying) {
			ctx.strokeStyle = c.outline;
			ctx.lineWidth = 1.5;
			line(60, -13, 60, 8);
			ctx.restore();
			bundle(x + dir * 60, y + 18, 10, 0);
			return;
		}
		ctx.restore();

		function wing(l, far) {
			ctx.beginPath();
			ctx.moveTo(-10, -5);
			ctx.quadraticCurveTo(-4, -22 - l, 14, -30 - l * 1.3);
			ctx.lineTo(20, -22 - l);
			ctx.quadraticCurveTo(10, -10, 4, -3);
			ctx.closePath();
			ctx.fillStyle = far ? c.featherShade : c.feather;
			ctx.fill();
			ctx.strokeStyle = c.outline;
			ctx.lineWidth = 2;
			ctx.stroke();
			// Black flight feathers at the tip.
			ctx.beginPath();
			ctx.moveTo(6, -24 - l * 1.1);
			ctx.lineTo(14, -30 - l * 1.3);
			ctx.lineTo(20, -22 - l);
			ctx.lineTo(12, -17 - l * 0.8);
			ctx.closePath();
			ctx.fillStyle = c.outline;
			ctx.fill();
		}
	}

	function item(it) {
		if (it.kind === 'bundle') bundle(it.x, it.y, it.r, it.rot);
		else if (it.kind === 'bottle') bottle(it.x, it.y, it.rot);
		else if (it.kind === 'coffee') coffee(it.x, it.y);
		else advice(it.x, it.y, it.text);
	}

	function bundle(x, y, r, rot) {
		// A parcel with a ribbon and a bow: the stork's actual job.
		const c = colours;
		const h = r * 0.95;
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(rot);
		ctx.lineJoin = 'round';
		ctx.strokeStyle = c.outline;
		ctx.lineWidth = 2;
		ctx.fillStyle = c.cloth;
		roundRect(-h, -h, h * 2, h * 2, 3);
		ctx.fill();
		ctx.fillStyle = c.accent;
		ctx.fillRect(-2.5, -h, 5, h * 2);
		ctx.fillRect(-h, -2.5, h * 2, 5);
		roundRect(-h, -h, h * 2, h * 2, 3);
		ctx.stroke();
		// The bow.
		ctx.fillStyle = c.accent;
		for (const side of [-1, 1]) {
			ctx.beginPath();
			ctx.moveTo(0, -h);
			ctx.quadraticCurveTo(side * h * 0.9, -h * 1.9, side * h * 0.75, -h * 1.05);
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
		}
		ctx.restore();
	}

	function bottle(x, y, rot) {
		const c = colours;
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(rot);
		ctx.strokeStyle = c.outline;
		ctx.lineWidth = 2;
		// Teat, collar, bottle, milk.
		ctx.fillStyle = c.soon;
		ctx.beginPath();
		ctx.ellipse(0, -15, 4, 5, 0, Math.PI, 0);
		ctx.lineTo(4, -11);
		ctx.lineTo(-4, -11);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = c.yes;
		roundRect(-8, -12, 16, 5, 2);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = c.glass;
		roundRect(-7, -7, 14, 22, 3);
		ctx.fill();
		ctx.fillStyle = c.milk;
		roundRect(-7, 1, 14, 14, 3);
		ctx.fill();
		roundRect(-7, -7, 14, 22, 3);
		ctx.stroke();
		ctx.restore();
	}

	function coffee(x, y) {
		const c = colours;
		ctx.save();
		ctx.translate(x, y);
		ctx.strokeStyle = c.outline;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(10, 1, 5, -Math.PI / 2, Math.PI / 2);
		ctx.stroke();
		ctx.fillStyle = c.no;
		roundRect(-10, -8, 20, 18, 3);
		ctx.fill();
		ctx.stroke();
		ctx.strokeStyle = c.ink3;
		ctx.lineWidth = 1.5;
		for (const dx of [-4, 3]) {
			ctx.beginPath();
			ctx.moveTo(dx, -11);
			ctx.quadraticCurveTo(dx + 3, -15, dx, -19);
			ctx.stroke();
		}
		ctx.restore();
	}

	function advice(x, y, text) {
		const c = colours;
		ctx.save();
		ctx.font = '600 11px "Martian Mono", ui-monospace, monospace';
		const w = Math.ceil(ctx.measureText(text).width) + 16;
		const h = 24;
		ctx.translate(Math.max(w / 2 + 2, Math.min(W - w / 2 - 2, x)), y);
		ctx.fillStyle = c.panel;
		ctx.strokeStyle = c.error;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(-w / 2 + 4, -h / 2);
		ctx.lineTo(w / 2 - 4, -h / 2);
		ctx.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + 4);
		ctx.lineTo(w / 2, h / 2 - 4);
		ctx.quadraticCurveTo(w / 2, h / 2, w / 2 - 4, h / 2);
		ctx.lineTo(-4, h / 2);
		ctx.lineTo(-10, h / 2 + 7);
		ctx.lineTo(-12, h / 2);
		ctx.lineTo(-w / 2 + 4, h / 2);
		ctx.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - 4);
		ctx.lineTo(-w / 2, -h / 2 + 4);
		ctx.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + 4, -h / 2);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = c.ink;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(text, 0, 1);
		ctx.restore();
	}

	function basket(x, y, w, h) {
		const c = colours;
		ctx.save();
		ctx.translate(x, y);
		ctx.strokeStyle = c.outline;
		ctx.lineWidth = 2;
		// Handle.
		ctx.beginPath();
		ctx.ellipse(0, 2, w * 0.36, h * 0.85, 0, Math.PI, 0);
		ctx.stroke();
		// Body: a trapezoid with a weave.
		ctx.beginPath();
		ctx.moveTo(-w / 2, 4);
		ctx.lineTo(w / 2, 4);
		ctx.lineTo(w / 2 - 8, h);
		ctx.lineTo(-w / 2 + 8, h);
		ctx.closePath();
		ctx.fillStyle = c.wicker;
		ctx.fill();
		ctx.save();
		ctx.clip();
		ctx.strokeStyle = c.wickerDark;
		ctx.lineWidth = 1.5;
		for (let yy = 10; yy < h; yy += 6) line(-w / 2, yy, w / 2, yy);
		for (let xx = -w / 2; xx < w / 2; xx += 9) line(xx, 4, xx + 3, h);
		ctx.restore();
		ctx.beginPath();
		ctx.moveTo(-w / 2, 4);
		ctx.lineTo(w / 2, 4);
		ctx.lineTo(w / 2 - 8, h);
		ctx.lineTo(-w / 2 + 8, h);
		ctx.closePath();
		ctx.stroke();
		// Rim.
		ctx.fillStyle = c.wickerDark;
		roundRect(-w / 2 - 3, 0, w + 6, 7, 3);
		ctx.fill();
		ctx.stroke();
		ctx.restore();
	}

	function roundRect(x, y, w, h, r) {
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}

	// ── Input ──────────────────────────────────────────────────────────────────
	const typing = (el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

	document.addEventListener('keydown', (e) => {
		if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
		const key = e.key;
		if (key === 'ArrowLeft' || key === 'a' || key === 'A') {
			input.left = true;
			input.pointerX = null;
			if (game.mode === 'playing') e.preventDefault();
		} else if (key === 'ArrowRight' || key === 'd' || key === 'D') {
			input.right = true;
			input.pointerX = null;
			if (game.mode === 'playing') e.preventDefault();
		} else if (key === ' ' || key === 'p' || key === 'P') {
			if (game.mode === 'playing') {
				e.preventDefault();
				pause('Paused');
			} else if (game.mode === 'paused') {
				e.preventDefault();
				resume();
			}
		} else if (key === 'm' || key === 'M') {
			setSound(!soundOn);
		}
	});
	document.addEventListener('keyup', (e) => {
		if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') input.left = false;
		if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') input.right = false;
	});

	const toCanvasX = (clientX) => {
		const rect = canvas.getBoundingClientRect();
		return ((clientX - rect.left) / rect.width) * W;
	};
	canvas.addEventListener('pointerdown', (e) => {
		if (game.mode !== 'playing') return;
		input.pointerX = toCanvasX(e.clientX);
		canvas.setPointerCapture?.(e.pointerId);
		e.preventDefault();
	});
	canvas.addEventListener('pointermove', (e) => {
		if (game.mode !== 'playing') return;
		// Mouse: follow while hovering. Touch and pen: only while pressed.
		if (e.pointerType === 'mouse' || e.buttons) input.pointerX = toCanvasX(e.clientX);
	});
	const release = (e) => {
		if (e.pointerType !== 'mouse') input.pointerX = null;
	};
	canvas.addEventListener('pointerup', release);
	canvas.addEventListener('pointercancel', release);
	canvas.addEventListener('pointerleave', () => {
		input.pointerX = null;
	});

	const hold = (btn, dir) => {
		if (!btn) return;
		const on = (e) => {
			e.preventDefault();
			input.pointerX = null;
			input.buttonDir = dir;
		};
		const off = () => {
			if (input.buttonDir === dir) input.buttonDir = 0;
		};
		btn.addEventListener('pointerdown', on);
		btn.addEventListener('pointerup', off);
		btn.addEventListener('pointerleave', off);
		btn.addEventListener('pointercancel', off);
		btn.addEventListener('contextmenu', (e) => e.preventDefault());
	};
	hold(leftBtn, -1);
	hold(rightBtn, 1);

	startBtn?.addEventListener('click', () => {
		if (game.mode === 'paused') resume();
		else start();
	});
	pauseBtn?.addEventListener('click', () => {
		if (game.mode === 'playing') pause('Paused');
		else if (game.mode === 'paused') resume();
	});

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) pause('The stork noticed you left');
	});
	window.addEventListener('blur', () => pause('Away from the desk'));

	// ── Scores ─────────────────────────────────────────────────────────────────
	function resetForm(text) {
		if (fieldset) fieldset.disabled = true;
		if (hint) hint.textContent = text;
		if (notice) notice.replaceChildren();
	}

	async function offerScore() {
		if (!form || !fieldset) return;
		if (game.tokenPending) await game.tokenPending;
		if (game.score < 1) {
			resetForm('Zero points. The stork appreciates the effort; the leaderboard does not.');
			return;
		}
		if (!game.token) {
			resetForm("This round can't be lodged: the scorekeeper was out when it started. The next one can.");
			return;
		}
		tokenInput.value = game.token;
		scoreInput.value = String(game.score);
		if (initialsInput && !initialsInput.value) initialsInput.value = store('stork-initials') || '';
		fieldset.disabled = false;
		if (hint) hint.textContent = `You scored ${game.score}. Lodge it under three initials.`;
		if (notice) notice.replaceChildren();
		if (window.matchMedia('(pointer: fine)').matches) initialsInput?.focus({ preventScroll: true });
	}

	function say(kind, text) {
		if (!notice) return;
		const p = document.createElement('p');
		p.className = `notice notice-${kind}`;
		p.setAttribute('role', kind === 'error' ? 'alert' : 'status');
		p.textContent = text;
		notice.replaceChildren(p);
	}

	form?.addEventListener('submit', async (e) => {
		e.preventDefault();
		if (!fieldset || fieldset.disabled) return;
		const initials = (initialsInput?.value || '').trim().toUpperCase();
		if (!/^[A-Z]{3}$/.test(initials)) {
			say('error', 'Initials are exactly three letters, A to Z. Arcade rules.');
			initialsInput?.focus();
			return;
		}
		const turnstile = form.querySelector('[name="cf-turnstile-response"]');
		const payload = {
			token: tokenInput.value,
			score: Number(scoreInput.value),
			initials,
			'cf-turnstile-response': turnstile instanceof HTMLInputElement ? turnstile.value : undefined,
		};
		const button = form.querySelector('button[type="submit"]');
		if (button) button.disabled = true;
		say('ok', 'Lodging…');
		let data = null;
		let status = 0;
		try {
			const res = await fetch(form.action, {
				method: 'POST',
				headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			status = res.status;
			data = await res.json().catch(() => null);
		} catch {
			data = null;
		}
		if (button) button.disabled = false;
		try {
			window.turnstile?.reset();
		} catch {
			/* no widget */
		}
		if (data?.ok) {
			store('stork-initials', initials);
			resetForm('Lodged. Play again to beat it.');
			say('ok', `Lodged: ${initials} with ${data.score}, number ${data.rank} on the board.`);
			window.iszacka?.announce?.(`Score lodged at number ${data.rank}.`);
			if (Array.isArray(data.scores)) renderBoard(data.scores, data.id, data.rank);
			return;
		}
		const error = data?.error || (status ? `That didn't work (HTTP ${status}). Please try again.` : "Couldn't reach the scorekeeper. Check your connection and try again.");
		say('error', error);
		// A spent or refused game can't be lodged again.
		if (typeof data?.code === 'string' && (data.code === 'duplicate' || data.code === 'implausible' || data.code === 'daily_limit' || data.code.startsWith('token_'))) {
			if (fieldset) fieldset.disabled = true;
		}
	});

	const dateFormat = (() => {
		try {
			return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
		} catch {
			return null;
		}
	})();

	function renderBoard(scores, newId, newRank) {
		const body = document.querySelector('[data-stork-board]');
		const wrap = document.querySelector('[data-stork-board-wrap]');
		const empty = document.querySelector('[data-stork-empty]');
		if (!body) return;
		const rows = scores.map((s) => {
			const tr = document.createElement('tr');
			if (s.rank === newRank && newId) tr.className = 'is-new';
			const rank = document.createElement('td');
			rank.className = 'mono';
			rank.textContent = String(s.rank);
			const who = document.createElement('th');
			who.scope = 'row';
			who.className = 'mono stork-initials';
			who.textContent = String(s.initials);
			const score = document.createElement('td');
			score.className = 'mono';
			score.textContent = Number(s.score).toLocaleString('en-GB');
			const when = document.createElement('td');
			when.className = 'tiny muted';
			const time = document.createElement('time');
			time.dateTime = String(s.at);
			time.textContent = dateFormat ? dateFormat.format(new Date(s.at)) : String(s.at).slice(0, 10);
			when.append(time);
			tr.append(rank, who, score, when);
			return tr;
		});
		body.replaceChildren(...rows);
		if (wrap) wrap.hidden = rows.length === 0;
		if (empty) empty.hidden = rows.length > 0;
	}

	// ── Boot ───────────────────────────────────────────────────────────────────
	function makeClouds() {
		return [
			{ x: 60, y: 150, s: 1, speed: 8 },
			{ x: 300, y: 210, s: 0.8, speed: 5 },
			{ x: 420, y: 130, s: 0.65, speed: 11 },
			{ x: 180, y: 290, s: 0.9, speed: 6 },
		];
	}

	resize();
	// Web fonts may land after the first frame; redraw once they have.
	document.fonts?.ready?.then(() => draw());
}

/** The site's palette from its CSS custom properties, plus a few game-only colours. */
function readColours() {
	const css = getComputedStyle(document.documentElement);
	const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
	const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
	return {
		paper: v('--paper', '#f1ece1'),
		paper2: v('--paper-2', '#e6dfcf'),
		panel: v('--panel', '#f9f6ef'),
		ink: v('--ink', '#17140f'),
		ink2: v('--ink-2', '#4c4538'),
		ink3: v('--ink-3', '#786f5d'),
		rule: v('--rule', 'rgb(23 20 15 / 0.13)'),
		grid: v('--grid', 'rgb(23 20 15 / 0.055)'),
		no: v('--no', '#e2491f'),
		soon: v('--soon', '#f2a300'),
		yes: v('--yes', '#14864a'),
		error: v('--error', '#c42b1c'),
		accent: v('--accent', '#e2491f'),
		// The stork is white whatever the weather, with an outline that reads on both papers.
		feather: '#fbfaf6',
		featherShade: '#ddd8cc',
		outline: '#17140f',
		beak: '#f08a24',
		cloth: dark ? '#efe6d3' : '#fffaf0',
		glass: '#f4f8fb',
		milk: '#fffdf7',
		wicker: '#c8925a',
		wickerDark: '#8f5f30',
	};
}
