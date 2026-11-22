import { open, mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MultipartFile } from "@fastify/multipart";
import { ApiError } from "../api/errors.js";

type Format = "wav" | "webm" | "ogg" | "mp4" | "mp3";
const MEDIA: Record<string, { extension: string; format: Format }> = {
  "audio/wav": { extension: ".wav", format: "wav" }, "audio/x-wav": { extension: ".wav", format: "wav" },
  "audio/webm": { extension: ".webm", format: "webm" }, "audio/ogg": { extension: ".ogg", format: "ogg" },
  "audio/mp4": { extension: ".mp4", format: "mp4" }, "video/mp4": { extension: ".mp4", format: "mp4" },
  "audio/m4a": { extension: ".m4a", format: "mp4" }, "audio/x-m4a": { extension: ".m4a", format: "mp4" },
  "audio/mpeg": { extension: ".mp3", format: "mp3" }, "audio/mp3": { extension: ".mp3", format: "mp3" },
};
export type StoredUpload = { path: string; output: string; format: Format; cleanup: () => Promise<void> };

export async function storeUpload(file: MultipartFile, options: { directory: string; maxBytes: number }, signal: AbortSignal): Promise<StoredUpload> {
  const media = MEDIA[file.mimetype];
  if (!media) throw new ApiError(415, "invalid_request_error", "unsupported_media_type", `Unsupported audio media type '${file.mimetype}'.`, "file");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const base = join(options.directory, randomUUID()); const input = base + media.extension; const output = base + ".normalized.wav";
  try {
    const handle = await open(input, "wx", 0o600); let bytes = 0;
    try { for await (const chunk of file.file) { if (signal.aborted) throw signal.reason; bytes += chunk.length; if (bytes > options.maxBytes) throw new ApiError(413, "invalid_request_error", "upload_too_large", "Audio upload exceeds the configured limit.", "file"); await handle.write(chunk); } } finally { await handle.close(); }
    const prefix = Buffer.alloc(16); const reader = await open(input, "r");
    try { await reader.read(prefix, 0, prefix.length, 0); } finally { await reader.close(); }
    if (!matchesContainer(prefix, media.format)) throw new ApiError(415, "invalid_request_error", "unsupported_media_type", "The file contents do not match the declared supported container.", "file");
    return { path: input, output, format: media.format, cleanup: () => Promise.all([rm(input, { force: true }), rm(output, { force: true })]).then(() => undefined) };
  } catch (error) { await Promise.all([rm(input, { force: true }), rm(output, { force: true })]); throw error; }
}

export async function normalizeUpload(upload: StoredUpload, options: { ffmpeg: string; prlimit: string; memoryBytes: number; timeoutMs: number; maxOutputBytes: number }, signal: AbortSignal) {
  signal.throwIfAborted();
  const ffmpegArgs = ["-nostdin", "-v", "error", "-threads", "1", "-y", "-i", upload.path, "-ac", "1", "-ar", "16000", "-fs", String(options.maxOutputBytes), "-f", "wav", upload.output];
  const child = spawn(options.prlimit, [`--as=${options.memoryBytes}`, "--", options.ffmpeg, ...ffmpegArgs], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.resume();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs); const abort = () => child.kill("SIGKILL"); signal.addEventListener("abort", abort, { once: true });
  let code: number | null;
  try { [code] = await once(child, "close") as [number | null]; }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  if (signal.aborted) throw signal.reason;
  if (timedOut) throw new ApiError(504, "server_error", "normalization_timeout", "Audio normalization timed out.");
  if (code !== 0) throw new ApiError(400, "invalid_request_error", "invalid_audio", "Audio could not be decoded.", "file");
  const outputBytes = (await stat(upload.output)).size;
  if (outputBytes >= options.maxOutputBytes) throw new ApiError(413, "invalid_request_error", "decoded_audio_too_large", "Decoded audio exceeds the configured limit.", "file");
  return { path: upload.output, durationSeconds: await normalizedWaveSamples(upload.output, outputBytes) / 16_000 };
}

/** ffmpeg writes optional RIFF chunks; file length minus 44 is not PCM duration. */
async function normalizedWaveSamples(path: string, size: number): Promise<number> {
  const invalidWave = () => new ApiError(400, "invalid_request_error", "invalid_audio", "Audio normalization did not produce a complete PCM WAV.", "file");
  const file = await open(path, "r"); const header = Buffer.alloc(16);
  try {
    if ((await file.read(header, 0, 12, 0)).bytesRead !== 12 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") throw invalidWave();
    let pcmBytes: number | undefined; let format = false; let offset = 12;
    for (let chunks = 0; offset + 8 <= size && chunks < 64; chunks++) {
      if ((await file.read(header, 0, 8, offset)).bytesRead !== 8) throw invalidWave();
      const tag = header.toString("ascii", 0, 4); const bytes = header.readUInt32LE(4);
      offset += 8;
      if (offset + bytes > size) throw invalidWave();
      if (tag === "fmt ") {
        if (bytes < 16 || (await file.read(header, 0, 16, offset)).bytesRead !== 16 || header.readUInt16LE(0) !== 1 || header.readUInt16LE(2) !== 1 || header.readUInt32LE(4) !== 16000 || header.readUInt16LE(14) !== 16) throw invalidWave();
        format = true;
      } else if (tag === "data") {
        if (pcmBytes !== undefined || bytes % 2) throw invalidWave();
        pcmBytes = bytes;
      }
      offset += bytes + bytes % 2;
    }
    if (!format || pcmBytes === undefined || offset !== size) throw invalidWave();
    return pcmBytes / 2;
  } finally { await file.close(); }
}

function matchesContainer(prefix: Buffer, format: Format) {
  if (format === "wav") return prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WAVE";
  if (format === "webm") return prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (format === "ogg") return prefix.subarray(0, 4).toString("ascii") === "OggS";
  if (format === "mp3") return prefix.subarray(0, 3).toString("ascii") === "ID3" || (prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0);
  return prefix.subarray(4, 8).toString("ascii") === "ftyp";
}
