import { describe, expect, it } from 'vitest';
import {
	NAME_MAX,
	WALL_MESSAGE_MAX,
	WALL_NAME_MAX,
	charLength,
	cleanLine,
	cleanMultiline,
	competitionRanks,
	isModerationAction,
	isValidSuggestedName,
	looksLikeLink,
	nameKey,
	normaliseSuggestedName,
	parseId,
	plural,
	validateChecklistLabel,
	validateNameSuggestion,
	validateWallEntry,
} from '../src/lib/community';

describe('cleanLine', () => {
	it('trims and collapses whitespace, including newlines and tabs', () => {
		expect(cleanLine('  Aunt \t Jo \n\n Smith  ')).toBe('Aunt Jo Smith');
	});

	it('strips control, zero-width and bidi-override characters', () => {
		expect(cleanLine('A\u0000B\u0007C')).toBe('A B C');
		expect(cleanLine('Zer\u200Bo\uFEFF')).toBe('Zero');
		expect(cleanLine('\u202Egnirts')).toBe('gnirts');
	});

	it('normalises to NFC', () => {
		expect(cleanLine('Rene\u0301e')).toBe('Renée');
		expect(cleanLine('Rene\u0301e')).toHaveLength(5);
	});

	it('tames Zalgo text', () => {
		const zalgo = `Z${'\u0301'.repeat(40)}`;
		expect(charLength(cleanLine(zalgo))).toBe(4);
	});

	it('keeps emoji sequences intact', () => {
		expect(cleanLine('🎉 👨\u200D👩\u200D👧 ')).toBe('🎉 👨\u200D👩\u200D👧');
	});

	it('returns an empty string for non-strings', () => {
		expect(cleanLine(undefined)).toBe('');
		expect(cleanLine(42)).toBe('');
		expect(cleanLine(['a'])).toBe('');
	});

	it('repairs lone surrogates', () => {
		expect(cleanLine('a\uD800b')).toBe('a\uFFFDb');
	});
});

describe('cleanMultiline', () => {
	it('keeps paragraphs but no more than one blank line', () => {
		expect(cleanMultiline('Hello\r\n\r\n\r\n\r\nWorld  \r\n  again')).toBe('Hello\n\nWorld\nagain');
	});

	it('trims the whole thing and collapses runs of spaces', () => {
		expect(cleanMultiline('\n\n  Well    done!  \n\n')).toBe('Well done!');
	});

	it('turns tabs and control characters into spaces', () => {
		expect(cleanMultiline('a\tb\u0000c')).toBe('a b c');
	});
});

describe('charLength', () => {
	it('counts code points, not UTF-16 units', () => {
		expect(charLength('abc')).toBe(3);
		expect(charLength('🎉')).toBe(1);
		expect('🎉'.length).toBe(2);
	});
});

describe('parseId', () => {
	it('accepts positive integers', () => {
		expect(parseId('1')).toBe(1);
		expect(parseId('12345')).toBe(12345);
	});

	it('rejects everything else', () => {
		for (const bad of ['0', '-1', '01', '1.5', '1e3', ' 1', 'abc', '', '9999999999999999', undefined, 7]) {
			expect(parseId(bad)).toBeNull();
		}
	});
});

describe('plural', () => {
	it('pluralises and formats', () => {
		expect(plural(0, 'message')).toBe('0 messages');
		expect(plural(1, 'message')).toBe('1 message');
		expect(plural(1234, 'suggestion')).toBe('1,234 suggestions');
		expect(plural(2, 'item', 'items of note')).toBe('2 items of note');
	});
});

