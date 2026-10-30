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
  assert.match(command, /python3 -u -c/);
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
  assert.equal((await pending).status, 409);
});

test('disconnect rejects a late offer without clobbering a newer bootstrap', async t => {
  const attempts = [];
  let firstBegan, secondBegan;
  const firstStarted = new Promise(resolve => { firstBegan = resolve; });
  const secondStarted = new Promise(resolve => { secondBegan = resolve; });
  const app = await startDemo({ target: 'fixture', port: 0, session: 'browser-demo-test', cols: 120, rows: 36 }, {
    bootstrap: () => {
      const attempt = { pendingCloses: 0, resultCloses: 0, child: new EventEmitter() };
      const ready = new Promise(resolve => {
        attempt.offer = () => resolve({ offer: fakeOffer, child: attempt.child,
          close: () => { attempt.resultCloses++; } });
      });
      attempts.push(attempt);
      (attempts.length === 1 ? firstBegan : secondBegan)();
      return { ready, close: () => { attempt.pendingCloses++; } };
    },
    probe: () => ({ ready: Promise.resolve({ hostname: 'fixture', username: 'fixture' }), close() {} }),
  });
  t.after(async () => { for (const attempt of attempts) attempt.offer(); await app.close(); });
  const headers = { Origin: app.origin, 'X-Herdr-Demo-Token': app.nonce };
  const post = path => fetch(`${app.origin}${path}`, { method: 'POST', headers });
  const state = async () => (await (await post('/stats')).json()).attachment.state;

  const oldBootstrap = post('/bootstrap');
  await firstStarted;
  assert.equal((await post('/disconnect')).status, 200);
  assert.equal(attempts[0].pendingCloses, 1);
  assert.equal(await state(), 'idle');

  const newBootstrap = post('/bootstrap');
  await secondStarted;
  attempts[0].offer();
  assert.equal((await oldBootstrap).status, 409);
  assert.equal(attempts[0].resultCloses, 1);
  assert.equal(await state(), 'starting');
  assert.equal((await post('/bootstrap')).status, 409);
  assert.equal(attempts.length, 2);

  attempts[1].offer();
  assert.equal((await newBootstrap).status, 200);
  assert.equal(await state(), 'offered');
  attempts[0].child.emit('exit', 0);
  assert.equal(await state(), 'offered');
  assert.equal(attempts[1].resultCloses, 0);
  assert.equal((await post('/disconnect')).status, 200);
  assert.equal(attempts[1].resultCloses, 1);
  assert.equal(await state(), 'idle');
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


test('bootstrap accepts bounded geometry only and snapshots it per attachment', async t => {
  let received;
  const app = await startDemo({ target: 'fixture', port: 0, session: 'browser-demo-test', cols: 120, rows: 36 }, {
    bootstrap: config => { received = config; return { ready: Promise.resolve({ offer: fakeOffer, close() {} }) }; },
  });
  t.after(() => app.close());
  const headers = { Origin: app.origin, 'X-Herdr-Demo-Token': app.nonce, 'Content-Type': 'application/json' };
  for (const value of [{ cols: 10, rows: 30 }, { cols: 501, rows: 30 }, { cols: 80, rows: 301 },
    { cols: 80, rows: 30, target: 'other' }, { cols: '80', rows: 30 }, [80, 30]]) {
    assert.equal((await fetch(`${app.origin}/bootstrap`, { method: 'POST', headers, body: JSON.stringify(value) })).status, 400);
    assert.equal(received, undefined);
  }
  const result = await fetch(`${app.origin}/bootstrap`, { method: 'POST', headers, body: JSON.stringify({ cols: 180, rows: 55 }) });
  assert.equal(result.status, 200);
  assert.equal(received.cols, 180); assert.equal(received.rows, 55); assert.equal(received.target, 'fixture');
  const data = await result.json(); assert.equal(data.cols, 180); assert.equal(data.rows, 55);
  assert.equal(data.applicationProtocol, 'herdr-browser-pty-v1');
});

test('stats require authorization, coalesce probes and cache explicit remote measurements', async t => {
  let count = 0, complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const app = await startDemo({ target: 'fixed-target', port: 0, session: 'browser-demo-stats', cols: 120, rows: 36 }, {
    probe: config => { assert.equal(config.target, 'fixed-target'); count++; return { ready: pending, close() {} }; },
  });
  t.after(() => app.close());
  assert.equal((await fetch(`${app.origin}/stats`, { method: 'POST' })).status, 403);
  assert.equal(count, 0);
  const headers = { Origin: app.origin, 'X-Herdr-Demo-Token': app.nonce };
  const a = fetch(`${app.origin}/stats`, { method: 'POST', headers });
  const b = fetch(`${app.origin}/stats`, { method: 'POST', headers });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(count, 1);
  complete({ hostname: 'real-remote', username: 'fixture', uptimeSeconds: 123, sshProbeMs: 31.5 });
  const first = await (await a).json(); await b;
  assert.equal(first.sshProbeMs, 31.5); assert.equal(first.server.uptimeSeconds, 123);
  assert.equal(first.parentUptimeSeconds >= 0, true); assert.equal(first.attachment.state, 'idle');
  assert.equal('rtt' in first.server, false);
  assert.equal((await fetch(`${app.origin}/stats`, { method: 'POST', headers })).status, 200);
  assert.equal(count, 1);
  assert.equal((await fetch(`${app.origin}/stats`, { method: 'POST', headers, body: '{"target":"other"}' })).status, 400);
  assert.equal(count, 1);
});
