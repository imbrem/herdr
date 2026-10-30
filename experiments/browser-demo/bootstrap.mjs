import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { TRANSPORT_PROTOCOL } from './backend/config.mjs';

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function remotePtyCommand({ session, cols, rows }) {
  const source = readFileSync(new URL('./pty_bridge.py', import.meta.url), 'utf8');
  return `python3 -u -c ${shellQuote(source)} --session ${shellQuote(session)} --cols ${cols} --rows ${rows}`;
}

export function remoteCommand(config) {
  return `env HERDR_ROAM_ALLOWED_ORIGIN=${shellQuote(config.origin)} herdr-roam serve --protocols ${TRANSPORT_PROTOCOL} -- ${shellQuote(remotePtyCommand(config))}`;
}

function base64Bytes(value, minimum, maximum = minimum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length >= minimum && bytes.length <= maximum && bytes.toString('base64') === value;
}

export function validateGreeting(greeting) {
  if (!greeting || greeting.selected_protocol !== TRANSPORT_PROTOCOL ||
      !Array.isArray(greeting.supported_protocols) || !greeting.supported_protocols.includes(TRANSPORT_PROTOCOL)) {
    throw new Error(`Remote helper did not select ${TRANSPORT_PROTOCOL}.`);
  }
  const offer = greeting.offer;
  // Bootstrap is authenticated SSH, but reject malformed data before handing it to a browser.
  if (!offer || offer.version !== 1 || !Number.isInteger(offer.port) || offer.port < 1 || offer.port > 65535 ||
      typeof offer.address !== 'string' || !isIP(offer.address) || ['0.0.0.0', '::'].includes(offer.address) ||
      !base64Bytes(offer.token, 32) || !base64Bytes(offer.cert, 64, 8192)) {
    throw new Error('Remote helper returned an invalid attachment offer.');
  }
  return offer;
}

/** Signal only the process/group this parent created; never a remote Herdr daemon. */
function processStopper(child, grouped = false) {
  let stopping = false;
  return () => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    stopping = true;
    const signal = name => {
      try { grouped && child.pid ? process.kill(-child.pid, name) : child.kill(name); } catch {}
    };
    signal('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
    }, 500);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  };
}

// The target and remote command come only from trusted parent-process configuration.
// No HTTP request may supply a target, session, shell command, path, or environment.
function offerProcess(executable, args, env = process.env) {
  const grouped = process.platform !== 'win32';
  const child = spawn(executable, args, { env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
  let collected = Buffer.alloc(0);
  let settled = false;
  let timer;
  let rejectOffer;
  const stop = processStopper(child, grouped);
  const close = () => { rejectOffer?.(new Error('Bootstrap cancelled.')); stop(); };
  const ready = new Promise((resolve, reject) => {
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(error);
    };
    rejectOffer = fail;
    timer = setTimeout(() => fail(new Error('SSH bootstrap timed out. Verify SSH access and the remote helper.')), 12_000);
    child.once('error', () => fail(new Error('Could not start SSH.')));
    child.once('close', code => fail(new Error(`SSH bootstrap ended before an offer (exit ${code ?? 'signal'}).`)));
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
    await new Promise((resolve, reject) => {
      const stop = processStopper(preflight);
      const timer = setTimeout(() => { stop(); reject(new Error('SSH authorization check timed out.')); }, 12_000);
      activeClose = () => { clearTimeout(timer); stop(); reject(new Error('Bootstrap cancelled.')); };
      preflight.once('error', () => { clearTimeout(timer); reject(new Error('Could not start SSH authorization check.')); });
      preflight.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('SSH authorization check failed. Verify SSH access first.')); });
    });
    if (cancelled) throw new Error('Bootstrap cancelled.');
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', '--', config.target, remotePtyCommand(config)];
    const command = [config.sshPath ?? 'ssh', ...sshArgs].map(shellQuote).join(' ');
    const helper = config.helper ?? fileURLToPath(new URL('../../target/debug/herdr-roam', import.meta.url));
    const pending = offerProcess(helper, ['serve', '--protocols', TRANSPORT_PROTOCOL, '--', command], {
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
  const stop = processStopper(child);
  let rejectProbe;
  const close = () => { rejectProbe?.(new Error('SSH stats probe cancelled.')); stop(); };
  const ready = new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0), settled = false;
    const fail = error => { if (settled) return; settled = true; clearTimeout(timer); stop(); reject(error); };
    rejectProbe = fail;
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
