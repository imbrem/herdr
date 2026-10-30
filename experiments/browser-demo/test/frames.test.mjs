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
