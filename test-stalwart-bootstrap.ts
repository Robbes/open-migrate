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

  // Wait for Stalwart to be fully ready
  await new Promise(r => setTimeout(r, 5000));

  // Try to bootstrap an admin account
  console.log('\n=== Trying to bootstrap admin account ===');
  try {
    const response = await fetch(`http://${host}:${port}/.well-known/jmap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core'],
        methodCalls: [
          ['Account/set', {
            create: {
              '0': {
                name: 'admin@dev.local',
                password: 'admin123',
                roles: ['admin'],
              },
            },
          }, 'accountSet1'],
        ],
      }),
    });
    console.log('Status:', response.status);
    const text = await response.text();
    console.log('Response:', text.substring(0, 1000));
  } catch (err) {
    console.error('Error:', err.message);
  }

  // Try the bootstrap endpoint
  console.log('\n=== Trying bootstrap endpoint ===');
  try {
    const response = await fetch(`http://${host}:${port}/api/v1/bootstrap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: 'admin@dev.local',
        password: 'admin123',
        roles: ['admin'],
      }),
    });
    console.log('Status:', response.status);
    const text = await response.text();
    console.log('Response:', text.substring(0, 1000));
  } catch (err) {
    console.error('Error:', err.message);
  }

  // Check logs
  console.log('\n=== Stalwart Logs ===');
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
