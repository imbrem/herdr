import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { TerminalConnection } from '../src/terminal-connection.js';
import { DATA, RESIZE, PING, HEARTBEAT, frame } from '../src/frames.js';
import { fakeOffer } from './fixtures.mjs';

const bootstrap = () => ({ applicationProtocol: 'herdr-browser-pty-v1', offer: { ...fakeOffer } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('unopened metrics distinguish no connection/update from a real timestamp of zero', () => {
  const connection = new TerminalConnection();
  assert.equal(connection.stats.connectedAt, null);
  assert.equal(connection.stats.lastUpdate, null);
});

function fixture(options = {}) {
  const instances = [];
  const closed = deferred();
  let controller;
  let readCancelled = 0, writeAborted = 0;
  const writes = [];
  const stream = {
    readable: new ReadableStream({ start(value) { controller = value; }, cancel() { readCancelled++; } }),
    writable: new WritableStream({
      async write(value) {
        writes.push(value.slice());
        if (options.write) return await options.write(value, writes.length, controller);
        if (writes.length === 1 && options.autoAck !== false) controller.enqueue(new Uint8Array([1]));
      },
      abort() { writeAborted++; },
    }),
  };
  class FakeTransport {
    constructor(url, settings) {
      this.url = url;
      this.settings = settings;
      this.ready = options.ready ?? Promise.resolve();
      this.closed = closed.promise;
      this.closeCount = 0;
      instances.push(this);
      options.construct?.(this);
    }
    createBidirectionalStream() { return options.creating ?? Promise.resolve(stream); }
    close() { this.closeCount++; }
  }
  const data = [], endings = [], updates = [];
  const connection = new TerminalConnection({
    WebTransportClass: FakeTransport, crypto: webcrypto,
    onData: async value => { data.push(value.slice()); await options.onData?.(value); },
    onClose: error => endings.push(error), onUpdate: value => updates.push(value),
    now: options.now ?? (() => 100), timeouts: options.timeouts,
  });
  return { connection, instances, stream, writes, closed, data, endings, updates,
    get controller() { return controller; },
    get readCancelled() { return readCancelled; }, get writeAborted() { return writeAborted; } };
}

test('strict application and endpoint validation rejects malformed offers before transport construction', async () => {
  for (const mutate of [
    value => { value.applicationProtocol = 'other'; },
    value => { value.offer.version = 2; },
    value => { value.offer.port = 0; },
    value => { value.offer.port = '443'; },
    value => { value.offer.address = 'server.example'; },
    value => { value.offer.address = '127.0.0.1/evil'; },
    value => { value.offer.address = '999.0.0.1'; },
    value => { value.offer.address = '127.01.0.1'; },
    value => { value.offer.address = '0.0.0.0'; },
    value => { value.offer.address = '224.0.0.1'; },
    value => { value.offer.address = '::'; },
    value => { value.offer.address = 'ff02::1'; },
    value => { value.offer.address = '::1%lo0'; },
    value => { value.offer.address = '::bad::'; },
    value => { value.offer.token = Buffer.alloc(31).toString('base64'); },
    value => { value.offer.token += '\n'; },
    value => { value.offer.cert = Buffer.alloc(8193).toString('base64'); },
  ]) {
    const context = fixture(), value = bootstrap();
    mutate(value);
    await assert.rejects(context.connection.open(value));
    assert.equal(context.instances.length, 0);
  }
});

test('open pins the certificate and sends token then COMMIT before any terminal input', async () => {
  const ack = deferred();
  const context = fixture({ write: async (_value, count) => { if (count === 1) await ack.promise; } });
  const opening = context.connection.open(bootstrap());
  for (let attempt = 0; attempt < 20 && context.writes.length === 0; attempt++) await tick();
  assert.equal(context.connection.sendInput(new Uint8Array([42])), false);
  assert.equal(context.connection.ping(), false);
  assert.equal(context.writes.length, 1);
  assert.equal(context.writes[0].length, 32);
  context.controller.enqueue(new Uint8Array([1]));
  ack.resolve();
  await opening;
  assert.deepEqual([...context.writes[1]], [1]);
  const transport = context.instances[0];
  assert.equal(transport.url, 'https://127.0.0.1:60000/herdr-roam/v1');
  const expected = await webcrypto.subtle.digest('SHA-256', Buffer.from(fakeOffer.cert, 'base64'));
  assert.deepEqual(transport.settings.serverCertificateHashes, [{ algorithm: 'sha-256', value: expected }]);
  assert.equal(context.connection.stats.connectedAt, 100);
  assert.equal(context.connection.stats.lastUpdate, null);
  context.connection.close();
});

test('IPv6 endpoint and binary terminal data work with bounded framed input and resize', async () => {
  const context = fixture(), value = bootstrap();
  value.offer.address = '2001:db8::1';
  await context.connection.open(value);
  assert.equal(context.instances[0].url, 'https://[2001:db8::1]:60000/herdr-roam/v1');
  const input = new Uint8Array(40_000).fill(255);
  assert.equal(context.connection.sendInput(input), true);
  input.fill(0); // Enqueued bytes are owned snapshots, not caller-owned buffers.
  assert.equal(context.connection.resize({ cols: 200, rows: 45 }), true);
  await tick();
  await tick();
  assert.deepEqual(context.writes.slice(2, 5).map(value => value.length), [16_389, 16_389, 7237]);
  assert.equal(context.writes[2][5], 255);
  const resize = context.writes[5];
  assert.equal(resize[0], RESIZE);
  assert.equal(new DataView(resize.buffer).getUint16(5), 200);
  assert.equal(new DataView(resize.buffer).getUint16(7), 45);
  assert.equal(context.connection.stats.sentBytes, 40_000);
  context.controller.enqueue(frame(DATA, new Uint8Array([0, 255, 27])));
  await tick();
  assert.deepEqual([...context.data[0]], [0, 255, 27]);
  assert.equal(context.connection.stats.receivedBytes, 3);
  assert.throws(() => context.connection.resize({ cols: 501, rows: 40 }), /geometry/);
  context.connection.close();
});

test('heartbeat and echoed ping update session RTT without counting control traffic as terminal bytes', async () => {
  let now = 100;
  const context = fixture({ now: () => now });
  await context.connection.open(bootstrap());
  assert.equal(context.connection.ping(), true);
  await tick();
  const packet = context.writes[2];
  assert.equal(packet[0], PING);
  now = 175;
  context.controller.enqueue(packet);
  context.controller.enqueue(frame(HEARTBEAT));
  await tick();
  assert.equal(context.connection.stats.lastRtt, 75);
  assert.equal(context.connection.stats.lastUpdate, 175);
  assert.equal(context.connection.stats.sentBytes, 0);
  assert.equal(context.connection.stats.receivedBytes, 0);
  const snapshot = context.connection.stats;
  snapshot.rtts.push(-1);
  assert.deepEqual(context.connection.stats.rtts, [75]);
  // A duplicate or unknown cookie cannot manufacture another RTT sample.
  context.controller.enqueue(packet);
  await tick();
  assert.deepEqual(context.connection.stats.rtts, [75]);
  context.connection.close();
});

test('pending ping cookies and input queues remain bounded', async () => {
  const blocked = deferred();
  const context = fixture({ write: async (_value, count, output) => {
    if (count === 1) output.enqueue(new Uint8Array([1]));
    if (count > 2) await blocked.promise;
  } });
  await context.connection.open(bootstrap());
  for (let index = 0; index < 4; index++) assert.equal(context.connection.ping(), true);
  assert.equal(context.connection.ping(), false);
  assert.equal(context.connection.sendInput(new Uint8Array(60_000)), true);
  assert.equal(context.connection.sendInput(new Uint8Array(10_000)), false);
  assert.equal(context.endings.length, 1);
  assert.match(context.endings[0].message, /queue full/);
  context.closed.reject(new Error('also closed'));
  blocked.resolve();
  await tick();
  assert.equal(context.endings.length, 1);
});

test('an oversized paste is rejected atomically before any part is written', async () => {
  const context = fixture();
  await context.connection.open(bootstrap());
  assert.equal(context.connection.sendInput(new Uint8Array(70_000)), false);
  await tick();
  assert.equal(context.writes.length, 2);
  assert.equal(context.endings.length, 1);
});

test('invalid ACK and authentication timeout clean up without COMMIT or duplicate onClose', async () => {
  const invalid = fixture({ autoAck: false });
  const opening = invalid.connection.open(bootstrap());
  for (let attempt = 0; attempt < 20 && invalid.writes.length === 0; attempt++) await tick();
  invalid.controller.enqueue(new Uint8Array([0]));
  await assert.rejects(opening, /authorization failed/);
  assert.equal(invalid.writes.length, 1);
  assert.equal(invalid.instances[0].closeCount, 1);
  assert.equal(invalid.endings.length, 0);
  const timeout = fixture({ autoAck: false, timeouts: { auth: 10 } });
  await assert.rejects(timeout.connection.open(bootstrap()), /authorization timed out/);
  assert.equal(timeout.writes.length, 1);
  assert.equal(timeout.readCancelled, 1);
});

test('write deadlines cover both authorization and connected terminal input', async () => {
  const blocked = deferred();
  const auth = fixture({ write: () => blocked.promise, timeouts: { write: 10 } });
  await assert.rejects(auth.connection.open(bootstrap()), /authorization write timed out/);
  blocked.resolve();
  const held = deferred();
  const context = fixture({ write: (_value, count, output) => {
    if (count === 1) output.enqueue(new Uint8Array([1]));
    if (count > 2) return held.promise;
  }, timeouts: { write: 10 } });
  await context.connection.open(bootstrap());
  context.connection.sendInput(new Uint8Array([1]));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(context.endings.length, 1);
  assert.match(context.endings[0].message, /input write timed out/);
  held.resolve();
});

test('ready and stream creation have deadlines, including cleanup of a late stream', async () => {
  const waiting = fixture({ ready: deferred().promise, timeouts: { ready: 10 } });
  await assert.rejects(waiting.connection.open(bootstrap()), /connection timed out/);
  assert.equal(waiting.instances[0].closeCount, 1);
  const creating = deferred();
  const late = fixture({ creating: creating.promise, timeouts: { stream: 10 } });
  await assert.rejects(late.connection.open(bootstrap()), /stream timed out/);
  creating.resolve(late.stream);
  await tick();
  assert.equal(late.readCancelled, 1);
  assert.equal(late.writeAborted, 1);
});

test('COMMIT completion gates input and presentation, including ACK leftovers', async () => {
  const committed = deferred();
  const context = fixture({ write: (_value, count, output) => {
    if (count === 1) {
      const terminal = frame(DATA, new Uint8Array([42]));
      output.enqueue(new Uint8Array([1, ...terminal]));
    }
    if (count === 2) return committed.promise;
  } });
  const opening = context.connection.open(bootstrap());
  for (let attempt = 0; attempt < 20 && context.writes.length < 2; attempt++) await tick();
  assert.equal(context.writes.length, 2);
  assert.equal(context.connection.sendInput(new Uint8Array([43])), false);
  assert.equal(context.data.length, 0);
  committed.resolve();
  await opening;
  await tick();
  assert.deepEqual([...context.data[0]], [42]);
  context.connection.close();
});

test('transport.closed rejection is handled even before ready and AbortSignal cancels setup', async () => {
  const ready = deferred();
  const context = fixture({ ready: ready.promise });
  const opening = context.connection.open(bootstrap());
  for (let attempt = 0; attempt < 20 && context.instances.length === 0; attempt++) await tick();
  context.closed.reject(new Error('TLS failed'));
  await assert.rejects(opening, /cancelled/);
  assert.equal(context.endings.length, 0);
  const controller = new AbortController();
  const aborted = fixture({ ready: deferred().promise });
  const attempt = aborted.connection.open(bootstrap(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(attempt, { name: 'AbortError' });
  assert.equal(aborted.endings.length, 0);
});

test('cancellation closes a stream that resolves after create was abandoned', async () => {
  const creating = deferred();
  const context = fixture({ creating: creating.promise });
  const controller = new AbortController();
  const opening = context.connection.open(bootstrap(), { signal: controller.signal });
  for (let attempt = 0; attempt < 20 && context.instances.length === 0; attempt++) await tick();
  await tick();
  controller.abort();
  await assert.rejects(opening, { name: 'AbortError' });
  creating.resolve(context.stream);
  await tick();
  assert.equal(context.readCancelled, 1);
  assert.equal(context.writeAborted, 1);
  assert.equal(context.writes.length, 0);
});

test('remote EOF or malformed terminal framing closes once; intentional close cancels silently', async () => {
  const context = fixture();
  await context.connection.open(bootstrap());
  context.controller.enqueue(new Uint8Array([DATA, 0, 0]));
  context.controller.close();
  await tick();
  assert.equal(context.endings.length, 1);
  assert.match(context.endings[0].message, /Incomplete terminal frame/);
  context.closed.resolve();
  await tick();
  assert.equal(context.endings.length, 1);
  const intentional = fixture();
  await intentional.connection.open(bootstrap());
  intentional.connection.close();
  intentional.connection.close();
  await tick();
  assert.equal(intentional.endings.length, 0);
  assert.equal(intentional.readCancelled, 1);
  assert.equal(intentional.writeAborted, 1);
});

test('slow terminal presentation applies backpressure and cancellation unblocks it', async () => {
  const blocked = deferred();
  const context = fixture({ onData: () => blocked.promise });
  await context.connection.open(bootstrap());
  context.controller.enqueue(frame(DATA, new Uint8Array([1])));
  context.controller.enqueue(frame(DATA, new Uint8Array([2])));
  await tick();
  assert.equal(context.data.length, 1);
  context.connection.close();
  await tick();
  assert.equal(context.readCancelled, 1);
  assert.equal(context.data.length, 1);
  assert.equal(context.endings.length, 0);
  blocked.resolve();
});
