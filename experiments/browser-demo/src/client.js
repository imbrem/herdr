import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { DATA, RESIZE, PING, frame, FrameDecoder } from './frames.js';

const $ = id => document.getElementById(id);
const terminal = new Terminal({ cols: 120, rows: 36, fontSize: 14,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', cursorBlink: true,
  disableStdin: true, scrollback: 3000, allowProposedApi: false,
  theme: { background: '#0d0e11', foreground: '#d8dbe2', cursor: '#c0c9d9', selectionBackground: '#384252' } });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open($('terminal'));

let capability = location.hash.slice(1);
try {
  if (capability) sessionStorage.setItem('herdr-launch', capability);
  else capability = sessionStorage.getItem('herdr-launch') ?? '';
} catch { /* The launch link also works with browser storage disabled. */ }
history.replaceState(null, '', location.pathname);

const encoder = new TextEncoder();
const decodeBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
let configuration, current, generation = 0, connectedAt = 0, lastUpdate = 0;
let receivedBytes = 0, sentBytes = 0, lastRtt, rtts = [], sequence = 0;
let phase = 'disconnected', statsPending = false, serverInfo;

function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  seconds = Math.max(0, Math.floor(seconds));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}
function bytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
function metric(value) { return Number.isFinite(value) ? `${Math.round(value)} ms` : '—'; }
function showLogin(message = '') {
  $('login-error').hidden = !message;
  $('login-error').textContent = message;
  if ($('details').open) $('details').close();
  if (!$('login').open) $('login').showModal();
}
function focusTerminal() { if (phase === 'connected') terminal.focus(); }
function setPhase(value, description) {
  phase = value;
  document.body.dataset.state = value;
  $('connection-state').textContent = description;
  $('stat-status').textContent = description;
  $('login-status').textContent = value === 'connecting' ? description : 'SSH authentication';
  $('connect').disabled = value === 'connecting';
  $('reconnect').disabled = value === 'connecting' || !configuration || !capability;
  $('details-reconnect').disabled = $('reconnect').disabled;
  $('disconnect').disabled = value === 'disconnected';
}
async function request(path, body) {
  const result = await fetch(path, { method: 'POST', cache: 'no-store', headers: {
    'X-Herdr-Demo-Token': capability, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, signal: AbortSignal.timeout(path === '/bootstrap' ? 30_000 : path === '/stats' ? 8000 : 3000),
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await result.json();
  if (!result.ok) throw new Error(data.error ?? `Request failed (${result.status}).`);
  return data;
}

function sendFrame(type, payload, beforeWrite) {
  const attachment = current;
  if (!attachment?.writer || phase !== 'connected') return;
  const packet = frame(type, payload);
  if (attachment.queued + packet.length > 64 * 1024) {
    void disconnect('Input queue full. Reconnect to continue.');
    return;
  }
  attachment.queued += packet.length;
  attachment.sending = attachment.sending.then(async () => {
    if (current !== attachment) return;
    beforeWrite?.();
    await attachment.writer.write(packet);
    if (type === DATA) sentBytes += payload.length;
  }).catch(() => {
    if (current === attachment) void disconnect('Connection lost.');
  }).finally(() => { attachment.queued -= packet.length; });
}
function sendInput(value) {
  for (let offset = 0; offset < value.length; offset += 16 * 1024) {
    sendFrame(DATA, value.subarray(offset, offset + 16 * 1024));
  }
}
terminal.onData(data => sendInput(encoder.encode(data)));
terminal.onBinary(data => sendInput(Uint8Array.from(data, char => char.charCodeAt(0))));
$('terminal').addEventListener('contextmenu', event => event.preventDefault());

function fitTerminal() {
  const dimensions = fit.proposeDimensions();
  if (!dimensions) return;
  const cols = Math.max(20, Math.min(500, dimensions.cols));
  const rows = Math.max(5, Math.min(300, dimensions.rows));
  if (terminal.cols === cols && terminal.rows === rows) return;
  terminal.resize(cols, rows);
  const payload = new Uint8Array(4), view = new DataView(payload.buffer);
  view.setUint16(0, cols); view.setUint16(2, rows);
  sendFrame(RESIZE, payload);
  $('stat-grid').textContent = `${cols} × ${rows}`;
}
let fitQueued = false;
new ResizeObserver(() => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitTerminal(); });
}).observe($('terminal'));
document.fonts.ready.then(fitTerminal);

