// Copyright 2026 OpenHands Agent (Apache-2.0)
// Testcontainers setup for integration tests.
// Spins up Postgres and Stalwart programmatically.
//
// IMPORTANT: Stalwart v0.16.10 requires a two-phase startup:
//   Phase 1: Recovery mode container - provisions accounts via stalwart-cli
//   Phase 2: Normal mode container - starts with mail listeners enabled
// Both phases share the same Docker named volume for data persistence.
//
// NOTE: Bind mounts to host directories do not sync data in this Docker-in-Docker environment.
//       We use Docker named volumes instead, which work reliably.

import { GenericContainer, Wait, Network } from 'testcontainers';
import type { StartedTestContainer, StoppedTestContainer } from 'testcontainers';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Path to stalwart-cli binary (installed via installer script)
const STALWART_CLI_PATH = '/home/openhands/.cargo/bin/stalwart-cli';

// Docker named volume for Stalwart data persistence
// Bind mounts don't work in this DinD environment, so we use Docker volumes
// IMPORTANT: Use a UNIQUE volume name per test run to prevent RocksDB lock conflicts
// across parallel test runs or leftover state from previous runs
const STALWART_DATA_VOLUME = `stalwart-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Ensure the Docker volume exists.
 */
function ensureVolume(): void {
  try {
    execFileSync('docker', ['volume', 'inspect', STALWART_DATA_VOLUME], { stdio: 'ignore' });
  } catch {
    execFileSync('docker', ['volume', 'create', STALWART_DATA_VOLUME]);
  }
}

/**
 * Get the host path for a Docker volume.
 * This is needed for testcontainers bind mounts.
 */
function getVolumeMountpoint(volumeName: string): string {
  const stdout = execFileSync('docker', ['volume', 'inspect', volumeName], {
    encoding: 'utf8',
  });
  const data = JSON.parse(stdout);
  return data[0]?.Mountpoint || '/var/lib/docker/volumes/' + volumeName + '/_data';
}

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
 * Start Stalwart in two phases:
 *   Phase 1: Recovery mode - provision accounts via stalwart-cli
 *   Phase 2: Normal mode - start with mail listeners enabled
 * Both phases share the same Docker named volume for data persistence.
 */
async function startStalwart(): Promise<{
  jmapUrl: string;
  imapHost: string;
  imapPort: number;
  container: StartedTestContainer;
}> {
  // Ensure Docker volume exists for data persistence
  ensureVolume();
  const volumeMountpoint = getVolumeMountpoint(STALWART_DATA_VOLUME);
  console.log(`[StalwartSetup] Using Docker volume at: ${volumeMountpoint}`);

  // Generate recovery admin credentials
  const recoveryPassword = 'provision_' + Math.random().toString(36).slice(2, 10);
  const provisionAdmin = `admin:${recoveryPassword}`;
  const [adminUser, adminPass] = provisionAdmin.split(':');

  console.log('[StalwartSetup] Phase 1: Starting recovery mode container...');

  // Minimal config.json for Stalwart - just the data store settings
  // This prevents bootstrap mode and allows recovery mode to work properly
  // Format MUST be valid JSON (not JS object notation)
  // Path must match the volume mount target
  const configJson = '{"@type":"RocksDb","path":"/opt/stalwart/data"}';

  // Phase 1: Provisioning container in recovery mode
  // Runs as root to allow writing to the mounted data directory
  const containerA = await new GenericContainer('stalwart-test-custom:latest')
    .withBindMounts([
      { source: volumeMountpoint, target: '/opt/stalwart/data' },
    ])
    .withCopyContentToContainer([
      { content: configJson, target: '/etc/stalwart/config.json' },
    ])
    .withEnvironment({
      STALWART_HOSTNAME: 'mail.stalwart.local',
      STALWART_RECOVERY_MODE: '1',
      STALWART_RECOVERY_ADMIN: provisionAdmin,
    })
    .withExposedPorts(8080)
    .withStartupTimeout(120000)
    .withUser('root')
    .withCommand(['--config', '/etc/stalwart/config.json'])
    .withWaitStrategy(Wait.forLogMessage('Network listener started'))
    .start();

  const mgmtPort = containerA.getMappedPort(8080);
  const mgmtHost = containerA.getHost();

  console.log(`[StalwartSetup] Recovery listener ready at http://${mgmtHost}:${mgmtPort}`);

  // Wait a moment for recovery listener to be fully ready
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log('[StalwartSetup] Provisioning accounts via stalwart-cli...');
  
  // Stalwart v0.16.x account format - account ID is used as username for IMAP
  // With config.json present, server starts in recovery mode (not bootstrap)
  // Can directly create Domain and Account objects
  const plan = [
    // Step 1: Create Domain
    { '@type': 'upsert', object: 'Domain', matchOn: ['name'], value: { 'dom-a': { name: 'dev.local' } } },
    // Step 2: Create source account
    { '@type': 'upsert', object: 'Account', matchOn: ['name'], value: { 'source': {
        '@type': 'User', name: 'source', domainId: '#dom-a',
        credentials: { '0': { '@type': 'Password', secret: 'source_password' } },
        roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' },
    } } },
    // Step 3: Create target account
    { '@type': 'upsert', object: 'Account', matchOn: ['name'], value: { 'target': {
        '@type': 'User', name: 'target', domainId: '#dom-a',
        credentials: { '0': { '@type': 'Password', secret: 'target_password' } },
        roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' },
    } } },
  ].map((op) => JSON.stringify(op)).join('\n');

  try {
    // Use host-level stalwart-cli binary to provision accounts
    // This avoids Docker networking issues and container lifecycle problems
    console.log('[StalwartSetup] STALWART_URL:', `http://${mgmtHost}:${mgmtPort}`);
    
    // Write plan to temp file
    const planFile = path.join(tmpdir(), `stalwart-plan-${Date.now()}.jsonl`);
    writeFileSync(planFile, plan);
    console.log('[StalwartSetup] Plan written to:', planFile);
    
    console.log('[StalwartSetup] Running stalwart-cli...');
    const { stdout, stderr } = await execFileAsync(
      STALWART_CLI_PATH,
      ['apply', '--file', planFile],
      {
        env: {
          STALWART_URL: `http://${mgmtHost}:${mgmtPort}`,
          STALWART_USER: adminUser,
          STALWART_PASSWORD: adminPass,
        },
        timeout: 30000, // 30 second timeout to prevent hanging
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      }
    );
    
    console.log('[StalwartSetup] stalwart-cli completed successfully');
    if (stderr) console.log('[StalwartSetup] Output:', stderr);
    if (stdout) console.log('[StalwartSetup] Stdout:', stdout);
    
  } catch (err: any) {
    console.error('[StalwartSetup] stalwart-cli failed:', err.message);
    console.error('[StalwartSetup] Exit code:', err.code);
    console.error('[StalwartSetup] Signal:', err.signal);
    if (err.stdout) console.error('[StalwartSetup] Stdout:', err.stdout);
    if (err.stderr) console.error('[StalwartSetup] Stderr:', err.stderr);
    await containerA.stop();
    throw new Error(`Failed to provision accounts: ${err.message}`);
  }

  // Verify accounts were created using host-level CLI
  console.log('[StalwartSetup] Verifying accounts...');
  try {
    const { stdout: verifyOutput } = await execFileAsync(
      STALWART_CLI_PATH,
      ['get', 'Account', 'source'],
      {
        env: {
          STALWART_URL: `http://${mgmtHost}:${mgmtPort}`,
          STALWART_USER: adminUser,
          STALWART_PASSWORD: adminPass,
        },
        timeout: 10000,
      }
    );
    console.log('[StalwartSetup] Source account verified:', verifyOutput ? 'found' : 'not found');
  } catch (err: any) {
    console.warn('[StalwartSetup] Warning: Could not verify source account:', err.message);
  }

  // Stop provisioning container
  console.log('[StalwartSetup] Stopping recovery container...');
  await containerA.stop();
  
  // CRITICAL: Wait for RocksDB lock to be released
  // containerA.stop() may return before the Stalwart process fully releases the lock file
  // We need to ensure the LOCK file is actually gone before starting Phase 2
  console.log('[StalwartSetup] Waiting for Phase 1 container to fully terminate...');
  const stopContainerId = containerA.getId();
  let attempts = 0;
  const maxAttempts = 30; // 30 seconds total
  
  // Step 1: Wait for container to disappear from docker ps
  while (attempts < maxAttempts) {
    try {
      const { stdout } = await execFileAsync('docker', ['ps', '-q', '--filter', `id=${stopContainerId}`]);
      if (!stdout.trim()) {
        console.log('[StalwartSetup] Phase 1 container no longer in docker ps.');
        break;
      }
    } catch {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
  }
  
  if (attempts >= maxAttempts) {
    console.warn('[StalwartSetup] Container still appearing, forcing removal...');
    await execFileAsync('docker', ['rm', '-f', stopContainerId]).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  // Step 2: Force-remove LOCK file and verify it's gone
  // The LOCK file may persist due to Docker volume caching or delayed cleanup
  console.log('[StalwartSetup] Forcing LOCK file removal...');
  try {
    await execFileAsync('docker', [
      'run', '--rm', '-v', `${STALWART_DATA_VOLUME}:/data`, 'alpine',
      'rm', '-f', '/data/LOCK'
    ]);
    console.log('[StalwartSetup] LOCK file removal command executed.');
  } catch (e: any) {
    console.warn('[StalwartSetup] Warning: Could not remove LOCK file:', e.message);
  }
  
  // Step 3: Verify LOCK file is actually gone (wait up to 10 seconds)
  console.log('[StalwartSetup] Verifying LOCK file is gone...');
  attempts = 0;
  while (attempts < 10) {
    try {
      await execFileAsync('docker', [
        'run', '--rm', '-v', `${STALWART_DATA_VOLUME}:/data`, 'alpine',
        'test', '-f', '/data/LOCK'
      ]);
      // LOCK file still exists
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    } catch (err: any) {
      // LOCK file does not exist - this is what we want
      console.log('[StalwartSetup] LOCK file confirmed gone after', attempts, 'verification attempts.');
      break;
    }
  }
  
  if (attempts >= 10) {
    console.error('[StalwartSetup] ERROR: LOCK file still present after forced removal!');
    console.error('[StalwartSetup] This indicates a persistent lock issue - aborting Phase 2.');
    throw new Error('LOCK file could not be removed - RocksDB may still be in use');
  }

  console.log('[StalwartSetup] Phase 2: Starting normal mode container with provisioned data...');

  // Phase 2: Production container with MINIMAL config
  // REUSE the same Docker volume from Phase 1 (contains provisioned accounts in DB)
  console.log('[StalwartSetup] Phase 2 using same volume:', volumeMountpoint);

  // LOCK file should already be released by the wait loop above
  // No need to force-remove it here

  // MINIMAL config per FIXED TRUTH: only DataStore, no http/imap/listeners/accounts/domains
  // Accounts/domains are in the DB from Phase 1 provisioning
  // Listeners auto-start in normal mode (no recovery mode)
  const normalConfig = '{"@type":"RocksDb","path":"/opt/stalwart/data"}';

  // Custom wait strategy that also logs container output for debugging
  const customWaitStrategy = {
    waitUntilReady: async (container: any) => {
      const timeout = 180000;
      const startTime = Date.now();
      
      // Get container ID for manual inspection
      const containerId = container.getId ? container.getId() : 'unknown';
      console.log(`[StalwartSetup] Phase 2 container ID: ${containerId}`);
      
      while (Date.now() - startTime < timeout) {
        // Check if ports are bound
        const inspect = await container.inspect();
        const state = inspect.State;
        const running = state.Running;
        const status = state.Status;
        const exited = !running && status === 'exited';
        const dead = status === 'dead';
        
        console.log(`[StalwartSetup] Container state: running=${running}, status=${status}, exited=${exited}, dead=${dead}`);
        
        if (exited || dead) {
          const logs = await container.logs({ stdout: true, stderr: true, tail: 100, timestamps: true });
          console.error('[StalwartSetup] Container exited! Last logs:', logs.toString().substring(0, 2000));
          throw new Error(`Stalwart container exited with status: ${status}`);
        }
        
        if (running) {
          // Get container logs periodically to see what's happening
          if ((Date.now() - startTime) % 30000 < 5000) {  // Every 30 seconds
            try {
              const logs = await container.logs({ stdout: true, stderr: true, tail: 20, timestamps: true });
              const logStr = logs.toString();
              if (logStr.length > 0) {
                console.log('[StalwartSetup] Recent logs:', logStr.substring(0, 500));
              }
            } catch (e: any) {
              // Ignore log errors
            }
          }
          
          // Try to connect to port 8080
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const response = await fetch(`http://${container.getHost()}:${container.getMappedPort(8080)}/.well-known/jmap`, {
              signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (response.ok || response.status === 404) {
              console.log('[StalwartSetup] Port 8080 is listening');
              return;
            }
          } catch (e: any) {
            // Port not ready yet
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      throw new Error('Stalwart did not start within timeout');
    },
    withStartupTimeout: (ms: number) => customWaitStrategy,
    isStartupTimeoutSet: () => false,
    getStartupTimeout: () => 0
  };

  const containerB = await new GenericContainer('stalwart-test-custom:latest')
    .withBindMounts([
      { source: volumeMountpoint, target: '/opt/stalwart/data' },
    ])
    .withCopyContentToContainer([
      { content: normalConfig, target: '/etc/stalwart/config.json' },
    ])
    .withEnvironment({
      STALWART_HOSTNAME: 'mail.stalwart.local',
    })
    .withExposedPorts(8080, 143)
    .withStartupTimeout(180000)
    .withUser('root')
    .withCommand(['--config', '/etc/stalwart/config.json'])
    .withWaitStrategy(customWaitStrategy)
    .start();

  console.log('[StalwartSetup] Container started, waiting for JMAP endpoint...');
  const stalwartHost = containerB.getHost();
  const imapPort = containerB.getMappedPort(143);
  const jmapPort = containerB.getMappedPort(8080);
  const jmapUrl = `http://${stalwartHost}:${jmapPort}`;
  
  // Use manual polling instead of testcontainers' wait strategy
  await waitForHttpEndpoint(`${jmapUrl}/.well-known/jmap`);
  
  console.log('[StalwartSetup] JMAP endpoint ready at:', jmapUrl);
  console.log('[StalwartSetup] IMAP available at:', `${stalwartHost}:${imapPort}`);

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
  
  // Clean up the Stalwart data volume to prevent stale locks for next run
  try {
    execFileSync('docker', ['volume', 'rm', STALWART_DATA_VOLUME], { stdio: 'ignore' });
    console.log(`[Testcontainers] Cleaned up Stalwart volume: ${STALWART_DATA_VOLUME}`);
  } catch {
    // Volume might already be gone or in use
    console.warn(`[Testcontainers] Could not remove volume ${STALWART_DATA_VOLUME}`);
  }
}
