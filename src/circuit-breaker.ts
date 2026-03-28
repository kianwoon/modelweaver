// src/circuit-breaker.ts
export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerConfig {
  failureThreshold: number;
  windowSeconds: number;
  cooldownSeconds: number;
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

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failureTimestamps: number[] = [];
  private openedAt: number | null = null;
  private halfOpenInProgress: boolean = false;
  private halfOpenProbeId: number | null = null;
  private nextProbeId: number = 0;
  private readonly config: BreakerConfig;

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
      // Check if cooldown has elapsed
      if (this.openedAt && Date.now() - this.openedAt >= this.config.cooldownSeconds * 1000) {
        this.state = "half-open";
        console.warn('[circuit-breaker] HALF-OPEN — cooldown elapsed, allowing probe');
        const probeId = this.nextProbeId++;
        this.halfOpenInProgress = true;
        this.halfOpenProbeId = probeId;
        return { allowed: true, probeId };
      }
      return { allowed: false, probeId: 0 };
    }
    // half-open: allow exactly one probe at a time
    if (!this.halfOpenInProgress) {
      const probeId = this.nextProbeId++;
      this.halfOpenInProgress = true;
      this.halfOpenProbeId = probeId;
      return { allowed: true, probeId };
    }
    return { allowed: false, probeId: 0 };
  }

  recordResult(status: number, probeId?: number): void {
    // Only reset half-open flag if this is the probe that triggered it
    if (this.halfOpenInProgress && (probeId === undefined || probeId === this.halfOpenProbeId)) {
      this.halfOpenInProgress = false;
      this.halfOpenProbeId = null;
    }

    if (status >= 200 && status < 300) {
      // Success — reset to closed
      this.state = "closed";
      this.failureTimestamps = [];
      this.openedAt = null;
      console.warn('[circuit-breaker] CLOSED — recovered after successful request');
      return;
    }

    // Only count retriable errors (429, 5xx) as failures
    if (status !== 429 && status < 500) return;

    const now = Date.now();
    this.failureTimestamps.push(now);
    this.pruneOldFailures(now);

    if (this.state === "half-open") {
      // Any failure in half-open → back to open
      this.state = "open";
      this.openedAt = now;
      console.warn('[circuit-breaker] back to OPEN — probe failed');
      return;
    }

    // Check if threshold exceeded
    if (this.failureTimestamps.length >= this.config.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
      console.warn(`[circuit-breaker] OPENED — ${this.failureTimestamps.length} failures in ${this.config.windowSeconds}s window`);
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
