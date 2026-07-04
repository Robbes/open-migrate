import { GenericContainer, Wait } from 'testcontainers';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'stalwart-test-'));
  console.log(`Data directory: ${dataDir}`);

  const configDir = path.join(dataDir, 'config');
  mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.json');
  
  const config = { '@type': 'RocksDb', path: '/var/lib/stalwart/data' };
  writeFileSync(configPath, JSON.stringify(config));

  const container = await new GenericContainer('stalwartlabs/stalwart:v0.16.10')
    .withCopyContentToContainer([{ content: JSON.stringify(config), target: '/etc/stalwart/config.json' }])
    .withBindMounts([{ source: dataDir, target: '/var/lib/stalwart/data' }])
    .withCommand(['--config', '/etc/stalwart/config.json'])
    .withExposedPorts(8080, 143)
    .withUser('root')
    .withStartupTimeout(120000)
    .withWaitStrategy(Wait.forHttp('/healthz/ready', 8080))
    .start();

  console.log(`Container started. JMAP: ${container.getHost()}:${container.getMappedPort(8080)}, IMAP: ${container.getHost()}:${container.getMappedPort(143)}`);
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n=== Container Logs ===');
  const logs = await container.logs();
  let logCount = 0;
  for await (const chunk of logs) {
    const str = chunk.toString();
    if (str.trim()) { console.log(str); logCount++; }
  }
  console.log(`\n=== Total log lines: ${logCount} ===\n`);

  const net = await import('node:net');
  const imapPort = container.getMappedPort(143);
  const imapHost = container.getHost();
  
  console.log(`Testing IMAP port ${imapHost}:${imapPort}...`);
  for (let i = 0; i < 3; i++) {
    console.log(`\nAttempt ${i + 1}:`);
    await new Promise<void>((resolve) => {
      const client = new net.Socket();
      client.setTimeout(3000);
      client.on('connect', () => { console.log('  IMAP connected!'); client.write('A001 LOGIN source source_password\r\n'); });
      client.on('data', (data) => { console.log('  Received:', data.toString().trim()); });
      client.on('error', (err) => { console.error(`  Error: ${err.message}`); });
      client.on('close', () => { console.log('  Closed'); resolve(); });
      client.connect(imapPort, imapHost);
    });
    await new Promise(r => setTimeout(r, 1000));
  }
  await container.stop();
}
main().catch(err => { console.error(err); process.exit(1); });
