/**
 * In-process wake-ups for SSE streams: when this instance appends a triage event or changes a report,
 * streams on the same instance stop waiting and re-read the Store at once. It is only an optimization;
 * every stream also polls the Store, which is the source of truth across instances.
 */
export type ReportSignals = {
  notify(reportId: string): void;
  /** Resolves on the next notify for this report, after `ms`, or when `signal` aborts. */
  wait(reportId: string, ms: number, signal?: AbortSignal): Promise<void>;
};

export function createReportSignals(): ReportSignals {
  const waiters = new Map<string, Set<() => void>>();
  return {
    notify(reportId) {
      const set = waiters.get(reportId);
      if (!set) return;
      waiters.delete(reportId);
      for (const wake of set) wake();
    },
    wait(reportId, ms, signal) {
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          waiters.get(reportId)?.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted) return finish();
        let set = waiters.get(reportId);
        if (!set) {
          set = new Set();
          waiters.set(reportId, set);
        }
        set.add(finish);
      });
    },
  };
}
