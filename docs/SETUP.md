# Setting up iszacka.dad from scratch

Everything needed to take this repository from "cloned" to "answering the question at
https://iszacka.dad", in order:

1. add the zone to Cloudflare;
2. create the Cloudflare deploy token, and a Resend API key;
3. set the GitHub secrets;
4. push to `main`, which deploys;
5. run the **Setup** workflow once;
6. check it works.

After that, merging to `main` is the whole deploy process.

You'll need:

- A Cloudflare account. The site is built to run on the **Workers Free** plan: every request,
  cron run and Workflow step fits in its 10 ms of CPU (see "CPU budget (Workers Free)" in
  [ARCHITECTURE.md](ARCHITECTURE.md#cpu-budget-workers-free)). The free daily limits still
  apply, and when one runs out it stays out until 00:00 UTC: 100,000 Worker requests, 100,000
  Durable Object requests (each counted check is one), 3,000 Workflow steps for the whole account
  (an announcement takes about a dozen plus one per extra batch of recipients, an inbound email
  four or five, the daily job four plus its post's announcement), and D1's reads and writes. For
  scale: one open `curl -N /api/stream` keeps the production Durable Object awake around the
  clock, which is about 10,800 of the Free plan's 13,000 GB-s a day, so leave headroom for other
  Durable Objects on the account (preview streams are closed after a few minutes for this
  reason). Workers Paid lifts all of this if the site ever gets popular.
- A [Resend](https://resend.com) account, for email in both directions. The free plan is enough
  (see [Email limits](#email-limits)).
- Admin access to the GitHub repository (`zackpollard/iszacka.dad`).
- Locally (optional): Node 24, `curl`, `jq`, and the [GitHub CLI](https://cli.github.com) (`gh`).

## 1. Add the zone

1. In the Cloudflare dashboard, **Add a domain**, enter `iszacka.dad`, and pick a plan (Free is
   plenty).
2. At the registrar, replace the nameservers with the two Cloudflare gives you.
3. Wait until the zone shows **Active**. Nothing below works on a pending zone.

Don't create DNS records for `iszacka.dad` or `www.iszacka.dad` yourself: `wrangler deploy`
attaches both as Worker custom domains and creates the records and certificates itself. An
existing record with the same name will make that fail. The email records (DKIM, SPF, MX, DMARC)
are the Setup workflow's job.

(`.dad` is on the HSTS preload list as a whole TLD, so browsers only ever use HTTPS. The site
sends HSTS anyway. Belt and braces.)

Also open **Workers & Pages** once. A brand new account is asked to pick a `workers.dev`
subdomain there, and PR previews live on it.

## 2. Create the credentials

### The Cloudflare deploy token

CI deploys, and the Setup workflow configures, with one scoped API token. Create it under **Manage
Account → Account API Tokens** (recommended: it belongs to the account rather than a person) or
**My Profile → API Tokens**, as a **Custom token** called something like `iszacka.dad deploys`.

**Account permissions** (Account Resources: include only your account)

| Permission | Level | Why |
|---|---|---|
| Workers Scripts | Edit | Deploy the Worker and PR previews (and delete them), Worker secrets, the Durable Object, the three Workflows (the Workflows API is covered by this permission), the rate limiters, the `workers.dev` subdomain lookup and attaching custom domains |
| D1 | Edit | Find or create the `iszackadad` and `iszackadad_preview` databases, and apply migrations |
| Account Settings | Read | Wrangler reads account details when it starts |
| Turnstile | Edit | The Setup workflow finds or creates the Turnstile widget, and reads (or rotates) its secret (the API docs call this "Turnstile Sites Write") |
| Workers Tail | Read | Optional: lets you `wrangler tail` with the same token |

**Zone permissions** (Zone Resources: include → specific zone → `iszacka.dad`)

| Permission | Level | Why |
|---|---|---|
| Zone | Read | Look up the zone (wrangler's custom domains, the setup script) |
| Workers Routes | Edit | Attach the `iszacka.dad` and `www.iszacka.dad` custom domains on deploy |
| DNS | Edit | DNS records for the custom domains, and Resend's DKIM, SPF, MX and the `_dmarc` record from the setup script |
| Zone Settings | Edit | Only if Cloudflare Email Routing was ever switched on for the zone: the setup script turns it off, so inbound mail reaches Resend instead |

Things you don't need, so don't add them:

- **Browser Rendering** (shown as "Browser Run" in newer dashboards): nothing uses it. The social
  cards are pre-rendered PNGs in `public/og/`.
- Any of Cloudflare's own email permissions: email is Resend's job here.
- **User Details** and **Memberships**: wrangler only needs them to discover your account, and
  CI tells it the account ID instead.
- Client IP filtering: GitHub's runners don't have fixed addresses.

Check the token works (account tokens use the account endpoint; personal tokens use
`/user/tokens/verify`):

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/<account-id>/tokens/verify" \
  -H "Authorization: Bearer <token>" | jq '.result.status'      # "active"
```

Your **account ID** is on the Workers & Pages overview page, or run `npx wrangler whoami`.

### The Resend API key

In Resend, **API Keys → Create API key** with **Full access**. "Sending access" isn't enough: the
Setup workflow adds the domain and the webhook, and the Worker fetches received emails, and both
need full access. The Worker uses this key at runtime to send every email and to read inbound
mail.

### Optional: a DNS-only token for the Worker

By default the deploy hands the Worker `CLOUDFLARE_API_TOKEN` as its `DNS_API_TOKEN` (it already
has DNS Edit on the zone). Set a narrower `DNS_EDIT_TOKEN` (or `DNS_API_TOKEN`) secret (Zone Read + DNS Edit on
`iszacka.dad` only) so the Worker doesn't hold the deploy token; it takes precedence.

With a `DNS_API_TOKEN`, the Worker keeps a TXT record in sync with the answer, so
`dig +short TXT answer.iszacka.dad` answers the question too. It's written when a change of
answer is announced, when the due date changes, by the daily 09:00 UTC cron and by **Sync DNS**
in `/admin`. Without the token the site doesn't advertise the `dig` command at all. The Worker holds this token at
runtime, so give it as little as possible: a separate **Custom token** with

| Permission | Level | Why |
|---|---|---|
| Zone → DNS | Edit | Create and update `answer.iszacka.dad` |
| Zone → Zone | Read | Look up the zone ID by name. Skip it if you also set `DNS_ZONE_ID` |

and Zone Resources: include → specific zone → `iszacka.dad`. Nothing else, and no account
permissions at all. Without the token the feature quietly switches itself off.

## 3. GitHub secrets

In the repository: **Settings → Secrets and variables → Actions → New repository secret**, or
with `gh` (it prompts for the value, so nothing ends up in your shell history):

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo zackpollard/iszacka.dad
```

| Secret | Required? | What |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Yes | The deploy token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Your Cloudflare account ID |
| `ADMIN_PASSWORD` | Yes, for `/admin` | The admin password. Make it long; it guards the big red button. `openssl rand -base64 24` will do |
| `RESEND_API_KEY` | Yes, for email | The full-access Resend key from step 2 |
| `DNS_EDIT_TOKEN` | Optional | A DNS-only token for the Worker (`DNS_API_TOKEN` also works); falls back to `CLOUDFLARE_API_TOKEN` |
| `DNS_ZONE_ID` | Optional | The `iszacka.dad` zone ID, so the DNS token doesn't need Zone Read |
| `PREVIEW_ADMIN_PASSWORD` | Optional | The `/admin` password for PR previews (`openssl rand -base64 24`). Without it, preview admin is switched off. Never post it anywhere public: previews are reachable by anyone |
| `TURNSTILE_SITE_KEY` | Don't set | The Setup workflow stores it on the Worker. Set it here only to override that |
| `TURNSTILE_SECRET_KEY` | Don't set | Likewise |
| `RESEND_WEBHOOK_SECRET` | Don't set | Likewise: the Setup workflow takes it from the Resend webhook it creates |

The deploy workflow copies `ADMIN_PASSWORD`, `RESEND_API_KEY`, `DNS_API_TOKEN` and `DNS_ZONE_ID`
into Worker secrets after every deploy, plus any of the three "don't set" ones you set anyway. A
secret that isn't set in GitHub is left alone on the Worker (never deleted), so you can also
manage any of them with `npx wrangler secret put <NAME>`.

The `production` environment is created automatically by the first deploy. Add protection rules
to it if you'd like a human to approve production deploys (and Setup runs, which use it too).

## 4. First deploy

Push to `main` (or run the **Deploy** workflow by hand from the Actions tab). It will:

1. typecheck and run the unit tests;
2. find the `iszackadad` D1 database, creating it (in Western Europe) if this is the first time,
   and write its ID into the job's copy of `wrangler.toml`;
3. apply the D1 migrations;
4. `wrangler deploy`, attaching `iszacka.dad` and `www.iszacka.dad`;
5. set the Worker secrets from step 3;
6. wait for the site to answer, then run the smoke test against it, read-only.

On the very first deploy, certificates for the custom domains can take a few minutes. The
workflow waits up to five; if it gives up, re-run it a little later.

The site works at this point, but email doesn't yet: Resend doesn't know the domain, and nothing
points inbound mail at it. That's the next step.

PR previews work from now on too: every pull request from a branch in this repository deploys
`iszacka-dad-pr<N>` to `workers.dev`, with its own Workflows, the shared `iszackadad_preview`
database and Turnstile's test keys. Preview `/admin` uses the `PREVIEW_ADMIN_PASSWORD` repository
secret (stored on each preview Worker as a secret, never printed); without it, preview admin is
switched off. Previews are public on `workers.dev`, so never publish that password. Previews have
no Resend key, so they never send email, and their webhook endpoint answers 503. Fork PRs are
skipped (they get no secrets). Closing the PR deletes the preview.

The shared preview database records migrations by name, so editing a migration after its preview
has run won't re-apply it: rename the file, or drop the table from `iszackadad_preview` by hand.

## 5. Run the Setup workflow

**Actions → Setup → Run workflow.** It runs
[`scripts/setup-cloudflare.sh`](../scripts/setup-cloudflare.sh) with the `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` and `RESEND_API_KEY` secrets. It checks before it changes anything, so it's
safe to run as often as you like; tick **dry run** to see what it would do first. It:

1. finds the `iszacka.dad` zone, and checks it belongs to `CLOUDFLARE_ACCOUNT_ID`;
2. finds or creates the `iszacka.dad` domain in Resend (region `eu-west-1`, sending and receiving),
   switching receiving on if it's off;
3. switches off Cloudflare Email Routing if it's on, and removes any apex MX record that isn't
   Resend's, printing each one it removes (inbound mail has to reach Resend);
4. adds or fixes every DNS record Resend asks for: the DKIM key, the SPF `MX` and `TXT` records on
   `send.iszacka.dad`, and the receiving `MX` on `iszacka.dad`, all unproxied;
5. asks Resend to verify the domain and waits up to two minutes. Still pending after that is fine:
   Resend keeps checking for 72 hours, and the next run reports the result;
6. finds or creates the Resend webhook for `https://iszacka.dad/api/resend/webhook` (events
   `email.received`, `email.bounced`, `email.complained`), and stores its signing secret as the
   Worker secret `RESEND_WEBHOOK_SECRET`;
7. finds or creates a managed Turnstile widget for `iszacka.dad`, and stores its keys as the Worker
   secrets `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (rotating the widget's secret if the API
   won't hand over the current one);
8. adds a `_dmarc` TXT record (`v=DMARC1; p=quarantine; adkim=r; aspf=r`) if there isn't one.
   Alignment is relaxed because Resend's bounce address lives on `send.iszacka.dad`;
9. prints a summary.

Worker secrets are only written when they're missing or their source is new (a new webhook, a new
widget); **force secrets** re-writes them anyway. No secret value is ever printed, and the ones it
discovers are masked in the log. It exits non-zero while anything needs attention, so "run it until
it's green" works. If it says the Worker doesn't exist, deploy first (step 4).

Prefer your own machine? The same script runs locally:

```bash
npm ci
CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account-id> RESEND_API_KEY=<key> \
  bash scripts/setup-cloudflare.sh --dry-run      # then again without --dry-run
```

## 6. Check it all works

```bash
bash scripts/smoke.sh https://iszacka.dad
```

That walks every URL in [ARCHITECTURE.md](ARCHITECTURE.md) and checks status codes, content
types, security headers, the feeds, the API, MCP, the WebSocket and the SSE stream. Against
production it only reads. Never pass `--mutate` to production: it presses the big red button
(and refuses unless you insist, which you shouldn't).

Then the things a script can't check:

- In Resend, **Domains → iszacka.dad** shows sending and receiving as verified.
- `/admin` → **Send a test email** to your own address.
- Email `ask@iszacka.dad` from a real inbox and wait for the auto-reply. Resend's **Webhooks** page
  shows each delivery and its response.
- If you set up the DNS token: press **Sync DNS** in `/admin` (or wait for the 09:00 UTC cron),
  then `dig +short TXT answer.iszacka.dad`. Before that first sync the record doesn't exist.
- `curl iszacka.dad`, for the ASCII art. Obviously.
- In GitHub, **Settings → Code security → Private vulnerability reporting** is enabled:
  `/.well-known/security.txt` sends security reports there (mail to the domain only reaches the
  auto-responder).
- Subscribe with your own address and confirm it. If you're brave, flip the answer to NOT YET
  in `/admin` and back to NO within 60 seconds: thanks to the undo window, nobody hears a thing,
  and the dashboard's delivery log shows what each notification run decided.

## Email limits

Resend's free plan allows **100 emails a day** (reset at 00:00 UTC) and **3,000 a month**, and
received emails count too. The Worker keeps its own tally (the `email_sends` table) and stops at
`EMAIL_DAILY_LIMIT` (90, in `wrangler.toml`) so it never hits Resend's wall mid-announcement:

- a status announcement that runs out sleeps until midnight UTC, then carries on where it stopped;
- the daily "still no" isn't posted on a day when only the last 10 emails are left;
- inbound mail is still recorded when the limit is reached, but not replied to.

On a paid plan, raise `EMAIL_DAILY_LIMIT` in `wrangler.toml`.

## Day to day

- **Deploy**: merge to `main`.
- **Logs**: `npx wrangler tail iszacka-dad`, or Workers Observability in the dashboard.
- **Roll back**: `npx wrangler rollback` (code only; D1 migrations don't roll back).
- **Change the admin password**: update the `ADMIN_PASSWORD` secret, then run the Deploy workflow.
- **Rotate the Resend key**: create a new full-access key, update `RESEND_API_KEY`, run the Deploy
  workflow, then delete the old key.
- **Rotate the webhook or Turnstile secrets**: delete the webhook (in Resend) or the widget (in
  Cloudflare), then run the Setup workflow.
- **Rotate the deploy token**: create the new one, update `CLOUDFLARE_API_TOKEN`, delete the old.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy fails attaching a custom domain | A DNS record named `iszacka.dad` or `www` already exists. Delete it and re-run |
| A preview can't find its `workers.dev` URL | The account has no `workers.dev` subdomain yet. Open Workers & Pages once to pick one |
| "A workflow with this name already exists" | Something else owns that Workflow name. Previews rename theirs per PR; check nothing else uses `iszacka-dad-announce`, `iszacka-dad-inbound` or `iszacka-dad-daily` |
| Setup says Resend can't list domains | `RESEND_API_KEY` is a sending-only key. Create a full-access one |
| Setup says the domain is registered already | It's verified in another Resend team. Remove it there first |
| No auto-reply to email | Check, in order: the Resend domain shows receiving verified; `dig +short MX iszacka.dad` shows only Resend's host; Resend's **Webhooks** page shows deliveries answered with 200 (401 means `RESEND_WEBHOOK_SECRET` is stale: run Setup with **force secrets**); the `iszacka-dad-inbound` Workflow has an `inbound-<svix-id>` instance for the email, and its steps say what it decided (**Workers & Pages → Workflows**, or `npx wrangler workflows instances list iszacka-dad-inbound`); the daily email limit isn't used up |
| `/admin` test email fails with `no_api_key` | `RESEND_API_KEY` isn't on the Worker. Set the GitHub secret and run the Deploy workflow |
| Test email fails with `validation_error` | The Resend domain isn't verified yet. Run the Setup workflow and check its step 5 |
| Forms say the robot check failed | `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` belong to different widgets. Run Setup with **force secrets** |
| The smoke test fails right after the first deploy | Certificates are still being issued. Wait a few minutes and re-run the Deploy workflow |
