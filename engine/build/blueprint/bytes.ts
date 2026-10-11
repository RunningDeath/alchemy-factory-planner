/** Little-endian byte reader / writer for Unreal Engine archives */

export class ByteReader {
    readonly view: DataView;
    pos: number;

    constructor(
        readonly bytes: Uint8Array,
        pos = 0,
    ) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.pos = pos;
    }

    get remaining(): number {
        return this.bytes.length - this.pos;
    }

    private need(n: number) {
        if (n < 0 || this.pos + n > this.bytes.length) throw new Error(`read past end at ${this.pos} (+${n} of ${this.bytes.length})`);
    }

    u8(): number {
        this.need(1);
        return this.bytes[this.pos++];
    }

    i32(): number {
        this.need(4);
        const v = this.view.getInt32(this.pos, true);
        this.pos += 4;
        return v;
    }

    u16(): number {
        this.need(2);
        const v = this.view.getUint16(this.pos, true);
        this.pos += 2;
        return v;
    }

    u32(): number {
        this.need(4);
        const v = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return v;
    }

    i64(): bigint {
        this.need(8);
        const v = this.view.getBigInt64(this.pos, true);
        this.pos += 8;
        return v;
    }

    f32(): number {
        this.need(4);
        const v = this.view.getFloat32(this.pos, true);
        this.pos += 4;
        return v;
    }

    f64(): number {
        this.need(8);
        const v = this.view.getFloat64(this.pos, true);
        this.pos += 8;
        return v;
    }

    raw(n: number): Uint8Array {
        this.need(n);
        const v = this.bytes.slice(this.pos, this.pos + n);
        this.pos += n;
        return v;
    }

    /** FString: int32 length incl. terminator; negative = UTF-16 */
    fstring(): string {
        const len = this.i32();
        if (len === 0) return "";
        if (len > 0) {
            this.need(len);
            let s = "";
            for (let i = 0; i < len - 1; i++) s += String.fromCharCode(this.bytes[this.pos + i]);
            this.pos += len;
            return s;
        }
        const n = -len;
        this.need(n * 2);
        let s = "";
        for (let i = 0; i < n - 1; i++) s += String.fromCharCode(this.view.getUint16(this.pos + i * 2, true));
        this.pos += n * 2;
        return s;
    }
}

export class ByteWriter {
    private buf = new Uint8Array(1024);
    private view = new DataView(this.buf.buffer);
    length = 0;

    private ensure(n: number) {
        if (this.length + n <= this.buf.length) return;
        let size = this.buf.length * 2;
        while (size < this.length + n) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.length));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }

    u8(v: number) {
        this.ensure(1);
        this.buf[this.length++] = v;
    }

    i32(v: number) {
        this.ensure(4);
        this.view.setInt32(this.length, v, true);
        this.length += 4;
    }

    u16(v: number) {
        this.ensure(2);
        this.view.setUint16(this.length, v, true);
        this.length += 2;
    }

    u32(v: number) {
        this.ensure(4);
        this.view.setUint32(this.length, v, true);
        this.length += 4;
    }

    i64(v: bigint) {
        this.ensure(8);
        this.view.setBigInt64(this.length, v, true);
        this.length += 8;
    }

    f32(v: number) {
        this.ensure(4);
        this.view.setFloat32(this.length, v, true);
        this.length += 4;
    }

    f64(v: number) {
        this.ensure(8);
        this.view.setFloat64(this.length, v, true);
        this.length += 8;
    }

    raw(bytes: Uint8Array) {
        this.ensure(bytes.length);
        this.buf.set(bytes, this.length);
        this.length += bytes.length;
    }

    /** Overwrites an int32 written earlier (for size fields) */
    patchI32(at: number, v: number) {
        this.view.setInt32(at, v, true);
    }

    /** FString: ANSI when every char is < 0x80 (like UE's IsPureAnsi), else UTF-16 */
    fstring(s: string) {
        if (s.length === 0) {
            this.i32(0);
            return;
        }
        let ansi = true;
        for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x80) ansi = false;
        if (ansi) {
            this.i32(s.length + 1);
            this.ensure(s.length + 1);
            for (let i = 0; i < s.length; i++) this.buf[this.length++] = s.charCodeAt(i);
            this.buf[this.length++] = 0;
        } else {
            this.i32(-(s.length + 1));
            this.ensure((s.length + 1) * 2);
            for (let i = 0; i < s.length; i++) {
                this.view.setUint16(this.length, s.charCodeAt(i), true);
                this.length += 2;
            }
            this.view.setUint16(this.length, 0, true);
            this.length += 2;
        }
    }

    bytes(): Uint8Array {
        return this.buf.slice(0, this.length);
    }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
    outer: for (let i = from; i <= hay.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return i;
    }
    return -1;
}
