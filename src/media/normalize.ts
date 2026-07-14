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
  const ffmpegArgs = ["-nostdin", "-v", "error", "-threads", "1", "-y", "-i", upload.path, "-ac", "1", "-ar", "16000", "-fs", String(options.maxOutputBytes), "-f", "wav", upload.output];
  const child = spawn(options.prlimit, [`--as=${options.memoryBytes}`, "--", options.ffmpeg, ...ffmpegArgs], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { if (stderr.length < 8192) stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs); const abort = () => child.kill("SIGKILL"); signal.addEventListener("abort", abort, { once: true });
  const [code] = await once(child, "exit") as [number | null]; clearTimeout(timer); signal.removeEventListener("abort", abort);
  if (signal.aborted) throw signal.reason;
  if (code !== 0) throw new ApiError(400, "invalid_request_error", "invalid_audio", "Audio could not be decoded.", "file");
  const outputBytes = (await stat(upload.output)).size;
  if (outputBytes >= options.maxOutputBytes) throw new ApiError(413, "invalid_request_error", "decoded_audio_too_large", "Decoded audio exceeds the configured limit.", "file");
  return { path: upload.output, durationSeconds: Math.max(0, outputBytes - 44) / 32_000 };
}

function matchesContainer(prefix: Buffer, format: Format) {
  if (format === "wav") return prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WAVE";
  if (format === "webm") return prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (format === "ogg") return prefix.subarray(0, 4).toString("ascii") === "OggS";
  if (format === "mp3") return prefix.subarray(0, 3).toString("ascii") === "ID3" || (prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0);
  return prefix.subarray(4, 8).toString("ascii") === "ftyp";
}
