import { describe, expect, it } from 'vitest';
import {
	BADGE_COLOURS,
	BADGE_DEFAULT_LABEL,
	BADGE_LABEL_MAX,
	badgeMessage,
	estimateTextWidth,
	isBadgeStyle,
	renderBadge,
	sanitiseBadgeLabel,
} from '../src/lib/feeds-badge';

const svgWidth = (svg: string) => Number(/<svg[^>]* width="(\d+)"/.exec(svg)?.[1]);
const svgHeight = (svg: string) => Number(/<svg[^>]* height="(\d+)"/.exec(svg)?.[1]);

describe('badge text', () => {
	it('says no, not yet or yes', () => {
		expect(badgeMessage('no')).toBe('no');
		expect(badgeMessage('soon')).toBe('not yet');
		expect(badgeMessage('yes')).toBe('yes');
	});

	it('uses red, amber and green', () => {
		expect(new Set(Object.values(BADGE_COLOURS)).size).toBe(3);
		expect(BADGE_COLOURS.no).toBe('#c62828');
		expect(BADGE_COLOURS.soon).toBe('#b45309');
		expect(BADGE_COLOURS.yes).toBe('#2e7d32');
	});

	it('defaults, trims, cleans and length-limits labels', () => {
		expect(sanitiseBadgeLabel(undefined)).toBe(BADGE_DEFAULT_LABEL);
		expect(sanitiseBadgeLabel('')).toBe('');
		expect(sanitiseBadgeLabel('  hello \n\t world  ')).toBe('hello world');
		expect(sanitiseBadgeLabel('a\u202Eb\u0000c')).toBe('a b c');
		expect(Array.from(sanitiseBadgeLabel('x'.repeat(500)))).toHaveLength(BADGE_LABEL_MAX);
	});

	it('accepts only known styles', () => {
		expect(isBadgeStyle('flat')).toBe(true);
		expect(isBadgeStyle('flat-square')).toBe(true);
		expect(isBadgeStyle('for-the-badge')).toBe(true);
		expect(isBadgeStyle('plastic')).toBe(false);
		expect(isBadgeStyle(undefined)).toBe(false);
	});
});

describe('text width estimation', () => {
	it('is sensible for Verdana 11px', () => {
		const w = estimateTextWidth(BADGE_DEFAULT_LABEL);
		expect(w).toBeGreaterThan(70);
		expect(w).toBeLessThan(90);
		expect(estimateTextWidth('mmm')).toBeGreaterThan(estimateTextWidth('iii'));
		expect(estimateTextWidth('NO')).toBeGreaterThan(estimateTextWidth('no'));
	});

	it('scales with size, weight and letter spacing', () => {
		const base = estimateTextWidth('not yet');
		expect(estimateTextWidth('not yet', { size: 22 })).toBeCloseTo(base * 2, 5);
		expect(estimateTextWidth('not yet', { bold: true })).toBeGreaterThan(base);
		expect(estimateTextWidth('ab', { letterSpacing: 2 })).toBeCloseTo(estimateTextWidth('ab') + 2, 5);
	});

	it('treats wide characters as wide and combining marks as nothing', () => {
		expect(estimateTextWidth('猫')).toBe(11);
		expect(estimateTextWidth('é')).toBe(estimateTextWidth('e'));
	});
});

describe('renderBadge', () => {
	const base = { label: BADGE_DEFAULT_LABEL, message: 'no', colour: BADGE_COLOURS.no } as const;

	it('renders an accessible flat badge', () => {
		const svg = renderBadge({ ...base, style: 'flat' });
		expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
		expect(svg).toContain('role="img"');
		expect(svg).toContain('aria-label="is zack a dad?: no"');
		expect(svg).toContain('<title>is zack a dad?: no</title>');
		expect(svg).toContain('fill="#c62828"');
		expect(svg).toContain('rx="3"');
		expect(svgHeight(svg)).toBe(20);
		expect(svgWidth(svg)).toBeGreaterThan(90);
	});

	it('flat-square has square corners and no gradient', () => {
		const svg = renderBadge({ ...base, style: 'flat-square' });
		expect(svg).not.toContain('rx=');
		expect(svg).not.toContain('linearGradient');
		expect(svgHeight(svg)).toBe(20);
	});

	it('for-the-badge is taller and shouts', () => {
		const svg = renderBadge({ ...base, message: 'not yet', style: 'for-the-badge' });
		expect(svgHeight(svg)).toBe(28);
		expect(svg).toContain('>IS ZACK A DAD?</text>');
		expect(svg).toContain('>NOT YET</text>');
		expect(svg).toContain('font-weight="bold"');
	});

	it('escapes hostile labels', () => {
		const svg = renderBadge({ ...base, label: '<script>alert("x")</script>&', style: 'flat' });
		expect(svg).not.toContain('<script');
		expect(svg).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;');
	});

	it('hides the label section when the label is empty', () => {
		const svg = renderBadge({ ...base, label: '', style: 'flat' });
		expect(svg).toContain('aria-label="no"');
		expect(svg).not.toContain('fill="#555"');
		expect(svgWidth(svg)).toBeLessThan(30);
	});

	it('grows with longer labels', () => {
		const short = svgWidth(renderBadge({ ...base, label: 'dad?', style: 'flat' }));
		const long = svgWidth(renderBadge({ ...base, label: 'is zack a dad yet, honestly?', style: 'flat' }));
		expect(long).toBeGreaterThan(short);
	});
});
