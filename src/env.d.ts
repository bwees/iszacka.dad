// Optional secrets that `wrangler types` can't see (they're never in wrangler.toml).
interface Env {
	/** Cloudflare API token with Zone DNS:Edit on the site's zone. Enables the live TXT record. */
	DNS_API_TOKEN?: string;
	/** Optional zone id override; otherwise looked up from ZONE_NAME. */
	DNS_ZONE_ID?: string;
	/** Resend API key (full access). Sends and fetches received email; unset means no email at all. */
	RESEND_API_KEY?: string;
	/** Resend webhook signing secret (whsec_…). Verifies POST /api/resend/webhook. */
	RESEND_WEBHOOK_SECRET?: string;
	/** Test hook: Resend API base URL override. Defaults to https://api.resend.com. */
	RESEND_API_BASE?: string;
}
