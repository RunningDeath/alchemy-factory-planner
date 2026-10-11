/**
 * Templates copied from real player blueprints: every field the app doesn't set keeps
 * exactly the value and layout the game wrote.
 */
import { cloneProperties, decodeProperties, findProp, getProp, type Property, type Value } from "./properties";
import { BODY_B64, HEADER_B64 } from "./template-data";

export interface BlueprintTemplate {
    header: Property[];
    /** Top-level body properties; Buildings is replaced on export */
    body: Property[];
    /** A plain building (CloneBuildingData) */
    building: Property[];
    /** A conveyor lift building */
    lift: Property[];
    /** One stacked lift piece (CloneSimplifyPackage in Extension) */
    piece: Property[];
}

function fromBase64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

let cached: BlueprintTemplate | null = null;

function load(): BlueprintTemplate {
    if (cached) return cached;
    const header = decodeProperties(fromBase64(HEADER_B64));
    const body = decodeProperties(fromBase64(BODY_B64));
    const [building, lift] = getProp<Value[]>(body, "Buildings") as Property[][];
    const piece = (getProp<Value[]>(lift, "Extension") as Property[][])[0];
    cached = { header, body, building, lift, piece };
    return cached;
}

/** Fresh deep copies, safe to modify */
export function blueprintTemplate(): BlueprintTemplate {
    const t = load();
    return {
        header: cloneProperties(t.header),
        body: cloneProperties(t.body),
        building: cloneProperties(t.building),
        lift: cloneProperties(t.lift),
        piece: cloneProperties(t.piece),
    };
}

/** Sets a nested property, e.g. setPath(b, ["building", "SettleKey"], 3) */
export function setPath(props: Property[], path: string[], value: Value) {
    let cur = props;
    for (const name of path.slice(0, -1)) cur = getProp<Property[]>(cur, name);
    const p = findProp(cur, path[path.length - 1]);
    if (!p) throw new Error(`missing property ${path.join(".")}`);
    p.value = value;
}
