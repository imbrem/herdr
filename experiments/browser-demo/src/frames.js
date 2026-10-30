export const DATA = 1, RESIZE = 2, PING = 3, HEARTBEAT = 4;
export const MAX_FRAME = 64 * 1024;

export function frame(type, payload = new Uint8Array()) {
  if (payload.byteLength > MAX_FRAME) throw new Error('Terminal frame exceeds limit.');
  const bytes = new Uint8Array(5 + payload.byteLength);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(1, payload.byteLength);
  bytes.set(payload, 5);
  return bytes;
}

// Reads arbitrary stream boundaries without retaining an unbounded partial frame.
export class FrameDecoder {
  header = new Uint8Array(5);
  headerUsed = 0;
  payload = undefined;
  used = 0;

  push(chunk) {
    const frames = [];
    let position = 0;
    while (position < chunk.length) {
      if (!this.payload) {
        const count = Math.min(5 - this.headerUsed, chunk.length - position);
        this.header.set(chunk.subarray(position, position + count), this.headerUsed);
        this.headerUsed += count;
        position += count;
        if (this.headerUsed < 5) continue;
        const size = new DataView(this.header.buffer).getUint32(1), type = this.header[0];
        if (size > MAX_FRAME || ![DATA, PING, HEARTBEAT].includes(type) ||
            (type === PING && size !== 8) || (type === HEARTBEAT && size !== 0)) {
          throw new Error('Invalid terminal frame.');
        }
        this.payload = new Uint8Array(size);
        this.used = 0;
      }
      const count = Math.min(this.payload.length - this.used, chunk.length - position);
      this.payload.set(chunk.subarray(position, position + count), this.used);
      position += count;
      this.used += count;
      if (this.used === this.payload.length) {
        frames.push({ type: this.header[0], payload: this.payload });
        this.payload = undefined;
        this.headerUsed = 0;
      }
    }
    return frames;
  }

  finish() {
    if (this.headerUsed || this.payload) throw new Error('Incomplete terminal frame.');
  }
}
