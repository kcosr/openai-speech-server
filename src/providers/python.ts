import type { SpeechProvider, SpeechRequest, TranscriptRequest, TranscriptResult, TranscriptionProvider } from "./types.js";
import { WorkerSupervisor } from "./supervisor.js";
import { ApiError } from "../api/errors.js";

abstract class PythonProvider {
  private next = 0;
  private readonly reserved = new Set<WorkerSupervisor>();
  constructor(protected readonly supervisors: WorkerSupervisor[]) {}
  get ready() { return this.supervisors.every((worker) => worker.ready); }
  get state() { return this.ready ? "ready" : this.supervisors.map((worker) => worker.state).join(","); }
  get restartCount() { return this.supervisors.reduce((total, worker) => total + worker.restartCount, 0); }
  get inFlight() { return this.reserved.size; }
  start() { return Promise.all(this.supervisors.map((worker) => worker.start())).then(() => undefined); }
  stop() { return Promise.all(this.supervisors.map((worker) => worker.stop())).then(() => undefined); }
  protected worker() {
    for (let offset = 0; offset < this.supervisors.length; offset++) {
      const index = (this.next + offset) % this.supervisors.length; const worker = this.supervisors[index];
      if (worker?.ready && !worker.busy && !this.reserved.has(worker)) { this.next = index + 1; this.reserved.add(worker); return worker; }
    }
    throw new ApiError(503, "server_error", "model_unavailable", "No ready worker replica is available.", undefined, 1);
  }
  protected release(worker: WorkerSupervisor) { this.reserved.delete(worker); }
}

export class PythonTranscriptionProvider extends PythonProvider implements TranscriptionProvider {
  async transcribe(request: TranscriptRequest, signal: AbortSignal): Promise<TranscriptResult> {
    const worker = this.worker();
    try { const job = await worker.request({ task: "transcription", ...request }, signal); let result: TranscriptResult | undefined; for await (const message of job.messages()) if (message.type === "result") result = { text: String(message.text ?? ""), ...(message.language ? { language: String(message.language) } : {}) }; if (!result) { if (signal.aborted) throw signal.reason; throw new Error("Transcription worker returned no result"); } return result; }
    finally { this.release(worker); }
  }
}

export class PythonSpeechProvider extends PythonProvider implements SpeechProvider {
  async *synthesize(request: SpeechRequest, signal: AbortSignal): AsyncIterable<Buffer> {
    const worker = this.worker(); const job = await worker.request({ task: "speech", ...request }, signal).catch((error) => { this.release(worker); throw error; });
    let complete = false;
    try { for await (const message of job.messages()) { if (message.type === "chunk") yield Buffer.from(String(message.data), "base64"); if (message.type === "done") complete = true; } }
    finally { try { if (!complete) { job.cancel(); await job.done.catch(() => undefined); } } finally { this.release(worker); } }
  }
}
