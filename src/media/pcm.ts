import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { StoredUpload } from "./normalize.js";

export const REALTIME_SAMPLE_RATE = 24_000;
export const REALTIME_BYTES_PER_SECOND = REALTIME_SAMPLE_RATE * 2;

/** Stage mono s16le PCM as WAV so the existing bounded ffmpeg normalizer can resample it. */
export async function storeRealtimePcm(pcm: Buffer, directory: string, signal: AbortSignal): Promise<StoredUpload> {
  signal.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.wav`);
  const output = path.replace(/\.wav$/, ".normalized.wav");
  const cleanup = () => Promise.all([rm(path, { force: true }), rm(output, { force: true })]).then(() => undefined);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(REALTIME_SAMPLE_RATE, 24); header.writeUInt32LE(REALTIME_BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  try {
    await writeFile(path, Buffer.concat([header, pcm]), { flag: "wx", mode: 0o600, signal });
    signal.throwIfAborted();
    return { path, output, format: "wav", cleanup };
  } catch (error) { await cleanup(); throw error; }
}
