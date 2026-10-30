import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function remotePtyCommand({ session, cols, rows }) {
  const tui = `stty rows ${rows} cols ${cols}; exec env TERM=xterm-256color COLORTERM=truecolor herdr --session ${shellQuote(session)}`;
  return `script -qefc ${shellQuote(tui)} /dev/null`;
}

export function remoteCommand(config) {
  return `env HERDR_ROAM_ALLOWED_ORIGIN=${shellQuote(config.origin)} herdr-roam serve --protocols webtransport-stream-v1 -- ${shellQuote(remotePtyCommand(config))}`;
}

export function validateGreeting(greeting) {
  if (greeting.selected_protocol !== 'webtransport-stream-v1' ||
      !greeting.supported_protocols?.includes('webtransport-stream-v1')) {
    throw new Error('Remote helper did not select webtransport-stream-v1.');
  }
  const offer = greeting.offer;
  // Bootstrap is authenticated SSH, but reject malformed data before handing it to a browser.
  if (!offer || offer.version !== 1 || !Number.isInteger(offer.port) || offer.port < 1 || offer.port > 65535 ||
      typeof offer.address !== 'string' || !isIP(offer.address) || ['0.0.0.0', '::'].includes(offer.address) ||
      typeof offer.cert !== 'string' || typeof offer.token !== 'string' ||
      Buffer.from(offer.token, 'base64').length !== 32 ||
      Buffer.from(offer.cert, 'base64').length < 64 || Buffer.from(offer.cert, 'base64').length > 8192) {
    throw new Error('Remote helper returned an invalid attachment offer.');
  }
  return offer;
}

// The target and remote command come only from trusted parent-process configuration.
// No HTTP request may supply a target, session, shell command, path, or environment.
function offerProcess(executable, args, env = process.env) {
  const grouped = process.platform !== 'win32';
  const child = spawn(executable, args, { env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
  let collected = Buffer.alloc(0);
  let settled = false;
  let timer;
  const close = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { grouped && child.pid ? process.kill(-child.pid, 'SIGTERM') : child.kill(); } catch {}
  };
  const ready = new Promise((resolve, reject) => {
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      reject(error);
    };
    timer = setTimeout(() => fail(new Error('SSH bootstrap timed out. Verify SSH access and the remote helper.')), 12_000);
    child.once('error', () => fail(new Error('Could not start SSH.')));
    child.once('exit', code => fail(new Error(`SSH bootstrap ended before an offer (exit ${code ?? 'signal'}).`)));
    // Drain errors without logging or returning arbitrary remote output or credentials.
    child.stderr.on('data', () => {});
    child.stdout.on('data', bytes => {
      if (settled) return;
      collected = Buffer.concat([collected, bytes]);
      if (collected.length > 16 * 1024) return fail(new Error('SSH bootstrap exceeded its size limit.'));
      const newline = collected.indexOf(10);
      if (newline < 0) return;
      try {
        const offer = validateGreeting(JSON.parse(collected.subarray(0, newline).toString('utf8')));
        settled = true;
        clearTimeout(timer);
        collected = Buffer.alloc(0);
        resolve({ offer, close, child });
      } catch {
        fail(new Error('Invalid SSH bootstrap. Install the matching herdr-roam helper on the target.'));
      }
    });
  });
  return { ready, close, child };
}


export function bootstrapOverSsh(config) {
  return offerProcess(config.sshPath ?? 'ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', '--', config.target,
    remoteCommand(config),
  ]);
}

// Explicit fallback topology: browser WT terminates on localhost, then authenticated
// SSH carries the PTY. The browser cannot turn this into an arbitrary SSH proxy.
export function bootstrapRelay(config) {
  let activeClose, cancelled = false;
  const close = () => { cancelled = true; activeClose?.(); };
  const ready = (async () => {
    const preflight = spawn(config.sshPath ?? 'ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', '--', config.target, 'true',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    activeClose = () => preflight.kill();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { preflight.kill(); reject(new Error('SSH authorization check timed out.')); }, 12_000);
      preflight.once('error', () => { clearTimeout(timer); reject(new Error('Could not start SSH authorization check.')); });
      preflight.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('SSH authorization check failed. Verify SSH access first.')); });
    });
    if (cancelled) throw new Error('Bootstrap cancelled.');
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', '--', config.target, remotePtyCommand(config)];
    const command = [config.sshPath ?? 'ssh', ...sshArgs].map(shellQuote).join(' ');
    const helper = config.helper ?? fileURLToPath(new URL('../../target/debug/herdr-roam', import.meta.url));
    const pending = offerProcess(helper, ['serve', '--protocols', 'webtransport-stream-v1', '--', command], {
      ...process.env, HERDR_ROAM_LISTEN: '127.0.0.1', HERDR_ROAM_ALLOWED_ORIGIN: config.origin,
    });
    activeClose = pending.close;
    return await pending.ready;
  })();
  return { ready, close };
}

export function bootstrapAttachment(config) {
  return config.relay ? bootstrapRelay(config) : bootstrapOverSsh(config);
}
