/** Small DOM adapter. Network operations and terminal state live elsewhere. */
export function createTerminalUI({ document, onConnect, onDisconnect, onRefreshInfo, onFocus }) {
  const element = id => document.getElementById(id);
  const text = (id, value) => {
    const node = element(id), next = String(value);
    if (node.textContent !== next) node.textContent = next;
  };
  let configuration, authorized = false, phase = 'disconnected', serverInfo;
  const events = new AbortController();
  const listen = (node, name, callback) => node.addEventListener(name, callback, { signal: events.signal });
  const focus = () => { if (!element('login').open && !element('details').open && phase === 'connected') onFocus(); };

  function showLogin(message = '') {
    text('login-error', message);
    element('login-error').hidden = !message;
    element('details').close();
    if (!element('login').open) element('login').showModal();
  }

  function setPhase(value, description) {
    phase = value;
    document.body.dataset.state = value;
    text('connection-state', description);
    text('stat-status', description);
    text('login-status', value === 'connecting' ? description : 'SSH authentication');
    const canConnect = Boolean(configuration && authorized);
    element('connect').disabled = value === 'connecting' || !canConnect;
    element('reconnect').disabled = value === 'connecting' || !canConnect;
    element('details-reconnect').disabled = element('reconnect').disabled;
    element('disconnect').disabled = value === 'disconnected';
    if (value !== 'connected') element('stale').hidden = true;
  }

  function configure(config, hasAuthorization) {
    configuration = config;
    authorized = hasAuthorization;
    element('target').value = config.target;
    text('host', config.target);
    document.title = `${config.target} · Herdr`;
    const route = config.relay ? 'WebTransport → SSH relay' : 'Direct WebTransport';
    text('login-route', route); text('login-session', config.session);
    text('stat-target', config.target); text('stat-session', config.session); text('stat-route', route);
    setPhase(phase, phase === 'connected' ? 'Connected' : 'Disconnected');
  }

  function render(stats = {}, geometry) {
    const now = performance.now();
    const updateAge = Number.isFinite(stats.lastUpdate) ? (now - stats.lastUpdate) / 1000 : Infinity;
    const connectedAge = Number.isFinite(stats.connectedAt) ? (now - stats.connectedAt) / 1000 : 0;
    const stale = phase === 'connected' && updateAge > 6 && connectedAge > 6;
    document.body.dataset.state = stale ? 'stale' : phase;
    element('stale').hidden = !stale;
    if (stale) text('stale-text', Number.isFinite(updateAge) ? `No server update · ${duration(updateAge)}` : 'Waiting for server updates');
    if (phase === 'connected') text('connection-state', stale ? `${duration(updateAge)} stale` : milliseconds(stats.lastRtt).replace(' ms', 'ms'));
    text('stat-status', stale ? 'Waiting for server' : phase === 'connected' ? 'Connected' : phase === 'connecting' ? 'Connecting' : 'Disconnected');
    text('stat-connected', phase === 'connected' ? duration(connectedAge) : '—');
    text('stat-update', Number.isFinite(updateAge) ? `${duration(updateAge)} ago` : '—');
    const rtts = stats.rtts ?? [];
    text('stat-rtt', rtts.length ? `${milliseconds(stats.lastRtt)} · avg ${milliseconds(rtts.reduce((a, b) => a + b, 0) / rtts.length)}` : '—');
    text('stat-bytes', `${byteCount(stats.receivedBytes ?? 0)} / ${byteCount(stats.sentBytes ?? 0)}`);
    text('stat-grid', `${geometry.cols} × ${geometry.rows}`);
    if (serverInfo) {
      const sampleAge = Math.max(0, (Date.now() - Date.parse(serverInfo.sampledAt)) / 1000);
      text('stat-uptime', serverInfo.server?.uptimeSeconds == null ? '—' : duration(serverInfo.server.uptimeSeconds + sampleAge));
      text('stat-sampled', Number.isFinite(sampleAge) ? `${duration(sampleAge)} ago` : '—');
      text('stat-parent', duration(serverInfo.parentUptimeSeconds + (now - serverInfo.receivedAt) / 1000));
    }
  }

  function setServerInfo(info) {
    serverInfo = { ...info, receivedAt: performance.now() };
    const server = info.server;
    text('stat-hostname', server?.hostname ?? '—'); text('stat-user', server?.username ?? '—');
    text('stat-kernel', server?.kernel ?? '—'); text('stat-version', server?.herdrVersion ?? '—');
    const load = server?.loadAverage;
    text('stat-load', Array.isArray(load) && load.length === 3 && load.every(Number.isFinite)
      ? load.map(value => value.toFixed(2)).join(' / ') : '—');
    text('stat-probe', Number.isFinite(info.sshProbeMs) ? `${milliseconds(info.sshProbeMs)} · SSH + command` : '—');
    showInfoError(info.error ?? '');
  }

  function showInfoError(message) {
    text('stats-error', message);
    element('stats-error').hidden = !message;
  }

  function openDetails() {
    element('login').close();
    if (!element('details').open) element('details').showModal();
    onRefreshInfo();
  }

  listen(element('login-form'), 'submit', event => { event.preventDefault(); onConnect(); });
  listen(element('login-close'), 'click', () => { element('login').close(); focus(); });
  listen(element('details-toggle'), 'click', openDetails);
  listen(element('details-close'), 'click', () => { element('details').close(); focus(); });
  for (const id of ['reconnect', 'stale-reconnect', 'details-reconnect']) listen(element(id), 'click', onConnect);
  listen(element('disconnect'), 'click', onDisconnect);
  listen(element('refresh-stats'), 'click', onRefreshInfo);
  for (const id of ['login', 'details']) listen(element(id), 'close', focus);
  listen(document, 'keydown', event => {
    if (event.altKey && event.shiftKey && event.code === 'KeyI') { event.preventDefault(); openDetails(); }
  });
  return {
    configure, setPhase, showLogin, render, setServerInfo, showInfoError,
    get detailsOpen() { return element('details').open; },
    setInfoPending: pending => { element('refresh-stats').disabled = pending; },
    connected() { element('login').close(); element('details').close(); onFocus(); },
    dispose: () => events.abort(),
  };
}

function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  seconds = Math.max(0, Math.floor(seconds));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}

function byteCount(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

function milliseconds(value) { return Number.isFinite(value) ? `${Math.round(value)} ms` : '—'; }
