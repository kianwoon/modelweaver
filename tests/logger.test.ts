// tests/logger.test.ts
import { describe, it, expect, vi } from "vitest";
import { createLogger, type Logger } from "../src/logger.js";

describe("logger", () => {
  it("logs info messages as JSON to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger("info");
    logger.info("test", { model: "claude-sonnet-4", tier: "sonnet" });

    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse(spy.mock.calls[0][0] as string);
    expect(output.level).toBe("info");
    expect(output.message).toBe("test");
    expect(output.model).toBe("claude-sonnet-4");
    expect(output.tier).toBe("sonnet");
    expect(output.timestamp).toBeDefined();
    spy.mockRestore();
  });

  it("skips debug messages when level is info", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger("info");
    logger.debug("should not appear");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("includes debug messages when level is debug", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger("debug");
    logger.debug("debug msg");
    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse(spy.mock.calls[0][0] as string);
    expect(output.level).toBe("debug");
    spy.mockRestore();
  });

  it("includes requestId in structured data", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger("info");
    logger.info("request", { requestId: "abc-123" });
    const output = JSON.parse(spy.mock.calls[0][0] as string);
    expect(output.requestId).toBe("abc-123");
    spy.mockRestore();
  });
});
