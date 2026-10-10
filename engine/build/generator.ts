/**
 * Generates a compact, vertically stacked module for a production plan.
 *
 * Each production step gets one or more tiers. A tier is a block of machine columns
 * separated by belt lanes running along +y:
 *
 *     lane | machines → | lane | ← machines | lane | machines → | lane
 *      in               out                  in                 out
 *
 * Every other column is turned around so neighbouring columns share a lane. Input
 * lanes enter at the top edge (y = 0) and split into each machine input they pass;
 * output lanes merge machine outputs and leave at the bottom edge. Machines per lane
 * are capped so a lane never carries more than one belt.
 *
 * Machines that can stand on each other (grinders, stackable crucibles, ...) are
 * stacked directly, with frames carrying the upper lanes. Tiers are stacked on wooden
 * floors. Connecting tiers to each other (lifts) is left to the player.
 */
import { beltPieceFor } from "./belt-pieces";
import { footprintCells, footprintPorts, getFootprint, oppositeSide, rotatedSize, type Rotation } from "./footprint";
import { placementPorts, type Placement } from "./layout";
import type { BuildingFootprint, Side } from "./types";

export interface StepFlow {
    itemName: string;
    perMachineRate: number;
}

export interface ModuleStep {
    nodeKey: string;
    itemName: string;
    deviceId: string;
    machines: number;
    /** Belt inputs per machine (fluids excluded; they travel by pipe) */
    inputs: StepFlow[];
    /** Belt outputs per machine */
    outputs: StepFlow[];
    /** Fluid inputs, listed for the player to pipe in */
    fluidInputs: string[];
}

export interface ModuleOptions {
    /** Largest tier footprint in cells (a wooden floor is 16 × 16) */
    maxWidth: number;
    maxDepth: number;
    /** Highest stack for machines that can stand on each other */
    maxStack: number;
    beltSpeed: number;
}

export const DEFAULT_MODULE_OPTIONS: Omit<ModuleOptions, "beltSpeed"> = {
    maxWidth: 16,
    maxDepth: 16,
    maxStack: 3,
};

export interface LaneInfo {
    kind: "in" | "out";
    x: number;
    /** Stack level inside the tier */
    level: number;
    z: number;
    items: StepFlow[];
    rate: number;
    overBelt: boolean;
}

export interface TierInfo {
    index: number;
    nodeKey: string;
    itemName: string;
    deviceId: string;
    machines: number;
    /** Base height of the machines (the floor, if any, is at z - 1) */
    z: number;
    height: number;
    width: number;
    depth: number;
    columns: number;
    rows: number;
    levels: number;
    lanes: LaneInfo[];
    fluidInputs: string[];
    /** Machine ports above the lane level that need a manual connection */
    offLanePorts: number;
}

export interface GeneratedModule {
    placements: Placement[];
    tiers: TierInfo[];
    size: [number, number, number];
}

const FLOOR_ID = "construct-floor-wood-8x8";
const FLOOR_TILE = 8;
const FRAME_ID = "frame-single";

/** Turn the machine so most inputs face left and outputs face right */
export function machineRotation(fp: BuildingFootprint): Rotation {
    let best: Rotation = 0;
    let bestScore = -Infinity;
    for (const rot of [0, 1, 2, 3] as Rotation[]) {
        const ports = footprintPorts(fp, rot).filter((p) => p.medium === "belt");
        const score =
            ports.filter((p) => p.dir === "in" && p.face === "left").length +
            ports.filter((p) => p.dir === "out" && p.face === "right").length;
        if (score > bestScore) {
            best = rot;
            bestScore = score;
        }
    }
    return best;
}

/** One cell tall, every cell carries what's above and needs support: these stack directly */
export function isDirectlyStackable(fp: BuildingFootprint): boolean {
    const cells = footprintCells(fp);
    return fp.size.z === 1 && cells.every((c) => c.stackable && c.foundation);
}

interface TierShape {
    columns: number;
    rows: number;
    levels: number;
    shared: boolean;
    width: number;
    depth: number;
}

function laneCapacity(flows: StepFlow[], beltSpeed: number): number {
    const perMachine = flows.reduce((sum, f) => sum + f.perMachineRate, 0);
    return perMachine > 0 ? Math.floor(beltSpeed / perMachine) : Infinity;
}

