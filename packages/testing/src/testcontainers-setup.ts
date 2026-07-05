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
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Path to stalwart-cli binary (installed via installer script)
const STALWART_CLI_PATH = '/home/openhands/.cargo/bin/stalwart-cli';

/**
 * Wait for an HTTP endpoint to become available using manual polling.
 * This is more reliable than testcontainers' built-in HttpWaitStrategy for Stalwart.
 */
async function waitForHttpEndpoint(
  url: string,
  maxAttempts: number = 60,
  intervalMs: number = 3000
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        console.log(`[WaitForHttp] Endpoint ready after ${i + 1} attempts`);
        return;
      }
    } catch (err: any) {
      // Ignore connection errors and keep trying
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Endpoint ${url} not available after ${maxAttempts} attempts`);
}

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
 * Stalwart v0.16 config.json contains DataStore at ROOT level.
 * Listeners and all other configuration are loaded from the database.
 * Format:
 * {
 *   "@type": "RocksDb",
 *   "path": "/opt/stalwart/data"
 * }
 */
function createStalwartConfig(configPath: string, normalMode: boolean = false): void {
  const config: any = {
    '@type': 'RocksDb' as const,
    path: '/opt/stalwart/data',
  };
  
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[StalwartSetup] Config written to ${configPath}`);
}

/**
 * Start Stalwart in normal mode and provision accounts.
 * For testing, we use recovery mode to create accounts, then restart in normal mode.
 */
