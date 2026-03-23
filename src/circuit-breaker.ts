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
  private readonly config: BreakerConfig;

  constructor(config: Partial<BreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  canProceed(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      // Check if cooldown has elapsed
      if (this.openedAt && Date.now() - this.openedAt >= this.config.cooldownSeconds * 1000) {
        this.state = "half-open";
        return true; // Allow one probe request
      }
      return false;
    }
    // half-open: allow exactly one probe at a time
    if (!this.halfOpenInProgress) {
      this.halfOpenInProgress = true;
      return true;
    }
    return false;
  }

  recordResult(status: number): void {
    this.halfOpenInProgress = false;

    if (status >= 200 && status < 300) {
      // Success — reset to closed
      this.state = "closed";
      this.failureTimestamps = [];
      this.openedAt = null;
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
      return;
    }

    // Check if threshold exceeded
    if (this.failureTimestamps.length >= this.config.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
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
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
  }
}
