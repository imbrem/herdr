import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSession } from '../src/terminal-session.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const geometry = { cols: 80, rows: 24 };

test('a cancelled old bootstrap cannot open a transport or replace a newer session', async () => {
  const offers = [deferred(), deferred()], opened = [], closed = [], errors = [];
  let bootstraps = 0;
  const session = new TerminalSession({
    gateway: { disconnect: async () => {}, bootstrap: async () => offers[bootstraps++].promise },
    createConnection: () => ({ open: async offer => opened.push(offer), close: () => closed.push(true) }),
    onDisconnected: error => errors.push(error),
  });
  const first = session.connect(geometry);
  await tick();
  const second = session.connect(geometry);
  await tick();
  offers[1].resolve('new'); await second;
  offers[0].resolve('old'); await first;
  assert.deepEqual(opened, ['new']);
  assert.equal(session.phase, 'connected');
  assert.deepEqual(errors, []);
  await session.disconnect();
  assert.equal(closed.length, 1);
});

test('new bootstrap waits for old cleanup, and cleanup failure fails closed', async () => {
  const reset = deferred();
  let disconnects = 0, bootstraps = 0;
  const errors = [];
  const session = new TerminalSession({
    gateway: {
      disconnect: () => ++disconnects === 1 ? reset.promise : Promise.resolve(),
      bootstrap: async () => { bootstraps++; return {}; },
    },
    createConnection: () => ({ open: async () => {}, close() {} }),
    onDisconnected: message => errors.push(message),
  });
  const pending = session.connect(geometry);
  await tick();
  assert.equal(bootstraps, 0);
  reset.reject(new Error('Gateway reset failed.'));
  await pending;
  assert.equal(bootstraps, 0);
  assert.equal(session.phase, 'disconnected');
  assert.deepEqual(errors, ['Gateway reset failed.']);
});

test('obsolete transport termination cannot close its replacement', async () => {
  const callbacks = [];
  const session = new TerminalSession({
    gateway: { disconnect: async () => {}, bootstrap: async () => ({}) },
    createConnection: ({ onClose }) => { callbacks.push(onClose); return { open: async () => {}, close() {} }; },
  });
  await session.connect(geometry);
  await session.connect(geometry);
  callbacks[0](new Error('Old connection ended.'));
  await tick();
  assert.equal(session.phase, 'connected');
  assert.equal(callbacks.length, 2);
});
