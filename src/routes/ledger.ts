// OWNER: ledger agent.
// /ledger, /api/ledger, /.well-known/dad-ledger.json, /ledger/verify.mjs, /og.png.
// Chain verification is memoised per isolate (see verifyLedgerCached): on Workers Free a
// request gets 10 ms of CPU, and re-checking every hash and signature on every hit adds up.

import type { Context } from 'hono';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { LinearRouter } from 'hono/router/linear-router';
import { renderPage } from '../lib/layout';
import {
	CANONICAL_FORMAT,
	canonicalString,
	GENESIS_PREV_HASH,
	getLedger,
	getLedgerPublicKey,
	getLedgerSummary,
	LEDGER_SNAPSHOT_LIMIT,
	LEDGER_ALGORITHM,
	LEDGER_HASH_ALGORITHM,
	type LedgerEntry,
	ledgerVerifierScript,
	type LedgerVerification,
	verifyLedger,
} from '../lib/ledger';
import { ogCardPath, ogVersionStatus } from '../lib/og';
import { allow, clientKey, sha256Hex, wantsJson } from '../lib/security';
import { DAD, STATUS_COPY } from '../lib/site';
import { formatLondon } from '../lib/time';
import type { AppEnv, Status } from '../types';

export const ledgerRoutes = new Hono<AppEnv>({ router: new LinearRouter() });

type Ctx = Context<AppEnv>;

const LEDGER_TAGLINE =
	'A tamper-evident, cryptographically signed, append-only record of whether Zack is a dad. Like a blockchain, but useful.';

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
	'Access-Control-Expose-Headers': 'ETag, X-Ledger-Head, X-Ledger-Verified',
	'Access-Control-Max-Age': '86400',
};

const CANONICALISATION = {
	format: CANONICAL_FORMAT,
	description:
		'Each entry is serialised as its seq (decimal integer), at (ISO-8601 UTC timestamp), status (no | soon | yes), note (free text, NFC-normalised, may contain "|") and prevHash (64 lowercase hex characters), joined with "|" and encoded as UTF-8. It is unambiguous because only the note can contain "|" and prevHash is always the final 64 characters.',
	hash: 'hash = lowercase hex SHA-256 of the UTF-8 bytes of the canonical string.',
	signature:
		'signature = Ed25519 signature over the UTF-8 bytes of the 64-character hash hex string (not the raw digest), encoded as unpadded base64url.',
	chain: 'prevHash is the hash of the previous entry. seq starts at 0 and has no gaps.',
	genesisPrevHash: GENESIS_PREV_HASH,
} as const;

const shorten = (value: string, length = 12) => (value.length > length ? `${value.slice(0, length)}…` : value);

const publicKeyJwk = (publicKey: string) => ({ kty: 'OKP', crv: 'Ed25519', x: publicKey }) as const;

const originOf = (c: Ctx) => new URL(c.req.url).origin;

/** Rate-limit the JSON endpoints. Returns a 429 response, or null to carry on. */
async function apiLimit(c: Ctx): Promise<Response | null> {
	if (await allow(c.env.RL_API, `ledger:${clientKey(c)}`)) return null;
	return c.json({ error: 'Too many requests. The ledger is append-only; it will still be here in a minute.' }, 429, {
		...CORS_HEADERS,
		'Retry-After': '60',
	});
}

