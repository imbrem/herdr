import '@xterm/xterm/css/xterm.css';
import './style.css';
import { GatewayClient, captureCapability, loadGatewayUrl } from './gateway-client.js';
import { TerminalConnection } from './terminal-connection.js';
import { TerminalSession } from './terminal-session.js';
import { createTerminalView } from './terminal-view.js';
import { createTerminalUI } from './terminal-ui.js';

// This entry point wires independent UI, terminal, control-plane and data-plane
// components. Auth methods belong in the gateway adapter, not in the renderer.
let gateway, session, configuration, statsPending = false;
const view = createTerminalView(document.getElementById('terminal'), {
  onInput: bytes => session?.connection?.sendInput(bytes),
  onResize: geometry => session?.connection?.resize(geometry),
});
const ui = createTerminalUI({ document,
  onConnect: () => { if (session) void session.connect(view.fit()); },
  onDisconnect: () => { if (session) void session.disconnect(); },
  onRefreshInfo: () => void refreshInfo(),
  onFocus: () => view.focus(),
});
ui.setPhase('disconnected', 'Disconnected');

async function refreshInfo() {
  if (statsPending || !gateway?.authorized) return;
  statsPending = true; ui.setInfoPending(true);
  try { ui.setServerInfo(await gateway.stats()); }
  catch (error) { ui.showInfoError(error.message); }
  finally { statsPending = false; ui.setInfoPending(false); render(); }
}

function render() { ui.render(session?.connection?.stats, view.geometry()); }

try {
  const baseUrl = await loadGatewayUrl(document.baseURI);
  let storage;
  try { storage = window.sessionStorage; } catch { /* The launch link also works without storage. */ }
  const capability = captureCapability(baseUrl, { location, history, storage });
  gateway = new GatewayClient({ baseUrl, capability });
  configuration = await gateway.configuration();
  session = new TerminalSession({ gateway,
    createConnection({ onClose }) {
      let firstOutput = true;
      return new TerminalConnection({ onClose, onData: bytes => {
        // Keep the old screen visible through reconnect until a fresh stream has
        // actual output. Clear it before parsing that stream's first ANSI bytes.
        if (firstOutput) { view.reset(); firstOutput = false; }
        return view.write(bytes);
      } });
    },
    onPhase(phase, description) {
      view.setInputEnabled(phase === 'connected');
      ui.setPhase(phase, description); render();
    },
    onReady(connection) {
      connection.resize(view.fit());
      connection.ping(); ui.connected(); render();
    },
    onDisconnected: message => ui.showLogin(message),
  });
  ui.configure(configuration, gateway.authorized);
  ui.showLogin(capability ? '' : 'Open the launch link from the gateway.');

  // Opening a renewed launch link in the same tab may change only the fragment.
  window.addEventListener('hashchange', async () => {
    if (!location.hash) return;
    await session.disconnect();
    try {
      gateway.authorize(captureCapability(baseUrl, { location, history, storage }));
      ui.configure(configuration, gateway.authorized); ui.showLogin();
    } catch (error) { ui.showLogin(error.message); }
  });
} catch (error) { ui.showLogin(error.message); }

setInterval(render, 500);
setInterval(() => session?.connection?.ping(), 3000);
setInterval(() => { if (ui.detailsOpen) void refreshInfo(); }, 10_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { view.fit(); session?.connection?.ping(); }
});
window.addEventListener('beforeunload', () => session?.dispose());
