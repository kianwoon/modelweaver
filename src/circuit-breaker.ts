// src/circuit-breaker.ts
export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerConfig {
  failureThreshold: number;
  windowSeconds: number;
  cooldownSeconds: number;
  /** Shorter cooldown for rate-limited (429) providers — they recover faster */
  rateLimitCooldownSeconds?: number;
}

export interface BreakerStatus {
  state: BreakerState;
  failures: number;
  lastFailure: number | null;
}

const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 3,
  windowSeconds: 60,
  cooldownSeconds: 30,
};

/** Maximum cooldown cap (ms) — escalating cooldown never exceeds this */
const COOLDOWN_CAP_MS = 60_000;
/** Number of consecutive successes needed to reset escalating cooldown */
const SUSTAINED_RECOVERY_THRESHOLD = 5;

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failureTimestamps: number[] = [];
  private openedAt: number | null = null;
  private _cooldownMs: number = 0;
  private halfOpenInProgress: boolean = false;
  private halfOpenProbeId: number | null = null;
  private nextProbeId: number = 0;
  /** Synchronous lock: prevents concurrent half-open probe grants in the same microtask batch.
   *  Set synchronously in canProceed() before any await, reset in recordResult(). */
  private _probeGranted: boolean = false;
  private readonly config: BreakerConfig;

  /** Consecutive open→close→open flap cycles (for escalating cooldown) */
  private _flapCount = 0;
  /** Consecutive successes since last open→close transition (for sustained recovery reset) */
  private _consecutiveSuccesses = 0;

  constructor(config: Partial<BreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Returns a probe ID if the caller is allowed to proceed in half-open state,
   * or null if blocked. For closed state, always returns 0 (no probe tracking needed).
   */
  canProceed(): { allowed: boolean; probeId: number } {
    if (this.state === "closed") return { allowed: true, probeId: 0 };
    if (this.state === "open") {
      // Check if cooldown has elapsed (use per-event cooldown for 429 vs 502)
      const cooldown = this._cooldownMs || this.config.cooldownSeconds * 1000;
      if (this.openedAt && Date.now() - this.openedAt >= cooldown) {
        this.state = "half-open";
        console.warn('[circuit-breaker] HALF-OPEN — cooldown elapsed, allowing probe');
        const probeId = this.nextProbeId++;
        this.halfOpenInProgress = true;
        this.halfOpenProbeId = probeId;
        this._probeGranted = true;
        return { allowed: true, probeId };
      }
      return { allowed: false, probeId: 0 };
    }
    // half-open: allow exactly one probe at a time
    if (!this.halfOpenInProgress && !this._probeGranted) {
      const probeId = this.nextProbeId++;
      this.halfOpenInProgress = true;
      this.halfOpenProbeId = probeId;
      this._probeGranted = true;
      return { allowed: true, probeId };
    }
    return { allowed: false, probeId: 0 };
  }

  /**
   * Record a timeout on a probe request in half-open state.
   * Clears probe flags and transitions back to open (counts as a flap)
   * so the next request after cooldown can probe again.
   *
   * For non-probe timeouts (regular requests in closed state), timeouts
   * are still a no-op — they don't count toward the failure threshold.
   */
  recordProbeTimeout(probeId: number): void {
    // Only act if this probe is the one in flight
    if (!this.halfOpenInProgress || probeId !== this.halfOpenProbeId) return;

    // Timeout of a half-open probe = treat as a flap, go back to open
    // and let the next cooldown-elapsed request trigger a fresh probe.
    this.halfOpenInProgress = false;
    this.halfOpenProbeId = null;
    this._probeGranted = false;
    this.state = "open";
    this.openedAt = Date.now();
    this._cooldownMs = this.escalateCooldown(false /* not a rate-limit */);
    this._flapCount++;
    console.warn(`[circuit-breaker] HALF-OPEN PROBE TIMED OUT — back to OPEN (flap=${this._flapCount}, cooldown=${this._cooldownMs}ms)`);
  }

  /**
   * Record a timeout without tripping the circuit breaker.
   * Timeouts are often caused by stale connections or transient load —
   * retrying with a fresh connection usually succeeds. Only actual server
   * errors (5xx, 429) should count toward the failure threshold.
   * NOTE: For probe timeouts, use recordProbeTimeout() instead — that
   * clears probe flags so a new probe can be attempted.
   */
  recordTimeout(): void {
    // No-op for non-probe requests: timeouts don't count as circuit breaker failures.
    // This prevents cascading breaker trips during upstream degradation.
  }

  /**
   * Whether a given HTTP status should be treated as a server error
   * (and count toward the circuit breaker threshold) vs a transient
   * condition (timeout, stall) that should NOT trip the breaker.
   */
  isRetriableServerError(status: number): boolean {
    // Only count actual server responses as failures — not synthetic 502s
    // generated by timeouts, stalls, or connection errors.
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }

  recordResult(status: number, probeId?: number): void {
    // Only reset half-open flag if this is the probe that triggered it
    if (this.halfOpenInProgress && (probeId === undefined || probeId === this.halfOpenProbeId)) {
      this.halfOpenInProgress = false;
      this.halfOpenProbeId = null;
      this._probeGranted = false;
    }

    if (status >= 200 && status < 300) {
      // Success — reset to closed
      this._consecutiveSuccesses++;

      // Check for sustained recovery: reset escalating cooldown after N consecutive successes
      if (this._consecutiveSuccesses >= SUSTAINED_RECOVERY_THRESHOLD) {
        if (this._flapCount > 0) {
          console.warn(`[circuit-breaker] SUSTAINED RECOVERY — resetting flap count from ${this._flapCount} to 0 after ${this._consecutiveSuccesses} consecutive successes`);
        }
        this._flapCount = 0;
        this._consecutiveSuccesses = 0;
      }

      this.state = "closed";
      this.failureTimestamps = [];
      this.openedAt = null;
      this._probeGranted = false;
      console.warn('[circuit-breaker] CLOSED — recovered after successful request');
      return;
    }

    // Only count retriable errors (429, 5xx from actual upstream) as failures.
    // Synthetic 502s from timeouts/stalls/connection errors are NOT counted —
    // they're transient and retrying with a fresh connection usually succeeds.
    if (!this.isRetriableServerError(status)) return;

    const isRateLimit = status === 429;

    const now = Date.now();
    this.failureTimestamps.push(now);
    this.pruneOldFailures(now);

    // Any retriable failure resets the consecutive success counter
    this._consecutiveSuccesses = 0;

    if (this.state === "half-open") {
      // Any failure in half-open → back to open (count as a flap)
      this._flapCount++;
      this._consecutiveSuccesses = 0;
      this.state = "open";
      this.openedAt = now;
      this._cooldownMs = this.escalateCooldown(isRateLimit);
      this._probeGranted = false;
      console.warn(`[circuit-breaker] back to OPEN — probe failed (${isRateLimit ? 'rate-limited' : 'server error'}, cooldown=${this._cooldownMs}ms, flap=${this._flapCount})`);
      return;
    }

    // Check if threshold exceeded
    if (this.failureTimestamps.length >= this.config.failureThreshold) {
      this._consecutiveSuccesses = 0;
      this.state = "open";
      this.openedAt = now;
      this._cooldownMs = this.escalateCooldown(isRateLimit);
      console.warn(`[circuit-breaker] OPENED — ${this.failureTimestamps.length} failures in ${this.config.windowSeconds}s window (${isRateLimit ? 'rate-limited' : 'server error'}, cooldown=${this._cooldownMs}ms, flap=${this._flapCount})`);
    }
  }

  getState(): BreakerState {
    return this.state;
  }

  getStatus(): BreakerStatus {
    return {
      state: this.state,
      failures: this.failureTimestamps.length,
      lastFailure: this.failureTimestamps.length > 0
        ? this.failureTimestamps[this.failureTimestamps.length - 1]
        : null,
    };
  }

  /**
   * Compute escalating cooldown based on flap count.
   * Each consecutive open→close→open cycle doubles the base cooldown, capped at COOLDOWN_CAP_MS.
   * 1st failure: base cooldown (e.g. 30s)
   * 2nd flap: 2× base
   * 3rd flap: 4× base
   * ...
   * Caps at COOLDOWN_CAP_MS (60s)
   */
  private escalateCooldown(isRateLimit: boolean): number {
    const baseCooldown = isRateLimit
      ? (this.config.rateLimitCooldownSeconds ?? 10) * 1000
      : this.config.cooldownSeconds * 1000;
    const escalated = baseCooldown * Math.pow(2, this._flapCount);
    return Math.min(escalated, COOLDOWN_CAP_MS);
  }

  private pruneOldFailures(now: number): void {
    const cutoff = now - this.config.windowSeconds * 1000;
    let writeIdx = 0;
    for (let i = 0; i < this.failureTimestamps.length; i++) {
      if (this.failureTimestamps[i] >= cutoff) {
        this.failureTimestamps[writeIdx++] = this.failureTimestamps[i];
      }
    }
    this.failureTimestamps.length = writeIdx;
  }
}
