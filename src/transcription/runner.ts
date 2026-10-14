import { Worker } from "node:worker_threads";
import { ApiError } from "../api/errors.js";
import type { Config } from "../config/schema.js";
import { MAX_TRANSCRIPT_BYTES, isWellFormedUnicode, type SubstitutionResult } from "./substitutions.js";

export const SUBSTITUTION_TIMEOUT_MS = 2000;
export const SUBSTITUTION_STARTUP_TIMEOUT_MS = 10_000;
export const MAX_PENDING_SUBSTITUTIONS = 8;
export const SUBSTITUTION_WORKER_OLD_MEMORY_MB = 128;
export const SUBSTITUTION_WORKER_YOUNG_MEMORY_MB = 16;

export type SubstitutionWorkerRequest = { id: number; text: string; selection: string };
export type SubstitutionWorkerResponse =
  | { type: "ready" }
  | { type: "startup_error" }
  | { type: "result"; id: number; result: SubstitutionResult }
  | { type: "error"; id: number; error: { status: number; type: string; code: string; message: string } };

type Job = {
  id: number;
  text: string;
  selection: string;
  deadline?: number;
  resolve: (result: SubstitutionResult) => void;
  reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  abort: () => void;
};
type WorkerState = {
  worker: Worker;
  ready: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

function failure(code: string, message: string, status = 500): ApiError {
  return new ApiError(status, "server_error", `transcription_substitution_${code}`, message);
}

const deadlineFailure = () => failure("work_limit", "The transcript exceeds the substitution processing deadline");

/** Runs correction away from the HTTP event loop, with enforceable deadlines. */
export class AsyncTranscriptSubstitutions {
  private readonly config: Config["transcription_substitutions"];
  private readonly pending: Job[] = [];
  private state: WorkerState | undefined;
  private active: Job | undefined;
  private terminating: Promise<void> | undefined;
  private stopped = false;
  private nextId = 0;

  constructor(config: Config["transcription_substitutions"]) {
    this.config = structuredClone(config);
  }

  async start(): Promise<void> {
    if (this.stopped) throw failure("unavailable", "Transcription substitutions have stopped", 503);
    if (!Object.values(this.config.rule_sets).some(rules => rules.length > 0)) return;
    if (this.terminating) await this.terminating;
    if (this.stopped) throw failure("unavailable", "Transcription substitutions have stopped", 503);
    if (this.state) return this.state.promise;

    const options = {
      workerData: this.config,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: SUBSTITUTION_WORKER_OLD_MEMORY_MB, maxYoungGenerationSizeMb: SUBSTITUTION_WORKER_YOUNG_MEMORY_MB, stackSizeMb: 4 },
    };
    let worker: Worker;
    try {
      if (import.meta.url.endsWith(".ts")) {
        // Source execution needs tsx explicitly; do not inherit Vitest loaders.
        const loader = import.meta.resolve("tsx/esm/api");
        const source = new URL("./worker.ts", import.meta.url).href;
        worker = new Worker(`import(${JSON.stringify(loader)}).then(({ tsImport }) => tsImport(${JSON.stringify(source)}, ${JSON.stringify(import.meta.url)}))`, { ...options, eval: true });
      } else {
        worker = new Worker(new URL("./worker.js", import.meta.url), options);
      }
    } catch {
      const error = failure("unavailable", "The transcription substitution worker could not start", 503);
      this.failPending(error);
      throw error;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const state: WorkerState = {
      worker, ready: false, promise, resolve, reject,
      timer: setTimeout(() => this.workerFailed(state), SUBSTITUTION_STARTUP_TIMEOUT_MS),
    };
    state.timer.unref();
    this.state = state;
    worker.on("message", (message: SubstitutionWorkerResponse) => this.receive(state, message));
    worker.on("error", () => this.workerFailed(state));
    worker.on("exit", () => this.workerFailed(state));
    return promise;
  }

  async apply(text: string, selection?: string | null, signal?: AbortSignal): Promise<SubstitutionResult> {
    signal?.throwIfAborted();
    if (this.stopped) throw failure("unavailable", "Transcription substitutions have stopped", 503);
    const ruleSet = selection === undefined ? this.config.default_rule_set : selection;
    if (ruleSet === null) return { text, ruleSet, matches: [] };
    if (!Object.hasOwn(this.config.rule_sets, ruleSet)) throw failure("configuration", "The selected transcription substitution rule set is unavailable");
    if (this.config.rule_sets[ruleSet]!.length === 0) return { text, ruleSet, matches: [] };
    // Reject oversized input before copying it into the worker message queue.
    if (Buffer.byteLength(text, "utf8") > MAX_TRANSCRIPT_BYTES) throw failure("input_limit", "The transcript exceeds the substitution input limit");
    if (!isWellFormedUnicode(text)) throw failure("invalid_unicode", "The transcript contains malformed Unicode");
    if (this.pending.length >= MAX_PENDING_SUBSTITUTIONS) throw failure("busy", "The transcription substitution queue is full", 503);

    return new Promise<SubstitutionResult>((resolve, reject) => {
      const job: Job = {
        id: ++this.nextId, text, selection: ruleSet, resolve, reject, signal,
        abort: () => this.cancel(job, signal!.reason),
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.pending.push(job);
      this.drain();
      void this.start().then(() => this.drain(), () => { /* start failures already settle pending jobs */ });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const error = failure("unavailable", "Transcription substitutions have stopped", 503);
    this.failPending(error);
    const active = this.active;
    this.active = undefined;
    if (active) this.cleanup(active);
    if (this.state) this.discard(this.state, error);
    await this.terminating;
    active?.reject(error);
  }

  private receive(state: WorkerState, message: SubstitutionWorkerResponse): void {
    if (this.state !== state) return;
    if (message.type === "startup_error") { this.workerFailed(state); return; }
    if (message.type === "ready") {
      clearTimeout(state.timer);
      state.ready = true;
      state.resolve();
      this.drain();
      return;
    }
    const job = this.active;
    if (!job || message.id !== job.id) { this.workerFailed(state); return; }
    this.active = undefined;
    if (performance.now() >= job.deadline!) {
      // The worker has already finished. Reject the late result without killing
      // an idle thread or delaying unrelated requests behind another warmup.
      this.finish(job, deadlineFailure());
    } else if (message.type === "result") {
      this.cleanup(job);
      job.resolve(message.result);
    } else {
      const { status, type, code, message: description } = message.error;
      this.finish(job, new ApiError(status, type, code, description));
    }
    this.drain();
  }

  private drain(): void {
    const state = this.state;
    if (this.stopped || !state?.ready || this.active) return;
    const job = this.pending.shift();
    if (!job) { state.worker.unref(); return; }
    this.active = job;
    // FIFO waiting does not spend another caller's execution budget. Waiting
    // remains bounded by queue capacity, startup limits, and caller cancellation.
    job.deadline = performance.now() + SUBSTITUTION_TIMEOUT_MS;
    job.timer = setTimeout(() => this.cancel(job, deadlineFailure()), SUBSTITUTION_TIMEOUT_MS);
    state.worker.ref();
    state.worker.postMessage({ id: job.id, text: job.text, selection: job.selection } satisfies SubstitutionWorkerRequest);
  }

  private cancel(job: Job, error: unknown): void {
    if (this.active === job) {
      this.active = undefined;
      this.cleanup(job);
      const terminated = this.state ? this.discard(this.state, error) : this.terminating ?? Promise.resolve();
      // Keep the caller's admission/queue lease until the active thread is gone.
      void terminated.then(() => job.reject(error));
    } else {
      const index = this.pending.indexOf(job);
      if (index === -1) return;
      this.pending.splice(index, 1);
      this.finish(job, error);
    }
  }

  private workerFailed(state: WorkerState): void {
    if (this.state !== state) return;
    const error = failure("unavailable", "The transcription substitution worker failed", 503);
    const active = this.active;
    this.active = undefined;
    if (active) this.cleanup(active);
    if (!state.ready) this.failPending(error);
    const terminated = this.discard(state, error);
    if (active) void terminated.then(() => active.reject(error));
  }

  private discard(state: WorkerState, error: unknown): Promise<void> {
    if (this.state !== state) return this.terminating ?? Promise.resolve();
    this.state = undefined;
    clearTimeout(state.timer);
    state.reject(error);
    const terminating = state.worker.terminate().then(() => undefined);
    this.terminating = terminating;
    void terminating.finally(() => {
      if (this.terminating === terminating) this.terminating = undefined;
      if (!this.stopped && this.pending.length > 0) void this.start().then(() => this.drain(), () => {});
    });
    return terminating;
  }

  private failPending(error: unknown): void {
    for (const job of this.pending.splice(0)) this.finish(job, error);
  }

  private cleanup(job: Job): void {
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort);
  }

  private finish(job: Job, error: unknown): void {
    this.cleanup(job);
    job.reject(error);
  }
}
