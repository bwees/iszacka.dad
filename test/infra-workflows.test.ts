// GitHub workflows and the scripts they lean on: the preview comment builder, plus static
// guards against the classic CI foot-guns (script injection, unpinned actions, fork PRs
// with secrets, undocumented secrets, placeholders that drifted out of wrangler.toml).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ROOT } from './infra-helpers';

type PreviewState = 'building' | 'ready' | 'failed' | 'deleted';

interface CommentInput {
	state: PreviewState;
	sha: string;
	worker: string;
	database: string;
	runUrl: string;
	url?: string;
	smoke?: string;
}

interface Comment {
	id: number;
	user?: { type?: string } | null;
	body?: string | null;
}

interface PreviewCommentModule {
	(tools: { github: unknown; context: unknown }): Promise<void>;
	buildBody(input: CommentInput): string;
	isPreviewComment(comment: Comment): boolean;
	MARKER: string;
}

const previewComment = createRequire(import.meta.url)('../.github/scripts/preview-comment.cjs') as PreviewCommentModule;

const WORKFLOW_DIR = join(ROOT, '.github/workflows');
const workflows = Object.fromEntries(
	readdirSync(WORKFLOW_DIR)
		.filter((name) => name.endsWith('.yml'))
		.map((name) => [name, readFileSync(join(WORKFLOW_DIR, name), 'utf8')]),
);
const allWorkflows = Object.values(workflows).join('\n');
const setupDoc = readFileSync(join(ROOT, 'docs/SETUP.md'), 'utf8');
const wranglerToml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');

const base: CommentInput = {
	state: 'ready',
	sha: '0123456789abcdef',
	worker: 'iszacka-dad-pr7',
	database: 'iszackadad_preview',
	runUrl: 'https://github.com/zackpollard/iszacka.dad/actions/runs/1',
	url: 'https://iszacka-dad-pr7.example.workers.dev',
	smoke: 'success',
};

