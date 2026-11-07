import { describe, expect, it } from 'vitest';
import {
	FEED_CONTENT_TYPES,
	buildJsonFeed,
	escapeIcalText,
	escapeXml,
	etagFor,
	etagMatches,
	feedUpdatedAt,
	foldIcalLine,
	icalDateTime,
	renderAtom,
	renderIcal,
	renderJsonFeed,
	renderRss,
	rfc822,
	textToHtml,
	updateTagId,
} from '../src/lib/feeds';
import type { SiteState, Update } from '../src/types';

const SITE = 'https://iszacka.dad';

const update = (over: Partial<Update> & Pick<Update, 'id'>): Update => ({
	kind: 'daily',
	title: `Day ${over.id}: still no.`,
	body: 'Nothing to report.',
	status: 'no',
	audience: 'daily',
	createdAt: `2026-11-0${over.id}T09:00:00.000Z`,
	notifiedAt: null,
	...over,
});

const UPDATES: Update[] = [
	update({ id: 3, body: 'Line one\nline two\n\nNew paragraph & more' }),
	update({ id: 2, kind: 'system', title: 'Tom & Jerry <script>alert(1)</script>', body: '' }),
	update({ id: 1, kind: 'status', title: 'Zack is not a dad.', body: "It's \"official\"." }),
];

const NO: SiteState = { status: 'no', statusChangedAt: '2026-11-01T08:00:00.000Z', dueDate: '2026-11-20' };

/** Every & must start an entity; no raw < inside text. A cheap well-formedness smoke test. */
function assertEntitiesSafe(xml: string): void {
	expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
	expect(xml).not.toContain('<script');
}

