// Feature routes (delights). Mounted in src/index.ts.

import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const delightsRoutes = new Hono<AppEnv>();