describe('preview comment', () => {
	it('always starts with the marker, whatever the state', () => {
		for (const state of ['building', 'ready', 'failed', 'deleted'] as const) {
			expect(previewComment.buildBody({ ...base, state }).startsWith(previewComment.MARKER)).toBe(true);
		}
	});

	it('lists the preview links when ready', () => {
		const body = previewComment.buildBody(base);
		expect(body).toContain('`0123456`');
		expect(body).toContain('https://iszacka-dad-pr7.example.workers.dev/api/status');
		expect(body).toContain('https://iszacka-dad-pr7.example.workers.dev/admin');
		expect(body).toContain('✅ passed');
	});

	it('never publishes a preview admin password', () => {
		const body = previewComment.buildBody(base);
		expect(body).not.toContain('password: `preview`');
		expect(body).toContain('PREVIEW_ADMIN_PASSWORD');
		// Previews are public: the password is a secret, never a committed var.
		expect(wranglerToml).not.toMatch(/^\s*ADMIN_PASSWORD\s*=/m);
		expect(workflows['preview.yml']).toContain('--secrets-file');
		expect(workflows['preview.yml']).not.toMatch(/--var[^\n]*ADMIN_PASSWORD/);
	});

	it('reports a failed smoke test with a link to the run', () => {
		const body = previewComment.buildBody({ ...base, smoke: 'failure' });
		expect(body).toContain(`❌ failed ([log](${base.runUrl}))`);
	});

	it('never links to anything but an https origin', () => {
		const body = previewComment.buildBody({ ...base, url: 'javascript:alert(1)' });
		expect(body).not.toContain('javascript:');
		expect(body).toContain('URL went missing');
		const trimmed = previewComment.buildBody({ ...base, url: 'https://x.workers.dev/some/path?q=1' });
		expect(trimmed).toContain('**https://x.workers.dev**');
	});

	it("can't be broken out of inline code by a backtick", () => {
		const body = previewComment.buildBody({ ...base, state: 'deleted', worker: 'evil`name' });
		expect(body).toContain("`evil'name`");
	});

	it('only recognises its own bot comments', () => {
		expect(previewComment.isPreviewComment({ id: 1, user: { type: 'Bot' }, body: `${previewComment.MARKER}\nhi` })).toBe(true);
		expect(previewComment.isPreviewComment({ id: 2, user: { type: 'User' }, body: `${previewComment.MARKER}\nhi` })).toBe(false);
		expect(previewComment.isPreviewComment({ id: 3, user: { type: 'Bot' }, body: 'some other bot' })).toBe(false);
	});

	describe('run()', () => {
		const context = {
			repo: { owner: 'zackpollard', repo: 'iszacka.dad' },
			sha: 'ffffffffffffffff',
			serverUrl: 'https://github.com',
			runId: 42,
		};

		function fakeGithub(existing: Comment[]) {
			const listComments = vi.fn();
			const createComment = vi.fn(async () => ({}));
			const updateComment = vi.fn(async () => ({}));
			return {
				client: {
					paginate: vi.fn(async () => existing),
					rest: { issues: { listComments, createComment, updateComment } },
				},
				createComment,
				updateComment,
			};
		}

		async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
			const saved = { ...process.env };
			Object.assign(process.env, { HEAD_SHA: '', PREVIEW_URL: '', SMOKE_OUTCOME: '', WORKER_NAME: 'iszacka-dad-pr7', PREVIEW_DB: 'iszackadad_preview' }, env);
			try {
				await fn();
			} finally {
				process.env = saved;
			}
		}

		it('creates the comment the first time', async () => {
			const github = fakeGithub([{ id: 9, user: { type: 'User' }, body: 'nice PR' }]);
			await withEnv({ PREVIEW_STATE: 'building', PR_NUMBER: '7' }, () => previewComment({ github: github.client, context }));
			expect(github.createComment).toHaveBeenCalledTimes(1);
			expect(github.createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 7, owner: 'zackpollard' }));
			expect(github.updateComment).not.toHaveBeenCalled();
		});

		it('updates the existing comment after that', async () => {
			const github = fakeGithub([{ id: 5, user: { type: 'Bot' }, body: `${previewComment.MARKER}\nold` }]);
			await withEnv({ PREVIEW_STATE: 'ready', PR_NUMBER: '7', PREVIEW_URL: base.url ?? '' }, () =>
				previewComment({ github: github.client, context }),
			);
			expect(github.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 5 }));
			expect(github.createComment).not.toHaveBeenCalled();
		});

		it("doesn't create a comment just to say the preview was deleted", async () => {
			const github = fakeGithub([]);
			await withEnv({ PREVIEW_STATE: 'deleted', PR_NUMBER: '7' }, () => previewComment({ github: github.client, context }));
			expect(github.createComment).not.toHaveBeenCalled();
			expect(github.updateComment).not.toHaveBeenCalled();
		});

		it('rejects a nonsense state or PR number', async () => {
			const github = fakeGithub([]);
			await withEnv({ PREVIEW_STATE: 'exploded', PR_NUMBER: '7' }, async () => {
				await expect(previewComment({ github: github.client, context })).rejects.toThrow(/PREVIEW_STATE/);
			});
			await withEnv({ PREVIEW_STATE: 'ready', PR_NUMBER: 'seven' }, async () => {
				await expect(previewComment({ github: github.client, context })).rejects.toThrow(/PR_NUMBER/);
			});
		});
	});
});

