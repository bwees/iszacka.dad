// OWNER: frontend agent.
// "No" (and "not yet" / "yes") in 70-odd languages, and Accept-Language negotiation.
//
// Every entry answers the specific question "Is Zack a dad?", so where a language
// answers yes/no questions by echoing the verb (Welsh) or by negating the copula
// (Thai, Nepali, Telugu, Chinese), the entry uses that form rather than a bare
// dictionary "no". Languages with no idiomatic standalone yes/no (Irish, Scottish
// Gaelic) are deliberately left out rather than guessed at.

import type { Status } from '../types';

export interface Translation {
	/** BCP 47 tag, e.g. 'de'. */
	lang: string;
	/** Language name in English. */
	name: string;
	no: string;
	notYet: string;
	yes: string;
}

export const TRANSLATIONS: Translation[] = [
	{ lang: 'en', name: 'English', no: 'No', notYet: 'Not yet', yes: 'Yes' },
	{ lang: 'fr', name: 'French', no: 'Non', notYet: 'Pas encore', yes: 'Oui' },
	{ lang: 'de', name: 'German', no: 'Nein', notYet: 'Noch nicht', yes: 'Ja' },
	{ lang: 'es', name: 'Spanish', no: 'No', notYet: 'Todavía no', yes: 'Sí' },
	{ lang: 'it', name: 'Italian', no: 'No', notYet: 'Non ancora', yes: 'Sì' },
	{ lang: 'pt', name: 'Portuguese', no: 'Não', notYet: 'Ainda não', yes: 'Sim' },
	{ lang: 'nl', name: 'Dutch', no: 'Nee', notYet: 'Nog niet', yes: 'Ja' },
	{ lang: 'af', name: 'Afrikaans', no: 'Nee', notYet: 'Nog nie', yes: 'Ja' },
	{ lang: 'lb', name: 'Luxembourgish', no: 'Nee', notYet: 'Nach net', yes: 'Jo' },
	{ lang: 'sv', name: 'Swedish', no: 'Nej', notYet: 'Inte än', yes: 'Ja' },
	{ lang: 'da', name: 'Danish', no: 'Nej', notYet: 'Ikke endnu', yes: 'Ja' },
	{ lang: 'nb', name: 'Norwegian (Bokmål)', no: 'Nei', notYet: 'Ikke ennå', yes: 'Ja' },
	{ lang: 'nn', name: 'Norwegian (Nynorsk)', no: 'Nei', notYet: 'Ikkje enno', yes: 'Ja' },
	{ lang: 'is', name: 'Icelandic', no: 'Nei', notYet: 'Ekki ennþá', yes: 'Já' },
	{ lang: 'fi', name: 'Finnish', no: 'Ei', notYet: 'Ei vielä', yes: 'Kyllä' },
	{ lang: 'et', name: 'Estonian', no: 'Ei', notYet: 'Veel mitte', yes: 'Jah' },
	{ lang: 'lv', name: 'Latvian', no: 'Nē', notYet: 'Vēl nē', yes: 'Jā' },
	{ lang: 'lt', name: 'Lithuanian', no: 'Ne', notYet: 'Dar ne', yes: 'Taip' },
	{ lang: 'pl', name: 'Polish', no: 'Nie', notYet: 'Jeszcze nie', yes: 'Tak' },
	{ lang: 'cs', name: 'Czech', no: 'Ne', notYet: 'Ještě ne', yes: 'Ano' },
	{ lang: 'sk', name: 'Slovak', no: 'Nie', notYet: 'Ešte nie', yes: 'Áno' },
	{ lang: 'sl', name: 'Slovenian', no: 'Ne', notYet: 'Še ne', yes: 'Da' },
	{ lang: 'hr', name: 'Croatian', no: 'Ne', notYet: 'Još ne', yes: 'Da' },
	{ lang: 'sr', name: 'Serbian', no: 'Не', notYet: 'Још не', yes: 'Да' },
	{ lang: 'sr-Latn', name: 'Serbian (Latin)', no: 'Ne', notYet: 'Još ne', yes: 'Da' },
	{ lang: 'mk', name: 'Macedonian', no: 'Не', notYet: 'Сè уште не', yes: 'Да' },
	{ lang: 'bg', name: 'Bulgarian', no: 'Не', notYet: 'Още не', yes: 'Да' },
	{ lang: 'ru', name: 'Russian', no: 'Нет', notYet: 'Ещё нет', yes: 'Да' },
	{ lang: 'uk', name: 'Ukrainian', no: 'Ні', notYet: 'Ще ні', yes: 'Так' },
	{ lang: 'kk', name: 'Kazakh', no: 'Жоқ', notYet: 'Әлі жоқ', yes: 'Иә' },
	{ lang: 'uz', name: 'Uzbek', no: 'Yoʻq', notYet: 'Hali yoʻq', yes: 'Ha' },
	{ lang: 'az', name: 'Azerbaijani', no: 'Xeyr', notYet: 'Hələ yox', yes: 'Bəli' },
	{ lang: 'tr', name: 'Turkish', no: 'Hayır', notYet: 'Henüz değil', yes: 'Evet' },
	{ lang: 'hu', name: 'Hungarian', no: 'Nem', notYet: 'Még nem', yes: 'Igen' },
	{ lang: 'ro', name: 'Romanian', no: 'Nu', notYet: 'Încă nu', yes: 'Da' },
	{ lang: 'sq', name: 'Albanian', no: 'Jo', notYet: 'Jo ende', yes: 'Po' },
	{ lang: 'el', name: 'Greek', no: 'Όχι', notYet: 'Όχι ακόμα', yes: 'Ναι' },
	{ lang: 'ka', name: 'Georgian', no: 'არა', notYet: 'ჯერ არა', yes: 'კი' },
	{ lang: 'hy', name: 'Armenian', no: 'Ոչ', notYet: 'Դեռ ոչ', yes: 'Այո' },
	{ lang: 'ca', name: 'Catalan', no: 'No', notYet: 'Encara no', yes: 'Sí' },
	{ lang: 'gl', name: 'Galician', no: 'Non', notYet: 'Aínda non', yes: 'Si' },
	{ lang: 'eu', name: 'Basque', no: 'Ez', notYet: 'Oraindik ez', yes: 'Bai' },
	{ lang: 'cy', name: 'Welsh', no: 'Nac ydy', notYet: 'Ddim eto', yes: 'Ydy' },
	{ lang: 'sco', name: 'Scots', no: 'Naw', notYet: 'No yet', yes: 'Aye' },
	{ lang: 'la', name: 'Latin', no: 'Non', notYet: 'Nondum', yes: 'Ita' },
	{ lang: 'eo', name: 'Esperanto', no: 'Ne', notYet: 'Ankoraŭ ne', yes: 'Jes' },
	{ lang: 'ar', name: 'Arabic', no: 'لا', notYet: 'ليس بعد', yes: 'نعم' },
	{ lang: 'he', name: 'Hebrew', no: 'לא', notYet: 'עוד לא', yes: 'כן' },
	{ lang: 'yi', name: 'Yiddish', no: 'ניין', notYet: 'נאָך נישט', yes: 'יאָ' },
	{ lang: 'fa', name: 'Persian', no: 'نه', notYet: 'هنوز نه', yes: 'بله' },
	{ lang: 'ur', name: 'Urdu', no: 'نہیں', notYet: 'ابھی تک نہیں', yes: 'ہاں' },
	{ lang: 'hi', name: 'Hindi', no: 'नहीं', notYet: 'अभी तक नहीं', yes: 'हाँ' },
	{ lang: 'mr', name: 'Marathi', no: 'नाही', notYet: 'अजून नाही', yes: 'हो' },
	{ lang: 'ne', name: 'Nepali', no: 'होइन', notYet: 'अझै होइन', yes: 'हो' },
	{ lang: 'bn', name: 'Bengali', no: 'না', notYet: 'এখনও না', yes: 'হ্যাঁ' },
	{ lang: 'pa', name: 'Punjabi', no: 'ਨਹੀਂ', notYet: 'ਅਜੇ ਨਹੀਂ', yes: 'ਹਾਂ' },
	{ lang: 'gu', name: 'Gujarati', no: 'ના', notYet: 'હજી નહીં', yes: 'હા' },
	{ lang: 'ta', name: 'Tamil', no: 'இல்லை', notYet: 'இன்னும் இல்லை', yes: 'ஆம்' },
	{ lang: 'te', name: 'Telugu', no: 'కాదు', notYet: 'ఇంకా కాదు', yes: 'అవును' },
	{ lang: 'th', name: 'Thai', no: 'ไม่ใช่', notYet: 'ยังไม่ใช่', yes: 'ใช่' },
	{ lang: 'vi', name: 'Vietnamese', no: 'Không', notYet: 'Chưa', yes: 'Có' },
	{ lang: 'id', name: 'Indonesian', no: 'Tidak', notYet: 'Belum', yes: 'Ya' },
	{ lang: 'ms', name: 'Malay', no: 'Tidak', notYet: 'Belum', yes: 'Ya' },
	{ lang: 'fil', name: 'Filipino', no: 'Hindi', notYet: 'Hindi pa', yes: 'Oo' },
	{ lang: 'zh-Hans', name: 'Chinese (Simplified)', no: '不是', notYet: '还不是', yes: '是的' },
	{ lang: 'zh-Hant', name: 'Chinese (Traditional)', no: '不是', notYet: '還不是', yes: '是的' },
	{ lang: 'yue', name: 'Cantonese', no: '唔係', notYet: '仲未係', yes: '係' },
	{ lang: 'ja', name: 'Japanese', no: 'いいえ', notYet: 'まだです', yes: 'はい' },
	{ lang: 'ko', name: 'Korean', no: '아니요', notYet: '아직이요', yes: '네' },
	{ lang: 'sw', name: 'Swahili', no: 'Hapana', notYet: 'Bado', yes: 'Ndiyo' },
	{ lang: 'mi', name: 'Māori', no: 'Kāo', notYet: 'Kāore anō', yes: 'Āe' },
	{ lang: 'tlh', name: 'Klingon', no: "ghobe'", notYet: 'wej', yes: "HIja'" },
];

