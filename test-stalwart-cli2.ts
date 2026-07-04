import { GenericContainer, Wait, Network } from 'testcontainers';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

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

  console.log(`Stalwart started at http://${mgmtHost}:${mgmtPort}`);

  // Wait for Stalwart to be fully ready
  await new Promise(r => setTimeout(r, 5000));

  // Try to create accounts using stalwart-cli with the correct syntax
  console.log('\n=== Creating accounts via stalwart-cli ===');
  
  // First, let's try to create the bootstrap admin account
  try {
    const result = await execAsync(
      `docker run --rm --network container:${stalwartContainer.getId()} ` +
      `ghcr.io/stalwartlabs/cli:latest ` +
      `--url http://stalwart:8080 ` +
      `create Account ` +
      `--field name=admin@dev.local ` +
      `--field 'password={type:PlainText, value:admin123}' ` +
      `--field 'roles=[admin]'`
    );
    console.log('CLI output:', result.stdout);
    console.log('CLI stderr:', result.stderr);
  } catch (err: any) {
    console.log('CLI error:', err.message);
    console.log('CLI stderr:', err.stderr);
  }

  // Check logs
  console.log('\n=== Stalwart Logs ===');
  const logs = await stalwartContainer.logs();
  for await (const chunk of logs) {
    process.stdout.write(chunk.toString());
  }

  await stalwartContainer.stop();
  await network.stop();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
