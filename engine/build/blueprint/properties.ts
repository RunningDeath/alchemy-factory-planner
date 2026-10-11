/**
 * Unreal Engine tagged property serialization (UE 5.5+ "complete type name" tags),
 * as used by Alchemy Factory blueprints.
 *
 * Each property: FString name, type-name tree, int32 size, uint8 flags, optional
 * array index / guid / extensions, then the value. A list ends with the name "None".
 * Values we don't understand are kept as raw bytes so everything round-trips.
 */
import { ByteReader, ByteWriter } from "./bytes";

export interface PropType {
    name: string;
    params: PropType[];
}

/** Tag flags */
export const TAG = {
    HasArrayIndex: 0x01,
    HasPropertyGuid: 0x02,
    HasPropertyExtensions: 0x04,
    HasBinaryOrNativeSerialize: 0x08,
    BoolTrue: 0x10,
} as const;

/** Bytes we don't decode; written back unchanged */
export class RawValue {
    constructor(readonly bytes: Uint8Array) {}
}

/** FText with history type None (-1): the only kind blueprints use for titles */
export interface TextValue {
    text: { flags: number; invariant: string | null };
}

export type Value =
    | boolean
    | number
    | bigint
    | string
    | number[] // native structs: Vector, IntVector, IntPoint, Color, …
    | Property[] // structs
    | Value[] // arrays
    | TextValue
    | RawValue;

export interface Property {
    name: string;
    type: PropType;
    /** Tag flags other than BoolTrue, which comes from the value */
    flags: number;
    arrayIndex?: number;
    guid?: Uint8Array;
    /** Raw property-extension bytes */
    ext?: Uint8Array;
    value: Value;
}

/** Structs serialized natively (no property list): byte size and element kind */
const NATIVE_STRUCTS: Record<string, { size: number; kind: "f64" | "i32" | "u8" | "f32" }> = {
    Vector: { size: 24, kind: "f64" },
    Vector2D: { size: 16, kind: "f64" },
    Rotator: { size: 24, kind: "f64" },
    Quat: { size: 32, kind: "f64" },
    IntVector: { size: 12, kind: "i32" },
    IntPoint: { size: 8, kind: "i32" },
    Color: { size: 4, kind: "u8" },
    LinearColor: { size: 16, kind: "f32" },
    Guid: { size: 16, kind: "i32" },
};

const structName = (t: PropType) => t.params[0]?.name ?? "";

// ---------------------------------------------------------------- reading

function readType(r: ByteReader): PropType {
    const name = r.fstring();
    const n = r.i32();
    const params: PropType[] = [];
    for (let i = 0; i < n; i++) params.push(readType(r));
    return { name, params };
}

function readNative(r: ByteReader, name: string): number[] {
    const { size, kind } = NATIVE_STRUCTS[name];
    const out: number[] = [];
    const step = kind === "f64" ? 8 : kind === "u8" ? 1 : 4;
    for (let i = 0; i < size / step; i++) out.push(kind === "f64" ? r.f64() : kind === "i32" ? r.i32() : kind === "f32" ? r.f32() : r.u8());
    return out;
}

function readText(r: ByteReader, size: number): TextValue | RawValue {
    const start = r.pos;
    const flags = r.u32();
    const history = (r.u8() << 24) >> 24;
    if (history === -1) {
        const has = r.i32();
        const invariant = has ? r.fstring() : null;
        if (r.pos === start + size) return { text: { flags, invariant } };
    }
    r.pos = start;
    return new RawValue(r.raw(size));
}

/** Value of one array element; null if the element type isn't understood */
function readElement(r: ByteReader, inner: PropType): Value | null {
    switch (inner.name) {
        case "StructProperty": {
            const s = structName(inner);
            return NATIVE_STRUCTS[s] ? readNative(r, s) : readProperties(r);
        }
        case "NameProperty":
        case "StrProperty":
        case "EnumProperty":
            return r.fstring();
        case "IntProperty":
            return r.i32();
        case "UInt32Property":
            return r.u32();
        case "FloatProperty":
            return r.f32();
        case "DoubleProperty":
            return r.f64();
        case "Int64Property":
            return r.i64();
        case "BoolProperty":
            return r.u8() !== 0;
        case "ByteProperty":
            return inner.params.length ? null : r.u8();
        default:
            return null;
    }
}

