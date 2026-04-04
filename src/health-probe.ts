import type { CircuitBreaker } from './circuit-breaker.js';

const PROBE_INTERVAL_MS = 15_000; // 15 seconds
const PROBE_TIMEOUT_MS = 5_000;  // 5 second timeout per probe

export class ActiveProbeManager {
  private providers: Map<string, { baseUrl: string; _circuitBreaker?: CircuitBreaker }>;
  private fetchFn: typeof fetch;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private _tickInProgress = false;

  constructor(
    providers: Map<string, { baseUrl: string; _circuitBreaker?: CircuitBreaker }>,
    fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.providers = providers;
    this.fetchFn = fetchFn;
  }

  /** Update the providers reference after config hot-reload */
  updateProviders(providers: Map<string, { baseUrl: string; _circuitBreaker?: CircuitBreaker }>): void {
    this.providers = providers;
  }

  start(intervalMs: number = PROBE_INTERVAL_MS): void {
    if (this.intervalId !== null) return; // already running
    this.intervalId = setInterval(() => {
      this.tick().catch(err => {
        console.error('[health-probe] tick failed:', err);
      });
    }, intervalMs);
    if (this.intervalId.unref) this.intervalId.unref();
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Run one probe cycle — useful for testing */
  async tick(): Promise<void> {
    // Guard: prevent concurrent tick execution (e.g., if a tick takes >15s due to slow probes)
    if (this._tickInProgress) return;
    this._tickInProgress = true;

    try {
      const probeable: Array<{ name: string; baseUrl: string; cb: CircuitBreaker; probeId: number | undefined }> = [];

      for (const [name, provider] of this.providers) {
        const cb = provider._circuitBreaker;
        if (!cb) continue;
        const state = cb.getState();

        if (state === 'half-open') {
          // Already half-open — a real request may have the probe slot in flight.
          // Fire a probe directly without calling canProceed() to avoid slot-stealing.
          // probeId=undefined tells recordResult() to clear half-open flags regardless
          // of which probe slot is active.
          probeable.push({ name, baseUrl: provider.baseUrl, cb, probeId: undefined });
        } else if (state === 'open') {
          // Open — call canProceed() ONCE to trigger open→half-open transition
          // when cooldown has elapsed. Capture probeId here and pass it through
          // to probeProvider() — do NOT call canProceed() again there.
          const { allowed, probeId } = cb.canProceed();
          if (allowed) {
            probeable.push({ name, baseUrl: provider.baseUrl, cb, probeId });
          }
        }
        // 'closed': nothing to do
      }

      // Probe all eligible providers in parallel
      await Promise.all(probeable.map(p => this.probeProvider(p)));
    } finally {
      this._tickInProgress = false;
    }
  }

  private async probeProvider(entry: { name: string; baseUrl: string; cb: CircuitBreaker; probeId: number | undefined }): Promise<void> {
    // probeId is pre-captured in tick():
    //   - undefined for half-open providers (canProceed skipped to avoid slot-stealing)
    //   - number for open→half-open providers (canProceed called once in tick())
    // Do NOT call canProceed() here — it would consume a second slot or get denied.
    const { probeId } = entry;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

      let status = 0;
      try {
        // Lightweight HEAD request — most providers accept it
        const res = await this.fetchFn(entry.baseUrl, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'follow',
        });
        status = res.status;
      } catch (err: any) {
        clearTimeout(timeout);
        if (err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
          // recordProbeTimeout handles probeId=undefined gracefully for half-open providers
          entry.cb.recordProbeTimeout(probeId!);
          console.warn(`[health-probe] half-open probe timed out for ${entry.name}: ${err.message}`);
          return;
        }
        // Network errors (ENOTFOUND, ECONNREFUSED, TLS errors, etc.) — treat as probe failure
        console.warn(`[health-probe] probe error for ${entry.name}: ${err.message}`);
        entry.cb.recordProbeTimeout(probeId!);
        return;
      } finally {
        clearTimeout(timeout);
      }

      // Treat any HTTP response as "provider is reachable" — the circuit breaker
      // cares about server availability, not endpoint correctness.
      // Only 5xx/429 indicates the provider is actually struggling.
      const effectiveStatus = (status >= 500 || status === 429) ? status : 200;
      // recordResult handles probeId=undefined by clearing half-open flags regardless
      // of which probe slot is active — safe to call for all probe types.
      entry.cb.recordResult(effectiveStatus, probeId);
      console.warn(`[health-probe] half-open probe result for ${entry.name}: ${status}${effectiveStatus !== status ? ` (treated as ${effectiveStatus})` : ''}`);
    } catch (err: any) {
      // Non-fetch errors — log and treat as probe failure
      console.warn(`[health-probe] probe unexpected error for ${entry.name}: ${err.message}`);
      entry.cb.recordProbeTimeout(probeId!);
    }
  }
}
