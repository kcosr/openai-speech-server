/** Independent bit-at-a-time CRC for fixture construction. */
export function checksum(page: Buffer) {
  page.writeUInt32LE(0, 22); let crc = 0;
  for (const value of page) {
    crc ^= value << 24;
    for (let i = 0; i < 8; i++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  }
  page.writeUInt32LE(crc >>> 0, 22); return page;
}

export function page(packets: Buffer[], sequence: number, granule: number, flags = 0, serial = 42) {
  const segments: number[] = [];
  for (const packet of packets) { let length = packet.length; while (length >= 255) { segments.push(255); length -= 255; } segments.push(length); }
  const header = Buffer.alloc(27 + segments.length);
  header.write("OggS"); header[5] = flags; header.writeBigUInt64LE(BigInt(granule), 6); header.writeUInt32LE(serial, 14); header.writeUInt32LE(sequence, 18); header[26] = segments.length;
  Buffer.from(segments).copy(header, 27); return checksum(Buffer.concat([header, ...packets]));
}

export function head(preSkip = 312) {
  const packet = Buffer.alloc(19); packet.write("OpusHead"); packet[8] = 1; packet[9] = 1; packet.writeUInt16LE(preSkip, 10); packet.writeUInt32LE(24000, 12); return packet;
}
export function tags() {
  const packet = Buffer.alloc(21); packet.write("OpusTags"); packet.writeUInt32LE(5, 8); packet.write("tests", 12); return packet;
}
// RFC-compatible mono 20 ms Opus silence packet.
export const silence = Buffer.from([0xf8, 0xff, 0xfe]);
export function silenceStream(samples = 9600, preSkip = 312) {
  const packets = Array.from({ length: Math.ceil((samples + preSkip) / 960) }, () => silence);
  return [page([head(preSkip)], 0, 0, 2), page([tags()], 1, 0), page(packets, 2, samples + preSkip, 4)];
}
