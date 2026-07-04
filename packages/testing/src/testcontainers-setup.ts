// Copyright 2026 OpenHands Agent (Apache-2.0)
// Testcontainers setup for integration tests.
// Spins up Postgres and Stalwart programmatically.
//
// IMPORTANT: Stalwart v0.16.10 requires a two-phase startup:
//   Phase 1: Recovery mode container - provisions accounts via stalwart-cli
//   Phase 2: Normal mode container - starts with mail listeners enabled
// Both phases share the same data directory (host bind-mount).

import { GenericContainer, Wait, Network } from 'testcontainers';
import type { StartedTestContainer, StoppedTestContainer } from 'testcontainers';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TestEnvironment {
  postgres: {
    host: string;
    port: number;
    connectionString: string;
    container: StartedTestContainer;
  };
  stalwart: {
    imapHost: string;
    imapPort: number;
    jmapUrl: string;
    jmapUsername: string;
    jmapPassword: string;
    container: StartedTestContainer;
  };
}

/**
 * Create the Stalwart configuration file.
 * Stalwart v0.16 config.json contains ONLY the DataStore configuration at the ROOT level.
 * Format: {"@type": "RocksDb", "path": "/opt/stalwart/data"}
 */
function createStalwartConfig(configPath: string): void {
  const config = {
    '@type': 'RocksDb' as const,
    path: '/opt/stalwart/data',
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[StalwartSetup] Config written to ${configPath}`);
}

/**
 * Start Stalwart in two phases:
 *   Phase 1: Recovery mode - provision accounts via stalwart-cli
 *   Phase 2: Normal mode - start with mail listeners enabled
 */
async function startStalwart(): Promise<{
  jmapUrl: string;
  imapHost: string;
  imapPort: number;
  container: StartedTestContainer;
}> {
  // Create a host-bind mount directory for Stalwart data
  // This persists between container A (provisioning) and container B (production)
  const dataDir = mkdtempSync(path.join(tmpdir(), 'stalwart-data-'));
  console.log(`[StalwartSetup] Data directory: ${dataDir}`);

  // Create config file
  const configPath = path.join(tmpdir(), `stalwart-config-${Date.now()}.json`);
  createStalwartConfig(configPath);

  // Generate recovery admin credentials
  const recoveryPassword = 'provision_' + Math.random().toString(36).slice(2, 10);
  const provisionAdmin = `admin:${recoveryPassword}`;
  const [adminUser, adminPass] = provisionAdmin.split(':');

  console.log('[StalwartSetup] Phase 1: Starting recovery mode container...');

  // Phase 1: Provisioning container in recovery mode
  const containerA = await new GenericContainer('stalwartlabs/stalwart:v0.16.10')
    .withBindMounts([
      { source: dataDir, target: '/opt/stalwart/data' },
      { source: configPath, target: '/etc/stalwart/config.json' },
    ])
    .withEnvironment({
      STALWART_HOSTNAME: 'mail.stalwart.local',
      STALWART_RECOVERY_MODE: '1',
      STALWART_RECOVERY_ADMIN: provisionAdmin,
    })
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp('/', 8080))
    .withStartupTimeout(60000)
    .start();

  const mgmtPort = containerA.getMappedPort(8080);
  const mgmtHost = containerA.getHost();

  console.log(`[StalwartSetup] Recovery listener ready at http://${mgmtHost}:${mgmtPort}`);

  // Wait a moment for recovery listener to be fully ready
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Log container A startup to verify recovery mode
  const logsA = await containerA.logs();
  let logOutput = '';
  for await (const chunk of logsA) {
    logOutput += chunk.toString();
  }
  console.log('[StalwartSetup] Container A logs (first 1000 chars):');
  console.log(logOutput.substring(0, 1000));

  // Verify we're in recovery mode (should NOT see bootstrap banner)
  if (logOutput.includes('bootstrap mode')) {
    console.error('[StalwartSetup] ERROR: Container started in bootstrap mode, not recovery mode!');
    console.error('[StalwartSetup] Recovery mode requires config.json to be present');
    await containerA.stop();
    throw new Error('Stalwart started in wrong mode - expected recovery, got bootstrap');
  }

  // Provision accounts via stalwart-cli
  console.log('[StalwartSetup] Provisioning accounts via stalwart-cli...');
  
  const plan = [
    { '@type': 'upsert', object: 'Domain', matchOn: ['name'], value: { 'dom-a': { name: 'dev.local' } } },
    { '@type': 'upsert', object: 'Account', matchOn: ['name'], value: { src: {
        '@type': 'User', name: 'source', domainId: '#dom-a',
        credentials: { '0': { '@type': 'Password', secret: 'source_password' } },
        roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' },
    } } },
    { '@type': 'upsert', object: 'Account', matchOn: ['name'], value: { tgt: {
        '@type': 'User', name: 'target', domainId: '#dom-a',
        credentials: { '0': { '@type': 'Password', secret: 'target_password' } },
        roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' },
    } } },
  ].map((op) => JSON.stringify(op)).join('\n');

  try {
    // Use the separate stalwart-cli Docker image to provision accounts
    const cliContainer = await new GenericContainer('ghcr.io/stalwartlabs/cli:latest')
      .withEnvironment({
        STALWART_URL: `http://${mgmtHost}:${mgmtPort}`,
        STALWART_USER: adminUser,
        STALWART_PASSWORD: adminPass,
      })
      .withCopyContentToContainer([
        { content: plan, target: '/tmp/plan.json' },
      ])
      .withCommand(['apply', '--file', '/tmp/plan.json'])
      .withStartupTimeout(30000)
      .start();
    
    const cliLogs = await cliContainer.logs();
    let cliOutput = '';
    for await (const chunk of cliLogs) {
      cliOutput += chunk.toString();
    }
    console.log('[StalwartSetup] stalwart-cli output:', cliOutput);
    
    await cliContainer.stop();
  } catch (err: any) {
    console.error('[StalwartSetup] stalwart-cli failed:', err.message);
    await containerA.stop();
    throw new Error(`Failed to provision accounts: ${err.message}`);
  }

  // Verify accounts were created
  console.log('[StalwartSetup] Verifying accounts...');
  try {
    const verifyContainer = await new GenericContainer('ghcr.io/stalwartlabs/cli:latest')
      .withEnvironment({
        STALWART_URL: `http://${mgmtHost}:${mgmtPort}`,
        STALWART_USER: adminUser,
        STALWART_PASSWORD: adminPass,
      })
      .withCommand(['get', 'Account'])
      .withStartupTimeout(30000)
      .start();
    
    const verifyLogs = await verifyContainer.logs();
    let verifyOutput = '';
    for await (const chunk of verifyLogs) {
      verifyOutput += chunk.toString();
    }
    console.log('[StalwartSetup] Accounts:', verifyOutput);
    
    await verifyContainer.stop();
  } catch (err: any) {
    console.warn('[StalwartSetup] Warning: Could not verify accounts:', err.message);
  }

  // Stop provisioning container
  console.log('[StalwartSetup] Stopping recovery container...');
  await containerA.stop();

  console.log('[StalwartSetup] Phase 2: Starting normal mode container...');

  // Phase 2: Production container without recovery mode
  const containerB = await new GenericContainer('stalwartlabs/stalwart:v0.16.10')
    .withBindMounts([
      { source: dataDir, target: '/opt/stalwart/data' },
      { source: configPath, target: '/etc/stalwart/config.json' },
    ])
    .withEnvironment({
      STALWART_HOSTNAME: 'mail.stalwart.local',
    })
    .withExposedPorts(8080, 143)
    .withWaitStrategy(
      Wait.forHttp('/.well-known/jmap', 8080)
        .withStartupTimeout(120000)
    )
    .start();

  // Log container B startup to verify normal mode with mail listeners
  const logsB = await containerB.logs();
  logOutput = '';
  for await (const chunk of logsB) {
    logOutput += chunk.toString();
    console.log(`[StalwartSetup] ${chunk.toString().trim()}`);
  }
  console.log('[StalwartSetup] Container B full logs:');
  console.log(logOutput);

  // Verify mail listeners started
  if (!logOutput.includes('listening') && !logOutput.includes('IMAP')) {
    console.warn('[StalwartSetup] Warning: Could not confirm mail listeners from logs');
  }

  const stalwartHost = containerB.getHost();
  const imapPort = containerB.getMappedPort(143);
  const jmapUrl = `http://${stalwartHost}:${containerB.getMappedPort(8080)}`;

  console.log(`[StalwartSetup] Stalwart ready - JMAP: ${jmapUrl}, IMAP: ${stalwartHost}:${imapPort}`);

  return {
    jmapUrl,
    imapHost: stalwartHost,
    imapPort,
    container: containerB,
  };
}

/**
 * Start the test environment using Testcontainers.
 * Spins up Postgres and Stalwart (two-phase startup) containers.
 */
export async function startTestEnvironment(): Promise<TestEnvironment> {
  console.log('[Testcontainers] Starting test environment...');

  // Create a shared network for containers
  const network = await new Network().start();

  // Start Postgres container
  console.log('[Testcontainers] Starting Postgres container...');
  const postgresContainer = await new GenericContainer('postgres:18-alpine')
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: 'openmig',
      POSTGRES_USER: 'openmig',
      POSTGRES_PASSWORD: 'openmig',
      POSTGRES_INITDB_ARGS: '-E UTF8',
    })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/))
    .withStartupTimeout(120000)
    .withNetwork(network)
    .withNetworkAliases('postgres')
    .start();

  const postgresPort = postgresContainer.getMappedPort(5432);
  const postgresHost = postgresContainer.getHost();
  const postgresConnectionString = `postgres://openmig:openmig@${postgresHost}:${postgresPort}/openmig`;

  console.log(`[Testcontainers] Postgres ready at ${postgresConnectionString}`);

  // Start Stalwart (two-phase: provision then run)
  const stalwart = await startStalwart();

  const stalwartEnv: TestEnvironment['stalwart'] = {
    imapHost: stalwart.imapHost,
    imapPort: stalwart.imapPort,
    jmapUrl: stalwart.jmapUrl,
    jmapUsername: 'source@dev.local',
    jmapPassword: 'source_password',
    container: stalwart.container,
  };

  return {
    postgres: {
      host: postgresHost,
      port: postgresPort,
      connectionString: postgresConnectionString,
      container: postgresContainer,
    },
    stalwart: stalwartEnv,
  };
}

/**
 * Stop the test environment and clean up all containers.
 */
export async function stopTestEnvironment(env: TestEnvironment): Promise<void> {
  console.log('[Testcontainers] Stopping containers...');
  await env.postgres.container.stop();
  await env.stalwart.container.stop();
  console.log('[Testcontainers] All containers stopped.');
}
