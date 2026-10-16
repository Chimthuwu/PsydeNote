export interface Peak {
  min: number;
  max: number;
}

export class PeakBuffer {
  private buffer: Float32Array;
  private head = 0;
  private count = 0;
  private capacity: number;

  constructor(maxSeconds: number, bucketMs: number = 20) {
    this.capacity = Math.ceil((maxSeconds * 1000) / bucketMs) * 2; // *2 because min and max
    this.buffer = new Float32Array(this.capacity);
  }

  push(min: number, max: number) {
    this.buffer[this.head] = min;
    this.buffer[this.head + 1] = max;
    this.head = (this.head + 2) % this.capacity;
    if (this.count < this.capacity / 2) {
      this.count++;
    }
  }

  clear() {
    this.head = 0;
    this.count = 0;
  }

  /**
   * Returns a copy of the peaks in chronological order.
   * Each pair is [min, max].
   */
  getPeaks(): Peak[] {
    const peaks: Peak[] = [];
    const numPairs = this.count;
    if (numPairs === 0) return peaks;

    // If we haven't wrapped, just read from 0 to head
    if (this.count < this.capacity / 2) {
      for (let i = 0; i < this.head; i += 2) {
        peaks.push({ min: this.buffer[i], max: this.buffer[i + 1] });
      }
    } else {
      // If we wrapped, read from head to end, then 0 to head
      for (let i = this.head; i < this.capacity; i += 2) {
        peaks.push({ min: this.buffer[i], max: this.buffer[i + 1] });
      }
      for (let i = 0; i < this.head; i += 2) {
        peaks.push({ min: this.buffer[i], max: this.buffer[i + 1] });
      }
    }
    return peaks;
  }

  getState(): { buffer: Float32Array; head: number; count: number; capacity: number } {
    return { buffer: this.buffer, head: this.head, count: this.count, capacity: this.capacity };
  }

  setState(state: { buffer: Float32Array; head: number; count: number; capacity: number }) {
    this.buffer = state.buffer;
    this.head = state.head;
    this.count = state.count;
    this.capacity = state.capacity;
  }

  /**
   * More efficient: returns a contiguous Float32Array of [min, max, min, max...]
   * useful for fast drawing.
   */
  getFloat32Array(): Float32Array {
    const out = new Float32Array(this.count * 2);
    if (this.count === 0) return out;

    if (this.count < this.capacity / 2) {
      out.set(this.buffer.subarray(0, this.head));
    } else {
      out.set(this.buffer.subarray(this.head, this.capacity), 0);
      out.set(this.buffer.subarray(0, this.head), this.capacity - this.head);
    }
    return out;
  }

  getCount(): number {
    return this.count;
  }
}
