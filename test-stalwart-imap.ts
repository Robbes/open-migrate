import { GenericContainer, Wait } from 'testcontainers';
import net from 'node:net';

async function main() {
  const container = await new GenericContainer('stalwartlabs/stalwart:v0.16.10')
    .withCommand(['--config', '/etc/stalwart/config.json'])
    .withExposedPorts(8080, 143)
    .withUser('root')
    .withStartupTimeout(120000)
    .withWaitStrategy(Wait.forHttp('/healthz/ready', 8080))
    .start();

  const jmapPort = container.getMappedPort(8080);
  const imapPort = container.getMappedPort(143);
  const host = container.getHost();
  console.log(`Stalwart started - JMAP: http://${host}:${jmapPort}, IMAP: ${host}:${imapPort}`);

  // Wait a bit for services to initialize
  await new Promise(r => setTimeout(r, 5000));

  // Test IMAP connection
  console.log('\n=== Testing IMAP Connection ===');
  for (let i = 0; i < 3; i++) {
    console.log(`\nAttempt ${i + 1}:`);
    await new Promise<void>((resolve) => {
      const client = new net.Socket();
      client.setTimeout(3000);
      
      client.on('connect', () => {
        console.log('  ✓ IMAP connection established!');
        client.write('A001 LOGIN test test\r\n');
      });
      
      client.on('data', (data) => {
        console.log('  Received:', data.toString().trim());
      });
      
      client.on('error', (err) => {
        console.error(`  ✗ Connection error: ${err.message}`);
      });
      
      client.on('close', () => {
        console.log('  Connection closed');
        resolve();
      });
      
      client.connect(imapPort, host);
    });
    await new Promise(r => setTimeout(r, 1000));
  }

  await container.stop();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
