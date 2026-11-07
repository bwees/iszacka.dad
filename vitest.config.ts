import { defineConfig } from 'vitest/config';

// Unit tests for pure logic (feeds, scoring, VAPID, ledger hashing, parsing...).
// End-to-end behaviour is covered by scripts/smoke.sh against `wrangler dev`.
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
	},
});
