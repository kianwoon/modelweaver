#!/usr/bin/env node
import { Readable } from 'node:stream';

// Use tsx to run source directly
const mod = await import('tsx/esm/register');
const { createOpenAIChatToAnthropicStream } = await import('./src/adapters/openai-utils.ts');

// Simulate a real OpenAI SSE response
const mockOpenAIResponse = `data: {"id":"test123","created":1234567890,"object":"chat.completion.chunk","model":"glm-5-turbo","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}

data: {"id":"test123","created":1234567890,"object":"chat.completion.chunk","model":"glm-5-turbo","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"test123","created":1234567890,"object":"chat.completion.chunk","model":"glm-5-turbo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

`;

console.error('=== Output (Anthropic SSE) ===');

const input = Readable.from([mockOpenAIResponse]);
const transformer = createOpenAIChatToAnthropicStream();

let outputChunks = [];
transformer.on('data', (chunk) => {
  outputChunks.push(chunk.toString());
  process.stdout.write(chunk);
});

transformer.on('end', () => {
  console.error('\n=== Transform complete ===');
  console.error(`Total output chunks: ${outputChunks.length}`);
  console.error(`Total bytes: ${outputChunks.join('').length}`);
});
