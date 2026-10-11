/**
 * Belts in blueprints.
 *
 * Player blueprints use the plain conveyor "Belt" (secondary type Belt) for straight
 * runs, turns and merges: GridRotation gives the output side (NoRotation = +x, like
 * BeltFixed), and BaseActiveIndex records which sides feed it. Bits observed in 341
 * belts of 18 player blueprints, relative to the belt's direction:
 *   1 = front (rare), 2 = right side, 4 = back, 8 = left side, 16 = output connected.
 * Higher bits (32, 64, 128) also appear; their meaning is unknown and they are left 0.
 */
import { beltPieceFor } from "../belt-pieces";
import { rotateSide, SIDES, type Rotation } from "../footprint";
import type { Side } from "../types";

export const BAI = { FRONT: 1, RIGHT: 2, BACK: 4, LEFT: 8, OUT_CONNECTED: 16 } as const;

/** Rotation of a plain belt whose output points to `out` */
export function beltRotationFor(out: Side): Rotation {
    return ((SIDES.indexOf(out) - SIDES.indexOf("right") + 4) % 4) as Rotation;
}

export function beltOutput(rot: Rotation): Side {
    return rotateSide("right", rot);
}

/** BaseActiveIndex for a plain belt fed from `ins` */
export function beltActiveIndex(out: Side, ins: Side[], outConnected: boolean): number {
    let bits = outConnected ? BAI.OUT_CONNECTED : 0;
    for (const s of ins) {
        if (s === rotateSide(out, 2)) bits |= BAI.BACK;
        else if (s === rotateSide(out, 1)) bits |= BAI.RIGHT;
        else if (s === rotateSide(out, 3)) bits |= BAI.LEFT;
        else bits |= BAI.FRONT;
    }
    return bits;
}

/** Input sides recorded in a plain belt's BaseActiveIndex (front ignored) */
export function beltInputs(rot: Rotation, activeIndex: number): Side[] {
    const out = beltOutput(rot);
    const ins: Side[] = [];
    if (activeIndex & BAI.BACK) ins.push(rotateSide(out, 2));
    if (activeIndex & BAI.RIGHT) ins.push(rotateSide(out, 1));
    if (activeIndex & BAI.LEFT) ins.push(rotateSide(out, 3));
    return ins;
}

/** The app's fixed belt piece for a plain blueprint belt (straight from behind when unknown) */
export function beltPieceForBlueprint(rot: Rotation, activeIndex: number): { id: string; rot: Rotation } {
    const out = beltOutput(rot);
    const ins = beltInputs(rot, activeIndex);
    return (ins.length && beltPieceFor(ins, [out])) || beltPieceFor([rotateSide(out, 2)], [out])!;
}
