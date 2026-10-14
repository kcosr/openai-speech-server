import { parentPort, workerData } from "node:worker_threads";
import { ApiError } from "../api/errors.js";
import type { Config } from "../config/schema.js";
import { TranscriptSubstitutions } from "./substitutions.js";
import type { SubstitutionWorkerRequest, SubstitutionWorkerResponse } from "./runner.js";

if (!parentPort) throw new Error("Transcription substitution worker requires a parent port");
const port = parentPort;
const send = (message: SubstitutionWorkerResponse) => port.postMessage(message);

try {
  const substitutions = new TranscriptSubstitutions(workerData as Config["transcription_substitutions"]);
  port.on("message", (request: SubstitutionWorkerRequest) => {
    try {
      send({ type: "result", id: request.id, result: substitutions.apply(request.text, request.selection) });
    } catch (error) {
      const safe = error instanceof ApiError ? error : new ApiError(500, "server_error", "transcription_substitution_failed", "Transcription substitutions failed");
      send({ type: "error", id: request.id, error: { status: safe.status, type: safe.type, code: safe.code, message: safe.message } });
    }
  });
  send({ type: "ready" });
} catch {
  send({ type: "startup_error" });
}
