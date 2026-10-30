import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function remotePtyCommand({ session, cols, rows }) {
  const source = readFileSync(new URL('./pty_bridge.py', import.meta.url), 'utf8');
  return `python3 -u -c ${shellQuote(source)} --session ${shellQuote(session)} --cols ${cols} --rows ${rows}`;
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


const SERVER_INFO_SCRIPT = `import getpass,json,os,platform,subprocess
from pathlib import Path
info={"hostname":platform.node(),"username":getpass.getuser(),"os":platform.system(),"kernel":platform.release(),"cpuCount":os.cpu_count()}
try: info["uptimeSeconds"]=float(Path("/proc/uptime").read_text().split()[0])
except (OSError,ValueError): pass
try: info["loadAverage"]=list(os.getloadavg())
except OSError: pass
try:
 m=dict(line.split(":",1) for line in Path("/proc/meminfo").read_text().splitlines())
 info["memoryTotalBytes"]=int(m["MemTotal"].split()[0])*1024
 info["memoryAvailableBytes"]=int(m["MemAvailable"].split()[0])*1024
except (OSError,KeyError,ValueError): pass
try: info["herdrVersion"]=subprocess.run(["herdr","--version"],capture_output=True,text=True,timeout=2,check=True).stdout.strip()[:128]
except (OSError,subprocess.SubprocessError): pass
print(json.dumps(info,separators=(",",":")))`;

// This elapsed time includes SSH authentication/setup and remote command work.
// It is NOT ICMP RTT or browser WebTransport RTT, particularly in relay mode.
export function probeServer(config) {
  const started = performance.now();
  const child = spawn(config.sshPath ?? 'ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', '-T', '--', config.target,
    `python3 -c ${shellQuote(SERVER_INFO_SCRIPT)}`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  const close = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
  const ready = new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0), settled = false;
    const fail = error => { if (settled) return; settled = true; clearTimeout(timer); close(); reject(error); };
    const timer = setTimeout(() => fail(new Error('SSH stats probe timed out.')), 5_000);
    child.once('error', () => fail(new Error('Could not start SSH stats probe.')));
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 8192) fail(new Error('SSH stats response exceeded its limit.'));
    });
    // Wait until stdout is drained as well as the process exiting.
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) return fail(new Error('SSH stats probe failed.'));
      try {
        const info = JSON.parse(bytes.toString('utf8'));
        if (!info || typeof info.hostname !== 'string' || typeof info.username !== 'string') throw new Error('invalid');
        settled = true; clearTimeout(timer);
        resolve({ ...info, sampledAt: new Date().toISOString(), sshProbeMs: performance.now() - started });
      } catch { fail(new Error('Invalid SSH stats response.')); }
    });
  });
  return { ready, close };
}
