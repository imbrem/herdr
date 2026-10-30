import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemo, parseArgs } from '../server.mjs';
import { remoteCommand, validateGreeting, bootstrapRelay } from '../bootstrap.mjs';

const fakeOffer = { version: 1, address: '127.0.0.1', port: 60000,
  cert: Buffer.alloc(256, 1).toString('base64'), token: Buffer.alloc(32, 2).toString('base64') };

test('Host, Origin and launch capability are required before any SSH bootstrap', async t => {
  let attempts = 0;
  const app = await startDemo({ target: 'fixture', port: 0, session: 'browser-demo-test', cols: 120, rows: 36 }, {
    bootstrap: () => { attempts++; return { ready: Promise.resolve({ offer: fakeOffer, child: new EventEmitter(), close() {} }) }; },
  });
  t.after(() => app.close());
  for (const headers of [
    {},
    { Origin: app.origin },
    { Origin: 'https://malicious.invalid', 'X-Herdr-Demo-Token': app.nonce },
    { Origin: app.origin, 'X-Herdr-Demo-Token': 'wrong' },
  ]) {
    const result = await fetch(`${app.origin}/bootstrap`, { method: 'POST', headers });
    assert.equal(result.status, 403);
    assert.equal(attempts, 0);
  }
  const badHost = await new Promise((resolve, reject) => {
    const req = request(`${app.origin}/bootstrap`, { method: 'POST', headers: { Host: 'malicious.invalid', Origin: app.origin, 'X-Herdr-Demo-Token': app.nonce } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHost, 403); assert.equal(attempts, 0);
  const result = await fetch(`${app.origin}/bootstrap`, { method: 'POST', headers: {
    Origin: app.origin, 'X-Herdr-Demo-Token': app.nonce,
  } });
  assert.equal(result.status, 200);
  assert.equal(attempts, 1);
  assert.equal((await result.json()).offer.token, fakeOffer.token);
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('HTTP cannot choose a target or command and concurrent attachments are rejected', async t => {
  let attempts = 0;
  const app = await startDemo({ target: 'fixed-target', port: 0, session: 'browser-demo-test', cols: 120, rows: 36 }, {
    bootstrap: config => { assert.equal(config.target, 'fixed-target'); attempts++; return { ready: Promise.resolve({ offer: fakeOffer, child: new EventEmitter(), close() {} }) }; },
  });
  t.after(() => app.close());
  const headers = { Origin: app.origin, 'X-Herdr-Demo-Token': app.nonce };
  const body = await fetch(`${app.origin}/bootstrap`, { method: 'POST', headers, body: '{"target":"other","command":"bad"}' });
  assert.equal(body.status, 400); assert.equal(attempts, 0);
  assert.equal((await fetch(`${app.origin}/bootstrap`, { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(`${app.origin}/bootstrap`, { method: 'POST', headers })).status, 409);
  assert.equal(attempts, 1);
});

test('CLI uses a dedicated session and strict transport command', () => {
  assert.throws(() => parseArgs(['--target', '-oProxyCommand=bad']));
  assert.throws(() => parseArgs(['--target', 'fixture', '--session', 'default']));
  const config = parseArgs(['--target', 'fixture']);
  assert.match(config.session, /^browser-demo-/);
  const command = remoteCommand({ ...config, origin: 'http://127.0.0.1:8765' });
  assert.match(command, /HERDR_ROAM_ALLOWED_ORIGIN=/);
  assert.match(command, /serve --protocols webtransport-stream-v1/);
  assert.match(command, /script -qefc/);
  assert.match(command, /browser-demo-/);
});

test('bootstrap rejects unknown selected protocols and invalid capabilities', () => {
  assert.throws(() => validateGreeting({ selected_protocol: 'ssh', offer: fakeOffer }));
  const greeting = { selected_protocol: 'webtransport-stream-v1', supported_protocols: ['webtransport-stream-v1'], offer: fakeOffer };
  assert.equal(validateGreeting(greeting), fakeOffer);
  assert.throws(() => validateGreeting({ ...greeting, offer: { ...fakeOffer, token: 'short' } }));
});

test('shutdown cancels an SSH bootstrap still waiting for its offer', async () => {
  let began, cancel;
  const started = new Promise(resolve => { began = resolve; });
  const app = await startDemo({ target: 'fixture', port: 0, session: 'browser-demo-test', cols: 120, rows: 36 }, {
    bootstrap: () => {
      const ready = new Promise((_, reject) => { cancel = () => reject(new Error('cancelled')); });
      began();
      return { ready, close: () => cancel() };
    },
  });
  const pending = fetch(`${app.origin}/bootstrap`, { method: 'POST', headers: {
    Origin: app.origin, 'X-Herdr-Demo-Token': app.nonce,
  } });
  await started;
  await app.close();
  assert.equal((await pending).status, 502);
});


test('explicit relay requires SSH authorization before minting a local capability', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-browser-relay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sshPath = join(dir, 'ssh'), helper = join(dir, 'helper'), marker = join(dir, 'helper-started');
  await writeFile(sshPath, '#!/bin/sh\nexit 255\n', { mode: 0o700 });
  await writeFile(helper, `#!/bin/sh\necho started > '${marker}'\n`, { mode: 0o700 });
  const pending = bootstrapRelay({ target: 'fixture', sshPath, helper, origin: 'http://127.0.0.1:8765', session: 'browser-demo-test', cols: 120, rows: 36 });
  await assert.rejects(pending.ready, /SSH authorization check failed/);
  await assert.rejects(access(marker));
});

test('relay is an explicit CLI choice, not an automatic downgrade', () => {
  assert.equal(parseArgs(['--target', 'fixture']).relay, undefined);
  const config = parseArgs(['--target', 'fixture', '--relay', '--helper', '/fixed/helper']);
  assert.equal(config.relay, true);
  assert.equal(config.helper, '/fixed/helper');
});
