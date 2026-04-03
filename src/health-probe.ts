import type { CircuitBreaker } from './circuit-breaker.js';

const PROBE_INTERVAL_MS = 15_000; // 15 seconds
const PROBE_TIMEOUT_MS = 5_000;  // 5 second timeout per probe

export class ActiveProbeManager {
  private providers: Map<string, { baseUrl: string; _circuitBreaker?: CircuitBreaker }>;
  private fetchFn: typeof fetch;
  private intervalId: ReturnType<typeof setInterval> | null = null;

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
    this.intervalId = setInterval(() => { this.tick().catch(() => {}); }, intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Run one probe cycle — useful for testing */
  async tick(): Promise<void> {
    const probeable: Array<{ name: string; baseUrl: string; cb: CircuitBreaker }> = [];

    for (const [name, provider] of this.providers) {
      const cb = provider._circuitBreaker;
      if (!cb) continue;
      const state = cb.getState();
      // Probe half-open providers directly; for open providers, call canProceed()
      // to trigger the open→half-open transition when cooldown has elapsed.
      if (state === 'half-open' || state === 'open') {
        probeable.push({ name, baseUrl: provider.baseUrl, cb });
      }
    }

    // Probe all eligible providers in parallel
    await Promise.all(probeable.map(p => this.probeProvider(p)));
  }

  private async probeProvider(entry: { name: string; baseUrl: string; cb: CircuitBreaker }): Promise<void> {
    // Call canProceed() to trigger open→half-open transition when cooldown elapsed
    const { allowed, probeId } = entry.cb.canProceed();
    if (!allowed) return; // cooldown not elapsed or another probe already in flight

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
          entry.cb.recordProbeTimeout(probeId);
          console.warn(`[health-probe] half-open probe timed out for ${entry.name}`);
          return;
        }
        // Other error — ignore, let the next interval try again
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
    } catch {
      // Non-fetch errors — ignore
    }
  }
}
