import { GenericContainer, Wait } from 'testcontainers';

async function main() {
  const container = await new GenericContainer('stalwartlabs/stalwart:v0.16.10')
    .withCommand(['--config', '/etc/stalwart/config.json'])
    .withExposedPorts(8080, 143)
    .withUser('root')
    .withStartupTimeout(120000)
    .withWaitStrategy(Wait.forHttp('/healthz/ready', 8080))
    .start();

  const port = container.getMappedPort(8080);
  const host = container.getHost();
  console.log(`Stalwart started at http://${host}:${port}`);

  // Wait a bit for services to initialize
  await new Promise(r => setTimeout(r, 5000));

  // Try to get JMAP endpoint
  console.log('\n=== Checking JMAP endpoint ===');
  try {
    const response = await fetch(`http://${host}:${port}/.well-known/jmap`);
    console.log('Status:', response.status);
    const text = await response.text();
    console.log('Response:', text.substring(0, 500));
  } catch (err) {
    console.error('Error:', err.message);
  }

  // Try to get health status
  console.log('\n=== Checking health ===');
  try {
    const response = await fetch(`http://${host}:${port}/healthz/ready`);
    console.log('Status:', response.status);
    const text = await response.text();
    console.log('Response:', text.substring(0, 500));
  } catch (err) {
    console.error('Error:', err.message);
  }

  // Get logs
  console.log('\n=== Container Logs ===');
  const logs = await container.logs();
  let count = 0;
  for await (const chunk of logs) {
    const str = chunk.toString();
    if (str.trim()) {
      console.log(str);
      count++;
    }
  }
  console.log(`Total lines: ${count}`);

  await container.stop();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
