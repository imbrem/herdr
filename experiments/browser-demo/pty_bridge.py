#!/usr/bin/env python3
"""Bounded browser terminal framing around one dedicated Herdr TUI attachment.

Wire: type:u8, payload_length:u32be, payload. DATA=1, RESIZE=2 (cols/rows:u16be),
PING/PONG=3 (8 opaque bytes), HEARTBEAT=4 (empty, server to client only).
This is an application protocol inside the unchanged WebTransport byte stream.
"""
import argparse
import errno
import fcntl
import os
import pty
import re
import selectors
import signal
import struct
import sys
import termios
import time

DATA, RESIZE, PING, HEARTBEAT = 1, 2, 3, 4
HEADER = struct.Struct('!BI')
MAX_PAYLOAD = 64 * 1024
MAX_QUEUED = 256 * 1024
IO_CHUNK = 16 * 1024
HEARTBEAT_SECONDS = 2.0
SESSION_RE = re.compile(r'browser-demo-[A-Za-z0-9-]{1,48}\Z')


def geometry(cols, rows):
    if not (20 <= cols <= 500 and 5 <= rows <= 300):
        raise ValueError('terminal geometry outside 20..500 columns / 5..300 rows')
    return cols, rows


def frame(kind, payload=b''):
    if len(payload) > MAX_PAYLOAD:
        raise ValueError('terminal frame exceeds payload limit')
    return HEADER.pack(kind, len(payload)) + payload


class FrameDecoder:
    def __init__(self):
        self.pending = bytearray()

    def feed(self, data):
        # Callers supply at most IO_CHUNK bytes; malformed claimed sizes are
        # rejected as soon as the header is complete, before allocating payload.
        if len(data) > IO_CHUNK:
            raise ValueError('terminal read chunk exceeds limit')
        self.pending.extend(data)
        frames = []
        while len(self.pending) >= HEADER.size:
            kind, length = HEADER.unpack_from(self.pending)
            if length > MAX_PAYLOAD:
                raise ValueError('terminal frame exceeds payload limit')
            end = HEADER.size + length
            if len(self.pending) < end:
                break
            frames.append((kind, bytes(self.pending[HEADER.size:end])))
            del self.pending[:end]
        return frames


def resize(master, cols, rows):
    geometry(cols, rows)
    # The PTY owner changes the kernel's dimensions. This also notifies the
    # foreground terminal process group with SIGWINCH; no shell text is injected.
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def enqueue(queue, data):
    if len(queue) + len(data) > MAX_QUEUED:
        raise ValueError('terminal queue exceeds limit')
    queue.extend(data)


def receive(kind, payload, master, to_pty, to_browser):
    if kind == DATA:
        enqueue(to_pty, payload)
    elif kind == RESIZE:
        if len(payload) != 4:
            raise ValueError('resize requires exactly four bytes')
        resize(master, *struct.unpack('!HH', payload))
    elif kind == PING:
        if len(payload) != 8:
            raise ValueError('ping requires exactly eight bytes')
        enqueue(to_browser, frame(PING, payload))
    else:
        raise ValueError('unsupported browser terminal frame')


def spawn_attachment(session, cols, rows):
    if not SESSION_RE.fullmatch(session):
        raise ValueError('use a dedicated browser-demo-* session')
    geometry(cols, rows)
    pid, master = pty.fork()
    if pid == 0:
        try:
            resize(0, cols, rows)
            env = os.environ.copy()
            # Caller routing must not select the SSH shell's Herdr session.
            for name in ('HERDR_ENV', 'HERDR_SESSION', 'HERDR_SOCKET_PATH',
                         'HERDR_CLIENT_SOCKET_PATH', 'HERDR_WORKSPACE_ID',
                         'HERDR_TAB_ID', 'HERDR_PANE_ID', 'HERDR_PANE_RUNTIME_ID'):
                env.pop(name, None)
            env.update(TERM='xterm-256color', COLORTERM='truecolor')
            os.execvpe('herdr', ['herdr', '--session', session], env)
        except BaseException:
            # Never send tracebacks, environment values, or SSH bootstrap data
            # into the framed channel. The parent gets a normal PTY EOF.
            os._exit(127)
    return pid, master