/** Deprecated, macro-language and regional tags that should map onto an entry above. Keys are lower case. */
const ALIASES: Record<string, string> = {
	no: 'nb', // ISO 639-1 "Norwegian" is what most browsers send
	iw: 'he', // pre-1989 code for Hebrew, still sent by old Android builds
	ji: 'yi',
	in: 'id',
	tl: 'fil',
	zh: 'zh-Hans',
	'zh-cn': 'zh-Hans',
	'zh-sg': 'zh-Hans',
	'zh-my': 'zh-Hans',
	'zh-tw': 'zh-Hant',
	'zh-hk': 'zh-Hant',
	'zh-mo': 'zh-Hant',
	sh: 'sr-Latn', // Serbo-Croatian, written in Latin script
	'sr-me': 'sr-Latn', // Montenegro uses Latin script by default
	cmn: 'zh-Hans',
	nob: 'nb',
	nno: 'nn',
};

const BY_TAG = new Map(TRANSLATIONS.map((t) => [t.lang.toLowerCase(), t]));

/** Accept-Language headers longer than this are truncated: nobody speaks that many languages. */
const MAX_HEADER_LENGTH = 1024;
const MAX_RANGES = 32;

export interface LanguageRange {
	/** Lower-cased language range, e.g. 'en-gb' or '*'. */
	tag: string;
	/** Quality, 0-1. */
	q: number;
}