function readValue(r: ByteReader, type: PropType, size: number, flags: number): Value {
    const start = r.pos;
    const end = start + size;
    let v: Value;
    switch (type.name) {
        case "BoolProperty":
            v = (flags & TAG.BoolTrue) !== 0;
            break;
        case "IntProperty":
            v = r.i32();
            break;
        case "UInt32Property":
            v = r.u32();
            break;
        case "UInt16Property":
            v = r.u16();
            break;
        case "Int64Property":
            v = r.i64();
            break;
        case "FloatProperty":
            v = r.f32();
            break;
        case "DoubleProperty":
            v = r.f64();
            break;
        case "NameProperty":
        case "StrProperty":
        case "EnumProperty":
            v = r.fstring();
            break;
        case "ByteProperty":
            v = size === 1 ? r.u8() : r.fstring();
            break;
        case "TextProperty":
            v = readText(r, size);
            break;
        case "StructProperty": {
            const s = structName(type);
            v = NATIVE_STRUCTS[s] && size === NATIVE_STRUCTS[s].size ? readNative(r, s) : readProperties(r);
            break;
        }
        case "ArrayProperty": {
            const n = r.i32();
            const items: Value[] = [];
            for (let i = 0; i < n; i++) {
                const item = readElement(r, type.params[0]);
                if (item === null) break;
                items.push(item);
            }
            if (items.length === n && r.pos === end) {
                v = items;
                break;
            }
            r.pos = start;
            v = new RawValue(r.raw(size));
            break;
        }
        default:
            v = new RawValue(r.raw(size));
    }
    if (r.pos !== end) throw new Error(`property of type ${type.name} at ${start}: read ${r.pos - start} of ${size} bytes`);
    return v;
}

/** Reads properties until "None" */
export function readProperties(r: ByteReader): Property[] {
    const props: Property[] = [];
    for (;;) {
        const name = r.fstring();
        if (name === "None") return props;
        if (name === "") throw new Error(`empty property name at ${r.pos}`);
        const type = readType(r);
        const size = r.i32();
        const flags = r.u8();
        const prop: Property = { name, type, flags: flags & ~TAG.BoolTrue, value: false };
        if (flags & TAG.HasArrayIndex) prop.arrayIndex = r.i32();
        if (flags & TAG.HasPropertyGuid) prop.guid = r.raw(16);
        if (flags & TAG.HasPropertyExtensions) {
            const at = r.pos;
            const ext = r.u8();
            if (ext & 0x02) r.u8();
            prop.ext = r.bytes.slice(at, r.pos);
        }
        prop.value = readValue(r, type, size, flags);
        props.push(prop);
    }
}

// ---------------------------------------------------------------- writing

function writeType(w: ByteWriter, t: PropType) {
    w.fstring(t.name);
    w.i32(t.params.length);
    for (const p of t.params) writeType(w, p);
}

function writeNative(w: ByteWriter, name: string, v: number[]) {
    const { kind } = NATIVE_STRUCTS[name];
    for (const x of v) {
        if (kind === "f64") w.f64(x);
        else if (kind === "i32") w.i32(x);
        else if (kind === "f32") w.f32(x);
        else w.u8(x);
    }
}

function writeElement(w: ByteWriter, inner: PropType, v: Value) {
    switch (inner.name) {
        case "StructProperty": {
            const s = structName(inner);
            if (NATIVE_STRUCTS[s]) writeNative(w, s, v as number[]);
            else writeProperties(w, v as Property[]);
            return;
        }
        case "NameProperty":
        case "StrProperty":
        case "EnumProperty":
            return w.fstring(v as string);
        case "IntProperty":
            return w.i32(v as number);
        case "UInt32Property":
            return w.u32(v as number);
        case "FloatProperty":
            return w.f32(v as number);
        case "DoubleProperty":
            return w.f64(v as number);
        case "Int64Property":
            return w.i64(v as bigint);
        case "BoolProperty":
            return w.u8(v ? 1 : 0);
        case "ByteProperty":
            return w.u8(v as number);
        default:
            throw new Error(`can't write array of ${inner.name}`);
    }
}