def stop_attachment(pid, reaped):
    if reaped:
        return
    # pty.fork gives this TUI its own session/process group. A persistent Herdr
    # daemon detaches into another session and must never be signalled here.
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
        try:
            ended, _status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return
        if ended == pid:
            return
        try:
            os.killpg(pid, sig)
        except PermissionError:
            # Some hosts deny process-group signalling after PTY hangup. The
            # still-unreaped direct child remains a safe individual fallback.
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        except ProcessLookupError:
            pass
        until = time.monotonic() + 0.3
        while time.monotonic() < until:
            try:
                result, _status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return
            if result == pid:
                return
            time.sleep(0.01)


def bridge(session, cols, rows):
    pid, master = spawn_attachment(session, cols, rows)
    selector = selectors.DefaultSelector()
    decoder, to_pty, to_browser = FrameDecoder(), bytearray(), bytearray()
    stopping = False
    reaped = False
    terminal_done = False
    next_heartbeat = time.monotonic()
    previous_signals = {}

    def stop(_signum, _stack):
        nonlocal stopping
        stopping = True

    def interest(fd, events):
        try:
            key = selector.get_key(fd)
        except KeyError:
            if events:
                selector.register(fd, events)
        else:
            if events:
                if key.events != events:
                    selector.modify(fd, events)
            else:
                selector.unregister(fd)

    try:
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            previous_signals[sig] = signal.signal(sig, stop)
        for fd in (0, 1, master):
            os.set_blocking(fd, False)
        while not stopping:
            now = time.monotonic()
            if now >= next_heartbeat:
                if len(to_browser) + HEADER.size <= MAX_QUEUED:
                    enqueue(to_browser, frame(HEARTBEAT))
                next_heartbeat = now + HEARTBEAT_SECONDS
            if terminal_done and not to_browser:
                break
            interest(0, selectors.EVENT_READ if not terminal_done and
                     len(to_pty) <= MAX_QUEUED - MAX_PAYLOAD and
                     len(to_browser) <= MAX_QUEUED - MAX_PAYLOAD else 0)
            master_events = 0
            if not terminal_done:
                if len(to_browser) <= MAX_QUEUED - IO_CHUNK - HEADER.size:
                    master_events |= selectors.EVENT_READ
                if to_pty:
                    master_events |= selectors.EVENT_WRITE
            interest(master, master_events)
            interest(1, selectors.EVENT_WRITE if to_browser else 0)
            for key, events in selector.select(min(0.25, max(0, next_heartbeat - now))):
                fd = key.fd
                if fd == 0:
                    chunk = os.read(0, IO_CHUNK)
                    if not chunk:
                        stopping = True
                        break
                    for kind, payload in decoder.feed(chunk):
                        receive(kind, payload, master, to_pty, to_browser)
                elif fd == 1:
                    written = os.write(1, to_browser)
                    del to_browser[:written]
                else:
                    if events & selectors.EVENT_READ:
                        try:
                            chunk = os.read(master, IO_CHUNK)
                        except OSError as error:
                            if error.errno != errno.EIO:
                                raise
                            chunk = b''
                        if chunk:
                            enqueue(to_browser, frame(DATA, chunk))
                        else:
                            terminal_done = True
                            to_pty.clear()
                    if events & selectors.EVENT_WRITE and to_pty and not terminal_done:
                        written = os.write(master, to_pty)
                        del to_pty[:written]
            if not reaped:
                result, _status = os.waitpid(pid, os.WNOHANG)
                reaped = result == pid
    finally:
        selector.close()
        os.close(master)
        stop_attachment(pid, reaped)
        for sig, previous in previous_signals.items():
            signal.signal(sig, previous)
    return 0


def main():
    parser = argparse.ArgumentParser(description='Dedicated Herdr browser PTY attachment')
    parser.add_argument('--session', required=True)
    parser.add_argument('--cols', type=int, default=120)
    parser.add_argument('--rows', type=int, default=36)
    args = parser.parse_args()
    if not SESSION_RE.fullmatch(args.session):
        parser.error('use a dedicated browser-demo-* session')
    try:
        geometry(args.cols, args.rows)
        return bridge(args.session, args.cols, args.rows)
    except (ValueError, OSError) as error:
        print('browser PTY: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
