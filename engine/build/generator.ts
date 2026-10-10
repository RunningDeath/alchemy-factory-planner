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
 * Blocks go up in levels the way players build them: grinder-sized machines stack
 * directly; everything else stands on a deck of beams laid across its column, with
 * lab stand pillars at the beam ends. Upper belts rest on the beams, on lab stands or
 * on wood blocks. Blocks are packed tightly on the ground (turned where that saves
 * space), each with a free row on its input side for bringing belts in. Connecting
 * the blocks to each other is left to the player.
 */
import { beltPieceFor } from "./belt-pieces";
import { footprintPorts, getFootprint, isDirectlyStackable, oppositeSide, rotatedSize, type Rotation } from "./footprint";
import { buildOccupancy, cellKey, placementIssues, placementPorts, type Placement, type WorldCell } from "./layout";
import { packBlocks, transformBlock } from "./packing";
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
    /** Block origin on the ground (including its free input row) */
    x: number;
    y: number;
    z: number;
    height: number;
    width: number;
    depth: number;
    /** Turned a quarter: lanes run along x instead of y */
    turned: boolean;
    columns: number;
    rows: number;
    levels: number;
    /** How upper levels are carried */
    stacking: "none" | "direct" | "beam-deck";
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

const FRAME_ID = "frame-single";
const BLOCK_ID = "wood-block";

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


export interface Stacking {
    kind: "none" | "direct" | "beam-deck";
    /** Height from one level to the next */
    pitch: number;
    /** Beam deck: the beam that spans one column from lane to lane, and its length */
    beamId?: string;
    beamLength?: number;
}

/** Beams the game offers, by length (they need support at both ends only) */
const BEAMS: [number, string][] = [
    [3, "beam3"],
    [5, "beam5"],
    [10, "beam10"],
    [18, "beam18"],
];

/**
 * How this machine goes up a level, the way players build it: grinder-sized machines
 * directly on each other; everything else on a deck of beams laid across the column
 * (lane to lane) with lab stand pillars at the ends, like the player blueprints.
 */
