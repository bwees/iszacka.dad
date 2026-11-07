// Shared helpers for the infra tests (CI scripts, workflows, docs). Not a test file itself.

import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url).href);

/**
 * A throwaway directory for one test file, under node_modules/.cache (git-ignored, on disk
 * rather than a RAM-backed /tmp). Call the returned cleanup in afterAll.
 */
export function scratchDir(label: string): { dir: string; cleanup: () => void } {
	const parent = join(ROOT, 'node_modules', '.cache', 'iszackadad-infra-tests');
	mkdirSync(parent, { recursive: true });
	const dir = mkdtempSync(join(parent, `${label}-`));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write an executable script. */
export function writeExecutable(path: string, contents: string): string {
	writeFileSync(path, contents);
	chmodSync(path, 0o755);
	return path;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run a command asynchronously (so an in-process mock server can still answer). Never rejects. */
export function run(
	command: string,
	args: string[],
	opts: { env?: Record<string, string | undefined>; cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				cwd: opts.cwd ?? ROOT,
				env: { ...process.env, ...opts.env },
				timeout: opts.timeoutMs ?? 30_000,
				maxBuffer: 10 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});
}
