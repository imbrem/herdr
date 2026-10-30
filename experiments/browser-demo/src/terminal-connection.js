import { DATA, RESIZE, PING, frame, FrameDecoder } from './frames.js';

const APPLICATION_PROTOCOL = 'herdr-browser-pty-v1';
const INPUT_LIMIT = 64 * 1024;
const CHUNK_SIZE = 16 * 1024;
const DEFAULT_TIMEOUTS = Object.freeze({ certificate: 5000, ready: 10_000, stream: 5000, auth: 5000, write: 5000, drain: 10_000 });

function decodeBase64(value, minimum, maximum = minimum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) {
    throw new Error('Invalid attachment offer.');
  }
  let decoded;
  try { decoded = atob(value); } catch { throw new Error('Invalid attachment offer.'); }
  if (decoded.length < minimum || decoded.length > maximum || btoa(decoded) !== value) {
    throw new Error('Invalid attachment offer.');
  }
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

// The gateway already validates the SSH offer. Validate it again at this public
// boundary: it must describe one pinned IP endpoint, never a URL or DNS target.
function validateBootstrap(bootstrap) {
  if (bootstrap?.applicationProtocol !== APPLICATION_PROTOCOL) {
    throw new Error('Update the browser gateway and reload this tab.');
  }
  const offer = bootstrap.offer;
  if (!offer || offer.version !== 1 || !Number.isInteger(offer.port) || offer.port < 1 || offer.port > 65535 ||
      typeof offer.address !== 'string' || offer.address.length > 45) throw new Error('Invalid attachment offer.');
  let host;
  if (offer.address.includes(':')) {
    if (!/^[0-9a-fA-F:.]+$/.test(offer.address)) throw new Error('Invalid attachment offer.');
    host = `[${offer.address}]`;
  } else {
    const parts = offer.address.split('.');
    if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) {
      throw new Error('Invalid attachment offer.');
    }
    if (Number(parts[0]) >= 224 && Number(parts[0]) <= 239) throw new Error('Invalid attachment offer.');
    host = offer.address;
  }
  let url;
  try { url = new URL(`https://${host}:${offer.port}/herdr-roam/v1`); }
  catch { throw new Error('Invalid attachment offer.'); }
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname.startsWith('[ff')) {
    throw new Error('Invalid attachment offer.');
  }
  return { url: url.href, certificate: decodeBase64(offer.cert, 64, 8192), token: decodeBase64(offer.token, 32) };
}

function abortError() {
  return new DOMException('Connection cancelled.', 'AbortError');
}

function ignoreFailure(action) {
  try { Promise.resolve(action()).catch(() => {}); } catch { /* Already closed/locked. */ }
}

function discardStream(stream) {
  ignoreFailure(() => stream.readable.cancel());
  ignoreFailure(() => stream.writable.abort());
}

/** One pinned WebTransport terminal attachment, with no DOM or gateway access.
 *
 * open() rejects setup errors; after it resolves, onClose(Error) reports remote
 * termination exactly once. Explicit close/AbortSignal cancellation is silent.
 * Input is admitted only after ACK/COMMIT and is never replayed on reconnect.
 * onData may be async: its completion supplies terminal-render backpressure.
 */
export class TerminalConnection {
  #active;
  #onData;
  #onClose;
  #onUpdate;
  #now;
  #WebTransport;
  #crypto;
  #timeouts;
  #stats = { connectedAt: null, lastUpdate: null, receivedBytes: 0, sentBytes: 0, lastRtt: undefined, rtts: [] };