/** All tier shapes that fit the options, for a machine of the given rotated size */
function* tierShapes(step: ModuleStep, fp: BuildingFootprint, rot: Rotation, opts: ModuleOptions): Generator<TierShape> {
    const { x: sx, y: sy } = rotatedSize(fp, rot);
    const cap = Math.max(1, Math.min(laneCapacity(step.inputs, opts.beltSpeed), laneCapacity(step.outputs, opts.beltSpeed)));
    const maxLevels = isDirectlyStackable(fp) ? Math.max(1, opts.maxStack) : 1;

    // Sharing a lane between two columns saves width but doubles the lane's load
    for (const shared of cap >= 2 ? [true, false] : [false])
    for (let levels = 1; levels <= maxLevels; levels++) {
        for (let columns = 1; ; columns++) {
            const width = shared ? columns * (sx + 1) + 1 : columns * (sx + 2);
            if (width > opts.maxWidth && columns > 1) break;
            const maxRowsByLane = shared && columns > 1 ? Math.floor(cap / 2) : cap;
            const maxRowsByDepth = Math.floor((opts.maxDepth - 2) / sy);
            const maxRows = Math.max(1, Math.min(maxRowsByLane, maxRowsByDepth));
            yield { columns, rows: maxRows, levels, shared, width, depth: maxRows * sy + 2 };
            if (width > opts.maxWidth) break;
        }
    }
}

/** Smallest-volume shape for n machines, or the biggest shape when n doesn't fit in one tier */
function chooseShape(step: ModuleStep, n: number, fp: BuildingFootprint, rot: Rotation, opts: ModuleOptions): TierShape {
    const { y: sy, z: sz } = rotatedSize(fp, rot);
    let best: TierShape | null = null;
    let bestVolume = Infinity;
    let biggest: TierShape | null = null;

    for (const shape of tierShapes(step, fp, rot, opts)) {
        const capacity = shape.columns * shape.rows * shape.levels;
        if (!biggest || capacity > biggest.columns * biggest.rows * biggest.levels) biggest = shape;
        if (capacity < n) continue;
        // Trim rows to what n needs
        const rows = Math.ceil(n / (shape.columns * shape.levels));
        const trimmed = { ...shape, rows, depth: rows * sy + 2 };
        const volume = trimmed.width * trimmed.depth * (trimmed.levels * sz + 1);
        if (volume < bestVolume) {
            best = trimmed;
            bestVolume = volume;
        }
    }
    return best ?? biggest!;
}

let uidCounter = 0;
const nextUid = (prefix: string) => `${prefix}-${++uidCounter}`;

interface PortHit {
    /** Side of the lane cell the item moves through */
    side: Side;
    machine: Placement;
}

function buildTier(
    step: ModuleStep,
    count: number,
    shape: TierShape,
    fp: BuildingFootprint,
    rot: Rotation,
    z: number,
    index: number,
    beltSpeed: number,
): { placements: Placement[]; info: TierInfo } {
    const { x: sx, y: sy, z: sz } = rotatedSize(fp, rot);
    const placements: Placement[] = [];
    const machines: Placement[] = [];

    // Machines: level by level, column by column, row by row
    let placed = 0;
    for (let level = 0; level < shape.levels && placed < count; level++) {
        for (let col = 0; col < shape.columns && placed < count; col++) {
            const flipped = shape.shared && col % 2 === 1;
            const x = shape.shared ? col * (sx + 1) + 1 : col * (sx + 2) + 1;
            for (let row = 0; row < shape.rows && placed < count; row++) {
                const m: Placement = {
                    uid: nextUid("m"),
                    id: step.deviceId,
                    x,
                    y: 1 + row * sy,
                    z: z + level * sz,
                    rot: ((rot + (flipped ? 2 : 0)) % 4) as Rotation,
                    nodeKey: step.nodeKey,
                    label: step.itemName,
                };
                machines.push(m);
                placed++;
            }
        }
    }
    placements.push(...machines);

    // Which lane cells machine ports point at, per level
    const lanes: LaneInfo[] = [];
    const beltCells = new Map<string, number>(); // "x,y" → highest level with a belt
    let offLanePorts = 0;

    for (let level = 0; level < shape.levels; level++) {
        const levelZ = z + level * sz;
        const hits = new Map<number, Map<number, { ins: PortHit[]; outs: PortHit[] }>>(); // x → y → hits
        for (const m of machines.filter((mm) => mm.z === levelZ)) {
            for (const port of placementPorts(m)) {
                if (port.medium !== "belt") continue;
                if (port.z !== levelZ || port.face === "up" || port.face === "down" || port.face === "top" || port.face === "base") {
                    offLanePorts++;
                    continue;
                }
                const laneX = port.face === "left" ? port.x - 1 : port.x + 1;
                const byY = hits.get(laneX) ?? new Map();
                hits.set(laneX, byY);
                const at = byY.get(port.y) ?? { ins: [], outs: [] };
                byY.set(port.y, at);
                // Lane sends items into machine inputs and takes them from machine outputs
                const laneSide = oppositeSide(port.face);
                if (port.dir === "in") at.outs.push({ side: laneSide, machine: m });
                else at.ins.push({ side: laneSide, machine: m });
            }
        }

        for (const [laneX, byY] of [...hits.entries()].sort((a, b) => a[0] - b[0])) {
            const ys = [...byY.keys()];
            const feeds = ys.some((y) => byY.get(y)!.outs.length > 0);
            const collects = ys.some((y) => byY.get(y)!.ins.length > 0);
            const yStart = feeds ? 0 : Math.min(...ys.filter((y) => byY.get(y)!.ins.length > 0));
            const yEnd = collects ? shape.depth - 1 : Math.max(...ys.filter((y) => byY.get(y)!.outs.length > 0));

            for (let y = yStart; y <= yEnd; y++) {
                const at = byY.get(y);
                const ins: Side[] = [...new Set(at?.ins.map((h) => h.side) ?? [])];
                const outs: Side[] = [...new Set(at?.outs.map((h) => h.side) ?? [])];
                if (y > yStart || feeds) ins.push("up");
                if (y < yEnd || collects) outs.push("down");
                const piece = beltPieceFor(ins, outs) ?? beltPieceFor(["up"], ["down"])!;
                placements.push({ uid: nextUid("b"), id: piece.id, x: laneX, y, z: levelZ, rot: piece.rot, nodeKey: step.nodeKey });
                const key = `${laneX},${y}`;
                beltCells.set(key, Math.max(beltCells.get(key) ?? 0, level));
            }

            const lanesMachines = (pick: "ins" | "outs") =>
                new Set([...byY.values()].flatMap((h) => h[pick].map((p) => p.machine.uid))).size;
            if (feeds) lanes.push(laneInfo("in", laneX, level, levelZ, step.inputs, lanesMachines("outs"), beltSpeed));
            if (collects) lanes.push(laneInfo("out", laneX, level, levelZ, step.outputs, lanesMachines("ins"), beltSpeed));
        }
    }

    // Frames carry the lanes of upper stack levels (a frame shares its cell with the belt beside it)
    beltCells.forEach((topLevel, key) => {
        const [x, y] = key.split(",").map(Number);
        for (let level = 0; level < topLevel; level++) {
            placements.push({ uid: nextUid("f"), id: FRAME_ID, x, y, z: z + level * sz, rot: 0 });
        }
    });

    return {
        placements,
        info: {
            index,
            nodeKey: step.nodeKey,
            itemName: step.itemName,
            deviceId: step.deviceId,
            machines: count,
            z,
            height: shape.levels * sz,
            width: shape.width,
            depth: shape.depth,
            columns: Math.min(shape.columns, Math.ceil(count / (shape.rows * shape.levels)) || 1),
            rows: shape.rows,
            levels: Math.min(shape.levels, Math.ceil(count / (shape.columns * shape.rows))),
            lanes,
            fluidInputs: step.fluidInputs,
            offLanePorts,
        },
    };
}

