/**
 * Supports under raised belts and beams: lab stands (they share a cell with a belt)
 * or wood blocks, stacked down to the ground or the first stackable cell.
 */
import { cellKey, cellsCollide, placementCells, type Placement, type WorldCell } from "./layout";

const FRAME_ID = "frame-single";
const BLOCK_ID = "wood-block";

export type Occupancy = Map<string, WorldCell[]>;

export function addToOccupancy(occupancy: Occupancy, p: Placement): void {
    for (const c of placementCells(p)) {
        const key = cellKey(c.x, c.y, c.z);
        const list = occupancy.get(key);
        if (list) list.push(c);
        else occupancy.set(key, [c]);
    }
}

/** Something under (x, y, z) a belt or support can stand on */
export function isSupported(occupancy: Occupancy, x: number, y: number, z: number, groundZ = 0): boolean {
    if (z <= groundZ) return true;
    return (occupancy.get(cellKey(x, y, z - 1)) ?? []).some((c) => c.stackable && c.quads === 15);
}

function fits(occupancy: Occupancy, p: Placement): boolean {
    return placementCells(p).every((c) => (occupancy.get(cellKey(c.x, c.y, c.z)) ?? []).every((o) => !cellsCollide(c, o)));
}

/**
 * Supports from just below z down to the ground or the first stackable cell. Adds them
 * to the occupancy. Stops early (leaving the cell unsupported) when something is in the way.
 */
export function supportColumn(occupancy: Occupancy, x: number, y: number, z: number, groundZ: number, makeUid: () => string): Placement[] {
    const added: Placement[] = [];
    for (let fz = z - 1; fz >= groundZ; fz--) {
        if (isSupported(occupancy, x, y, fz + 1, groundZ)) break;
        const support = [FRAME_ID, BLOCK_ID]
            .map((id): Placement => ({ uid: makeUid(), id, x, y, z: fz, rot: 0 }))
            .find((p) => fits(occupancy, p));
        if (!support) break;
        addToOccupancy(occupancy, support);
        added.push(support);
    }
    return added;
}

/** How many supports a cell at z would need, or null if they can't be placed */
export function supportCost(occupancy: Occupancy, x: number, y: number, z: number, groundZ = 0): number | null {
    let count = 0;
    for (let fz = z - 1; fz >= groundZ; fz--) {
        if (isSupported(occupancy, x, y, fz + 1, groundZ)) return count;
        // A lab stand uses the top and side layers of the cell
        const blocked = (occupancy.get(cellKey(x, y, fz)) ?? []).some((o) => (o.layers & 12) !== 0);
        if (blocked) return null;
        count++;
    }
    return count;
}
