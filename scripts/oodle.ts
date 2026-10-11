/**
 * Real Oodle via bun:ffi (local scripts and tests only, never in the browser).
 * Needs oo2core_9_win64.dll (ships with many UE games / CUE4Parse); point
 * OODLE_DLL at it.
 */
// @ts-expect-error -- bun:ffi types ship with Bun, the project doesn't install them
import { dlopen, FFIType, ptr } from "bun:ffi";

export interface OodleLib {
    decompress(compressed: Uint8Array, size: number): Uint8Array;
    /** Kraken at the given level (4 = Normal) */
    compress(data: Uint8Array, level?: number): Uint8Array;
}

export function loadOodle(path = process.env.OODLE_DLL): OodleLib | null {
    if (!path) return null;
    const lib = dlopen(path, {
        OodleLZ_Decompress: {
            args: [
                FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i64,
                FFIType.i32, FFIType.i32, FFIType.i32,
                FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.i32,
            ],
            returns: FFIType.i64,
        },
        OodleLZ_Compress: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i64],
            returns: FFIType.i64,
        },
    });
    const f = lib.symbols;
    return {
        decompress(compressed, size) {
            const out = new Uint8Array(size);
            // fuzzSafe = 1, checkCRC = 1 (verify checksums when present), verbosity 0, threadPhase 3 (all)
            const n = Number(f.OodleLZ_Decompress(ptr(compressed), compressed.length, ptr(out), size, 1, 1, 0, null, 0, null, null, null, 0, 3));
            if (n !== size) throw new Error(`OodleLZ_Decompress returned ${n}, expected ${size}`);
            return out;
        },
        compress(data, level = 4) {
            const out = new Uint8Array(data.length + 274 * Math.ceil(data.length / 0x40000) + 1024);
            const KRAKEN = 8;
            const n = Number(f.OodleLZ_Compress(KRAKEN, ptr(data), data.length, ptr(out), level, null, null, null, null, 0));
            if (n <= 0) throw new Error(`OodleLZ_Compress failed (${n})`);
            return out.slice(0, n);
        },
    };
}
