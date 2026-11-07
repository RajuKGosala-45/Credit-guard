const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { randomInt } = require('node:crypto');

async function unusedPort() {
  const [minimum, maximum] = process.platform === 'win32' ? [30000, 45000] : [20000, 30000];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = randomInt(minimum, maximum);
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('Could not reserve a free port for the CAP test server.');
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function startCapServer({ env = {}, probePath = '/api/dashboard' } = {}) {
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
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      LLM_PROVIDER: 'offline',
      AGENT_MEMORY_ENABLED: 'true',
      ...env
    },
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
      const response = await fetch(`${origin}${probePath}`, {
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
