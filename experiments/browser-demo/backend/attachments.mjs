class AttachmentConflict extends Error {
  statusCode = 409;
}

/** Own only this parent's attachment, never the persistent named Herdr runtime. */
export function createAttachments(config, bootstrap) {
  let generation = 0, pending, active, starting = false, offeredAt;
  let stopped = false;
  let rejectCancelled;
  const cancel = () => {
    generation++;
    const oldPending = pending, oldActive = active;
    pending = undefined; active = undefined; starting = false; offeredAt = undefined;
    rejectCancelled?.(new AttachmentConflict('Bootstrap cancelled.'));
    rejectCancelled = undefined;
    oldPending?.close(); oldActive?.close();
  };
  return {
    get generation() { return generation; },
    get busy() { return starting || Boolean(active); },
    snapshot: () => ({ state: starting ? 'starting' : active ? 'offered' : 'idle', offeredAt: offeredAt ?? null }),
    cancel,
    close() { stopped = true; cancel(); },
    async open(size, origin, expectedGeneration, signal) {
      if (stopped || signal.aborted || expectedGeneration !== generation) throw new AttachmentConflict('Bootstrap cancelled.');
      if (starting || active) throw new AttachmentConflict('An attachment is already open. Disconnect it first.');
      const ownGeneration = ++generation;
      starting = true;
      const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
      const onAbort = () => { if (generation === ownGeneration) cancel(); };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const attempt = bootstrap({ ...config, ...size, origin });
        pending = attempt;
        // A subprocess may produce an already-buffered offer after cancellation.
        const offered = attempt.ready.then(result => {
          if (ownGeneration !== generation) {
            result.close();
            throw new AttachmentConflict('Bootstrap cancelled.');
          }
          return result;
        });
        const result = await Promise.race([offered, cancelled]);
        if (ownGeneration !== generation) { result.close(); throw new AttachmentConflict('Bootstrap cancelled.'); }
        active = result;
        offeredAt = new Date().toISOString();
        result.child?.once('exit', () => {
          if (active === result) { active = undefined; offeredAt = undefined; }
        });
        return result.offer;
      } catch (error) {
        if (ownGeneration !== generation) throw new AttachmentConflict('Bootstrap cancelled.');
        throw error;
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (ownGeneration === generation) { starting = false; pending = undefined; rejectCancelled = undefined; }
      }
    },
  };
}
