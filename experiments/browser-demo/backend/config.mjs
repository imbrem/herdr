import { randomBytes } from 'node:crypto';

export const APPLICATION_PROTOCOL = 'herdr-browser-pty-v1';
export const TRANSPORT_PROTOCOL = 'webtransport-stream-v1';
const USAGE = 'Usage: node server.mjs --target telperion [--port 8765] [--session browser-demo-name] [--relay] [--helper /path/to/herdr-roam]';

export function validateGeometry({ cols, rows }) {
  if (!Number.isInteger(cols) || cols < 20 || cols > 500 ||
      !Number.isInteger(rows) || rows < 5 || rows > 300) {
    throw new Error('Only terminal geometry is accepted: cols 20–500 and rows 5–300.');
  }
  return { cols, rows };
}

/** Take a fixed startup snapshot. HTTP requests never supply SSH targets or commands. */
export function validateConfig(input) {
  const config = { port: 8765, cols: 120, rows: 36,
    session: `browser-demo-${randomBytes(5).toString('hex')}`, ...input };
  if (typeof config.target !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(config.target)) {
    throw new Error('Provide a normal SSH host/alias with --target.');
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid port.');
  if (typeof config.session !== 'string' || !/^browser-demo-[A-Za-z0-9-]{1,48}$/.test(config.session)) {
    throw new Error('Use a dedicated browser-demo-* session.');
  }
  for (const name of ['helper', 'sshPath']) {
    if (config[name] !== undefined && (typeof config[name] !== 'string' || !config[name] || config[name].includes('\0'))) {
      throw new Error(`Invalid ${name} executable path.`);
    }
  }
  if (config.relay !== undefined && typeof config.relay !== 'boolean') throw new Error('Invalid relay setting.');
  validateGeometry(config);
  return Object.freeze(config);
}

export function parseArgs(args) {
  const config = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--relay') { config.relay = true; continue; }
    if (!['--target', '--port', '--session', '--helper'].includes(name) || args[i + 1] === undefined) throw new Error(USAGE);
    const value = args[++i];
    if (name === '--port' && !/^\d+$/.test(value)) throw new Error('Invalid port.');
    config[name.slice(2)] = name === '--port' ? Number(value) : value;
  }
  return validateConfig(config);
}