async function closeAttachment() {
  generation++;
  const attachment = current;
  current = undefined;
  terminal.options.disableStdin = true;
  connectedAt = 0; lastUpdate = 0;
  try { attachment?.transport.close(); } catch {}
  try { await attachment?.reader?.cancel(); } catch {}
  if (capability) { try { await request('/disconnect'); } catch {} }
}
async function disconnect(message = '') {
  await closeAttachment();
  setPhase('disconnected', 'Disconnected');
  $('stale').hidden = true;
  showLogin(message);
}
async function deadline(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function connect() {
  if (phase === 'connecting') return;
  setPhase('connecting', 'Connecting…');
  $('login-error').hidden = true;
  const closingGeneration = generation + 1;
  await closeAttachment();
  if (generation !== closingGeneration) return;
  const active = ++generation;
  const attachment = { sending: Promise.resolve(), queued: 0, pings: new Map() };
  current = attachment;
  const guard = () => { if (active !== generation || current !== attachment) throw new Error('Cancelled.'); };
  try {
    if (!configuration) throw new Error('Gateway configuration unavailable.');
    if (!capability) throw new Error('Open the launch link from the gateway.');
    if (!isSecureContext || !('WebTransport' in window)) throw new Error('WebTransport requires a supported browser and a secure context.');
    fitTerminal();
    setPhase('connecting', 'Authenticating…');
    const bootstrap = await request('/bootstrap', { cols: terminal.cols, rows: terminal.rows });
    guard();
    if (bootstrap.applicationProtocol !== 'herdr-browser-pty-v1') throw new Error('Update the browser gateway and reload this tab.');
    const { offer } = bootstrap;
    const address = offer.address.includes(':') ? `[${offer.address}]` : offer.address;
    const hash = await crypto.subtle.digest('SHA-256', decodeBase64(offer.cert));
    guard();
    const transport = new WebTransport(`https://${address}:${offer.port}/herdr-roam/v1`, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
    });
    attachment.transport = transport;
    setPhase('connecting', 'Opening transport…');
    await deadline(transport.ready, 10_000, 'WebTransport connection timed out.');
    guard();
    const stream = await deadline(transport.createBidirectionalStream(), 5_000, 'Terminal stream timed out.');
    guard();
    const writer = stream.writable.getWriter(), reader = stream.readable.getReader();
    attachment.reader = reader;
    await writer.write(decodeBase64(offer.token));
    const acknowledgment = await deadline(reader.read(), 5_000, 'Server authorization timed out.');
    guard();
    if (acknowledgment.done || acknowledgment.value?.[0] !== 1) throw new Error('Server authorization failed.');
    await writer.write(new Uint8Array([1])); // COMMIT; never replay input on reconnect.
    guard();
    attachment.writer = writer;
    terminal.reset();
    terminal.options.disableStdin = false;
    receivedBytes = 0; sentBytes = 0; rtts = []; lastRtt = undefined;
    connectedAt = performance.now(); lastUpdate = 0;
    setPhase('connected', 'Connected');
    $('login').close(); $('details').close();
    terminal.focus();
    transport.closed.catch(() => {}).finally(() => {
      if (current === attachment) void disconnect('Connection closed.');
    });
    const decoder = new FrameDecoder();
    const present = async chunk => {
      for (const message of decoder.push(chunk)) {
        guard();
        lastUpdate = performance.now();
        if (message.type === DATA) {
          receivedBytes += message.payload.length;
          await new Promise(resolve => terminal.write(message.payload, resolve));
        } else if (message.type === PING) {
          const key = new DataView(message.payload.buffer).getBigUint64(0).toString();
          const sent = attachment.pings.get(key);
          if (sent !== undefined) {
            lastRtt = performance.now() - sent;
            rtts.push(lastRtt); if (rtts.length > 20) rtts.shift();
            attachment.pings.delete(key);
          }
        }
      }
    };
    if (acknowledgment.value.length > 1) await present(acknowledgment.value.subarray(1));
    fitTerminal(); ping(); updateStatistics();
    while (current === attachment) {
      const { value, done } = await reader.read();
      if (done) { decoder.finish(); break; }
      await present(value);
    }
    if (current === attachment) await disconnect('Remote attachment ended.');
  } catch (error) {
    if (active === generation && current === attachment) await disconnect(error.message);
  }
}
function ping() {
  const attachment = current;
  if (phase !== 'connected' || !attachment?.writer) return;
  const now = performance.now();
  for (const [key, sent] of attachment.pings) if (now - sent > 15_000) attachment.pings.delete(key);
  if (attachment.pings.size >= 4) return;
  const payload = new Uint8Array(8), key = BigInt(++sequence);
  new DataView(payload.buffer).setBigUint64(0, key);
  sendFrame(PING, payload, () => attachment.pings.set(key.toString(), performance.now()));
}
function updateStatistics() {
  const now = performance.now(), age = lastUpdate ? (now - lastUpdate) / 1000 : Infinity;
  const stale = phase === 'connected' && age > 6 && now - connectedAt > 6000;
  document.body.dataset.state = stale ? 'stale' : phase;
  $('stale').hidden = !stale;
  if (stale) $('stale-text').textContent = lastUpdate ? `No server update · ${duration(age)}` : 'Waiting for server updates';
  if (phase === 'connected') $('connection-state').textContent = stale ? `${duration(age)} stale` : metric(lastRtt).replace(' ms', 'ms');
  $('stat-status').textContent = stale ? 'Waiting for server' : phase === 'connected' ? 'Connected' : phase === 'connecting' ? 'Connecting' : 'Disconnected';
  $('stat-connected').textContent = connectedAt ? duration((now - connectedAt) / 1000) : '—';
  $('stat-update').textContent = lastUpdate ? `${duration(age)} ago` : '—';
  $('stat-rtt').textContent = rtts.length ? `${metric(lastRtt)} · avg ${metric(rtts.reduce((a, b) => a + b, 0) / rtts.length)}` : '—';
  $('stat-bytes').textContent = `${bytes(receivedBytes)} / ${bytes(sentBytes)}`;
  $('stat-grid').textContent = `${terminal.cols} × ${terminal.rows}`;
  if (serverInfo) {
    const { server, sampledAt } = serverInfo;
    const sampleAge = Math.max(0, (Date.now() - Date.parse(sampledAt)) / 1000);
    $('stat-uptime').textContent = server?.uptimeSeconds == null ? '—' : duration(server.uptimeSeconds + sampleAge);
    $('stat-sampled').textContent = Number.isFinite(sampleAge) ? `${duration(sampleAge)} ago` : '—';
    $('stat-parent').textContent = duration(serverInfo.parentUptimeSeconds + (now - serverInfo.receivedAt) / 1000);
  }
}
async function refreshServerInfo() {
  if (statsPending || !capability) return;
  statsPending = true; $('refresh-stats').disabled = true;
  try {
    serverInfo = await request('/stats');
    serverInfo.receivedAt = performance.now();
    const server = serverInfo.server;
    $('stat-hostname').textContent = server?.hostname ?? '—';
    $('stat-user').textContent = server?.username ?? '—';
    $('stat-kernel').textContent = server?.kernel ?? '—';
    $('stat-version').textContent = server?.herdrVersion ?? '—';
    $('stat-load').textContent = server?.loadAverage?.map(value => Number(value).toFixed(2)).join(' / ') ?? '—';
    $('stat-probe').textContent = serverInfo.sshProbeMs == null ? '—' : `${metric(serverInfo.sshProbeMs)} · SSH + command`;
    $('stats-error').hidden = !serverInfo.error;
    $('stats-error').textContent = serverInfo.error ?? '';
    updateStatistics();
  } catch (error) {
    $('stats-error').hidden = false; $('stats-error').textContent = error.message;
  } finally { statsPending = false; $('refresh-stats').disabled = false; }
}
function openDetails() {
  if ($('login').open) $('login').close();
  if (!$('details').open) $('details').showModal();
  updateStatistics(); void refreshServerInfo();
}
$('login-form').addEventListener('submit', event => { event.preventDefault(); void connect(); });
$('login-close').addEventListener('click', () => { $('login').close(); focusTerminal(); });
$('details-toggle').addEventListener('click', openDetails);
$('details-close').addEventListener('click', () => { $('details').close(); focusTerminal(); });
$('reconnect').addEventListener('click', () => void connect());
$('stale-reconnect').addEventListener('click', () => void connect());
$('details-reconnect').addEventListener('click', () => void connect());
$('disconnect').addEventListener('click', () => void disconnect());
$('refresh-stats').addEventListener('click', () => void refreshServerInfo());
for (const dialog of [$('login'), $('details')]) dialog.addEventListener('close', focusTerminal);
window.addEventListener('keydown', event => {
  if (event.altKey && event.shiftKey && event.code === 'KeyI') { event.preventDefault(); openDetails(); }
});
window.addEventListener('beforeunload', () => { try { current?.transport?.close(); } catch {} });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { ping(); fitTerminal(); } });
setInterval(updateStatistics, 500);
setInterval(ping, 3000);
setInterval(() => { if ($('details').open) void refreshServerInfo(); }, 10_000);

setPhase('disconnected', 'Disconnected');
try {
  const response = await fetch('/configuration', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Gateway configuration unavailable.');
  configuration = await response.json();
  $('target').value = configuration.target;
  $('host').textContent = configuration.target;
  document.title = `${configuration.target} · Herdr`;
  $('login-route').textContent = configuration.relay ? 'WebTransport → SSH relay' : 'Direct WebTransport';
  $('login-session').textContent = configuration.session;
  $('stat-target').textContent = configuration.target;
  $('stat-session').textContent = configuration.session;
  $('stat-route').textContent = configuration.relay ? 'WebTransport → SSH relay' : 'Direct WebTransport';
  setPhase('disconnected', 'Disconnected');
  showLogin(capability ? '' : 'Open the launch link from the gateway.');
} catch (error) { showLogin(error.message); }
