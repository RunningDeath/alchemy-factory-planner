/**
 * Pipes: the cell at every pipe port of a module (extractors, blenders, the first steam
 * heater of a row) is reserved before the belts are routed. Once the belts are in, the ports
 * of one fluid join into one network through the free cells, as low as they can (pipes need
 * no support). Brine from the extractors reaches the blender that way; a fluid nobody in the
 * module makes (steam, bought brine) gets one pipe from the middle of its network straight
 * up to the module's top, where the player connects it.
 */
import { footprintCells, getFootprint, oppositeSide, SIDE_OFFSET } from "./footprint";
import { buildOccupancy, cellsCollide, placementPorts, type Placement } from "./layout";
import type { Side, VerticalFace } from "./types";

export const PIPE_ID = "pipe";

/** Machines whose pipe ports reach a neighbour's port directly (chained heaters) need no pipe there */
function portTaken(placements: Placement[], x: number, y: number, z: number, face: Side | VerticalFace): boolean {
    return placements.some((p) => placementPorts(p).some((q) => q.medium === "pipe" && q.x === x && q.y === y && q.z === z && q.face === face));
}

/** Where the pipe of a machine's pipe port starts, and the fluid it carries */
interface PipePort {
    resource: string;
    x: number;
    y: number;
    z: number;
    /** Side of the start cell that faces the port */
    toward: Side | VerticalFace;
    /** The machine takes the fluid in or gives it out */
    kind: "in" | "out";
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
type Cell = [number, number, number];
const STEPS: [number, number, number, Side | VerticalFace][] = [
    [-1, 0, 0, "left"],
    [1, 0, 0, "right"],
    [0, -1, 0, "up"],
    [0, 1, 0, "down"],
    [0, 0, 1, "top"],
    [0, 0, -1, "base"],
];
const opposite = (side: Side | VerticalFace): Side | VerticalFace => (side === "top" ? "base" : side === "base" ? "top" : oppositeSide(side));

/** The pipe ports needing a pipe: a steam heater needs one of its two sides, other machines every pipe port */
function pipePorts(placements: Placement[], cellFree: (x: number, y: number, z: number) => boolean): PipePort[] {
    const ports: PipePort[] = [];
    const heaters: PipePort[][] = [];
    for (const p of placements) {
        const fp = getFootprint(p.id);
        if (!fp || (fp.category !== "production" && fp.category !== "heating")) continue;
        const resource = p.pipeEnd?.items[0]?.itemName;
        // Heaters after the first of a row get their steam from the neighbour
        if (!resource) continue;
        const kind = p.pipeEnd?.kind ?? "in";
        const options: PipePort[] = [];
        for (const q of placementPorts(p).filter((q) => q.medium === "pipe" && q.face !== "base")) {
            if (q.face === "top") {
                options.push({ resource, kind, x: q.x, y: q.y, z: q.z + 1, toward: "base" });
                continue;
            }
            const face = q.face as Side;
            const [dx, dy] = SIDE_OFFSET[face];
            if (portTaken(placements, q.x + dx, q.y + dy, q.z, oppositeSide(face))) continue;
            options.push({ resource, kind, x: q.x + dx, y: q.y + dy, z: q.z, toward: oppositeSide(face) });
        }
        const usable = options.filter((o) => cellFree(o.x, o.y, o.z));
        if (p.id === "steam-heater") heaters.push(usable);
        else ports.push(...usable);
    }
    // A heater takes the side nearest another port of its fluid: two heaters face each other
    for (const options of heaters) {
        const others = [...ports, ...heaters.filter((o) => o !== options).flat()].filter((o) => o.resource === options[0]?.resource);
        const near = (o: PipePort) => Math.min(Infinity, ...others.map((q) => Math.abs(q.x - o.x) + Math.abs(q.y - o.y) + Math.abs(q.z - o.z)));
        const best = [...options].sort((a, b) => near(a) - near(b))[0];
        if (best) ports.push(best);
    }
    return ports;
}

/** Placeholders on the cells at the pipe ports, so belts leave them free (see layPipes) */
export function reservePipeCells(placements: Placement[], makeUid: () => string): Placement[] {
    const occupancy = buildOccupancy(placements);
    const reserved = new Set<string>();
    const free = (x: number, y: number, z: number) => !occupancy.get(key(x, y, z))?.length && !reserved.has(key(x, y, z));
    const ports = pipePorts(placements, free);
    const out: Placement[] = [];
    const reserve = (x: number, y: number, z: number, resource: string) => {
        if (reserved.has(key(x, y, z))) return;
        reserved.add(key(x, y, z));
        out.push({ uid: makeUid(), id: PIPE_ID, x, y, z, rot: 0, pipeSides: [], label: resource });
    };
    ports.forEach((port) => reserve(port.x, port.y, port.z, port.resource));
    // Ports of one fluid in a straight free line (heaters side by side): the pipe between them too
    for (const a of ports)
        for (const b of ports) {
            if (a === b || a.resource !== b.resource || a.z !== b.z || (a.x !== b.x && a.y !== b.y)) continue;
            const cells: [number, number][] = [];
            const [dx, dy] = [Math.sign(b.x - a.x), Math.sign(b.y - a.y)];
            for (let x = a.x + dx, y = a.y + dy; x !== b.x || y !== b.y; x += dx, y += dy) cells.push([x, y]);
            if (cells.length <= MAX_DIRECT_PIPE && cells.every(([x, y]) => free(x, y, a.z) || reserved.has(key(x, y, a.z)))) cells.forEach(([x, y]) => reserve(x, y, a.z, a.resource));
        }
    return out;
}

/** Longest straight pipe kept free between two ports before the belts are routed */
const MAX_DIRECT_PIPE = 6;

/**
 * The pipe networks for a routed layout (its pipe placeholders are replaced): per fluid, the
 * ports join through free cells, low ones first; see the file comment
 */
export function layPipes(input: Placement[], maxHeight: number, makeUid: () => string): Placement[] {
    const placements = input.filter((p) => p.id !== PIPE_ID);
    const occupancy = buildOccupancy(placements);
    const cells = new Map<string, { resource: string; sides: Set<Side | VerticalFace> }>();
    // A pipe shares a cell with what leaves it room (a lab stand), not with a wood block or belt
    const pipeCell = footprintCells(getFootprint(PIPE_ID)!)[0];
    const blocked = (x: number, y: number, z: number) => !!occupancy.get(key(x, y, z))?.some((c) => cellsCollide(c, pipeCell));
    const ports = pipePorts(placements, (x, y, z) => !blocked(x, y, z));
    const all = [...occupancy.keys()].map((k) => k.split(",").map(Number));
    const bounds = {
        minX: Math.min(...all.map((c) => c[0])) - 1,
        maxX: Math.max(...all.map((c) => c[0])) + 1,
        minY: Math.min(...all.map((c) => c[1])) - 1,
        maxY: Math.max(...all.map((c) => c[1])) + 1,
    };
    // Level with the module's top, not the storey's ceiling
    const top = Math.min(maxHeight - 1, Math.max(0, ...all.map((c) => c[2]), ...ports.map((p) => p.z)));
    const add = (c: Cell, resource: string, side?: Side | VerticalFace) => {
        const k = key(...c);
        const cell = cells.get(k) ?? { resource, sides: new Set() };
        if (side) cell.sides.add(side);
        cells.set(k, cell);
    };
    const link = (a: Cell, b: Cell) => {
        const step = STEPS.find(([dx, dy, dz]) => a[0] + dx === b[0] && a[1] + dy === b[1] && a[2] + dz === b[2])!;
        cells.get(key(...a))!.sides.add(step[3]);
        cells.get(key(...b))!.sides.add(opposite(step[3]));
    };
    /** Cheapest way from `from` to any cell of `targets`, through free cells; height costs a little */
    const route = (from: Cell, targets: Set<string>, resource: string): Cell[] | null => {
        const usable = (x: number, y: number, z: number) => {
            if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY || z < 0 || z > top) return false;
            const cell = cells.get(key(x, y, z));
            return !blocked(x, y, z) && (!cell || cell.resource === resource);
        };
        const dist = new Map<string, number>([[key(...from), 0]]);
        const prev = new Map<string, string>();
        // Buckets by cost (small integer costs): a simple Dijkstra
        const buckets: Cell[][] = [[from]];
        for (let d = 0; d < buckets.length && d < 4000; d++) {
            for (const c of buckets[d] ?? []) {
                const k = key(...c);
                if (dist.get(k) !== d) continue;
                if (d > 0 && targets.has(k)) {
                    const path: Cell[] = [];
                    for (let at: string | undefined = k; at; at = prev.get(at)) path.unshift(at.split(",").map(Number) as Cell);
                    return path;
                }
                for (const [dx, dy, dz] of STEPS) {
                    const n: Cell = [c[0] + dx, c[1] + dy, c[2] + dz];
                    const nk = key(...n);
                    if (!targets.has(nk) && !usable(...n)) continue;
                    // Up costs more than across: networks stay low
                    const cost = d + (dz > 0 ? 3 : 1);
                    if (cost >= (dist.get(nk) ?? Infinity)) continue;
                    dist.set(nk, cost);
                    prev.set(nk, k);
                    (buckets[cost] ??= []).push(n);
                }
            }
        }
        return null;
    };

