import { GenericContainer, Wait } from 'testcontainers';

async function main() {
  const container = await new GenericContainer('stalwartlabs/stalwart:v0.16.10')
    .withCommand(['--config', '/etc/stalwart/config.json'])
    .withExposedPorts(8080, 143)
    .withStartupTimeout(120000)
    .withWaitStrategy(Wait.forHttp('/healthz/ready', 8080))
    .start();

  const port = container.getMappedPort(8080);
  const host = container.getHost();
  console.log(`Stalwart started at http://${host}:${port}`);

  // Wait a bit for services to initialize
  await new Promise(r => setTimeout(r, 3000));

  // Try various API endpoints
  const endpoints = [
    '/.well-known/jmap',
    '/api/v1/domain',
    '/api/v1/account',
    '/jmap/',
    '/jmap/down',
  ];

  for (const endpoint of endpoints) {
    console.log(`\n=== ${endpoint} ===`);
    try {
      const response = await fetch(`http://${host}:${port}${endpoint}`);
      console.log('Status:', response.status);
      const text = await response.text();
      console.log('Response:', text.substring(0, 300));
    } catch (err) {
      console.error('Error:', err.message);
    }
  }

  await container.stop();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