  constructor({ onData = async () => {}, onClose = () => {}, onUpdate,
    now = () => performance.now(), WebTransportClass = globalThis.WebTransport,
    crypto = globalThis.crypto, timeouts = {} } = {}) {
    this.#onData = onData;
    this.#onClose = onClose;
    this.#onUpdate = onUpdate;
    this.#now = now;
    this.#WebTransport = WebTransportClass;
    this.#crypto = crypto;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  get stats() { return { ...this.#stats, rtts: [...this.#stats.rtts] }; }

  #guard(attachment) {
    if (attachment.closed || this.#active !== attachment) throw abortError();
  }

  async #wait(attachment, promise, timeout, description = 'Connection operation timed out.') {
    let timer;
    const contenders = [promise, attachment.cancelled];
    if (timeout !== undefined) contenders.push(new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), timeout);
    }));
    try {
      const result = await Promise.race(contenders);
      this.#guard(attachment);
      return result;
    } finally { clearTimeout(timer); }
  }

  #update() { if (this.#onUpdate) this.#onUpdate(this.stats); }

  #dispose(attachment) {
    if (attachment.closed) return;
    attachment.closed = true;
    clearTimeout(attachment.drainTimer);
    if (this.#active === attachment) this.#active = undefined;
    attachment.signal?.removeEventListener('abort', attachment.onAbort);
    attachment.cancel(abortError());
    // Cancellation must unblock pending read/write/stream promises. Do not await
    // transport-owned cleanup, which may itself be waiting for a network peer.
    ignoreFailure(() => attachment.reader?.cancel());
    ignoreFailure(() => attachment.writer?.abort());
    ignoreFailure(() => attachment.transport?.close());
  }

  #ended(attachment, error) {
    if (attachment.closed) return;
    const notify = attachment.opened;
    this.#dispose(attachment);
    if (notify) this.#onClose(error instanceof Error ? error : new Error('Connection closed.'));
  }

  #gracefullyClosed(attachment) {
    if (attachment.closed) return;
    if (!attachment.opened) {
      this.#ended(attachment, new Error('Connection closed.'));
      return;
    }
    // Transport closure may precede consumption of buffered receive bytes or
    // completion of async terminal rendering. Stream EOF owns normal completion.
    // Stop sending, but allow that tail to drain before cancelling the reader.
    attachment.draining = true;
    attachment.drainTimer = setTimeout(() => this.#ended(attachment,
      new Error('Connection closed before terminal output drained.')), this.#timeouts.drain);
  }

  close() {
    if (this.#active) this.#dispose(this.#active);
  }

  async open(bootstrap, { signal } = {}) {
    this.close();
    if (signal?.aborted) throw abortError();
    const offer = validateBootstrap(bootstrap);
    if (!this.#WebTransport || !this.#crypto?.subtle) throw new Error('WebTransport requires a supported browser and a secure context.');
    const attachment = { closed: false, opened: false, queued: 0, sending: Promise.resolve(), pings: new Map(), sequence: 0n, signal };
    attachment.cancelled = new Promise((_, reject) => { attachment.cancel = reject; });
    // Cancellation can precede the first awaited operation.
    attachment.cancelled.catch(() => {});
    attachment.onAbort = () => this.#dispose(attachment);
    this.#active = attachment;
    signal?.addEventListener('abort', attachment.onAbort, { once: true });
    try {
      const hash = await this.#wait(attachment, this.#crypto.subtle.digest('SHA-256', offer.certificate),
        this.#timeouts.certificate, 'Certificate preparation timed out.');
      const transport = new this.#WebTransport(offer.url, {
        serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
      });
      attachment.transport = transport;
      // Attach immediately, including while ready/authentication are pending.
      Promise.resolve(transport.closed).then(
        () => this.#gracefullyClosed(attachment),
        () => this.#ended(attachment, new Error('Connection lost.')),
      ).catch(() => {});
      await this.#wait(attachment, transport.ready, this.#timeouts.ready, 'WebTransport connection timed out.');
      const creating = Promise.resolve(transport.createBidirectionalStream());
      // A cancelled/timed-out create may still resolve with live resources later.
      creating.then(stream => { if (attachment.closed) discardStream(stream); }, () => {});
      const stream = await this.#wait(attachment, creating, this.#timeouts.stream, 'Terminal stream timed out.');
      attachment.writer = stream.writable.getWriter();
      attachment.reader = stream.readable.getReader();
      await this.#wait(attachment, attachment.writer.write(offer.token), this.#timeouts.write, 'Server authorization write timed out.');
      const acknowledgment = await this.#wait(attachment, attachment.reader.read(), this.#timeouts.auth, 'Server authorization timed out.');
      if (acknowledgment.done || !(acknowledgment.value instanceof Uint8Array) || acknowledgment.value[0] !== 1 ||
          acknowledgment.value.byteLength > INPUT_LIMIT) throw new Error('Server authorization failed.');
      await this.#wait(attachment, attachment.writer.write(new Uint8Array([1])), this.#timeouts.write, 'Server commitment timed out.');
      attachment.opened = true;
      this.#stats = { connectedAt: this.#now(), lastUpdate: null, receivedBytes: 0, sentBytes: 0, lastRtt: undefined, rtts: [] };
      this.#update();
      // The read task owns EOF/errors after open; ACK leftovers use the same
      // bounded decoder, and cannot reach onData before COMMIT completes.
      void this.#read(attachment, acknowledgment.value.subarray(1));
      return this;
    } catch (error) {
      this.#dispose(attachment);
      throw error;
    }
  }

  #queue(type, payload, beforeWrite) {
    const attachment = this.#active;
    if (!attachment?.opened || attachment.closed || attachment.draining) return false;
    const packet = frame(type, payload);
    if (attachment.queued + packet.byteLength > INPUT_LIMIT) {
      this.#ended(attachment, new Error('Input queue full. Reconnect to continue.'));
      return false;
    }
    attachment.queued += packet.byteLength;
    attachment.sending = attachment.sending.then(async () => {
      this.#guard(attachment);
      if (attachment.draining) return;
      beforeWrite?.();
      await this.#wait(attachment, attachment.writer.write(packet), this.#timeouts.write, 'Terminal input write timed out.');
      if (type === DATA) this.#stats.sentBytes += payload.byteLength;
      this.#update();
    }).catch(error => {
      // Graceful transport shutdown may reject an outstanding input write even
      // while its receive stream still has valid buffered output to present.
      if (!attachment.draining) this.#ended(attachment, error);
    }).finally(() => { attachment.queued -= packet.byteLength; });
    return true;
  }

  sendInput(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Terminal input must be a Uint8Array.');
    const attachment = this.#active;
    if (!attachment?.opened || attachment.draining) return false;
    // Reject an oversized paste before sending any part of it.
    if (attachment.queued + bytes.byteLength + Math.ceil(bytes.byteLength / CHUNK_SIZE) * 5 > INPUT_LIMIT) {
      this.#ended(attachment, new Error('Input queue full. Reconnect to continue.'));
      return false;
    }
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      if (!this.#queue(DATA, bytes.subarray(offset, offset + CHUNK_SIZE))) return false;
    }
    return true;
  }

  resize({ cols, rows }) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 5 || rows > 300) {
      throw new Error('Terminal geometry outside 20..500 columns / 5..300 rows.');
    }
    const payload = new Uint8Array(4), view = new DataView(payload.buffer);
    view.setUint16(0, cols); view.setUint16(2, rows);
    return this.#queue(RESIZE, payload);
  }

  ping() {
    const attachment = this.#active;
    if (!attachment?.opened || attachment.draining) return false;
    const now = this.#now();
    for (const [key, sent] of attachment.pings) if (sent !== undefined && now - sent > 15_000) attachment.pings.delete(key);
    if (attachment.pings.size >= 4) return false;
    const payload = new Uint8Array(8), key = ++attachment.sequence;
    new DataView(payload.buffer).setBigUint64(0, key);
    attachment.pings.set(key.toString(), undefined);
    return this.#queue(PING, payload, () => attachment.pings.set(key.toString(), this.#now()));
  }

  async #present(attachment, decoder, bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('Invalid terminal stream data.');
    // FrameDecoder bounds each partial payload; slicing also bounds each returned
    // frame list even when the transport coalesces many tiny control frames.
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      for (const message of decoder.push(bytes.subarray(offset, offset + CHUNK_SIZE))) {
        this.#guard(attachment);
        this.#stats.lastUpdate = this.#now();
        if (message.type === DATA) {
          this.#stats.receivedBytes += message.payload.byteLength;
          await this.#wait(attachment, this.#onData(message.payload));
        } else if (message.type === PING) {
          const key = new DataView(message.payload.buffer, message.payload.byteOffset, 8).getBigUint64(0).toString();
          const sent = attachment.pings.get(key);
          if (sent !== undefined) {
            this.#stats.lastRtt = this.#now() - sent;
            this.#stats.rtts.push(this.#stats.lastRtt);
            if (this.#stats.rtts.length > 20) this.#stats.rtts.shift();
            attachment.pings.delete(key);
          }
        }
        this.#update();
      }
    }
  }

  async #read(attachment, initial) {
    const decoder = new FrameDecoder();
    try {
      await this.#present(attachment, decoder, initial);
      while (!attachment.closed) {
        const { value, done } = await this.#wait(attachment, attachment.reader.read());
        if (done) {
          decoder.finish();
          this.#ended(attachment, new Error('Remote attachment ended.'));
          break;
        }
        await this.#present(attachment, decoder, value);
      }
    } catch (error) { this.#ended(attachment, error); }
    finally { ignoreFailure(() => attachment.reader?.releaseLock()); }
  }
}
