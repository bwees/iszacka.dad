// Keeps the TXT record DNS_RECORD_NAME (answer.iszacka.dad) in sync with the
// answer, so `dig +short TXT answer.iszacka.dad` works for the truly committed.
// Cloudflare's v4 API: find the zone, find the record, PATCH it or create it.

import type { DeliveryResult, SiteState } from '../types';

const API = 'https://api.cloudflare.com/client/v4';
export const DNS_TTL = 60;
const TIMEOUT_MS = 10_000;
const COMMENT = 'Managed by iszacka.dad. Editing it by hand will not make Zack a dad any faster.';

/** The TXT content, quoted as Cloudflare likes it: "is-zack-a-dad=no; since=<iso>[; due=<ymd>]". */
export function answerRecordContent(state: SiteState): string {
	const parts = [`is-zack-a-dad=${state.status}`, `since=${state.statusChangedAt}`];
	if (state.dueDate && state.status !== 'yes') parts.push(`due=${state.dueDate}`);
	return `"${parts.join('; ').replace(/["\\]/g, '')}"`;
}

/** Same TXT value, ignoring the optional quoting (the API may return either). */
export function sameTxtContent(a: string, b: string): boolean {
	const strip = (value: string) => value.trim().replace(/^"(.*)"$/s, '$1');
	return strip(a) === strip(b);
}

interface CloudflareEnvelope<T> {
	success: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	result: T;
}

interface DnsRecord {
	id: string;
	name: string;
	content: string;
	ttl: number;
}

class CloudflareApiError extends Error {}

async function cloudflare<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${API}${path}`, {
			method: init.method ?? 'GET',
			headers: {
				Authorization: `Bearer ${token}`,
				...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
		throw new CloudflareApiError(timedOut ? `Cloudflare API timed out after ${TIMEOUT_MS / 1000}s` : `Cloudflare API unreachable: ${String(err)}`);
	}
	let data: CloudflareEnvelope<T> | null = null;
	try {
		data = (await res.json()) as CloudflareEnvelope<T>;
	} catch {
		// Not JSON; reported below with the status code.
	}
	if (!res.ok || !data?.success) {
		const reasons = (data?.errors ?? []).map((e) => `${e.code ?? '?'} ${e.message ?? ''}`.trim()).join(', ');
		throw new CloudflareApiError(`Cloudflare API ${init.method ?? 'GET'} ${path.split('?')[0]} → HTTP ${res.status}${reasons ? `: ${reasons}` : ''}`);
	}
	return data.result;
}

async function resolveZoneId(env: Env, token: string): Promise<string> {
	if (env.DNS_ZONE_ID) return env.DNS_ZONE_ID;
	const zoneName = env.ZONE_NAME || env.DNS_RECORD_NAME.split('.').slice(-2).join('.');
	const zones = await cloudflare<Array<{ id: string; name: string }>>(token, `/zones?name=${encodeURIComponent(zoneName)}&per_page=5`);
	const zone = zones.find((z) => z.name === zoneName) ?? zones[0];
	if (!zone) throw new CloudflareApiError(`no zone named ${zoneName} is visible to the API token`);
	return zone.id;
}

/** Upsert the TXT record. Never throws. Skips (ok: true, detail 'skipped') when DNS_API_TOKEN / DNS_RECORD_NAME is unset. */
export async function updateAnswerRecord(env: Env, state: SiteState): Promise<DeliveryResult> {
	const token = env.DNS_API_TOKEN;
	const name = env.DNS_RECORD_NAME?.trim().replace(/\.$/, '');
	if (!token || !name) return { ok: true, detail: 'skipped' };

	try {
		const zoneId = await resolveZoneId(env, token);
		const content = answerRecordContent(state);
		const records = await cloudflare<DnsRecord[]>(
			token,
			`/zones/${encodeURIComponent(zoneId)}/dns_records?type=TXT&name=${encodeURIComponent(name)}&per_page=10`,
		);
		const existing = records.find((r) => r.name === name) ?? records[0];
		if (existing) {
			if (sameTxtContent(existing.content, content) && existing.ttl === DNS_TTL) {
				return { ok: true, detail: `${name} already says ${content}` };
			}
			await cloudflare<DnsRecord>(token, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existing.id)}`, {
				method: 'PATCH',
				body: { content, ttl: DNS_TTL, comment: COMMENT },
			});
			return { ok: true, detail: `updated ${name} to ${content}` };
		}
		await cloudflare<DnsRecord>(token, `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
			method: 'POST',
			body: { type: 'TXT', name, content, ttl: DNS_TTL, comment: COMMENT },
		});
		return { ok: true, detail: `created ${name} with ${content}` };
	} catch (err) {
		const detail = err instanceof CloudflareApiError ? err.message : `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
		console.error('DNS answer record update failed:', detail);
		return { ok: false, detail: detail.slice(0, 300) };
	}
}
