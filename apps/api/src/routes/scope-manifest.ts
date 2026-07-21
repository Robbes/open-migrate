// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * GET /api/scope-manifest — the static §11.2 "what migrates / partial / does NOT migrate" manifest
 * for the pre-sync confirm screen (workplan 0013 T4). No auth/tenant scoping: it's a global,
 * public promise set, not tenant data.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { SCOPE_MANIFEST } from '@openmig/shared';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json(SCOPE_MANIFEST);
});

export default router;