export function stackingFor(fp: BuildingFootprint, rot: Rotation): Stacking {
    if (isDirectlyStackable(fp)) return { kind: "direct", pitch: fp.size.z };
    const { x: sx } = rotatedSize(fp, rot);
    const beam = BEAMS.find(([length]) => length >= sx + 2 && length <= sx + 4);
    if (beam && getFootprint(beam[1])) {
        // The deck sits right above the machine (including its partly used top cell)
        return { kind: "beam-deck", pitch: fp.size.z + 1, beamId: beam[1], beamLength: beam[0] };
    }
    return { kind: "none", pitch: fp.size.z };
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
    /** Upper levels stand on beams laid across each column */
    deck: boolean;
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
    const rowPitch = sy;

    // Sharing a lane between two columns saves width but doubles the lane's load
    for (const shared of cap >= 2 ? [true, false] : [false]) {
        for (let levels = 1; levels <= maxLevels; levels++) {
            // A beam deck spans one column on its own, so stacked columns don't share lanes
            const deck = levels > 1 && stacking.kind === "beam-deck";
            if (deck && shared) continue;
            const columnPitch = deck ? stacking.beamLength! : shared ? sx + 1 : sx + 2;
            for (let columns = 1; ; columns++) {
                const width = shared ? columns * columnPitch + 1 : columns * columnPitch;
                if (width > opts.maxWidth && columns > 1) break;
                const maxRowsByLane = shared && columns > 1 ? Math.floor(cap / 2) : cap;
                // Entry row, exit row and the free row in front of the block
                const maxRowsByDepth = Math.floor((opts.maxDepth - 3 - sy) / rowPitch) + 1;
                const rows = Math.max(1, Math.min(maxRowsByLane, maxRowsByDepth));
                yield { columns, rows, levels, shared, width, depth: (rows - 1) * rowPitch + sy + 2, rowPitch, columnPitch, deck };
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
        // Lab stand first (it shares its cell with a belt), wood block where that doesn't fit
        const support = [FRAME_ID, BLOCK_ID]
            .map((id): Placement => ({ uid: nextUid("f"), id, x, y, z: fz, rot: 0 }))
            .find((p) => !placementIssues(p, occupancy).some((i) => i.kind === "collision"));
        // A leg or stand top in the way: leave it unsupported, the checks will show it
        if (!support) break;
        frames.push(support);
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
    const { y: sy, z: sz } = rotatedSize(fp, rot);
    const placements: Placement[] = [];
    const machines: Placement[] = [];
    const decks: Placement[] = [];
    const levelZ = (level: number) => origin.z + level * stacking.pitch;

    // Machines: level by level, column by column, row by row (lower levels fill first)
    let placed = 0;
    for (let level = 0; level < shape.levels && placed < count; level++) {
        for (let col = 0; col < shape.columns && placed < count; col++) {
            const flipped = shape.shared && col % 2 === 1;
            const x = origin.x + col * shape.columnPitch + 1;
            for (let row = 0; row < shape.rows && placed < count; row++) {
                const y = origin.y + 1 + row * shape.rowPitch;
                if (level > 0 && shape.deck) {
                    // One beam per machine row, across the column from the input lane on
                    const deckZ = levelZ(level) - 1;
                    for (let r = 0; r < sy; r++) {
                        decks.push({ uid: nextUid("d"), id: stacking.beamId!, x: x - 1, y: y + r, z: deckZ, rot: 1 });
                    }
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
    placements.push(...machines, ...decks);

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
                const lane = feeds ? "in" : "out";
                const label = (lane === "in" ? step.inputs : step.outputs).map((fl) => fl.itemName).join(" + ");
                belts.push({ uid: nextUid("b"), id: piece.id, x: laneX, y, z, rot: piece.rot, nodeKey: step.nodeKey, lane, label });
            }

            const lanesMachines = (pick: "ins" | "outs") =>
                new Set([...byY.values()].flatMap((h) => h[pick].map((p) => p.machine.uid))).size;
            if (feeds) lanes.push(laneInfo("in", laneX - origin.x, level, z, step.inputs, lanesMachines("outs"), beltSpeed));
            if (collects) lanes.push(laneInfo("out", laneX - origin.x, level, z, step.outputs, lanesMachines("ins"), beltSpeed));
        }
    }
    placements.push(...belts);

    // Beam ends rest on lab stand pillars; upper belts rest on beams, elsewhere on pillars too
    for (const d of [...decks].sort((a, c) => a.z - c.z)) {
        const length = stacking.beamLength!;
        for (const endX of [d.x, d.x + length - 1]) placements.push(...supportColumn(placements, endX, d.y, d.z, origin.z));
    }
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
            turned: false,
            columns: Math.min(shape.columns, Math.ceil(count / (shape.rows * shape.levels)) || 1),
            rows: shape.rows,
            levels: levelsUsed,
            stacking: levelsUsed > 1 ? (shape.deck ? "beam-deck" : stacking.kind) : "none",
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

/** Lay every step out as blocks and pack them tightly on the ground */
export function generateModule(steps: ModuleStep[], options: ModuleOptions): GeneratedModule {
    const blocks: { placements: Placement[]; info: TierInfo }[] = [];

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
            // Row 0 stays free so belts can be brought to the input lanes
            const block = buildTier(step, n, shape, fp, rot, stacking, { x: 0, y: 1, z: 0 }, blocks.length, options.beltSpeed);
            block.info.y = 0;
            block.info.depth = shape.depth + 1;
            block.placements = block.placements.map((p) => ({ ...p, block: blocks.length }));
            blocks.push(block);
        }
    }

    const packed = packBlocks(
        blocks.map((b) => ({ width: b.info.width, depth: b.info.depth })),
        options.maxWidth,
    );
    const placements: Placement[] = [];
    const tiers = blocks.map((b, i) => {
        const pos = packed.positions[i];
        placements.push(...transformBlock(b.placements, b.info.depth, pos.rot, pos.x, pos.y));
        const turned = pos.rot === 1;
        return {
            ...b.info,
            x: pos.x,
            y: pos.y,
            width: turned ? b.info.depth : b.info.width,
            depth: turned ? b.info.width : b.info.depth,
            turned,
        };
    });

    const height = Math.max(0, ...tiers.map((t) => t.z + t.height));
    return { placements, tiers, size: [packed.width, packed.depth, height] };
}
