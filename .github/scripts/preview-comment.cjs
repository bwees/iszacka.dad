// @ts-check
// The one PR comment that tracks a preview deploy. Used by .github/workflows/preview.yml via
// actions/github-script:
//
//   const run = require('./.github/scripts/preview-comment.cjs');
//   await run({ github, context });
//
// Everything it needs arrives in environment variables (never interpolated into code):
//   PREVIEW_STATE   building | ready | failed | deleted
//   PR_NUMBER       the pull request number
//   WORKER_NAME     e.g. iszacka-dad-pr12
//   PREVIEW_DB      the shared preview D1 database name
//   HEAD_SHA        the commit being previewed (optional)
//   PREVIEW_URL     the workers.dev URL (for `ready`)
//   SMOKE_OUTCOME   success | failure | skipped | cancelled (optional)
//
// The comment is found again by a hidden marker, and only ever one is created per PR.
'use strict';

const MARKER = '<!-- iszacka.dad preview -->';
const HEADING = '### 🍼 Preview: is this PR a dad?';
const STATES = /** @type {const} */ (['building', 'ready', 'failed', 'deleted']);

/**
 * @typedef {(typeof STATES)[number]} PreviewState
 * @typedef {{
 *   state: PreviewState,
 *   sha: string,
 *   worker: string,
 *   database: string,
 *   runUrl: string,
 *   url?: string,
 *   smoke?: string,
 * }} CommentInput
 */

/** @param {string} value */
function isPreviewState(value) {
	return /** @type {readonly string[]} */ (STATES).includes(value);
}

/** Markdown-safe inline code (backticks can't break out of it). @param {string} value */
function code(value) {
	return '`' + String(value).replace(/`/g, "'") + '`';
}

/** Only ever link to an https URL we built ourselves. @param {string | undefined} value */
function safeUrl(value) {
	if (!value) return '';
	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? url.origin : '';
	} catch {
		return '';
	}
}

/** @param {string | undefined} outcome @param {string} runUrl */
function smokeSummary(outcome, runUrl) {
	switch (outcome) {
		case 'success':
			return '✅ passed';
		case 'failure':
			return `❌ failed ([log](${runUrl}))`;
		case 'skipped':
		case 'cancelled':
			return '⏭️ skipped';
		default:
			return '❔ not run';
	}
}

/**
 * The comment body for a preview state. Pure, so it's unit-tested.
 * @param {CommentInput} input
 * @returns {string}
 */
function buildBody(input) {
	const sha = code(String(input.sha || '').slice(0, 7) || 'unknown');
	const worker = code(input.worker);
	const lines = [MARKER, HEADING, ''];

	switch (input.state) {
		case 'building':
			lines.push(`⏳ Building a preview of ${sha}… ([watch it happen](${input.runUrl}))`);
			break;
		case 'ready': {
			const url = safeUrl(input.url);
			if (!url) {
				lines.push(`❌ The preview of ${sha} deployed, but its URL went missing. [See the logs](${input.runUrl}).`);
				break;
			}
			lines.push(
				`✅ Deployed ${sha} to **${url}**`,
				'',
				'| Page | Link |',
				'|---|---|',
				`| The answer | ${url}/ |`,
				`| API | ${url}/api/status |`,
				`| Dad Ledger | ${url}/ledger |`,
				`| Status page | ${url}/status |`,
				// Previews are public: never print the password, only say where it lives.
				`| Admin | ${url}/admin (password: the ${code('PREVIEW_ADMIN_PASSWORD')} repo secret; admin is off without it) |`,
				`| Smoke test | ${smokeSummary(input.smoke, input.runUrl)} |`,
				'',
				`<sub>Worker ${worker} · D1 ${code(input.database)} (shared by every preview) · Turnstile test keys · deleted when this PR closes.</sub>`,
			);
			break;
		}
		case 'failed':
			lines.push(`❌ The preview of ${sha} failed to deploy. [See the logs](${input.runUrl}).`);
			break;
		case 'deleted':
			lines.push(`🧹 This PR is closed, so the preview Worker ${worker} has been deleted. It was lovely while it lasted.`);
			break;
	}
	return lines.join('\n');
}

/**
 * @param {{ user?: { type?: string } | null, body?: string | null }} comment
 */
function isPreviewComment(comment) {
	return comment.user?.type === 'Bot' && Boolean(comment.body?.includes(MARKER));
}

/**
 * Create or update the preview comment. A `deleted` state never creates a new comment.
 * @param {{ github: any, context: any }} tools
 */
async function run({ github, context }) {
	const env = process.env;
	const state = env.PREVIEW_STATE ?? '';
	if (!isPreviewState(state)) throw new Error(`PREVIEW_STATE must be one of ${STATES.join(', ')}; got "${state}"`);
	const issueNumber = Number(env.PR_NUMBER);
	if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error(`PR_NUMBER is not a PR number: "${env.PR_NUMBER}"`);

	const { owner, repo } = context.repo;
	const body = buildBody({
		state: /** @type {PreviewState} */ (state),
		sha: env.HEAD_SHA || context.sha || '',
		worker: env.WORKER_NAME || `pr${issueNumber}`,
		database: env.PREVIEW_DB || 'iszackadad_preview',
		runUrl: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
		url: env.PREVIEW_URL,
		smoke: env.SMOKE_OUTCOME,
	});

	const comments = await github.paginate(github.rest.issues.listComments, {
		owner,
		repo,
		issue_number: issueNumber,
		per_page: 100,
	});
	const existing = comments.find(isPreviewComment);
	if (existing) {
		await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
	} else if (state !== 'deleted') {
		await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
	}
}

module.exports = run;
module.exports.run = run;
module.exports.buildBody = buildBody;
module.exports.isPreviewComment = isPreviewComment;
module.exports.MARKER = MARKER;
