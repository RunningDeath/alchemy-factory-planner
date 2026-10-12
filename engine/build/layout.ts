/**
 * A module layout: buildings placed on the cell grid, plus the game's placement rules.
 *
 * - Collision: two buildings may share a cell only if they use different layers or
 *   different quadrants of it.
 * - Support: a cell marked as foundation needs the ground (z = 0) or a stackable cell
 *   of another building directly below it.
 * - Ports connect when two neighbouring cells face each other with matching directions.
 */
import { canSupport, footprintCells, footprintPorts, getFootprint, needsHeat, oppositeSide, SIDE_OFFSET, STACKS_ON_ITSELF, type Rotation } from "./footprint";
import type { FootprintCell, FootprintPort, Side, VerticalFace } from "./types";

export interface Placement {
    uid: string;
    /** Building id from building-footprints.json */
    id: string;
    x: number;
    y: number;
    z: number;
    rot: Rotation;
    /** Plan node this building belongs to (production machines) */
    nodeKey?: string;
    /** What a belt carries, for display */
    label?: string;
    /** Generated belt lanes: feeding machines or collecting their output */
    lane?: "in" | "out" | "route";
    /** Generated block (index into the module's tiers) this building belongs to */
    block?: number;
    /** Open end of a generated lane: where items enter (in) or leave (out) the block */
    laneEnd?: { kind: "in" | "out"; items: { itemName: string; rate: number }[] };
    /** Fluid this building takes in or gives out through its pipe ports */
    pipeEnd?: { kind: "in" | "out"; items: { itemName: string; rate: number }[] };
    /** Filters: the item sent to the lower output (tall filter) or the side output (flat filter); everything else takes the other */
    filterItem?: string;
    /** Purchasing portals: the item bought */
    supplyItem?: string;
    /** The box the player fills with fertilizer once to start the module (shown red) */
    starterBox?: boolean;
    /** Plain pipes: the sides they connect ("top"/"base" for up and down) */
    pipeSides?: (Side | VerticalFace)[];
}

export interface WorldCell extends FootprintCell {
    uid: string;
    /** Building id, for support rules */
    id: string;
}

export interface WorldPort extends FootprintPort {
    uid: string;
}

export type LayoutIssue =
    | { kind: "unknown"; uid: string }
    | { kind: "underground"; uid: string }
    | { kind: "collision"; uid: string; other: string; cell: [number, number, number] }
    | { kind: "unsupported"; uid: string; cell: [number, number, number] }
    /** Heated machines must be built on a heating device ("Can only be built on heating devices") */
    | { kind: "unheated"; uid: string };

export const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

export function placementCells(p: Placement): WorldCell[] {
    const fp = getFootprint(p.id);
    if (!fp) return [];
    return footprintCells(fp, p.rot).map((c) => ({ ...c, x: c.x + p.x, y: c.y + p.y, z: c.z + p.z, uid: p.uid, id: p.id }));
}

export function placementPorts(p: Placement): WorldPort[] {
    const fp = getFootprint(p.id);
    if (!fp) return [];
    return footprintPorts(fp, p.rot).map((port) => ({ ...port, x: port.x + p.x, y: port.y + p.y, z: port.z + p.z, uid: p.uid }));
}

/** Cell → everything occupying it */
export function buildOccupancy(placements: Placement[]): Map<string, WorldCell[]> {
    const map = new Map<string, WorldCell[]>();
    for (const p of placements) {
        for (const c of placementCells(p)) {
            const key = cellKey(c.x, c.y, c.z);
            const list = map.get(key);
            if (list) list.push(c);
            else map.set(key, [c]);
        }
    }
    return map;
}

export function cellsCollide(a: FootprintCell, b: FootprintCell): boolean {
    return (a.layers & b.layers) !== 0 && (a.quads & b.quads) !== 0;
}

