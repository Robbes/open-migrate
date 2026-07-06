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
import type { StartedTestContainer } from 'testcontainers';
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Test logs directory - created once at module load
 */
const TEST_LOGS_DIR = path.join(process.cwd(), 'test-logs');

/**
 * Ensure the test-logs directory exists
 */
function ensureTestLogsDir(): void {
  if (!existsSync(TEST_LOGS_DIR)) {
    mkdirSync(TEST_LOGS_DIR, { recursive: true });
    console.log(`[TestLogs] Created directory: ${TEST_LOGS_DIR}`);
  }
}

/**
 * Stream container logs to a file from container start.
 * This is different from polling - it attaches a log consumer that streams
 * each line as it's produced.
 */
async function streamContainerLogs(
  container: StartedTestContainer,
  logFileName: string
): Promise<void> {
  ensureTestLogsDir();
  const logFilePath = path.join(TEST_LOGS_DIR, logFileName);
  
  console.log(`[TestLogs] Starting log stream to: ${logFilePath}`);
  
  // Clear/create the log file
  try {
    appendFileSync(logFilePath, `\n=== ${logFileName} started at ${new Date().toISOString()} ===\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[TestLogs] Warning: Could not initialize log file: ${msg}`);
    return;
  }
  
  // Use testcontainers' log consumer to stream logs
  try {
    const logStream = await container.logs();
    logStream.on('data', (line: string) => {
      try {
        appendFileSync(logFilePath, line + '\n');
      } catch {
        // Ignore write errors - container might be shutting down
      }
    });
    logStream.on('err', (line: string) => {
      try {
        appendFileSync(logFilePath, `[ERR] ${line}\n`);
      } catch {
        // Ignore write errors
      }
    });
    logStream.on('end', () => {
      try {
        appendFileSync(logFilePath, `\n=== ${logFileName} ended ===\n`);
      } catch {
        // Ignore
      }
      console.log(`[TestLogs] Log stream ended for: ${logFileName}`);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[TestLogs] Warning: Could not attach log stream for ${logFileName}: ${msg}`);
  }
}

/**
 * Capture final diagnostics for a container including docker logs,
 * internal logs, and network state.
 */
async function captureContainerDiagnostics(
  container: StartedTestContainer,
  containerName: string,
  extraChecks: string[] = []
): Promise<void> {
  ensureTestLogsDir();
  const diagnosticsFile = path.join(TEST_LOGS_DIR, `diagnostics-${containerName}.txt`);
  
  console.log(`[TestLogs] Capturing diagnostics for ${containerName}...`);
  
  try {
    const containerId = container.getId();
    
    // Get Docker logs
    let dockerLogs = '';
    try {
      const { stdout } = await execFileAsync('docker', ['logs', '--tail', '200', containerId]);
      dockerLogs = stdout || 'No docker logs available';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dockerLogs = `Error getting docker logs: ${msg}`;
    }
    
    // Get container's internal /opt/stalwart/data/LOG if it exists
    let stalwartDbLog = '';
    try {
      const { stdout } = await execFileAsync('docker', [
        'exec', containerId, 'cat', '/opt/stalwart/data/LOG'
      ]);
      stalwartDbLog = stdout || 'No RocksDB LOG found';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stalwartDbLog = `Could not read RocksDB LOG: ${msg}`;
    }
    
    // Get network state from inside container
    let networkState = '';
    try {
      const { stdout } = await execFileAsync('docker', [
        'exec', containerId, 'sh', '-c', 'ss -ltn || netstat -ltn || cat /proc/net/tcp'
      ]);
      networkState = stdout || 'No network state available';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      networkState = `Could not get network state: ${msg}`;
    }
    
    // Get docker ps -a for this container
    let dockerPs = '';
    try {
      const { stdout } = await execFileAsync('docker', ['ps', '-a', '--filter', `id=${containerId}`, '--no-trunc']);
      dockerPs = stdout || 'No container found in docker ps -a';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dockerPs = `Error: ${msg}`;
    }
    
    // Write all diagnostics
    const header = `=== Diagnostics for ${containerName} (Container ID: ${containerId}) ===\n`;
    const dockerLogsSection = `\n=== Docker Logs (last 200 lines) ===\n${dockerLogs}\n`;
    const dbLogSection = `\n=== Stalwart RocksDB LOG ===\n${stalwartDbLog}\n`;
    const networkSection = `\n=== Network State ===\n${networkState}\n`;
    const psSection = `\n=== Docker ps -a ===\n${dockerPs}\n`;
    
    appendFileSync(diagnosticsFile, header + dockerLogsSection + dbLogSection + networkSection + psSection);
    
    // Run any extra checks
    for (const check of extraChecks) {
      try {
        const { stdout } = await execFileAsync('docker', ['exec', containerId, 'sh', '-c', check]);
        appendFileSync(diagnosticsFile, `\n=== ${check} ===\n${stdout}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendFileSync(diagnosticsFile, `\n=== ${check} ===\nError: ${msg}\n`);
      }
    }
    
    console.log(`[TestLogs] Diagnostics saved to: ${diagnosticsFile}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[TestLogs] Warning: Could not capture diagnostics for ${containerName}: ${msg}`);
  }
}

