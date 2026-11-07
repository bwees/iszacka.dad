// OWNER: community agent.
// Dad readiness checklist, congratulations wall, baby name suggestion box.
//
// Three small features with one thing in common: the public can look, a few can
// write, and nothing appears until the management has had a look. Everything in
// this file is either a pure helper (validation, maths, copy) or a thin D1 query.
// Pure helpers are unit-tested in test/community-*.test.ts.

import type { Status } from '../types';
import { formatNumber, nowIso } from './time';

// ─────────────────────────────────────────────────────────────────────────────
// Shared text helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Zero-width and bidi-control characters: invisible, and only useful for mischief. */
const INVISIBLE = /[\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** C0/C1 control characters (tab and newlines included). */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
/** C0/C1 control characters except the newline. */
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
/** More than three combining marks in a row is Zalgo, not a name. */
const ZALGO = /(\p{M}{3})\p{M}+/gu;

function baseClean(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	return raw.toWellFormed().normalize('NFC').replace(INVISIBLE, '').replace(ZALGO, '$1');
}

/** Clean single-line user input: NFC, no control or invisible characters, single spaces, trimmed. */
export function cleanLine(raw: unknown): string {
	return baseClean(raw).replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * Clean multi-line user input: as cleanLine, but keeps line breaks (normalised to
 * \n, trailing spaces trimmed, at most one blank line in a row).
 */
export function cleanMultiline(raw: unknown): string {
	return baseClean(raw)
		.replace(/\r\n?|[\u2028\u2029]/g, '\n')
		.replace(CONTROL_EXCEPT_NEWLINE, ' ')
		.split('\n')
		.map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Length in Unicode code points (what a person would call characters, emoji aside). */
export function charLength(value: string): number {
	let n = 0;
	for (const _ of value) n++;
	return n;
}

/** Parse a positive integer row id from a URL segment or form field. */
export function parseId(raw: unknown): number | null {
	if (typeof raw !== 'string' || !/^[1-9]\d{0,14}$/.test(raw)) return null;
	const id = Number(raw);
	return Number.isSafeInteger(id) ? id : null;
}

/** "1 message", "2 messages", "1,204 messages". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${formatNumber(count)} ${count === 1 ? singular : pluralForm}`;
}

export type FieldErrors<F extends string> = Partial<Record<F, string>>;

/** Validation result. `input` always holds the cleaned values, for re-filling a form. */
export type Validation<T, F extends string> =
	| { ok: true; value: T; input: Record<F, string> }
	| { ok: false; errors: FieldErrors<F>; input: Record<F, string> };

/** True if the text contains something that looks like a link (flagged for moderators). */
export function looksLikeLink(text: string): boolean {
	return /\b(?:https?:\/\/|www\.)|\b[a-z0-9-]+\.(?:com|net|org|io|ru|xyz|top|info|biz|co|uk|ly)\b/i.test(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dad readiness checklist
// ─────────────────────────────────────────────────────────────────────────────

export interface Readiness {
	done: number;
	total: number;
	/** 0-100, rounded. */
	percent: number;
	items: Array<{ label: string; done: boolean }>;
}

export interface ChecklistItem {
	id: number;
	label: string;
	done: boolean;
	sort: number;
	createdAt: string;
	doneAt: string | null;
}

export const CHECKLIST_LABEL_MAX = 120;

/** Universal, non-personal, and all broadly true of every expectant parent everywhere. */
export const SUGGESTED_CHECKLIST: readonly string[] = [
	'Car seat installed (and the manual read, twice)',
	'Can fold the pram in under 20 minutes',
	'Nappy changes practised on a doll',
	'Has downloaded 47 white-noise apps',
	'Hospital bag packed (and unpacked, and repacked)',
	'Cot assembled, with only a few screws left over',
	'Swaddling mastered on a teddy bear, who did not complain',
	'Freezer stocked with enough lasagne to survive a siege',
	'Stockpiled 300 dad jokes, tested on 0 live audiences',
	'Knows the difference between a babygrow and a sleepsuit (there may not be one)',
	'Car boot cleared of approximately one tonne of miscellaneous stuff',
	'Has accepted that sleep cannot be banked in advance',
];

/**
 * Readiness percentage. Rounded, but honest at the edges: it only says 100 when
 * everything is done, and only says 0 when nothing is.
 */
export function readinessPercent(done: number, total: number): number {
	if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done <= 0) return 0;
	if (done >= total) return 100;
	return Math.min(99, Math.max(1, Math.round((done / total) * 100)));
}

export function summariseReadiness(items: ReadonlyArray<{ label: string; done: boolean }>): Readiness {
	const done = items.filter((item) => item.done).length;
	return {
		done,
		total: items.length,
		percent: readinessPercent(done, items.length),
		items: items.map((item) => ({ label: item.label, done: item.done })),
	};
}

export interface Dadcon {
	/** 5 (least ready) to 1 (maximum readiness). */
	level: 1 | 2 | 3 | 4 | 5;
	label: string;
}

/** The Dad Readiness Condition, modelled loosely on DEFCON and not at all on anything real. */
export function dadcon(percent: number): Dadcon {
	if (percent >= 100) return { level: 1, label: 'maximum readiness (theoretical)' };
	if (percent >= 80) return { level: 2, label: 'hospital bag by the door' };
	if (percent >= 50) return { level: 3, label: 'pram folded at least once' };
	if (percent >= 20) return { level: 4, label: 'nesting detected' };
	return { level: 5, label: 'blissful ignorance' };
}

/** Dry commentary that changes with the percentage (and, at the end, with the status). */
export function readinessCommentary(readiness: Pick<Readiness, 'percent' | 'total'>, status: Status): string {
	if (readiness.total === 0) {
		return 'No checklist yet. Either Zack is perfectly ready, or nobody has written anything down. History suggests the latter.';
	}
	const p = readiness.percent;
	let base: string;
	if (p === 0) base = 'Readiness: none. Zack has, however, read several articles about babies and nodded at them.';
	else if (p < 20) base = 'Early days. The pram remains a mystery wrapped in an enigma wrapped in a rain cover.';
	else if (p < 40) base = 'Progress has been made, in the sense that things have happened and some of them were on the list.';
	else if (p < 60) base = 'Roughly half ready. Statistically indistinguishable from a coin toss, which reassures nobody.';
	else if (p < 80) base = 'More ready than not. Cautious optimism has been authorised, pending review.';
	else if (p < 95) base = 'Alarmingly competent. Smugness levels are being monitored.';
	else if (p < 100) base = 'So close. The last few per cent are traditionally the hardest, and usually involve the car seat.';
	else base = 'Fully ready. This is an illusion, as nobody is ever ready, but the checklist is unambiguous.';

	if (status === 'soon') return `${base} Labour has started, so this is now less a checklist and more a historical document.`;
	if (status === 'yes') return `${base} Zack is now a dad, so readiness is purely academic. The baby did not check.`;
	return base;
}

export function validateChecklistLabel(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
	const value = cleanLine(raw);
	if (!value) return { ok: false, error: 'An item needs a label. Even "be ready" counts.' };
	if (charLength(value) > CHECKLIST_LABEL_MAX) {
		return { ok: false, error: `Labels are limited to ${CHECKLIST_LABEL_MAX} characters. Brevity is a parenting skill.` };
	}
	return { ok: true, value };
}

/** Swap an id with its neighbour. Returns the new order, or null if it can't move. */
export function reorderIds(ids: readonly number[], id: number, direction: 'up' | 'down'): number[] | null {
	const from = ids.indexOf(id);
	if (from === -1) return null;
	const to = direction === 'up' ? from - 1 : from + 1;
	if (to < 0 || to >= ids.length) return null;
	const next = [...ids];
	[next[from], next[to]] = [next[to] as number, next[from] as number];
	return next;
}

/** Suggested items not already on the list (case- and whitespace-insensitive). */
export function missingSuggestions(existingLabels: readonly string[], suggestions: readonly string[] = SUGGESTED_CHECKLIST): string[] {
	// toLowerCase, not toLocaleLowerCase('en-GB'): the same for English, and no ICU start-up cost.
	const key = (s: string) => cleanLine(s).toLowerCase();
	const have = new Set(existingLabels.map(key));
	const out: string[] = [];
	for (const label of suggestions) {
		const k = key(label);
		if (have.has(k)) continue;
		have.add(k);
		out.push(label);
	}
	return out;
}

interface ChecklistRow {
	id: number;
	label: string;
	done: number;
	sort: number;
	created_at: string;
	done_at: string | null;
}

export async function listChecklist(env: Env): Promise<ChecklistItem[]> {
	const { results } = await env.DB.prepare(
		'SELECT id, label, done, sort, created_at, done_at FROM checklist ORDER BY sort ASC, id ASC',
	).all<ChecklistRow>();
	return results.map((r) => ({
		id: r.id,
		label: r.label,
		done: r.done === 1,
		sort: r.sort,
		createdAt: r.created_at,
		doneAt: r.done_at,
	}));
}

/** Readiness for any module that wants it. Never throws: an unreadable checklist is an empty one. */
export async function getReadiness(env: Env): Promise<Readiness> {
	try {
		return summariseReadiness(await listChecklist(env));
	} catch (err) {
		console.error('getReadiness failed:', err);
		return { done: 0, total: 0, percent: 0, items: [] };
	}
}

export type ReadinessSummary = Pick<Readiness, 'done' | 'total' | 'percent'>;

/**
 * Just the numbers, for the home page's readiness panel: one aggregate row instead of every
 * checklist item. Never throws: an unreadable checklist is an empty one.
 */
export async function getReadinessSummary(env: Env): Promise<ReadinessSummary> {
	try {
		const row = await env.DB.prepare(
			'SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END), 0) AS done FROM checklist',
		).first<{ total: number; done: number }>();
		const total = Number(row?.total ?? 0);
		const done = Number(row?.done ?? 0);
		return { done, total, percent: readinessPercent(done, total) };
	} catch (err) {
		console.error('getReadinessSummary failed:', err);
		return { done: 0, total: 0, percent: 0 };
	}
}

/** Append an item to the end of the list. Returns its id. */
export async function addChecklistItem(env: Env, label: string): Promise<number> {
	const row = await env.DB.prepare(
		`INSERT INTO checklist (label, sort, created_at)
		 VALUES (?1, (SELECT COALESCE(MAX(sort), -1) + 1 FROM checklist), ?2)
		 RETURNING id`,
	)
		.bind(label, nowIso())
		.first<{ id: number }>();
	if (!row) throw new Error('checklist insert returned no row');
	return row.id;
}

/** Mark an item done (sets done_at) or not done (clears it). Omit `done` to flip it. */
export async function setChecklistDone(env: Env, id: number, done?: boolean): Promise<boolean> {
	// ?3 is the target (1 / 0), or NULL to flip. Re-marking a done item keeps its original done_at.
	const result = await env.DB.prepare(
		`UPDATE checklist
		 SET done = COALESCE(?3, 1 - done),
		     done_at = CASE
		       WHEN COALESCE(?3, 1 - done) = 1 THEN COALESCE(CASE WHEN done = 1 THEN done_at END, ?2)
		       ELSE NULL
		     END
		 WHERE id = ?1`,
	)
		.bind(id, nowIso(), done === undefined ? null : done ? 1 : 0)
		.run();
	return result.meta.changes > 0;
}

export async function deleteChecklistItem(env: Env, id: number): Promise<boolean> {
	const result = await env.DB.prepare('DELETE FROM checklist WHERE id = ?').bind(id).run();
	return result.meta.changes > 0;
}

/** Move an item one place up or down. Renumbers the whole list so sort values stay dense. */
export async function moveChecklistItem(env: Env, id: number, direction: 'up' | 'down'): Promise<boolean> {
	const items = await listChecklist(env);
	const order = reorderIds(
		items.map((item) => item.id),
		id,
		direction,
	);
	if (!order) return false;
	const current = new Map(items.map((item) => [item.id, item.sort]));
	const statements = order
		.map((itemId, index) => ({ itemId, index }))
		.filter(({ itemId, index }) => current.get(itemId) !== index)
		.map(({ itemId, index }) => env.DB.prepare('UPDATE checklist SET sort = ? WHERE id = ?').bind(index, itemId));
	if (statements.length) await env.DB.batch(statements);
	return true;
}

/** Add any suggested items that aren't already on the list. Returns how many were added. */
export async function seedChecklist(env: Env): Promise<number> {
	const items = await listChecklist(env);
	const missing = missingSuggestions(items.map((item) => item.label));
	if (!missing.length) return 0;
	const start = items.reduce((max, item) => Math.max(max, item.sort), -1) + 1;
	const at = nowIso();
	await env.DB.batch(
		missing.map((label, i) =>
			env.DB.prepare('INSERT INTO checklist (label, sort, created_at) VALUES (?, ?, ?)').bind(label, start + i, at),
		),
	);
	return missing.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Moderation (shared by the wall and the name box)
// ─────────────────────────────────────────────────────────────────────────────

export type ModerationAction = 'approve' | 'reject' | 'remove';

export function isModerationAction(value: unknown): value is ModerationAction {
	return value === 'approve' || value === 'reject' || value === 'remove';
}

/** approve/reject act on pending rows; remove acts on approved ones. */
function moderationSql(table: 'wall' | 'name_suggestions', action: ModerationAction): string {
	switch (action) {
		case 'approve':
			return `UPDATE ${table} SET approved_at = ?2 WHERE id = ?1 AND approved_at IS NULL AND rejected_at IS NULL`;
		case 'reject':
			return `UPDATE ${table} SET rejected_at = ?2 WHERE id = ?1 AND approved_at IS NULL AND rejected_at IS NULL`;
		case 'remove':
			return `UPDATE ${table} SET rejected_at = ?2 WHERE id = ?1 AND approved_at IS NOT NULL AND rejected_at IS NULL`;
	}
}

export interface ModerationCounts {
	pending: number;
	approved: number;
	rejected: number;
	total: number;
}

async function moderationCounts(env: Env, table: 'wall' | 'name_suggestions'): Promise<ModerationCounts> {
	const row = await env.DB.prepare(
		`SELECT
		   COUNT(*) AS total,
		   COALESCE(SUM(CASE WHEN rejected_at IS NULL AND approved_at IS NULL THEN 1 ELSE 0 END), 0) AS pending,
		   COALESCE(SUM(CASE WHEN rejected_at IS NULL AND approved_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS approved,
		   COALESCE(SUM(CASE WHEN rejected_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS rejected
		 FROM ${table}`,
	).first<ModerationCounts>();
	return row ?? { pending: 0, approved: 0, rejected: 0, total: 0 };
}

/** Pending items in each moderation queue (for the admin dashboard). */
export async function communityPendingCounts(env: Env): Promise<{ wall: number; names: number }> {
	const [wall, names] = await Promise.all([moderationCounts(env, 'wall'), moderationCounts(env, 'name_suggestions')]);
	return { wall: wall.pending, names: names.pending };
}

/** Per-visitor cap on unmoderated submissions, so one person can't bury the queue. */
export const PENDING_PER_VISITOR = { wall: 5, names: 10 } as const;
/** Global cap on the queue, in case many people try at once. */
export const PENDING_TOTAL_MAX = 500;

async function queueIsFull(env: Env, table: 'wall' | 'name_suggestions', ipHash: string, perVisitor: number): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT
		   COUNT(*) AS total,
		   COALESCE(SUM(CASE WHEN ip_hash = ?1 THEN 1 ELSE 0 END), 0) AS mine
		 FROM ${table}
		 WHERE approved_at IS NULL AND rejected_at IS NULL`,
	)
		.bind(ipHash)
		.first<{ total: number; mine: number }>();
	return (row?.mine ?? 0) >= perVisitor || (row?.total ?? 0) >= PENDING_TOTAL_MAX;
}

// ─────────────────────────────────────────────────────────────────────────────
// Congratulations wall
// ─────────────────────────────────────────────────────────────────────────────

export const WALL_NAME_MAX = 60;
export const WALL_MESSAGE_MAX = 500;
export const WALL_PAGE_SIZE = 50;

export interface WallEntryInput {
	name: string;
	message: string;
}

export interface WallMessage {
	id: number;
	name: string;
	message: string;
	createdAt: string;
	approvedAt: string | null;
}

export function validateWallEntry(input: { name?: unknown; message?: unknown }): Validation<WallEntryInput, 'name' | 'message'> {
	const name = cleanLine(input.name);
	const message = cleanMultiline(input.message);
	const errors: FieldErrors<'name' | 'message'> = {};
	if (!name) errors.name = 'Please tell us who you are. "A well-wisher" is fine, if a little mysterious.';
	else if (charLength(name) > WALL_NAME_MAX) errors.name = `Names are limited to ${WALL_NAME_MAX} characters. Nicknames welcome.`;
	if (!message) errors.message = 'The message is empty. Heartfelt, but hard to display.';
	else if (charLength(message) > WALL_MESSAGE_MAX) {
		errors.message = `Messages are limited to ${WALL_MESSAGE_MAX} characters (yours has ${charLength(message)}). Save the rest for the card.`;
	}
	const cleaned = { name, message };
	return Object.keys(errors).length ? { ok: false, errors, input: cleaned } : { ok: true, value: cleaned, input: cleaned };
}

export type SubmitOutcome = 'queued' | 'duplicate' | 'queue-full';

/** Queue a wall message for approval. A repeat of a pending message from the same visitor is a no-op. */
export async function submitWallMessage(env: Env, entry: WallEntryInput, ipHash: string): Promise<SubmitOutcome> {
	const duplicate = await env.DB.prepare(
		`SELECT id FROM wall
		 WHERE ip_hash = ?1 AND name = ?2 AND message = ?3 AND rejected_at IS NULL
		 LIMIT 1`,
	)
		.bind(ipHash, entry.name, entry.message)
		.first<{ id: number }>();
	if (duplicate) return 'duplicate';
	if (await queueIsFull(env, 'wall', ipHash, PENDING_PER_VISITOR.wall)) return 'queue-full';
	await env.DB.prepare('INSERT INTO wall (name, message, ip_hash, created_at) VALUES (?, ?, ?, ?)')
		.bind(entry.name, entry.message, ipHash, nowIso())
		.run();
	return 'queued';
}

interface WallRow {
	id: number;
	name: string;
	message: string;
	created_at: string;
	approved_at: string | null;
}

const toWallMessage = (r: WallRow): WallMessage => ({
	id: r.id,
	name: r.name,
	message: r.message,
	createdAt: r.created_at,
	approvedAt: r.approved_at,
});

/** Approved messages, newest first. `beforeId` pages backwards. */
export async function listApprovedWall(
	env: Env,
	opts: { limit?: number; beforeId?: number | null } = {},
): Promise<{ messages: WallMessage[]; nextBefore: number | null }> {
	const limit = Math.min(Math.max(opts.limit ?? WALL_PAGE_SIZE, 1), 200);
	const { results } = await env.DB.prepare(
		`SELECT id, name, message, created_at, approved_at FROM wall
		 WHERE approved_at IS NOT NULL AND rejected_at IS NULL AND (?1 IS NULL OR id < ?1)
		 ORDER BY id DESC
		 LIMIT ?2`,
	)
		.bind(opts.beforeId ?? null, limit + 1)
		.all<WallRow>();
	const page = results.slice(0, limit).map(toWallMessage);
	const last = page.at(-1);
	return { messages: page, nextBefore: results.length > limit && last ? last.id : null };
}

/** Pending messages, oldest first (first come, first moderated). */
export async function listPendingWall(env: Env, limit = 200): Promise<WallMessage[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, name, message, created_at, approved_at FROM wall
		 WHERE approved_at IS NULL AND rejected_at IS NULL
		 ORDER BY id ASC
		 LIMIT ?`,
	)
		.bind(limit)
		.all<WallRow>();
	return results.map(toWallMessage);
}

export function wallCounts(env: Env): Promise<ModerationCounts> {
	return moderationCounts(env, 'wall');
}

export async function moderateWall(env: Env, id: number, action: ModerationAction): Promise<boolean> {
	const result = await env.DB.prepare(moderationSql('wall', action)).bind(id, nowIso()).run();
	return result.meta.changes > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Baby name suggestion box
// ─────────────────────────────────────────────────────────────────────────────

export const NAME_MAX = 40;
export const SUGGESTED_BY_MAX = 40;
export const NAMES_LIST_LIMIT = 100;

/** Words of letters (with accents), joined by single spaces, hyphens or apostrophes. */
const NAME_PATTERN = /^\p{L}[\p{L}\p{M}]*(?:[ '-]\p{L}[\p{L}\p{M}]*)*$/u;

/** The same rule for the browser's `pattern` attribute (which uses the `v` flag). */
export const NAME_HTML_PATTERN = "[\\p{L}\\p{M} '\u2018\u2019\\-\u2010\u2011\u2013]+";

/** Tidy a suggested name: cleanLine, typographic apostrophes and hyphens made plain, no spaces around hyphens. */
export function normaliseSuggestedName(raw: unknown): string {
	return cleanLine(raw)
		.replace(/[\u2018\u2019\u201B`\u00B4\u2032]/g, "'")
		.replace(/[\u2010\u2011\u2012\u2013\u2212]/g, '-')
		.replace(/ ?- ?/g, '-')
		.replace(/ ?' ?/g, "'");
}

/** Comparison key for spotting the same name twice: case-insensitive (Unicode-aware), accent-sensitive. */
export function nameKey(name: string): string {
	return normaliseSuggestedName(name).toLowerCase();
}

export function isValidSuggestedName(name: string): boolean {
	return charLength(name) <= NAME_MAX && NAME_PATTERN.test(name);
}

export interface NameSuggestionInput {
	name: string;
	suggestedBy: string | null;
}

/** Same tests the pool uses for names: whatever is shown publicly mustn't be a link or an address. */
const LINK_LIKE = /https?:|www\.|\.(?:com|net|org|io|xyz|ru)\b/i;
const EMAIL_LIKE = /\S+@\S+\.\S+/;

export function validateNameSuggestion(input: {
	name?: unknown;
	suggestedBy?: unknown;
}): Validation<NameSuggestionInput, 'name' | 'suggestedBy'> {
	const name = normaliseSuggestedName(input.name);
	const suggestedBy = cleanLine(input.suggestedBy);
	const errors: FieldErrors<'name' | 'suggestedBy'> = {};
	if (!name) errors.name = 'Please suggest a name. Silence has been noted, but cannot be counted.';
	else if (charLength(name) > NAME_MAX) errors.name = `Names are limited to ${NAME_MAX} characters. The form at the registry office has a small box.`;
	else if (!NAME_PATTERN.test(name)) {
		errors.name = 'Letters, spaces, hyphens and apostrophes only. Digits are for passwords, not babies.';
	}
	if (charLength(suggestedBy) > SUGGESTED_BY_MAX) errors.suggestedBy = `Your name is limited to ${SUGGESTED_BY_MAX} characters here.`;
	else if (suggestedBy && EMAIL_LIKE.test(suggestedBy)) {
		errors.suggestedBy = 'That looks like an email address. This is shown publicly, so a first name or nickname will do.';
	} else if (suggestedBy && LINK_LIKE.test(suggestedBy)) errors.suggestedBy = 'Names, not links.';
	const cleaned = { name, suggestedBy };
	return Object.keys(errors).length
		? { ok: false, errors, input: cleaned }
		: { ok: true, value: { name, suggestedBy: suggestedBy || null }, input: cleaned };
}

/** Standard competition ranking ("1224"): ties share a rank. Input must be sorted descending. */
export function competitionRanks(votes: readonly number[]): number[] {
	const ranks: number[] = [];
	votes.forEach((v, i) => {
		ranks.push(i > 0 && v === votes[i - 1] ? (ranks[i - 1] as number) : i + 1);
	});
	return ranks;
}

export interface NameSuggestion {
	id: number;
	name: string;
	suggestedBy: string | null;
	votes: number;
	createdAt: string;
	approvedAt: string | null;
}

interface NameRow {
	id: number;
	name: string;
	suggested_by: string | null;
	votes: number;
	created_at: string;
	approved_at: string | null;
}

const toNameSuggestion = (r: NameRow): NameSuggestion => ({
	id: r.id,
	name: r.name,
	suggestedBy: r.suggested_by,
	votes: r.votes,
	createdAt: r.created_at,
	approvedAt: r.approved_at,
});

export type VoteOutcome =
	| { kind: 'counted'; votes: number; name: string }
	| { kind: 'already'; votes: number; name: string }
	| { kind: 'not-found' };

/**
 * One vote per voter per approved suggestion. The vote row and the cached
 * `votes` count are written in one batch (a transaction), and the count is
 * recomputed from name_votes, so the two can't drift.
 */
export async function voteForName(env: Env, id: number, voterHash: string): Promise<VoteOutcome> {
	const [insert, , select] = await env.DB.batch([
		env.DB.prepare(
			`INSERT OR IGNORE INTO name_votes (suggestion_id, voter_hash, created_at)
			 SELECT id, ?2, ?3 FROM name_suggestions
			 WHERE id = ?1 AND approved_at IS NOT NULL AND rejected_at IS NULL`,
		).bind(id, voterHash, nowIso()),
		env.DB.prepare(
			'UPDATE name_suggestions SET votes = (SELECT COUNT(*) FROM name_votes WHERE suggestion_id = ?1) WHERE id = ?1',
		).bind(id),
		env.DB.prepare(
			`SELECT name, votes FROM name_suggestions
			 WHERE id = ?1 AND approved_at IS NOT NULL AND rejected_at IS NULL`,
		).bind(id),
	]);
	const row = (select?.results as Array<{ name: string; votes: number }> | undefined)?.[0];
	if (!row) return { kind: 'not-found' };
	return { kind: (insert?.meta.changes ?? 0) > 0 ? 'counted' : 'already', votes: row.votes, name: row.name };
}

export type NameSubmitOutcome =
	| { kind: 'queued' }
	| { kind: 'duplicate-pending' }
	| { kind: 'duplicate-approved'; id: number; name: string; vote: VoteOutcome }
	| { kind: 'queue-full' };

/**
 * Queue a suggestion. Names already on the leaderboard become a vote instead,
 * names already in the queue are not queued twice, and names the moderators
 * have already rejected are received (and counted) but filed straight under
 * "rejected", so nobody has to reject them again.
 */
export async function submitNameSuggestion(env: Env, input: NameSuggestionInput, ipHash: string): Promise<NameSubmitOutcome> {
	// SQLite's NOCASE only folds ASCII (so "zoë" ≠ "ZOË"): narrow by length in SQL,
	// then compare Unicode-aware keys here. Best state first, so approved wins.
	const { results: candidates } = await env.DB.prepare(
		`SELECT id, name,
		   CASE WHEN rejected_at IS NOT NULL THEN 2 WHEN approved_at IS NOT NULL THEN 0 ELSE 1 END AS state
		 FROM name_suggestions
		 WHERE length(name) = length(?1)
		 ORDER BY state ASC, id ASC
		 LIMIT 5000`,
	)
		.bind(input.name)
		.all<{ id: number; name: string; state: 0 | 1 | 2 }>();
	const key = nameKey(input.name);
	const existing = candidates.find((row) => nameKey(row.name) === key);
	if (existing?.state === 0) {
		return { kind: 'duplicate-approved', id: existing.id, name: existing.name, vote: await voteForName(env, existing.id, ipHash) };
	}
	if (existing?.state === 1) return { kind: 'duplicate-pending' };
	if (await queueIsFull(env, 'name_suggestions', ipHash, PENDING_PER_VISITOR.names)) return { kind: 'queue-full' };
	const at = nowIso();
	await env.DB.prepare(
		'INSERT INTO name_suggestions (name, suggested_by, ip_hash, created_at, rejected_at) VALUES (?, ?, ?, ?, ?)',
	)
		.bind(input.name, input.suggestedBy, ipHash, at, existing ? at : null)
		.run();
	return { kind: 'queued' };
}

/** Approved suggestions by votes (most first), then the earliest suggested. */
export async function listApprovedNames(env: Env, limit = NAMES_LIST_LIMIT): Promise<NameSuggestion[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, name, suggested_by, votes, created_at, approved_at FROM name_suggestions
		 WHERE approved_at IS NOT NULL AND rejected_at IS NULL
		 ORDER BY votes DESC, created_at ASC, id ASC
		 LIMIT ?`,
	)
		.bind(limit)
		.all<NameRow>();
	return results.map(toNameSuggestion);
}

/** Pending suggestions, oldest first. */
export async function listPendingNames(env: Env, limit = 200): Promise<NameSuggestion[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, name, suggested_by, votes, created_at, approved_at FROM name_suggestions
		 WHERE approved_at IS NULL AND rejected_at IS NULL
		 ORDER BY id ASC
		 LIMIT ?`,
	)
		.bind(limit)
		.all<NameRow>();
	return results.map(toNameSuggestion);
}

export function nameCounts(env: Env): Promise<ModerationCounts> {
	return moderationCounts(env, 'name_suggestions');
}

/** Ids of the suggestions this voter has already voted for. */
export async function votedSuggestionIds(env: Env, voterHash: string): Promise<Set<number>> {
	const { results } = await env.DB.prepare('SELECT suggestion_id FROM name_votes WHERE voter_hash = ?')
		.bind(voterHash)
		.all<{ suggestion_id: number }>();
	return new Set(results.map((r) => r.suggestion_id));
}

export async function moderateName(env: Env, id: number, action: ModerationAction): Promise<boolean> {
	const result = await env.DB.prepare(moderationSql('name_suggestions', action)).bind(id, nowIso()).run();
	return result.meta.changes > 0;
}
