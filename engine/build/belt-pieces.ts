/**
 * The game's fixed belt pieces: straight, turns, 2-/3-way splits and merges.
 * Each is a one-cell building with ports; rotating it gives every direction.
 */
import { footprintPorts, getFootprint, type Rotation } from "./footprint";
import type { Side } from "./types";

const BELT_PIECES = [
    "belt-fixed",
    "belt-fixed-c-c-w",
    "belt-fixed-cw",
    "belt-fixed-2-split-1",
    "belt-fixed-2-split-2",
    "belt-fixed-2-split-3",
    "belt-fixed-2-merge-1",
    "belt-fixed-2-merge-2",
    "belt-fixed-2-merge-3",
    "belt-fixed-3-split",
    "belt-fixed-3-merge",
];

const sameSet = (a: Side[], b: Side[]) => a.length === b.length && a.every((s) => b.includes(s));

const cache = new Map<string, { id: string; rot: Rotation } | null>();

/** The belt piece and rotation that takes items in from `ins` and sends them out to `outs` */
export function beltPieceFor(ins: Side[], outs: Side[]): { id: string; rot: Rotation } | null {
    const key = `${[...ins].sort().join("+")}>${[...outs].sort().join("+")}`;
    if (cache.has(key)) return cache.get(key)!;

    let found: { id: string; rot: Rotation } | null = null;
    for (const id of BELT_PIECES) {
        const fp = getFootprint(id);
        if (!fp) continue;
        for (const rot of [0, 1, 2, 3] as Rotation[]) {
            const ports = footprintPorts(fp, rot);
            const pIns = ports.filter((p) => p.dir === "in").map((p) => p.face as Side);
            const pOuts = ports.filter((p) => p.dir === "out").map((p) => p.face as Side);
            if (sameSet(pIns, ins) && sameSet(pOuts, outs)) {
                found = { id, rot };
                break;
            }
        }
        if (found) break;
    }
    cache.set(key, found);
    return found;
}

export function isBeltPiece(id: string): boolean {
    return id === "belt" || BELT_PIECES.includes(id);
}
