// Site-wide constants and copy shared by every module.

import type { Status } from '../types';

export const SITE_NAME = 'Is Zack a Dad?';
export const DAD = 'Zack';
export const PARENTS = 'Jess & Zack';
export const DOMAIN = 'iszacka.dad';

/** The TXT record name `dig` can query, or null when the DNS updater isn't configured. */
export function dnsAnswerName(env: Pick<Env, 'DNS_API_TOKEN' | 'DNS_RECORD_NAME'>): string | null {
	return env.DNS_API_TOKEN && env.DNS_RECORD_NAME ? env.DNS_RECORD_NAME : null;
}

/** Absolute base URL for links that leave the request context (emails, feeds, webhooks). No trailing slash. */
export function siteUrl(env: Pick<Env, 'SITE_URL'>): string {
	return (env.SITE_URL || `https://${DOMAIN}`).replace(/\/+$/, '');
}

export interface StatusCopy {
	/** The giant word on the homepage. */
	word: string;
	/** Short answer for text contexts. */
	short: string;
	/** Headline for updates, emails, notifications. */
	headline: string;
	/** One full sentence. */
	sentence: string;
	/** Favicon / tab emoji. */
	emoji: string;
	/** Value of the X-Is-Zack-A-Dad header. */
	header: string;
	/** Default note written to the Dad Ledger when the site enters this status. */
	ledgerNote: string;
}

// Copy rules for every module: never use gendered pronouns for anyone (Zack, Jess or
// the baby). Say "Zack", "Jess", "the baby". Never mention baby names, weights,
// locations or hospitals: the site only knows whether Zack is a dad.
export const STATUS_COPY: Record<Status, StatusCopy> = {
	no: {
		word: 'NO',
		short: 'No.',
		headline: 'Zack is not a dad.',
		sentence: 'Zack is not a dad. Yet.',
		emoji: '🥚',
		header: 'no',
		ledgerNote: 'Zack is not a dad.',
	},
	soon: {
		word: 'NOT YET',
		short: 'Not yet, but it is happening.',
		headline: "It's happening.",
		sentence: "Zack is not a dad yet, but it's happening right now.",
		emoji: '🐣',
		header: 'not yet (it is happening)',
		ledgerNote: 'Labour has started. Zack is about to be a dad.',
	},
	yes: {
		word: 'YES',
		short: 'Yes!',
		headline: 'Zack is a dad!',
		sentence: 'Zack is a dad! The baby is here.',
		emoji: '👶',
		header: 'yes',
		ledgerNote: 'Zack is a dad.',
	},
};
