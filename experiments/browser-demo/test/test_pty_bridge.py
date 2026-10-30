"""Protocol and real PTY checks; no Herdr server or user session is used."""
import importlib.util
import os
import random
from pathlib import Path
import selectors
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'pty_bridge.py'
spec = importlib.util.spec_from_file_location('pty_bridge', SCRIPT)
pty_bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pty_bridge)


class ProtocolTests(unittest.TestCase):
    def test_fragmented_and_multiple_frames(self):
        source = pty_bridge.frame(1, b'abc') + pty_bridge.frame(3, b'12345678')
        decoder = pty_bridge.FrameDecoder()
        result = []
        for byte in source:
            result.extend(decoder.feed(bytes([byte])))
        self.assertEqual(result, [(1, b'abc'), (3, b'12345678')])
        self.assertEqual(decoder.pending, b'')

    def test_maximum_frame_and_oversized_claim(self):
        decoder = pty_bridge.FrameDecoder()
        source = pty_bridge.frame(1, b'x' * pty_bridge.MAX_PAYLOAD)
        result = []
        for offset in range(0, len(source), pty_bridge.IO_CHUNK):
            result.extend(decoder.feed(source[offset:offset + pty_bridge.IO_CHUNK]))
        self.assertEqual(result, [(1, b'x' * pty_bridge.MAX_PAYLOAD)])
        with self.assertRaises(ValueError):
            decoder.feed(struct.pack('!BI', 1, pty_bridge.MAX_PAYLOAD + 1))

    def test_invalid_control_headers_rejected_before_payload(self):
        for kind, length in ((0, 65536), (255, 1), (2, 65536), (3, 7), (4, 0)):
            with self.assertRaises(ValueError):
                pty_bridge.FrameDecoder().feed(struct.pack('!BI', kind, length))

    def test_randomized_stream_boundaries_preserve_frames(self):
        rng = random.Random(1793)
        expected = []
        for _ in range(100):
            kind = rng.choice((1, 1, 1, 2, 3))
            length = {2: 4, 3: 8}.get(kind, rng.randrange(0, 4097))
            expected.append((kind, bytes(rng.randrange(256) for _ in range(length))))
        source = b''.join(pty_bridge.frame(kind, payload) for kind, payload in expected)
        decoder, result, offset = pty_bridge.FrameDecoder(), [], 0
        while offset < len(source):
            length = rng.randrange(1, pty_bridge.IO_CHUNK + 1)
            result.extend(decoder.feed(source[offset:offset + length]))
            offset += length
        self.assertEqual(result, expected)
        self.assertEqual(decoder.pending, b'')

    def test_input_headroom_handles_completion_plus_next_frame(self):
        decoder = pty_bridge.FrameDecoder()
        packet = pty_bridge.frame(1, b'a' * pty_bridge.MAX_PAYLOAD)
        prefix = packet[:-1]
        for offset in range(0, len(prefix), pty_bridge.IO_CHUNK):
            self.assertEqual(decoder.feed(prefix[offset:offset + pty_bridge.IO_CHUNK]), [])
        suffix = packet[-1:] + pty_bridge.frame(1, b'b' * (pty_bridge.IO_CHUNK - 6))
        queue = bytearray(pty_bridge.MAX_QUEUED - pty_bridge.INPUT_HEADROOM)
        completed = decoder.feed(suffix)
        self.assertGreater(sum(len(payload) for _kind, payload in completed), pty_bridge.MAX_PAYLOAD)
        for kind, payload in completed:
            pty_bridge.receive(kind, payload, -1, queue, bytearray())
        self.assertLessEqual(len(queue), pty_bridge.MAX_QUEUED)

    def test_geometry_and_control_validation(self):
        self.assertEqual(pty_bridge.geometry(20, 5), (20, 5))
        self.assertEqual(pty_bridge.geometry(500, 300), (500, 300))
        for cols, rows in ((19, 20), (501, 20), (80, 4), (80, 301)):
            with self.assertRaises(ValueError):
                pty_bridge.geometry(cols, rows)
        for kind, payload in ((2, b''), (3, b'x'), (4, b''), (255, b'')):
            with self.assertRaises(ValueError):
                pty_bridge.receive(kind, payload, -1, bytearray(), bytearray())
        with self.assertRaises(ValueError):
            pty_bridge.enqueue(bytearray(pty_bridge.MAX_QUEUED), b'x')


