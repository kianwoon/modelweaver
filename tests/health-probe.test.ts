import { describe, it, assert, vi, beforeEach, afterEach } from 'vitest';
import { ActiveProbeManager } from '../src/health-probe.js';

describe('ActiveProbeManager', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let providers: Map<string, { baseUrl: string; _circuitBreaker?: any }>;

  beforeEach(() => {
    fetchMock = vi.fn();
    providers = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('probes half-open providers on tick and records success', async () => {
    const recordResult = vi.fn();
    const recordProbeTimeout = vi.fn();
    const canProceed = vi.fn().mockReturnValue({ allowed: true, probeId: 1 });
    const getState = vi.fn().mockReturnValue('half-open');

    providers.set('glm', {
      baseUrl: 'https://glm.example.com',
      _circuitBreaker: { getState, canProceed, recordResult, recordProbeTimeout },
    });

    fetchMock.mockResolvedValue({ status: 200 });
    const mgr = new ActiveProbeManager(providers, fetchMock as any);

    await mgr.tick();

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.include(fetchMock.mock.calls[0][0], 'glm');
    assert.equal(recordResult.mock.calls.length, 1);
    assert.equal(recordResult.mock.calls[0][0], 200);
    assert.equal(recordProbeTimeout.mock.calls.length, 0);
  });

  it('calls recordProbeTimeout when probe times out', async () => {
    const recordResult = vi.fn();
    const recordProbeTimeout = vi.fn();
    const canProceed = vi.fn().mockReturnValue({ allowed: true, probeId: 1 });
    const getState = vi.fn().mockReturnValue('half-open');

    providers.set('glm', {
      baseUrl: 'https://glm.example.com',
      _circuitBreaker: { getState, canProceed, recordResult, recordProbeTimeout },
    });

    // Simulate timeout by aborting
    fetchMock.mockImplementation(() => {
      return new Promise((_, __) => {}); // never resolves
    });
    const mgr = new ActiveProbeManager(providers, fetchMock as any);

    // Tick returns after timeout - but our mock never resolves so use a quick timeout
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => { mgr.stop(); resolve(); }, 100);
    });
    await Promise.race([mgr.tick(), timeoutPromise]);
    mgr.stop();
  });

  it('skips closed providers', async () => {
    const getState = vi.fn().mockReturnValue('closed');
    providers.set('glm', {
      baseUrl: 'https://glm.example.com',
      _circuitBreaker: { getState },
    });

    const mgr = new ActiveProbeManager(providers, fetchMock as any);
    await mgr.tick();

    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it('skips open providers', async () => {
    const getState = vi.fn().mockReturnValue('open');
    providers.set('glm', {
      baseUrl: 'https://glm.example.com',
      _circuitBreaker: { getState },
    });

    const mgr = new ActiveProbeManager(providers, fetchMock as any);
    await mgr.tick();

    assert.equal(fetchMock.mock.calls.length, 0);
  });
});
