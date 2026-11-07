import { describe, expect, it } from 'vitest';
import { fillDays, fillHours, isBot, isPrefetch, normaliseColo, normaliseCountry } from '../src/lib/counters';
import { coloCities, coloInfo, countryName, flagEmoji } from '../src/lib/counters-geo';

const HUMANS = {
	'Chrome on Windows':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	'Safari on iPhone':
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
	'Firefox on Linux': 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
	'Samsung Internet': 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
	'a phone made by Cubot':
		'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
	'Pinterest in-app browser':
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [Pinterest/iOS]',
	curl: 'curl/8.10.1',
	wget: 'Wget/1.24.5',
	HTTPie: 'HTTPie/3.2.4',
};

const BOTS = {
	Googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
	bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
	Slackbot: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
	'Slack image proxy': 'Slack-ImgProxy (+https://api.slack.com/robots)',
	Discordbot: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
	facebookexternalhit: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
	Twitterbot: 'Twitterbot/1.0',
	WhatsApp: 'WhatsApp/2.23.20.0 A',
	TelegramBot: 'TelegramBot (like TwitterBot)',
	LinkedInBot: 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
	Applebot: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1)',
	'Bing preview': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) BingPreview/1.0b',
	HeadlessChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36',
	Lighthouse: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
	UptimeRobot: 'Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
	Mastodon: 'http.rb/5.2.0 (Mastodon/4.3.0; +https://mastodon.social/)',
	'Bluesky cardyb': 'Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)',
	GPTBot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
	ClaudeBot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
	AhrefsBot: 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
	'python-requests': 'python-requests/2.32.3',
	'Go HTTP client': 'Go-http-client/2.0',
	'Node fetch': 'node',
	'an empty user agent': '',
};

describe('isBot', () => {
	for (const [name, ua] of Object.entries(HUMANS)) {
		it(`counts ${name} as a human`, () => expect(isBot(ua)).toBe(false));
	}
	for (const [name, ua] of Object.entries(BOTS)) {
		it(`ignores ${name}`, () => expect(isBot(ua)).toBe(true));
	}
	it('ignores a missing user agent', () => {
		expect(isBot(null)).toBe(true);
		expect(isBot(undefined)).toBe(true);
		expect(isBot('   ')).toBe(true);
	});
	it('is stateless between calls (no sticky regex lastIndex)', () => {
		for (let i = 0; i < 3; i++) {
			expect(isBot(HUMANS['a phone made by Cubot'])).toBe(false);
			expect(isBot(BOTS.Googlebot)).toBe(true);
		}
	});
});

describe('isPrefetch', () => {
	it('spots speculative loads', () => {
		expect(isPrefetch(new Headers({ 'Sec-Purpose': 'prefetch' }))).toBe(true);
		expect(isPrefetch(new Headers({ 'Sec-Purpose': 'prefetch;prerender' }))).toBe(true);
		expect(isPrefetch(new Headers({ Purpose: 'prefetch' }))).toBe(true);
		expect(isPrefetch(new Headers({ 'X-Moz': 'prefetch' }))).toBe(true);
		expect(isPrefetch(new Headers({ 'X-Purpose': 'preview' }))).toBe(true);
	});
	it('lets ordinary navigations through', () => {
		expect(isPrefetch(new Headers({ Accept: 'text/html' }))).toBe(false);
	});
});

describe('normalising cf properties', () => {
	it('keeps valid country codes, including Tor', () => {
		expect(normaliseCountry('GB')).toBe('GB');
		expect(normaliseCountry('gb')).toBe('GB');
		expect(normaliseCountry('T1')).toBe('T1');
	});
	it('maps anything else to XX', () => {
		for (const bad of [undefined, null, '', 'GBR', 'G', '12', 7, '<b>']) expect(normaliseCountry(bad)).toBe('XX');
	});
	it('keeps valid colos and maps anything else to XXX', () => {
		expect(normaliseColo('LHR')).toBe('LHR');
		expect(normaliseColo('lhr')).toBe('LHR');
		for (const bad of [undefined, '', 'LH', 'LHRX', 'L1R', 42]) expect(normaliseColo(bad)).toBe('XXX');
	});
});

describe('flagEmoji', () => {
	it('builds regional-indicator flags', () => {
		expect(flagEmoji('GB')).toBe('🇬🇧');
		expect(flagEmoji('us')).toBe('🇺🇸');
		expect(flagEmoji('JP')).toBe('🇯🇵');
		expect(flagEmoji(' de ')).toBe('🇩🇪');
	});
	it('has opinions about Tor and unknowns', () => {
		expect(flagEmoji('T1')).toBe('🧅');
		expect(flagEmoji('XX')).toBe('🏳️');
		expect(flagEmoji('')).toBe('🏳️');
		expect(flagEmoji('GBR')).toBe('🏳️');
		expect(flagEmoji('1A')).toBe('🏳️');
	});
});

describe('countryName', () => {
	it('uses British English names', () => {
		expect(countryName('GB')).toBe('United Kingdom');
		expect(countryName('us')).toBe('United States');
	});
	it('handles the specials', () => {
		expect(countryName('XX')).toBe('Parts unknown');
		expect(countryName('T1')).toContain('Tor');
		expect(countryName('nonsense')).toBe('Parts unknown');
	});
});

describe('coloInfo', () => {
	it('knows the common datacentres', () => {
		expect(coloInfo('LHR')).toEqual({ code: 'LHR', city: 'London', country: 'GB', label: 'London' });
		expect(coloInfo('sin').city).toBe('Singapore');
		expect(coloInfo('EWR').country).toBe('US');
	});
	it('shrugs politely at codes it does not know', () => {
		expect(coloInfo('ZZZ')).toEqual({ code: 'ZZZ', city: null, country: null, label: 'somewhere with a runway called ZZZ' });
	});
	it('treats missing or malformed codes as undisclosed', () => {
		for (const bad of [null, undefined, '', 'XXX', 'LONDON', '12']) {
			expect(coloInfo(bad)).toMatchObject({ code: 'XXX', city: null, label: 'an undisclosed datacentre' });
		}
	});
	it('has a healthy number of well-formed entries', () => {
		const entries = Object.entries(coloCities());
		expect(entries.length).toBeGreaterThanOrEqual(60);
		for (const [code, [city, country]] of entries) {
			expect(code).toMatch(/^[A-Z]{3}$/);
			expect(city.length).toBeGreaterThan(0);
			expect(country).toMatch(/^[A-Z]{2}$/);
		}
	});
});

describe('analytics helpers', () => {
	it('zero-fills the last N days, oldest first, across a month boundary', () => {
		const days = fillDays(
			[
				{ day: '2026-11-01', count: 4 },
				{ day: '2026-10-30', count: 2 },
				{ day: '2026-09-01', count: 99 },
			],
			'2026-11-02',
			5,
		);
		expect(days).toEqual([
			{ day: '2026-10-29', count: 0 },
			{ day: '2026-10-30', count: 2 },
			{ day: '2026-10-31', count: 0 },
			{ day: '2026-11-01', count: 4 },
			{ day: '2026-11-02', count: 0 },
		]);
	});

	it('fills 24 hourly buckets and ignores out-of-range hours', () => {
		const hours = fillHours([
			{ hour: 0, count: 1 },
			{ hour: 23, count: 5 },
			{ hour: 24, count: 9 },
			{ hour: -1, count: 9 },
		]);
		expect(hours).toHaveLength(24);
		expect(hours[0]).toBe(1);
		expect(hours[23]).toBe(5);
		expect(hours.reduce((a, b) => a + b, 0)).toBe(6);
	});
});
