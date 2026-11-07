// Feature routes (terminal). Mounted in src/index.ts.

import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const terminalRoutes = new Hono<AppEnv>();
