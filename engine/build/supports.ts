/**
 * Supports under raised belts and beams: lab stands (they share a cell with a belt)
 * or wood blocks, stacked down to the ground or the first stackable cell.
 */
import { canSupport, getFootprint } from "./footprint";
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

/** Something under (x, y, z) a belt or support can stand on (most machines can't carry a load) */
export function isSupported(occupancy: Occupancy, x: number, y: number, z: number, groundZ = 0): boolean {
    if (z <= groundZ) return true;
    return (occupancy.get(cellKey(x, y, z - 1)) ?? []).some((c) => c.stackable && c.quads === 15 && canSupport(getFootprint(c.id)!));
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
        // Lab stands while routing: belts can still pass through their cell. preferBlocks()
        // swaps the ones nobody shares for wood blocks afterwards
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

const SUPPORT_IDS = new Set([FRAME_ID, BLOCK_ID]);
/** Wooden beams (the steel ones cost steel ingots); they need support at both ends only */
const WOOD_BEAMS: [number, string][] = [
    [5, "beam5"],
    [3, "beam3"],
];

function isBeltPieceId(id: string): boolean {
    return id === "belt" || id.startsWith("belt-fixed");
}

interface Point {
    x: number;
    y: number;
    z: number;
}

/** Cells (above the first level) that something stands on a pillar with: belts and beam ends */
function carriedCells(placements: Placement[]): Point[] {
    const points = new Map<string, Point>();
    for (const p of placements) {
        const belt = isBeltPieceId(p.id);
        if (!belt && !p.id.startsWith("beam")) continue;
        for (const c of placementCells(p)) {
            if (c.z <= 1 || (!belt && !c.foundation)) continue;
            points.set(cellKey(c.x, c.y, c.z), { x: c.x, y: c.y, z: c.z });
        }
    }
    return [...points.values()];
}

/**
 * Replaces pillars under straight raised belt runs with a wooden beam: the beam lies
 * right under the belts, its ends rest on the end pillars, and the pillars under the
 * middle of the run go away. Cheaper on longer drops, and the open space between the
 * pillars keeps the build readable.
 */
export function beamsUnderRuns(placements: Placement[], makeUid: () => string): Placement[] {
    let current = placements;
    const occupancyOf = (list: Placement[]) => {
        const occ: Occupancy = new Map();
        list.forEach((p) => addToOccupancy(occ, p));
        return occ;
    };
    let occupancy = occupancyOf(current);
    const byUid = () => new Map(current.map((p) => [p.uid, p]));

    /** The single-cell supports directly under (x, y, z), from z-1 down to whatever they stand on */
    const columnUnder = (x: number, y: number, z: number, uids: Map<string, Placement>): Placement[] | null => {
        const column: Placement[] = [];
        for (let cz = z - 1; cz >= 0; cz--) {
            const occupants = occupancy.get(cellKey(x, y, cz)) ?? [];
            const supports = occupants.map((o) => uids.get(o.uid)!).filter((p) => p && SUPPORT_IDS.has(p.id));
            if (supports.length === 0) break;
            // Something else shares the cell (a lower belt next to a lab stand): the column ends here
            if (occupants.some((o) => !SUPPORT_IDS.has(uids.get(o.uid)?.id ?? ""))) return cz === z - 1 ? null : column;
            column.push(...supports);
        }
        return column.length ? column : null;
    };

    for (const axis of ["x", "y"] as const) {
        // Raised cells that stand on a pillar: belts, and the ends of deck beams under machines.
        // Rows of these become straight runs a beam can carry instead
        const raised = carriedCells(current);
        const keyOf = (p: Point) => (axis === "x" ? `${p.y},${p.z}` : `${p.x},${p.z}`);
        const groups = new Map<string, Point[]>();
        raised.forEach((p) => groups.set(keyOf(p), [...(groups.get(keyOf(p)) ?? []), p]));

        for (const line of groups.values()) {
            line.sort((a, b) => (axis === "x" ? a.x - b.x : a.y - b.y));
            let run: Point[] = [];
            const flush = () => {
                let i = 0;
                while (i < run.length) {
                    let placed = false;
                    for (const [length, beamId] of WOOD_BEAMS) {
                        if (i + length > run.length) continue;
                        const cells = run.slice(i, i + length);
                        const uids = byUid();
                        const columns = cells.map((b) => columnUnder(b.x, b.y, b.z, uids));
                        if (columns.some((c) => !c)) continue;
                        // Middle pillars go entirely; at the ends only the top piece makes room for the beam
                        const removed = new Set<string>();
                        columns.forEach((col, k) => {
                            const ends = k === 0 || k === length - 1;
                            (ends ? col!.slice(0, 1) : col!).forEach((p) => removed.add(p.uid));
                        });
                        // Worth it once a middle pillar goes: open space under the run is easier to see through and walk past
                        if (removed.size <= 2) continue;
                        const first = cells[0];
                        const beam: Placement = { uid: makeUid(), id: beamId, x: first.x, y: first.y, z: first.z - 1, rot: axis === "x" ? 1 : 0 };
                        const next = [...current.filter((p) => !removed.has(p.uid)), beam];
                        const nextOcc = occupancyOf(next);
                        // The beam must fit and its ends must still be carried
                        const beamCells = placementCells(beam);
                        const fits = beamCells.every((c) => (nextOcc.get(cellKey(c.x, c.y, c.z)) ?? []).every((o) => o.uid === beam.uid || !cellsCollide(c, o)));
                        const carried = [cells[0], cells[length - 1]].every((b) => isSupported(nextOcc, b.x, b.y, b.z - 1));
                        if (!fits || !carried) continue;
                        current = next;
                        occupancy = nextOcc;
                        i += length;
                        placed = true;
                        break;
                    }
                    if (!placed) i++;
                }
                run = [];
            };
            for (const b of line) {
                const prev = run[run.length - 1];
                const adjacent = prev && (axis === "x" ? b.x === prev.x + 1 : b.y === prev.y + 1);
                if (!adjacent) flush();
                run.push(b);
            }
            flush();
        }
    }
    return current;
}

/**
 * Removes supports nothing stands on any more (left over after belts were re-routed or
 * blocks moved), top down so whole columns go.
 */
export function pruneSupports(placements: Placement[]): Placement[] {
    let current = placements;
    for (;;) {
        const carried = new Set<string>();
        for (const p of current)
            for (const c of placementCells(p)) if (c.foundation) carried.add(cellKey(c.x, c.y, c.z - 1));
        const next = current.filter((p) => !SUPPORT_IDS.has(p.id) || carried.has(cellKey(p.x, p.y, p.z)));
        if (next.length === current.length) return current;
        current = next;
    }
}

/**
 * Lab stands that don't share their cell with a belt become wood blocks: same support,
 * cheaper (no nails). Run after routing, when no belt needs to pass any more.
 */
export function preferBlocks(placements: Placement[]): Placement[] {
    const occupancy: Occupancy = new Map();
    placements.forEach((p) => addToOccupancy(occupancy, p));
    return placements.map((p) => {
        if (p.id !== FRAME_ID) return p;
        const shared = (occupancy.get(cellKey(p.x, p.y, p.z)) ?? []).some((o) => o.uid !== p.uid);
        return shared ? p : { ...p, id: BLOCK_ID };
    });
}
