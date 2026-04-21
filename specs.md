The clean way is to put a translation shim between the OpenAI-style backend and the Anthropic-style frontend that Claude Code expects.

At a high level:

Claude Code side wants Anthropic Messages semantics: assistant output arrives as content blocks like text and tool_use, and tool returns go back in as tool_result content blocks. Anthropic’s streaming docs show assistant output as content_block_start / content_block_delta, with tool use emitted as a tool_use block containing id, name, and input.
OpenAI-style backends usually return Chat Completions semantics: assistant text in choices[0].message.content, and tool calls in choices[0].message.tool_calls, where each call has an id, type: "function", function.name, and function.arguments as a JSON string.

So the adapter’s job is simple:

1) OpenAI request in, Anthropic request out

When Claude Code sends a request in Anthropic format, convert it before calling the OpenAI-style backend.

Anthropic-style input
{
  "model": "claude-opus-4-7",
  "messages": [
    {
      "role": "user",
      "content": "Fix this function."
    }
  ],
  "tools": [
    {
      "name": "read_file",
      "description": "Read a file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": { "type": "string" }
        },
        "required": ["path"]
      }
    }
  ]
}
Convert to OpenAI-style request
{
  "model": "glm-5.1",
  "messages": [
    {
      "role": "system",
      "content": "You are Claude Code-compatible. Use tools when needed."
    },
    {
      "role": "user",
      "content": "Fix this function."
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a file",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          },
          "required": ["path"]
        }
      }
    }
  ]
}

That mapping is valid because Anthropic tools use name, description, and input_schema, while OpenAI tool definitions use type: "function" plus function.parameters.

2) OpenAI response in, Anthropic response out

This is the part you asked for.

If OpenAI returns normal text

OpenAI-style:

{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Here is the fix..."
      },
      "finish_reason": "stop"
    }
  ]
}

Return to Claude Code as Anthropic-style:

{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "Here is the fix..."
    }
  ],
  "stop_reason": "end_turn"
}

That matches Anthropic’s content-block model, where text is a type: "text" block.

If OpenAI returns a tool call

OpenAI-style:

{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_123",
            "type": "function",
            "function": {
              "name": "read_file",
              "arguments": "{\"path\":\"main.py\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}

Return to Claude Code as Anthropic-style:

{
  "role": "assistant",
  "content": [
    {
      "type": "tool_use",
      "id": "call_123",
      "name": "read_file",
      "input": {
        "path": "main.py"
      }
    }
  ],
  "stop_reason": "tool_use"
}

That mapping is the core one. OpenAI exposes tool calls under tool_calls, and Anthropic expresses the same intent as a tool_use content block.

3) Tool result mapping back into the next turn

After Claude Code executes the tool, it will want to continue the conversation with a tool result.

Anthropic expects tool outputs as tool_result content blocks in the next user turn; Anthropic’s docs explicitly mention tool_use blocks in requests and responses and tool_result blocks in requests.

Anthropic-style tool result
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "call_123",
      "content": "def foo():\n    pass\n"
    }
  ]
}

Convert that to OpenAI-style tool message:

{
  "role": "tool",
  "tool_call_id": "call_123",
  "content": "def foo():\n    pass\n"
}

OpenAI Chat Completions supports role: "tool" messages, and tool messages may carry string content or text content parts.

4) The exact field map

Use this map and you’ll stay sane:

OpenAI-style	Anthropic-style
message.content: "text"	content: [{type:"text", text:"text"}]
message.tool_calls[i].id	content[j].id on tool_use
message.tool_calls[i].function.name	content[j].name on tool_use
JSON.parse(message.tool_calls[i].function.arguments)	content[j].input on tool_use
finish_reason: "tool_calls"	stop_reason: "tool_use"
role: "tool", tool_call_id, content	role: "user", content:[{type:"tool_result", tool_use_id, content}]

That is the harmonization layer.

5) Streaming mapping

If you want Claude Code to behave nicely, stream in Anthropic event shape, not raw OpenAI chunks.

Anthropic streaming uses events like:

message_start
content_block_start
content_block_delta
content_block_stop
message_delta
message_stop

So if your OpenAI backend streams deltas, buffer them and re-emit Anthropic-shaped events.

For plain text:

first text token → emit content_block_start with {type:"text", text:""}
each delta token → emit content_block_delta with {type:"text_delta", text:"..."}
at end → emit content_block_stop
then message_delta with stop_reason:"end_turn"
then message_stop

For tool calls:

when OpenAI starts a function call, emit Anthropic content_block_start with type:"tool_use"
stream arguments as input_json_delta
end with message_delta.stop_reason = "tool_use"

That is the closest behavioral match for Claude Code.

6) What usually breaks

Been there. These are the usual footguns.

First, don’t forward OpenAI content arrays blindly. OpenAI supports richer content parts, but many “OpenAI-compatible” vendors only partially implement them. Anthropic also uses its own content-block types. Normalize everything internally to:

text
tool_use
tool_result
maybe image/document later

Second, parse tool arguments safely. OpenAI documents that tool arguments are returned as a JSON string and may not always be valid JSON. Validate before turning them into Anthropic input.

Third, don’t try to preserve hidden reasoning verbatim. Anthropic streaming has special thinking modes, and OpenAI has its own reasoning products, but these are not wire-compatible. For a Claude Code shim, translate only the visible text/tool behavior unless you are deliberately emulating thinking blocks.

7) The simplest adapter algorithm
1. Receive Anthropic-style request from Claude Code
2. Convert messages/tools to OpenAI-style
3. Call OpenAI-compatible backend
4. If response has assistant text:
   -> emit Anthropic assistant text block
5. If response has tool_calls:
   -> emit Anthropic tool_use block(s)
6. Receive tool results from Claude Code
7. Convert tool_result to OpenAI role=tool message
8. Continue loop
8) My blunt recommendation

Use an internal canonical model instead of translating directly back and forth everywhere.

Something like:

{
  "role": "assistant",
  "segments": [
    { "kind": "text", "text": "..." },
    { "kind": "tool_call", "id": "call_123", "name": "read_file", "input": { "path": "main.py" } }
  ],
  "stop_reason": "tool_use"
}

Then write:

Anthropic encoder/decoder
OpenAI encoder/decoder

That avoids turning your proxy into spaghetti.