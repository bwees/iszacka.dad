// Shared types. Owned by the foundation: agents may import from here but must not
// change existing shapes (add new types in their own modules instead).

/** 'no' = not a dad. 'soon' = labour is happening right now. 'yes' = Zack is a dad. */
export type Status = 'no' | 'soon' | 'yes';

export const STATUSES: readonly Status[] = ['no', 'soon', 'yes'] as const;

export function isStatus(value: unknown): value is Status {
	return value === 'no' || value === 'soon' || value === 'yes';
}

/** Everything the site knows. All of it is public. */
export interface SiteState {
	status: Status;
	/** ISO timestamp of the last status change (for 'yes': the moment Zack became a dad). */
	statusChangedAt: string;
	/** 'YYYY-MM-DD' or null if the admin hasn't set one. */
	dueDate: string | null;
}

export type UpdateKind = 'status' | 'daily' | 'system';

/** Who gets notified about an update. */
export type Audience = 'none' | 'daily' | 'all';

/** Subscription frequency for email + webhooks. 'big' = real news only. 'daily' = also daily "still no". */
export type Frequency = 'big' | 'daily';

export interface Update {
	id: number;
	kind: UpdateKind;
	title: string;
	/** Plain text. Render with escaping; may contain newlines. */
	body: string;
	/** Status at the time of the update. */
	status: Status;
	audience: Audience;
	createdAt: string;
	notifiedAt: string | null;
}

export interface SubscriberRow {
	id: number;
	email: string;
	frequency: Frequency;
	token: string;
	created_at: string;
	confirm_sent_at: string | null;
	confirmed_at: string | null;
	unsubscribed_at: string | null;
}

export interface PushSubscriptionRow {
	id: number;
	endpoint: string;
	p256dh: string;
	auth: string;
	failures: number;
}

export type WebhookKind = 'discord' | 'slack' | 'generic';

export interface WebhookRow {
	id: number;
	url: string;
	kind: WebhookKind;
	frequency: Frequency;
	token: string;
	failures: number;
}

/** Result of delivering one notification. Delivery functions never throw. */
export interface DeliveryResult {
	ok: boolean;
	/** The target is permanently gone (e.g. push 410, webhook 404) and has been disabled. */
	gone?: boolean;
	detail?: string;
}

export type Channel = 'email' | 'push' | 'webhook' | 'dns' | 'og';

/** Server → browser messages over the live WebSocket / SSE stream. */
export type LiveMessage =
	| { type: 'hello'; state: SiteState; viewers: number; vibes: number; checks: number; reloadNonce: string }
	| { type: 'state'; state: SiteState }
	| { type: 'update'; update: Update }
	| { type: 'viewers'; viewers: number }
	| { type: 'vibes'; vibes: number; emoji: string }
	| { type: 'checks'; checks: number }
	| { type: 'reload'; nonce: string };

/** Browser → server messages over the live WebSocket. */
export type ClientMessage = { type: 'vibe'; emoji?: string } | { type: 'ping' };

/** Hono app environment. `state` is loaded once per request by the root middleware. */
export type AppEnv = {
	Bindings: Env;
	Variables: {
		state: SiteState;
		requestStart: number;
	};
};
