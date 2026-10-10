/**
 * Generates a compact module for a production plan that fits in one storey
 * (a wall is 16 cells high).
 *
 * Each production step gets a block of machine columns separated by belt lanes
 * running along +y:
 *
 *     lane | machines → | lane | ← machines | lane | machines → | lane
 *      in               out                  in                 out
 *
 * Every other column is turned around so neighbouring columns share a lane. Input
 * lanes enter at the top edge (y = 0) and split into each machine input they pass;
 * output lanes merge machine outputs and leave at the bottom edge. Machines per lane
 * are capped so a lane never carries more than one belt.
 *
 * Blocks go up in levels, using only what the game allows: machines that can stand
 * on each other (grinders, ...) stack directly, others stand on metal stands over
 * the machine below (like nursery → stand → nursery). Upper belts rest on the stands
 * or on frame columns. Blocks sit side by side on the ground; connecting them to each
 * other is left to the player.
 */
import { beltPieceFor } from "./belt-pieces";
import { footprintCells, footprintPorts, getFootprint, oppositeSide, rotatedSize, type Rotation } from "./footprint";
import { buildOccupancy, cellKey, placementIssues, placementPorts, validateLayout, type Placement, type WorldCell } from "./layout";
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
    /** Module footprint limits in cells; blocks wrap into a new row past maxWidth */
    maxWidth: number;
    maxDepth: number;
    /** Module height in cells (one storey = 16) */
    maxHeight: number;
    /** Most machine levels per block */
    maxStack: number;
    beltSpeed: number;
}

/** One storey: walls and pillars are 16 cells high */
export const STOREY_HEIGHT = 16;

export const DEFAULT_MODULE_OPTIONS: Omit<ModuleOptions, "beltSpeed"> = {
    maxWidth: 32,
    maxDepth: 32,
    maxHeight: STOREY_HEIGHT,
    maxStack: 4,
};

