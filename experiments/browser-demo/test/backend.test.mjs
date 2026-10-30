import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { validateConfig } from '../backend/config.mjs';
import { readGeometry } from '../backend/http.mjs';
import { createStatsSampler } from '../backend/stats.mjs';

test('startup validates direct API callers and snapshots the fixed SSH target', () => {
  assert.throws(() => validateConfig({ target: '-oProxyCommand=bad' }));
  assert.throws(() => validateConfig({ target: 'fixture', session: 'default' }));
  assert.throws(() => validateConfig({ target: 'fixture', cols: 1000 }));
  const input = { target: 'fixture' };
  const config = validateConfig(input);
  input.target = 'different';
  assert.equal(config.target, 'fixture');
  assert.equal(Object.isFrozen(config), true);
});

test('geometry body has a byte limit, exact JSON media type, and independent read deadline', async () => {
  const request = (body, contentType = 'application/json') => {
    const req = new PassThrough(); req.headers = { 'content-type': contentType };
    req.end(body); return req;
  };
  await assert.rejects(readGeometry(request('x'.repeat(257)), {}), error => error.statusCode === 413);
  await assert.rejects(readGeometry(request('{"cols":80,"rows":30}', 'application/json-evil'), {}), error => error.statusCode === 400);
  assert.deepEqual(await readGeometry(request('{"cols":80,"rows":30}', 'application/json; charset=utf-8'), {}), { cols: 80, rows: 30 });
  const slow = new PassThrough(); slow.headers = {};
  await assert.rejects(readGeometry(slow, {}, { timeoutMs: 5 }), error => error.statusCode === 408);
  assert.equal(slow.destroyed, false); // The caller can still send the HTTP error response.
  slow.end();
});

test('stats cache setup failures and shutdown settles an unresponsive probe', async () => {
  let attempts = 0;
  const failing = createStatsSampler({}, () => { attempts++; throw new Error('fixture failure'); });
  assert.equal((await failing.sample()).error, 'fixture failure');
  assert.equal((await failing.sample()).server, null);
  assert.equal(attempts, 1);
  failing.close();

  let closes = 0;
  const sampler = createStatsSampler({}, () => ({ ready: new Promise(() => {}), close() { closes++; } }));
  const pending = sampler.sample();
  sampler.close();
  assert.equal((await pending).error, 'SSH stats probe cancelled.');
  assert.equal(closes, 1);
});

test('concurrent stats callers deterministically share one pending probe', async () => {
  let attempts = 0, complete;
  const ready = new Promise(resolve => { complete = resolve; });
  const sampler = createStatsSampler({}, () => { attempts++; return { ready, close() {} }; });
  const first = sampler.sample(), second = sampler.sample();
  assert.equal(attempts, 1);
  complete({ hostname: 'fixture', username: 'fixture', sshProbeMs: 10 });
  assert.deepEqual(await first, await second);
  sampler.close();
});
