/** On-demand SSH samples, shared by concurrent callers and cached for five seconds. */
export function createStatsSampler(config, probe, { ttlMs = 5_000 } = {}) {
  let pending, cached, cachedAt = 0, stopped = false;
  const snapshot = () => ({
    server: cached?.server ?? null,
    sshProbeMs: cached?.sshProbeMs ?? null,
    sampledAt: cached?.sampledAt ?? null,
    error: cached?.error ?? null,
  });
  return {
    async sample() {
      if (stopped) return snapshot();
      if (cached && performance.now() - cachedAt <= ttlMs) return snapshot();
      if (!pending) {
        const current = {};
        pending = current;
        current.ready = (async () => {
          try {
            current.probe = probe(config);
            const cancelled = new Promise((_, reject) => { current.cancel = () => reject(new Error('SSH stats probe cancelled.')); });
            const remote = await Promise.race([current.probe.ready, cancelled]);
            const { sshProbeMs, ...server } = remote;
            delete server.sampledAt;
            cached = { server, sshProbeMs, sampledAt: new Date().toISOString() };
          } catch (error) {
            cached = { error: error instanceof Error ? error.message : 'SSH stats probe failed.', sampledAt: new Date().toISOString() };
          } finally {
            cachedAt = performance.now();
            if (pending === current) pending = undefined;
          }
        })();
      }
      await pending?.ready;
      return snapshot();
    },
    close() {
      if (stopped) return;
      stopped = true;
      pending?.cancel?.();
      pending?.probe?.close();
    },
  };
}
