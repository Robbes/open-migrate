import { GenericContainer, Wait, Network } from 'testcontainers';

async function main() {
  const network = await new Network().start();

  // Start Stalwart
  const stalwartContainer = await new GenericContainer('stalwartlabs/stalwart:v0.16.10')
    .withNetwork(network)
    .withNetworkAliases('stalwart')
    .withCommand(['--config', '/etc/stalwart/config.json'])
    .withExposedPorts(8080, 143)
    .withStartupTimeout(120000)
    .withWaitStrategy(Wait.forHttp('/healthz/ready', 8080))
    .start();

  const mgmtPort = stalwartContainer.getMappedPort(8080);
  const mgmtHost = stalwartContainer.getHost();
  const imapPort = stalwartContainer.getMappedPort(143);

  console.log(`Stalwart started - JMAP: http://${mgmtHost}:${mgmtPort}, IMAP: ${mgmtHost}:${imapPort}`);

  // Wait for Stalwart to be fully ready
  await new Promise(r => setTimeout(r, 3000));

  // Create accounts using stalwart-cli
  console.log('Creating accounts via stalwart-cli...');
  
  const cliContainer = await new GenericContainer('ghcr.io/stalwartlabs/cli:latest')
    .withNetwork(network)
    .withNetworkAliases('cli')
    .withCommand([
      'account', 'create',
      '--server', 'stalwart:8080',
      '--name', 'source@dev.local',
      '--password', 'source_password',
      '--role', 'user',
    ])
    .withStartupTimeout(30000)
    .start();

  const cliLogs = await cliContainer.logs();
  for await (const chunk of cliLogs) {
    process.stdout.write(chunk.toString());
  }
  await cliContainer.stop();

  console.log('\n=== Checking if account was created ===');
  
  // Try to connect via IMAP
  const net = await import('node:net');
  console.log(`Testing IMAP connection to ${mgmtHost}:${imapPort}...`);
  
  const client = new net.Socket();
  client.setTimeout(5000);
  
  client.on('connect', () => {
    console.log('IMAP connection established!');
    client.write('A001 LOGIN source@dev.local source_password\r\n');
  });
  
  client.on('data', (data) => {
    console.log('Received:', data.toString());
  });
  
  client.on('error', (err) => {
    console.error('Connection error:', err.message);
  });
  
  client.on('close', () => {
    console.log('Connection closed');
    stalwartContainer.stop();
    network.stop();
    process.exit(0);
  });
  
  client.connect(imapPort, mgmtHost);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
