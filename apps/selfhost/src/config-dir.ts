// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Load a directory of mapping configs (workplan 0010 T2). The self-host appliance
 * reads every `*.json` under its config dir (default `/data/config`) and validates
 * each with the shared `parseMappingConfigJson` — the same schema the managed
 * edition uses, so there is one config contract.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMappingConfigJson, type MappingConfig } from '@openmig/shared';

export interface LoadedMapping {
  readonly path: string;
  readonly config: MappingConfig;
}

/**
 * Load and validate all mapping JSONs in `dir` (sorted by filename). Throws with
 * the offending path if any file is invalid — fail fast, never skip silently.
 */
export function loadConfigDir(dir: string): LoadedMapping[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const loaded: LoadedMapping[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const path = join(dir, file);
    let config: MappingConfig;
    try {
      config = parseMappingConfigJson(readFileSync(path, 'utf-8'));
    } catch (err) {
      throw new Error(
        `Invalid mapping config ${path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const priorPath = seen.get(config.mappingId);
    if (priorPath) {
      throw new Error(
        `Duplicate mappingId '${config.mappingId}' in ${path} (already defined in ${priorPath})`,
      );
    }
    seen.set(config.mappingId, path);
    loaded.push({ path, config });
  }
  return loaded;
}
