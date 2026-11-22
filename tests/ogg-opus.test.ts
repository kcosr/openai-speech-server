import { describe, expect, it } from "vitest";
import { OggOpusValidator, opusPacketSamples } from "../src/media/ogg-opus.js";
import { checksum, head, page, silence, silenceStream, tags } from "./ogg-helpers.js";

describe("bounded Ogg Opus validation", () => {
  it("accepts multiple complete pages per message, exact preskip/end trimming and fresh segments", () => {
    for (const samples of [4800, 9600, 9701, 48000]) {
      const validator = new OggOpusValidator(samples);
      validator.append(Buffer.concat(silenceStream(samples)));
      expect(validator.finish()).toBe(samples);
    }
  });
  it("validates every page before admitting any of a message", () => {
    const validator = new OggOpusValidator(9600); const pages = silenceStream();
    const corrupt = Buffer.from(pages[1]!); corrupt[30]! ^= 1;
    expect(() => validator.append(Buffer.concat([pages[0]!, corrupt]))).toThrow("checksum");
    for (const part of pages) validator.append(part);
    expect(validator.finish()).toBe(9600);
  });
  it.each([
    ["CRC", (pages: Buffer[]) => { pages[2]![30]! ^= 1; }],
    ["serial", (pages: Buffer[]) => { pages[2]!.writeUInt32LE(43, 14); checksum(pages[2]!); }],
    ["sequence", (pages: Buffer[]) => { pages[2]!.writeUInt32LE(4, 18); checksum(pages[2]!); }],
    ["continuation", (pages: Buffer[]) => { pages[2]![5] = 5; checksum(pages[2]!); }],
    ["stereo", (pages: Buffer[]) => { pages[0]![37] = 2; checksum(pages[0]!); }],
    ["invalid granule", (pages: Buffer[]) => { pages[2]!.writeBigUInt64LE(20000n, 6); checksum(pages[2]!); }],
    ["excessive trim", (pages: Buffer[]) => { pages[2]!.writeBigUInt64LE(9000n, 6); checksum(pages[2]!); }],
    ["negative granule", (pages: Buffer[]) => { pages[2]!.writeBigUInt64LE(0xffffffffffffffffn, 6); checksum(pages[2]!); }],
  ])("rejects malformed %s before decode", (_name, mutate) => {
    const pages = silenceStream(); mutate(pages);
    expect(() => new OggOpusValidator(48000).append(Buffer.concat(pages))).toThrow();
  });
  it("rejects truncated messages, continued packets, chained streams and missing EOS", () => {
    const [first, second, last] = silenceStream(); const validator = new OggOpusValidator(48000);
    expect(() => validator.append(first!.subarray(0, first!.length - 1))).toThrow("complete");
    validator.append(first!); validator.append(second!);
    expect(() => validator.finish()).toThrow("EOS");
    const continued = page([Buffer.alloc(254)], 2, 960, 0); continued[27] = 255;
    expect(() => validator.append(checksum(Buffer.concat([continued, Buffer.alloc(1)])))).toThrow("complete");
    validator.append(last!); expect(() => validator.append(first!)).toThrow("EOS");
  });
  it("requires real packet duration to support granules and enforces decoded limits independent of compressed size", () => {
    const validator = new OggOpusValidator(9600);
    validator.append(page([head()], 0, 0, 2)); validator.append(page([tags()], 1, 0));
    expect(() => validator.append(page([silence], 2, 4800))).toThrow("durations");
    expect(() => new OggOpusValidator(4800).append(Buffer.concat(silenceStream()))).toThrow("duration limit");
    validator.append(page(Array(5).fill(silence), 2, 4800));
    expect(() => validator.append(page([silence], 3, 4000, 4))).toThrow("trimming");
    validator.append(page(Array(6).fill(silence), 3, 9912, 4)); expect(validator.finish()).toBe(9600);
  });
  it("rejects malicious comment counts without unbounded iteration", () => {
    const validator = new OggOpusValidator(48000); validator.append(page([head()], 0, 0, 2));
    const comments = tags(); comments.writeUInt32LE(0xffffffff, 17);
    expect(() => validator.append(page([comments], 1, 0))).toThrow("comment count");
  });
});

describe("Opus packet framing", () => {
  it("counts all TOC frame-duration modes and valid multi-frame packets", () => {
    expect(opusPacketSamples(silence)).toBe(960);
    expect(opusPacketSamples(Buffer.from([0x80]))).toBe(120);
    expect(opusPacketSamples(Buffer.from([0x98]))).toBe(960);
    expect(opusPacketSamples(Buffer.from([0x18]))).toBe(2880);
    expect(opusPacketSamples(Buffer.from([0xf9, 1, 2]))).toBe(1920);
    expect(opusPacketSamples(Buffer.from([0xfa, 1, 1, 2]))).toBe(1920);
    expect(opusPacketSamples(Buffer.from([0xfb, 3, 1, 2, 3]))).toBe(2880);
    expect(opusPacketSamples(Buffer.from([0xfb, 0x83, 1, 1, 1, 2, 3]))).toBe(2880);
    expect(opusPacketSamples(Buffer.from([0xfb, 0x43, 1, 1, 2, 3, 0]))).toBe(2880);
  });
  it.each([[], [0xfc], [0xf9, 1], [0xfa], [0xfa, 252], [0xfa, 100, 1], [0xfb], [0xfb, 0], [0xfb, 49], [0xfb, 7], [0xfb, 0x43, 99], [0xfb, 0x83, 100, 100], [0xfb, 0x43, 255]])("rejects malformed framing %j", (...bytes) => {
    expect(() => opusPacketSamples(Buffer.from(bytes as number[]))).toThrow();
  });
});
