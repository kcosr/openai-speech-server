import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";

type WorkerMessage = { v: 1; id?: string; type: string; [key: string]: unknown };
type Pending = { emitter: EventEmitter; reject: (error: Error) => void };
const MAX_BUFFERED_MESSAGE_BYTES = 1_048_576;
const RESUME_BUFFERED_MESSAGE_BYTES = 524_288;

export class WorkerSupervisor {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private stopping = false;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, Pending>();
  state = "stopped";
  restartCount = 0;

  constructor(private readonly executable: string, private readonly args: string[], private readonly cancelGraceMs: number, private readonly warmupTimeoutMs: number, private readonly init: Record<string, unknown>) {}
  get ready() { return this.state === "ready"; }
  get busy() { return this.pending.size > 0; }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = this.spawnWorker().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async spawnWorker(): Promise<void> {
    this.state = "warming";
    const child = spawn(this.executable, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr.on("data", (chunk) => process.stderr.write(`[worker] ${chunk}`));
    child.on("error", (error) => this.onProcessError(child, error));
    child.stdin.on("error", (error) => { if (this.child === child) this.crash(error); });
    child.once("exit", (code, signal) => this.onExit(child, code, signal));
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    try {
      const ready = new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { clearTimeout(timer); this.events.off("message", onMessage); child.off("error", onError); child.off("exit", onWarmupExit); error ? reject(error) : resolve(); };
        const onMessage = (message: WorkerMessage) => { if (message.type === "ready") finish(); else if (message.type === "error" && !message.id) finish(new Error(String(message.message ?? "Worker initialization failed"))); };
        const onError = (error: Error) => finish(error);
        const onWarmupExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`Worker exited during warmup (${code ?? signal})`));
        const timer = setTimeout(() => finish(new Error("Worker warmup timed out")), this.warmupTimeoutMs);
        this.events.on("message", onMessage); child.once("error", onError); child.once("exit", onWarmupExit);
      });
      this.write({ v: 1, type: "init", ...this.init });
      await ready;
      this.failures = 0;
      this.state = "ready";
    } catch (error) {
      if (this.child === child) child.kill("SIGKILL");
      this.state = "failed";
      this.scheduleRestart();
      throw error;
    }
  }

  private readonly events = new EventEmitter();
  private onLine(line: string) {
    let message: WorkerMessage;
    try { message = JSON.parse(line) as WorkerMessage; if (message.v !== 1 || typeof message.type !== "string") throw new Error("invalid envelope"); }
    catch { this.crash(new Error("Malformed worker protocol output")); return; }
    this.events.emit("message", message);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (pending) pending.emitter.emit("message", message);
  }

  async request(payload: Record<string, unknown>, signal: AbortSignal): Promise<WorkerRequest> {
    await this.start();
    if (signal.aborted) throw signal.reason;
    if (!this.child || !this.ready) throw new Error("Worker is not ready");
    const child = this.child;
    const id = randomUUID();
    const emitter = new EventEmitter();
    const request = new WorkerRequest(
      id,
      emitter,
      () => this.pending.delete(id),
      (message) => this.write(message),
      () => child.stdout.pause(),
      () => child.stdout.resume(),
    );
    this.pending.set(id, { emitter, reject: (error) => emitter.emit("error", error) });
    const cancel = () => {
      try { this.write({ v: 1, id, type: "cancel" }); } catch { /* Worker exit already fails the request. */ }
      setTimeout(() => { if (this.pending.has(id)) this.child?.kill("SIGKILL"); }, this.cancelGraceMs).unref();
    };
    signal.addEventListener("abort", cancel, { once: true });
    request.done.finally(() => signal.removeEventListener("abort", cancel)).catch(() => undefined);
    try { this.write({ v: 1, id, type: "request", ...payload }); }
    catch (error) { signal.removeEventListener("abort", cancel); this.pending.delete(id); throw error; }
    return request;
  }

  private write(message: WorkerMessage) { if (!this.child?.stdin.writable) throw new Error("Worker stdin unavailable"); this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  private crash(error: Error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.child?.kill("SIGKILL"); }
  private onProcessError(child: ChildProcessWithoutNullStreams, error: Error) {
    if (this.child !== child) return;
    this.crash(error);
    this.child = undefined;
    this.state = this.stopping ? "stopped" : "failed";
    this.scheduleRestart();
  }
  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null) {
    if (this.child !== child) return;
    this.child = undefined;
    this.state = this.stopping ? "stopped" : "failed";
    this.crash(new Error(`Worker exited (${code ?? signal})`));
    this.scheduleRestart();
  }
  private scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    const delay = Math.min(30_000, 500 * 2 ** this.failures++); this.restartCount++;
    this.restartTimer = setTimeout(() => { this.restartTimer = undefined; if (!this.stopping) void this.start().catch(() => undefined); }, delay);
    this.restartTimer.unref();
  }
  async stop() {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    const child = this.child;
    if (!child) { this.state = "stopped"; return; }
    try { this.write({ v: 1, type: "shutdown" }); } catch { /* The exit path completes shutdown. */ }
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (this.child) child.kill("SIGKILL");
    this.state = "stopped";
  }
}

export class WorkerRequest {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  private readonly queue: Array<{ message: WorkerMessage; bytes: number }> = [];
  private bufferedBytes = 0;
  private paused = false;
  private wake: (() => void) | undefined;
  private finished = false;
  private abandoned = false;
  private failure: Error | undefined;
  constructor(readonly id: string, readonly emitter: EventEmitter, private readonly cleanup: () => void, private readonly send: (message: WorkerMessage) => void, private readonly pause: () => void, private readonly resume: () => void) {
    this.done = new Promise<void>((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    emitter.on("message", (message: WorkerMessage) => {
      if (!this.abandoned) {
        const bytes = Buffer.byteLength(JSON.stringify(message));
        this.queue.push({ message, bytes }); this.bufferedBytes += bytes;
        if (!this.paused && this.bufferedBytes >= MAX_BUFFERED_MESSAGE_BYTES) { this.paused = true; this.pause(); }
        this.wake?.();
      }
      if (message.type === "done" || message.type === "cancelled") { this.cleanup(); this.resolveDone(); }
      if (message.type === "error") { this.cleanup(); this.rejectDone(new Error(String(message.message ?? "Worker error"))); }
    });
    emitter.once("error", (error) => { this.cleanup(); this.rejectDone(error); });
    this.done.then(() => { this.finished = true; this.wake?.(); }, (error: Error) => { this.failure = error; this.finished = true; this.wake?.(); });
  }
  messages(): AsyncIterable<WorkerMessage> {
    const self = this;
    return { async *[Symbol.asyncIterator]() {
      try {
        while (!self.finished || self.queue.length) {
          if (!self.queue.length) await new Promise<void>((resolve) => { self.wake = resolve; });
          self.wake = undefined;
          while (self.queue.length) {
            const entry = self.queue.shift()!; self.bufferedBytes -= entry.bytes;
            if (self.paused && self.bufferedBytes <= RESUME_BUFFERED_MESSAGE_BYTES) { self.paused = false; self.resume(); }
            yield entry.message;
          }
        }
        if (self.failure) throw self.failure;
      } finally {
        self.abandoned = true;
        self.queue.length = 0; self.bufferedBytes = 0;
        if (self.paused) { self.paused = false; self.resume(); }
      }
    }};
  }
  cancel() { try { this.send({ v: 1, id: this.id, type: "cancel" }); } catch { /* A dead worker has already cancelled the request. */ } }
}
