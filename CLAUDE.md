# CLAUDE.md

> **Agents: keep this file, the README and docs/ up to date.** If you change the deploy model,
> add tooling, change a convention, or add a URL, update the relevant doc in the same change.

**iszacka.dad** answers "Is Zack a dad?" with one gloriously overengineered Cloudflare Worker
(TypeScript, Hono, server-rendered HTML via `hono/html`, static assets in `public/`). Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing anything: it's the contract for
module ownership, foundation APIs, the URL map, the live protocol and the UI kit.

## Hard rules

- **No AI calls**: no Workers AI, no LLM APIs. (The MCP server serves other people's assistants.)
- **No personal data**: the site knows the status, when it changed, and the due date. Never store
  or show baby names, weights, photos, locations or hospitals. The repo is public: no secrets, no
  personal info, no real email addresses in code or tests (use `example.com`).
- **No gendered pronouns** for Zack, Jess or the baby. Use names, or "the baby".
- **Escape everything**: build HTML with `` html`...` `` from `hono/html`; never pass user input to
  `raw()`.
- **No inline scripts** (CSP): JS lives in `public/*.js`; pass data via `data-*` attributes.
- **Progressive enhancement**: every form works without JS, and returns JSON to
  `Accept: application/json`.
- **Every public write** is rate-limited (`allow()`), Turnstile-checked (`verifyTurnstile()`),
  length-limited and trimmed.
- **Delivery functions never throw**; they return `DeliveryResult`.
- **Time**: Europe/London for "days" (`src/lib/time.ts`); store ISO UTC.
- **10 ms of CPU** (Workers Free): every request (`waitUntil` included), cron run and Workflow
  step must fit. Heavy or slow work goes into a Workflow step (`ANNOUNCE`, `INBOUND`, `DAILY`);
  no headless browser (the OG cards are pre-rendered by `scripts/og-render.ts`); nothing costly
  at module scope; no `Intl`, `toLocale*` or `localeCompare` on hot paths (use `lib/time.ts`'s
  `formatLondon`, `formatNumber` and friends, or its memoised `dateTimeFormat`). See "CPU budget
  (Workers Free)" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **British English**, dry and witty: nappy, colour, favourite.

## Checks

```bash
npx tsc --noEmit                                 # typecheck
npx vitest run                                   # unit tests (test/*.test.ts)
shellcheck scripts/*.sh .github/scripts/*.sh     # shell lint (CI runs it)
actionlint .github/workflows/*.yml               # workflow lint
npm run db:migrate:local
npx wrangler dev --infer-origin-from-routes=false &
bash scripts/smoke.sh http://localhost:8787 --mutate    # end-to-end
```

Adding a URL? Add it to the URL map in docs/ARCHITECTURE.md and a check for it to
`scripts/smoke.sh` (`test/infra-smoke-coverage.test.ts` fails until you do).

## Deploys

- Pull requests: CI (`.github/workflows/ci.yml`) plus a preview Worker per PR
  (`preview.yml`). Merging to `main` deploys production (`deploy.yml`).
- D1 ids are never committed. `wrangler.toml` keeps `PLACEHOLDER_D1_ID` and
  `PLACEHOLDER_D1_PREVIEW_ID`; `.github/scripts/ensure-d1.sh` injects the real ones in CI.
- Email is [Resend](https://resend.com), both ways: the Worker sends with `RESEND_API_KEY` and
  receives through the signed webhook `POST /api/resend/webhook`. Cloudflare's email products
  aren't used. Mind the free plan (100 emails/day, received ones included): the Worker caps
  itself at `EMAIL_DAILY_LIMIT`.
- Secrets: GitHub holds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_PASSWORD` and
  `RESEND_API_KEY` (the deploy syncs the Worker ones). The **Setup** workflow
  (`.github/workflows/setup.yml` → `scripts/setup-cloudflare.sh`, run by hand) owns the Resend
  domain, its DNS records and webhook, Turnstile, and the Worker secrets `RESEND_WEBHOOK_SECRET`,
  `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. Never print secret values in scripts or logs.
- One-time setup, in order, and the API token's permissions: [docs/SETUP.md](docs/SETUP.md).

## Git

- Conventional commits, lowercase: `feat: add the fruit`, `fix: escape the wall`.
- PR titles follow the same format. PRs are squash-merged into `main`.
