/** Shared refresh coordinator for SSE updates and the polling fallback.
 * It prevents a slow refresh from stacking overlapping poll requests and isolates
 * callback failures so one view cannot block the others from synchronizing.
 */
export type CloudRefreshCallback = () => void | Promise<void>;

export interface CloudSyncCallbacks {
  logs?: CloudRefreshCallback;
  activity?: CloudRefreshCallback;
  suggestions?: CloudRefreshCallback;
  foremen?: CloudRefreshCallback;
  approvals?: CloudRefreshCallback;
  imports?: CloudRefreshCallback;
  fetchStatus?: () => Promise<unknown>;
  maintenance?: (state: { on: boolean; since?: number }) => void;
}

export function createCloudSyncRefreshers(callbacks: CloudSyncCallbacks) {
  let disposed = false;
  let inFlight: Promise<void> | null = null;

  async function invoke(callback?: CloudRefreshCallback): Promise<void> {
    if (!callback) return;
    try {
      await callback();
    } catch {
      // A failed request is retried by the next SSE event or polling tick.
    }
  }

  function refreshAll(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;

    inFlight = (async () => {
      await Promise.all([
        invoke(callbacks.logs),
        invoke(callbacks.activity),
        invoke(callbacks.suggestions),
        invoke(callbacks.foremen),
        invoke(callbacks.approvals),
        invoke(callbacks.imports),
      ]);
      if (disposed || !callbacks.fetchStatus) return;
      try {
        const status = await callbacks.fetchStatus();
        if (disposed || !status || typeof status !== 'object') return;
        const maintenance = (status as { maintenance?: unknown }).maintenance;
        if (maintenance && typeof maintenance === 'object') {
          const state = maintenance as { on?: unknown; since?: unknown };
          callbacks.maintenance?.({
            on: Boolean(state.on),
            ...(typeof state.since === 'number' && Number.isFinite(state.since) ? { since: state.since } : {}),
          });
        }
      } catch {
        // Status is best-effort; data refreshes above still completed independently.
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    refreshAll,
    dispose() {
      disposed = true;
    },
  };
}
