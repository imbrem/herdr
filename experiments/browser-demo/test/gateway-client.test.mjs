import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayClient, captureCapability, gatewayUrl, loadGatewayUrl } from '../src/gateway-client.js';

const capability = 'A'.repeat(43);
const page = 'https://terminal.example/tools/herdr/';

test('static deployment preserves a path prefix and rejects credential-bearing or insecure gateways', async () => {
  assert.equal(gatewayUrl(null, page).href, page);
  assert.equal(gatewayUrl('https://gateway.example/api', page).href, 'https://gateway.example/api/');
  for (const value of ['http://gateway.example', 'https://u:p@gateway.example', 'https://gateway.example/?token=x', 'https://gateway.example/#token', 'javascript:alert(1)']) {
    assert.throws(() => gatewayUrl(value, page));
  }
  const url = await loadGatewayUrl(page, async () => Response.json({ gateway: 'https://gateway.example/api/' }));
  assert.equal(url.href, 'https://gateway.example/api/');
  assert.equal((await loadGatewayUrl(page, async () => new Response('', { status: 404 }))).href, page);
});

test('launch capability is removed from URL and scoped to a gateway and tab storage', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  let replaced;
  const location = { hash: `#${capability}`, pathname: '/tools/herdr/', search: '' };
  const history = { replaceState: (_state, _title, url) => { replaced = url; } };
  const first = new URL('https://gateway.example/api/');
  assert.equal(captureCapability(first, { location, history, storage }), capability);
  assert.equal(replaced, '/tools/herdr/');
  location.hash = '';
  assert.equal(captureCapability(first, { location, history, storage }), capability);
  assert.equal(captureCapability(new URL('https://other.example/'), { location, history, storage }), '');
  location.hash = '#invalid';
  assert.throws(() => captureCapability(first, { location, history, storage }), /Invalid launch link/);
});

test('control requests never redirect credentials and cancel oversized responses', async () => {
  let cancelled = false;
  const client = new GatewayClient({ baseUrl: 'https://gateway.example/api/', capability,
    fetchImpl: async (url, options) => {
      assert.equal(url.href, 'https://gateway.example/api/stats');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers['X-Herdr-Demo-Token'], capability);
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(65537)); },
        cancel() { cancelled = true; },
      }));
    },
  });
  await assert.rejects(client.stats(), /size limit/);
  assert.equal(cancelled, true);
});

test('missing authorization makes no network request; malformed JSON fails explicitly', async () => {
  let calls = 0;
  const client = new GatewayClient({ baseUrl: page, fetchImpl: async () => { calls++; return new Response('not JSON'); } });
  await assert.rejects(client.bootstrap({ cols: 80, rows: 24 }), /launch link/);
  assert.equal(calls, 0);
  client.authorize(capability);
  await assert.rejects(client.stats(), /invalid JSON/);
  assert.equal(calls, 1);
});

test('native fetch adapters retain the global receiver', async () => {
  const client = new GatewayClient({ baseUrl: page, capability, fetchImpl: function () {
    assert.equal(this, globalThis);
    return Promise.resolve(Response.json({ ok: true }));
  } });
  assert.deepEqual(await client.stats(), { ok: true });
});
