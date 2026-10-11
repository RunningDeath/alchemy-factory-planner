/**
 * Minimal Oodle (Kraken) stream writer that needs no compressor: every 256 KiB block
 * is stored uncompressed. A block header is two bytes:
 *
 *   byte 0: 0x0C | uncompressed (0x40) | restart decoder (0x80)
 *   byte 1: decoder type (6 = Kraken), checksum flag 0x80 not set
 *
 * followed, for an uncompressed block, by the block's raw bytes. Real Oodle
 * decoders (OodleLZ_Decompress) accept this; see scripts/oodle.ts and oodle-dll.test.ts.
 */

const BLOCK = 0x40000;
const KRAKEN = 6;
const HEADER_STORED = 0x80 | 0x40 | 0x0c;

export function oodleStore(data: Uint8Array): Uint8Array {
    const blocks = Math.max(1, Math.ceil(data.length / BLOCK));
    const out = new Uint8Array(data.length + blocks * 2);
    let o = 0;
    for (let i = 0; i < blocks; i++) {
        const chunk = data.subarray(i * BLOCK, Math.min(data.length, (i + 1) * BLOCK));
        out[o++] = HEADER_STORED;
        out[o++] = KRAKEN;
        out.set(chunk, o);
        o += chunk.length;
    }
    return out;
}

/** Reads a stream written by oodleStore (stored blocks only); throws on compressed blocks */
export function oodleUnstore(stream: Uint8Array, size: number): Uint8Array {
    const out = new Uint8Array(size);
    let i = 0;
    for (let o = 0; o < size; o += BLOCK) {
        const n = Math.min(BLOCK, size - o);
        if ((stream[i] & 0x0f) !== 0x0c || (stream[i] & 0x40) === 0) throw new Error("compressed Oodle block: needs the Oodle library");
        i += 2;
        out.set(stream.subarray(i, i + n), o);
        i += n;
    }
    return out;
}

/** Whether a stream starts with an Oodle LZ block header */
export function isOodleStream(stream: Uint8Array): boolean {
    return stream.length >= 2 && (stream[0] & 0x0f) === 0x0c && (stream[0] & 0x30) === 0;
}