/**
 * Resolve the path to the stalwart-cli binary.
 * Priority: STALWART_CLI_PATH env var > 'stalwart-cli' on PATH > error.
 * This allows CI to override the path while keeping local development simple.
 */
function resolveStalwartCliPath(): string {
  const envPath = process.env.STALWART_CLI_PATH;
  if (envPath) {
    console.log(`[StalwartSetup] Using STALWART_CLI_PATH from env: ${envPath}`);
    return envPath;
  }
  
  // Try to find stalwart-cli on PATH
  try {
    const result = execFileSync('which', ['stalwart-cli'], { encoding: 'utf8' }).trim();
    if (result) {
      console.log(`[StalwartSetup] Found stalwart-cli on PATH: ${result}`);
      return result;
    }
  } catch {
    // which failed, binary not on PATH
  }
  
  throw new Error(
    'stalwart-cli not found. Please either:\n' +
    '  1. Install stalwart-cli and ensure it\'s on PATH, or\n' +
    '  2. Set the STALWART_CLI_PATH environment variable to the full path of the binary.\n' +
    'To install: curl --proto \'=https\' --tlsv1.2 -LsSf https://github.com/stalwartlabs/cli/releases/latest/download/stalwart-cli-installer.sh | sh'
  );
}

// Path to stalwart-cli binary (resolved dynamically at runtime)
const STALWART_CLI_PATH = resolveStalwartCliPath();

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
    } catch {
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

  // Attach log stream for Phase 1 - streams continuously from container start
  await streamContainerLogs(containerA, 'stalwart-phase1.log');

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
    
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[StalwartSetup] stalwart-cli failed:', msg);
    const code = err && typeof err === 'object' && 'code' in err ? (err.code as string | undefined) : undefined;
    const signal = err && typeof err === 'object' && 'signal' in err ? (err.signal as string | undefined) : undefined;
    const stdoutVal = err && typeof err === 'object' && 'stdout' in err ? err.stdout : undefined;
    const stderrVal = err && typeof err === 'object' && 'stderr' in err ? err.stderr : undefined;
    console.error('[StalwartSetup] Exit code:', code);
    console.error('[StalwartSetup] Signal:', signal);
    if (stdoutVal) console.error('[StalwartSetup] Stdout:', stdoutVal);
    if (stderrVal) console.error('[StalwartSetup] Stderr:', stderrVal);
    await containerA.stop();
    throw new Error(`Failed to provision accounts: ${msg}`, { cause: err });
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[StalwartSetup] Warning: Could not verify source account:', msg);
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
  } catch {
    console.warn('[StalwartSetup] Warning: Could not remove LOCK file');
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
    } catch {
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
    // Use default command from image (already includes --config /etc/stalwart/config.json)
    .withWaitStrategy(Wait.forLogMessage('Network listener started'))
    .start();

  // Attach log stream for Phase 2 - streams continuously from container start
  await streamContainerLogs(containerB, 'stalwart-phase2.log');

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
 * Also captures diagnostics on failure or during teardown.
 */
export async function stopTestEnvironment(env: TestEnvironment): Promise<void> {
  console.log('[Testcontainers] Stopping containers...');
  
  // Attach log stream for Postgres
  await streamContainerLogs(env.postgres.container, 'postgres.log');
  
  try {
    await env.postgres.container.stop();
    console.log('[Testcontainers] Postgres stopped.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Testcontainers] Error stopping Postgres:', msg);
    // Capture diagnostics on error
    await captureContainerDiagnostics(env.postgres.container, 'postgres', ['ps aux', 'df -h']);
  }
  
  try {
    await env.stalwart.container.stop();
    console.log('[Testcontainers] Stalwart stopped.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Testcontainers] Error stopping Stalwart:', msg);
    // Capture full diagnostics on Stalwart failure
    await captureContainerDiagnostics(
      env.stalwart.container,
      'stalwart-phase2',
      ['ps aux', 'df -h', 'cat /etc/stalwart/config.json 2>/dev/null || echo "no config"', 'ls -la /opt/stalwart/data/']
    );
  }
  
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
