/**
 * Owns one attachment. UI actions cancel obsolete attempts; uncertain input is
 * never copied into a replacement connection. Gateway cleanup is serialized so
 * an older disconnect cannot deliberately run after a newer bootstrap.
 */
export class TerminalSession {
  constructor({ gateway, createConnection, onPhase = () => {}, onReady = () => {}, onDisconnected = () => {} }) {
    this.gateway = gateway;
    this.createConnection = createConnection;
    this.onPhase = onPhase;
    this.onReady = onReady;
    this.onDisconnected = onDisconnected;
    this.phase = 'disconnected';
    this.epoch = 0;
    this.cleanup = Promise.resolve();
  }

  setPhase(phase, description) {
    this.phase = phase;
    this.onPhase(phase, description);
  }

  cancelLocal() {
    this.controller?.abort();
    this.connection?.close();
    this.connection = undefined;
    return ++this.epoch;
  }

  resetGateway() {
    // A later explicit retry may recover from a failed earlier cleanup. Its own
    // cleanup still must succeed before it is allowed to bootstrap a new session.
    this.cleanup = this.cleanup.catch(() => {}).then(() => this.gateway.disconnect());
    return this.cleanup;
  }

  async connect(geometry) {
    const epoch = this.cancelLocal();
    const controller = new AbortController();
    this.controller = controller;
    const active = () => epoch === this.epoch && !controller.signal.aborted;
    this.setPhase('connecting', 'Authenticating…');
    try {
      await this.resetGateway();
      if (!active()) return;
      const bootstrap = await this.gateway.bootstrap(geometry, { signal: controller.signal });
      if (!active()) return;
      const connection = this.createConnection({ onClose: error => {
        if (active()) void this.disconnect(error?.message ?? error ?? 'Remote attachment ended.');
      } });
      this.connection = connection;
      this.setPhase('connecting', 'Opening transport…');
      await connection.open(bootstrap, { signal: controller.signal });
      if (!active()) { connection.close(); return; }
      this.setPhase('connected', 'Connected');
      this.onReady(connection);
    } catch (error) {
      if (active()) await this.disconnect(error.message);
    }
  }

  async disconnect(message = '') {
    const epoch = this.cancelLocal();
    this.setPhase('disconnected', 'Disconnected');
    try { await this.resetGateway(); }
    catch (error) { message ||= error.message; }
    if (epoch === this.epoch) this.onDisconnected(message);
  }

  /** Page teardown closes only the data path; the persistent Herdr session remains. */
  dispose() { this.cancelLocal(); }
}