@unittest.skipUnless(os.name == 'posix', 'requires Unix PTYs')
class PtyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='herdr-browser-pty-')
        self.root = Path(self.directory.name)
        self.child = None
        self.runtime_pid = None
        fake = self.root / 'herdr'
        fake.write_text('#!' + sys.executable + '\n' + r'''
import fcntl,os,signal,struct,subprocess,sys,termios,tty
from pathlib import Path
assert sys.argv[1:]==['--session','browser-demo-unittest']
assert 'HERDR_ENV' not in os.environ
assert 'HERDR_SOCKET_PATH' not in os.environ
tty.setraw(0)
if os.environ.get('PTY_TEST_MODE')=='output-burst':
 data=b'z'*(700*1024)
 while data:
  data=data[os.write(1,data):]
 sys.exit(0)
Path(os.environ['PTY_TEST_ROOT'],'tui.pid').write_text(str(os.getpid()))
# Model a persistent daemon in another session, as Herdr's runtime is detached.
runtime=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
Path(os.environ['PTY_TEST_ROOT'],'runtime.pid').write_text(str(runtime.pid))
def report(prefix):
 rows,cols,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\0'*8))
 os.write(1,('%s %s %s\n'%(prefix,cols,rows)).encode())
signal.signal(signal.SIGWINCH,lambda *_:report('SIZE'))
report('READY')
while True:
 data=os.read(0,4096)
 if not data:break
 os.write(1,b'ECHO:'+data)
''')
        fake.chmod(0o700)
        self.env = os.environ.copy()
        self.env.update(PATH=str(self.root) + os.pathsep + self.env['PATH'],
                        PTY_TEST_ROOT=str(self.root), HERDR_ENV='1',
                        HERDR_SOCKET_PATH='/not/a/live/socket')
        self.decoder = pty_bridge.FrameDecoder(from_browser=False)
        self.output = bytearray()
        self.events = []

    def tearDown(self):
        if self.child:
            if self.child.poll() is None:
                self.child.kill()
            self.child.wait(timeout=5)
            for stream in (self.child.stdin, self.child.stdout, self.child.stderr):
                if stream:
                    stream.close()
        path = self.root / 'runtime.pid'
        if path.exists():
            try:
                os.kill(int(path.read_text()), signal.SIGTERM)
            except ProcessLookupError:
                pass
        self.directory.cleanup()

    def start(self):
        self.child = subprocess.Popen([sys.executable, str(SCRIPT), '--session',
            'browser-demo-unittest', '--cols', '90', '--rows', '20'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=self.env)
        self.wait_for(b'READY 90 20')
        self.runtime_pid = int((self.root / 'runtime.pid').read_text())
        return self.child

    def wait_for(self, expected, timeout=5):
        deadline = time.monotonic() + timeout
        selector = selectors.DefaultSelector()
        selector.register(self.child.stdout, selectors.EVENT_READ)
        try:
            while expected not in self.output:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    self.fail('timed out waiting for framed PTY output: ' + repr(expected))
                data = os.read(self.child.stdout.fileno(), pty_bridge.IO_CHUNK)
                if not data:
                    self.fail('PTY bridge exited before expected output')
                for kind, payload in self.decoder.feed(data):
                    self.events.append((kind, payload))
                    if kind == pty_bridge.DATA:
                        self.output.extend(payload)
        finally:
            selector.close()

    def test_echo_resize_ping_heartbeat_and_eof_preserves_detached_runtime(self):
        child = self.start()
        child.stdin.write(pty_bridge.frame(pty_bridge.RESIZE, struct.pack('!HH', 200, 45)))
        child.stdin.write(pty_bridge.frame(pty_bridge.PING, b'12345678'))
        child.stdin.write(pty_bridge.frame(pty_bridge.DATA, b'hello'))
        child.stdin.flush()
        self.wait_for(b'SIZE 200 45')
        self.wait_for(b'ECHO:hello')
        self.assertIn((pty_bridge.PING, b'12345678'), self.events)
        self.assertIn((pty_bridge.HEARTBEAT, b''), self.events)
        tui_pid = int((self.root / 'tui.pid').read_text())
        child.stdin.close()
        self.assertEqual(child.wait(timeout=5), 0, child.stderr.read().decode())
        os.kill(self.runtime_pid, 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(tui_pid, 0)
        self.assertNotIn(b'Traceback', child.stderr.read())

    def test_sigterm_closes_attachment_but_not_detached_runtime(self):
        child = self.start()
        tui_pid = int((self.root / 'tui.pid').read_text())
        child.terminate()
        self.assertEqual(child.wait(timeout=5), 0, child.stderr.read().decode())
        os.kill(self.runtime_pid, 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(tui_pid, 0)

    def test_eof_closes_attachment_while_output_is_backpressured(self):
        self.env['PTY_TEST_MODE'] = 'output-burst'
        self.child = subprocess.Popen([sys.executable, str(SCRIPT), '--session',
            'browser-demo-unittest'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=self.env)
        # No output reader: stdout and the bounded application queue fill.
        time.sleep(0.15)
        self.child.stdin.close()
        self.assertEqual(self.child.wait(timeout=3), 0, self.child.stderr.read().decode())

    def test_slow_output_reader_drains_final_burst_without_loss(self):
        self.env['PTY_TEST_MODE'] = 'output-burst'
        self.child = subprocess.Popen([sys.executable, str(SCRIPT), '--session',
            'browser-demo-unittest'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=self.env)
        # Let stdout and the bridge's bounded queue fill before reading.
        time.sleep(0.15)
        selector = selectors.DefaultSelector()
        selector.register(self.child.stdout, selectors.EVENT_READ)
        output = bytearray()
        deadline = time.monotonic() + 5
        try:
            while True:
                if not selector.select(max(0, deadline - time.monotonic())):
                    self.fail('slow-reader output did not finish')
                data = os.read(self.child.stdout.fileno(), pty_bridge.IO_CHUNK)
                if not data:
                    break
                for kind, payload in self.decoder.feed(data):
                    if kind == pty_bridge.DATA:
                        output.extend(payload)
        finally:
            selector.close()
        self.assertEqual(self.child.wait(timeout=5), 0, self.child.stderr.read().decode())
        self.assertEqual(output, b'z' * (700 * 1024))

    def test_untrusted_session_rejected_before_launch(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '--session', 'default'],
                                env=self.env, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.root / 'tui.pid').exists())


if __name__ == '__main__':
    unittest.main()
