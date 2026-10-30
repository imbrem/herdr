import { timingSafeEqual } from 'node:crypto';
import { validateGeometry } from './config.mjs';

export class HttpError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

export function secureHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function writeResponse(res, status, body, contentType) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

export function send(res, status, body) {
  writeResponse(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

/** Static JSON is already serialized bytes, just like JavaScript and CSS assets. */
export function sendAsset(res, body, contentType) {
  writeResponse(res, 200, body, contentType);
}

export function requireParentRequest(req, origin, nonce) {
  const token = req.headers['x-herdr-demo-token'];
  const actual = typeof token === 'string' ? Buffer.from(token) : Buffer.alloc(0);
  const expected = Buffer.from(nonce);
  if (req.method !== 'POST' || req.headers.origin !== origin || actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)) {
    throw new HttpError(403, 'The launch link and a same-origin request are required.');
  }
}

export function requireEmptyBody(req) {
  if (Number(req.headers['content-length'] ?? 0) !== 0 || req.headers['transfer-encoding']) {
    throw new HttpError(400, 'This endpoint does not accept a request body.');
  }
}

/** Bound both bytes and time without async-iterator early-return destroying the response. */
function readBody(req, { maxBytes = 256, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const finish = (error, value) => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const data = chunk => {
      length += chunk.length;
      if (length > maxBytes) return finish(new HttpError(413, 'Bootstrap body is too large.'));
      chunks.push(chunk);
    };
    const end = () => finish(null, Buffer.concat(chunks).toString('utf8'));
    const fail = () => finish(new HttpError(400, 'Bootstrap request was interrupted.'));
    const aborted = () => finish(new HttpError(400, 'Bootstrap request was interrupted.'));
    const timer = setTimeout(() => finish(new HttpError(408, 'Bootstrap body timed out.')), timeoutMs);
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted);
  });
}

export async function readGeometry(req, config, bodyLimits) {
  const body = await readBody(req, bodyLimits);
  if (!body) return validateGeometry(config);
  if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(400, 'Expected JSON geometry.');
  }
  let value;
  try { value = JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON geometry.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).some(key => !['cols', 'rows'].includes(key))) {
    throw new HttpError(400, 'Only terminal geometry is accepted.');
  }
  try { return validateGeometry(value); }
  catch (error) { throw new HttpError(400, error.message); }
}
