import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startDemo } from '../server.mjs';

test('config asset is literal JSON while startup routing and the asset allowlist stay fixed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-browser-assets-'));
  const fixture = { gateway: 'https://gateway.example.test/api/' };
  await writeFile(join(dir, 'config.json'), JSON.stringify(fixture));
  await writeFile(join(dir, 'private.json'), '{"mustNotBeServed":true}');
  const app = await startDemo({ target: 'fixed-target', port: 0 }, {
    assetRoot: pathToFileURL(`${dir}/`),
    bootstrap: () => { throw new Error('Static requests must not bootstrap SSH.'); },
    probe: () => { throw new Error('Static requests must not probe SSH.'); },
  });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const response = await fetch(`${app.origin}/config.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), fixture);
  assert.equal((await (await fetch(`${app.origin}/configuration`)).json()).target, 'fixed-target');
  assert.equal((await fetch(`${app.origin}/private.json`)).status, 404);
});