describe('validateWallEntry', () => {
	it('accepts and cleans a good entry', () => {
		const r = validateWallEntry({ name: '  Aunt Jo ', message: '  Congratulations!\r\n\r\n\r\nLove, Jo  ' });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toEqual({ name: 'Aunt Jo', message: 'Congratulations!\n\nLove, Jo' });
	});

	it('requires both fields', () => {
		const r = validateWallEntry({ name: '   ', message: '\n\n' });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors.name).toBeTruthy();
			expect(r.errors.message).toBeTruthy();
		}
	});

	it('treats missing or non-string fields as empty', () => {
		const r = validateWallEntry({});
		expect(r.ok).toBe(false);
		expect(r.input).toEqual({ name: '', message: '' });
	});

	it('enforces the length limits after trimming', () => {
		expect(validateWallEntry({ name: 'a'.repeat(WALL_NAME_MAX), message: 'hi' }).ok).toBe(true);
		expect(validateWallEntry({ name: `  ${'a'.repeat(WALL_NAME_MAX)}  `, message: 'hi' }).ok).toBe(true);
		expect(validateWallEntry({ name: 'a'.repeat(WALL_NAME_MAX + 1), message: 'hi' }).ok).toBe(false);
		expect(validateWallEntry({ name: 'Jo', message: 'm'.repeat(WALL_MESSAGE_MAX) }).ok).toBe(true);
		const long = validateWallEntry({ name: 'Jo', message: 'm'.repeat(WALL_MESSAGE_MAX + 1) });
		expect(long.ok).toBe(false);
		if (!long.ok) expect(long.errors.message).toMatch(/501/);
	});

	it('counts emoji as one character each', () => {
		expect(validateWallEntry({ name: 'Jo', message: '🎉'.repeat(WALL_MESSAGE_MAX) }).ok).toBe(true);
	});

	it('returns cleaned input for re-filling the form', () => {
		const r = validateWallEntry({ name: ' Jo ', message: '' });
		expect(r.input).toEqual({ name: 'Jo', message: '' });
	});
});

describe('suggested names', () => {
	it('accepts letters, accents, spaces, hyphens and apostrophes', () => {
		for (const name of ['Alex', 'Zoë', 'Renée', 'Anne-Marie', "D'Angelo", "O'Brien-Smith", 'Mary Jane', 'Søren', 'Łucja', 'X', 'Ægir', 'José María', 'Ngọc']) {
			expect(isValidSuggestedName(normaliseSuggestedName(name)), name).toBe(true);
		}
	});

	it('rejects digits, symbols and stray punctuation', () => {
		for (const name of ['R2-D2', 'Alex!', 'Bobby;DROP TABLE', '<script>', '-Alex', 'Alex-', "Alex'", 'A--B', "A''B", '🎉', '_', "'"]) {
			expect(isValidSuggestedName(normaliseSuggestedName(name)), name).toBe(false);
		}
	});

	it('normalises typographic apostrophes, hyphens and stray spaces', () => {
		expect(normaliseSuggestedName('  D\u2019Angelo ')).toBe("D'Angelo");
		expect(normaliseSuggestedName('Anne \u2013 Marie')).toBe('Anne-Marie');
		expect(normaliseSuggestedName('Jean \u2010 Luc')).toBe('Jean-Luc');
		expect(normaliseSuggestedName("O ' Brien")).toBe("O'Brien");
		expect(normaliseSuggestedName('Mary    Jane')).toBe('Mary Jane');
	});

	it('spots the same name regardless of case, but not regardless of accents', () => {
		expect(nameKey('zoë')).toBe(nameKey('ZOË'));
		expect(nameKey('  anne – MARIE ')).toBe(nameKey('Anne-Marie'));
		expect(nameKey("D’Angelo")).toBe(nameKey("d'angelo"));
		expect(nameKey('Zoe')).not.toBe(nameKey('Zoë'));
	});

	it('enforces the 40-character limit', () => {
		expect(isValidSuggestedName('A'.repeat(NAME_MAX))).toBe(true);
		expect(isValidSuggestedName('A'.repeat(NAME_MAX + 1))).toBe(false);
	});
});

