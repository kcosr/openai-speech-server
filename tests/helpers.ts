import { ConfigSchema, type Config } from "../src/config/schema.js";
import { hashToken } from "../src/auth/auth.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const TOKEN = "test-secret";
export async function testConfig(serverOverrides: Record<string, unknown> = {}, maxConcurrentRequests = 2): Promise<Config> {
  const directory = await mkdtemp(join(tmpdir(), "openai-speech-server-test-"));
  const tokens = join(directory, "tokens.json");
  await writeFile(tokens, JSON.stringify({ tokens: { test: hashToken(TOKEN) } }), { mode: 0o600 });
  return ConfigSchema.parse({
    server: { listen: "127.0.0.1:0", temp_directory: directory, ffmpeg: "/usr/bin/ffmpeg", request_timeout_seconds: 5, stream_idle_timeout_seconds: 2, ...serverOverrides },
    auth: { tokens_file: tokens },
    models: [
      { id: "parakeet-local", task: "transcription", provider: "parakeet", default: true, provider_config: { python: process.env.PYTHON ?? "python3", command: resolve("tests/fixtures/fake_worker.py") } },
      { id: "kokoro-local", task: "speech", provider: "kokoro", default: true, default_voice: "af_heart", voices: ["af_heart", "af_sky"], output_formats: ["pcm", "wav"], provider_config: { python: process.env.PYTHON ?? "python3", command: resolve("tests/fixtures/fake_worker.py") } },
    ],
    clients: [{ id: "test", token_ref: "test", allowed_models: ["parakeet-local", "kokoro-local"], max_concurrent_requests: maxConcurrentRequests }],
  });
}

export function wav(): Buffer {
  const data = Buffer.alloc(3200); const result = Buffer.alloc(44 + data.length);
  result.write("RIFF", 0); result.writeUInt32LE(36 + data.length, 4); result.write("WAVEfmt ", 8); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write("data", 36); result.writeUInt32LE(data.length, 40); data.copy(result, 44); return result;
}

export function multipart(fields: Record<string, string>, file: Buffer, fileFirst = false, mediaType = "audio/wav", filename = "test.wav") {
  const boundary = "openai-speech-server-boundary"; const chunks: Buffer[] = [];
  const fileChunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`), file, Buffer.from("\r\n")];
  if (fileFirst) chunks.push(...fileChunks);
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  if (!fileFirst) chunks.push(...fileChunks);
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
