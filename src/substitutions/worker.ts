import { parentPort, workerData } from "node:worker_threads";
import { ApiError } from "../api/errors.js";
import { TextSubstitutions, substitutionFailure, type SubstitutionConfig, type SubstitutionTask } from "./substitutions.js";
import type { SubstitutionWorkerRequest, SubstitutionWorkerResponse } from "./runner.js";

if (!parentPort) throw new Error("Substitution worker requires a parent port");
const port = parentPort;
const send = (message: SubstitutionWorkerResponse) => port.postMessage(message);
const { config, task } = workerData as { config: SubstitutionConfig; task: SubstitutionTask };

try {
  const substitutions = new TextSubstitutions(config, task);
  port.on("message", (request: SubstitutionWorkerRequest) => {
    try {
      send({ type: "result", id: request.id, result: substitutions.apply(request.text, request.selection) });
    } catch (error) {
      const safe = error instanceof ApiError ? error : substitutionFailure(task, "failed", `${task === "transcription" ? "Transcription" : "Speech"} substitutions failed`);
      send({ type: "error", id: request.id, error: { status: safe.status, type: safe.type, code: safe.code, message: safe.message } });
    }
  });
  send({ type: "ready" });
} catch {
  send({ type: "startup_error" });
}
