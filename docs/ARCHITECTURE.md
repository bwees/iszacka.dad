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
- **10 ms of CPU.** Production runs on Workers Free: see [CPU budget](#cpu-budget-workers-free).

## Foundation (read-only for agents)

`src/index.ts`, `src/types.ts`, `src/env.d.ts`, `src/lib/{state,updates,live,security,deliveries,site,time}.ts`,
`wrangler.toml`, `package.json`, `migrations/0001_init.sql`, `worker-configuration.d.ts`.
Need a change there? Don't make it. Report it in your result as a foundation request.

Key APIs:

| Module | Exports |
|---|---|
| `lib/state.ts` | `getState(env)`, `setStatus(env, status, {note})` (one D1 batch: settings + history + update; then starts `AnnounceWorkflow` with `publish`, which broadcasts, signs the ledger and updates DNS), `setDueDate(env, ymd\|null)`, `getSetting/setSetting/getOrCreateSetting(env, key, …)`, `getStatusHistory(env)` |
| `lib/updates.ts` | `createUpdate(env, {kind,title,body,status,audience})` (stores, starts `AnnounceWorkflow` with `publish`, whose first step broadcasts it; broadcasts inline only for audience `none` or if the workflow can't start), `insertUpdateStatement`, `launchAnnouncement`, `startAnnouncement(env, id, attempt)` (admin re-runs: no re-broadcast), `getUpdate`, `listUpdates(env,{limit,beforeId,kinds})`, `markNotified` |
| `lib/live.ts` | `broadcast(env, LiveMessage)`, `liveSnapshot(env)` (viewers, vibes, checks and reload nonce in one RPC), `liveStats(env)`, `waitingRoom(env)` |
| `lib/security.ts` | `randomToken`, `sha256Hex`, `timingSafeEqual`, `hashIdentifier(env, value)` (salted, salt cached per isolate; use for IPs/emails), `clientIp(c)`, `clientKey(c)` (rate-limit key: IPv6 → /64), `dnsAnswerName(env)` is in `lib/site.ts`, `wantsJson(c)`, `isValidEmail`, `allow(limiter, key)`, `turnstileEnabled/turnstileWidget/verifyTurnstile`, `base64UrlEncode/Decode` |
| `lib/deliveries.ts` | `deliveredTargets(env, updateId, channel, ids)`, `recordDelivery(...)`, `deliverySummary(env, updateId)` |
| `lib/site.ts` | `SITE_NAME`, `DAD`, `PARENTS`, `DOMAIN`, `siteUrl(env)`, `STATUS_COPY[status]` (`word`, `short`, `headline`, `sentence`, `emoji`, `header`, `ledgerNote`) |
| `lib/time.ts` | `TZ`, `nowIso`, `londonDate`, `londonHour`, `isYmd`, `daysBetween`, `addDays`, `formatLondon`, `formatLondonDate` (all without Intl for the formats in use), `formatNumber` (en-GB grouping without Intl), `formatWeekday`, `formatDayMonth`, `formatWeekdayDayMonth`, `dateTimeFormat`/`numberFormat` (memoised Intl, for anything else) |
| `lib/layout.ts` | `renderPage(c, {title, description, body, path, head, scripts, turnstile, noindex, status, bodyClass, bare})` (owned by frontend; the signature is a contract) |

`c.get('state')` holds the `SiteState` for the current request, except on the routes in
`STATELESS_PATHS` (`src/index.ts`: `/api/resend/webhook`, `/api/push/key`, `/api/push/subscribe`,
`/api/push/unsubscribe`, `/robots.txt`, `/.well-known/security.txt`) and WebSocket upgrades to
`/ws`, which skip the state read and get no `X-Is-Zack-A-Dad` header; call `getState(env)` there if
you need it. Root middleware also counts checks (one fire-and-forget RPC to the WaitingRoom),
serves curl ASCII on `/`, redirects `www.`, and sets the `X-Is-Zack-A-Dad`, `Server-Timing`, CSP and
security headers. A route can override a default header by setting it first. `/embed` needs
`frame-ancestors *`.

Bindings (`Env`): `DB` (D1), `WAITING_ROOM` (DO), `ANNOUNCE` (Workflow `iszacka-dad-announce`),
`INBOUND` (Workflow `iszacka-dad-inbound`), `DAILY` (Workflow `iszacka-dad-daily`), `CF_VERSION`
(version metadata), `RL_FORMS` 10/min, `RL_API` 120/min, `RL_EMAIL` 5/min, `ASSETS`. Previews
suffix the Workflow names with `-preview`. Vars: `ENVIRONMENT`, `SITE_URL`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_FROM`,
`EMAIL_DAILY_LIMIT`, `DNS_RECORD_NAME`, `ZONE_NAME` (preview also has Turnstile's test keys and an
admin password as vars). Secrets: `ADMIN_PASSWORD`, `RESEND_API_KEY?`, `RESEND_WEBHOOK_SECRET?`,
`TURNSTILE_SITE_KEY?`, `TURNSTILE_SECRET_KEY?`, `DNS_API_TOKEN?`, `DNS_ZONE_ID?`. The deploy workflow
syncs `ADMIN_PASSWORD`, `RESEND_API_KEY` and the DNS ones from GitHub; the Setup workflow
(`scripts/setup-cloudflare.sh`) stores `RESEND_WEBHOOK_SECRET` and both Turnstile keys. Email goes
through the Resend API, both ways (see "Email (Resend)" below); there is no email binding.

## Status model & notification flow

`no` → `soon` (labour started) → `yes`. Admin flips it. `setStatus` writes the settings, the
`status_history` row and an update (kind `status`, audience `all`) in one D1 batch, then starts
`AnnounceWorkflow` with `{updateId, publish: true, ledgerNote}` and returns. `createUpdate` does the
same for other updates (`{updateId, publish: true}`). If the workflow can't be started, both
broadcast inline so open browsers still flip. Workflow instance ids are `update-<id>` (admin
re-runs: `update-<id>-r<n>`, without `publish`).

`AnnounceWorkflow` (`src/workflows/announce.ts`), one `step.do` per item:
1. Load the update.
2. Only when `params.publish` is set (so admin re-runs never repeat them): broadcast the fresh
   state from D1 (status updates), broadcast `{type:'update'}`, and append the change to the Dad
   Ledger (skipped if a newer status update exists or the ledger head already shows this status,
   so retries and quick double flips stay in order).
3. Status updates: write the DNS TXT answer record (`updateAnswerRecord`) from fresh state.
4. Status updates: wait a 60s grace period, then skip notifying if the status has changed
   again or was flipped back to what the world was last told (undo window; only email, push and
   webhook deliveries count as "told"). The reason is recorded in settings `superseded:<id>` so
   `/updates/:id` can say the update was never announced.
5. Push, then webhooks, 10 targets per step by id cursor (at most 6 in flight, so at most 20
   subrequests a step). Each batch filters out recipients already in `deliveries` and records
   every attempt in one D1 batch.
6. Email, last, because it's the only channel with a quota: 20 per step in one request to Resend's
   `/emails/batch`. When the day's quota runs out mid-batch, real news (audience `all`)
   `step.sleepUntil`s the next 00:00 UTC, checks the update isn't stale, and carries on from the
   same cursor. Daily posts stop at `DAILY_EMAIL_RESERVE` and are dropped rather than sent
   tomorrow. Email waiting on the quota never delays push, webhooks or DNS.
7. `markNotified`.

Audience mapping:

| Audience | Email | Push | Webhooks |
|---|---|---|---|
| `all` | confirmed subscribers, both frequencies | all active | all active |
| `daily` | `daily` subscribers only | none | `daily` hooks only |
| `none` | no-one | no-one | no-one |

Daily cron (09:00 UTC, `src/cron.ts`) only starts `DailyWorkflow` (`src/workflows/daily.ts`) with
id `daily-<London date>`, so a second trigger on the same day finds it already there. Its steps,
each retried on its own (one failing never stops the others; the instance errors at the end):

1. **Post the daily update** (kind `daily`, audience `daily`, which starts its own
   `AnnounceWorkflow`): before `yes`, "Day N: still no." with due/overdue info; after `yes`, "Dad
   day N" for 7 days, then a final "daily service concluded" post, then nothing. Skipped if it's
   already out today, if the London day is over, or if the email quota is down to its last 10
   (`DAILY_EMAIL_RESERVE`), kept for real news.
2. **Sync the DNS answer record.**
3. **Purge subscribers**: unconfirmed ones older than 7 days, unsubscribed ones after 30 days.
4. **Purge `resend_events`** rows older than 30 days.

## Email (Resend)

All email goes through [Resend](https://resend.com) with `RESEND_API_KEY`; with no key, every send
fails cleanly (`no_api_key`) and nothing else breaks.

- **Sending** (`src/notify/email.ts`): `sendEmail()` posts one email to `POST /emails` (confirmations,
  replies, test emails); announcements use `sendEmailBatch()`/`deliverEmailBatch()`, one
  `POST /emails/batch` (`x-batch-validation: permissive`) per step, rendered once per frequency.
  Every request carries an `Idempotency-Key` per logical send (update + subscribers, the inbound
  email's id, or a random key for one-offs) and a `User-Agent` (Resend refuses requests without
  one). From `EMAIL_FROM_NAME <EMAIL_FROM>`; subscriber emails carry
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
  does as little as possible, since the whole request gets 10 ms of CPU: it verifies the Svix
  signature with `RESEND_WEBHOOK_SECRET` (503 if unset, 401 if wrong or older than 5 minutes),
  claims the `svix-id` in `resend_events` (`migrations/0011_resend.sql`) so a retried delivery is
  acknowledged with `{duplicate: true}` but never handled twice, and then:
  - `email.received`: starts `InboundWorkflow` (`src/workflows/inbound.ts`) with id
    `inbound-<svix-id>` (hashed if it isn't a valid instance id) and params `{emailId, from,
    svixId}`, where `from` is the webhook's bare `data.from`, lower-cased. An instance that already
    exists counts as started. If it can't be started, the claim is released and the route answers
    503, so Resend redelivers. Instances keep their output for a day (`successRetention`). Steps:
    - **fetch**: `GET /emails/receiving/{id}`, capped at 512 KiB before parsing, trimmed to what's
      needed (HTML capped at 32,000 characters, text at 16,000, and the body kept only for
      guesses). 429, 5xx, network errors and timeouts throw and the step retries for about 4
      hours; a 4xx, a missing id or key, or an oversized email is permanent and the email is
      recorded as ignored.
    - **decide**: loop protection skips bounces (null Return-Path, mailer-daemon), auto-replies
      (`Auto-Submitted`, `Precedence`, `X-Auto-Response-Suppress`), mailing lists (`List-Id`),
      no-reply senders and our own domain; nothing is answered unless Resend's `authentication`
      result says DKIM or DMARC passed (so spoofed senders can't use the auto-reply to spam
      someone); then the quota, `RL_EMAIL` and 20 replies per sender a day. A subject containing
      "guess" enters the baby pool (`parseGuessText`); anything else gets the status auto-reply.
    - **guess** (guesses that parsed): `submitGuess`.
    - **reply**: from `EMAIL_REPLY_FROM` with `In-Reply-To`/`References`, idempotency key
      `reply:<emailId>`.
    - **record**: one D1 batch writes `inbound_emails` (sender only ever stored hashed) and counts
      the email against the quota, exactly once per instance thanks to an `inbound.recorded`
      marker row in `resend_events` keyed by the instance id (purged with the rest after 30 days).
  - Pool names come only from an explicit `Name:` line. The display name on the sender's address
    is never used (it would end up on a public page); without a `Name:` line the entry is
    "Anonymous emailer", and the reply says so.
  - `email.bounced` (permanent) and `email.complained`: unsubscribe the matching subscribers,
    inline (at most 10 recipients).
  - Anything else: 200, ignored.

## Live protocol (`/ws` WebSocket, `/api/stream` SSE: realtime agent server, frontend client)

Server → client `LiveMessage` (see `src/types.ts`): `hello` (on connect: state, viewers, vibes,
checks, reloadNonce, anxiety), `state`, `update`, `viewers`, `vibes` (`{vibes, emoji, country?}`:
the sender's country, when known), `checks` (at most once a second), `reload`.
Client → server: `{type:'vibe', emoji}` (rate-limited per socket), `{type:'ping'}`. The client
reconnects with backoff. On `reload` with a nonce different from the one it booted with, it does
`location.reload()`.

Social messages (`src/lib/social.ts`, computed in the WaitingRoom from the checks it already
tallies; no extra D1 writes, and nothing per person beyond a country code):
- `checkfeed` (`{items: [{country, n}], more?}`): who just checked, by ISO 3166-1 alpha-2 code
  (`XX` unknown, `T1` Tor). The first check goes out at once, the rest at most every 3 s, and only
  while someone is connected.
- `milestone` (`{n, country}`): the check that took the total to 100, 250, 500, 1k, 2.5k, 5k, 10k,
  25k…, once ever (the last one is kept in DO storage, `social_milestone`).
- `anxiety` (`{level, perMinute}`): checks a minute over a sliding 5-minute window; `calm`,
  `elevated` (3+ checks in 5 minutes), `frantic` (15+), `meltdown` (50+). Sent only when the level
  changes. The only alarms it adds are the few moments the level would fall, and only while a
  viewer is connected; the window is saved (`social_pulse`) when no checks are waiting, i.e.
  before the object can hibernate. `liveSnapshot()` carries it too, for the home page's render.

`public/social.js` (home page only) turns these into the DADCON, anxiety, live map and
"who just checked" panels, and milestone toasts. The map (`/world-map.svg`, Natural Earth, public
domain, ~66 KB) is fetched only when scrolled near, then shaded from `/api/countries`.

## Ownership (agents edit only their files; new files only under their own names/prefixes)

| Agent | Files | Features |
|---|---|---|
| frontend | `src/lib/layout.ts`, `src/routes/pages.ts`, `src/lib/i18n.ts`, `src/lib/og-card.ts`, `public/styles.css`, `public/app.js`, `public/favicon-*.svg`, `public/icons/*`, `public/og/*`, `public/fonts/*`, `public/_headers`, `scripts/og-*`, `test/frontend-*` | design system; home; /updates; /everything; /og/card; 404; i18n; easter eggs |
| feeds | `src/routes/feeds.ts`, `src/routes/api.ts`, `src/routes/mcp.ts`, `src/lib/feeds.ts`, `src/lib/ascii.ts`, `public/embed.js`, `test/feeds-*` | RSS/Atom/JSON/iCal, badge, embed, API + docs + OpenAPI, /api/dad 425/201, MCP, llms/humans/security/robots/sitemap, curl ASCII |
| email | `src/routes/subscribe.ts`, `src/routes/resend-webhook.ts`, `src/notify/email.ts`, `src/workflows/announce.ts`, `src/workflows/daily.ts`, `src/workflows/inbound.ts`, `src/cron.ts`, `src/email-handler.ts`, `src/lib/daily.ts`, `test/email-*`, `test/resend-*` | email updates via Resend (double opt-in, one-click unsubscribe, quota), daily NO, AnnounceWorkflow, DailyWorkflow, cron, Resend webhook, InboundWorkflow (inbound email auto-reply + email guesses) |
| push | `src/routes/push.ts`, `src/routes/webhooks.ts`, `src/notify/push.ts`, `src/notify/webhooks.ts`, `src/notify/dns.ts`, `src/lib/vapid.ts`, `public/sw.js`, `public/push.js`, `public/manifest.webmanifest`, `public/offline.html`, `test/push-*` | web push, PWA + offline, webhooks, DNS TXT |
| realtime | `src/do/waiting-room.ts`, `src/do/waiting-room-protocol.ts`, `src/routes/live.ts`, `src/lib/counters.ts`, `test/realtime-*` | WebSockets, viewers, vibes, SSE, check counters (tallied in the WaitingRoom), /stats |
| admin | `src/lib/admin.ts`, `src/routes/admin.ts`, `public/admin.js`, `test/admin-*` | admin auth + dashboard |
| community | `src/lib/community.ts`, `src/routes/community.ts`, `test/community-*` | readiness checklist, congratulations wall, name suggestions (+ their /admin pages) |
| fun | `src/lib/pool.ts`, `src/lib/forecast.ts`, `src/lib/fruit.ts`, `src/routes/fun.ts`, `test/fun-*` | baby pool, status page, certificate, fridge poster, forecast + fruit maths |
| ledger | `src/lib/ledger.ts`, `src/lib/og.ts`, `src/routes/ledger.ts`, `test/ledger-*` | Dad Ledger (verification memoised per isolate), `/og.png` (serves the pre-rendered card) |
| infra | `.github/**`, `scripts/setup-cloudflare.sh`, `scripts/smoke.sh`, `README.md`, `CLAUDE.md`, `docs/SETUP.md` | CI/CD, previews, one-time Cloudflare setup, smoke tests, docs |
| social | `src/routes/social.ts`, `src/lib/social.ts`, `src/lib/dadcon.ts`, `public/social.js`, `public/social.css`, `public/world-map.svg`, `public/world-map.LICENSE.txt`, the social parts of `src/do/waiting-room.ts`, `test/social-*` | DADCON, live check feed, live world map, milestones, global anxiety meter (home panels CH-12 to CH-15) |
| corporate | `src/routes/corporate.ts`, `src/lib/corporate.ts`, `src/lib/stork.ts`, `public/stork.js`, `public/corporate.css`, `migrations/0012_stork.sql`, `test/corporate-*`, `test/stork-*` | press kit, privacy policy + terms (kept accurate by tests against the schema and the CSS), pigeon / smoke signal / fax on /everything, Catch the Stork + leaderboard |

Reserved migration files, if you need schema additions (prefer not to): `0002_realtime`,
`0003_email` (used: `email_sends`), `0004_push`, `0005_admin`, `0006_community`, `0007_fun`,
`0008_ledger`, `0009_feeds`, `0010_frontend`, `0011_resend` (used: `resend_events`), `0012_stork`
(used: `stork_scores`). A new table also needs a row on `/privacy` (`PRIVACY_TABLES` in
`lib/corporate.ts`); `test/corporate-pages.test.ts` fails until it has one.

## Cross-module contracts (stubs exist; keep exported signatures exactly)

- `lib/counters.ts`: `recordCheck(env, request)` (synchronous filtering, then one fire-and-forget
  `WaitingRoom.recordCheck` RPC; the room tallies in memory and writes D1 in batches),
  `getCheckTotal(env)` (one `checkTotal()` RPC, cached 2 s per isolate; D1 if the room is down)
- `do/waiting-room.ts`: class `WaitingRoom` with `fetch()` (ws + sse), RPCs `broadcast(msg)`, `stats()`,
  `liveSnapshot()` (`{viewers, vibes, checks, reloadNonce, anxiety}`), `recordCheck(check)`, `checkTotal()`
- `routes/social.ts`: `socialHomePanels(state, {today, anxiety})` (the home page's CH-12 to CH-15),
  `SOCIAL_HEAD` + `SOCIAL_SCRIPT` (`/social.css`, `/social.js`) for pages that show them
- `lib/ledger.ts`: `appendLedger(env, {status, note})`, `getLedger(env, {limit})`, type `LedgerEntry`
- `lib/og.ts`: `ogCardPath(status)`, `ogVersionStatus(v)`. Nothing renders at request time: `/og.png`
  serves `public/og/<status>.png` from `ASSETS` (the status from a valid `?v=<status>-<ms>`, cached
  for a year; else the current status, 5 minutes). `scripts/og-render.ts --screenshot` regenerates
  the PNGs from `lib/og-card.ts`; re-run it and commit them whenever the card or `STATUS_COPY`
  changes.
- `lib/og-card.ts`: `renderOgCardHtml({state, checks, today}) → string` (self-contained HTML, 1200×630,
  used by `scripts/og-render.ts` and the `/og/card` preview)
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
  `/push.js`) (`routes/push.ts`), `webhookForm(c)` (`routes/webhooks.ts`), `pigeonForm()`,
  `smokeSignalForm()`, `faxForm()` (`routes/corporate.ts`)

## URL map

| Owner | URLs |
|---|---|
| frontend | `/`, `/updates`, `/updates/:id`, `/everything`, `/og/card?status=`; static `/styles.css`, `/app.js`, `/favicon-{no,soon,yes}.svg`, `/icons/{icon-192,icon-512,maskable-512,apple-touch-icon}.png`, `/og/{no,soon,yes}.png` |
| feeds | `/feed.xml` (+`/rss.xml`), `/atom.xml`, `/feed.json`, `/calendar.ics`, `/badge.svg`, `/embed`, `/embed.js`, `/llms.txt`, `/humans.txt`, `/.well-known/security.txt`, `/robots.txt`, `/sitemap.xml`, `/api`, `/api/status` (+`.json`), `/api/status.txt`, `/api/history`, `/api/updates`, `/api/dad`, `/openapi.json`, `/mcp` |
| realtime | `/ws`, `/api/stream`, `/api/live`, `/stats` |
| email | `/subscribe` (GET/POST), `/confirm/:token`, `/unsubscribe/:token` (GET/POST one-click), `/api/resend/webhook` (POST, Svix-signed) |
| push | `/api/push/key`, `/api/push/subscribe`, `/api/push/unsubscribe`, `/push.js`, `/sw.js`, `/manifest.webmanifest`, `/offline.html`, `/webhooks` (POST), `/webhooks/:token`, `/webhooks/:token/delete`, `/webhooks/:token/test` |
| admin | `/admin`, `/admin/login`, `/admin/logout`, `/admin/status`, `/admin/due-date`, `/admin/reload`, `/admin/test-email`, `/admin/updates/:id/rerun`, `/admin/og/render` (retired: redirects to `/admin` with a notice, 410 for JSON), `/admin/dns/sync` |
| community | `/ready`, `/wall`, `/names`, `/names/:id/vote`, `/admin/checklist`, `/admin/wall`, `/admin/names` |
| fun | `/pool`, `/status`, `/certificate`, `/poster`, `/admin/pool` |
| ledger | `/ledger`, `/api/ledger`, `/.well-known/dad-ledger.json`, `/og.png` |
| social | `/api/countries` (checks per country, cached ~60 s, CORS `*`); static `/social.js`, `/social.css`, `/world-map.svg`, `/world-map.LICENSE.txt` |
| corporate | `/press`, `/privacy`, `/terms`, `/pigeon`, `/smoke-signal`, `/fax` (POST: a result page, nothing read or stored; GET redirects back to the method on /everything), `/stork`, `/api/stork/start` (POST), `/api/stork/score` (POST), `/api/stork/scores`; static `/stork.js`, `/corporate.css` |

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

## CPU budget (Workers Free)

Production runs on the Workers Free plan. Its limits shape the code:

- **10 ms of CPU** per HTTP request (`waitUntil` work included), per cron run and per Workflow
  step. Waiting on `fetch`, D1 or a Durable Object doesn't count; `crypto.subtle` does. Going over
  is Error 1102 for a request, a failed attempt for a step. Wall time is generous, CPU isn't.
- **Nearly every request is a cold isolate** on a site this quiet, so module-scope work is paid
  on every route. Keep module scope to constants: no `Intl` objects, big regexes, parsing or
  crypto at import time.
- **Heavy work goes into Workflow steps**, each with its own 10 ms and retries: announcements
  (`AnnounceWorkflow`), inbound email (`InboundWorkflow`), the daily job (`DailyWorkflow`). A
  request or the cron only writes what it must and starts an instance. Batch sizes keep a step
  inside its budget and under **50 external subrequests** (push and webhooks: 10 per step; email:
  one Resend batch request of 20). An instance may take 1,024 steps, and the account 3,000 a day.
- **No headless browser.** The social cards are pre-rendered PNGs (`scripts/og-render.ts`).
- **Memoise `Intl`, or avoid it.** The first `Intl` call in an isolate (any `DateTimeFormat`,
  `NumberFormat`, `toLocaleString`, `localeCompare`) costs 6 to 8 ms of CPU starting ICU. Use the
  helpers in `lib/time.ts` (`formatLondon`, `formatNumber`, …), which avoid ICU for the formats in
  use; `dateTimeFormat`/`numberFormat` build any other formatter once per isolate.
- **Cache per isolate** what only changes with the status or the day (rendered fragments, ledger
  verification, the `ip_salt`), keyed on exactly what it depends on, and bounded.
- **One round trip where possible**: `D1.batch` for several statements, `liveSnapshot` for every
  live number, the state read skipped on routes that don't need it.
- **Durable Object** requests get their own budget, but every counted check is one, so the
  WaitingRoom keeps per-check work to memory and flushes to D1 in batches from its alarm.

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