/** Issues for the given placement against everything else in the occupancy map */
export function placementIssues(p: Placement, occupancy: Map<string, WorldCell[]>): LayoutIssue[] {
    if (!getFootprint(p.id)) return [{ kind: "unknown", uid: p.uid }];
    const cells = placementCells(p);
    const issues: LayoutIssue[] = [];
    if (cells.some((c) => c.z < 0)) issues.push({ kind: "underground", uid: p.uid });

    const own = new Set(cells.map((c) => cellKey(c.x, c.y, c.z)));
    const collidedWith = new Set<string>();
    let unsupported: LayoutIssue | null = null;

    for (const c of cells) {
        for (const other of occupancy.get(cellKey(c.x, c.y, c.z)) ?? []) {
            if (other.uid === p.uid || collidedWith.has(other.uid) || !cellsCollide(c, other)) continue;
            collidedWith.add(other.uid);
            issues.push({ kind: "collision", uid: p.uid, other: other.uid, cell: [c.x, c.y, c.z] });
        }

        // Only the bottom of each column needs support; cells above rest on the building itself
        if (!unsupported && c.foundation && c.z > 0 && !own.has(cellKey(c.x, c.y, c.z - 1))) {
            const below = occupancy.get(cellKey(c.x, c.y, c.z - 1)) ?? [];
            const supported = below.some(
                (b) => b.uid !== p.uid && b.stackable && (b.quads & c.quads) !== 0 && canSupport(getFootprint(b.id)!, getFootprint(p.id)),
            );
            if (!supported) unsupported = { kind: "unsupported", uid: p.uid, cell: [c.x, c.y, c.z] };
        }
    }
    if (unsupported) issues.push(unsupported);

    const fp = getFootprint(p.id)!;
    if (needsHeat(fp)) {
        const bottom = Math.min(...cells.map((c) => c.z));
        // Cauldrons stacked on a cauldron share its heat
        const heatsFrom = (id: string) => getFootprint(id)?.category === "heating" || (STACKS_ON_ITSELF.has(fp.id) && id === fp.id);
        const heated = cells
            .filter((c) => c.z === bottom && c.foundation)
            .every((c) => (occupancy.get(cellKey(c.x, c.y, c.z - 1)) ?? []).some((b) => b.uid !== p.uid && heatsFrom(b.id)));
        if (!heated) issues.push({ kind: "unheated", uid: p.uid });
    }
    return issues;
}

export function validateLayout(placements: Placement[]): LayoutIssue[] {
    const occupancy = buildOccupancy(placements);
    return placements.flatMap((p) => placementIssues(p, occupancy));
}

/** Neighbour cell a port points at */
export function portTarget(port: FootprintPort): [number, number, number] {
    if (port.face === "top") return [port.x, port.y, port.z + 1];
    if (port.face === "base") return [port.x, port.y, port.z - 1];
    const [dx, dy] = SIDE_OFFSET[port.face];
    return [port.x + dx, port.y + dy, port.z];
}

function facesBack(port: FootprintPort): Side | "top" | "base" {
    if (port.face === "top") return "base";
    if (port.face === "base") return "top";
    return oppositeSide(port.face);
}

function directionsMatch(a: FootprintPort["dir"], b: FootprintPort["dir"]): boolean {
    if (a === "both" || b === "both") return true;
    return a !== b;
}

export interface PortStatus {
    port: WorldPort;
    /** Building on the other side, if connected */
    connectedTo?: string;
}

/** Connection status of every port in the layout */
export function portConnections(placements: Placement[]): PortStatus[] {
    const ports = placements.flatMap(placementPorts);
    const byCell = new Map<string, WorldPort[]>();
    for (const port of ports) {
        const key = cellKey(port.x, port.y, port.z);
        const list = byCell.get(key);
        if (list) list.push(port);
        else byCell.set(key, [port]);
    }

    return ports.map((port) => {
        const [tx, ty, tz] = portTarget(port);
        const back = facesBack(port);
        const match = (byCell.get(cellKey(tx, ty, tz)) ?? []).find(
            (other) =>
                other.uid !== port.uid &&
                other.face === back &&
                other.medium === port.medium &&
                directionsMatch(port.dir, other.dir),
        );
        return match ? { port, connectedTo: match.uid } : { port };
    });
}

export interface LayoutBounds {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
}

export function layoutBounds(placements: Placement[]): LayoutBounds | null {
    const cells = placements.flatMap(placementCells);
    if (cells.length === 0) return null;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const c of cells) {
        [c.x, c.y, c.z].forEach((v, i) => {
            min[i] = Math.min(min[i], v);
            max[i] = Math.max(max[i], v);
        });
    }
    return { min, max, size: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1] };
}

/** Total build cost per item id */
export function billOfMaterials(placements: Placement[]): Map<string, number> {
    const totals = new Map<string, number>();
    for (const p of placements) {
        for (const c of getFootprint(p.id)?.cost ?? []) totals.set(c.item, (totals.get(c.item) || 0) + c.count);
    }
    return totals;
}

/** Number of placed buildings per building id */
export function countBuildings(placements: Placement[]): Map<string, number> {
    const counts = new Map<string, number>();
    placements.forEach((p) => counts.set(p.id, (counts.get(p.id) || 0) + 1));
    return counts;
}