    const byResource = new Map<string, PipePort[]>();
    for (const port of ports) byResource.set(port.resource, [...(byResource.get(port.resource) ?? []), port]);
    for (const [resource, list] of byResource) {
        for (const port of list) add([port.x, port.y, port.z], resource, port.toward);
        // Join the ports one by one to the network so far
        const tree = new Set([key(list[0].x, list[0].y, list[0].z)]);
        for (const port of list.slice(1)) {
            if (tree.has(key(port.x, port.y, port.z))) continue;
            const path = route([port.x, port.y, port.z], tree, resource);
            if (!path) continue;
            path.forEach((c, i) => {
                add(c, resource);
                tree.add(key(...c));
                if (i > 0) link(path[i - 1], c);
            });
        }
        // Fluid from outside: one pipe from the middle of the network up to the top
        if (list.every((p) => p.kind === "in")) {
            const net = [...tree].map((k) => k.split(",").map(Number) as Cell);
            const [cx, cy] = [net.reduce((s, c) => s + c[0], 0) / net.length, net.reduce((s, c) => s + c[1], 0) / net.length];
            const topCells = new Set<string>();
            for (let x = bounds.minX; x <= bounds.maxX; x++) for (let y = bounds.minY; y <= bounds.maxY; y++) if (!blocked(x, y, top)) topCells.add(key(x, y, top));
            // Nearest the middle first; a straight column if one is free, else the cheapest way up
            net.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
            let up: Cell[] | null = null;
            for (const start of net) {
                if (start[2] === top) {
                    up = [start];
                    break;
                }
                const column: Cell[] = [];
                for (let z = start[2]; z <= top; z++) column.push([start[0], start[1], z]);
                if (column.slice(1).every((c) => !blocked(...c) && (!cells.get(key(...c)) || cells.get(key(...c))!.resource === resource))) {
                    up = column;
                    break;
                }
            }
            up ??= route(net[0], topCells, resource);
            up?.forEach((c, i) => {
                add(c, resource);
                if (i > 0) link(up![i - 1], c);
            });
        }
    }
    const pipes: Placement[] = [...cells.entries()].map(([k, cell]) => {
        const [x, y, z] = k.split(",").map(Number);
        return { uid: makeUid(), id: PIPE_ID, x, y, z, rot: 0, pipeSides: [...cell.sides], label: cell.resource };
    });
    return [...placements, ...pipes];
}
