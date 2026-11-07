import { describe, expect, it } from 'vitest';
import { ogSubline, renderOgCardHtml } from '../src/lib/og-card';
import type { SiteState } from '../src/types';

const today = '2026-11-06';
const state = (over: Partial<SiteState>): SiteState => ({ status: 'no', statusChangedAt: '', dueDate: null, ...over });

describe('ogSubline', () => {
	it('counts down to and past the due date', () => {
		expect(ogSubline({ state: state({ dueDate: '2026-11-20' }), checks: 0, today }).headline).toBe('DUE IN 14 DAYS');
		expect(ogSubline({ state: state({ dueDate: '2026-11-07' }), checks: 0, today }).headline).toBe('DUE TOMORROW');
		expect(ogSubline({ state: state({ dueDate: '2026-11-06' }), checks: 0, today }).headline).toBe('DUE TODAY');
		expect(ogSubline({ state: state({ dueDate: '2026-11-05' }), checks: 0, today }).headline).toBe('1 DAY OVERDUE');
		expect(ogSubline({ state: state({ dueDate: '2026-11-01' }), checks: 0, today }).headline).toBe('5 DAYS OVERDUE');
		expect(ogSubline({ state: state({}), checks: 0, today }).headline).toBe('AWAITING FURTHER DEVELOPMENTS');
	});

	it('mentions the check count when there is one', () => {
		expect(ogSubline({ state: state({}), checks: 48213, today }).detail).toBe('Checked 48,213 times. The answer has been no every time.');
		expect(ogSubline({ state: state({}), checks: 1, today }).detail).toBe('Checked once. The answer has been no every time.');
		expect(ogSubline({ state: state({}), checks: Number.NaN, today }).detail).not.toContain('NaN');
	});

	it('reports labour with its start time', () => {
		const sub = ogSubline({ state: state({ status: 'soon', statusChangedAt: '2026-11-06T14:32:00Z' }), checks: 3, today });
		expect(sub.headline).toBe('LABOUR IN PROGRESS · SINCE 14:32 UK TIME');
		expect(sub.detail).toBe('Checked 3 times. It is finally happening.');
	});

	it('dates the moment Zack became a dad, when known', () => {
		expect(ogSubline({ state: state({ status: 'yes', statusChangedAt: '2026-11-20T03:10:00Z' }), checks: 0, today }).headline).toBe(
			'DAD SINCE FRI 20 NOV 2026',
		);
		expect(ogSubline({ state: state({ status: 'yes', statusChangedAt: '' }), checks: 0, today }).headline).toBe('DAD STATUS: CONFIRMED');
	});
});

describe('renderOgCardHtml', () => {
	for (const status of ['no', 'soon', 'yes'] as const) {
		it(`renders a self-contained card for ${status}`, () => {
			const html = renderOgCardHtml({ state: state({ status }), checks: 10, today });
			expect(html.startsWith('<!doctype html>')).toBe(true);
			expect(html).toContain('width:1200px;height:630px');
			expect(html).toContain('data:font/woff2;base64,');
			// No network: nothing but data: URIs and the SVG namespace.
			expect(html).not.toMatch(/(src|href)=["']?https?:/i);
			expect(html).not.toMatch(/url\(\s*["']?https?:/i);
			expect(html).not.toContain('<script');
		});
	}

	it('stacks NOT YET on two lines', () => {
		expect(renderOgCardHtml({ state: state({ status: 'soon' }), checks: 0, today })).toContain('NOT<br>YET');
	});
});