describe('workflows', () => {
	it('has CI, deploy, preview and setup workflows', () => {
		expect(Object.keys(workflows).sort()).toEqual(['ci.yml', 'deploy.yml', 'preview.yml', 'setup.yml']);
	});

	it('only runs setup by hand, and never alongside a production deploy', () => {
		const setup = workflows['setup.yml'] ?? '';
		expect(setup).toMatch(/^on:\n\s+workflow_dispatch:/m);
		expect(setup).not.toMatch(/^\s+(push|pull_request\w*):/m);
		expect(setup).toMatch(/concurrency:\n\s+group: deploy-production\n\s+cancel-in-progress: false/);
		expect(setup).toContain('bash scripts/setup-cloudflare.sh');
		for (const secret of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'RESEND_API_KEY']) expect(setup).toContain(`secrets.${secret}`);
	});

	it('syncs RESEND_API_KEY on deploy, and leaves setup-owned secrets alone unless overridden', () => {
		const deploy = workflows['deploy.yml'] ?? '';
		expect(deploy).toContain('RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}');
		expect(deploy).toMatch(/if \[\[ -z \$value \]\]; then[\s\S]*continue/);
	});

	it('never interpolates attacker-controlled text into a run step', () => {
		const dangerous =
			/\$\{\{\s*github\.(head_ref|event\.(pull_request\.(title|body|head\.ref|head\.label)|head_commit\.message|commits|comment|issue|review))/;
		for (const [name, text] of Object.entries(workflows)) {
			expect(dangerous.test(text), `${name} interpolates untrusted input`).toBe(false);
		}
	});

	it('pins every action to a major version or a commit', () => {
		const uses = [...allWorkflows.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
		expect(uses.length).toBeGreaterThan(5);
		for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@(v\d+(\.\d+)*|[0-9a-f]{40})$/);
	});

	it("doesn't leave the checkout token lying around for later steps", () => {
		const checkouts = allWorkflows.match(/uses: actions\/checkout@/g) ?? [];
		const persisted = allWorkflows.match(/persist-credentials: false/g) ?? [];
		expect(persisted.length).toBe(checkouts.length);
	});

	it('keeps secrets away from fork PRs', () => {
		const preview = workflows['preview.yml'] ?? '';
		expect(preview).toMatch(/^on:\n\s+pull_request:/m);
		expect(preview).not.toContain('pull_request_target');
		const guards = preview.match(/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/g) ?? [];
		expect(guards.length).toBe(2);
	});

	it('documents every secret the workflows use', () => {
		const secrets = new Set([...allWorkflows.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1] ?? ''));
		expect(secrets.size).toBeGreaterThan(2);
		for (const secret of secrets) expect(setupDoc, `${secret} isn't in docs/SETUP.md`).toContain(`\`${secret}\``);
	});

	it('never cancels a production deploy halfway through', () => {
		const deploy = workflows['deploy.yml'] ?? '';
		expect(deploy).toMatch(/concurrency:\n\s+group: deploy-production\n\s+cancel-in-progress: false/);
		expect(deploy).toContain('workflow_dispatch');
	});

	it('runs the full smoke test, button and all, in CI', () => {
		expect(workflows['ci.yml']).toMatch(/bash scripts\/smoke\.sh "\$DEV_URL" --mutate/);
		expect(workflows['ci.yml']).toContain('--infer-origin-from-routes=false');
	});

	it('only calls scripts that exist', () => {
		const referenced = new Set([...allWorkflows.matchAll(/(?:\.\/)?((?:\.github\/)?scripts\/[\w.-]+\.(?:sh|cjs))/g)].map((m) => m[1] ?? ''));
		expect(referenced.size).toBeGreaterThan(2);
		for (const path of referenced) expect(existsSync(join(ROOT, path)), path).toBe(true);
	});
});

describe('wrangler.toml contract the workflows rely on', () => {
	const count = (needle: string) => wranglerToml.split(needle).length - 1;

	it('has each D1 placeholder exactly once', () => {
		expect(count('"PLACEHOLDER_D1_ID"')).toBe(1);
		expect(count('"PLACEHOLDER_D1_PREVIEW_ID"')).toBe(1);
	});

	it('has the preview Workflow name exactly once (previews rename it per PR)', () => {
		expect(count('"iszacka-dad-announce-preview"')).toBe(1);
	});

	it('names the Worker and databases the workflows expect', () => {
		expect(wranglerToml).toMatch(/^name = "iszacka-dad"$/m);
		expect(wranglerToml).toContain('database_name = "iszackadad"');
		expect(wranglerToml).toContain('database_name = "iszackadad_preview"');
		expect(wranglerToml).toMatch(/^\[env\.preview\]$/m);
	});
});
