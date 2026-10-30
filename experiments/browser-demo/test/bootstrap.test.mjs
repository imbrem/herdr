import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { parseArgs } from '../server.mjs';
import { remoteCommand, validateGreeting, bootstrapRelay, bootstrapOverSsh, probeServer } from '../bootstrap.mjs';
import { fakeOffer } from './fixtures.mjs';

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
  assert.throws(() => validateGreeting(null));
  assert.throws(() => validateGreeting({ selected_protocol: 'ssh', offer: fakeOffer }));
  const greeting = { selected_protocol: 'webtransport-stream-v1', supported_protocols: ['webtransport-stream-v1'], offer: fakeOffer };
  assert.equal(validateGreeting(greeting), fakeOffer);
  assert.throws(() => validateGreeting({ ...greeting, offer: { ...fakeOffer, token: 'short' } }));
  assert.throws(() => validateGreeting({ ...greeting, supported_protocols: 'webtransport-stream-v1' }));
  assert.throws(() => validateGreeting({ ...greeting, offer: { ...fakeOffer, token: `${fakeOffer.token}!` } }));
  assert.throws(() => validateGreeting({ ...greeting, offer: { ...fakeOffer, cert: ` ${fakeOffer.cert}` } }));
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

test('closing an offered helper terminates only its own process group, escalating if needed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-browser-helper-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sshPath = join(dir, 'ssh');
  const greeting = { selected_protocol: 'webtransport-stream-v1', supported_protocols: ['webtransport-stream-v1'], offer: fakeOffer };
  // The fixture ignores TERM to exercise the bounded KILL fallback.
  await writeFile(sshPath, `#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' '${JSON.stringify(greeting)}'\nsleep 30\n`, { mode: 0o700 });
  const pending = bootstrapOverSsh({ target: 'fixture', sshPath, origin: 'http://127.0.0.1:8765', session: 'browser-demo-test', cols: 120, rows: 36 });
  t.after(() => pending.close());
  await pending.ready;
  const exited = once(pending.child, 'exit');
  pending.close();
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
});

test('a missing SSH executable rejects bootstrap and stats without exposing process errors', async () => {
  const config = { target: 'fixture', sshPath: '/nonexistent/herdr-demo-ssh', origin: 'http://127.0.0.1:8765', session: 'browser-demo-test', cols: 120, rows: 36 };
  await assert.rejects(bootstrapOverSsh(config).ready, /^Error: Could not start SSH\.$/);
  await assert.rejects(probeServer(config).ready, /^Error: Could not start SSH stats probe\.$/);
});
