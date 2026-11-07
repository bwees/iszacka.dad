// Feature routes (corporate). Mounted in src/index.ts.

import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const corporateRoutes = new Hono<AppEnv>();
