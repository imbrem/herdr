import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { startDemo } from '../server.mjs';
import { fakeOffer } from './fixtures.mjs';

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
  // Cancellation settles before a delayed subprocess produces any offer.
  assert.equal((await oldBootstrap).status, 409);
  assert.equal(await state(), 'idle');

  const newBootstrap = post('/bootstrap');
  await secondStarted;
  attempts[0].offer();
  assert.equal(await state(), 'starting');
  assert.equal(attempts[0].resultCloses, 1);
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

test('oversized HTTP bodies return a complete error response without starting SSH', async t => {
  let attempts = 0;
  const app = await startDemo({ target: 'fixture', port: 0 }, {
    bootstrap: () => { attempts++; throw new Error('must not start'); },
  });
  t.after(() => app.close());
  const result = await fetch(`${app.origin}/bootstrap`, { method: 'POST',
    headers: { Origin: app.origin, 'X-Herdr-Demo-Token': app.nonce, 'Content-Type': 'application/json' },
    body: 'x'.repeat(257),
  });
  assert.equal(result.status, 413);
  assert.equal((await result.json()).error, 'Bootstrap body is too large.');
  assert.equal(attempts, 0);
});

test('disconnect during geometry upload invalidates the request before SSH can start', async t => {
  let attempts = 0;
  const app = await startDemo({ target: 'fixture', port: 0 }, {
    bootstrap: () => { attempts++; throw new Error('must not start'); },
  });
  t.after(() => app.close());
  const body = '{"cols":80,"rows":30}';
  const headers = { Origin: app.origin, 'X-Herdr-Demo-Token': app.nonce,
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  const received = new Promise(resolve => app.server.once('request', resolve));
  let upload;
  const response = new Promise((resolve, reject) => {
    upload = request(`${app.origin}/bootstrap`, { method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode); });
    upload.on('error', reject);
    upload.write(body.slice(0, 1));
  });
  t.after(() => upload.destroy());
  await received;
  assert.equal((await fetch(`${app.origin}/disconnect`, { method: 'POST',
    headers: { Origin: app.origin, 'X-Herdr-Demo-Token': app.nonce },
  })).status, 200);
  upload.end(body.slice(1));
  assert.equal(await response, 409);
  assert.equal(attempts, 0);
});

test('stats require authorization, coalesce probes and cache explicit remote measurements', async t => {
  let count = 0, complete, began;
  const started = new Promise(resolve => { began = resolve; });
  const pending = new Promise(resolve => { complete = resolve; });
  const app = await startDemo({ target: 'fixed-target', port: 0, session: 'browser-demo-stats', cols: 120, rows: 36 }, {
    probe: config => { assert.equal(config.target, 'fixed-target'); count++; began(); return { ready: pending, close() {} }; },
  });
  t.after(() => app.close());
  assert.equal((await fetch(`${app.origin}/stats`, { method: 'POST' })).status, 403);
  assert.equal(count, 0);
  const headers = { Origin: app.origin, 'X-Herdr-Demo-Token': app.nonce };
  const a = fetch(`${app.origin}/stats`, { method: 'POST', headers });
  const b = fetch(`${app.origin}/stats`, { method: 'POST', headers });
  await started;
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