function writeValue(w: ByteWriter, type: PropType, v: Value) {
    if (v instanceof RawValue) return w.raw(v.bytes);
    switch (type.name) {
        case "BoolProperty":
            return;
        case "IntProperty":
            return w.i32(v as number);
        case "UInt32Property":
            return w.u32(v as number);
        case "UInt16Property":
            return w.u16(v as number);
        case "Int64Property":
            return w.i64(v as bigint);
        case "FloatProperty":
            return w.f32(v as number);
        case "DoubleProperty":
            return w.f64(v as number);
        case "NameProperty":
        case "StrProperty":
        case "EnumProperty":
            return w.fstring(v as string);
        case "ByteProperty":
            return typeof v === "number" ? w.u8(v) : w.fstring(v as string);
        case "TextProperty": {
            const { flags, invariant } = (v as TextValue).text;
            w.u32(flags);
            w.u8(0xff);
            w.i32(invariant === null ? 0 : 1);
            if (invariant !== null) w.fstring(invariant);
            return;
        }
        case "StructProperty": {
            const s = structName(type);
            if (NATIVE_STRUCTS[s] && !isPropertyList(v)) writeNative(w, s, v as number[]);
            else writeProperties(w, v as Property[]);
            return;
        }
        case "ArrayProperty": {
            const items = v as Value[];
            w.i32(items.length);
            for (const item of items) writeElement(w, type.params[0], item);
            return;
        }
        default:
            throw new Error(`can't write ${type.name}`);
    }
}

function isPropertyList(v: Value): v is Property[] {
    return Array.isArray(v) && (v.length === 0 || typeof v[0] === "object");
}

export function writeProperty(w: ByteWriter, p: Property) {
    w.fstring(p.name);
    writeType(w, p.type);
    const sizeAt = w.length;
    w.i32(0);
    let flags = p.flags & ~TAG.BoolTrue;
    if (p.type.name === "BoolProperty" && p.value === true) flags |= TAG.BoolTrue;
    w.u8(flags);
    if (flags & TAG.HasArrayIndex) w.i32(p.arrayIndex ?? 0);
    if (flags & TAG.HasPropertyGuid) w.raw(p.guid ?? new Uint8Array(16));
    if (flags & TAG.HasPropertyExtensions) w.raw(p.ext ?? new Uint8Array(1));
    const start = w.length;
    writeValue(w, p.type, p.value);
    w.patchI32(sizeAt, w.length - start);
}

/** Writes properties followed by "None" */
export function writeProperties(w: ByteWriter, props: Property[]) {
    for (const p of props) writeProperty(w, p);
    w.fstring("None");
}

export function decodeProperties(bytes: Uint8Array): Property[] {
    const r = new ByteReader(bytes);
    const props = readProperties(r);
    if (r.remaining !== 0) throw new Error(`${r.remaining} bytes after the property list`);
    return props;
}

export function encodeProperties(props: Property[]): Uint8Array {
    const w = new ByteWriter();
    writeProperties(w, props);
    return w.bytes();
}

// ---------------------------------------------------------------- access helpers

export function findProp(props: Property[], name: string): Property | undefined {
    return props.find((p) => p.name === name);
}

export function getProp<T extends Value>(props: Property[], name: string): T {
    const p = findProp(props, name);
    if (!p) throw new Error(`missing property ${name}`);
    return p.value as T;
}

export function setProp(props: Property[], name: string, value: Value) {
    const p = findProp(props, name);
    if (!p) throw new Error(`missing property ${name}`);
    p.value = value;
}

/** Deep copy (RawValue and guid bytes are shared, they are never mutated) */
export function cloneProperties(props: Property[]): Property[] {
    return props.map((p) => ({ ...p, value: cloneValue(p.value) }));
}

function cloneValue(v: Value): Value {
    if (Array.isArray(v)) {
        if (v.length && typeof v[0] === "object" && v[0] !== null && "name" in (v[0] as object) && "type" in (v[0] as object))
            return cloneProperties(v as Property[]);
        return (v as Value[]).map(cloneValue);
    }
    if (typeof v === "object" && v !== null && "text" in v) return { text: { ...v.text } };
    return v;
}

/** Plain JSON-able view of a property list (for debugging and tests) */
export function toPlain(props: Property[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of props) out[p.name] = plainValue(p.value);
    return out;
}

function plainValue(v: Value): unknown {
    if (v instanceof RawValue) return `<raw ${v.bytes.length}>`;
    if (typeof v === "bigint") return Number(v);
    if (Array.isArray(v)) {
        if (v.length && typeof v[0] === "object" && v[0] !== null && "type" in (v[0] as object)) return toPlain(v as Property[]);
        return (v as Value[]).map(plainValue);
    }
    if (typeof v === "object" && v !== null && "text" in v) return v.text.invariant;
    return v;
}
