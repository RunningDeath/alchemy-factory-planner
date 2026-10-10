/**
 * Editing operations for module layouts. All return new arrays.
 */
import { beltPieceFor, isBeltPiece } from "./belt-pieces";
import { getFootprint, type Rotation } from "./footprint";
import { buildOccupancy, cellKey, cellsCollide, placementCells, type Placement } from "./layout";
import type { Side } from "./types";

export type PlaceResult =
    | { ok: true; placements: Placement[] }
    | { ok: false; reason: "collision" | "unknown"; blockedBy?: string };

/**
 * Adds a building. Belt pieces replace belt pieces they overlap (like redrawing a belt
 * in game); anything else that collides blocks the placement.
 */
export function placeBuilding(placements: Placement[], next: Placement): PlaceResult {
    if (!getFootprint(next.id)) return { ok: false, reason: "unknown" };
    const occupancy = buildOccupancy(placements);
    const replace = new Set<string>();
    const byUid = new Map(placements.map((p) => [p.uid, p]));

    for (const c of placementCells(next)) {
        for (const other of occupancy.get(cellKey(c.x, c.y, c.z)) ?? []) {
            if (!cellsCollide(c, other)) continue;
            if (isBeltPiece(next.id) && isBeltPiece(byUid.get(other.uid)!.id)) replace.add(other.uid);
            else return { ok: false, reason: "collision", blockedBy: other.uid };
        }
    }
    return { ok: true, placements: [...placements.filter((p) => !replace.has(p.uid)), next] };
}

/** What occupies a cell, most specific first: machines and belts before structures and floors */
export function placementsAt(placements: Placement[], x: number, y: number, z: number): Placement[] {
    const rank = (p: Placement) => {
        const category = getFootprint(p.id)?.category;
        return category === "floor" ? 2 : category === "structure" ? 1 : 0;
    };
    return placements
        .filter((p) => placementCells(p).some((c) => c.x === x && c.y === y && c.z === z))
        .sort((a, b) => rank(a) - rank(b));
}

export function removePlacement(placements: Placement[], uid: string): Placement[] {
    return placements.filter((p) => p.uid !== uid);
}

/** Turns a building a quarter turn clockwise around its anchor */
export function rotatePlacement(placements: Placement[], uid: string): Placement[] {
    return placements.map((p) => (p.uid === uid ? { ...p, rot: ((p.rot + 1) % 4) as Rotation } : p));
}

/** Switches to the building's alternative build option (mirrored machine, other belt shape, ...) */
export function cycleVariant(id: string): string {
    return getFootprint(id)?.alt ?? id;
}

function sideTowards(from: [number, number], to: [number, number]): Side {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    if (dx > 0) return "right";
    if (dx < 0) return "left";
    return dy > 0 ? "down" : "up";
}

/**
 * Belt pieces for a drawn path of neighbouring cells (in drawing order). Each cell
 * takes items in from the previous cell and passes them to the next; the ends
 * continue straight.
 */
export function beltPath(path: [number, number][], z: number, makeUid: () => string): Placement[] {
    const pieces: Placement[] = [];
    for (let i = 0; i < path.length; i++) {
        const cell = path[i];
        const prev = path[i - 1];
        const next = path[i + 1];
        const out = next ? sideTowards(cell, next) : prev ? sideTowards(prev, cell) : "right";
        const inFrom = prev ? sideTowards(cell, prev) : next ? opposite(sideTowards(cell, next)) : "left";
        const piece = beltPieceFor([inFrom], [out]);
        if (!piece) continue;
        pieces.push({ uid: makeUid(), id: piece.id, x: cell[0], y: cell[1], z, rot: piece.rot });
    }
    return pieces;
}

function opposite(side: Side): Side {
    return ({ left: "right", right: "left", up: "down", down: "up" } as const)[side];
}

/** Grid cells from a to b: along x first, then y (an L-shaped belt run) */
export function lPath(a: [number, number], b: [number, number]): [number, number][] {
    const cells: [number, number][] = [];
    const stepX = Math.sign(b[0] - a[0]);
    const stepY = Math.sign(b[1] - a[1]);
    for (let x = a[0]; x !== b[0]; x += stepX) cells.push([x, a[1]]);
    for (let y = a[1]; y !== b[1]; y += stepY) cells.push([b[0], y]);
    cells.push([b[0], b[1]]);
    return cells;
}
