/**
 * Blueprint file container: PNG preview, then (after IEND) a tagged-property header,
 * the Oodle-compressed body, and an 8-byte trailer.
 *
 *   [PNG][header properties … "None"][compressed body (CompressedSize bytes)]
 *   [uint32 length of header + body][uint32 magic 0x5042AFD5]
 */
import { ByteReader, ByteWriter, concatBytes, indexOfBytes } from "./bytes";
import { findProp, readProperties, writeProperties, type Property } from "./properties";

export const TRAILER_MAGIC = 0x5042afd5;

export interface BlueprintFile {
    png: Uint8Array;
    header: Property[];
    /** Compressed body exactly as stored */
    compressed: Uint8Array;
    uncompressedSize: number;
}

const IEND = new Uint8Array([0x49, 0x45, 0x4e, 0x44]);

/** Length of the PNG part (up to and including the IEND chunk's CRC) */
export function pngLength(bytes: Uint8Array): number {
    const at = indexOfBytes(bytes, IEND, 8);
    if (at < 0) throw new Error("no PNG IEND chunk");
    return at + 8;
}

export function readBlueprintFile(bytes: Uint8Array): BlueprintFile {
    const pngEnd = pngLength(bytes);
    return { png: bytes.slice(0, pngEnd), ...readBlueprintTail(bytes.subarray(pngEnd)) };
}

/** Reads the part after the PNG */
export function readBlueprintTail(tail: Uint8Array): Omit<BlueprintFile, "png"> {
    if (tail.length < 8) throw new Error("blueprint data too short");
    const trailer = new DataView(tail.buffer, tail.byteOffset + tail.length - 8, 8);
    if (trailer.getUint32(4, true) !== TRAILER_MAGIC) throw new Error("missing blueprint trailer");
    const dataLength = trailer.getUint32(0, true);
    if (dataLength !== tail.length - 8) throw new Error(`trailer length ${dataLength} != ${tail.length - 8}`);

    const r = new ByteReader(tail);
    const header = readProperties(r);
    const compressedSize = Number(headerValue<bigint>(header, "CompressedSize"));
    const uncompressedSize = Number(headerValue<bigint>(header, "UncompressedSize"));
    if (r.pos + compressedSize !== dataLength) throw new Error(`body size ${dataLength - r.pos} != CompressedSize ${compressedSize}`);
    return { header, compressed: r.raw(compressedSize), uncompressedSize };
}

function headerValue<T>(header: Property[], name: string): T {
    const p = findProp(header, name);
    if (!p) throw new Error(`blueprint header lacks ${name}`);
    return p.value as T;
}

/** Writes the file; CompressedSize / UncompressedSize in the header are set from the arguments */
export function writeBlueprintFile(file: BlueprintFile): Uint8Array {
    const header = file.header.map((p) =>
        p.name === "CompressedSize"
            ? { ...p, value: BigInt(file.compressed.length) }
            : p.name === "UncompressedSize"
              ? { ...p, value: BigInt(file.uncompressedSize) }
              : p,
    );
    const w = new ByteWriter();
    writeProperties(w, header);
    w.raw(file.compressed);
    const dataLength = w.length;
    w.u32(dataLength);
    w.u32(TRAILER_MAGIC);
    return concatBytes([file.png, w.bytes()]);
}
