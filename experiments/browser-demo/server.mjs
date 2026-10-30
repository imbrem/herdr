import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { bootstrapAttachment, probeServer } from './bootstrap.mjs';
import { APPLICATION_PROTOCOL, TRANSPORT_PROTOCOL, parseArgs, validateConfig } from './backend/config.mjs';
import { HttpError, secureHeaders, send, sendAsset, requireParentRequest, requireEmptyBody, readGeometry } from './backend/http.mjs';
import { createAttachments } from './backend/attachments.mjs';
import { createStatsSampler } from './backend/stats.mjs';

export { parseArgs } from './backend/config.mjs';

const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/client.js', ['client.js', 'text/javascript; charset=utf-8']],
  ['/client.css', ['client.css', 'text/css; charset=utf-8']],
  ['/config.json', ['config.json', 'application/json; charset=utf-8']],
]);

/** Loopback parent: authenticated control requests, fixed SSH configuration, local assets. */
export async function startDemo(input, {
  bootstrap = bootstrapAttachment, probe = probeServer,
  assetRoot = new URL('./dist/', import.meta.url),
} = {}) {
  const config = validateConfig(input);
  const nonce = randomBytes(32).toString('base64url');
  const attachments = createAttachments(config, bootstrap);
  const stats = createStatsSampler(config, probe);
  const parentStartedAt = new Date().toISOString(), parentStarted = performance.now();
  let origin, expectedHost, closing = false, closePromise;
  const configuration = {
    relay: Boolean(config.relay), target: config.target, session: config.session,
    cols: config.cols, rows: config.rows, applicationProtocol: APPLICATION_PROTOCOL,
  };

  async function handle(req, res) {
    secureHeaders(res);
    // Errors after a rejected/aborted body must not become unhandled stream errors.
    req.on('error', () => {});
    if (closing) res.shouldKeepAlive = false;
    res.once('finish', () => { if (closing) server.closeIdleConnections(); });
    if (req.headers.host !== expectedHost) throw new HttpError(403, 'Unexpected Host.');
    if (req.url === '/configuration' && req.method === 'GET') return send(res, 200, configuration);

    if (['/bootstrap', '/disconnect', '/stats'].includes(req.url)) {
      requireParentRequest(req, origin, nonce); // Authorize before reading a body or invoking SSH.
      if (req.url !== '/bootstrap') requireEmptyBody(req);
      if (req.url === '/stats') {
        const sampled = await stats.sample();
        return send(res, 200, {
          target: config.target, session: config.session, relay: Boolean(config.relay),
          parentStartedAt, parentUptimeSeconds: (performance.now() - parentStarted) / 1000,
          attachment: attachments.snapshot(), ...sampled,
        });
      }
      if (req.url === '/disconnect') {
        attachments.cancel();
        return send(res, 200, { ok: true });
      }
      if (attachments.busy) throw new HttpError(409, 'An attachment is already open. Disconnect it first.');
      const generation = attachments.generation;
      const abort = new AbortController();
      const onClose = () => { if (!res.writableFinished) abort.abort(); };
      res.once('close', onClose);
      try {
        const size = await readGeometry(req, config);
        const offer = await attachments.open(size, origin, generation, abort.signal);
        return send(res, 200, {
          protocol: TRANSPORT_PROTOCOL, relay: Boolean(config.relay), offer,
          session: config.session, ...size, applicationProtocol: APPLICATION_PROTOCOL,
        });
      } finally { res.off('close', onClose); }
    }

    const asset = req.method === 'GET' ? ASSETS.get(req.url) : undefined;
    if (!asset) throw new HttpError(404, 'Not found.');
    const [file, type] = asset;
    try { sendAsset(res, await readFile(new URL(file, assetRoot)), type); }
    catch { throw new HttpError(503, 'Build the local assets first: npm ci && npm run build'); }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      // Rejected requests may still have unread bytes; close their own HTTP connection.
      res.shouldKeepAlive = false;
      const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
        ? error.statusCode : 502;
      send(res, status, { error: error instanceof Error ? error.message : 'Gateway request failed.' });
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  expectedHost = new URL(origin).host;
  return { server, origin, nonce, url: `${origin}/#${nonce}`, close() {
    if (closePromise) return closePromise;
    closing = true;
    attachments.close(); stats.close();
    closePromise = new Promise(resolve => {
      const timer = setTimeout(() => server.closeAllConnections(), 1_000);
      timer.unref();
      server.close(() => { clearTimeout(timer); resolve(); });
    });
    return closePromise;
  } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const config = parseArgs(process.argv.slice(2));
    const app = await startDemo(config);
    console.log(`Herdr browser demo for ${config.target}, isolated session ${config.session}`);
    console.log(config.relay ? 'Explicit relay: browser WebTransport → localhost helper → SSH → remote Herdr' : 'Direct: browser WebTransport → remote Herdr helper');
    console.log(`Open this local launch link: ${app.url}`);
    console.log('The fragment is a local launch capability. Do not share the link. Ctrl+C closes this parent app.');
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (closing) return;
      closing = true;
      await app.close();
      console.log(`The dedicated Herdr session ${config.session} remains on ${config.target}.`);
      process.exit(0);
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