export interface LaneInfo {
    kind: "in" | "out";
    x: number;
    /** Stack level inside the block */
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
    /** Block origin on the ground */
    x: number;
    y: number;
    z: number;
    height: number;
    width: number;
    depth: number;
    columns: number;
    rows: number;
    levels: number;
    /** How upper levels are carried */
    stacking: "none" | "direct" | "metal-stand";
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

const STAND_ID = "metal-stand";
const FRAME_ID = "frame-single";
const STAND_SIZE = 3;

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

export interface Stacking {
    kind: "none" | "direct" | "metal-stand";
    /** Height from one level to the next */
    pitch: number;
    /** Metal stand height above the lower machine's base */
    standOffset: number;
}

/**
 * How this machine goes up a level: directly on itself, on a metal stand over the
 * machine below (tested against the game's occupation rules), or not at all.
 */
export function stackingFor(fp: BuildingFootprint, rot: Rotation): Stacking {
    if (isDirectlyStackable(fp)) return { kind: "direct", pitch: fp.size.z, standOffset: 0 };
    const size = rotatedSize(fp, rot);
    if (size.x >= 2 && size.x <= STAND_SIZE && size.y <= STAND_SIZE) {
        for (let offset = 0; offset <= 2; offset++) {
            const fits = ([rot, ((rot + 2) % 4) as Rotation] as Rotation[]).every(
                (r) =>
                    validateLayout([
                        { uid: "a", id: fp.id, x: 0, y: 0, z: 0, rot: r },
                        { uid: "s", id: STAND_ID, x: 0, y: 0, z: offset, rot: 0 },
                        { uid: "b", id: fp.id, x: 0, y: 0, z: offset + STAND_SIZE, rot: r },
                    ]).length === 0,
            );
            if (fits) return { kind: "metal-stand", pitch: offset + STAND_SIZE, standOffset: offset };
        }
    }
    return { kind: "none", pitch: fp.size.z, standOffset: 0 };
}

interface TierShape {
    columns: number;
    rows: number;
    levels: number;
    shared: boolean;
    width: number;
    depth: number;
    rowPitch: number;
    columnPitch: number;
}

function laneCapacity(flows: StepFlow[], beltSpeed: number): number {
    const perMachine = flows.reduce((sum, f) => sum + f.perMachineRate, 0);
    return perMachine > 0 ? Math.floor(beltSpeed / perMachine) : Infinity;
}

function maxLevelsFor(fp: BuildingFootprint, stacking: Stacking, opts: ModuleOptions): number {
    if (stacking.kind === "none") return 1;
    const byHeight = Math.floor((opts.maxHeight - fp.size.z) / stacking.pitch) + 1;
    return Math.max(1, Math.min(opts.maxStack, byHeight));
}

/** All block shapes that fit the options */
function* tierShapes(step: ModuleStep, fp: BuildingFootprint, rot: Rotation, stacking: Stacking, opts: ModuleOptions): Generator<TierShape> {
    const { x: sx, y: sy } = rotatedSize(fp, rot);
    const cap = Math.max(1, Math.min(laneCapacity(step.inputs, opts.beltSpeed), laneCapacity(step.outputs, opts.beltSpeed)));
    const maxLevels = maxLevelsFor(fp, stacking, opts);
    // A stand is 3 × 3, so rows of stand-stacked machines are at least 3 apart
    const rowPitch = stacking.kind === "metal-stand" ? Math.max(sy, STAND_SIZE) : sy;

    // Sharing a lane between two columns saves width but doubles the lane's load
    for (const shared of cap >= 2 ? [true, false] : [false]) {
        const columnPitch = shared ? sx + 1 : sx + 2;
        if (stacking.kind === "metal-stand" && columnPitch < STAND_SIZE) continue;
        for (let levels = 1; levels <= maxLevels; levels++) {
            for (let columns = 1; ; columns++) {
                const width = shared ? columns * columnPitch + 1 : columns * columnPitch;
                if (width > opts.maxWidth && columns > 1) break;
                const maxRowsByLane = shared && columns > 1 ? Math.floor(cap / 2) : cap;
                const maxRowsByDepth = Math.floor((opts.maxDepth - 2 - sy) / rowPitch) + 1;
                const rows = Math.max(1, Math.min(maxRowsByLane, maxRowsByDepth));
                yield { columns, rows, levels, shared, width, depth: (rows - 1) * rowPitch + sy + 2, rowPitch, columnPitch };
                if (width > opts.maxWidth) break;
            }
        }
    }
}

/** Smallest footprint for n machines, or the biggest shape when n doesn't fit in one block */
function chooseShape(step: ModuleStep, n: number, fp: BuildingFootprint, rot: Rotation, stacking: Stacking, opts: ModuleOptions): TierShape {
    const { y: sy } = rotatedSize(fp, rot);
    let best: TierShape | null = null;
    let bestScore = Infinity;
    let biggest: TierShape | null = null;

    for (const shape of tierShapes(step, fp, rot, stacking, opts)) {
        const capacity = shape.columns * shape.rows * shape.levels;
        if (!biggest || capacity > biggest.columns * biggest.rows * biggest.levels) biggest = shape;
        if (capacity < n) continue;
        // Trim rows to what n needs
        const rows = Math.ceil(n / (shape.columns * shape.levels));
        const trimmed = { ...shape, rows, depth: (rows - 1) * shape.rowPitch + sy + 2 };
        // Floor space first; a few extra levels are cheap inside one storey
        const score = trimmed.width * trimmed.depth * 100 + trimmed.levels;
        if (score < bestScore) {
            best = trimmed;
            bestScore = score;
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

/** Something under (x, y, z) that a belt or frame can stand on */
function isSupported(occupancy: Map<string, WorldCell[]>, x: number, y: number, z: number, groundZ: number): boolean {
    if (z <= groundZ) return true;
    return (occupancy.get(cellKey(x, y, z - 1)) ?? []).some((c) => c.stackable && c.quads === 15);
}

/** Frames from the ground (or the first stackable cell) up to just below z */
function supportColumn(placements: Placement[], x: number, y: number, z: number, groundZ: number): Placement[] {
    const frames: Placement[] = [];
    let occupancy = buildOccupancy(placements);
    for (let fz = z - 1; fz >= groundZ; fz--) {
        if (isSupported(occupancy, x, y, fz + 1, groundZ)) break;
        const frame: Placement = { uid: nextUid("f"), id: FRAME_ID, x, y, z: fz, rot: 0 };
        // A leg or stand top in the way: leave it unsupported, the checks will show it
        if (placementIssues(frame, occupancy).some((i) => i.kind === "collision")) break;
        frames.push(frame);
        occupancy = buildOccupancy([...placements, ...frames]);
    }
    return frames;
}

function buildTier(
    step: ModuleStep,
    count: number,
    shape: TierShape,
    fp: BuildingFootprint,
    rot: Rotation,
    stacking: Stacking,
    origin: { x: number; y: number; z: number },
    index: number,
    beltSpeed: number,
): { placements: Placement[]; info: TierInfo } {
    const { z: sz } = rotatedSize(fp, rot);
    const placements: Placement[] = [];
    const machines: Placement[] = [];
    const levelZ = (level: number) => origin.z + level * stacking.pitch;

    // Machines: level by level, column by column, row by row (lower levels fill first)
    let placed = 0;
    for (let level = 0; level < shape.levels && placed < count; level++) {
        for (let col = 0; col < shape.columns && placed < count; col++) {
            const flipped = shape.shared && col % 2 === 1;
            const x = origin.x + col * shape.columnPitch + 1;
            for (let row = 0; row < shape.rows && placed < count; row++) {
                const y = origin.y + 1 + row * shape.rowPitch;
                if (level > 0 && stacking.kind === "metal-stand") {
                    placements.push({ uid: nextUid("s"), id: STAND_ID, x, y, z: levelZ(level - 1) + stacking.standOffset, rot: 0 });
                }
                machines.push({
                    uid: nextUid("m"),
                    id: step.deviceId,
                    x,
                    y,
                    z: levelZ(level),
                    rot: ((rot + (flipped ? 2 : 0)) % 4) as Rotation,
                    nodeKey: step.nodeKey,
                    label: step.itemName,
                });
                placed++;
            }
        }
    }
    placements.push(...machines);

    // Which lane cells machine ports point at, per level
    const lanes: LaneInfo[] = [];
    const belts: Placement[] = [];
    let offLanePorts = 0;
    const levelsUsed = Math.max(...machines.map((m) => Math.round((m.z - origin.z) / stacking.pitch))) + 1;

    for (let level = 0; level < levelsUsed; level++) {
        const z = levelZ(level);
        const hits = new Map<number, Map<number, { ins: PortHit[]; outs: PortHit[] }>>(); // x → y → hits
        for (const m of machines.filter((mm) => mm.z === z)) {
            for (const port of placementPorts(m)) {
                if (port.medium !== "belt") continue;
                if (port.z !== z || port.face === "up" || port.face === "down" || port.face === "top" || port.face === "base") {
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
            const top = origin.y;
            const bottom = origin.y + shape.depth - 1;
            const yStart = feeds ? top : Math.min(...ys.filter((y) => byY.get(y)!.ins.length > 0));
            const yEnd = collects ? bottom : Math.max(...ys.filter((y) => byY.get(y)!.outs.length > 0));

            for (let y = yStart; y <= yEnd; y++) {
                const at = byY.get(y);
                const ins: Side[] = [...new Set(at?.ins.map((h) => h.side) ?? [])];
                const outs: Side[] = [...new Set(at?.outs.map((h) => h.side) ?? [])];
                if (y > yStart || feeds) ins.push("up");
                if (y < yEnd || collects) outs.push("down");
                const piece = beltPieceFor(ins, outs) ?? beltPieceFor(["up"], ["down"])!;
                belts.push({ uid: nextUid("b"), id: piece.id, x: laneX, y, z, rot: piece.rot, nodeKey: step.nodeKey });
            }

            const lanesMachines = (pick: "ins" | "outs") =>
                new Set([...byY.values()].flatMap((h) => h[pick].map((p) => p.machine.uid))).size;
            if (feeds) lanes.push(laneInfo("in", laneX - origin.x, level, z, step.inputs, lanesMachines("outs"), beltSpeed));
            if (collects) lanes.push(laneInfo("out", laneX - origin.x, level, z, step.outputs, lanesMachines("ins"), beltSpeed));
        }
    }
    placements.push(...belts);

    // Upper belts rest on stand tops where they reach over a lane; elsewhere on frame columns
    for (const b of belts.filter((bb) => bb.z > origin.z).sort((a, c) => a.z - c.z)) {
        placements.push(...supportColumn(placements, b.x, b.y, b.z, origin.z));
    }

    return {
        placements,
        info: {
            index,
            nodeKey: step.nodeKey,
            itemName: step.itemName,
            deviceId: step.deviceId,
            machines: count,
            x: origin.x,
            y: origin.y,
            z: origin.z,
            height: (levelsUsed - 1) * stacking.pitch + sz,
            width: shape.width,
            depth: shape.depth,
            columns: Math.min(shape.columns, Math.ceil(count / (shape.rows * shape.levels)) || 1),
            rows: shape.rows,
            levels: levelsUsed,
            stacking: levelsUsed > 1 ? stacking.kind : "none",
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

/** Lay every step out as blocks side by side on the ground, wrapping into rows */
export function generateModule(steps: ModuleStep[], options: ModuleOptions): GeneratedModule {
    const placements: Placement[] = [];
    const tiers: TierInfo[] = [];
    let cursorX = 0;
    let cursorY = 0;
    let rowDepth = 0;

    for (const step of steps) {
        const fp = getFootprint(step.deviceId);
        const count = Math.ceil(step.machines - 1e-9);
        if (!fp || count <= 0) continue;
        const rot = machineRotation(fp);
        const stacking = stackingFor(fp, rot);

        // Split into several blocks when one can't hold all machines
        const biggest = chooseShape(step, Infinity, fp, rot, stacking, options);
        const perBlock = biggest.columns * biggest.rows * biggest.levels;
        const blockCount = Math.ceil(count / perBlock);

        for (let t = 0; t < blockCount; t++) {
            const n = Math.floor(count / blockCount) + (t < count % blockCount ? 1 : 0);
            const shape = chooseShape(step, n, fp, rot, stacking, options);
            if (cursorX > 0 && cursorX + shape.width > options.maxWidth) {
                cursorX = 0;
                cursorY += rowDepth;
                rowDepth = 0;
            }
            const block = buildTier(step, n, shape, fp, rot, stacking, { x: cursorX, y: cursorY, z: 0 }, tiers.length, options.beltSpeed);
            placements.push(...block.placements);
            tiers.push(block.info);
            cursorX += shape.width;
            rowDepth = Math.max(rowDepth, shape.depth);
        }
    }

    const width = Math.max(0, ...tiers.map((t) => t.x + t.width));
    const depth = Math.max(0, ...tiers.map((t) => t.y + t.depth));
    const height = Math.max(0, ...tiers.map((t) => t.z + t.height));
    return { placements, tiers, size: [width, depth, height] };
}
