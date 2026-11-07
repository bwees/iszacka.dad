// OWNER: feeds agent.
// /mcp: the Model Context Protocol endpoint. Mounted from ./api, which adds CORS and the
// RL_API rate limit. The protocol logic lives in lib/feeds-mcp.ts; this file only wires
// the request's state and data sources into it.

import { Hono } from 'hono';
import { getCheckTotal } from '../lib/counters';
import { type McpDeps, handleMcpHttp } from '../lib/feeds-mcp';
import { dadForecast } from '../lib/forecast';
import { babySize } from '../lib/fruit';
import { siteUrl } from '../lib/site';
import { londonDate } from '../lib/time';
import { listUpdates } from '../lib/updates';
import type { AppEnv } from '../types';

export const MCP_PATH = '/mcp';

export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.all(MCP_PATH, (c) => {
	const env = c.env;
	const deps: McpDeps = {
		state: c.get('state'),
		today: londonDate(),
		siteUrl: siteUrl(env),
		getChecks: () => getCheckTotal(env),
		listUpdates: (opts) => listUpdates(env, opts),
		forecast: dadForecast,
		babySize,
	};
	return handleMcpHttp(c.req.raw, deps);
});
