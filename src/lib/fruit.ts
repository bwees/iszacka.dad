// OWNER: fun agent.
// "The baby is currently the size of a watermelon."
//
// Gestational age is counted the obstetric way: the due date is exactly 40 weeks
// + 0 days, so "today" is 280 - (days until the due date) days along. Fruit sizes
// follow the usual week-by-week produce aisle (they're approximate, and so is
// every pregnancy app that uses them). After 40 weeks the produce gives up and
// the jokes take over.

import { daysBetween, isYmd } from './time';

export interface BabySize {
	week: number;
	day: number;
	fruit: string;
	emoji: string;
	/** True once the baby is past 40+0. Optional so existing callers can ignore it. */
	overdue?: boolean;
	/** Whole days past the due date (0 when not overdue). */
	daysOverdue?: number;
}

/** A full-term pregnancy: 40 weeks, in days. The due date is day 280. */
export const TERM_DAYS = 280;

/** The first week the produce aisle has an opinion about. */
export const FIRST_FRUIT_WEEK = 4;

interface Produce {
	fruit: string;
	emoji: string;
}

/** Week → produce, weeks 4 to 40 inclusive. */
export const FRUIT_BY_WEEK: Readonly<Record<number, Produce>> = {
	4: { fruit: 'a poppy seed', emoji: '🌱' },
	5: { fruit: 'a sesame seed', emoji: '🌾' },
	6: { fruit: 'a sweet pea', emoji: '🫛' },
	7: { fruit: 'a blueberry', emoji: '🫐' },
	8: { fruit: 'a kidney bean', emoji: '🫘' },
	9: { fruit: 'a cherry', emoji: '🍒' },
	10: { fruit: 'a strawberry', emoji: '🍓' },
	11: { fruit: 'a Brussels sprout', emoji: '🥬' },
	12: { fruit: 'a lime', emoji: '🍋‍🟩' },
	13: { fruit: 'a lemon', emoji: '🍋' },
	14: { fruit: 'a nectarine', emoji: '🍑' },
	15: { fruit: 'an apple', emoji: '🍎' },
	16: { fruit: 'an avocado', emoji: '🥑' },
	17: { fruit: 'an onion', emoji: '🧅' },
	18: { fruit: 'a sweet potato', emoji: '🍠' },
	19: { fruit: 'a mango', emoji: '🥭' },
	20: { fruit: 'a banana', emoji: '🍌' },
	21: { fruit: 'a carrot', emoji: '🥕' },
	22: { fruit: 'a spaghetti squash', emoji: '🍝' },
	23: { fruit: 'a grapefruit', emoji: '🍊' },
	24: { fruit: 'an ear of sweetcorn', emoji: '🌽' },
	25: { fruit: 'a swede', emoji: '🥔' },
	26: { fruit: 'a courgette', emoji: '🥒' },
	27: { fruit: 'a cauliflower', emoji: '🥦' },
	28: { fruit: 'an aubergine', emoji: '🍆' },
	29: { fruit: 'a butternut squash', emoji: '🎃' },
	30: { fruit: 'a cabbage', emoji: '🥬' },
	31: { fruit: 'a coconut', emoji: '🥥' },
	32: { fruit: 'a bunch of bananas', emoji: '🍌' },
	33: { fruit: 'a pineapple', emoji: '🍍' },
	34: { fruit: 'a cantaloupe melon', emoji: '🍈' },
	35: { fruit: 'a honeydew melon', emoji: '🍈' },
	36: { fruit: 'a romaine lettuce', emoji: '🥬' },
	37: { fruit: 'a bunch of Swiss chard', emoji: '🥬' },
	38: { fruit: 'a pumpkin', emoji: '🎃' },
	39: { fruit: 'a mini watermelon', emoji: '🍉' },
	40: { fruit: 'a watermelon', emoji: '🍉' },
};

/** Once overdue, the comparisons escalate. `from` is the first day overdue each applies. */
const OVERDUE_JOKES: ReadonlyArray<{ from: number } & Produce> = [
	{ from: 1, fruit: 'a fully grown baby, frankly', emoji: '👶' },
	{ from: 4, fruit: 'a watermelon that has overstayed its welcome', emoji: '🍉' },
	{ from: 7, fruit: 'a prize-winning marrow with no intention of leaving', emoji: '🥒' },
	{ from: 10, fruit: 'a fully packed weekend bag', emoji: '🧳' },
	{ from: 14, fruit: 'the entire fruit bowl, plus the bowl', emoji: '🧺' },
	{ from: 21, fruit: 'a baby who has almost certainly arrived (someone should update the website)', emoji: '🤔' },
];

/** Overdue comparison for a number of days past the due date (>= 1). */
export function overdueProduce(daysOverdue: number): Produce {
	let pick = OVERDUE_JOKES[0] as Produce;
	for (const joke of OVERDUE_JOKES) if (daysOverdue >= joke.from) pick = joke;
	return { fruit: pick.fruit, emoji: pick.emoji };
}

/**
 * Gestational age on `today` for a pregnancy due on `dueDate` (both 'YYYY-MM-DD').
 * Returns null without a valid due date, or before week 4 (nothing to compare
 * with yet, and frankly a bit early to be weighing produce).
 */
export function gestationalAge(dueDate: string | null, today: string): { week: number; day: number; totalDays: number } | null {
	if (!isYmd(dueDate) || !isYmd(today)) return null;
	const totalDays = TERM_DAYS - daysBetween(today, dueDate);
	if (totalDays < FIRST_FRUIT_WEEK * 7) return null;
	return { week: Math.floor(totalDays / 7), day: totalDays % 7, totalDays };
}

export function babySize(dueDate: string | null, today: string): BabySize | null {
	const age = gestationalAge(dueDate, today);
	if (!age) return null;
	const daysOverdue = Math.max(0, age.totalDays - TERM_DAYS);
	const produce = daysOverdue > 0 ? overdueProduce(daysOverdue) : (FRUIT_BY_WEEK[age.week] as Produce);
	return {
		week: age.week,
		day: age.day,
		fruit: produce.fruit,
		emoji: produce.emoji,
		overdue: daysOverdue > 0,
		daysOverdue,
	};
}

/** "38+4" style notation (weeks+days), as written on every maternity note ever. */
export function formatGestation(size: Pick<BabySize, 'week' | 'day'>): string {
	return `${size.week}+${size.day}`;
}
