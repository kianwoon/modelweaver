import { describe, it, expect, beforeEach } from "vitest";
import { Semaphore, getSemaphore, resolveConcurrency, resetSemaphores } from "../src/concurrency.js";
import type { ConcurrencyConfig } from "../src/types.js";

describe("Semaphore", () => {
  let sem: Semaphore;

  beforeEach(() => {
    sem = new Semaphore(1);
  });

  it("acquires immediately when under limit", async () => {
    const acquired = await sem.acquire(1000);
    expect(acquired).toBe(true);
  });

  it("queues when at limit and resolves on release", async () => {
    await sem.acquire(1000);
    const p = sem.acquire(5000);
    sem.release();
    expect(await p).toBe(true);
  });

  it("rejects on timeout", async () => {
    await sem.acquire(1000);
    const acquired = await sem.acquire(50);
    expect(acquired).toBe(false);
  });

  it("handles multiple queued waiters in FIFO order", async () => {
    const sem2 = new Semaphore(1);
    await sem2.acquire(1000);

    const results: boolean[] = [];
    const p1 = sem2.acquire(2000).then((r) => results.push(r));
    const p2 = sem2.acquire(2000).then((r) => results.push(r));
    const p3 = sem2.acquire(2000).then((r) => results.push(r));

    sem2.release();
    await p1;
    sem2.release();
    await p2;
    sem2.release();
    await p3;

    expect(results).toEqual([true, true, true]);
  });

  it("cleans up timed-out waiters from queue", async () => {
    await sem.acquire(1000);
    await sem.acquire(50);
    expect((sem as any).queue.length).toBe(0);
  });
});

describe("resolveConcurrency", () => {
  beforeEach(() => {
    resetSemaphores();
  });

  it("returns null when no config provided", () => {
    expect(resolveConcurrency("glm-5.1", "tier1")).toBeNull();
  });

  it("prefers provider+model over model level", () => {
    const providerConfig = new Map<string, ConcurrencyConfig>();
    providerConfig.set("glm:glm-5.1", { max_inflight: 1, queueTimeoutMs: 10000 });
    const modelConfig = new Map<string, ConcurrencyConfig>();
    modelConfig.set("glm-5.1", { max_inflight: 4, queueTimeoutMs: 30000 });

    const result = resolveConcurrency("glm-5.1", "tier1", "glm", providerConfig, modelConfig);
    expect(result!.key).toBe("pm:glm:glm-5.1");
    expect(result!.config.max_inflight).toBe(1);
  });

  it("prefers model over tier when no provider config", () => {
    const modelConfig = new Map<string, ConcurrencyConfig>();
    modelConfig.set("glm-5.1", { max_inflight: 1, queueTimeoutMs: 10000 });
    const tierConfig = new Map<string, ConcurrencyConfig>();
    tierConfig.set("tier1", { max_inflight: 4, queueTimeoutMs: 30000 });

    const result = resolveConcurrency("glm-5.1", "tier1", "glm", undefined, modelConfig, tierConfig);
    expect(result!.key).toBe("model:glm-5.1");
    expect(result!.config.max_inflight).toBe(1);
  });

  it("falls back to tier when no model config", () => {
    const tierConfig = new Map<string, ConcurrencyConfig>();
    tierConfig.set("tier1", { max_inflight: 2, queueTimeoutMs: 30000 });

    const result = resolveConcurrency("glm-5.1", "tier1", "glm", undefined, undefined, tierConfig);
    expect(result!.key).toBe("tier:tier1");
    expect(result!.config.max_inflight).toBe(2);
  });

  it("returns null when max_inflight is 0", () => {
    const modelConfig = new Map<string, ConcurrencyConfig>();
    modelConfig.set("glm-5.1", { max_inflight: 0, queueTimeoutMs: 30000 });

    const result = resolveConcurrency("glm-5.1", "tier1", undefined, undefined, modelConfig);
    expect(result).toBeNull();
  });

  it("different providers get independent semaphores", () => {
    const providerConfig = new Map<string, ConcurrencyConfig>();
    providerConfig.set("glm:glm-5.1", { max_inflight: 1, queueTimeoutMs: 10000 });
    providerConfig.set("glm_openai:glm-5.1", { max_inflight: 3, queueTimeoutMs: 15000 });

    const r1 = resolveConcurrency("glm-5.1", "tier1", "glm", providerConfig);
    const r2 = resolveConcurrency("glm-5.1", "tier1", "glm_openai", providerConfig);

    const s1 = getSemaphore(r1!.key, r1!.config.max_inflight);
    const s2 = getSemaphore(r2!.key, r2!.config.max_inflight);
    expect(s1).not.toBe(s2);
  });

  it("skips provider level when provider is undefined", () => {
    const modelConfig = new Map<string, ConcurrencyConfig>();
    modelConfig.set("glm-5.1", { max_inflight: 2, queueTimeoutMs: 30000 });

    const result = resolveConcurrency("glm-5.1", "tier1", undefined, undefined, modelConfig);
    expect(result!.key).toBe("model:glm-5.1");
  });
});

describe("getSemaphore", () => {
  beforeEach(() => {
    resetSemaphores();
  });

  it("returns same semaphore for same key", () => {
    const a = getSemaphore("tier:tier1", 1);
    const b = getSemaphore("tier:tier1", 1);
    expect(a).toBe(b);
  });

  it("returns different semaphores for different keys", () => {
    const a = getSemaphore("pm:glm:glm-5.1", 1);
    const b = getSemaphore("pm:glm_openai:glm-5.1", 3);
    expect(a).not.toBe(b);
  });

  it("resetSemaphores clears all semaphores", () => {
    const a = getSemaphore("tier:tier1", 1);
    resetSemaphores();
    const b = getSemaphore("tier:tier1", 1);
    expect(a).not.toBe(b);
  });
});
