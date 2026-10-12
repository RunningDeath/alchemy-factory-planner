/**
 * Footprint lookup and rotation.
 *
 * Rotation is in quarter turns clockwise as seen from above, with +y pointing "down"
 * (the game's Bottom side): east (+x) turns to south (+y), left → up → right → down.
 */
import footprintData from "../../data/building-footprints.json";
import type { BuildingFootprint, FootprintCell, FootprintPort, Side, VerticalFace } from "./types";

export type Rotation = 0 | 1 | 2 | 3;

const FOOTPRINTS = footprintData as BuildingFootprint[];
const BY_ID = new Map(FOOTPRINTS.map((f) => [f.id, f]));

export const SIDES: Side[] = ["left", "up", "right", "down"];

export const SIDE_OFFSET: Record<Side, [number, number]> = {
    left: [-1, 0],
    up: [0, -1],
    right: [1, 0],
    down: [0, 1],
};

export function getAllFootprints(): BuildingFootprint[] {
    return FOOTPRINTS;
}

export function getFootprint(id: string): BuildingFootprint | undefined {
    return BY_ID.get(id);
}

/** Adds a footprint the generator made up (machine pairs, see pairs.ts); not a real building */
export function registerFootprint(fp: BuildingFootprint): void {
    BY_ID.set(fp.id, fp);
}

export function rotateSide(side: Side, rot: Rotation): Side {
    return SIDES[(SIDES.indexOf(side) + rot) % 4];
}

export function oppositeSide(side: Side): Side {
    return rotateSide(side, 2);
}

export function rotateFace(face: Side | VerticalFace, rot: Rotation): Side | VerticalFace {
    return face === "top" || face === "base" ? face : rotateSide(face, rot);
}

/** Quadrant bits NW=1, NE=2, SE=4, SW=8 move one step clockwise per quarter turn */
export function rotateQuads(quads: number, rot: Rotation): number {
    let q = quads & 15;
    for (let i = 0; i < rot; i++) q = ((q << 1) | (q >> 3)) & 15;
    return q;
}

/** Footprint size on the ground after rotation */
export function rotatedSize(fp: BuildingFootprint, rot: Rotation): { x: number; y: number; z: number } {
    return rot % 2 === 0 ? fp.size : { x: fp.size.y, y: fp.size.x, z: fp.size.z };
}

/** Rotates a local cell position inside the footprint's bounding box */
export function rotatePoint(x: number, y: number, fp: BuildingFootprint, rot: Rotation): [number, number] {
    const { x: sx, y: sy } = fp.size;
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

const cellCache = new Map<string, FootprintCell[]>();

/** All occupied cells of a footprint in local (rotated) coordinates */
export function footprintCells(fp: BuildingFootprint, rot: Rotation = 0): FootprintCell[] {
    const key = `${fp.id}:${rot}`;
    const cached = cellCache.get(key);
    if (cached) return cached;

    const cells: FootprintCell[] = [];
    for (const box of fp.boxes) {
        const { min, max, ...occupation } = box;
        for (let x = min[0]; x <= max[0]; x++)
            for (let y = min[1]; y <= max[1]; y++)
                for (let z = min[2]; z <= max[2]; z++) {
                    const [rx, ry] = rotatePoint(x, y, fp, rot);
                    cells.push({ ...occupation, x: rx, y: ry, z, quads: rotateQuads(occupation.quads, rot) });
                }
    }
    cellCache.set(key, cells);
    return cells;
}

/** One cell tall, every cell carries what's above and needs support: grinder-sized machines that stack directly */
export function isDirectlyStackable(fp: BuildingFootprint): boolean {
    return fp.size.z === 1 && footprintCells(fp).every((c) => c.stackable && c.foundation);
}

const MACHINE_CATEGORIES = new Set(["production", "portal", "storage"]);

/**
 * Whether `supporter` can carry what stands on it. Of the machines only grinder-sized
 * ones carry anything; player blueprints rest machines on grinders (fully or partly),
 * lab stands, beams, wood blocks and the stove, never on other machines.
 */
export function canSupport(supporter: BuildingFootprint, carried?: BuildingFootprint): boolean {
    // Pipes hang freely and carry nothing
    if (supporter.category === "pipe") return false;
    if (carried && carried.id === supporter.id && STACKS_ON_ITSELF.has(supporter.id)) return true;
    return !MACHINE_CATEGORIES.has(supporter.category) || isDirectlyStackable(supporter);
}

/** Machines that stack on their own kind: cauldrons share one heating pad that way */
export const STACKS_ON_ITSELF = new Set(["cauldron", "advanced-cauldron"]);

/** Machines that need heat from below although the game lists no heat cost for them (cauldrons) */
export const HEATED_MACHINES = new Set(["cauldron", "advanced-cauldron"]);

/** Heated production machine: stands on a heating device (or, for cauldrons, on a heated cauldron) */
export function needsHeat(fp: BuildingFootprint): boolean {
    return fp.category === "production" && (!!fp.heatCost || HEATED_MACHINES.has(fp.id));
}

/** Ports in local (rotated) coordinates */
export function footprintPorts(fp: BuildingFootprint, rot: Rotation = 0): FootprintPort[] {
    return fp.ports.map((p) => {
        const [x, y] = rotatePoint(p.x, p.y, fp, rot);
        return { ...p, x, y, face: rotateFace(p.face, rot) };
    });
}
