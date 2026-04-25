// tests/compress-old-turns.test.ts
import { describe, it, expect } from "vitest";
import { compressOldTurns } from "../src/proxy.js";

/** Helper: build a user text message */
function userMsg(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

/** Helper: build an assistant text message */
function assistantMsg(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** Helper: build an assistant message with tool_use blocks */
function assistantToolMsg(toolCalls: { id: string; name: string; input?: any }[]) {
  return {
    role: "assistant",
    content: toolCalls.map(tc => ({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.input ?? {},
    })),
  };
}

/** Helper: build a user message with tool_result blocks */
function toolResultMsg(results: { toolUseId: string; content: string }[]) {
  return {
    role: "user",
    content: results.map(r => ({
      type: "tool_result",
      tool_use_id: r.toolUseId,
      content: r.content,
    })),
  };
}

/** Helper: create body with messages array */
function makeBody(messages: any[]) {
  return { messages: structuredClone(messages) };
}

describe("compressOldTurns", () => {
  it("skips when messages count is zero", () => {
    const body = makeBody([]);
    compressOldTurns(body, 5);
    expect(body.messages).toEqual([]);
  });

  it("skips when turn count is within limit", () => {
    const msgs = [
      userMsg("hello"),
      assistantMsg("hi there"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 5);
    expect(body.messages).toEqual(msgs);
  });

  it("skips when turn count equals limit", () => {
    const msgs = [
      userMsg("turn 1"),
      assistantMsg("response 1"),
      userMsg("turn 2"),
      assistantMsg("response 2"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 2);
    // 2 turns === limit, no compression needed
    expect(body.messages).toEqual(msgs);
  });

  it("compresses old turns to skeletons and keeps recent turns verbatim", () => {
    const msgs = [
      userMsg("turn 1 question"),
      assistantMsg("turn 1 answer"),
      userMsg("turn 2 question"),
      assistantMsg("turn 2 answer"),
      userMsg("turn 3 question"),
      assistantMsg("turn 3 answer"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 1); // keep only last 1 turn

    const result = body.messages;

    // Should have: skeleton for turn1 + skeleton for turn2 + turn3 user + turn3 assistant
    // 2 skeleton pairs (4 msgs) + 2 kept = 6
    expect(result.length).toBe(6);

    // First skeleton user
    expect(result[0].role).toBe("user");
    expect(result[0].content[0].text).toContain("turn 1 question");

    // First skeleton assistant
    expect(result[1].role).toBe("assistant");
    expect(result[1].content[0].text).toContain("[Earlier:");

    // Second skeleton pair
    expect(result[2].role).toBe("user");
    expect(result[3].role).toBe("assistant");

    // Kept turn 3 verbatim
    expect(result[4]).toEqual(userMsg("turn 3 question"));
    expect(result[5]).toEqual(assistantMsg("turn 3 answer"));
  });

  it("preserves role alternation in output", () => {
    const msgs = [
      userMsg("q1"), assistantMsg("a1"),
      userMsg("q2"), assistantMsg("a2"),
      userMsg("q3"), assistantMsg("a3"),
      userMsg("q4"), assistantMsg("a4"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 2);

    // Verify strict alternation
    for (let i = 0; i < body.messages.length; i++) {
      const expectedRole = i % 2 === 0 ? "user" : "assistant";
      expect(body.messages[i].role).toBe(expectedRole);
    }
  });

  it("removes tool chain messages from old turns", () => {
    const msgs = [
      userMsg("write a function"),
      assistantToolMsg([{ id: "call_1", name: "Write" }]),
      toolResultMsg([{ toolUseId: "call_1", content: "file written" }]),
      assistantMsg("done writing"),
      userMsg("now test it"),
      assistantToolMsg([{ id: "call_2", name: "Bash" }]),
      toolResultMsg([{ toolUseId: "call_2", content: "tests pass" }]),
      assistantMsg("all tests pass"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 1); // keep only last turn ("now test it" onwards)

    const result = body.messages;

    // Old turn skeleton should mention "Write" tool
    const skeletonTexts = result.slice(0, 2).map((m: any) =>
      m.content.map((b: any) => b.text).join(""),
    ).join(" ");
    expect(skeletonTexts).toContain("Write");

    // Kept turn should be verbatim (userMsg + assistant tool chain + tool_result + assistant)
    const kept = result.slice(2); // after skeletons
    expect(kept[0]).toEqual(userMsg("now test it"));
    expect(kept[1]).toEqual(assistantToolMsg([{ id: "call_2", name: "Bash" }]));
  });

  it("handles user messages with string content (not array)", () => {
    const msgs = [
      { role: "user", content: "simple string question" },
      { role: "assistant", content: "simple answer" },
      userMsg("turn 2"),
      assistantMsg("answer 2"),
    ];
    const body = { messages: structuredClone(msgs) };
    compressOldTurns(body, 1);

    const result = body.messages as any[];
    // First skeleton should extract the string content
    expect(result[0].content[0].text).toContain("simple string question");
  });

  it("handles empty user message content", () => {
    const msgs = [
      { role: "user", content: "" },
      { role: "assistant", content: "ok" },
      userMsg("real question"),
      assistantMsg("real answer"),
    ];
    const body = { messages: structuredClone(msgs) };
    compressOldTurns(body, 1);

    const result = body.messages as any[];
    // Empty content → fallback to "[Earlier: user message]"
    expect(result[0].content[0].text).toContain("[Earlier: user message]");
  });

  it("skips tool_result-only user messages as turn starts", () => {
    // A conversation that starts with a tool_result (mid-chain) should NOT be treated as a turn start
    const msgs = [
      toolResultMsg([{ toolUseId: "call_1", content: "result" }]),
      assistantMsg("continuing"),
      userMsg("new turn"),
      assistantMsg("response"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 1);

    const result = body.messages;
    // tool_result message is NOT a turn start, so "new turn" is turn 1
    // With keepTurns=1 and only 1 turn, nothing should be compressed
    expect(result).toEqual(msgs);
  });

  it("skips injected hint messages as turn starts", () => {
    const hintMsg = {
      role: "user",
      content: [{ type: "text", text: "[System: 5 earlier turns compressed to summaries]" }],
    };
    const msgs = [
      hintMsg,
      assistantMsg("continuing"),
      userMsg("new question"),
      assistantMsg("answer"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 1);

    // "new question" is the only real turn, so nothing to compress
    expect(body.messages).toEqual(msgs);
  });

  it("truncates long user previews to 80 chars", () => {
    const longText = "a".repeat(200);
    const msgs = [
      userMsg(longText),
      assistantMsg("ok"),
      userMsg("short"),
      assistantMsg("done"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 1);

    const skeletonUser = body.messages[0];
    const text = skeletonUser.content[0].text;
    // The preview should contain at most 80 chars of the original + ellipsis
    expect(text.length).toBeLessThan(120); // "[Earlier: user asked " + 80 + "...]"
    expect(text).toContain("...");
  });

  it("mentions tool names in assistant skeleton", () => {
    const msgs = [
      userMsg("do stuff"),
      assistantToolMsg([
        { id: "c1", name: "Read" },
        { id: "c2", name: "Edit" },
      ]),
      userMsg("more"),
      assistantMsg("done"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 1);

    // Find the skeleton assistant for turn 1
    const skeletonAssistant = body.messages[1];
    const text = skeletonAssistant.content[0].text;
    expect(text).toContain("Read");
    expect(text).toContain("Edit");
  });

  it("handles assistant with text content when no tools used", () => {
    const msgs = [
      userMsg("explain something"),
      assistantMsg("here is a detailed explanation that is quite long and goes on and on and on and on"),
      userMsg("thanks"),
      assistantMsg("you're welcome"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 1);

    const skeletonAssistant = body.messages[1];
    const text = skeletonAssistant.content[0].text;
    expect(text).toContain("[Earlier: assistant responded");
    expect(text).toContain("here is a detailed explanation");
  });

  it("handles conversation with system prompt at start", () => {
    const msgs = [
      { role: "user", content: "system instruction" } as any,
      userMsg("first question"),
      assistantMsg("first answer"),
      userMsg("second question"),
      assistantMsg("second answer"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 1);

    // "system instruction" is the first turn, "first question" is second turn, "second question" is third
    // With keepTurns=1, turns 1 and 2 get compressed
    const result = body.messages;
    // Should still have strict role alternation
    for (let i = 0; i < result.length; i++) {
      const expectedRole = i % 2 === 0 ? "user" : "assistant";
      expect(result[i].role).toBe(expectedRole);
    }
  });

  it("does not mutate original messages array", () => {
    const original = [
      userMsg("q1"), assistantMsg("a1"),
      userMsg("q2"), assistantMsg("a2"),
    ];
    const originalCopy = structuredClone(original);
    const body = makeBody(original);
    compressOldTurns(body, 1);

    // The input array objects should not be modified (body.messages is a new array)
    // But verify the original messages' content wasn't mutated
    expect(original[0].content[0].text).toBe(originalCopy[0].content[0].text);
    expect(original[1].content[0].text).toBe(originalCopy[1].content[0].text);
  });

  it("handles single turn conversation (no compression needed)", () => {
    const msgs = [
      userMsg("hello"),
      assistantMsg("hi"),
    ];
    const body = makeBody(msgs);
    compressOldTurns(body, 5);
    expect(body.messages).toEqual(msgs);
  });

  it("handles non-array messages gracefully", () => {
    const body = { messages: "not an array" } as any;
    expect(() => compressOldTurns(body, 5)).not.toThrow();
  });

  it("handles missing messages field gracefully", () => {
    const body = {} as any;
    expect(() => compressOldTurns(body, 5)).not.toThrow();
  });
});
