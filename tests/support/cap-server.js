const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function startCapServer() {
  const port = await unusedPort();
  const origin = `http://localhost:${port}`;
  const entryPoint = path.join(
    process.cwd(),
    'node_modules',
    '@sap',
    'cds',
    'bin',
    'serve.js'
  );
  const child = spawn(process.execPath, [entryPoint, '--port', String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, ANTHROPIC_API_KEY: '', AGENT_MEMORY_ENABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`CAP server exited before becoming ready.\n${output}`);
    }

    try {
      const response = await fetch(`${origin}/api/dashboard`, {
        headers: {
          authorization: `Basic ${Buffer.from('requester:test').toString('base64')}`
        }
      });
      if (response.ok) return { child, origin, output: () => output };
    } catch {
      // The server may not have bound its port yet.
    }

    await delay(100);
  }

  child.kill();
  throw new Error(`CAP server did not become ready within 20 seconds.\n${output}`);
}

async function stopCapServer(server) {
  if (!server || server.child.exitCode !== null) return;

  server.child.kill();
  await Promise.race([
    new Promise(resolve => server.child.once('exit', resolve)),
    delay(5000).then(() => {
      if (server.child.exitCode === null) server.child.kill('SIGKILL');
    })
  ]);
}

module.exports = { startCapServer, stopCapServer };
