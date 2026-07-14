import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ApiError } from "../src/api/errors.js";
import { PythonTranscriptionProvider } from "../src/providers/python.js";
import { WorkerSupervisor } from "../src/providers/supervisor.js";

const supervisors: WorkerSupervisor[] = [];
afterEach(async () => { await Promise.all(supervisors.splice(0).map((item) => item.stop())); });

describe("provider adapters", () => {
  it("preserves the abort reason when transcription is cancelled", async () => {
    const supervisor = new WorkerSupervisor("python3", [resolve("tests/fixtures/fake_worker.py")], 500, 1000, { model_id: "test", task: "transcription", provider: "fake", device: "cpu", options: {} });
    supervisors.push(supervisor);
    const provider = new PythonTranscriptionProvider([supervisor]);
    await provider.start();
    const controller = new AbortController();
    const reason = new ApiError(504, "server_error", "request_timeout", "Request processing timed out.");
    const pending = provider.transcribe({ path: "/tmp/test.wav", language: "slow" }, controller.signal);
    setTimeout(() => controller.abort(reason), 20);
    await expect(pending).rejects.toBe(reason);
  });
});
