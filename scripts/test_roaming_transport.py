"""Isolated helper smoke tests. No live SSH, terminal sessions or packet loss.

HERDR_ROAM_TEST_BIN=$PWD/target/debug/herdr-roam python3 scripts/test_roaming_transport.py
"""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


@unittest.skipUnless(os.name == 'posix' and os.environ.get('HERDR_ROAM_TEST_BIN'),
                     'set HERDR_ROAM_TEST_BIN to a built helper (Unix)')
class TransportSmoke(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='herdr-roam-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = Path(os.environ['HERDR_ROAM_TEST_BIN']).resolve()
        (self.root / 'herdr-roam').symlink_to(self.binary)
        self.env = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ['PATH'],
                        HERDR_TRANSPORT='webtransport-stream-v1',
                        HERDR_ROAM_LISTEN='127.0.0.1',
                        ROAM_TEST_LOG=str(self.root / 'calls'))

    def ssh(self, behavior):
        path = self.root / 'ssh'
        path.write_text('#!/bin/sh\nfor arg do last=$arg; done\n' + behavior + '\n')
        path.chmod(0o700)

    def run_helper(self, payload=b'hello\x00webtransport\n', command='/bin/cat', timeout=20):
        return subprocess.run([str(self.binary), 'connect', '--', '-T', 'fixture', command],
                              input=payload, capture_output=True, env=self.env, timeout=timeout)

    def test_webtransport_binary_roundtrip_and_drain(self):
        self.ssh('exec /bin/sh -c "$last"')
        payload = bytes(range(256)) * 8192
        result = self.run_helper(payload)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertIn(b'selected webtransport-stream-v1', result.stderr)
        self.assertEqual(result.stdout, payload)

    def test_old_server_falls_back_without_consuming_input(self):
        self.env['HERDR_TRANSPORT'] = 'webtransport-stream-v1,ssh'
        self.ssh('case "$last" in\n  "if command -v herdr-roam"*) printf "%s\\n" HERDR_ROAM_UNSUPPORTED_V1 ;;\n  *) exec /bin/sh -c "$last" ;;\nesac')
        payload = b'preserve this input exactly\x00\xff'
        result = self.run_helper(payload)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stdout, payload)
        self.assertIn(b'selected ssh', result.stderr)

    def test_strict_selection_does_not_fallback(self):
        self.ssh('case "$last" in\n "if command -v herdr-roam"*) printf "%s\\n" HERDR_ROAM_UNSUPPORTED_V1 ;;\n *) echo unexpected-fallback >> "$ROAM_TEST_LOG" ;;\nesac')
        result = self.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'calls').exists())
        self.assertEqual(result.stdout, b'')

    def test_committed_failure_never_falls_back_or_replays(self):
        self.env['HERDR_TRANSPORT'] = 'auto'
        self.ssh('printf "call\\n" >> "$ROAM_TEST_LOG"\nexec /bin/sh -c "$last"')
        # No input is necessary: command execution itself must occur only once.
        marker = self.root / 'command-count'
        command = 'printf "ran\\n" >> ' + shlex.quote(str(marker))
        result = self.run_helper(b'', command=command)
        self.assertEqual(marker.read_text(), 'ran\n', result.stderr.decode())
        self.assertEqual((self.root / 'calls').read_text(), 'call\n')
        self.assertIn(b'selected webtransport-stream-v1', result.stderr)

    def test_unknown_protocol_fails_before_ssh(self):
        self.env['HERDR_TRANSPORT'] = 'bogus'
        self.ssh('echo unexpected-ssh >> "$ROAM_TEST_LOG"')
        result = self.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'calls').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
