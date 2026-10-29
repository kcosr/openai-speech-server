import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { invalid } from "../api/errors.js";
import type { StoredUpload } from "./normalize.js";

const bad = (message: string): never => { throw invalid("invalid_audio", message, "audio"); };
const overflow = (): never => { throw invalid("audio_buffer_overflow", "Audio exceeds the session or model duration limit.", "audio"); };
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  return crc >>> 0;
});

/** Ogg's non-reflected CRC, with the checksum field treated as zero. */
export function oggChecksum(page: Buffer): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ (i >= 22 && i < 26 ? 0 : page[i]!)) & 255]!) >>> 0;
  return crc;
}

/** Validate the RFC 6716 packet framing and return its duration in 48 kHz samples. */
export function opusPacketSamples(packet: Buffer): number {
  if (!packet.length) bad("Empty Opus packets are unsupported.");
  const toc = packet[0]!;
  if (toc & 4) bad("Only mono Opus packets are supported.");
  const config = toc >>> 3;
  const frameSamples = config >= 16 ? 120 << (config & 3) : config >= 12 ? 480 << (config & 1) : [480, 960, 1920, 2880][config & 3]!;
  let offset = 1; let end = packet.length; let count: number;
  const length = () => {
    if (offset >= end) return bad("Truncated Opus frame lengths.");
    const first = packet[offset++]!;
    if (first < 252) return first;
    if (offset >= end) return bad("Truncated Opus frame lengths.");
    return first + 4 * packet[offset++]!;
  };
  const frame = (bytes: number) => { if (bytes < 0 || bytes > 1275) bad("Invalid Opus frame length."); };
  switch (toc & 3) {
    case 0: count = 1; frame(end - offset); break;
    case 1: count = 2; if ((end - offset) % 2) bad("Invalid Opus CBR frame lengths."); frame((end - offset) / 2); break;
    case 2: {
      count = 2; const first = length(); frame(first); frame(end - offset - first); break;
    }
    default: {
      if (offset >= end) bad("Truncated Opus packet.");
      const control = packet[offset++]!; count = control & 63;
      if (!count || count > 48) bad("Invalid Opus frame count.");
      if (control & 64) {
        let padding = 0; let value: number;
        do { if (offset >= end) bad("Truncated Opus padding."); value = packet[offset++]!; padding += value === 255 ? 254 : value; } while (value === 255);
        end -= padding; if (end < offset) bad("Invalid Opus padding.");
      }
      if (control & 128) {
        let consumed = 0;
        for (let i = 1; i < count; i++) { const size = length(); frame(size); consumed += size; }
        frame(end - offset - consumed);
      } else {
        if ((end - offset) % count) bad("Invalid Opus CBR frame lengths.");
        frame((end - offset) / count);
      }
    }
  }
  const samples = count * frameSamples;
  if (samples > 5760) bad("Opus packets cannot exceed 120 ms.");
  return samples;
}

type StreamState = { sequence: number; serial: number; stage: "head" | "tags" | "audio"; preSkip: number; decoded: number; granule: number; ended: boolean };

/** Restricted streaming profile: independent mono stream, complete packets/pages, exact granules. */
export class OggOpusValidator {
  private state: StreamState = { sequence: 0, serial: 0, stage: "head", preSkip: 0, decoded: 0, granule: 0, ended: false };

  constructor(private readonly maximumSamples: number) {}

