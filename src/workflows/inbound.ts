// OWNER: inbound agent.
// Inbound email, one received Resend email per instance (id `inbound-<svix-id>`, started by
// POST /api/resend/webhook). On Workers Free each step gets its own 10 ms of CPU and its own
// retries, so the request only verifies, claims and hands off.
//
//   fetch   GET /emails/receiving/{id}, trimmed (src/email-handler.ts: fetchReceivedEmail).
//           429, 5xx and network errors throw, and the step retries with backoff for ~4 hours.
//   decide  loop protection, Resend's authentication verdict, quota, RL_EMAIL and the daily
//           per-sender cap, guess parsing. A small serialisable decision.
//   guess   enter the pool guess (guess emails that parsed only).
//   reply   render and send; the idempotency key is reply:<emailId>, so a retry can't send twice.
//   record  inbound_emails + count the received email against the quota, exactly once (keyed by
//           the instance id, see recordInbound), even when fetch or decide failed for good.
//
// Step names are fixed, so a replayed instance reuses every finished step's result. The
// instance output is a small summary with no addresses in it.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import {
	type FetchResult,
	type GuessOutcome,
	type InboundDecision,
	type InboundKind,
	type ReplyDecision,
	type ReplyOutcome,
	decideInbound,
	enterGuess,
	fetchReceivedEmail,
	recordInbound,
	sendInboundReply,
} from '../email-handler';

export interface InboundParams {
	/** Resend received-email id (data.email_id). */
	emailId: string;
	/** Bare, lower-cased sender address from the webhook (data.from). */
	from: string;
	/** svix-id of the delivery that started this instance. */
	svixId: string;
}

/** Resend outages: 1, 2, 4 ... 128 minutes apart, about 4 hours in all (Svix's own retries went further, slower). */
export const FETCH_STEP: WorkflowStepConfig = { retries: { limit: 8, delay: '1 minute', backoff: 'exponential' }, timeout: '1 minute' };
export const DECIDE_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' };
/** submitGuess never throws, so a retry only follows a crash. */
export const GUESS_STEP: WorkflowStepConfig = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' };
export const REPLY_RETRIES = 3;
export const REPLY_STEP: WorkflowStepConfig = {
	retries: { limit: REPLY_RETRIES, delay: '30 seconds', backoff: 'exponential' },
	timeout: '2 minutes',
};
export const RECORD_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' };

/** Thrown inside the reply step for a transient send failure, so the engine retries it. */
export class RetryableReplyError extends Error {
	override name = 'RetryableReplyError';
}

/** What an instance returns (stored by Workflows): no addresses, no content. */
export interface InboundSummary {
	kind: InboundKind;
	/** Why it was ignored, or why the email couldn't be read. */
	reason?: string;
	replied?: boolean;
	code?: string;
	/** False if an earlier attempt had already recorded this email. */
	recorded: boolean;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The whole run, given a step runner (tests pass a fake one). `instanceId` keys the
 * exactly-once record; `receivedAt` (when the instance was created) dates it, so an email
 * whose fetch was retried past midnight UTC still counts on the day Resend received it.
 * Throws only if the record step fails for good.
 */
export async function inbound(
	env: Env,
	params: InboundParams,
	instanceId: string,
	step: WorkflowStep,
	receivedAt: Date = new Date(),
): Promise<InboundSummary> {
	const emailId = typeof params.emailId === 'string' ? params.emailId : '';
	const webhookFrom = typeof params.from === 'string' ? params.from : '';

	let fetched: FetchResult;
	try {
		fetched = await step.do('fetch', FETCH_STEP, () => fetchReceivedEmail(env, emailId, webhookFrom));
	} catch (err) {
		console.error('inbound: gave up fetching the received email:', errorMessage(err));
		fetched = { ok: false, reason: 'fetch failed' };
	}

	const summary: Omit<InboundSummary, 'recorded'> = { kind: 'ignored' };
	let fromHash: string | null = null;
	if (!fetched.ok) {
		summary.reason = fetched.reason;
	} else {
		const email = fetched.email;
		let decision: InboundDecision | null = null;
		try {
			decision = await step.do('decide', DECIDE_STEP, () => decideInbound(env, email));
		} catch (err) {
			console.error('inbound: could not decide:', errorMessage(err));
			summary.reason = 'decide failed';
		}
		if (decision) fromHash = decision.fromHash;
		if (decision?.action === 'ignore') {
			console.log(`inbound: not replying (${decision.reason})`);
			summary.reason = decision.reason;
		} else if (decision) {
			const answer: ReplyDecision = decision;
			summary.kind = answer.action;
			let entered: GuessOutcome | null = null;
			let canReply = true;
			if (answer.action === 'guess' && !('error' in answer.guess)) {
				const guess = answer.guess;
				try {
					entered = await step.do('guess', GUESS_STEP, () => enterGuess(env, guess, answer.fromHash));
				} catch (err) {
					// Unknown whether it went in: say nothing rather than something wrong.
					console.error('inbound: could not enter the guess:', errorMessage(err));
					canReply = false;
				}
			}
			if (canReply) {
				const guessed = entered;
				try {
					const sent = await step.do('reply', REPLY_STEP, async (ctx): Promise<ReplyOutcome> => {
						const outcome = await sendInboundReply(env, emailId, email, answer, guessed);
						// Retry a transient failure, but return (not throw) from attempt REPLY_RETRIES on:
						// attempts count from 1, and this stays safe if a runtime counts from 0.
						if (outcome.retry && ctx.attempt < REPLY_RETRIES) throw new RetryableReplyError(`reply not sent: ${outcome.code ?? 'unknown'}`);
						return outcome;
					});
					summary.replied = sent.sent;
					if (sent.code) summary.code = sent.code;
				} catch (err) {
					console.error('inbound: reply failed:', errorMessage(err));
					summary.replied = false;
				}
			}
		}
	}

	const kind = summary.kind;
	const at = Number.isFinite(receivedAt.getTime()) ? receivedAt : new Date();
	const recorded = await step.do('record', RECORD_STEP, () => recordInbound(env, instanceId, kind, fromHash, at));
	return { ...summary, recorded };
}

export class InboundWorkflow extends WorkflowEntrypoint<Env, InboundParams> {
	async run(event: Readonly<WorkflowEvent<InboundParams>>, step: WorkflowStep): Promise<InboundSummary> {
		return inbound(this.env, event.payload, event.instanceId, step, new Date(event.timestamp));
	}
}
