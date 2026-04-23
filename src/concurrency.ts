import type { ConcurrencyConfig } from "./types.js";

export class Semaphore {
  private queue: Array<{ resolve: (slot: number) => void; timer?: ReturnType<typeof setTimeout> }> = [];
  private current = 0;

  constructor(private max: number) {}

  async acquire(timeoutMs?: number): Promise<boolean> {
    if (this.current < this.max) {
      this.current++;
      return true;
    }

    if (timeoutMs === undefined || timeoutMs <= 0) {
      return new Promise<boolean>((resolve) => {
        this.queue.push({ resolve: () => { this.current++; resolve(true); } });
      });
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((w) => w.resolve === onAcquire);
        if (idx !== -1) this.queue.splice(idx, 1);
        resolve(false);
      }, timeoutMs);

      const onAcquire = () => { this.current++; resolve(true); };
      this.queue.push({ resolve: onAcquire, timer });
    });
  }

  release(): void {
    if (this.current > 0) this.current--;
    const next = this.queue.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve(0);
    }
  }
}

const semaphores = new Map<string, Semaphore>();

/**
 * Resolve concurrency config for a request.
 * Lookup order: provider+model → model → tier → none.
 * Returns the key (for semaphore lookup) and the config, or null if no limit applies.
 */
export function resolveConcurrency(
  model: string,
  tier: string,
  provider?: string,
  providerConcurrency?: Map<string, ConcurrencyConfig>,
  modelConcurrency?: Map<string, ConcurrencyConfig>,
  tierConcurrency?: Map<string, ConcurrencyConfig>,
): { key: string; config: ConcurrencyConfig } | null {
  // 1. Provider+model level (most specific)
  if (provider) {
    const pmKey = `${provider}:${model}`;
    const pmConfig = providerConcurrency?.get(pmKey);
    if (pmConfig && pmConfig.max_inflight > 0) {
      return { key: `pm:${pmKey}`, config: pmConfig };
    }
  }

  // 2. Model level
  const modelConfig = modelConcurrency?.get(model);
  if (modelConfig && modelConfig.max_inflight > 0) {
    return { key: `model:${model}`, config: modelConfig };
  }

  // 3. Tier level (broadest)
  const tierConfig = tierConcurrency?.get(tier);
  if (tierConfig && tierConfig.max_inflight > 0) {
    return { key: `tier:${tier}`, config: tierConfig };
  }

  return null;
}

/**
 * Get or create a semaphore for the given key.
 */
export function getSemaphore(key: string, maxInflight: number): Semaphore {
  let sem = semaphores.get(key);
  if (!sem) {
    sem = new Semaphore(maxInflight);
    semaphores.set(key, sem);
  }
  return sem;
}

export function resetSemaphores(): void {
  semaphores.clear();
}
