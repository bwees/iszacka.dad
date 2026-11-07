import { describe, expect, it } from 'vitest';
import {
	BEYOND_MODEL_HAZARD,
	CLEAR_SKIES,
	FORECAST_DAYS,
	INDUCTION_OFFSET_DAYS,
	NO_DUE_DATE,
	birthProbabilityOnDay,
	dadForecast,
	forecastLabel,
	survivalFromDay,
} from '../src/lib/forecast';
import { addDays } from '../src/lib/time';

const DUE = '2026-12-01';
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('birth timing model', () => {
	it('is a proper distribution (sums to 1, nothing after induction)', () => {
		let total = 0;
		for (let k = -300; k <= 40; k++) total += birthProbabilityOnDay(k);
		expect(total).toBeCloseTo(1, 6);
		expect(birthProbabilityOnDay(INDUCTION_OFFSET_DAYS + 1)).toBe(0);
		expect(survivalFromDay(INDUCTION_OFFSET_DAYS + 1)).toBe(0);
	});

	it('peaks a day after the due date', () => {
		const around = [-1, 0, 1, 2, 3].map(birthProbabilityOnDay);
		expect(Math.max(...around)).toBe(birthProbabilityOnDay(1));
		expect(birthProbabilityOnDay(0)).toBeCloseTo(birthProbabilityOnDay(2), 10);
		// sd 9 days: the peak day holds roughly 1/(9·√(2π)) ≈ 4.4%.
		expect(birthProbabilityOnDay(1)).toBeCloseTo(0.0443, 3);
	});

	it('lumps the tail onto the induction day', () => {
		expect(birthProbabilityOnDay(INDUCTION_OFFSET_DAYS)).toBeCloseTo(survivalFromDay(INDUCTION_OFFSET_DAYS), 12);
		expect(birthProbabilityOnDay(INDUCTION_OFFSET_DAYS)).toBeGreaterThan(birthProbabilityOnDay(INDUCTION_OFFSET_DAYS - 1));
	});
});

describe('dadForecast', () => {
	it('returns seven consecutive days starting today', () => {
		const forecast = dadForecast(DUE, '2026-11-20', 'no');
		expect(forecast).toHaveLength(FORECAST_DAYS);
		expect(forecast.map((d) => d.date)).toEqual(Array.from({ length: 7 }, (_, i) => addDays('2026-11-20', i)));
		for (const day of forecast) {
			expect(day.label).toBeTruthy();
			expect(day.emoji).toBeTruthy();
		}
	});

	it('keeps probabilities in [0, 1] and their sum at most 1, from months early to well overdue', () => {
		for (let offset = -200; offset <= 30; offset++) {
			const today = addDays(DUE, offset);
			const forecast = dadForecast(DUE, today, 'no');
			const ps = forecast.map((d) => d.probability);
			for (const p of ps) {
				expect(p).toBeGreaterThanOrEqual(0);
				expect(p).toBeLessThanOrEqual(1);
			}
			expect(sum(ps)).toBeLessThanOrEqual(1 + 1e-9);
		}
	});

	it('is sunny months before the due date', () => {
		const forecast = dadForecast(DUE, addDays(DUE, -120), 'no');
		expect(forecast.every((d) => d.label === 'Sunny, no dads')).toBe(true);
		expect(sum(forecast.map((d) => d.probability))).toBeLessThan(0.001);
	});

	it('gives sensible odds on the due date', () => {
		const [today, tomorrow] = dadForecast(DUE, DUE, 'no');
		// P(due date | not yet born) ≈ 0.044 / 0.57.
		expect(today?.probability).toBeGreaterThan(0.06);
		expect(today?.probability).toBeLessThan(0.1);
		expect(tomorrow?.probability).toBeGreaterThan(today?.probability ?? 1);
	});

	it('gets more urgent the more overdue it is', () => {
		const p = (offset: number) => dadForecast(DUE, addDays(DUE, offset), 'no')[0]?.probability ?? 0;
		expect(p(5)).toBeGreaterThan(p(0));
		expect(p(10)).toBeGreaterThan(p(5));
		expect(p(13)).toBeGreaterThan(p(10));
	});

	it('puts everything left on the induction day', () => {
		const atInduction = dadForecast(DUE, addDays(DUE, INDUCTION_OFFSET_DAYS), 'no');
		expect(atInduction[0]?.probability).toBeCloseTo(1, 12);
		expect(atInduction.slice(1).every((d) => d.probability === 0)).toBe(true);

		const dayBefore = dadForecast(DUE, addDays(DUE, INDUCTION_OFFSET_DAYS - 1), 'no');
		expect(sum(dayBefore.map((d) => d.probability))).toBeCloseTo(1, 12);
		expect(dayBefore[1]?.probability).toBeGreaterThan(dayBefore[0]?.probability ?? 1);

		const weekBefore = dadForecast(DUE, addDays(DUE, INDUCTION_OFFSET_DAYS - 6), 'no');
		expect(sum(weekBefore.map((d) => d.probability))).toBeCloseTo(1, 12);
	});

	it('falls back to a constant hazard past 42 weeks', () => {
		const forecast = dadForecast(DUE, addDays(DUE, 20), 'no');
		expect(forecast[0]?.probability).toBeCloseTo(BEYOND_MODEL_HAZARD, 12);
		expect(forecast[1]?.probability).toBeCloseTo(BEYOND_MODEL_HAZARD * (1 - BEYOND_MODEL_HAZARD), 12);
		expect(sum(forecast.map((d) => d.probability))).toBeLessThanOrEqual(1);
	});

	it('says ~95% today once labour has started, due date or not', () => {
		for (const due of [DUE, null]) {
			const forecast = dadForecast(due, '2026-11-20', 'soon');
			expect(forecast[0]?.probability).toBeCloseTo(0.95, 6);
			expect(forecast[0]?.label).toMatch(/warning/i);
			expect(sum(forecast.map((d) => d.probability))).toBeLessThanOrEqual(1);
			expect(forecast[6]?.probability).toBe(0);
		}
	});

	it('is clear skies once Zack is a dad', () => {
		const forecast = dadForecast(DUE, DUE, 'yes');
		expect(forecast).toHaveLength(7);
		for (const day of forecast) {
			expect(day.probability).toBe(0);
			expect(day.label).toBe(CLEAR_SKIES.label);
		}
	});

	it('is foggy without a due date, and empty for a nonsense today', () => {
		const forecast = dadForecast(null, '2026-11-20', 'no');
		expect(forecast).toHaveLength(7);
		expect(forecast.every((d) => d.probability === 0 && d.label === NO_DUE_DATE.label)).toBe(true);
		expect(dadForecast(DUE, 'soon-ish', 'no')).toEqual([]);
	});
});

describe('forecastLabel', () => {
	it('escalates with probability', () => {
		expect(forecastLabel(0).label).toBe('Sunny, no dads');
		expect(forecastLabel(0.02).label).toBe('Light chance of contractions');
		expect(forecastLabel(0.05).label).toBe('Scattered nappies');
		expect(forecastLabel(0.25).label).toBe('Heavy dad warning');
		expect(forecastLabel(0.95).label).toMatch(/^Red warning/);
		expect(forecastLabel(1).label).toMatch(/^Red warning/);
		expect(forecastLabel(Number.NaN).label).toBe('Sunny, no dads');
	});
});
