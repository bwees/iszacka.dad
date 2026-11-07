import { describe, expect, it } from 'vitest';
import {
	TRANSLATIONS,
	answerInLanguage,
	findTranslation,
	isRtl,
	negotiateTranslation,
	parseAcceptLanguage,
	wordFor,
} from '../src/lib/i18n';

describe('TRANSLATIONS', () => {
	it('covers at least 40 languages, English first', () => {
		expect(TRANSLATIONS.length).toBeGreaterThanOrEqual(40);
		expect(TRANSLATIONS[0]?.lang).toBe('en');
	});

	it('has unique tags and non-empty words', () => {
		const tags = TRANSLATIONS.map((t) => t.lang.toLowerCase());
		expect(new Set(tags).size).toBe(tags.length);
		for (const t of TRANSLATIONS) {
			expect(t.name.trim(), t.lang).not.toBe('');
			for (const word of [t.no, t.notYet, t.yes]) {
				expect(word.trim(), `${t.lang}: ${word}`).not.toBe('');
				expect(word.length, `${t.lang}: ${word}`).toBeLessThanOrEqual(24);
			}
		}
	});

	it('uses well-formed BCP 47 tags', () => {
		for (const t of TRANSLATIONS) expect(t.lang).toMatch(/^[a-z]{2,3}(-[A-Z][a-z]{3})?$/);
	});

	it('has spot-checked entries', () => {
		const byLang = (lang: string) => TRANSLATIONS.find((t) => t.lang === lang);
		expect(byLang('de')).toMatchObject({ no: 'Nein', notYet: 'Noch nicht', yes: 'Ja' });
		expect(byLang('fr')).toMatchObject({ no: 'Non', notYet: 'Pas encore', yes: 'Oui' });
		expect(byLang('ja')).toMatchObject({ no: 'いいえ', yes: 'はい' });
		expect(byLang('cy')).toMatchObject({ no: 'Nac ydy', yes: 'Ydy' });
	});
});

describe('parseAcceptLanguage', () => {
	it('returns nothing for missing or empty headers', () => {
		expect(parseAcceptLanguage(undefined)).toEqual([]);
		expect(parseAcceptLanguage(null)).toEqual([]);
		expect(parseAcceptLanguage('')).toEqual([]);
	});

	it('orders by quality, keeping header order for ties', () => {
		expect(parseAcceptLanguage('fr;q=0.5, de-CH, en;q=0.5, *;q=0.1').map((r) => r.tag)).toEqual([
			'de-ch',
			'fr',
			'en',
			'*',
		]);
	});

	it('drops q=0, malformed tags and malformed q values', () => {
		expect(parseAcceptLanguage('de;q=0, fr;q=banana, <script>, es;q=0.9, it;q=1.5').map((r) => r.tag)).toEqual(['es']);
	});

	it('normalises case and underscores', () => {
		expect(parseAcceptLanguage('PT_br')).toEqual([{ tag: 'pt-br', q: 1 }]);
	});

	it('caps absurdly long headers', () => {
		const header = Array.from({ length: 500 }, () => 'xx').join(',');
		expect(parseAcceptLanguage(header).length).toBeLessThanOrEqual(32);
	});
});

describe('findTranslation', () => {
	it('matches exact tags case-insensitively', () => {
		expect(findTranslation('DE')?.lang).toBe('de');
		expect(findTranslation('sr-latn')?.lang).toBe('sr-Latn');
	});

	it('falls back to shorter prefixes', () => {
		expect(findTranslation('pt-BR')?.lang).toBe('pt');
		expect(findTranslation('en-GB')?.lang).toBe('en');
		expect(findTranslation('zh-Hant-TW')?.lang).toBe('zh-Hant');
	});

	it('maps aliases and regional Chinese', () => {
		expect(findTranslation('no')?.lang).toBe('nb');
		expect(findTranslation('iw')?.lang).toBe('he');
		expect(findTranslation('tl')?.lang).toBe('fil');
		expect(findTranslation('zh')?.lang).toBe('zh-Hans');
		expect(findTranslation('zh-CN')?.lang).toBe('zh-Hans');
		expect(findTranslation('zh-TW')?.lang).toBe('zh-Hant');
		expect(findTranslation('zh-HK')?.lang).toBe('zh-Hant');
	});

	it('returns null for unknown languages', () => {
		expect(findTranslation('xx')).toBeNull();
		expect(findTranslation('qaa-x-made-up')).toBeNull();
	});
});

describe('negotiateTranslation / answerInLanguage', () => {
	it('defaults to English', () => {
		expect(answerInLanguage(undefined, 'no')).toEqual({ lang: 'en', name: 'English', word: 'No' });
		expect(answerInLanguage('xx, yy;q=0.5', 'yes').word).toBe('Yes');
	});

	it('picks the first supported language in preference order', () => {
		expect(answerInLanguage('xx, de-AT;q=0.9, fr;q=0.8', 'no')).toEqual({ lang: 'de', name: 'German', word: 'Nein' });
		expect(answerInLanguage('fr;q=0.4, it;q=0.6', 'soon').word).toBe('Non ancora');
	});

	it('treats a wildcard as "English is fine"', () => {
		expect(negotiateTranslation('xx, *, de').lang).toBe('en');
	});

	it('maps each status to the right word', () => {
		const de = negotiateTranslation('de');
		expect(wordFor(de, 'no')).toBe('Nein');
		expect(wordFor(de, 'soon')).toBe('Noch nicht');
		expect(wordFor(de, 'yes')).toBe('Ja');
	});

	it('handles a typical browser header', () => {
		expect(answerInLanguage('en-GB,en-US;q=0.9,en;q=0.8', 'no').lang).toBe('en');
		expect(answerInLanguage('ja,en-US;q=0.9,en;q=0.8', 'yes').word).toBe('はい');
	});
});

describe('isRtl', () => {
	it('flags right-to-left scripts only', () => {
		expect(isRtl('ar')).toBe(true);
		expect(isRtl('he')).toBe(true);
		expect(isRtl('fa')).toBe(true);
		expect(isRtl('de')).toBe(false);
		expect(isRtl('zh-Hant')).toBe(false);
	});
});
