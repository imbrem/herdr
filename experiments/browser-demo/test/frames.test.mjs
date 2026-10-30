import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA, PING, HEARTBEAT, frame, FrameDecoder } from '../src/frames.js';

test('terminal frames survive every stream boundary and preserve binary payloads', () => {
  const packets = [frame(DATA, new Uint8Array([0, 255, 27, 91])), frame(HEARTBEAT), frame(PING, new Uint8Array(8)), frame(DATA)];
  const bytes = Uint8Array.from(packets.flatMap(value => [...value]));
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new FrameDecoder();
    const decoded = [...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))];
    decoder.finish();
    assert.deepEqual(decoded.map(value => value.type), [DATA, HEARTBEAT, PING, DATA]);
    assert.deepEqual([...decoded[0].payload], [0, 255, 27, 91]);
  }
});

test('oversized, unknown, malformed control and truncated frames fail closed', () => {
  const oversized = new Uint8Array([DATA, 0, 1, 0, 1]);
  for (const packet of [oversized, frame(99), frame(PING), frame(HEARTBEAT, new Uint8Array([1]))]) {
    assert.throws(() => new FrameDecoder().push(packet), /Invalid terminal frame/);
  }
  const decoder = new FrameDecoder();
  decoder.push(frame(DATA, new Uint8Array([1, 2])).subarray(0, 6));
  assert.throws(() => decoder.finish(), /Incomplete terminal frame/);
  assert.throws(() => frame(DATA, new Uint8Array(65537)), /exceeds limit/);
});

test('maximum-size binary frame decodes across randomized boundaries', () => {
  const payload = Uint8Array.from({ length: 65536 }, (_, i) => i % 256);
  const source = new Uint8Array(5 + payload.length + 5 + 13);
  source.set(frame(DATA, payload));
  source.set(frame(HEARTBEAT), 5 + payload.length);
  source.set(frame(PING, new Uint8Array(8).fill(73)), 10 + payload.length);
  const decoder = new FrameDecoder(), received = [];
  let seed = 1793;
  for (let offset = 0; offset < source.length;) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const length = 1 + seed % 16384;
    received.push(...decoder.push(source.subarray(offset, offset + length)));
    offset += length;
  }
  decoder.finish();
  assert.deepEqual(received.map(value => value.type), [DATA, HEARTBEAT, PING]);
  assert.deepEqual(received[0].payload, payload);
});

test('invalid frame headers reject before an attacker supplies any payload', () => {
  for (const [type, size] of [[0, 65536], [2, 4], [255, 1], [PING, 7], [HEARTBEAT, 1]]) {
    const header = new Uint8Array(5);
    header[0] = type;
    new DataView(header.buffer).setUint32(1, size);
    assert.throws(() => new FrameDecoder().push(header), /Invalid terminal frame/);
  }
});
