import { ApiError } from "../api/errors.js";

export class ClientAdmission {
  private readonly active = new Map<string, number>();
  acquire(id: string, maximum: number): () => void {
    const count = this.active.get(id) ?? 0;
    if (count >= maximum) throw new ApiError(429, "rate_limit_error", "client_concurrency_exceeded", "Client concurrency limit exceeded.", undefined, 1);
    this.active.set(id, count + 1);
    let released = false;
    return () => { if (!released) { released = true; const next = (this.active.get(id) ?? 1) - 1; next ? this.active.set(id, next) : this.active.delete(id); } };
  }
}

type Waiter = { resolve: (release: () => void) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; signal: AbortSignal; abort: () => void };
export class ModelQueue {
  private active = 0;
  private readonly waiting: Waiter[] = [];
  constructor(private readonly concurrency: number, private readonly maxDepth: number, private readonly waitMs: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active < this.concurrency) { this.active++; return Promise.resolve(this.releaseFn()); }
    if (this.waiting.length >= this.maxDepth) return Promise.reject(this.busy());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, timer: setTimeout(() => this.remove(waiter, this.busy()), this.waitMs), abort: () => this.remove(waiter, signal.reason) };
      this.waiting.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }
  get depth() { return this.waiting.length; }
  get occupancy() { return this.active; }
  private releaseFn() { let done = false; return () => { if (done) return; done = true; const waiter = this.waiting.shift(); if (waiter) { this.cleanup(waiter); waiter.resolve(this.releaseFn()); } else this.active--; }; }
  private cleanup(waiter: Waiter) { clearTimeout(waiter.timer); waiter.signal.removeEventListener("abort", waiter.abort); }
  private remove(waiter: Waiter, error: Error) { const index = this.waiting.indexOf(waiter); if (index >= 0) { this.waiting.splice(index, 1); this.cleanup(waiter); waiter.reject(error); } }
  private busy() { return new ApiError(429, "rate_limit_error", "model_busy", "Model queue is full or its wait timeout expired.", undefined, Math.max(1, Math.ceil(this.waiting.length + 1))); }
}
