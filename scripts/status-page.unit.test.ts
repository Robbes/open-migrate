// Copyright 2026 The Ownpace authors (Apache-2.0)

/**
 * The status page's configuration says what we think it says (workplan 0094).
 *
 * A status page is a peculiar thing to test: every mistake in it looks like an
 * outage, and an outage is the one state nobody investigates as a bug. A check
 * pointed at the wrong field is permanently red, and permanently red reads as
 * "that provider is having a bad month" for as long as anybody can stand it.
 *
 * So the case that earns this file is `[BODY]` fields exist on /api/ready:
 * `gatus.yaml` asserts on `[BODY].signIn`, and if `ready.ts` ever renames that
 * field the page goes red forever and looks like a real sign-in outage. Nothing
 * else in the repository connects those two files.
 *
 * In `scripts/` rather than beside `deploy/compose/gatus.yaml`, because
 * `deploy/` is in no tsconfig and a test there fails lint with a parser error —
 * the same trap `idp-wiring.unit.test.ts` was moved here for.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Endpoint {
  name: string;
  group?: string;
  url: string;
  conditions: string[];
}
interface GatusConfig {
  storage?: { type?: string; path?: string };
  ui?: { buttons?: Array<{ name: string; link: string }> };
  endpoints: Endpoint[];
}

const config = parse(
  readFileSync(join(ROOT, 'deploy/compose/gatus.yaml'), 'utf8'),
) as GatusConfig;
const composeText = readFileSync(join(ROOT, 'deploy/compose/managed.yml'), 'utf8');
/**
 * Parsed, not grepped. The first version of the `depends_on` case below matched
 * the string in the COMMENT explaining why there is no `depends_on`, and failed
 * on a service that was correct — prose about a key is not the key.
 */
const compose = parse(composeText) as {
  services: Record<string, { image?: string; volumes?: string[]; depends_on?: unknown }>;
  volumes?: Record<string, unknown>;
};
function gatus(): NonNullable<(typeof compose)['services'][string]> {
  const service = compose.services.gatus;
  // Asserted here rather than at every call site: a missing service should
  // fail with "the gatus service is gone", not with a null dereference three
  // cases later.
  if (!service) throw new Error('managed.yml has no `gatus` service');
  return service;
}
const readySource = readFileSync(join(ROOT, 'apps/api/src/routes/ready.ts'), 'utf8');

describe('what the page watches', () => {
  it('groups every endpoint, so nothing lands on the page uncategorised', () => {
    expect(config.endpoints.length).toBeGreaterThan(5);
    for (const endpoint of config.endpoints) {
      expect(endpoint.group, `${endpoint.name} has no group`).toBeTruthy();
    }
    expect(new Set(config.endpoints.map((e) => e.group))).toEqual(
      new Set(['Ownpace', 'Sources', 'Targets']),
    );
  });

  it('probes the address a BROWSER uses, never an internal service name', () => {
    // `http://api:3001` would prove the container can talk to itself and say
    // nothing about the reverse proxy, the certificate, or the same-origin
    // /api proxy — every hop a customer actually goes through.
    for (const endpoint of config.endpoints.filter((e) => e.group === 'Ownpace')) {
      expect(endpoint.url, `${endpoint.name} bypasses the public path`).toContain(
        '${STATUS_WEB_URL}',
      );
    }
    for (const endpoint of config.endpoints) {
      expect(endpoint.url).not.toMatch(/https?:\/\/(api|web|localhost|postgres|pgbouncer)[:/]/);
    }
  });
});

describe('the checks line up with what the API actually answers', () => {
  it('asserts only on fields /api/ready returns', () => {
    // THE CASE THIS FILE EXISTS FOR. A renamed field makes the page red
    // forever, and a red status page is the one bug nobody files.
    const declared = [...readySource.matchAll(/readonly (\w+): CheckState;/g)].map((m) => m[1]);
    expect(declared, 'the Readiness interface moved — this scan needs updating').toContain(
      'database',
    );

    const asserted = config.endpoints
      .flatMap((e) => e.conditions)
      .flatMap((c) => [...c.matchAll(/\[BODY\]\.(\w+)/g)].map((m) => m[1]));
    expect(asserted.length, 'no [BODY] conditions found — the scan is vacuous').toBeGreaterThan(0);

    for (const field of asserted) {
      // `status` is the roll-up, which is a field too.
      expect(
        [...declared, 'status'],
        `gatus.yaml asserts on [BODY].${field}, which /api/ready does not return`,
      ).toContain(field);
    }
  });

  it('reads the FIELD for database and sign-in, not the status code', () => {
    // Readiness answers 200 while degraded, on purpose — a load balancer that
    // pulled the API out of rotation over a sign-in outage would turn a partial
    // problem into a total one. So `[STATUS] == 200` would be green during
    // exactly the degradation these two rows exist to show.
    for (const name of ['Database', 'Sign-in']) {
      const endpoint = config.endpoints.find((e) => e.name === name)!;
      expect(endpoint, `${name} endpoint is gone`).toBeTruthy();
      expect(endpoint.conditions.join(' ')).toContain('[BODY].');
      expect(endpoint.conditions).not.toContain('[STATUS] == 200');
    }
  });
});

describe('the page keeps its own record', () => {
  it('stores history in sqlite, NOT in the Postgres it is watching', () => {
    // History in the monitored database disappears at the moment somebody
    // wants to read it, which is the whole failure this page exists to record.
    expect(config.storage?.type).toBe('sqlite');
    expect(config.storage?.path).toMatch(/^\/data\//);
    expect(gatus().volumes ?? []).toContain('gatus_data:/data');
    expect(compose.volumes ?? {}, 'the named volume is not declared').toHaveProperty('gatus_data');
  });
});

describe('it says what it cannot do', () => {
  it('carries the caveat as a visible button, not only a comment', () => {
    // The owner chose to run this inside the stack it watches, on the explicit
    // condition that the page says so (2026-08-22). A caveat in a YAML comment
    // is a caveat no visitor reads.
    const button = config.ui?.buttons?.find((b) => /cannot tell you/i.test(b.name));
    expect(button, 'the honesty button is gone').toBeTruthy();
    expect(button!.link).toMatch(/status-page\.md$/);
  });

  it('links to a document that exists and leads with the limit', () => {
    const doc = join(ROOT, 'docs/status-page.md');
    expect(existsSync(doc)).toBe(true);
    const text = readFileSync(doc, 'utf8');
    // The limitation is the first thing after the title, not a footnote.
    expect(text.slice(0, 900)).toMatch(/cannot tell you that Ownpace is down/i);
  });
});

describe('the service that serves it', () => {
  it('pins a version rather than following a moving tag', () => {
    // `stable` and `latest` both move under you, which for the thing that tells
    // you whether anything is wrong is the wrong place to find out.
    expect(gatus().image).toMatch(/^ghcr\.io\/twin\/gatus:v\d+\.\d+\.\d+$/);
  });

  it('does not wait for what it is watching before it starts', () => {
    // A status page with `depends_on: postgres` is a status page that is absent
    // exactly when Postgres is the problem.
    expect(gatus().depends_on).toBeUndefined();
    expect(gatus().volumes ?? [], 'the config should be mounted read-only').toContain(
      './gatus.yaml:/config/config.yaml:ro',
    );
  });
});
