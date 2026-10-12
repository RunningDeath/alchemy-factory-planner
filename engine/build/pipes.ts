/**
 * Pipes: every pipe port of a module (extractors, blenders, the first steam heater of a
 * row) gets a pipe straight up to the top layer, where the ports of one fluid join into one
 * network. Brine from the extractors reaches the blender that way; a fluid nobody in the
 * module makes (steam) comes in through its network at the top: one connection per fluid.
 * Laid before the belts are routed, so the cell at each pipe port stays free.
 */
import { getFootprint, oppositeSide, SIDE_OFFSET } from "./footprint";
import { buildOccupancy, placementPorts, type Placement } from "./layout";
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
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * The pipe ports that need a pipe, per machine (a steam heater needs one of its two sides,
 * other machines every pipe port), and how many have no free column above them
 */
function pipePorts(placements: Placement[], columnFree: (x: number, y: number, z: number) => boolean): { ports: PipePort[]; blocked: number } {
    const ports: PipePort[] = [];
    let blocked = 0;
    for (const p of placements) {
        const fp = getFootprint(p.id);
        if (!fp || (fp.category !== "production" && fp.category !== "heating")) continue;
        const resource = p.pipeEnd?.items[0]?.itemName;
        // Heaters after the first of a row get their steam from the neighbour
        if (!resource) continue;
        const options: PipePort[] = [];
        for (const q of placementPorts(p).filter((q) => q.medium === "pipe" && q.face !== "base")) {
            if (q.face === "top") {
                options.push({ resource, x: q.x, y: q.y, z: q.z + 1, toward: "base" });
                continue;
            }
            const face = q.face as Side;
            const [dx, dy] = SIDE_OFFSET[face];
            if (portTaken(placements, q.x + dx, q.y + dy, q.z, oppositeSide(face))) continue;
            options.push({ resource, x: q.x + dx, y: q.y + dy, z: q.z, toward: oppositeSide(face) });
        }
        const usable = options.filter((o) => columnFree(o.x, o.y, o.z));
        if (options.length && (p.id === "steam-heater" ? usable.length === 0 : usable.length < options.length)) blocked++;
        ports.push(...(p.id === "steam-heater" ? usable.slice(0, 1) : usable));
    }
    return { ports, blocked };
}

/** Pipe pieces for the pipe ports in `placements` (see the file comment; `placements` holds no pipes); each carries its fluid as label */
export function pipeRisers(placements: Placement[], maxHeight: number, makeUid: () => string): { pipes: Placement[]; blocked: number } {
    const occupancy = buildOccupancy(placements);
    const cells = new Map<string, { resource: string; sides: Set<Side | VerticalFace> }>();
    const taken = (x: number, y: number, z: number) => !!occupancy.get(key(x, y, z))?.length || cells.has(key(x, y, z));
    const columnFree = (x: number, y: number, z0: number) => {
        for (let z = z0; z < maxHeight; z++) if (taken(x, y, z)) return false;
        return true;
    };
    const { ports, blocked } = pipePorts(placements, columnFree);
    const top = maxHeight - 1;
    const add = (x: number, y: number, z: number, resource: string, side?: Side | VerticalFace) => {
        const cell = cells.get(key(x, y, z)) ?? { resource, sides: new Set() };
        if (side) cell.sides.add(side);
        cells.set(key(x, y, z), cell);
    };

    const byResource = new Map<string, PipePort[]>();
    for (const port of ports) byResource.set(port.resource, [...(byResource.get(port.resource) ?? []), port]);
    for (const [resource, list] of byResource) {
        // Straight up from every port
        const tops: [number, number][] = [];
        for (const port of list) {
            if (!columnFree(port.x, port.y, port.z)) continue;
            add(port.x, port.y, port.z, resource, port.toward);
            for (let z = port.z; z < top; z++) {
                add(port.x, port.y, z, resource, "top");
                add(port.x, port.y, z + 1, resource, "base");
            }
            tops.push([port.x, port.y]);
        }
        // The tops join along the top layer, each to the nearest part of the network so far
        const joined = new Set<string>(tops.length ? [`${tops[0][0]},${tops[0][1]}`] : []);
        for (const [tx, ty] of tops.slice(1)) {
            if (joined.has(`${tx},${ty}`)) continue;
            const path = pathOnLayer(tx, ty, joined, (x, y) => {
                const cell = cells.get(key(x, y, top));
                return !occupancy.get(key(x, y, top))?.length && (!cell || cell.resource === resource);
            });
            if (!path) continue;
            path.forEach(([x, y], i) => {
                add(x, y, top, resource);
                joined.add(`${x},${y}`);
                if (i === 0) return;
                const [px, py] = path[i - 1];
                const side = (Object.entries(SIDE_OFFSET) as [Side, [number, number]][]).find(([, [dx, dy]]) => px + dx === x && py + dy === y)![0];
                cells.get(key(px, py, top))!.sides.add(side);
                cells.get(key(x, y, top))!.sides.add(oppositeSide(side));
            });
        }
    }
    const pipes: Placement[] = [...cells.entries()].map(([k, cell]) => {
        const [x, y, z] = k.split(",").map(Number);
        return { uid: makeUid(), id: PIPE_ID, x, y, z, rot: 0, pipeSides: [...cell.sides], label: cell.resource };
    });
    return { pipes, blocked };
}

/** Shortest path on one layer from (x, y) to any cell in `targets` ("x,y" keys), through cells `ok` allows */
function pathOnLayer(x: number, y: number, targets: Set<string>, ok: (x: number, y: number) => boolean): [number, number][] | null {
    const start = `${x},${y}`;
    const prev = new Map<string, string | null>([[start, null]]);
    const queue: [number, number][] = [[x, y]];
    for (let i = 0; i < queue.length && i < 20000; i++) {
        const [cx, cy] = queue[i];
        const here = `${cx},${cy}`;
        if (i > 0 && targets.has(here)) {
            const path: [number, number][] = [];
            for (let k: string | null = here; k; k = prev.get(k) ?? null) path.unshift(k.split(",").map(Number) as [number, number]);
            return path;
        }
        for (const [dx, dy] of Object.values(SIDE_OFFSET)) {
            const [nx, ny] = [cx + dx, cy + dy];
            const next = `${nx},${ny}`;
            if (prev.has(next) || Math.abs(nx - x) > 64 || Math.abs(ny - y) > 160) continue;
            if (!targets.has(next) && !ok(nx, ny)) continue;
            prev.set(next, here);
            queue.push([nx, ny]);
        }
    }
    return null;
}

/**
 * Pipe ports that can't get their pipe: the column from the port's cell to `maxHeight`
 * isn't free (a steam heater needs one of its two sides). Towers must not add any.
 */
export function blockedPipePorts(placements: Placement[], maxHeight: number): number {
    const occupancy = buildOccupancy(placements);
    const columnFree = (x: number, y: number, z0: number) => {
        for (let z = z0; z < maxHeight; z++) if (occupancy.get(key(x, y, z))?.some((c) => c.id !== PIPE_ID)) return false;
        return true;
    };
    return pipePorts(placements, columnFree).blocked;
}
