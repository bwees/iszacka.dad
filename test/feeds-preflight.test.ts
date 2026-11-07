import { describe, expect, it } from 'vitest';
import { feedRoutes } from '../src/routes/feeds';

describe('CORS preflight for feeds and the badge', () => {
	it.each(['/feed.xml', '/rss.xml', '/atom.xml', '/feed.json', '/calendar.ics', '/badge.svg'])('answers OPTIONS %s', async (path) => {
		const res = await feedRoutes.request(`https://iszacka.dad${path}`, {
			method: 'OPTIONS',
			headers: { Origin: 'https://reader.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'if-none-match' },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('if-none-match');
		expect(res.headers.get('access-control-allow-methods')).toContain('GET');
	});
});