/** JSON with CORS, a strong ETag over the exact body, and 304 on a matching If-None-Match. */
async function jsonWithEtag(c: Ctx, payload: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
	const body = JSON.stringify(payload, null, 2);
	const etag = `"${(await sha256Hex(body)).slice(0, 32)}"`;
	const headers: Record<string, string> = {
		...CORS_HEADERS,
		...extraHeaders,
		ETag: etag,
		'Cache-Control': 'public, max-age=15',
	};
	const ifNoneMatch = c.req.header('if-none-match');
	if (ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

interface LedgerSnapshot {
	entries: LedgerEntry[];
	publicKey: string;
	verification: LedgerVerification;
}

// The last verification this isolate did. verifyLedger is pure, so the same entries and
// key always give the same answer. The head hash and key are the quick check; the full
// comparison means a past entry edited in D1 (same head, broken chain) is still caught.
let verified: { headHash: string; publicKey: string; entries: readonly LedgerEntry[]; result: LedgerVerification } | null = null;

function sameEntries(a: readonly LedgerEntry[], b: readonly LedgerEntry[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] as LedgerEntry;
		const y = b[i] as LedgerEntry;
		if (
			x.seq !== y.seq ||
			x.at !== y.at ||
			x.status !== y.status ||
			x.note !== y.note ||
			x.prevHash !== y.prevHash ||
			x.hash !== y.hash ||
			x.signature !== y.signature
		) {
			return false;
		}
	}
	return true;
}

/** verifyLedger, memoised per isolate by head hash plus public key (and the entries themselves). */
export async function verifyLedgerCached(entries: readonly LedgerEntry[], publicKey: string): Promise<LedgerVerification> {
	const headHash = entries.at(-1)?.hash ?? '';
	if (verified && verified.headHash === headHash && verified.publicKey === publicKey && sameEntries(verified.entries, entries)) {
		return { ...verified.result };
	}
	const result = await verifyLedger(entries, publicKey);
	verified = { headHash, publicKey, entries, result };
	return { ...result };
}

/** Forget the memoised verification (tests). */
export function resetLedgerVerificationCache(): void {
	verified = null;
}

async function loadSnapshot(env: Env): Promise<LedgerSnapshot> {
	const entries = await getLedger(env, { limit: LEDGER_SNAPSHOT_LIMIT });
	const publicKey = await getLedgerPublicKey(env);
	const verification = await verifyLedgerCached(entries, publicKey);
	return { entries, publicKey, verification };
}

function ledgerJson(c: Ctx, snapshot: LedgerSnapshot) {
	const head = snapshot.entries.at(-1) ?? null;
	const origin = originOf(c);
	return {
		name: 'The Dad Ledger',
		description: LEDGER_TAGLINE,
		algorithm: LEDGER_ALGORITHM,
		hashAlgorithm: LEDGER_HASH_ALGORITHM,
		publicKey: snapshot.publicKey,
		publicKeyEncoding: 'base64url (unpadded) of the raw 32-byte Ed25519 public key',
		publicKeyJwk: publicKeyJwk(snapshot.publicKey),
		canonicalisation: CANONICALISATION,
		verification: {
			...snapshot.verification,
			note: 'Checked by the server just now. Do not take its word for it: see /ledger for a verifier you can run yourself.',
		},
		count: snapshot.entries.length,
		head: head ? { seq: head.seq, hash: head.hash, status: head.status, at: head.at } : null,
		entries: snapshot.entries,
		links: {
			human: `${origin}/ledger`,
			wellKnown: `${origin}/.well-known/dad-ledger.json`,
			verifier: `${origin}/ledger/verify.mjs`,
		},
	};
}

function ledgerHeaders(snapshot: LedgerSnapshot): Record<string, string> {
	const head = snapshot.entries.at(-1);
	return {
		'X-Ledger-Verified': snapshot.verification.valid ? 'true' : 'false',
		...(head ? { 'X-Ledger-Head': head.hash } : {}),
	};
}

function statusBadge(status: Status) {
	return html`<span class="badge badge-${status}">${STATUS_COPY[status].word}</span>`;
}

function verificationNotice(verification: LedgerVerification) {
	if (verification.valid) {
		const n = verification.entries;
		return html`<div class="notice notice-ok" role="status">
			<p><strong>✅ Chain verified: ${n} ${n === 1 ? 'entry' : 'entries'}, all signatures valid.</strong></p>
			<p class="tiny muted">Checked on the server for this page load: every hash recomputed, every link followed, every
				Ed25519 signature checked. Then, please, check it yourself.</p>
		</div>`;
	}
	return html`<div class="notice notice-error" role="alert">
		<p><strong>❌ Chain broken at entry ${verification.brokenAt ?? 0}.</strong> ${verification.reason ?? ''}</p>
		<p class="tiny">Somebody has been editing history. This is precisely the situation the ledger exists to make
			embarrassing.</p>
	</div>`;
}

/** A <time> for an entry. A tampered, unparseable timestamp is shown as-is rather than taking the page down. */
function entryTime(at: string) {
	if (Number.isNaN(Date.parse(at))) return html`<span class="mono">${at}</span>`;
	return html`<time datetime="${at}">${formatLondon(at, { second: '2-digit' })}</time>`;
}

function entryRow(entry: LedgerEntry) {
	return html`<tr id="seq-${entry.seq}">
		<td class="mono">${entry.seq}</td>
		<td>${entryTime(entry.at)}</td>
		<td>${statusBadge(entry.status)}</td>
		<td>${entry.note}</td>
		<td><code title="${entry.hash}">${shorten(entry.hash)}</code></td>
		<td><code title="${entry.signature}">${shorten(entry.signature)}</code></td>
	</tr>`;
}

const WRAP = 'white-space:pre-wrap;overflow-wrap:anywhere';

function renderLedgerBody(c: Ctx, snapshot: LedgerSnapshot) {
	const { entries, publicKey, verification } = snapshot;
	const head = entries.at(-1);
	const siteStatus = c.get('state').status;
	const origin = originOf(c);
	const mismatch = head && verification.valid && head.status !== siteStatus;

	return html`<div class="wrap section stack">
	<header class="page-head">
		<p class="kicker">Exhibit A · Cryptographic proof</p>
		<h1>The Dad Ledger</h1>
		<p class="lede">${LEDGER_TAGLINE}</p>
	</header>

	${verificationNotice(verification)}
	${
		mismatch
			? html`<div class="notice" role="status"><p>The site currently says <strong>${STATUS_COPY[siteStatus].word}</strong>
				but the newest ledger entry says <strong>${STATUS_COPY[head.status].word}</strong>. The ledger is written a
				moment after the status changes, so this should last milliseconds. If it doesn't, something has gone wrong
				and the ledger is the one keeping receipts.</p></div>`
			: ''
	}

	<div class="stats">
		<div class="stat"><span class="stat-value">${entries.length}</span> <span class="stat-label">${entries.length === 1 ? 'entry' : 'entries'}</span></div>
		<div class="stat"><span class="stat-value">${head ? STATUS_COPY[head.status].word : '?'}</span> <span class="stat-label">according to the ledger</span></div>
		<div class="stat"><span class="stat-value">${LEDGER_ALGORITHM}</span> <span class="stat-label">signatures</span></div>
		<div class="stat"><span class="stat-value mono">${head ? shorten(head.hash, 8) : '…'}</span> <span class="stat-label">head hash</span></div>
	</div>

	<section class="stack" aria-labelledby="ledger-entries">
		<h2 id="ledger-entries">Entries</h2>
		${
			entries.length
				? html`<div class="table-wrap">
			<table class="table">
				<caption class="tiny muted">Oldest first. Times are UK time. Hover a hash or signature for the full value, or
					get the lot from <a href="/api/ledger">/api/ledger</a>.</caption>
				<thead><tr>
					<th scope="col">Seq</th><th scope="col">Time</th><th scope="col">Status</th><th scope="col">Note</th>
					<th scope="col">Hash</th><th scope="col">Signature</th>
				</tr></thead>
				<tbody>${entries.map(entryRow)}</tbody>
			</table>
		</div>`
				: html`<p class="empty">The ledger is empty, which should be impossible. Even the genesis entry has gone missing.</p>`
		}
	</section>

	<section class="stack" aria-labelledby="ledger-key">
		<h2 id="ledger-key">The public key</h2>
		<p>Every entry is signed with this ${LEDGER_ALGORITHM} key. Write it down. Screenshot it. Have it engraved on
			something. If it ever changes, somebody has rewritten the whole ledger and you should ask pointed questions.</p>
		<pre class="code" style="${WRAP}"><code>${publicKey}</code></pre>
		<p class="tiny muted">Raw 32-byte public key, unpadded base64url. As a JWK:
			<code style="${WRAP}">${JSON.stringify(publicKeyJwk(publicKey))}</code>. Machines and the suspicious can also
			fetch it from <a href="/.well-known/dad-ledger.json">/.well-known/dad-ledger.json</a>.</p>
	</section>

	<section class="stack" aria-labelledby="ledger-how">
		<h2 id="ledger-how">How it works</h2>
		<ol class="stack">
			<li>Each entry is flattened into one canonical string: <code>${CANONICAL_FORMAT}</code>.</li>
			<li>The <strong>hash</strong> is the ${LEDGER_HASH_ALGORITHM} of that string's UTF-8 bytes, in lowercase hex.</li>
			<li>The <strong>signature</strong> is ${LEDGER_ALGORITHM} over the UTF-8 bytes of the hash's hex string, in
				unpadded base64url.</li>
			<li>Each entry's <code>prevHash</code> is the previous entry's hash, so changing anything in the past breaks
				every link after it. The genesis entry points at 64 zeros, because something has to go first.</li>
		</ol>
		${
			head
				? html`<p>Here is the newest entry (seq ${head.seq}), taken apart:</p>
		<pre class="code" style="${WRAP}"><code>canonical  ${canonicalString(head)}
sha-256    ${head.hash}
signature  ${head.signature}</code></pre>`
				: ''
		}
	</section>

	<section class="stack" aria-labelledby="ledger-verify">
		<h2 id="ledger-verify">Verify it yourself</h2>
		<p>Don't trust this page; it would say that. Save this as <code>verify-dad-ledger.mjs</code> and run
			<code>node verify-dad-ledger.mjs</code> (Node 22 or newer, no dependencies). It also works pasted into a
			modern browser console.</p>
		<pre class="code"><code>${ledgerVerifierScript(origin, publicKey)}</code></pre>
		<p class="tiny muted">Or, if you trust us to write the verifier for you (which rather defeats the point):
			<code style="${WRAP}">curl -s ${origin}/ledger/verify.mjs | node --input-type=module</code></p>
	</section>

	<section class="stack" aria-labelledby="ledger-faq">
		<h2 id="ledger-faq">Questions nobody asked</h2>
		<details>
			<summary>Is this a blockchain?</summary>
			<p>No. It is one database, one signer, no mining, no tokens and no measurable carbon footprint. It is a hash
				chain with signatures, which is what a blockchain is once it has grown up and got a proper job.</p>
		</details>
		<details>
			<summary>What does "tamper-evident" mean?</summary>
			<p>It doesn't stop anybody editing the database. It makes it obvious: change one character of one old entry
				and its hash stops matching, the next entry's link breaks, and this page turns red.</p>
		</details>
		<details>
			<summary>Couldn't ${DAD} just rewrite the whole thing?</summary>
			<p>With the private key, the chain could be rebuilt from scratch, yes. You would notice, because the history
				you saved earlier would no longer match and, if the key were replaced, so would the public key above. This
				is why you pinned it. You did pin it.</p>
		</details>
		<details>
			<summary>Why?</summary>
			<p>Because "trust me" is not a cryptographic primitive, and because a yes/no question deserves an audit trail.</p>
		</details>
	</section>
</div>`;
}

// ── /ledger ─────────────────────────────────────────────────────────────────

ledgerRoutes.get('/ledger', async (c) => {
	if (wantsJson(c)) {
		const limited = await apiLimit(c);
		if (limited) return limited;
		const snapshot = await loadSnapshot(c.env);
		return jsonWithEtag(c, ledgerJson(c, snapshot), { ...ledgerHeaders(snapshot), Vary: 'Accept' });
	}
	const snapshot = await loadSnapshot(c.env);
	c.header('Vary', 'Accept');
	return renderPage(c, {
		title: 'The Dad Ledger',
		description: LEDGER_TAGLINE,
		path: '/ledger',
		head: html`<link rel="alternate" type="application/json" title="The Dad Ledger (JSON)" href="/api/ledger">`,
		body: renderLedgerBody(c, snapshot),
	});
});

ledgerRoutes.get('/ledger/verify.mjs', async (c) => {
	const publicKey = await getLedgerPublicKey(c.env);
	return c.body(ledgerVerifierScript(originOf(c), publicKey), 200, {
		'Content-Type': 'text/javascript; charset=utf-8',
		'Content-Disposition': 'inline; filename="verify-dad-ledger.mjs"',
		'Cache-Control': 'public, max-age=300',
		'Access-Control-Allow-Origin': '*',
	});
});

// ── /api/ledger ─────────────────────────────────────────────────────────────

ledgerRoutes.options('/api/ledger', (c) => c.body(null, 204, CORS_HEADERS));

ledgerRoutes.get('/api/ledger', async (c) => {
	const limited = await apiLimit(c);
	if (limited) return limited;
	const snapshot = await loadSnapshot(c.env);
	return jsonWithEtag(c, ledgerJson(c, snapshot), ledgerHeaders(snapshot));
});

// ── /.well-known/dad-ledger.json ────────────────────────────────────────────

ledgerRoutes.options('/.well-known/dad-ledger.json', (c) => c.body(null, 204, CORS_HEADERS));

ledgerRoutes.get('/.well-known/dad-ledger.json', async (c) => {
	const limited = await apiLimit(c);
	if (limited) return limited;
	const summary = await getLedgerSummary(c.env);
	const origin = originOf(c);
	return jsonWithEtag(
		c,
		{
			ledger: 'The Dad Ledger',
			algorithm: LEDGER_ALGORITHM,
			hashAlgorithm: LEDGER_HASH_ALGORITHM,
			publicKey: summary.publicKey,
			publicKeyEncoding: 'base64url (unpadded) of the raw 32-byte Ed25519 public key',
			publicKeyJwk: publicKeyJwk(summary.publicKey),
			headHash: summary.head?.hash ?? null,
			headSeq: summary.head?.seq ?? null,
			headStatus: summary.head?.status ?? null,
			headAt: summary.head?.at ?? null,
			count: summary.count,
			canonicalisation: CANONICAL_FORMAT,
			entries: `${origin}/api/ledger`,
			human: `${origin}/ledger`,
		},
		summary.head ? { 'X-Ledger-Head': summary.head.hash } : {},
	);
});

// ── /og.png ─────────────────────────────────────────────────────────────────

/**
 * og:image URLs carry `?v=<status>-<ms>` (lib/layout.ts ogImageUrl), and a given
 * version always gets the same pre-rendered card, so those can be cached for good.
 * A bare /og.png follows the current status, so it only gets a few minutes.
 */
const OG_VERSIONED_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const OG_CURRENT_CACHE_CONTROL = 'public, max-age=300';

ledgerRoutes.get('/og.png', async (c) => {
	const versioned = ogVersionStatus(c.req.query('v'));
	const status = versioned ?? c.get('state').status;

	// Serve the pre-rendered card from assets, passing conditional headers through.
	const conditional = new Headers();
	for (const name of ['if-none-match', 'if-modified-since']) {
		const value = c.req.header(name);
		if (value) conditional.set(name, value);
	}
	const asset = await c.env.ASSETS.fetch(new URL(ogCardPath(status), c.req.url), { headers: conditional });
	if (asset.ok || asset.status === 304) {
		const res = new Response(asset.body, asset);
		res.headers.set('Cache-Control', versioned ? OG_VERSIONED_CACHE_CONTROL : OG_CURRENT_CACHE_CONTROL);
		res.headers.set('X-Og-Source', 'static');
		return res;
	}
	return c.text('No preview image is available yet.', 404, { 'Cache-Control': 'no-store' });
});
