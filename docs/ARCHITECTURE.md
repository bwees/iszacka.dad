# Architecture & module contracts

**iszacka.dad** answers one question, "Is Zack a dad?", with absurd overengineering. It's one
Cloudflare Worker (TypeScript, [Hono](https://hono.dev) router, server-rendered HTML via
`hono/html`, no frontend framework) plus static assets in `public/`.

## Hard rules (every module)

- **No AI calls anywhere.** No Workers AI, no external LLM APIs.
- **No personal data.** The site only knows: status (`no` / `soon` / `yes`), when it changed, and the
  due date. Never store or show baby names, weights, photos, locations, hospitals. The repo is
  **public**: no secrets, no personal info, no real email addresses in code or tests.
- **No gendered pronouns** for anyone (Zack, Jess, the baby). Use names / "the baby".
- **Escape everything.** Build HTML with `html\`...\`` from `hono/html` (auto-escapes). Never pass
  user input to `raw()`.
- **CSP blocks inline scripts.** Put JS in `public/*.js` files. Pass data via `data-*` attributes
  or `<script type="application/json">`. Inline `style=` attributes are allowed.
- **Progressive enhancement.** Every form works without JS: a normal `POST` that renders a result
  page via `renderPage()`. If `wantsJson(c)` (Accept: application/json), return JSON instead.
- **Abuse protection on every public write:** `allow(c.env.RL_FORMS, \`<feature>:${clientKey(c)}\`)`
  (`clientKey` is the client IP, with IPv6 collapsed to its /64),
  then `verifyTurnstile(c.env, body['cf-turnstile-response'], clientIp(c))` (a no-op when
  Turnstile isn't configured), length limits, and trimming. Pages with a form render
  `turnstileWidget(c.env)` inside the form and pass `turnstile: true` to `renderPage`.
- **Time zone:** Europe/London for "days", using `src/lib/time.ts`. Store ISO UTC.
- **Delivery functions never throw.** They return `DeliveryResult`.

## Foundation (read-only for agents)

`src/index.ts`, `src/types.ts`, `src/env.d.ts`, `src/lib/{state,updates,live,security,deliveries,site,time}.ts`,
`wrangler.toml`, `package.json`, `migrations/0001_init.sql`, `worker-configuration.d.ts`.
Need a change there? Don't make it. Report it in your result as a foundation request.

Key APIs:

| Module | Exports |
|---|---|
| `lib/state.ts` | `getState(env)`, `setStatus(env, status, {note})` (history + ledger + update + broadcast + workflow), `setDueDate(env, ymd\|null)`, `getSetting/setSetting/getOrCreateSetting(env, key, …)`, `getStatusHistory(env)` |
| `lib/updates.ts` | `createUpdate(env, {kind,title,body,status,audience})` (stores, broadcasts, starts `AnnounceWorkflow` unless audience `none`), `startAnnouncement(env, id, attempt)`, `getUpdate`, `listUpdates(env,{limit,beforeId,kinds})`, `markNotified` |
| `lib/live.ts` | `broadcast(env, LiveMessage)`, `liveStats(env)`, `waitingRoom(env)` |
| `lib/security.ts` | `randomToken`, `sha256Hex`, `timingSafeEqual`, `hashIdentifier(env, value)` (salted; use for IPs/emails), `clientIp(c)`, `clientKey(c)` (rate-limit key: IPv6 → /64), `dnsAnswerName(env)` is in `lib/site.ts`, `wantsJson(c)`, `isValidEmail`, `allow(limiter, key)`, `turnstileEnabled/turnstileWidget/verifyTurnstile`, `base64UrlEncode/Decode` |
| `lib/deliveries.ts` | `deliveredTargets(env, updateId, channel, ids)`, `recordDelivery(...)`, `deliverySummary(env, updateId)` |
| `lib/site.ts` | `SITE_NAME`, `DAD`, `PARENTS`, `DOMAIN`, `siteUrl(env)`, `STATUS_COPY[status]` (`word`, `short`, `headline`, `sentence`, `emoji`, `header`, `ledgerNote`) |
| `lib/time.ts` | `TZ`, `nowIso`, `londonDate`, `londonHour`, `isYmd`, `daysBetween`, `addDays`, `formatLondon`, `formatLondonDate` |
| `lib/layout.ts` | `renderPage(c, {title, description, body, path, head, scripts, turnstile, noindex, status, bodyClass, bare})` (owned by frontend; the signature is a contract) |

`c.get('state')` holds the `SiteState` for the current request. Root middleware also counts checks,
serves curl ASCII on `/`, redirects `www.`, and sets the `X-Is-Zack-A-Dad`, `Server-Timing`, CSP and
security headers. A route can override a default header by setting it first. `/embed` needs
`frame-ancestors *`.

Bindings (`Env`): `DB` (D1), `WAITING_ROOM` (DO), `ANNOUNCE` (Workflow), `BROWSER` (Browser
Rendering), `CF_VERSION` (version metadata), `RL_FORMS` 10/min, `RL_API` 120/min, `RL_EMAIL` 5/min,
`ASSETS`. Vars: `ENVIRONMENT`, `SITE_URL`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_FROM`,
`EMAIL_DAILY_LIMIT`, `DNS_RECORD_NAME`, `ZONE_NAME` (preview also has Turnstile's test keys and an
admin password as vars). Secrets: `ADMIN_PASSWORD`, `RESEND_API_KEY?`, `RESEND_WEBHOOK_SECRET?`,
`TURNSTILE_SITE_KEY?`, `TURNSTILE_SECRET_KEY?`, `DNS_API_TOKEN?`, `DNS_ZONE_ID?`. The deploy workflow
syncs `ADMIN_PASSWORD`, `RESEND_API_KEY` and the DNS ones from GitHub; the Setup workflow
(`scripts/setup-cloudflare.sh`) stores `RESEND_WEBHOOK_SECRET` and both Turnstile keys. Email goes
through the Resend API, both ways (see "Email (Resend)" below); there is no email binding.

## Status model & notification flow

`no` → `soon` (labour started) → `yes`. Admin flips it. `setStatus` writes settings + `status_history`,
calls `appendLedger`, broadcasts `{type:'state'}`, and creates an update with kind `status` and
audience `all`. `createUpdate` broadcasts `{type:'update'}` and starts `AnnounceWorkflow` with
`{updateId}`.

`AnnounceWorkflow` (email agent):
1. Load the update.
2. For `status` updates, wait a 60s grace period, then skip notifying if the status has changed
   again (undo window). The reason is recorded in settings `superseded:<id>` so `/updates/:id`
   can say the update was never announced.
3. Push, then webhooks, each in its own `step.do` per batch of 25 by id cursor. Each batch
   filters out recipients already in `deliveries` and records every attempt.
4. On `status` updates, `updateAnswerRecord` (DNS, from fresh state).
5. `renderOgImage` (OG).
6. Email, last, because it's the only channel with a quota. When the day's quota runs out
   mid-batch, real news (audience `all`) `step.sleepUntil`s the next 00:00 UTC, checks the update
   isn't stale, and carries on from the same cursor. Daily posts stop at `DAILY_EMAIL_RESERVE`
   and are dropped rather than sent tomorrow. Email waiting on the quota never delays push,
   webhooks or DNS.
7. `markNotified`.

Audience mapping:

| Audience | Email | Push | Webhooks |
|---|---|---|---|
| `all` | confirmed subscribers, both frequencies | all active | all active |
| `daily` | `daily` subscribers only | none | `daily` hooks only |
| `none` | no-one | no-one | no-one |

Daily cron (09:00 UTC, email agent) creates a kind `daily` update with audience `daily`:

- Before `yes`: "Day N: still no." with due/overdue info.
- After `yes`: "Dad day N" for 7 days, then a final "daily service concluded" post, then stops.

It also purges unconfirmed subscribers older than 7 days, unsubscribed ones after 30 days, and
`resend_events` rows older than 30 days. If the email quota is down to its last 10
(`DAILY_EMAIL_RESERVE`), it skips the day's post rather than spend the reserve kept for real news.

## Email (Resend)

All email goes through [Resend](https://resend.com) with `RESEND_API_KEY`; with no key, every send
fails cleanly (`no_api_key`) and nothing else breaks.

- **Sending** (`src/notify/email.ts`): `sendEmail()` posts to `POST /emails`, one email per call, with
  an `Idempotency-Key` per logical send (update + subscriber, the inbound email's id, or a random
  key for one-offs) and a `User-Agent` (Resend
  refuses requests without one). From `EMAIL_FROM_NAME <EMAIL_FROM>`; subscriber emails carry
  `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058 one-click). Rate limits, 409s and 5xx
  are retried once in-process; validation errors are permanent; suppressed recipients are
  unsubscribed.
- **Quota**: Resend's free plan allows 100 emails a day (00:00 to 24:00 UTC) and 3,000 a month,
  and received emails count too. The `email_sends` table (`migrations/0003_email.sql`) counts
  every send and every received email per UTC day; `EMAIL_DAILY_LIMIT` (90, leaving headroom)
  caps it. At the cap, sends fail with `daily_quota_exceeded` without calling Resend,
  announcements sleep until midnight UTC, the daily post is skipped once only the reserve is left,
  and inbound mail is recorded but not replied to.
- **Receiving**: Resend receives `*@iszacka.dad` (the apex MX record points at Resend) and posts an
  `email.received` event to `POST /api/resend/webhook` (`src/routes/resend-webhook.ts`). The route
  verifies the Svix signature with `RESEND_WEBHOOK_SECRET` (503 if unset, 401 if wrong or older
  than 5 minutes), records the `svix-id` in `resend_events` (`migrations/0011_resend.sql`) so a
  retried delivery is acknowledged with `{duplicate: true}` but never handled twice, answers 200
  quickly and does the rest of the work in `waitUntil`:
  - `email.received`: fetch the message from `GET /emails/receiving/{id}` *before* answering
    (8-second timeout; Svix waits 15). If that fails transiently (429, 5xx, network error,
    timeout), the `svix-id` row is deleted again and the route answers 503, so Resend redelivers
    on its retry schedule (5s, 5m, 30m, ...) and the redelivery is handled rather than taken for
    a duplicate. A permanent failure (404 or other 4xx, no `email_id`, no `RESEND_API_KEY`) keeps
    the claim and answers 200. Once the claim is kept, the email is counted against the quota and
    `handleInboundEmail` (`src/email-handler.ts`) runs in `waitUntil`. The sender is the
    webhook's bare `data.from`, reduced to a lower-cased address, and only ever stored hashed
    (`inbound_emails`). Loop protection skips bounces (null Return-Path, mailer-daemon),
    auto-replies (`Auto-Submitted`, `Precedence`, `X-Auto-Response-Suppress`), mailing lists
    (`List-Id`), no-reply senders and our own domain, and nothing is answered unless Resend's
    `authentication` result says DKIM or DMARC passed (so spoofed senders can't use the
    auto-reply to spam someone); replies are capped per sender by `RL_EMAIL` and 20 a day. A subject containing
    "guess" enters the baby pool (`parseGuessText` → `submitGuess`); anything else gets the status
    auto-reply. Replies come from `EMAIL_REPLY_FROM` with `In-Reply-To`/`References`.
  - Pool names come only from an explicit `Name:` line. The display name on the sender's address
    is never used (it would end up on a public page); without a `Name:` line the entry is
    "Anonymous emailer", and the reply says so.
  - `email.bounced` (permanent) and `email.complained`: unsubscribe the matching subscriber.
  - Anything else: 200, ignored.

## Live protocol (`/ws` WebSocket, `/api/stream` SSE: realtime agent server, frontend client)

Server → client `LiveMessage` (see `src/types.ts`): `hello` (on connect: state, viewers, vibes,
checks, reloadNonce), `state`, `update`, `viewers`, `vibes` (`{vibes, emoji}`), `checks`, `reload`.
Client → server: `{type:'vibe', emoji}` (rate-limited per socket), `{type:'ping'}`. The client
reconnects with backoff. On `reload` with a nonce different from the one it booted with, it does
`location.reload()`.

## Ownership (agents edit only their files; new files only under their own names/prefixes)

| Agent | Files | Features |
|---|---|---|
| frontend | `src/lib/layout.ts`, `src/routes/pages.ts`, `src/lib/i18n.ts`, `src/lib/og-card.ts`, `public/styles.css`, `public/app.js`, `public/favicon-*.svg`, `public/icons/*`, `public/og/*`, `public/fonts/*`, `public/_headers`, `scripts/og-*`, `test/frontend-*` | design system; home; /updates; /everything; /og/card; 404; i18n; easter eggs |
| feeds | `src/routes/feeds.ts`, `src/routes/api.ts`, `src/routes/mcp.ts`, `src/lib/feeds.ts`, `src/lib/ascii.ts`, `public/embed.js`, `test/feeds-*` | RSS/Atom/JSON/iCal, badge, embed, API + docs + OpenAPI, /api/dad 425/201, MCP, llms/humans/security/robots/sitemap, curl ASCII |
| email | `src/routes/subscribe.ts`, `src/routes/resend-webhook.ts`, `src/notify/email.ts`, `src/workflows/announce.ts`, `src/cron.ts`, `src/email-handler.ts`, `src/lib/daily.ts`, `test/email-*`, `test/resend-*` | email updates via Resend (double opt-in, one-click unsubscribe, quota), daily NO, AnnounceWorkflow, cron, Resend webhook, inbound email auto-reply + email guesses |
| push | `src/routes/push.ts`, `src/routes/webhooks.ts`, `src/notify/push.ts`, `src/notify/webhooks.ts`, `src/notify/dns.ts`, `src/lib/vapid.ts`, `public/sw.js`, `public/push.js`, `public/manifest.webmanifest`, `public/offline.html`, `test/push-*` | web push, PWA + offline, webhooks, DNS TXT |
| realtime | `src/do/waiting-room.ts`, `src/routes/live.ts`, `src/lib/counters.ts`, `test/realtime-*` | WebSockets, viewers, vibes, SSE, check counters, /stats |
| admin | `src/lib/admin.ts`, `src/routes/admin.ts`, `public/admin.js`, `test/admin-*` | admin auth + dashboard |
| community | `src/lib/community.ts`, `src/routes/community.ts`, `test/community-*` | readiness checklist, congratulations wall, name suggestions (+ their /admin pages) |
| fun | `src/lib/pool.ts`, `src/lib/forecast.ts`, `src/lib/fruit.ts`, `src/routes/fun.ts`, `test/fun-*` | baby pool, status page, certificate, fridge poster, forecast + fruit maths |
| ledger | `src/lib/ledger.ts`, `src/lib/og.ts`, `src/routes/ledger.ts`, `test/ledger-*` | Dad Ledger, live OG image |
| infra | `.github/**`, `scripts/setup-cloudflare.sh`, `scripts/smoke.sh`, `README.md`, `CLAUDE.md`, `docs/SETUP.md` | CI/CD, previews, one-time Cloudflare setup, smoke tests, docs |

Reserved migration files, if you need schema additions (prefer not to): `0002_realtime`,
`0003_email` (used: `email_sends`), `0004_push`, `0005_admin`, `0006_community`, `0007_fun`,
`0008_ledger`, `0009_feeds`, `0010_frontend`, `0011_resend` (used: `resend_events`).

## Cross-module contracts (stubs exist; keep exported signatures exactly)

- `lib/counters.ts`: `recordCheck(env, request)`, `getCheckTotal(env)`
- `do/waiting-room.ts`: class `WaitingRoom` with `fetch()` (ws + sse), RPC `broadcast(msg)`, RPC `stats()`
- `lib/ledger.ts`: `appendLedger(env, {status, note})`, `getLedger(env, {limit})`, type `LedgerEntry`
- `lib/og.ts`: `renderOgImage(env) → DeliveryResult`. Stores PNG in `og_images` key `current`. `/og.png`
  serves it, falling back to static `/og/<status>.png`.
- `lib/og-card.ts`: `renderOgCardHtml({state, checks, today}) → string` (self-contained HTML, 1200×630)
- `notify/push.ts`: `listPushTargets(env, afterId, limit)`, `deliverPush(env, sub, update)`
- `notify/webhooks.ts`: `listWebhookTargets(env, audience, afterId, limit)`, `deliverWebhook(env, hook, update, state)`
- `notify/dns.ts`: `updateAnswerRecord(env, state)`
- `lib/pool.ts`: `submitGuess(env, {name, guessAt, source, ipHash})`, `parseGuessText(text, nowIso)`
- `lib/forecast.ts`: `dadForecast(dueDate, today, status) → ForecastDay[]`
- `lib/fruit.ts`: `babySize(dueDate, today) → BabySize | null`
- `lib/community.ts`: `getReadiness(env) → Readiness`
- `lib/admin.ts`: `requireAdmin` middleware, `isAdmin(c)`, `renderAdminPage(c, {title, body, status})`
- `lib/i18n.ts`: `TRANSLATIONS`, `answerInLanguage(acceptLanguage, status)`
- `lib/ascii.ts`: `isTerminalClient(ua)`, `renderAscii(state, {checks})`
- Fragments for `/everything`: `emailSignupForm(c)` (`routes/subscribe.ts`), `pushWidget(c)` (needs
  `/push.js`) (`routes/push.ts`), `webhookForm(c)` (`routes/webhooks.ts`)

## URL map

| Owner | URLs |
|---|---|
| frontend | `/`, `/updates`, `/updates/:id`, `/everything`, `/og/card?status=`; static `/styles.css`, `/app.js`, `/favicon-{no,soon,yes}.svg`, `/icons/{icon-192,icon-512,maskable-512,apple-touch-icon}.png`, `/og/{no,soon,yes}.png` |
| feeds | `/feed.xml` (+`/rss.xml`), `/atom.xml`, `/feed.json`, `/calendar.ics`, `/badge.svg`, `/embed`, `/embed.js`, `/llms.txt`, `/humans.txt`, `/.well-known/security.txt`, `/robots.txt`, `/sitemap.xml`, `/api`, `/api/status` (+`.json`), `/api/status.txt`, `/api/history`, `/api/updates`, `/api/dad`, `/openapi.json`, `/mcp` |
| realtime | `/ws`, `/api/stream`, `/api/live`, `/stats` |
| email | `/subscribe` (GET/POST), `/confirm/:token`, `/unsubscribe/:token` (GET/POST one-click), `/api/resend/webhook` (POST, Svix-signed) |
| push | `/api/push/key`, `/api/push/subscribe`, `/api/push/unsubscribe`, `/push.js`, `/sw.js`, `/manifest.webmanifest`, `/offline.html`, `/webhooks` (POST), `/webhooks/:token`, `/webhooks/:token/delete`, `/webhooks/:token/test` |
| admin | `/admin`, `/admin/login`, `/admin/logout`, `/admin/status`, `/admin/due-date`, `/admin/reload`, `/admin/test-email`, `/admin/updates/:id/rerun`, `/admin/og/render`, `/admin/dns/sync` |
| community | `/ready`, `/wall`, `/names`, `/names/:id/vote`, `/admin/checklist`, `/admin/wall`, `/admin/names` |
| fun | `/pool`, `/status`, `/certificate`, `/poster`, `/admin/pool` |
| ledger | `/ledger`, `/api/ledger`, `/.well-known/dad-ledger.json`, `/og.png` |

Email addresses: `stork@iszacka.dad` sends notifications and `answer@iszacka.dad` sends
auto-replies, both through Resend. Resend receives any `*@iszacka.dad`, and the Worker auto-replies;
advertise `ask@iszacka.dad`. To enter the pool by email, send a subject containing
"guess" with a body like `14 Nov 15:30` (and optionally `Name: Alex`).

## UI kit (frontend styles these; everyone else uses only these classes + semantic HTML)

- Layout: `.wrap` (centred container), `.section`, `.stack` (vertical rhythm), `.cluster` (wrapping row), `.grid` (auto-fit cards), `.page-head` (h1 + `.lede`)
- Text: `.kicker` (small caps label), `.lede`, `.muted`, `.tiny`, `.mono`, `.big-number`
- Components:
  - `.card` (+ `.card-title`)
  - `.btn`, with variants `.btn-primary`, `.btn-danger`, `.btn-ghost`
  - `.form` and `.field` (wraps a label + input/select/textarea), `.field-row`, `.hint`
  - `.notice`, with `.notice-ok` / `.notice-error`
  - `.table` (wrap in `.table-wrap` for scrolling)
  - `.stat` (`.stat-value`, `.stat-label`) inside `.stats`
  - `.badge`, with `.badge-no` / `.badge-soon` / `.badge-yes`
  - `.pill`
  - `pre.code` / `code`
  - `.meter` (`<div class="meter"><span style="width:40%"></span></div>`)
  - `.bars` (status page uptime bars: `<span class="bar bar-no">`)
  - `.empty` (empty state)
- Admin pages: same kit, inside `renderAdminPage`.
- `[data-status]` on `<html>`/`<body>` is `no`/`soon`/`yes` for state-specific theming.

## Local development & verification

```bash
npm run db:migrate:local && npm run dev        # http://localhost:8787 (admin password: dev)
npx tsc --noEmit && npx vitest run
```

Parallel agents: run your own dev server on your own port with your own state dir, and kill it when
done.

```bash
npx wrangler d1 migrations apply iszackadad --local --persist-to .wrangler/agent-<name>
npx wrangler dev --port <port> --persist-to .wrangler/agent-<name>
```
