import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './style.css';
const terminal = new Terminal({ cols: 120, rows: 36, fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', cursorBlink: true,
  disableStdin: true, scrollback: 2000, allowProposedApi: false,
  theme: { background: '#0b0f16', foreground: '#d6deeb', cursor: '#b9d6ff', selectionBackground: '#3a5276' } });
terminal.open(document.querySelector('#terminal'));
terminal.writeln('\x1b[38;2;144;168;208mHerdr browser transport lab\x1b[0m\r\n');
terminal.writeln('Connect to open a dedicated remote Herdr session.');
terminal.writeln('Your existing workspaces are left alone.\r\n');
const connectButton = document.querySelector('#connect'), disconnectButton = document.querySelector('#disconnect');
const status = document.querySelector('#status'), dot = document.querySelector('#dot'), detail = document.querySelector('#detail');
fetch('/configuration').then(result => result.json()).then(config => {
  if (config.relay) {
    document.querySelector('.subtitle').textContent = 'Explicit relay: browser WebTransport → localhost helper → authenticated SSH → remote Herdr.';
    detail.textContent = 'Relay mode · remote leg uses SSH';
    document.querySelector('#route').textContent = 'Encrypted local WebTransport · authenticated SSH upstream · pinned localhost certificate';
  }
}).catch(() => {});
const nonce = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
let transport, streamWriter, outputReader;
let sending = Promise.resolve(), queuedBytes = 0, generation = 0;
const encoder = new TextEncoder();
const decodeBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
function setStatus(message, state = '') { status.textContent = message; dot.className = `dot ${state}`; }
async function localRequest(path) {
  const result = await fetch(path, { method: 'POST', headers: { 'X-Herdr-Demo-Token': nonce }, cache: 'no-store' });
  const data = await result.json();
  if (!result.ok) throw new Error(data.error ?? `Bootstrap failed (${result.status}).`);
  return data;
}
function send(bytes) {
  if (!streamWriter) return;
  if (queuedBytes + bytes.byteLength > 64 * 1024) { void disconnect('Input queue full; reconnect before continuing.'); return; }
  const active = generation, writer = streamWriter;
  queuedBytes += bytes.byteLength;
  sending = sending.then(async () => { if (active === generation) await writer.write(bytes); })
    .catch(() => { if (active === generation) void disconnect('Connection lost; input was not replayed.'); })
    .finally(() => { queuedBytes -= bytes.byteLength; });
}
terminal.onData(data => send(encoder.encode(data)));
terminal.onBinary(data => send(Uint8Array.from(data, c => c.charCodeAt(0))));
document.querySelector('#terminal').addEventListener('contextmenu', event => event.preventDefault());
async function disconnect(message = 'Disconnected') {
  generation++;
  terminal.options.disableStdin = true;
  streamWriter = undefined;
  try { transport?.close(); } catch {}
  transport = undefined;
  try { await outputReader?.cancel(); } catch {}
  outputReader = undefined;
  try { await localRequest('/disconnect'); } catch {}
  connectButton.disabled = false;
  disconnectButton.disabled = true;
  setStatus(message);
}
connectButton.addEventListener('click', async () => {
  connectButton.disabled = true;
  disconnectButton.disabled = false;
  const active = ++generation;
  let connection;
  const guard = () => {
    if (active !== generation) { try { connection?.close(); } catch {} throw new Error('Cancelled.'); }
  };
  try {
    if (!nonce) throw new Error('Open the launch link printed by the local parent app.');
    if (!isSecureContext || !('WebTransport' in window)) throw new Error('This browser needs WebTransport support and a secure context. Try current Chrome or Edge.');
    setStatus('Authenticating through SSH…');
    const bootstrap = await localRequest('/bootstrap'), { offer } = bootstrap;
    guard();
    document.querySelector('#session').textContent = bootstrap.session;
    const address = offer.address.includes(':') ? `[${offer.address}]` : offer.address;
    const url = `https://${address}:${offer.port}/herdr-roam/v1`;
    const certificateHash = await crypto.subtle.digest('SHA-256', decodeBase64(offer.cert));
    guard();
    connection = new WebTransport(url, { serverCertificateHashes: [{ algorithm: 'sha-256', value: certificateHash }] });
    transport = connection;
    setStatus('Opening pinned WebTransport session…');
    await Promise.race([connection.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('WebTransport connection timed out. UDP 60000–61000 must be reachable.')), 10_000))]);
    guard();
    const stream = await connection.createBidirectionalStream();
    guard();
    const writer = stream.writable.getWriter(), reader = stream.readable.getReader();
    outputReader = reader;
    await writer.write(decodeBase64(offer.token));
    const acknowledgment = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('Remote authorization timed out.')), 5_000))]);
    guard();
    if (acknowledgment.done || acknowledgment.value?.[0] !== 1) throw new Error('Remote attachment authorization failed.');
    await writer.write(new Uint8Array([1])); // Irrevocable COMMIT: no fallback/replay after this.
    if (active !== generation) { connection.close(); return; }
    streamWriter = writer;
    terminal.reset();
    if (acknowledgment.value.length > 1) terminal.write(acknowledgment.value.subarray(1));
    terminal.options.disableStdin = false;
    terminal.focus();
    disconnectButton.disabled = false;
    detail.textContent = bootstrap.relay ? 'WebTransport local + SSH remote relay · certificate pinned' : `${bootstrap.protocol} · direct · certificate pinned`;
    setStatus('Connected', 'connected');
    connection.closed.catch(() => {}).finally(() => { if (active === generation) void disconnect('Connection closed.'); });
    while (active === generation) {
      const { value, done } = await reader.read();
      if (done) break;
      await new Promise(resolve => terminal.write(value, resolve));
    }
    if (active === generation) await disconnect('Remote attachment ended.');
  } catch (error) {
    if (active !== generation) return;
    await disconnect(error.message);
    dot.className = 'dot error'; detail.textContent = 'No session input was replayed';
  }
});
disconnectButton.addEventListener('click', () => void disconnect());
window.addEventListener('beforeunload', () => { try { transport?.close(); } catch {} });
if (!nonce) { connectButton.disabled = true; setStatus('Open the local launch link to connect.'); }