function laneInfo(kind: "in" | "out", x: number, level: number, z: number, flows: StepFlow[], machines: number, beltSpeed: number): LaneInfo {
    const items = flows.map((f) => ({ itemName: f.itemName, perMachineRate: f.perMachineRate * machines }));
    const rate = items.reduce((sum, f) => sum + f.perMachineRate, 0);
    return { kind, x, level, z, items, rate, overBelt: rate > beltSpeed + 1e-6 };
}

function floorTiles(width: number, depth: number, z: number): Placement[] {
    const tiles: Placement[] = [];
    for (let x = 0; x < width; x += FLOOR_TILE)
        for (let y = 0; y < depth; y += FLOOR_TILE) tiles.push({ uid: nextUid("fl"), id: FLOOR_ID, x, y, z, rot: 0 });
    return tiles;
}

/** Stack every step's tiers on top of each other, first step at the bottom */
export function generateModule(steps: ModuleStep[], options: ModuleOptions): GeneratedModule {
    const placements: Placement[] = [];
    const tiers: TierInfo[] = [];
    let z = 0;

    for (const step of steps) {
        const fp = getFootprint(step.deviceId);
        const count = Math.ceil(step.machines - 1e-9);
        if (!fp || count <= 0) continue;
        const rot = machineRotation(fp);

        // Split into several tiers when one can't hold all machines
        const biggest = chooseShape(step, Infinity, fp, rot, options);
        const perTier = biggest.columns * biggest.rows * biggest.levels;
        const tierCount = Math.ceil(count / perTier);

        for (let t = 0; t < tierCount; t++) {
            const n = Math.floor(count / tierCount) + (t < count % tierCount ? 1 : 0);
            const shape = chooseShape(step, n, fp, rot, options);
            if (z > 0) placements.push(...floorTiles(shape.width, shape.depth, z++));
            const tier = buildTier(step, n, shape, fp, rot, z, tiers.length, options.beltSpeed);
            placements.push(...tier.placements);
            tiers.push(tier.info);
            z += tier.info.height;
        }
    }

    const width = Math.max(0, ...tiers.map((t) => t.width));
    const depth = Math.max(0, ...tiers.map((t) => t.depth));
    return { placements, tiers, size: [width, depth, z] };
}
