import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { bootstrapAttachment } from './bootstrap.mjs';

const TYPES = { '/': ['index.html', 'text/html; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript; charset=utf-8'],
  '/client.css': ['client.css', 'text/css; charset=utf-8'] };

export function parseArgs(args) {
  const config = { target: '', port: 8765, cols: 120, rows: 36, session: `browser-demo-${randomBytes(5).toString('hex')}` };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--relay') { config.relay = true; continue; }
    if (!['--target', '--port', '--session', '--helper'].includes(name) || args[i + 1] === undefined) {
      throw new Error('Usage: node server.mjs --target telperion [--port 8765] [--session browser-demo-name] [--relay] [--helper /path/to/herdr-roam]');
    }
    config[name.slice(2)] = name === '--port' ? Number(args[++i]) : args[++i];
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(config.target)) throw new Error('Provide a normal SSH host/alias with --target.');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid port.');
  if (!/^browser-demo-[A-Za-z0-9-]{1,48}$/.test(config.session)) throw new Error('Use a dedicated browser-demo-* session.');
  return config;
}

function secretMatches(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startDemo(config, { bootstrap = bootstrapAttachment } = {}) {
  const nonce = randomBytes(32).toString('base64url');
  let origin;
  let attachment;
  let pendingAttachment;
  let starting = false;
  const send = (res, status, body, contentType = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.headers.host !== new URL(origin).host) return send(res, 403, { error: 'Unexpected Host.' });
    if (req.url === '/configuration' && req.method === 'GET') return send(res, 200, { relay: Boolean(config.relay), target: config.target });
    if (req.url === '/bootstrap' || req.url === '/disconnect') {
      if (req.method !== 'POST' || req.headers.origin !== origin ||
          !secretMatches(req.headers['x-herdr-demo-token'], nonce)) {
        return send(res, 403, { error: 'The launch link and a same-origin request are required.' });
      }
      if (Number(req.headers['content-length'] ?? 0) !== 0 || req.headers['transfer-encoding']) {
        return send(res, 400, { error: 'This endpoint does not accept a request body.' });
      }
      if (req.url === '/disconnect') {
        pendingAttachment?.close();
        attachment?.close(); attachment = undefined;
        return send(res, 200, { ok: true });
      }
      if (starting || attachment) return send(res, 409, { error: 'An attachment is already open. Disconnect it first.' });
      starting = true;
      try {
        const pending = bootstrap({ ...config, origin });
        pendingAttachment = pending;
        res.once('close', () => { if (!res.writableFinished) pending.close(); });
        const result = await pending.ready;
        if (res.destroyed) { result.close(); return; }
        attachment = result;
        result.child?.once('exit', () => { if (attachment === result) attachment = undefined; });
        send(res, 200, { protocol: 'webtransport-stream-v1', relay: Boolean(config.relay), offer: result.offer,
          session: config.session, cols: config.cols, rows: config.rows });
      } catch (error) {
        send(res, 502, { error: error.message });
      } finally { starting = false; pendingAttachment = undefined; }
      return;
    }
    if (req.method !== 'GET' || !TYPES[req.url]) return send(res, 404, { error: 'Not found.' });
    const [file, type] = TYPES[req.url];
    try { send(res, 200, await readFile(new URL(`./dist/${file}`, import.meta.url)), type); }
    catch { send(res, 503, { error: 'Build the local assets first: npm ci && npm run build' }); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, nonce, url: `${origin}/#${nonce}`, close: async () => {
    pendingAttachment?.close();
    attachment?.close();
    await new Promise(resolve => server.close(resolve));
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
      if (closing) return; closing = true;
      await app.close();
      console.log(`The dedicated Herdr session ${config.session} remains on ${config.target}.`);
      process.exit(0);
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
