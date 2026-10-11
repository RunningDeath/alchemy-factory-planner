/**
 * Blueprint grid conventions.
 *
 * The game positions a building by its grid group: `BaseArea` (the building's base
 * rectangle from its origin cell towards +x/+y, unrotated), rotated by `GridRotation`
 * into `GridArea`, whose min corner is `Pivot`. Cells the building has at negative
 * offsets from its origin (beams extend towards -y) lie outside that rectangle.
 * The app instead places the min corner of the whole rotated footprint.
 *
 * Both rotate the same way: quarter turns clockwise seen from above with +y = Bottom,
 * NoRotation / ClockWise / CentralSymmetry / CounterClockWise = rot 0 / 1 / 2 / 3.
 */
import type { Rotation } from "../footprint";
import type { BuildingFootprint } from "../types";

export const GRID_ROTATIONS = [
    "EGridRotation::NoRotation",
    "EGridRotation::ClockWise",
    "EGridRotation::CentralSymmetry",
    "EGridRotation::CounterClockWise",
] as const;

/** Cells are 25 UE units in every axis */
export const CELL = 25;

export function rotationFromEnum(value: string): Rotation {
    const i = GRID_ROTATIONS.indexOf(value as (typeof GRID_ROTATIONS)[number]);
    if (i < 0) throw new Error(`unknown grid rotation ${value}`);
    return i as Rotation;
}

/** Rotates a cell inside an sx × sy rectangle (same formula as footprint.rotatePoint) */
function rotateIn(x: number, y: number, sx: number, sy: number, rot: Rotation): [number, number] {
    switch (rot) {
        case 1:
            return [sy - 1 - y, x];
        case 2:
            return [sx - 1 - x, sy - 1 - y];
        case 3:
            return [y, sx - 1 - x];
        default:
            return [x, y];
    }
}

function origin(fp: BuildingFootprint): [number, number, number] {
    return fp.origin ?? [0, 0, 0];
}

/** The game's BaseArea: from the origin cell to the far edge of the footprint */
export function baseArea(fp: BuildingFootprint): [number, number] {
    const [ox, oy] = origin(fp);
    return [fp.size.x - ox, fp.size.y - oy];
}

export function gridArea(base: [number, number], rot: Rotation): [number, number] {
    return rot % 2 === 0 ? [base[0], base[1]] : [base[1], base[0]];
}

/**
 * Offset from the blueprint pivot to the app placement (min corner of the rotated
 * footprint). Any footprint cell maps to the same world cell both ways.
 */
function pivotToPlacement(fp: BuildingFootprint, base: [number, number], rot: Rotation): [number, number] {
    const [ox, oy] = origin(fp);
    const game = rotateIn(-ox, -oy, base[0], base[1], rot); // footprint cell 0,0 seen from the pivot
    const app = rotateIn(0, 0, fp.size.x, fp.size.y, rot); // the same cell seen from the placement
    return [game[0] - app[0], game[1] - app[1]];
}

export function placementFromPivot(
    fp: BuildingFootprint,
    rot: Rotation,
    pivot: [number, number, number],
    base: [number, number] = baseArea(fp),
): { x: number; y: number; z: number } {
    const [dx, dy] = pivotToPlacement(fp, base, rot);
    return { x: pivot[0] + dx, y: pivot[1] + dy, z: pivot[2] - origin(fp)[2] };
}

export function pivotFromPlacement(fp: BuildingFootprint, p: { x: number; y: number; z: number; rot: Rotation }): [number, number, number] {
    const [dx, dy] = pivotToPlacement(fp, baseArea(fp), p.rot);
    return [p.x - dx, p.y - dy, p.z + origin(fp)[2]];
}

/** World position the game stores for a building: centre of its grid area, at its base */
export function buildPos(parentPivot: number[], pivot: number[], area: [number, number]): [number, number, number] {
    return [
        (parentPivot[0] + pivot[0] + area[0] / 2) * CELL,
        (parentPivot[1] + pivot[1] + area[1] / 2) * CELL,
        (parentPivot[2] + pivot[2]) * CELL,
    ];
}
