// Copyright 2026 OpenHands Agent (Apache-2.0)
// Testcontainers setup for integration tests.
// Spins up Postgres and Stalwart programmatically.
//
// Stalwart v0.16.x requires a complete configuration file to enable JMAP/IMAP listeners.
// Without config, it starts in bootstrap mode which requires web UI setup.

import { GenericContainer, Wait, Network } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
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
 * Create a minimal Stalwart configuration file.
 * 
 * Note: Stalwart v0.16.x uses a minimal JSON config that only specifies the DataStore.
 * All other configuration is done through the JMAP API after startup.
 * Based on Stalwart documentation: https://stalw.art/docs/install/configuration
 */
function createStalwartConfig(configPath: string): void {
  // Create the config directory if it doesn't exist
  const configDir = path.dirname(configPath);
  mkdirSync(configDir, { recursive: true });

  // Minimal JSON configuration for Stalwart v0.16.x
  // Only specifies the DataStore location - all other config via JMAP API
  const config = {
    '@type': 'RocksDb',
    path: '/var/lib/stalwart/data',
  };

  writeFileSync(configPath, JSON.stringify(config));
  console.log(`[StalwartSetup] Config written to ${configPath}`);
}

/**
 * Start Stalwart with proper configuration.
 * Creates accounts via stalwart-cli after startup.
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

  // Create configuration file (minimal JSON for Stalwart v0.16.x)
  // Based on Stalwart documentation: only DataStore config is needed
  const configDir = path.join(dataDir, 'config');
  const configPath = path.join(configDir, 'config.json');
  createStalwartConfig(configPath);

  // Create config object for copy to container
  const config = {
    '@type': 'RocksDb',
    path: '/var/lib/stalwart/data',
  };

  console.log('[StalwartSetup] Starting Stalwart container with configuration...');

  // Start Stalwart with explicit --config argument
  // Note: Stalwart v0.16.x uses minimal JSON config (only DataStore)
  // Based on Dockerfile: CMD ["--config", "/etc/stalwart/config.json"]
  // IMPORTANT: Must run as root to avoid bind mount permission issues
  // The stalwart user (UID 2000) cannot write to host bind-mounted directories
  // due to UID translation in Docker. Running as root bypasses this issue.
  const container = await new GenericContainer('stalwartlabs/stalwart:v0.16.10')
    .withCopyContentToContainer([
      { content: JSON.stringify(config), target: '/etc/stalwart/config.json' },
    ])
    .withBindMounts([
      { source: dataDir, target: '/var/lib/stalwart/data' },
    ])
    .withCommand(['--config', '/etc/stalwart/config.json'])
    .withExposedPorts(8080, 143)
    .withUser('root')
    .withStartupTimeout(120000)
    .withWaitStrategy(Wait.forHttp('/healthz/ready', 8080))
    .start();

  const mgmtPort = container.getMappedPort(8080);
  const mgmtHost = container.getHost();

  console.log(`[StalwartSetup] Stalwart started at http://${mgmtHost}:${mgmtPort}`);

  // For integration tests, we'll use IMAP directly since JMAP requires bootstrap completion
  const stalwartHost = container.getHost();
  const imapPort = container.getMappedPort(143);
  const jmapUrl = `http://${mgmtHost}:${mgmtPort}`;

  console.log(`[StalwartSetup] Stalwart ready - JMAP: ${jmapUrl}, IMAP: ${stalwartHost}:${imapPort}`);

  return {
    jmapUrl,
    imapHost: stalwartHost,
    imapPort,
    container,
  };
}

/**
 * Start the test environment using Testcontainers.
 * Spins up Postgres and Stalwart containers.
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

  // Start Stalwart
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