describe('validateNameSuggestion', () => {
	it('accepts a name with an optional suggester', () => {
		const r = validateNameSuggestion({ name: ' Zoë ', suggestedBy: '  Uncle   Bob ' });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toEqual({ name: 'Zoë', suggestedBy: 'Uncle Bob' });
	});

	it('turns an empty suggester into null', () => {
		const r = validateNameSuggestion({ name: 'Alex', suggestedBy: '   ' });
		expect(r.ok && r.value.suggestedBy).toBeNull();
		const missing = validateNameSuggestion({ name: 'Alex' });
		expect(missing.ok && missing.value.suggestedBy).toBeNull();
	});

	it('explains what is wrong with a name', () => {
		const empty = validateNameSuggestion({ name: '' });
		expect(!empty.ok && empty.errors.name).toMatch(/suggest a name/);
		const digits = validateNameSuggestion({ name: 'Alex 2' });
		expect(!digits.ok && digits.errors.name).toMatch(/Letters/);
		const long = validateNameSuggestion({ name: 'A'.repeat(41) });
		expect(!long.ok && long.errors.name).toMatch(/40 characters/);
	});

	it('limits the suggester to 40 characters', () => {
		expect(validateNameSuggestion({ name: 'Alex', suggestedBy: 'b'.repeat(40) }).ok).toBe(true);
		const r = validateNameSuggestion({ name: 'Alex', suggestedBy: 'b'.repeat(41) });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors.suggestedBy).toBeTruthy();
			expect(r.errors.name).toBeUndefined();
		}
	});

	it('allows any printable characters in the suggester', () => {
		expect(validateNameSuggestion({ name: 'Alex', suggestedBy: 'Bob (from work) #1 🎉' }).ok).toBe(true);
	});

	it('refuses addresses and links in the suggester, since it is shown publicly', () => {
		const email = validateNameSuggestion({ name: 'Alex', suggestedBy: 'jane.smith@example.com' });
		expect(!email.ok && email.errors.suggestedBy).toMatch(/email address/);
		const link = validateNameSuggestion({ name: 'Alex', suggestedBy: 'www.example.org' });
		expect(!link.ok && link.errors.suggestedBy).toMatch(/not links/);
		expect(validateNameSuggestion({ name: 'Alex', suggestedBy: 'Auntie Jo' }).ok).toBe(true);
	});
});

describe('validateChecklistLabel', () => {
	it('trims and accepts', () => {
		expect(validateChecklistLabel('  Car seat   installed ')).toEqual({ ok: true, value: 'Car seat installed' });
	});

	it('rejects empty and over-long labels', () => {
		expect(validateChecklistLabel('   ').ok).toBe(false);
		expect(validateChecklistLabel(undefined).ok).toBe(false);
		expect(validateChecklistLabel('x'.repeat(120)).ok).toBe(true);
		expect(validateChecklistLabel('x'.repeat(121)).ok).toBe(false);
	});
});

describe('competitionRanks', () => {
	it('gives ties the same rank and skips the next', () => {
		expect(competitionRanks([5, 3, 3, 1])).toEqual([1, 2, 2, 4]);
		expect(competitionRanks([2, 2, 2])).toEqual([1, 1, 1]);
		expect(competitionRanks([9, 8, 7])).toEqual([1, 2, 3]);
		expect(competitionRanks([])).toEqual([]);
	});
});

describe('moderation helpers', () => {
	it('recognises moderation actions', () => {
		expect(isModerationAction('approve')).toBe(true);
		expect(isModerationAction('reject')).toBe(true);
		expect(isModerationAction('remove')).toBe(true);
		expect(isModerationAction('delete')).toBe(false);
		expect(isModerationAction(undefined)).toBe(false);
	});

	it('flags messages that look like links', () => {
		expect(looksLikeLink('see https://example.com')).toBe(true);
		expect(looksLikeLink('www.example.org')).toBe(true);
		expect(looksLikeLink('cheap-pills.xyz now')).toBe(true);
		expect(looksLikeLink('Congratulations! So happy for you both.')).toBe(false);
	});
});
