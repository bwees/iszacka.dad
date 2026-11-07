// OWNER: social agent.
// DADCON: the paternity readiness condition on the home page, modelled on DEFCON and on
// nothing else whatsoever. Pure: the level depends only on the status, the due date and the
// London date, so it costs nothing to work out per request. public/social.js mirrors
// dadconLevel() so the panel moves when the answer changes live.
//
// (Not to be confused with /ready's checklist-based condition in lib/community.ts, which
// measures how ready the household is rather than how close the moment is.)

import type { SiteState } from '../types';
import { daysBetween, isYmd } from './time';

export type DadconLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface DadconInfo {
	level: DadconLevel;
	/** Exercise term, DEFCON-style. */
	name: string;
	/** One dry sentence about what the level means. */
	description: string;
}

/** Every level, from the calmest down to the one that matters. Order is display order. */
export const DADCON_LEVELS: readonly DadconInfo[] = [
	{ level: 5, name: 'FADE OUT', description: 'Lowest state of readiness. The due date is over four weeks away, or classified. Normal sleep permitted.' },
	{ level: 4, name: 'DOUBLE TAKE', description: 'Due within four weeks. Hospital bag located, if not yet packed. Intelligence watch increased.' },
	{ level: 3, name: 'ROUND HOUSE', description: 'Due within a week. Phones stay on loud. The car keeps at least half a tank.' },
	{ level: 2, name: 'FAST PACE', description: 'Overdue. The due date has passed without incident. The baby is clearly on Zack time.' },
	{ level: 1, name: "IT'S HAPPENING", description: 'Labour is under way. All personnel to stations. Please stop asking Zack.' },
	{ level: 0, name: 'DAD', description: 'Condition achieved. Maximum readiness, minimum sleep. Stand down, everyone else.' },
];

const BY_LEVEL = new Map(DADCON_LEVELS.map((info) => [info.level, info]));

/** Days to the due date (negative once it has passed) at which each level starts. */
export const DADCON_WEEKS_OUT = 28;
export const DADCON_WEEK_OUT = 7;

/**
 * The level for a state on a London date ('YYYY-MM-DD'):
 * 5: due date over 28 days away, or unknown; 4: 8 to 28 days; 3: 7 days or fewer (due today
 * included); 2: overdue; 1: labour (`soon`); 0: `yes`.
 */
export function dadconLevel(state: Pick<SiteState, 'status' | 'dueDate'>, today: string): DadconLevel {
	if (state.status === 'yes') return 0;
	if (state.status === 'soon') return 1;
	if (!state.dueDate || !isYmd(state.dueDate) || !isYmd(today)) return 5;
	const days = daysBetween(today, state.dueDate);
	if (!Number.isFinite(days)) return 5;
	if (days < 0) return 2;
	if (days <= DADCON_WEEK_OUT) return 3;
	if (days <= DADCON_WEEKS_OUT) return 4;
	return 5;
}

/** The level plus its name and description. */
export function dadcon(state: Pick<SiteState, 'status' | 'dueDate'>, today: string): DadconInfo {
	return BY_LEVEL.get(dadconLevel(state, today)) ?? (DADCON_LEVELS[0] as DadconInfo);
}