async function startStalwart(): Promise<{
  jmapUrl: string;
  imapHost: string;
  imapPort: number;
  container: StartedTestContainer;
}> {
  // Create a host-bind mount directory for Stalwart data
  const dataDir = mkdtempSync(path.join(tmpdir(), 'stalwart-data-'));
  console.log(`[StalwartSetup] Data directory: ${dataDir}`);

  // Generate admin credentials for recovery mode
  const recoveryPassword = 'provision_' + Math.random().toString(36).slice(2, 10);
  const provisionAdmin = `admin:${recoveryPassword}`;
  const [adminUser, adminPass] = provisionAdmin.split(':');

  console.log('[StalwartSetup] Phase 1: Starting recovery mode container...');

  // Phase 1: Provisioning container in recovery mode
  const configContent = JSON.stringify({
    '@type': 'RocksDb',
    path: '/opt/stalwart/data',
  });
  
  const containerA = await new GenericContainer('stalwartlabs/stalwart:v0.16.10')
    .withBindMounts([
      { source: dataDir, target: '/opt/stalwart/data' },
    ])
    .withEnvironment({
      STALWART_HOSTNAME: 'mail.stalwart.local',
      STALWART_RECOVERY_MODE: '1',
      STALWART_RECOVERY_ADMIN: provisionAdmin,
    })
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forLogMessage(/Network listener started.*http-recovery/).withStartupTimeout(120000))
    .withStartupTimeout(120000)
    .start();

  const mgmtPort = containerA.getMappedPort(8080);
  const mgmtHost = containerA.getHost();

  console.log(`[StalwartSetup] Recovery listener ready at http://${mgmtHost}:${mgmtPort}`);

  // Wait a moment for recovery listener to be fully ready
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Get the container's internal IP address via docker inspect
  const containerId = containerA.getId();
  console.log(`[StalwartSetup] Container ID: ${containerId}`);
  
  let containerAIp: string;
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect', containerId,
      '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
    ]);
    containerAIp = stdout.trim();
    console.log(`[StalwartSetup] Container internal IP: ${containerAIp}`);
  } catch (err: any) {
    console.error('[StalwartSetup] Failed to get container IP:', err.message);
    await containerA.stop();
    throw new Error(`Failed to get container IP: ${err.message}`);
  }

  console.log('[StalwartSetup] Bootstrapping server...');
  
  // Step 1: Bootstrap the server (required before creating other objects)
  const bootstrapPlan = [
    { '@type': 'update', object: 'Bootstrap', id: 'singleton', value: {} },
  ].map((op) => JSON.stringify(op)).join('\n');
  
  const bootstrapFile = path.join(tmpdir(), `stalwart-bootstrap-${Date.now()}.jsonl`);
  writeFileSync(bootstrapFile, bootstrapPlan);
  
  try {
    // Use curl directly instead of stalwart-cli for better control
    const { stdout: bootstrapOutput } = await execFileAsync(
      'curl',
      [
        '-s', '-X', 'POST',
        '-u', `${adminUser}:${adminPass}`,
        `http://${containerAIp}:8080/`,
        '-H', 'Content-Type: application/json',
        '-d', bootstrapPlan
      ],
      {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    console.log('[StalwartSetup] Bootstrap completed:', bootstrapOutput?.trim() || 'ok');
  } catch (err: any) {
    console.error('[StalwartSetup] Bootstrap failed:', err.message);
    if (err.stderr) console.error('[StalwartSetup] Stderr:', err.stderr);
    await containerA.stop();
    throw new Error(`Failed to bootstrap server: ${err.message}`);
  }
  
  // Wait for Bootstrap to be fully persisted
  console.log('[StalwartSetup] Waiting for Bootstrap to persist...');
  await new Promise((resolve) => setTimeout(resolve, 5000));
  
  // Step 2: Create accounts and domains
  console.log('[StalwartSetup] Creating accounts and domains...');
  
  const plan = [
    { '@type': 'upsert', object: 'Domain', matchOn: ['name'], value: { 'dom-a': { name: 'dev.local' } } },
    { '@type': 'upsert', object: 'Account', matchOn: ['name'], value: { 'source': {
        '@type': 'User', name: 'source', domainId: '#dom-a',
        credentials: { '0': { '@type': 'Password', secret: 'source_password' } },
        roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' },
    } } },
    { '@type': 'upsert', object: 'Account', matchOn: ['name'], value: { 'target': {
        '@type': 'User', name: 'target', domainId: '#dom-a',
        credentials: { '0': { '@type': 'Password', secret: 'target_password' } },
        roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' },
    } } },
  ].map((op) => JSON.stringify(op)).join('\n');

  try {
    // Use curl directly to create accounts
    const { stdout, stderr } = await execFileAsync(
      'curl',
      [
        '-s', '-X', 'POST',
        '-u', `${adminUser}:${adminPass}`,
        `http://${containerAIp}:8080/`,
        '-H', 'Content-Type: application/json',
        '-d', plan
      ],
      {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    
    console.log('[StalwartSetup] Accounts created successfully');
    if (stderr) console.log('[StalwartSetup] Output:', stderr);
    if (stdout) console.log('[StalwartSetup] Stdout:', stdout);
    
  } catch (err: any) {
    console.error('[StalwartSetup] Failed to create accounts:', err.message);
    if (err.stderr) console.error('[StalwartSetup] Stderr:', err.stderr);
    await containerA.stop();
    throw new Error(`Failed to create accounts: ${err.message}`);
  }
  
  // Now restart in normal mode
  console.log('[StalwartSetup] Stopping recovery container to restart in normal mode...');
  await containerA.stop();

  console.log('[StalwartSetup] Phase 2: Starting normal mode container...');

  // Phase 2: Normal mode - start with the same data directory
  // Stalwart will read the Bootstrap and other objects from the database
  const containerB = await new GenericContainer('stalwartlabs/stalwart:v0.16.10')
    .withBindMounts([
      { source: dataDir, target: '/opt/stalwart/data' },
    ])
    .withCopyContentToContainer([{ 
      content: JSON.stringify({
        '@type': 'RocksDb',
        path: '/opt/stalwart/data',
      }, null, 2),
      target: '/etc/stalwart/config.json',
    }])
    .withEnvironment({
      STALWART_HOSTNAME: 'mail.stalwart.local',
    })
    .withCommand(['--config', '/etc/stalwart/config.json'])
    .withExposedPorts(8080, 143, 993)
    .withWaitStrategy(Wait.forLogMessage(/Network listener started.*http/).withStartupTimeout(120000))
    .withStartupTimeout(120000)
    .start();

  const stalwartHost = containerB.getHost();
  const imapPort = containerB.getMappedPort(143);
  const jmapPort = containerB.getMappedPort(8080);
  const jmapUrl = `http://${stalwartHost}:${jmapPort}`;
  
  console.log(`[StalwartSetup] Waiting for JMAP endpoint at ${jmapUrl}/.well-known/jmap...`);
  
  // Use manual polling for JMAP endpoint
  await waitForHttpEndpoint(`${jmapUrl}/.well-known/jmap`);
  
  console.log('[StalwartSetup] JMAP endpoint ready at:', jmapUrl);
  console.log('[StalwartSetup] IMAP available at:', `${stalwartHost}:${imapPort}`);

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
