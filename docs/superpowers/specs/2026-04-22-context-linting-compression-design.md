# Context Linting & Structured Tool Compression

> Date: 2026-04-22
> Status: Approved
> Features: #9 (Context Linting) + #4 (Enhanced Tool Compression)

## Overview

Two features that improve what the upstream model receives without requiring session state or new infrastructure:

1. **Context Linting** — pre-flight checks that auto-fix broken message arrays before forwarding
2. **Structured Tool Compression** — metadata headers on compressed tool results so models see key findings without parsing raw output

Both run in the existing `forwardRequest()` pipeline, between trimming and adapter transform.

## Feature #9: Context Linting

### Architecture

New file: `src/context-linter.ts`

```typescript
interface LintFix {
  rule: string;       // e.g. "orphan-tool-result"
  action: "removed" | "deduplicated";
  description: string;
  messageIndex?: number;
}

interface LintResult {
  fixes: LintFix[];
  warnings: string[];
}

// Message here is a plain object from parsed JSON body.messages[], not a TS class.
// Shape: { role: string, content: string | Array<{type: string, ...}> }
export function lintContext(messages: Message[]): { messages: Message[], result: LintResult }
```

Single-pass function. Mutates messages in-place (same pattern as existing `compressToolResults`). Returns fixes applied and warnings for unfixable issues.

### Lint Rules (v1)

#### Rule 1: Orphan tool result

- Scan for `tool_result` blocks whose `tool_use_id` has no matching `tool_use` in any assistant message
- Fix: Remove the orphaned `tool_result` block. If the user message becomes empty (all blocks were orphans), remove the entire message
- Replaces existing `cleanOrphanedToolMessages` which only ran on fallback attempts (chainIndex > 0). This runs on every request

#### Rule 2: Duplicate instructions

- Extract "instruction-like" content: system messages, user messages with text >200 chars that match heuristic patterns (starts with imperative verb, contains "must"/"should"/"always"/"never"/"ensure"/"do not", or is the first user message in the conversation)
- Normalize each instruction: lowercase, collapse whitespace, strip punctuation
- Compare word-level Jaccard similarity. If >0.8 between two instructions, flag the later one as duplicate
- Fix: Remove the later duplicate, keep the earlier (usually more authoritative system-level instruction)
- Only compares within the same role (system vs system, user vs user) to avoid false positives

#### Rule 3: Stale tool results

- Build tool_name → [tool_result entries] index from messages
- If the same tool name appears in tool_result blocks >4 turns apart, the earlier one is likely superseded
- Fix: Replace the earlier result with a compact summary: `[Previous ${toolName} result superseded — ${originalSize} chars omitted]`
- Exception: If a tool_use in between references the earlier tool_use_id, both are kept (still active chain)

### Mode

Auto-fix + warn. Silently fixes what it can, logs warnings for what it can't. Always forwards the request.

## Feature #4: Structured Tool Compression

### What changes

Current compression output (head+tail truncation):
```
<head of text>

... [1,234 chars compressed from Grep] ...

<tail of text>
```

New output adds a structured header before truncation:
```
[tool: Grep | matches: 5 | files: src/proxy.ts, src/types.ts]
> Pattern: "thinking"
---
<head/tail as current compressors produce>
```

### How it works

1. Before truncation, call `extractMeta(bucket, rawText, toolName)` to parse the raw tool result
2. Build a structured header from extracted metadata
3. Prepend header to the existing compressor output
4. Total output still respects `toolResultLimit` — header size is deducted from the truncation budget

### Per-bucket metadata extraction

| Bucket | Tools | Extracted metadata |
|--------|-------|--------------------|
| source | Read, read | File path, line range, total lines |
| logs | Bash, bash, shell-exec | Exit code, error count, total lines |
| structured | Grep, Glob, grep, glob, WebSearch, WebFetch, search, list | Match count, file list, unique patterns |
| default | Everything else | Char count, truncation note |

### Implementation

No new files. Extends existing compression in `src/proxy.ts`:

- New `META_EXTRACTORS` map: `Record<CompressionBucket, (text, toolName) => string>`
- `compressToolResults` modified to:
  1. Call `META_EXTRACTORS[bucket](text, toolName)` to get header
  2. Deduct header length from the `limit` passed to the compressor
  3. Prepend header to compressor output

### Header format

Plain text, not JSON — models read text naturally:

```
[tool: {name} | {key}: {value} | {key}: {value}]
> {line1 from raw text that looks like a key finding}
> {line2 from raw text that looks like a key finding}
---
{existing compressed output}
```

The `> Key:` lines are extracted from the raw text before compression — first non-blank, non-separator lines that look substantive (for source/structured buckets) or error lines (for logs bucket). Capped at 3 lines.

## Integration

### Pipeline order in `forwardRequest()`

```
1. Parse body
2. Context trim (maxContextMessages)
3. Context lint (orphan fix, dedup, stale detection)  ← NEW
4. Tool result compression (with structured headers)   ← ENHANCED
5. Adapter transform
6. Send upstream
```

### Config

No new config fields. Both features use existing config:
- `toolResultLimit` — per-provider, controls when compression triggers
- `maxContextMessages` — per-provider, controls when trimming triggers

Linter is always active. No toggle needed for v1 — checks are cheap (linear scans) and fixes are defensive. Can add `provider.enableContextLinting: boolean` later if needed.

### Existing code changes

- `cleanOrphanedToolMessages()` call in fallback path (chainIndex > 0) is **removed** — the linter handles orphan detection on every request now
- The `needsOrphanClean` flag and its branching logic in `applyTargetedReplacements` are **removed** entirely — the linter now handles orphan detection before `applyTargetedReplacements` is called, so the flag is dead code

## File changes

| File | Change |
|------|--------|
| `src/context-linter.ts` | **New** — `lintContext()` with 3 rules, exported types |
| `src/proxy.ts` | Call `lintContext()` after trim. Add `META_EXTRACTORS` + header prepending to compression. Remove orphan clean from fallback path |
| `tests/context-linter.test.ts` | **New** — unit tests for each lint rule |
| `tests/tool-compression.test.ts` | **New** — tests for structured headers |

## Testing

- Unit tests for each lint rule with crafted message arrays (orphan pairs, duplicate instructions, stale results)
- Unit tests for each metadata extractor with sample tool output
- Integration test: full pipeline (trim → lint → compress → adapter) verifying output structure
- Edge cases: empty messages, single message, all orphans, no tools, circular tool chains
