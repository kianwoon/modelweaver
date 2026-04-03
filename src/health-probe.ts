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
      const probeable: Array<{ name: string; baseUrl: string; cb: CircuitBreaker; fromHalfOpen: boolean }> = [];

      for (const [name, provider] of this.providers) {
        const cb = provider._circuitBreaker;
        if (!cb) continue;
        const state = cb.getState();

        if (state === 'half-open') {
          // Already half-open — a real request may have the probe slot in flight.
          // Fire a probe directly without calling canProceed() to avoid slot-stealing.
          // If a real request is in-flight, this is a redundant duplicate probe — harmless.
          // recordResult() will handle the response correctly regardless.
          probeable.push({ name, baseUrl: provider.baseUrl, cb, fromHalfOpen: true });
        } else if (state === 'open') {
          // Open — call canProceed() to trigger open→half-open transition
          // when cooldown has elapsed. This is safe since no real request
          // is in-flight (the breaker is blocking all traffic).
          const { allowed } = cb.canProceed();
          if (allowed) {
            probeable.push({ name, baseUrl: provider.baseUrl, cb, fromHalfOpen: false });
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

  private async probeProvider(entry: { name: string; baseUrl: string; cb: CircuitBreaker; fromHalfOpen: boolean }): Promise<void> {
    // For half-open providers: tick() skipped canProceed() to avoid slot-stealing,
    // so we probe with probeId=undefined. recordResult() with undefined probeId
    // will clear the half-open flags, transitioning back to closed on success.
    // If a real request already holds the probe slot, this is a harmless duplicate.
    // For open→half-open: canProceed() was called in tick() and granted a probeId.
    let probeId: number | undefined;
    if (entry.fromHalfOpen) {
      // Don't call canProceed() — it would steal the slot from a real request
      probeId = undefined;
    } else {
      const { allowed, probeId: pid } = entry.cb.canProceed();
      // Re-check: another tick or real request may have already handled this
      if (!allowed) return;
      probeId = pid;
    }

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
          if (probeId !== undefined) entry.cb.recordProbeTimeout(probeId);
          console.warn(`[health-probe] half-open probe timed out for ${entry.name}: ${err.message}`);
          return;
        }
        // Network errors (ENOTFOUND, ECONNREFUSED, TLS errors, etc.) — treat as probe failure
        console.warn(`[health-probe] probe error for ${entry.name}: ${err.message}`);
        if (probeId !== undefined) entry.cb.recordProbeTimeout(probeId);
        return;
      } finally {
        clearTimeout(timeout);
      }

      // Treat any HTTP response as "provider is reachable" — the circuit breaker
      // cares about server availability, not endpoint correctness.
      // Only 5xx/429 indicates the provider is actually struggling.
      const effectiveStatus = (status >= 500 || status === 429) ? status : 200;
      entry.cb.recordResult(effectiveStatus, probeId);
      console.warn(`[health-probe] half-open probe result for ${entry.name}: ${status}${effectiveStatus !== status ? ` (treated as ${effectiveStatus})` : ''}`);
    } catch (err: any) {
      // Non-fetch errors — log and treat as probe failure
      console.warn(`[health-probe] probe unexpected error for ${entry.name}: ${err.message}`);
      if (probeId !== undefined) entry.cb.recordProbeTimeout(probeId);
    }
  }
}
