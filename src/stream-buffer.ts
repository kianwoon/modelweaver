export interface SSEBufferOptions {
  bufferBytes: number;  // 0 = disabled
  bufferMs: number;      // 0 = disabled
  /** Hard cap — force-flush regardless of boundary when exceeded. Defaults to 1MB. */
  maxBufferBytes?: number;
}

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024; // 1MB

export class SSEBuffer {
  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxBytes: number;

  constructor(
    private enqueue: (chunk: Uint8Array) => void,
    private opts: SSEBufferOptions,
  ) {
    this.maxBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  }

  private scheduleTimer(): void {
    if (!this.opts.bufferMs) return;
    // Clear and reschedule — tracks "idle time since last write"
    this.resetTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushAll();
    }, this.opts.bufferMs);
  }

  private resetTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private flushAtBoundary(): void {
    // Passthrough mode — no buffering
    if (!this.opts.bufferBytes && !this.opts.bufferMs) {
      for (const chunk of this.chunks) {
        this.enqueue(chunk);
      }
      this.chunks = [];
      this.byteLength = 0;
      return;
    }

    if (this.chunks.length === 0) return;

    // Concatenate all chunks into a single buffer for boundary scanning
    const combined = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    if (this.opts.bufferBytes && this.byteLength >= this.opts.bufferBytes) {
      // Size threshold met — find last safe boundary before or at threshold
      let boundary = -1;
      const scanLimit = Math.min(this.byteLength - 1, this.opts.bufferBytes);
      for (let i = scanLimit - 2; i >= 0; i--) {
        if (combined[i] === 0x0A && combined[i + 1] === 0x0A) {
          boundary = i + 2;
          break;
        }
      }

      if (boundary > 0) {
        // Flush up to boundary, keep remainder
        this.enqueue(combined.subarray(0, boundary));
        const remainder = combined.subarray(boundary);
        this.chunks = [remainder];
        this.byteLength = remainder.length;
        this.scheduleTimer();
        return;
      }
      // Size threshold met but no boundary — check hard cap before holding
      if (this.byteLength >= this.maxBytes) {
        this.flushAll();
        return;
      }
      // Below hard cap — hold until next write or timer
      return;
    }
  }

  write(data: Uint8Array): void {
    // Passthrough mode
    if (!this.opts.bufferBytes && !this.opts.bufferMs) {
      this.enqueue(data);
      return;
    }

    this.chunks.push(data);
    this.byteLength += data.length;
    this.scheduleTimer();

    if (this.opts.bufferBytes && this.byteLength >= this.opts.bufferBytes) {
      this.flushAtBoundary();
    }
  }

  flush(): void {
    // Called by timer — flush everything regardless of boundaries
    this.flushAll();
  }

  private flushAll(): void {
    if (this.chunks.length === 0) return;
    this.resetTimer();
    const combined = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.enqueue(combined);
    this.chunks = [];
    this.byteLength = 0;
  }

  end(): void {
    // Clear timer FIRST — prevents a stale timer from firing after end()
    // and enqueueing to an already-closed ReadableStream controller.
    this.resetTimer();
    // Flush everything — no boundary check on stream end
    this.flushAll();
  }
}
