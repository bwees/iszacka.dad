// Feature routes (social). Mounted in src/index.ts.

import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const socialRoutes = new Hono<AppEnv>();