  // An invalid message never advances the accepted stream state.
  append(message: Buffer) {
    if (!message.length) bad("An Ogg audio message must contain complete pages.");
    const state = { ...this.state };
    for (let offset = 0; offset < message.length;) {
      if (state.ended) bad("Audio after Ogg EOS requires a new committed or cleared buffer.");
      if (message.length - offset < 27 || message.toString("ascii", offset, offset + 4) !== "OggS") bad("Audio must contain complete Ogg pages.");
      if (message[offset + 4] !== 0) bad("Unsupported Ogg version.");
      const flags = message[offset + 5]!; const segments = message[offset + 26]!;
      if (flags & ~6 || !segments) bad("Ogg packet continuation and empty pages are unsupported.");
      const body = offset + 27 + segments;
      if (body > message.length) bad("Truncated Ogg segment table.");
      let size = 0;
      for (let i = offset + 27; i < body; i++) size += message[i]!;
      const end = body + size;
      if (end > message.length || message[body - 1] === 255) bad("Each message must contain complete Ogg pages and packets.");
      const page = message.subarray(offset, end);
      if (page.readUInt32LE(22) !== oggChecksum(page)) bad("Ogg checksum mismatch.");
      const serial = page.readUInt32LE(14); const sequence = page.readUInt32LE(18);
      if (sequence !== state.sequence || (state.stage !== "head" && serial !== state.serial)) bad("Ogg pages must have one serial and consecutive sequence numbers starting at zero.");
      const rawGranule = page.readBigUInt64LE(6);
      if (rawGranule > BigInt(Number.MAX_SAFE_INTEGER)) bad("Invalid Ogg granule position.");
      const granule = Number(rawGranule);
      const packets: Buffer[] = []; let start = body; let position = body;
      for (let i = offset + 27; i < body; i++) {
        position += message[i]!;
        if (message[i] !== 255) { packets.push(message.subarray(start, position)); start = position; }
      }
      if (state.stage === "head") {
        const head = packets[0]!;
        if (flags !== 2 || packets.length !== 1 || granule !== 0 || head.length !== 19 || head.toString("ascii", 0, 8) !== "OpusHead" || head[8] !== 1 || head[9] !== 1 || head.readInt16LE(16) !== 0 || head[18] !== 0) bad("Expected a mono version-1 OpusHead BOS page with mapping family 0 and zero gain.");
        state.preSkip = head.readUInt16LE(10); state.serial = serial; state.stage = "tags";
      } else if (state.stage === "tags") {
        if (flags || granule !== 0 || packets.length !== 1) bad("Expected a separate OpusTags page.");
        validateTags(packets[0]!); state.stage = "audio";
      } else {
        if (flags & 2) bad("Chained Ogg streams are unsupported inside one buffer.");
        let lastSamples = 0;
        for (const packet of packets) { lastSamples = opusPacketSamples(packet); state.decoded += lastSamples; }
        const eos = (flags & 4) !== 0;
        if (eos) {
          if (granule < state.granule || granule < state.preSkip || granule > state.decoded || granule < state.decoded - lastSamples) bad("Invalid Opus end trimming.");
          state.ended = true;
        } else if (granule !== state.decoded) bad("Ogg granules must match decoded Opus packet durations.");
        if (granule - state.preSkip > this.maximumSamples) overflow();
        state.granule = granule;
      }
      state.sequence++; offset = end;
    }
    this.state = state;
  }

  finish(): number {
    if (!this.state.ended) bad("Finish the Ogg Opus stream with an EOS audio page before committing.");
    return this.state.granule - this.state.preSkip;
  }
}

function validateTags(tags: Buffer) {
  if (tags.length < 16 || tags.toString("ascii", 0, 8) !== "OpusTags") bad("Invalid OpusTags header.");
  let offset = 12 + tags.readUInt32LE(8);
  if (offset + 4 > tags.length) bad("Truncated OpusTags vendor.");
  const count = tags.readUInt32LE(offset); offset += 4;
  // Bound the loop by the page size, including zero-length comments.
  if (count > (tags.length - offset) / 4) bad("Invalid OpusTags comment count.");
  for (let i = 0; i < count; i++) {
    if (offset + 4 > tags.length) bad("Truncated OpusTags comment.");
    offset += 4 + tags.readUInt32LE(offset);
    if (offset > tags.length) bad("Truncated OpusTags comment.");
  }
  if (offset !== tags.length) bad("OpusTags padding is unsupported.");
}

export async function storeRealtimeOgg(ogg: Buffer, directory: string, signal: AbortSignal): Promise<StoredUpload> {
  signal.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const base = join(directory, randomUUID()); const path = `${base}.ogg`; const output = `${base}.normalized.wav`;
  const cleanup = () => Promise.all([rm(path, { force: true }), rm(output, { force: true })]).then(() => undefined);
  try {
    await writeFile(path, ogg, { flag: "wx", mode: 0o600, signal }); signal.throwIfAborted();
    return { path, output, format: "ogg", cleanup };
  } catch (error) { await cleanup(); throw error; }
}
