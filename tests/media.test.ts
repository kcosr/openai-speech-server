import { describe, expect, it } from "vitest";
import { readFile, readdir, rm } from "node:fs/promises";
import { storeRealtimePcm } from "../src/media/pcm.js";
import { normalizeUpload } from "../src/media/normalize.js";
import { testConfig } from "./helpers.js";
import { execFileSync } from "node:child_process";
import { OggOpusValidator, storeRealtimeOgg } from "../src/media/ogg-opus.js";

describe("Realtime PCM normalization", () => {
  it("preserves duration and speech-band samples when resampling 24 kHz PCM to the 16 kHz worker WAV", async () => {
    const { server } = await testConfig(); const signal = new AbortController().signal;
    const pcm = Buffer.alloc(9600);
    for (let sample = 0; sample < pcm.length / 2; sample++) pcm.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 1000 * sample / 24000)), sample * 2);
    const upload = await storeRealtimePcm(pcm, server.temp_directory, signal);
    try {
      const input = await readFile(upload.path); expect(input.readUInt32LE(24)).toBe(24000); expect(input.subarray(44)).toEqual(pcm);
      const normalized = await normalizeUpload(upload, { ffmpeg: server.ffmpeg, prlimit: server.prlimit, memoryBytes: server.ffmpeg_memory_bytes, timeoutMs: 5000, maxOutputBytes: server.max_upload_bytes }, signal);
      expect(normalized.durationSeconds).toBe(0.2);
      const wav = await readFile(upload.output); let output: Buffer | undefined;
      for (let offset = 12; offset + 8 <= wav.length;) {
        const length = wav.readUInt32LE(offset + 4); const chunk = wav.subarray(offset + 8, offset + 8 + length);
        if (wav.toString("ascii", offset, offset + 4) === "fmt ") { expect(chunk.readUInt16LE(0)).toBe(1); expect(chunk.readUInt16LE(2)).toBe(1); expect(chunk.readUInt32LE(4)).toBe(16000); expect(chunk.readUInt16LE(14)).toBe(16); }
        if (wav.toString("ascii", offset, offset + 4) === "data") output = chunk;
        offset += 8 + length + length % 2;
      }
      expect(output).toHaveLength(6400);
      // Skip filter edge transients; verify a 1 kHz tone keeps its frequency and amplitude.
      for (let sample = 100; sample < 200; sample++) expect(Math.abs(output!.readInt16LE(sample * 2) - Math.round(4000 * Math.sin(2 * Math.PI * 1000 * sample / 16000)))).toBeLessThan(10);
    } finally { await upload.cleanup(); await rm(server.temp_directory, { recursive: true, force: true }); }
  });
  it.each([2400, 4800, 4871])("normalizes real Opus with exact encoder pre-skip and end trimming (%s source samples)", async (samples) => {
    const { server } = await testConfig(); const signal = new AbortController().signal; const pcm = Buffer.alloc(samples * 2);
    for (let sample = 0; sample < samples; sample++) pcm.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 1000 * sample / 24000)), sample * 2);
    const encoded = execFileSync(server.ffmpeg, ["-nostdin", "-v", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32000", "-frame_duration", "20", "-f", "ogg", "pipe:1"], { input: pcm });
    const validator = new OggOpusValidator(samples * 2); validator.append(encoded); expect(validator.finish()).toBe(samples * 2);
    const upload = await storeRealtimeOgg(encoded, server.temp_directory, signal);
    try {
      const normalized = await normalizeUpload(upload, { ffmpeg: server.ffmpeg, prlimit: server.prlimit, memoryBytes: server.ffmpeg_memory_bytes, timeoutMs: 5000, maxOutputBytes: Math.ceil(samples * 4 / 3) + 4096 }, signal);
      expect(Math.abs(normalized.durationSeconds * 16000 - samples * 2 / 3)).toBeLessThanOrEqual(1);
    } finally { await upload.cleanup(); await rm(server.temp_directory, { recursive: true, force: true }); }
  });
  it("does not create files when a capture was already cancelled", async () => {
    const { server } = await testConfig(); const controller = new AbortController(); const reason = new Error("Disconnected"); controller.abort(reason);
    try { await expect(storeRealtimePcm(Buffer.alloc(4800), server.temp_directory, controller.signal)).rejects.toBe(reason); expect(await readdir(server.temp_directory)).toEqual(["tokens.json"]); }
    finally { await rm(server.temp_directory, { recursive: true, force: true }); }
  });
});
