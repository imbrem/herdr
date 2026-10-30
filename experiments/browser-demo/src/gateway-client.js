/**
 * HTTPS control plane. No terminal bytes or SSH private keys cross this API.
 *
 * A bootstrap adapter supplies configuration and a one-use transport offer. A
 * future token/key/OAuth adapter can implement this same small interface; the
 * terminal renderer and WebTransport framing do not depend on its login method.
 */
const RESPONSE_LIMIT = 64 * 1024;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function gatewayUrl(value, pageUrl) {
  const url = new URL(value || './', pageUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS gateway URL without credentials, query or fragment.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function readJson(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > RESPONSE_LIMIT) throw new Error('Gateway response exceeds its size limit.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Gateway returned invalid JSON.'); }
}

export class GatewayClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, capability = '' }) {
    this.baseUrl = gatewayUrl(baseUrl, baseUrl);
    // Native window.fetch rejects an arbitrary receiver such as this client.
    this.fetch = fetchImpl.bind(globalThis);
    this.authorize(capability);
  }

  get authorized() { return Boolean(this.capability); }

  authorize(capability) {
    if (capability && !CAPABILITY_PATTERN.test(capability)) throw new Error('Invalid launch capability.');
    this.capability = capability;
  }

  async #request(path, { body, signal, method = 'POST', timeout = 8000, authenticate = true } = {}) {
    if (authenticate && !this.authorized) throw new Error('Open the launch link from the gateway.');
    const timeoutSignal = AbortSignal.timeout(timeout);
    const response = await this.fetch(new URL(path, this.baseUrl), {
      method, cache: 'no-store', credentials: 'omit', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      headers: {
        ...(authenticate ? { 'X-Herdr-Demo-Token': this.capability } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await readJson(response);
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error.slice(0, 512) : `Gateway request failed (${response.status}).`);
    return data;
  }

  async configuration() {
    const config = await this.#request('configuration', { method: 'GET', authenticate: false, timeout: 5000 });
    if (!config || typeof config.target !== 'string' || config.target.length > 256 ||
        typeof config.session !== 'string' || config.session.length > 128 ||
        typeof config.relay !== 'boolean' || config.applicationProtocol !== 'herdr-browser-pty-v1') {
      throw new Error('Gateway configuration is incompatible with this terminal.');
    }
    return Object.freeze(config);
  }

  bootstrap(geometry, { signal } = {}) {
    return this.#request('bootstrap', { body: geometry, signal, timeout: 30_000 });
  }

  disconnect() { return this.authorized ? this.#request('disconnect', { timeout: 3000 }) : Promise.resolve(); }
  stats() { return this.#request('stats'); }
}

/** Build output can choose a different HTTPS adapter; missing config keeps local development working. */
export async function loadGatewayUrl(pageUrl, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(new URL('./config.json', pageUrl), {
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) return gatewayUrl(null, pageUrl);
  if (!response.ok) throw new Error('Could not load terminal configuration.');
  const config = await readJson(response);
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => key !== 'gateway') ||
      (config.gateway !== null && typeof config.gateway !== 'string')) {
    throw new Error('Invalid terminal configuration.');
  }
  return gatewayUrl(config.gateway, pageUrl);
}

/** Store only the local launch capability, scoped to its gateway and this tab. */
export function captureCapability(baseUrl, { location, history, storage }) {
  const key = `herdr-launch:${baseUrl.href}`;
  const fragment = location.hash.slice(1);
  let capability = fragment;
  if (fragment) {
    history.replaceState(null, '', location.pathname + location.search);
    if (!CAPABILITY_PATTERN.test(fragment)) throw new Error('Invalid launch link.');
    try { storage?.setItem(key, fragment); } catch { /* Storage may be disabled. */ }
  } else {
    try { capability = storage?.getItem(key) ?? ''; } catch { /* A launch link still works. */ }
  }
  return capability;
}