/**
 * Parse an Accept-Language header into ranges ordered by preference (highest q first,
 * header order breaking ties). Malformed entries and q=0 ("not this one") are dropped.
 */
export function parseAcceptLanguage(header: string | null | undefined): LanguageRange[] {
	if (!header) return [];
	const ranges: Array<LanguageRange & { index: number }> = [];
	const parts = header.slice(0, MAX_HEADER_LENGTH).split(',').slice(0, MAX_RANGES);
	parts.forEach((part, index) => {
		const [rawTag = '', ...params] = part.trim().split(';');
		const tag = rawTag.trim().toLowerCase().replace(/_/g, '-');
		if (!/^(\*|[a-z]{1,8}(-[a-z0-9]{1,8})*)$/.test(tag)) return;
		let q = 1;
		for (const param of params) {
			const [key, value] = param.split('=').map((s) => s.trim().toLowerCase());
			if (key !== 'q') continue;
			const parsed = Number(value);
			q = value !== undefined && /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(value) && Number.isFinite(parsed) ? parsed : -1;
		}
		if (q > 0) ranges.push({ tag, q, index });
	});
	return ranges.sort((a, b) => b.q - a.q || a.index - b.index).map(({ tag, q }) => ({ tag, q }));
}

/**
 * Find the translation for one language range: exact tag, then known aliases, then
 * progressively shorter prefixes ('pt-br' → 'pt', 'zh-hant-tw' → 'zh-hant').
 */
export function findTranslation(range: string): Translation | null {
	const subtags = range.toLowerCase().replace(/_/g, '-').split('-').filter(Boolean);
	for (let n = subtags.length; n > 0; n--) {
		const candidate = subtags.slice(0, n).join('-');
		const direct = BY_TAG.get(candidate);
		if (direct) return direct;
		const alias = ALIASES[candidate];
		if (alias) return BY_TAG.get(alias.toLowerCase()) ?? null;
	}
	return null;
}

/** The answer word for a status in a given language. */
export function wordFor(t: Translation, status: Status): string {
	return status === 'yes' ? t.yes : status === 'soon' ? t.notYet : t.no;
}

const ENGLISH = TRANSLATIONS[0] as Translation;

/** Negotiate the best translation for an Accept-Language header (falls back to English). */
export function negotiateTranslation(acceptLanguage: string | null | undefined): Translation {
	for (const { tag } of parseAcceptLanguage(acceptLanguage)) {
		if (tag === '*') return ENGLISH;
		const match = findTranslation(tag);
		if (match) return match;
	}
	return ENGLISH;
}

/** Pick the best translation for an Accept-Language header (falls back to English). */
export function answerInLanguage(acceptLanguage: string | undefined, status: Status): { lang: string; name: string; word: string } {
	const t = negotiateTranslation(acceptLanguage);
	return { lang: t.lang, name: t.name, word: wordFor(t, status) };
}

/** Right-to-left scripts, for setting dir="rtl" on foreign-language snippets. */
const RTL = new Set(['ar', 'he', 'yi', 'fa', 'ur']);

export function isRtl(lang: string): boolean {
	return RTL.has(lang.split('-')[0]?.toLowerCase() ?? '');
}
