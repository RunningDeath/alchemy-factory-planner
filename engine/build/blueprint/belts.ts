/**
 * Belts in blueprints.
 *
 * Player blueprints only use the plain conveyor "Belt" (secondary type Belt), for straight
 * runs, turns, merges and splits alike. GridRotation gives the belt's front (NoRotation = +x,
 * like BeltFixed) and BaseActiveIndex records the connected sides relative to that front:
 * the low four bits are inputs, the high four bits outputs. Checked against the neighbours
 * of 429 belts in 18 player blueprints.
 */
import { beltPieceFor } from "../belt-pieces";
import { rotateSide, SIDES, type Rotation } from "../footprint";
import type { Side } from "../types";

export const BAI = { FRONT: 1, RIGHT: 2, BACK: 4, LEFT: 8 } as const;
/** Output bits are the input bits shifted by four */
const OUT_SHIFT = 4;

/** Rotation of a plain belt whose front points to `front` */
export function beltRotationFor(front: Side): Rotation {
    return ((SIDES.indexOf(front) - SIDES.indexOf("right") + 4) % 4) as Rotation;
}

export function beltOutput(rot: Rotation): Side {
    return rotateSide("right", rot);
}

function sideBit(front: Side, side: Side): number {
    if (side === front) return BAI.FRONT;
    if (side === rotateSide(front, 1)) return BAI.RIGHT;
    if (side === rotateSide(front, 2)) return BAI.BACK;
    return BAI.LEFT;
}

function sidesOf(front: Side, bits: number): Side[] {
    return ([0, 1, 2, 3] as Rotation[]).filter((r) => bits & (1 << r)).map((r) => rotateSide(front, r));
}

/** BaseActiveIndex for a plain belt with its front at `front`, fed from `ins`, sending to the connected `outs` */
export function beltActiveIndex(front: Side, ins: Side[], outs: Side[]): number {
    let bits = 0;
    for (const s of ins) bits |= sideBit(front, s);
    for (const s of outs) bits |= sideBit(front, s) << OUT_SHIFT;
    return bits;
}

/** Input sides recorded in a plain belt's BaseActiveIndex */
export function beltInputs(rot: Rotation, activeIndex: number): Side[] {
    return sidesOf(beltOutput(rot), activeIndex & 0xf);
}

/** Output sides recorded in a plain belt's BaseActiveIndex */
export function beltOutputs(rot: Rotation, activeIndex: number): Side[] {
    return sidesOf(beltOutput(rot), (activeIndex >> OUT_SHIFT) & 0xf);
}

/**
 * Front for a belt with these sides: straight through when it can be, so plain runs
 * look like the game's own (input at the back, output at the front)
 */
export function beltFront(ins: Side[], outs: Side[]): Side {
    return outs.find((o) => ins.includes(rotateSide(o, 2))) ?? outs[0];
}

/** The app's fixed belt piece for a plain blueprint belt (straight from behind when unknown) */
export function beltPieceForBlueprint(rot: Rotation, activeIndex: number): { id: string; rot: Rotation } {
    const front = beltOutput(rot);
    const ins = beltInputs(rot, activeIndex).filter((s) => s !== front);
    const outs = beltOutputs(rot, activeIndex);
    const pieceOuts = outs.length ? outs : [front];
    const pieceIns = ins.filter((s) => !pieceOuts.includes(s));
    return (pieceIns.length && beltPieceFor(pieceIns, pieceOuts)) || beltPieceFor([rotateSide(front, 2)], [front])!;
}
