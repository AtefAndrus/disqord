export interface IInFlightTracker {
  track(work: Promise<unknown>): void;
  drain(timeoutMs: number): Promise<number>;
}

export function createInFlightTracker(): IInFlightTracker {
  const pending = new Set<Promise<unknown>>();
  const drained = new Set<() => void>();
  return {
    track(work): void {
      pending.add(work);
      const settled = (): void => {
        pending.delete(work);
        if (pending.size === 0) {
          for (const finish of drained) finish();
        }
      };
      void work.then(settled, settled);
    },
    drain(timeoutMs): Promise<number> {
      if (pending.size === 0) return Promise.resolve(0);
      return new Promise((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          drained.delete(finish);
          resolve(pending.size);
        };
        // Not unref'd: the caller waits on this, and an emptied event loop would
        // otherwise exit before the database is closed.
        const timer = setTimeout(finish, timeoutMs);
        drained.add(finish);
      });
    },
  };
}