describe('escaping', () => {
	it('escapes XML metacharacters and drops characters XML cannot carry', () => {
		expect(escapeXml(`<a href="x">Tom & 'Jerry'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;');
		expect(escapeXml('bell\u0007 nul\u0000 ok\ttab')).toBe('bell nul ok\ttab');
		expect(escapeXml('lone \uD800 surrogate, pair 👶 kept')).toBe('lone  surrogate, pair 👶 kept');
	});

	it('turns plain text into paragraphs and line breaks', () => {
		expect(textToHtml('a\nb\n\nc <d>')).toBe('<p>a<br>b</p><p>c &lt;d&gt;</p>');
		expect(textToHtml('')).toBe('');
	});

	it('formats RFC 822 dates for RSS', () => {
		expect(rfc822('2026-11-06T21:30:00.000Z')).toBe('Fri, 06 Nov 2026 21:30:00 GMT');
	});

	it('picks the latest change for the feed timestamp', () => {
		expect(feedUpdatedAt(NO, UPDATES)).toBe('2026-11-03T09:00:00.000Z');
		expect(feedUpdatedAt({ ...NO, statusChangedAt: '2026-12-01T00:00:00.000Z' }, UPDATES)).toBe('2026-12-01T00:00:00.000Z');
		expect(feedUpdatedAt(NO, [])).toBe(NO.statusChangedAt);
	});
});

describe('RSS 2.0', () => {
	const rss = renderRss({ siteUrl: SITE, state: NO, updates: UPDATES, selfPath: '/rss.xml' });

	it('has the channel essentials and a self link', () => {
		expect(rss.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">')).toBe(true);
		expect(rss).toContain('<atom:link href="https://iszacka.dad/rss.xml" rel="self" type="application/rss+xml"/>');
		expect(rss).toContain('<link>https://iszacka.dad/</link>');
		expect(rss).toContain('<lastBuildDate>Tue, 03 Nov 2026 09:00:00 GMT</lastBuildDate>');
	});

	it('renders items with non-permalink guids, RFC 822 dates and links to /updates/:id', () => {
		expect(rss.match(/<item>/g)).toHaveLength(3);
		expect(rss).toContain(`<guid isPermaLink="false">${updateTagId(3)}</guid>`);
		expect(rss).toContain('<link>https://iszacka.dad/updates/3</link>');
		expect(rss).toContain('<pubDate>Tue, 03 Nov 2026 09:00:00 GMT</pubDate>');
	});

	it('escapes everything', () => {
		expect(rss).toContain('<title>Tom &amp; Jerry &lt;script&gt;alert(1)&lt;/script&gt;</title>');
		expect(rss).toContain('&lt;p&gt;Line one&lt;br&gt;line two&lt;/p&gt;&lt;p&gt;New paragraph &amp;amp; more&lt;/p&gt;');
		assertEntitiesSafe(rss);
	});

	it('falls back to the title when the body is empty', () => {
		expect(rss).toContain('<description>&lt;p&gt;Tom &amp;amp; Jerry');
	});
});

describe('Atom 1.0', () => {
	const atom = renderAtom({ siteUrl: SITE, state: NO, updates: UPDATES });

	it('has id, title, updated, author and links', () => {
		expect(atom).toContain('<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-GB">');
		expect(atom).toContain('<id>tag:iszacka.dad,2026:feed</id>');
		expect(atom).toContain('<updated>2026-11-03T09:00:00.000Z</updated>');
		expect(atom).toContain('<link rel="self" type="application/atom+xml" href="https://iszacka.dad/atom.xml"/>');
		expect(atom).toContain('<author><name>Jess &amp; Zack</name>');
	});

	it('renders entries with tag ids, RFC 3339 dates and html content', () => {
		expect(atom.match(/<entry>/g)).toHaveLength(3);
		expect(atom).toContain(`<id>${updateTagId(1)}</id>`);
		expect(atom).toContain('<published>2026-11-01T09:00:00.000Z</published>');
		expect(atom).toContain('<link rel="alternate" type="text/html" href="https://iszacka.dad/updates/1"/>');
		expect(atom).toContain('<content type="html">&lt;p&gt;It&amp;#39;s &amp;quot;official&amp;quot;.&lt;/p&gt;</content>');
		assertEntitiesSafe(atom);
	});
});

describe('JSON Feed 1.1', () => {
	it('is valid JSON with the 1.1 version, items and our extension', () => {
		const parsed = JSON.parse(renderJsonFeed({ siteUrl: SITE, state: NO, updates: UPDATES })) as ReturnType<typeof buildJsonFeed>;
		expect(parsed.version).toBe('https://jsonfeed.org/version/1.1');
		expect(parsed.feed_url).toBe('https://iszacka.dad/feed.json');
		expect(parsed.home_page_url).toBe('https://iszacka.dad/');
		expect(parsed.items).toHaveLength(3);
		expect(parsed.items[0]).toMatchObject({
			id: updateTagId(3),
			url: 'https://iszacka.dad/updates/3',
			title: 'Day 3: still no.',
			date_published: '2026-11-03T09:00:00.000Z',
			tags: ['daily', 'status:no'],
		});
		expect(parsed.items[1]?.content_text).toBe(UPDATES[1]?.title);
		expect(parsed._is_zack_a_dad).toMatchObject({ status: 'no', answer: 'NO', dueDate: '2026-11-20' });
	});

	it('advertises charset in every content type', () => {
		for (const type of Object.values(FEED_CONTENT_TYPES)) expect(type).toMatch(/; charset=utf-8$/);
	});
});

describe('iCalendar', () => {
	const render = (state: SiteState, extra: { dueDateModifiedAt?: string } = {}) =>
		renderIcal({ siteUrl: SITE, state, stampedAt: state.statusChangedAt, ...extra });
	const unfold = (ics: string) => ics.replace(/\r\n /g, '');
	const events = (ics: string) => unfold(ics).match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];

	it('uses CRLF everywhere and folds at 75 octets', () => {
		const ics = render({ ...NO, status: 'soon' });
		expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
		expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
		for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
	});

	it('has the calendar-level properties', () => {
		const ics = unfold(render(NO));
		expect(ics).toContain('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:');
		expect(ics).toContain('X-WR-CALNAME:Is Zack a Dad?');
		expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
		expect(ics).toContain('X-PUBLISHED-TTL:PT1H');
		expect(ics).toContain('METHOD:PUBLISH');
	});

	it('has only the all-day due date while the answer is no', () => {
		const ics = render(NO, { dueDateModifiedAt: '2026-10-01T12:00:00.000Z' });
		const list = events(ics);
		expect(list).toHaveLength(1);
		expect(list[0]).toContain('UID:due-date@iszacka.dad');
		expect(list[0]).toContain('DTSTART;VALUE=DATE:20261120');
		expect(list[0]).toContain('DTEND;VALUE=DATE:20261121');
		expect(list[0]).toContain('DTSTAMP:20261101T080000Z');
		expect(list[0]).toContain('LAST-MODIFIED:20261001T120000Z');
		expect(list[0]).toContain('STATUS:TENTATIVE');
	});

	it("adds \"It's happening\" at the status change when labour starts", () => {
		const soon: SiteState = { ...NO, status: 'soon', statusChangedAt: '2026-11-18T03:14:00.000Z' };
		const list = events(render(soon));
		expect(list).toHaveLength(2);
		const happening = list.find((e) => e.includes("SUMMARY:It's happening"));
		expect(happening).toContain('DTSTART:20261118T031400Z');
		expect(happening).toContain('UID:its-happening-20261118T031400Z@iszacka.dad');
	});

	it('adds "Zack became a dad" when yes, and needs no due date', () => {
		const yes: SiteState = { status: 'yes', statusChangedAt: '2026-11-19T22:05:00.000Z', dueDate: null };
		const list = events(render(yes));
		expect(list).toHaveLength(1);
		expect(list[0]).toContain('SUMMARY:Zack became a dad');
		expect(list[0]).toContain('DTSTART:20261119T220500Z');
	});

	it('has no events when there is nothing to put in a calendar', () => {
		expect(events(render({ ...NO, dueDate: null }))).toHaveLength(0);
	});

	it('produces identical output (and UIDs) for identical state', () => {
		expect(render(NO)).toBe(render(NO));
	});

	it('escapes TEXT values', () => {
		expect(escapeIcalText('a;b,c\\d\ne\r\nf\u0007')).toBe('a\\;b\\,c\\\\d\\ne\\nf');
	});

	it('folds without splitting multi-byte characters and unfolds losslessly', () => {
		const line = `DESCRIPTION:${'Zack is not a dad 👶 – ç’est la vie. '.repeat(6)}`;
		const folded = foldIcalLine(line);
		for (const physical of folded.split('\r\n')) {
			expect(new TextEncoder().encode(physical).length).toBeLessThanOrEqual(75);
			expect(physical).not.toContain('\uFFFD');
		}
		expect(folded.replace(/\r\n /g, '')).toBe(line);
		expect(foldIcalLine('SHORT:line')).toBe('SHORT:line');
	});

	it('formats UTC date-times', () => {
		expect(icalDateTime('2026-11-06T21:30:05.123Z')).toBe('20261106T213005Z');
	});
});

describe('ETags', () => {
	it('is stable, quoted and content-sensitive', async () => {
		const a = await etagFor('hello');
		expect(a).toMatch(/^"[0-9a-f]{32}"$/);
		expect(await etagFor('hello')).toBe(a);
		expect(await etagFor('hello!')).not.toBe(a);
	});

	it('matches If-None-Match with weak comparison, lists and *', () => {
		const tag = '"abc"';
		expect(etagMatches('"abc"', tag)).toBe(true);
		expect(etagMatches('W/"abc"', tag)).toBe(true);
		expect(etagMatches('"x", W/"abc" ', tag)).toBe(true);
		expect(etagMatches('*', tag)).toBe(true);
		expect(etagMatches('"abd"', tag)).toBe(false);
		expect(etagMatches(undefined, tag)).toBe(false);
		expect(etagMatches('', tag)).toBe(false);
	});
});
