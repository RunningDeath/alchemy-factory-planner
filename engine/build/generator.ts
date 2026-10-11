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
import { footprintPorts, getFootprint, isDirectlyStackable, oppositeSide, rotatedSize, STACKS_ON_ITSELF, type Rotation } from "./footprint";
import { buildOccupancy, cellKey, placementCells, placementPorts, type Placement } from "./layout";
import { preferBlocks, pruneSupports, supportColumn, beamsUnderRuns } from "./supports";
import { buildTowers, type Tower } from "./towers";
import { attachDisposal, type Disposal } from "./disposal";
import { isFluidItem } from "../belt-analysis";
import { getItem } from "../item-utils";
import { capabilities, lockedBuildings, type BuildUnlocks, type Capabilities } from "./unlocks";
import deviceMetadata from "../../data/device-metadata.json";
import { flowRows, nearFeeders, packBlocks, transformBlock } from "./packing";

/** near: next to the feeding blocks; flow: rows by production stage; packed: tightest fit */
type LayoutMode = "near" | "flow" | "packed";
import { routeModule, type IoPoint, type RouteResult } from "./router";
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
    /** Fluids per machine, carried by pipes */
    fluids?: { inputs: StepFlow[]; outputs: StepFlow[] };
    /** Heated machines stand on steam heaters (steam fuel) or stone stoves (any other fuel) */
    heating?: { kind: "steam" | "stove"; fuelItem: string; fuelRate: number };
    /** Byproducts stay on the output belt with the product (no filter splitter unlocked) */
    unsorted?: boolean;
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
    /** Let belts cross gaps on drawbridge conveyors (needs the unlock; costs linen rope) */
    useBridges?: boolean;
    /** The plan's targets: always sent out at the module edge */
    finalProducts?: string[];
    /** Surplus the player sends out at the edge (the rest stays in the line; final products always leave) */
    exportItems?: string[];
    /** The player's level and unlocks; only those buildings are used. Absent: everything */
    unlocks?: BuildUnlocks;
    /** Put small blocks on top of others to save floor (default: yes) */
    stackBlocks?: boolean;
    /** Unneeded output (byproducts, overflow): knowledge altar, trash barrel, dispatch portal or out at the edge. Default: the first of these that is unlocked */
    disposal?: Disposal;
    /**
     * Build as modules: each group (step nodeKeys) becomes its own small module, stacked into
     * towers, with its inputs at its front and outputs at its back. The modules stand side by
     * side and are belted to each other. Steps in no group form one more module laid out as
     * usual. Absent or empty: one module for everything
     */
    moduleGroups?: string[][];
    /** Progress while laying out and routing: share done (0–1) and what is happening */
    onProgress?: (fraction: number, label: string) => void;
}

/** One storey: walls and pillars are 16 cells high */
export const STOREY_HEIGHT = 16;

/** More machines than this is not one module (it would take minutes and fill a map) */
export const MAX_MODULE_MACHINES = 2000;

/** Why a plan is too big for one module, or null when it fits */
export function moduleTooBig(steps: ModuleStep[]): { machines: number; biggest: ModuleStep } | null {
    const machines = steps.reduce((sum, st) => sum + Math.ceil(st.machines), 0);
    if (machines <= MAX_MODULE_MACHINES) return null;
    const biggest = steps.reduce((a, b) => (b.machines > a.machines ? b : a));
    return { machines, biggest };
}

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
    /** Inputs share one lane (couldn't be separated): a filter is needed in game */
    mixedInputs?: boolean;
    /** Heating platform under the machines */
    heating?: { kind: "steam" | "stove"; devices: number; fuelItem: string; fuelRate: number; slotsUsed: number; slotsAvailable: number };
}

export interface GeneratedModule {
    placements: Placement[];
    tiers: TierInfo[];
    size: [number, number, number];
    /** Belt connections between blocks, imports and exports */
    routes: RouteResult[];
    io: IoPoint[];
    /** Unused output that stays in the line */
    surplus: { itemName: string; rate: number }[];
    /** Buildings in the layout the player hasn't unlocked (it had no way around them) */
    locked: string[];
}

/** Widest corridor tried for stacked towers before falling back to blocks side by side */
const TOWER_MAX_CORRIDOR = 3;
/** After this long, stop trying more layouts once one routes everything */
const TIME_BUDGET_MS = 60000;

/** Free cells around each block, so belts can run between blocks; wider when routing fails */
const CORRIDORS = [1, 2, 3];
/** Free cells around the whole module for imports, exports and detours */
const ROUTING_MARGIN = 3;


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

/** Stone stoves: two rows (3 deep) around a fuel belt row, repeating every 7 rows */
const STOVE_UNIT = 7;
const FUEL_ROW = 3;
const STOVE_ID = "stone-stove";
const STEAM_HEATER_ID = "steam-heater";
const PLATFORM_HEIGHT: Record<"steam" | "stove", number> = { steam: 1, stove: 3 };

/** Heat slots per heating device and per machine (data/device-metadata.json) */
const HEATER_SLOTS = 9;
function slotsRequired(deviceId: string): number {
    const meta = (deviceMetadata as { heated_devices?: Record<string, { slots_required?: number }> }).heated_devices;
    return meta?.[deviceId]?.slots_required ?? 3;
}

/**
 * Where machine rows go, as offsets from the block's top edge (row 0 is the entry
 * row). On stoves, machines must stand on stove cells, so rows skip the fuel rows.
 */
function rowOffsets(rows: number, sy: number, rowPitch: number, heating: ModuleStep["heating"]): number[] {
    if (heating?.kind !== "stove") return Array.from({ length: rows }, (_, r) => 1 + r * rowPitch);
    const offsets: number[] = [];
    for (let y = 1; offsets.length < rows; y++) {
        let ok = true;
        for (let k = y; k < y + sy && ok; k++) ok = k % STOVE_UNIT !== FUEL_ROW;
        if (ok) {
            offsets.push(y);
            y += rowPitch - 1;
        }
    }
    return offsets;
}

/** Block depth for these rows: entry row, machine rows, exit row */
function blockDepth(rows: number, sy: number, rowPitch: number, heating: ModuleStep["heating"]): number {
    const offsets = rowOffsets(rows, sy, rowPitch, heating);
    return offsets[offsets.length - 1] + sy + 1;
}

/** Output lanes that carry two items end in a filter (2 rows) and two exit stubs (1 row) */
function filterRows(step: ModuleStep): number {
    return sortsOutputs(step) ? 3 : 0;
}

function sortsOutputs(step: ModuleStep): boolean {
    return step.outputs.length >= 2 && !step.unsorted;
}

function maxLevelsFor(step: ModuleStep, fp: BuildingFootprint, stacking: Stacking, opts: ModuleOptions): number {
    // A sorting filter is two cells tall, so machines with byproducts stay on one level
    if (stacking.kind === "none" || filterRows(step) > 0) return 1;
    const byHeight = Math.floor((opts.maxHeight - fp.size.z) / stacking.pitch) + 1;
    return Math.max(1, Math.min(opts.maxStack, byHeight));
}

/**
 * How a step's inputs reach its machines. With two or three different input items on
 * input ports that all face the lane, each item gets its own lane, one level above the
 * other, and each input port its own stub: a belt for the first item, a short lift down
 * for the others. Nothing is mixed. Otherwise one lane carries every input.
 */
interface FeedPlan {
    separate: boolean;
    /** Lane width on the input side: 1 (one lane) or 2 (stub column + lane column) */
    width: number;
    items: StepFlow[];
}

function feedPlan(step: ModuleStep, fp: BuildingFootprint, rot: Rotation): FeedPlan {
    const items = step.inputs;
    const inPorts = footprintPorts(fp, rot).filter((p) => p.medium === "belt" && p.dir === "in");
    const separate =
        items.length >= 2 &&
        items.length <= 3 &&
        inPorts.length >= items.length &&
        inPorts.every((p) => p.face === "left" && p.z === 0);
    return { separate, width: separate ? 2 : 1, items };
}

/** Machine x positions and block width for a row of columns */
function columnXs(columns: number, shared: boolean, sx: number, inWidth: number, pitchOverride?: number): { xs: number[]; width: number } {
    const xs: number[] = [];
    if (!shared) {
        const pitch = pitchOverride ?? inWidth + sx + 1;
        for (let c = 0; c < columns; c++) xs.push(c * pitch + inWidth);
        return { xs, width: columns * pitch };
    }
    // in | M → | out | ← M | in | M → | out ...: input groups serve the columns on both sides
    let cursor = 0;
    for (let c = 0; c < columns; c++) {
        const gap = c % 2 === 1 ? 1 : c === 0 ? inWidth : inWidth * 2 - 1;
        const x = cursor + gap;
        xs.push(x);
        cursor = x + sx;
    }
    const trailing = (columns - 1) % 2 === 0 ? 1 : inWidth;
    return { xs, width: cursor + trailing };
}

/** All block shapes that fit the options */
function* tierShapes(step: ModuleStep, fp: BuildingFootprint, rot: Rotation, stacking: Stacking, opts: ModuleOptions): Generator<TierShape> {
    const { x: sx, y: sy } = rotatedSize(fp, rot);
    const cap = Math.max(1, Math.min(laneCapacity(step.inputs, opts.beltSpeed), laneCapacity(step.outputs, opts.beltSpeed)));
    const maxLevels = maxLevelsFor(step, fp, stacking, opts);
    const rowPitch = sy;
    const feed = feedPlan(step, fp, rot);

    // Sharing a lane between two columns saves width but doubles the lane's load
    for (const shared of cap >= 2 ? [true, false] : [false]) {
        for (let levels = 1; levels <= maxLevels; levels++) {
            // A beam deck spans one column on its own, so stacked columns don't share lanes
            const deck = levels > 1 && stacking.kind === "beam-deck";
            if (deck && shared) continue;
            const columnPitch = deck ? stacking.beamLength! + feed.width - 1 : shared ? sx + 1 : sx + feed.width + 1;
            for (let columns = 1; ; columns++) {
                const { width } = columnXs(columns, shared, sx, feed.width, deck ? columnPitch : undefined);
                if (width > opts.maxWidth && columns > 1) break;
                const maxRowsByLane = shared && columns > 1 ? Math.floor(cap / 2) : cap;
                // The free row in front of the block counts too
                let rows = 1;
                while (rows < maxRowsByLane && blockDepth(rows + 1, sy, rowPitch, step.heating) <= opts.maxDepth - 1) rows++;
                yield { columns, rows, levels, shared, width, depth: blockDepth(rows, sy, rowPitch, step.heating) + filterRows(step), rowPitch, columnPitch, deck };
                if (width > opts.maxWidth) break;
            }
        }
    }
}

/** Smallest footprint for n machines, or the biggest shape when n doesn't fit in one block */
const MIN_PER_DECK_LEVEL = 2;
/** Machines this big (nurseries) stack one a level anyway: each level saves a lot of floor */
const BIG_MACHINE_FLOOR = 9;

function chooseShape(step: ModuleStep, n: number, fp: BuildingFootprint, rot: Rotation, stacking: Stacking, opts: ModuleOptions): TierShape {
    const { y: sy } = rotatedSize(fp, rot);
    let best: TierShape | null = null;
    let bestScore = Infinity;
    let biggest: TierShape | null = null;

    for (const shape of tierShapes(step, fp, rot, stacking, opts)) {
        const capacity = shape.columns * shape.rows * shape.levels;
        if (!biggest || capacity > biggest.columns * biggest.rows * biggest.levels) biggest = shape;
        if (capacity < n) continue;
        // A beam deck with its pillars and raised lanes isn't worth it for one small machine a level
        // (the block can still go on top of another one as a whole)
        if (shape.deck && n < shape.levels * MIN_PER_DECK_LEVEL && rotatedSize(fp, rot).x * sy < BIG_MACHINE_FLOOR) continue;
        // Trim rows to what n needs
        const rows = Math.ceil(n / (shape.columns * shape.levels));
        const trimmed = { ...shape, rows, depth: blockDepth(rows, sy, shape.rowPitch, step.heating) + filterRows(step) };
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

/** Rotation that turns a piece's port on `base` to face `want` */
function rotFor(base: Side, want: Side): Rotation {
    const order: Side[] = ["left", "up", "right", "down"];
    return ((order.indexOf(want) - order.indexOf(base) + 4) % 4) as Rotation;
}

interface PortHit {
    /** Side of the lane cell the item moves through */
    side: Side;
    machine: Placement;
}

/** Something under (x, y, z) that a belt or frame can stand on */
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
    const offsets = rowOffsets(shape.rows, sy, shape.rowPitch, step.heating);
    const feed = feedPlan(step, fp, rot);
    const { xs } = columnXs(shape.columns, shape.shared, rotatedSize(fp, rot).x, feed.width, shape.deck ? shape.columnPitch : undefined);
    let placed = 0;
    for (let level = 0; level < shape.levels && placed < count; level++) {
        for (let col = 0; col < shape.columns && placed < count; col++) {
            const flipped = shape.shared && col % 2 === 1;
            const x = origin.x + xs[col];
            for (let row = 0; row < shape.rows && placed < count; row++) {
                const y = origin.y + offsets[row];
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
                    pipeEnd: pipeEndFor(step),
                });
                placed++;
            }
        }
    }
    placements.push(...machines, ...decks);

    // Which lane cells machine ports point at, per level
    const lanes: LaneInfo[] = [];
    const belts: Placement[] = [];
    const lifts: Placement[] = [];
    let offLanePorts = 0;
    const levelsUsed = Math.max(...machines.map((m) => Math.round((m.z - origin.z) / stacking.pitch))) + 1;
    const top = origin.y;
    // Lanes end above the filter rows when outputs need sorting
    const bottom = origin.y + shape.depth - 1 - filterRows(step);
    const laneItems = (flows: StepFlow[], machineCount: number) => flows.map((fl) => ({ itemName: fl.itemName, rate: fl.perMachineRate * machineCount }));
    const inputLanes: InputLane[] = [];

    for (let level = 0; level < levelsUsed; level++) {
        const z = levelZ(level);
        const hits = new Map<number, Map<number, { ins: PortHit[]; outs: PortHit[] }>>(); // x → y → hits
        // Separate feed: lane column → item index → y → sides toward the stubs
        const feedHits = new Map<number, Map<number, Map<number, { sides: Side[]; machines: Set<string> }>>>();

        for (const m of machines.filter((mm) => mm.z === z)) {
            const ports = placementPorts(m).filter((p) => p.medium === "belt");
            const inPorts = ports
                .filter((p) => p.dir === "in" && (p.face === "left" || p.face === "right") && p.z === z)
                .sort((a, b) => a.y - b.y || a.x - b.x);
            for (const port of ports) {
                if (port.z !== z || port.face === "up" || port.face === "down" || port.face === "top" || port.face === "base") {
                    offLanePorts++;
                    continue;
                }
                const laneSide = oppositeSide(port.face);
                const stubX = port.face === "left" ? port.x - 1 : port.x + 1;

                if (port.dir === "in" && feed.separate) {
                    const item = inPorts.indexOf(port) % feed.items.length;
                    const laneX = port.face === "left" ? stubX - 1 : stubX + 1;
                    const towardLane = port.face; // the stub takes items from the lane side
                    if (item === 0) {
                        const piece = beltPieceFor([towardLane], [laneSide])!;
                        belts.push({ uid: nextUid("b"), id: piece.id, x: stubX, y: port.y, z, rot: piece.rot, nodeKey: step.nodeKey, lane: "in", label: feed.items[0].itemName });
                    } else {
                        // Short lift from the item's lane level down into the port
                        for (let lz = z; lz <= z + item; lz++) {
                            const isTop = lz === z + item;
                            const isBottom = lz === z;
                            const id = isTop ? "conveyer-lift-end-downwards" : isBottom ? "conveyer-lift-downwards" : "conveyer-lift-body";
                            const rotation = isTop ? rotFor("down", towardLane) : isBottom ? rotFor("left", laneSide) : 0;
                            lifts.push({ uid: nextUid("l"), id, x: stubX, y: port.y, z: lz, rot: rotation, nodeKey: step.nodeKey, lane: "in", label: feed.items[item].itemName });
                        }
                    }
                    const byItem = feedHits.get(laneX) ?? new Map();
                    feedHits.set(laneX, byItem);
                    const byY = byItem.get(item) ?? new Map();
                    byItem.set(item, byY);
                    const at = byY.get(port.y) ?? { sides: [], machines: new Set<string>() };
                    byY.set(port.y, at);
                    at.sides.push(laneSide);
                    at.machines.add(m.uid);
                    continue;
                }

                const byY = hits.get(stubX) ?? new Map();
                hits.set(stubX, byY);
                const at = byY.get(port.y) ?? { ins: [], outs: [] };
                byY.set(port.y, at);
                // Lane sends items into machine inputs and takes them from machine outputs
                if (port.dir === "in") at.outs.push({ side: laneSide, machine: m });
                else at.ins.push({ side: laneSide, machine: m });
            }
        }

        // One lane per input item, stacked one level apart (emitted below)
        for (const [laneX, byItem] of feedHits) {
            for (const [item, byY] of byItem) {
                const hits = new Map([...byY.entries()].map(([y, h]) => [y, h.sides]));
                const machinesServed = new Set([...byY.values()].flatMap((h) => [...h.machines]));
                inputLanes.push({ x: laneX, z: z + item, level, items: [feed.items[item]], hits, machines: machinesServed, separate: true });
            }
        }

        for (const [laneX, byY] of [...hits.entries()].sort((a, b) => a[0] - b[0])) {
            const ys = [...byY.keys()];
            const feeds = ys.some((y) => byY.get(y)!.outs.length > 0);
            const collects = ys.some((y) => byY.get(y)!.ins.length > 0);
            // Pure input lanes are emitted below, chained across levels and fed by one header
            if (feeds && !collects) {
                const laneHits = new Map(ys.map((y) => [y, [...new Set(byY.get(y)!.outs.map((h) => h.side))]] as [number, Side[]]));
                const machinesServed = new Set([...byY.values()].flatMap((h) => h.outs.map((p) => p.machine.uid)));
                inputLanes.push({ x: laneX, z, level, items: step.inputs, hits: laneHits, machines: machinesServed, separate: false });
                continue;
            }
            const yStart = feeds ? top : Math.min(...ys.filter((y) => byY.get(y)!.ins.length > 0));
            const yEnd = collects ? bottom : Math.max(...ys.filter((y) => byY.get(y)!.outs.length > 0));

            const laneMachines = (pick: "ins" | "outs") =>
                new Set([...byY.values()].flatMap((h) => h[pick].map((p) => p.machine.uid))).size;
            const sorted = collects && sortsOutputs(step);

            for (let y = yStart; y <= yEnd; y++) {
                const at = byY.get(y);
                const ins: Side[] = [...new Set(at?.ins.map((h) => h.side) ?? [])];
                const outs: Side[] = [...new Set(at?.outs.map((h) => h.side) ?? [])];
                if (y > yStart || feeds) ins.push("up");
                if (y < yEnd || collects) outs.push("down");
                const piece = beltPieceFor(ins, outs) ?? beltPieceFor(["up"], ["down"])!;
                const lane = feeds ? "in" : "out";
                const label = (lane === "in" ? step.inputs : step.outputs).map((fl) => fl.itemName).join(" + ");
                const belt: Placement = { uid: nextUid("b"), id: piece.id, x: laneX, y, z, rot: piece.rot, nodeKey: step.nodeKey, lane, label };
                // The open ends are where the router connects the block to the rest of the module
                if (feeds && y === yStart) belt.laneEnd = { kind: "in", items: laneItems(step.inputs, laneMachines("outs")) };
                else if (collects && y === yEnd && !sorted) belt.laneEnd = { kind: "out", items: laneItems(step.outputs, laneMachines("ins")) };
                belts.push(belt);
            }

            // Two items on an output lane: a filter sorts them onto two belts, one item each
            if (sorted) {
                const [first, second] = step.outputs;
                const served = laneMachines("ins");
                lifts.push({ uid: nextUid("x"), id: "filter-vert", x: laneX, y: yEnd + 1, z, rot: rotFor("left", "up"), nodeKey: step.nodeKey, filterItem: first.itemName, label: `filter: ${first.itemName}` });
                for (const [k, out] of [first, second].entries()) {
                    const piece = beltPieceFor(["up"], ["down"])!;
                    belts.push({
                        uid: nextUid("b"), id: piece.id, x: laneX, y: yEnd + 3, z: z + k, rot: piece.rot, nodeKey: step.nodeKey, lane: "out", label: out.itemName,
                        laneEnd: { kind: "out", items: laneItems([out], served) },
                    });
                }
            }

            if (feeds) lanes.push(laneInfo("in", laneX - origin.x, level, z, step.inputs, laneMachines("outs"), beltSpeed));
            if (collects) lanes.push(laneInfo("out", laneX - origin.x, level, z, step.outputs, laneMachines("ins"), beltSpeed));
        }
    }
    const fed = emitInputLanes(inputLanes, { top, bottom, beltSpeed, nodeKey: step.nodeKey, origin });
    belts.push(...fed.belts);
    lifts.push(...fed.lifts);
    lanes.push(...fed.lanes);

    placements.push(...lifts);
    placements.push(...belts);

    // Heated machines stand on a platform of steam heaters or stone stoves
    const platform = step.heating ? heatingPlatform(step, shape.width, shape.depth, origin, machines, step.deviceId) : null;
    if (platform) placements.push(...platform.placements);

    // Beam ends rest on lab stand pillars; upper belts rest on beams, elsewhere on pillars too
    const occupancy = buildOccupancy(placements);
    const makeUid = () => nextUid("f");
    for (const d of [...decks].sort((a, c) => a.z - c.z)) {
        const length = stacking.beamLength!;
        for (const endX of [d.x, d.x + length - 1]) placements.push(...supportColumn(occupancy, endX, d.y, d.z, 0, makeUid));
    }
    const liftBottoms = fed.lifts.filter((l) => l.id === "conveyer-lift-upwards");
    const raised = [...belts, ...liftBottoms, ...(platform?.belts ?? [])].filter((bb) => bb.z > 0).sort((a, c) => a.z - c.z);
    for (const b of raised) placements.push(...supportColumn(occupancy, b.x, b.y, b.z, 0, makeUid));

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
            height: origin.z + (levelsUsed - 1) * stacking.pitch + sz,
            width: shape.width,
            depth: Math.max(shape.depth, platform?.depth ?? 0),
            turned: false,
            columns: Math.min(shape.columns, Math.ceil(count / (shape.rows * shape.levels)) || 1),
            rows: shape.rows,
            levels: levelsUsed,
            stacking: levelsUsed > 1 ? (shape.deck ? "beam-deck" : stacking.kind) : "none",
            lanes,
            fluidInputs: step.fluidInputs,
            offLanePorts,
            heating: platform?.info,
            mixedInputs: step.inputs.length >= 2 && !feed.separate,
        },
    };
}

/** An input lane before its pieces are laid: column, height and the rows it feeds */
interface InputLane {
    x: number;
    z: number;
    level: number;
    items: StepFlow[];
    /** Row → sides of the lane cell that items leave toward machine inputs */
    hits: Map<number, Side[]>;
    machines: Set<string>;
    /** One item of a separated feed (its stubs and lifts are already placed) */
    separate: boolean;
}

function laneRate(lane: InputLane): number {
    return lane.items.reduce((sum, fl) => sum + fl.perMachineRate, 0) * lane.machines.size;
}

/**
 * Lays the input lanes so each item enters a block through as few belts as possible:
 *
 * - The levels of one lane column are chained: the lowest lane runs down, a lift at
 *   its end carries the rest up to the next level, which runs back, and so on. One
 *   entry feeds every level, as long as the whole column fits on one belt.
 * - The column entries of an item are fed by one header belt in the free row in front
 *   of the block (split into several headers only when one belt can't carry it all).
 */
function emitInputLanes(
    inputLanes: InputLane[],
    ctx: { top: number; bottom: number; beltSpeed: number; nodeKey: string; origin: { x: number; y: number; z: number } },
): { belts: Placement[]; lifts: Placement[]; lanes: LaneInfo[] } {
    const belts: Placement[] = [];
    const lifts: Placement[] = [];
    const lanes: LaneInfo[] = [];
    const { top, bottom, nodeKey } = ctx;
    const itemKey = (lane: InputLane) => lane.items.map((fl) => fl.itemName).join(" + ");
    const opposite = (d: Side): Side => (d === "down" ? "up" : d === "up" ? "down" : d === "left" ? "right" : "left");
    /** Entry points left after chaining: a belt at the top row taking items from above */
    const entries: { belt: Placement; items: { itemName: string; rate: number }[]; x: number; z: number; key: string }[] = [];

    const lift = (x: number, y: number, fromZ: number, toZ: number, inSide: Side, outSide: Side, label: string) => {
        for (let lz = fromZ; lz <= toZ; lz++) {
            const id = lz === fromZ ? "conveyer-lift-upwards" : lz === toZ ? "conveyer-lift-end-upwards" : "conveyer-lift-body";
            const rot = lz === fromZ ? rotFor("left", inSide) : lz === toZ ? rotFor("down", outSide) : 0;
            lifts.push({ uid: nextUid("l"), id, x, y, z: lz, rot, nodeKey, lane: "in", label });
        }
    };

    const layLane = (lane: InputLane, dir: Side, start: number, end: number, continues: boolean) => {
        const back = opposite(dir);
        const step = dir === "down" ? 1 : -1;
        let first: Placement | null = null;
        for (let y = start; dir === "down" ? y <= end : y >= end; y += step) {
            const outs: Side[] = [...(lane.hits.get(y) ?? [])];
            if (y !== end || continues) outs.push(dir);
            const piece = beltPieceFor([back], outs) ?? beltPieceFor([back], [dir])!;
            const belt: Placement = { uid: nextUid("b"), id: piece.id, x: lane.x, y, z: lane.z, rot: piece.rot, nodeKey, lane: "in", label: itemKey(lane) };
            belts.push(belt);
            first ??= belt;
        }
        lanes.push(laneInfo("in", lane.x - ctx.origin.x, lane.level, lane.z, lane.items, lane.machines.size, ctx.beltSpeed));
        return first!;
    };

    // Columns: lanes of the same items stacked in one x, lowest first
    const columns = new Map<string, InputLane[]>();
    for (const lane of inputLanes) {
        const key = `${lane.x}|${lane.separate ? lane.z : "chain"}|${itemKey(lane)}`;
        columns.set(key, [...(columns.get(key) ?? []), lane]);
    }

    for (const column of columns.values()) {
        column.sort((a, b) => a.z - b.z);
        const total = column.reduce((sum, l) => sum + laneRate(l), 0);
        const chain = column.length > 1 && !column[0].separate && total <= ctx.beltSpeed + 1e-6;
        const groups = chain ? [column] : column.map((l) => [l]);

        for (const group of groups) {
            const rate = (lanes: InputLane[]) =>
                lanes[0].items.map((fl) => ({ itemName: fl.itemName, rate: fl.perMachineRate * lanes.reduce((sum, l) => sum + l.machines.size, 0) }));
            group.forEach((lane, k) => {
                const dir: Side = k % 2 === 0 ? "down" : "up";
                const hasNext = k < group.length - 1;
                const hitRows = [...lane.hits.keys()];
                const start = k === 0 ? top : dir === "up" ? bottom - 1 : top + 1;
                const end = hasNext ? (dir === "down" ? bottom - 1 : top + 1) : dir === "down" ? Math.max(...hitRows) : Math.min(...hitRows);
                const first = layLane(lane, dir, start, end, hasNext);
                if (k === 0) entries.push({ belt: first, items: rate(group), x: lane.x, z: lane.z, key: itemKey(lane) });
                if (hasNext) {
                    // At the end of the line, a lift takes the rest up to the next level, which runs back
                    const liftRow = dir === "down" ? bottom : top;
                    lift(lane.x, liftRow, lane.z, group[k + 1].z, dir === "down" ? "up" : "down", dir === "down" ? "up" : "down", itemKey(lane));
                }
            });
        }
    }

    // One header per item and height in the free row in front of the block
    const byKey = new Map<string, typeof entries>();
    entries.forEach((e) => byKey.set(`${e.z}|${e.key}`, [...(byKey.get(`${e.z}|${e.key}`) ?? []), e]));
    for (const group of byKey.values()) {
        group.sort((a, b) => a.x - b.x);
        // Split into headers that each fit on one belt
        const segments: (typeof entries)[] = [];
        let current: typeof entries = [];
        let load = 0;
        for (const e of group) {
            const r = e.items.reduce((sum, i) => sum + i.rate, 0);
            if (current.length && load + r > ctx.beltSpeed + 1e-6) {
                segments.push(current);
                current = [];
                load = 0;
            }
            current.push(e);
            load += r;
        }
        if (current.length) segments.push(current);

        for (const segment of segments) {
            const sum = segment[0].items.map((it) => ({ itemName: it.itemName, rate: segment.reduce((acc, e) => acc + (e.items.find((x) => x.itemName === it.itemName)?.rate ?? 0), 0) }));
            if (segment.length === 1) {
                segment[0].belt.laneEnd = { kind: "in", items: sum };
                continue;
            }
            const y = top - 1;
            const z = segment[0].z;
            const xs = new Set(segment.map((e) => e.x));
            const lastX = segment[segment.length - 1].x;
            for (let x = segment[0].x; x <= lastX; x++) {
                const outs: Side[] = [];
                if (xs.has(x)) outs.push("down");
                if (x < lastX) outs.push("right");
                const ins: Side[] = [x === segment[0].x ? "up" : "left"];
                const piece = beltPieceFor(ins, outs) ?? beltPieceFor(ins, ["right"])!;
                const belt: Placement = { uid: nextUid("b"), id: piece.id, x, y, z, rot: piece.rot, nodeKey, lane: "in", label: segment[0].key };
                if (x === segment[0].x) belt.laneEnd = { kind: "in", items: sum };
                belts.push(belt);
            }
        }
    }
    return { belts, lifts, lanes };
}

/** Pipe connections a machine needs: fluid inputs (in) or fluid outputs (out) */
function pipeEndFor(step: ModuleStep): Placement["pipeEnd"] {
    const toRates = (list: StepFlow[]) => list.map((fl) => ({ itemName: fl.itemName, rate: fl.perMachineRate }));
    if (step.fluids?.inputs.length) return { kind: "in", items: toRates(step.fluids.inputs) };
    if (step.fluids?.outputs.length) return { kind: "out", items: toRates(step.fluids.outputs) };
    return undefined;
}

/**
 * Steam: heaters back to back (they pass steam to each other), one pipe input per row.
 * Stoves: rows in pairs facing a fuel belt row between them, as players build it.
 * The platform covers the whole block, so machines and lanes stand on it.
 */
function heatingPlatform(step: ModuleStep, width: number, depth: number, origin: { x: number; y: number; z: number }, machines: Placement[], deviceId: string) {
    const heating = step.heating!;
    const placements: Placement[] = [];
    const belts: Placement[] = [];
    const cols = Math.ceil(width / 3);
    const top = origin.y;
    let devices = 0;
    let platformDepth = 0;
    // Only where a machine stands: cells under the machines' foundations
    const heatedCells = new Set(
        machines.flatMap((m) => placementCells(m).filter((c) => c.foundation && c.z === origin.z).map((c) => `${c.x},${c.y}`)),
    );
    const underMachine = (x: number, y: number) => {
        for (let dx = 0; dx < 3; dx++) for (let dy = 0; dy < 3; dy++) if (heatedCells.has(`${x + dx},${y + dy}`)) return true;
        return false;
    };

    if (heating.kind === "steam") {
        const rows = Math.ceil(depth / 3);
        for (let r = 0; r < rows; r++) {
            let first = true;
            for (let c = 0; c < cols; c++) {
                const x = origin.x + c * 3;
                const y = top + r * 3;
                if (!underMachine(x, y)) continue;
                const heater: Placement = { uid: nextUid("h"), id: STEAM_HEATER_ID, x, y, z: 0, rot: 0 };
                // The first heater of a row takes the steam; the rest get it through their neighbour
                if (first) heater.pipeEnd = { kind: "in", items: [{ itemName: heating.fuelItem, rate: heating.fuelRate / rows }] };
                first = false;
                placements.push(heater);
                devices++;
                platformDepth = Math.max(platformDepth, (r + 1) * 3);
            }
        }
    } else {
        const fuelRows: number[] = [];
        for (let u = 0; u * STOVE_UNIT < depth; u++) {
            const y0 = u * STOVE_UNIT;
            const lower = y0 + FUEL_ROW + 1 < depth;
            const upperAt = new Set<number>();
            const lowerAt = new Set<number>();
            for (let c = 0; c < cols; c++) {
                const x = origin.x + c * 3;
                if (underMachine(x, top + y0)) {
                    placements.push({ uid: nextUid("h"), id: STOVE_ID, x, y: top + y0, z: 0, rot: 0 });
                    upperAt.add(c);
                    devices++;
                }
                if (lower && underMachine(x, top + y0 + FUEL_ROW + 1)) {
                    placements.push({ uid: nextUid("h"), id: STOVE_ID, x, y: top + y0 + FUEL_ROW + 1, z: 0, rot: 2 });
                    lowerAt.add(c);
                    devices++;
                }
            }
            const used = [...upperAt, ...lowerAt];
            if (used.length === 0) continue;
            fuelRows.push(y0 + FUEL_ROW);
            platformDepth = lowerAt.size ? y0 + STOVE_UNIT : y0 + FUEL_ROW + 1;
            // Fuel belt: in from the left, splitting up and down into the stoves' fuel ports
            const lastPort = Math.max(...used) * 3 + 1;
            for (let x = 0; x <= lastPort; x++) {
                const c = Math.floor(x / 3);
                const port = x % 3 === 1;
                const outs: Side[] = [];
                if (port && upperAt.has(c)) outs.push("up");
                if (port && lowerAt.has(c)) outs.push("down");
                if (x < lastPort) outs.push("right");
                const piece = beltPieceFor(["left"], outs) ?? beltPieceFor(["left"], ["right"])!;
                const belt: Placement = { uid: nextUid("b"), id: piece.id, x: origin.x + x, y: top + y0 + FUEL_ROW, z: 1, rot: piece.rot, lane: "in", label: heating.fuelItem, nodeKey: step.nodeKey };
                belts.push(belt);
            }
        }
        const share = heating.fuelRate / Math.max(1, fuelRows.length);
        belts.filter((b) => b.x === origin.x).forEach((b) => (b.laneEnd = { kind: "in", items: [{ itemName: heating.fuelItem, rate: share }] }));
        placements.push(...belts);
    }

    return {
        placements,
        belts: heating.kind === "stove" ? belts : [],
        depth: platformDepth,
        info: {
            kind: heating.kind,
            devices,
            fuelItem: heating.fuelItem,
            fuelRate: heating.fuelRate,
            slotsUsed: machines.length * slotsRequired(deviceId),
            slotsAvailable: devices * HEATER_SLOTS,
        },
    };
}

function laneInfo(kind: "in" | "out", x: number, level: number, z: number, flows: StepFlow[], machines: number, beltSpeed: number): LaneInfo {
    const items = flows.map((f) => ({ itemName: f.itemName, perMachineRate: f.perMachineRate * machines }));
    const rate = items.reduce((sum, f) => sum + f.perMachineRate, 0);
    return { kind, x, level, z, items, rate, overBelt: rate > beltSpeed + 1e-6 };
}

/** Cauldron columns: a cauldron and its in-stub, out-stub and a free column for lifts */
const CAULDRON_PITCH = 5;

/**
 * Cauldrons, laid out like players build them: a row of columns, each on its own
 * heating pad (steam) or stove, with cauldrons stacked on cauldrons above it (they share
 * the heat). Every input port gets a one-cell stub belt (top, left, bottom) and the
 * output port one on the right; the router belts the stubs to the rest of the module.
 */
function buildCauldronTier(step: ModuleStep, count: number, fp: BuildingFootprint, origin: { x: number; y: number; z: number }, index: number, opts: ModuleOptions, can: Capabilities) {
    const heating = step.heating!;
    const steam = heating.kind === "steam";
    const baseZ = steam ? PLATFORM_HEIGHT.steam : PLATFORM_HEIGHT.stove;
    const pitch = fp.size.z;
    const maxLevels = can.lifts ? Math.max(1, Math.min(opts.maxStack, Math.floor((opts.maxHeight - baseZ - 1) / pitch))) : 1;
    // Stack first (cauldrons share the heat below), then add columns
    const levels = Math.min(maxLevels, count);
    const columns = Math.ceil(count / levels);

    // Ports by side: which input item each one takes (an item used twice takes two ports)
    const portItems: StepFlow[] = [];
    const totalCount = step.inputs.reduce((s, f) => s + f.perMachineRate, 0) || 1;
    for (const f of step.inputs) {
        const ports = Math.max(1, Math.round((f.perMachineRate / totalCount) * 3));
        for (let k = 0; k < ports && portItems.length < 3; k++) portItems.push({ itemName: f.itemName, perMachineRate: f.perMachineRate / ports });
    }
    const inSides: { side: Side; dx: number; dy: number }[] = [
        { side: "up", dx: 1, dy: -1 },
        { side: "down", dx: 1, dy: 3 },
        { side: "left", dx: -1, dy: 1 },
    ];

    const placements: Placement[] = [];
    const stubs: Placement[] = [];
    let placed = 0;
    for (let col = 0; col < columns && placed < count; col++) {
        const x = origin.x + 1 + col * CAULDRON_PITCH;
        const y = origin.y + 1;
        const heater: Placement = { uid: nextUid("h"), id: steam ? STEAM_HEATER_ID : STOVE_ID, x, y, z: 0, rot: 0 };
        if (steam) heater.pipeEnd = { kind: "in", items: [{ itemName: heating.fuelItem, rate: heating.fuelRate / columns }] };
        placements.push(heater);
        if (!steam) {
            // Stove fuel enters from below
            const piece = beltPieceFor(["down"], ["up"])!;
            stubs.push({
                uid: nextUid("b"), id: piece.id, x: x + 1, y: y + 3, z: 1, rot: piece.rot, lane: "in", label: heating.fuelItem, nodeKey: step.nodeKey,
                laneEnd: { kind: "in", items: [{ itemName: heating.fuelItem, rate: heating.fuelRate / columns }] },
            });
        }
        for (let level = 0; level < levels && placed < count; level++, placed++) {
            const z = baseZ + level * pitch;
            placements.push({ uid: nextUid("m"), id: step.deviceId, x, y, z, rot: 0, nodeKey: step.nodeKey, label: step.itemName });
            const portZ = z + 1;
            portItems.forEach((flow, k) => {
                const { side, dx, dy } = inSides[k];
                // The stub sits on the port's side and runs into the cauldron
                const piece = beltPieceFor([side], [oppositeSide(side)])!;
                stubs.push({
                    uid: nextUid("b"), id: piece.id, x: x + dx, y: y + dy, z: portZ, rot: piece.rot, lane: "in", label: flow.itemName, nodeKey: step.nodeKey,
                    laneEnd: { kind: "in", items: [{ itemName: flow.itemName, rate: flow.perMachineRate }] },
                });
            });
            const out = beltPieceFor(["left"], ["right"])!;
            stubs.push({
                uid: nextUid("b"), id: out.id, x: x + 3, y: y + 1, z: portZ, rot: out.rot, lane: "out", label: step.outputs.map((o) => o.itemName).join(" + "), nodeKey: step.nodeKey,
                laneEnd: { kind: "out", items: step.outputs.map((o) => ({ itemName: o.itemName, rate: o.perMachineRate })) },
            });
        }
    }
    placements.push(...stubs);
    const occupancy = buildOccupancy(placements);
    const makeUid = () => nextUid("f");
    for (const b of [...stubs].filter((s) => s.z > 0).sort((a, c) => a.z - c.z)) placements.push(...supportColumn(occupancy, b.x, b.y, b.z, 0, makeUid));

    const width = 1 + columns * CAULDRON_PITCH;
    const depth = 5;
    const lanes: LaneInfo[] = [
        laneInfo("in", 0, 0, baseZ + 1, step.inputs, count, opts.beltSpeed),
        laneInfo("out", width - 1, 0, baseZ + 1, step.outputs, count, opts.beltSpeed),
    ];
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
            height: baseZ + levels * pitch + 1,
            width,
            depth,
            turned: false,
            columns,
            rows: 1,
            levels,
            stacking: levels > 1 ? ("direct" as const) : ("none" as const),
            lanes,
            fluidInputs: step.fluidInputs,
            offLanePorts: 0,
            heating: {
                kind: heating.kind,
                devices: columns,
                fuelItem: heating.fuelItem,
                fuelRate: heating.fuelRate,
                slotsUsed: count,
                slotsAvailable: columns * levels,
            },
        } satisfies TierInfo,
    };
}


/** Fuel that a stone stove burns when steam heating pads aren't unlocked */
const STOVE_FALLBACK_FUEL = "Coal";

/**
 * Heating the player can build: steam pads need their unlock, otherwise stoves (a steam
 * plan then burns coal instead, the same heat)
 */
function withUnlockedHeating(step: ModuleStep, can: Capabilities): ModuleStep {
    const heating = step.heating;
    if (!heating || heating.kind !== "steam" || can.steam || !can.stoves) return step;
    const heatOf = (item: string) => getItem(item)?.heat_value ?? 0;
    const fuelItem = isFluidItem(heating.fuelItem) ? STOVE_FALLBACK_FUEL : heating.fuelItem;
    const fuelRate = heatOf(fuelItem) > 0 ? (heating.fuelRate * heatOf(heating.fuelItem)) / heatOf(fuelItem) : heating.fuelRate;
    return { ...step, heating: { kind: "stove", fuelItem, fuelRate } };
}

/** Lay every step out as blocks and pack them tightly on the ground (or as modules side by side, see moduleGroups) */
export function generateModule(allSteps: ModuleStep[], options: ModuleOptions): GeneratedModule {
    const groups = moduleGroupsOf(allSteps, options.moduleGroups);
    if (!groups) return generateBlocks(allSteps, options, TIME_BUDGET_MS, true);
    if (groups.length === 1) return generateBlocks(groups[0].steps, { ...options, stackBlocks: groups[0].tower || options.stackBlocks }, TIME_BUDGET_MS, true);
    return generateGrouped(allSteps, groups, options);
}

/**
 * `budgetMs`: stop trying more layouts after this long once one routes everything.
 * `finish`: tidy up the supports (off while it is one module of several: that comes last)
 */
function generateBlocks(allSteps: ModuleStep[], options: ModuleOptions, budgetMs: number, finish: boolean): GeneratedModule {
    const blocks: { placements: Placement[]; info: TierInfo }[] = [];
    const can = capabilities(options.unlocks);
    const steps = allSteps.map((st) => withUnlockedHeating(can.filters ? st : { ...st, unsorted: true }, can));
    // Upper levels are fed by lifts; decks need beams
    const allowed = (stacking: Stacking): Stacking =>
        !can.lifts || (stacking.kind === "beam-deck" && !can.beams) ? { kind: "none", pitch: stacking.pitch } : stacking;

    for (const step of steps) {
        const fp = getFootprint(step.deviceId);
        const count = Math.ceil(step.machines - 1e-9);
        if (!fp || count <= 0) continue;
        const rot = machineRotation(fp);
        if (STACKS_ON_ITSELF.has(step.deviceId) && step.heating) {
            // Cauldrons: their own layout, as many per block as fit
            const perBlock = Math.max(1, Math.floor((options.maxWidth - 1) / CAULDRON_PITCH)) * Math.max(1, options.maxStack);
            for (let left = count; left > 0; left -= perBlock) {
                const block = buildCauldronTier(step, Math.min(left, perBlock), fp, { x: 0, y: 1, z: 0 }, blocks.length, options, can);
                block.info.y = 0;
                block.info.depth += 1;
                block.placements = block.placements.map((p) => ({ ...p, block: blocks.length }));
                blocks.push(block);
            }
            continue;
        }
        // Heated machines need their heat source right under them: no stacking
        const stacking: Stacking = step.heating ? { kind: "none", pitch: fp.size.z } : allowed(stackingFor(fp, rot));
        const baseZ = step.heating ? PLATFORM_HEIGHT[step.heating.kind] : 0;

        // Split into several blocks when one can't hold all machines
        const biggest = chooseShape(step, Infinity, fp, rot, stacking, options);
        const perBlock = biggest.columns * biggest.rows * biggest.levels;
        const blockCount = Math.ceil(count / perBlock);

        for (let t = 0; t < blockCount; t++) {
            const n = Math.floor(count / blockCount) + (t < count % blockCount ? 1 : 0);
            const shape = chooseShape(step, n, fp, rot, stacking, options);
            // Row 0 stays free so belts can be brought to the input lanes
            const block = buildTier(step, n, shape, fp, rot, stacking, { x: 0, y: 1, z: baseZ }, blocks.length, options.beltSpeed);
            block.info.y = 0;
            block.info.depth += 1;
            block.placements = block.placements.map((p) => ({ ...p, block: blocks.length }));
            blocks.push(block);
        }
    }

    // Production stage of each step: how many steps lie between it and the module's inputs
    const stepByNode = new Map(steps.map((st) => [st.nodeKey, st]));
    const producers = (item: string) => steps.filter((st) => st.outputs.some((o) => o.itemName === item));
    const stageMemo = new Map<string, number>();
    const stageOf = (st: ModuleStep, seen = new Set<string>()): number => {
        if (stageMemo.has(st.nodeKey)) return stageMemo.get(st.nodeKey)!;
        if (seen.has(st.nodeKey)) return 0;
        seen.add(st.nodeKey);
        const feeders = st.inputs.flatMap((i) => producers(i.itemName)).filter((p) => p.nodeKey !== st.nodeKey);
        const stage = feeders.length ? Math.max(...feeders.map((p) => stageOf(p, seen))) + 1 : 0;
        stageMemo.set(st.nodeKey, stage);
        return stage;
    };
    const flow = blocks.map((b) => {
        const st = stepByNode.get(b.info.nodeKey)!;
        const feederNodes = new Set(st.inputs.flatMap((i) => producers(i.itemName)).map((p) => p.nodeKey));
        const feeders = blocks.map((o, i) => (feederNodes.has(o.info.nodeKey) ? i : -1)).filter((i) => i >= 0);
        // How many belts' worth this block takes from each feeder (its inputs that feeder makes)
        const feederWeights = feeders.map((i) => {
            const made = new Set(stepByNode.get(blocks[i].info.nodeKey)!.outputs.map((o) => o.itemName));
            const rate = st.inputs.filter((inp) => made.has(inp.itemName)).reduce((sum, inp) => sum + inp.perMachineRate * b.info.machines, 0);
            return Math.max(0.25, rate / options.beltSpeed);
        });
        return { stage: stageOf(st), feeders, feederWeights };
    });

    // Keep the layout that routes everything with the fewest lifts and the least floor
    let best: GeneratedModule | null = null;
    const score = (m: GeneratedModule) =>
        m.routes.filter((r) => !r.ok).length * 100000 +
        m.placements.filter((p) => p.id === "conveyer-lift-upwards" || p.id === "conveyer-lift-downwards").length * 40 +
        // Belt length between blocks: long transports are what makes a module sprawl
        m.placements.filter((p) => p.uid.startsWith("rb-")).length * 3 +
        m.size[0] * m.size[1];
    // Near-feeder and stage-row layouts per corridor width, wider corridors if belts don't fit;
    // tight packing only as a last resort
    const attempts: [number, LayoutMode][] = [
        ...CORRIDORS.flatMap((c): [number, LayoutMode][] => [[c, "near"], [c, "flow"]]),
        [CORRIDORS[CORRIDORS.length - 1], "packed"],
    ];
    const leftovers = leftoversOf(steps);
    const singles: Tower[] = blocks.map((b, index) => ({ members: [{ index, dx: 0, dy: 0, dz: 0 }], placements: b.placements, width: b.info.width, depth: b.info.depth }));
    const related = (a: number, b: number) => flow[a].feeders.includes(b) || flow[b].feeders.includes(a);
    const towers =
        options.stackBlocks === false || !can.lifts
            ? singles
            : buildTowers(
                  blocks.map((b) => ({ placements: b.placements, width: b.info.width, depth: b.info.depth, canGoUp: !b.info.heating })),
                  { maxHeight: options.maxHeight, related, makeUid: () => nextUid("t") },
              );
    // Stacked towers first; side by side only when the towers can't be belted together
    const layouts = towers.length < singles.length ? [towers, singles] : [singles];
    // Stacked towers get the tight corridors only; when they don't route, side by side next
    const attemptsFor = (set: Tower[]) => (set === towers && towers !== singles ? attempts.filter(([c]) => c <= TOWER_MAX_CORRIDOR) : attempts);
    const total = layouts.reduce((sum, set) => sum + attemptsFor(set).length, 0);
    const started = Date.now();
    let attempt = 0;
    for (const set of layouts) {
        const setFlow = towerFlow(set, flow);
        for (const [corridor, mode] of attemptsFor(set)) {
            // Long enough: settle for the best layout that routes everything
            if (best?.routes.every((r) => r.ok) && Date.now() - started > budgetMs) break;
            const label = `Layout ${attempt + 1} of up to ${total}${set === towers && towers !== singles ? " (stacked)" : ""}: routing belts`;
            const base = attempt++;
            const onProgress = options.onProgress && ((f: number) => options.onProgress!((base + f) / total, label));
            onProgress?.(0);
            const result = layOut(blocks, set, setFlow, corridor, mode, { ...options, onProgress }, can, leftovers, finish);
            if (!best || score(result) < score(best)) best = result;
            // Both layouts of a corridor width get a chance before settling
            if (mode === "flow" && best.routes.every((r) => r.ok)) break;
        }
        if (best?.routes.every((r) => r.ok)) break;
    }
    best!.locked = lockedBuildings(new Set(best!.placements.map((p) => p.id)), options.unlocks);
    options.onProgress?.(1, "Done");
    return best!;
}

type BlockFlow = { stage: number; feeders: number[]; feederWeights: number[] };

/**
 * Where unneeded output goes, best first: the player's choice, then the knowledge altar,
 * trash barrel and dispatch portal, whichever is unlocked (out at the edge if none fits)
 */
function disposalFor(options: ModuleOptions, can: Capabilities): Disposal[] {
    if (options.disposal === "export") return ["export"];
    const unlocked: Disposal[] = [];
    if (can.altar) unlocked.push("altar");
    if (can.trash && can.lifts) unlocked.push("trash");
    if (can.sell) unlocked.push("sell");
    const chosen = options.disposal;
    return chosen ? [chosen, ...unlocked.filter((d) => d !== chosen)] : unlocked;
}

/** Flow between towers: a tower is as early as its earliest block and fed by its blocks' feeders */
function towerFlow(towers: Tower[], flow: BlockFlow[]): BlockFlow[] {
    const towerOf = new Map<number, number>();
    towers.forEach((t, ti) => t.members.forEach((m) => towerOf.set(m.index, ti)));
    return towers.map((t, ti) => {
        const weights = new Map<number, number>();
        for (const m of t.members)
            flow[m.index].feeders.forEach((f, k) => {
                const from = towerOf.get(f)!;
                if (from !== ti) weights.set(from, (weights.get(from) ?? 0) + flow[m.index].feederWeights[k]);
            });
        return { stage: Math.min(...t.members.map((m) => flow[m.index].stage)), feeders: [...weights.keys()], feederWeights: [...weights.values()] };
    });
}

/** Places the towers with free corridors between them and belts them together */
function layOut(
    blocks: { placements: Placement[]; info: TierInfo }[],
    towers: Tower[],
    flow: BlockFlow[],
    corridor: number,
    mode: LayoutMode,
    options: ModuleOptions,
    can: Capabilities,
    leftovers: Set<string>,
    finish: boolean,
): GeneratedModule {
    const pad = corridor * 2;
    const sizes = towers.map((t) => ({ width: t.width + pad, depth: t.depth + pad }));
    const packed =
        mode === "near"
            ? nearFeeders(sizes.map((sz, i) => ({ ...sz, ...flow[i] })), options.maxWidth + pad)
            : mode === "flow"
              ? flowRows(sizes.map((sz, i) => ({ ...sz, ...flow[i] })), options.maxWidth + pad, 0, 1)
              : packBlocks(sizes, options.maxWidth + pad);
    const blockPlacements: Placement[] = [];
    const tiers: TierInfo[] = new Array(blocks.length);
    towers.forEach((tower, ti) => {
        const pos = packed.positions[ti];
        const padded = tower.placements.map((p) => ({ ...p, x: p.x + corridor, y: p.y + corridor }));
        const towerDepth = tower.depth + pad;
        blockPlacements.push(...transformBlock(padded, towerDepth, pos.rot, pos.x, pos.y));
        const turned = pos.rot === 1;
        for (const m of tower.members) {
            const info = blocks[m.index].info;
            const x0 = m.dx + corridor;
            const y0 = m.dy + corridor;
            tiers[m.index] = {
                ...info,
                x: turned ? towerDepth - (y0 + info.depth) + pos.x : x0 + pos.x,
                y: turned ? x0 + pos.y : y0 + pos.y,
                z: info.z + m.dz,
                width: turned ? info.depth : info.width,
                depth: turned ? info.width : info.depth,
                turned,
            };
        }
    });
    return routeAndFinish(blockPlacements, tiers, [], options, can, leftovers, finish, ROUTING_MARGIN);
}

/**
 * Belts the blocks to each other, to the imports and to the exports, sends unneeded output
 * to a sink and (`finish`) puts cheaper supports under raised belts.
 * `extraNames`: names of lane-end owners past the tiers (whole modules of a grouped layout)
 */
function routeAndFinish(
    blockPlacements: Placement[],
    tiers: TierInfo[],
    extraNames: string[],
    options: ModuleOptions,
    can: Capabilities,
    leftovers: Set<string>,
    finish: boolean,
    margin: number,
): GeneratedModule {
    const finals = new Set(options.finalProducts ?? []);
    const chosen = new Set(options.exportItems ?? []);
    // What the module makes and nothing in it uses: always leaves, final products or not
    const consumed = new Set(tiers.flatMap((t) => t.lanes.filter((l) => l.kind === "in").flatMap((l) => l.items.map((i) => i.itemName))));
    const products = new Set(tiers.flatMap((t) => t.lanes.filter((l) => l.kind === "out").flatMap((l) => l.items.map((i) => i.itemName))).filter((i) => !consumed.has(i) && !leftovers.has(i)));

    // Belt the blocks to each other, to the imports and to the exports
    const routed = blockPlacements.length
        ? routeModule(blockPlacements, {
              onProgress: options.onProgress && ((f) => options.onProgress!(f, "")),
              beltSpeed: options.beltSpeed,
              margin,
              maxHeight: options.maxHeight,
              blockNames: [...tiers.map((t) => `${t.itemName} (${t.machines}× ${getFootprint(t.deviceId)?.name ?? t.deviceId})`), ...extraNames],
              bridges: options.useBridges && can.bridges,
              lifts: can.lifts,
              prioritySplitters: can.prioritySplitters,
              // Final products and chosen surplus leave; byproducts that share a belt go to a sink
              // (through any side); other surplus stays in the line (it only slows its machines)
              exportable: (item) => finals.has(item) || products.has(item) || chosen.has(item) || leftovers.has(item),
              sideExit: (item) => leftovers.has(item) && !finals.has(item) && !chosen.has(item),
          })
        : { placements: [], routes: [], io: [], surplus: [] };
    // Byproducts nobody takes end in a knowledge altar, trash barrel or dispatch portal
    const disposed = attachDisposal(routed.placements, routed.io, (item) => finals.has(item) || products.has(item) || chosen.has(item), disposalFor(options, can), () => nextUid("x"));
    routed.placements = disposed.placements;
    routed.io = disposed.io;
    if (finish) routed.placements = finishSupports(routed.placements, can);
    return { placements: routed.placements, tiers, size: moduleSize(routed.placements), routes: routed.routes, io: routed.io, surplus: routed.surplus, locked: [] };
}

/**
 * Cheaper supports now that routing is done: wood blocks where no belt shares the cell,
 * beams instead of pillars under longer raised belt runs
 * (lab stands a belt passes through stay; without that unlock they show up as locked)
 */
function finishSupports(placements: Placement[], can: Capabilities): Placement[] {
    const blocked = preferBlocks(pruneSupports(placements));
    return pruneSupports(can.beams ? beamsUnderRuns(blocked, () => nextUid("bm")) : blocked);
}

function moduleSize(placements: Placement[]): [number, number, number] {
    const cells = placements.map((p) => {
        const fp = getFootprint(p.id);
        const size = fp ? rotatedSize(fp, p.rot) : { x: 1, y: 1, z: 1 };
        return [p.x, p.y, p.z, p.x + size.x, p.y + size.y, p.z + size.z];
    });
    const extent = (i: number, pick: (a: number, b: number) => number) => cells.reduce((acc, c) => pick(acc, c[i]), pick === Math.max ? -Infinity : Infinity);
    return cells.length
        ? [extent(3, Math.max) - extent(0, Math.min), extent(4, Math.max) - extent(1, Math.min), extent(5, Math.max)]
        : [0, 0, 0];
}

/** Byproducts: second outputs that share a machine's output belt with its product; left on the belt they would block the machine */
function leftoversOf(steps: ModuleStep[]): Set<string> {
    return new Set(steps.flatMap((st) => (st.outputs.length >= 2 ? st.outputs.filter((o) => o.itemName !== st.itemName).map((o) => o.itemName) : [])));
}

interface StepGroup {
    steps: ModuleStep[];
    /** A module the player chose (stacked into towers); false for the steps in no group */
    tower: boolean;
}

/** The module groups that apply to these steps, feeding modules first; null for one module */
function moduleGroupsOf(steps: ModuleStep[], groups: string[][] | undefined): StepGroup[] | null {
    if (!groups?.length) return null;
    const taken = new Set<string>();
    const result: StepGroup[] = [];
    for (const keys of groups) {
        // A step listed in two groups belongs to the first
        const members = steps.filter((st) => keys.includes(st.nodeKey) && !taken.has(st.nodeKey));
        members.forEach((st) => taken.add(st.nodeKey));
        if (members.length) result.push({ steps: members, tower: true });
    }
    if (result.length === 0) return null;
    const rest = steps.filter((st) => !taken.has(st.nodeKey));
    if (rest.length) result.push({ steps: rest, tower: false });
    // Steps come in production order: a module goes where its last step (its product) is
    const order = new Map(steps.map((st, i) => [st.nodeKey, i]));
    const last = (g: StepGroup) => Math.max(...g.steps.map((st) => order.get(st.nodeKey)!));
    return result.sort((a, b) => last(a) - last(b));
}

/**
 * Room for the belts between modules standing side by side: free cells between two modules
 * (a few, plus some per belt coming in from another module) and around them all; more of
 * both when routing fails
 */
const MODULE_GAP = 2;
const MODULE_SPACINGS = [
    { perBelt: 1, margin: ROUTING_MARGIN },
    { perBelt: 2, margin: ROUTING_MARGIN * 2 },
];

/**
 * Build as modules: every group is laid out and routed on its own (inputs at its front,
 * outputs at its back), then the modules stand side by side and get belted together.
 */
function generateGrouped(allSteps: ModuleStep[], groups: StepGroup[], options: ModuleOptions): GeneratedModule {
    const can = capabilities(options.unlocks);
    const stages = groups.length + MODULE_SPACINGS.length;
    const report = (done: number, label: string) => (f: number, l: string) => options.onProgress?.((done + f) / stages, l ? `${label}: ${l}` : label);
    const products = groups.map((g) => (g.tower ? g.steps[g.steps.length - 1].itemName : "other steps"));
    const subs = groups.map((group, k) => {
        // What other modules use leaves at the back, once this module's own machines took theirs
        const usedElsewhere = new Set(allSteps.filter((st) => !group.steps.includes(st)).flatMap((st) => [...st.inputs.map((i) => i.itemName), st.heating?.fuelItem ?? ""]));
        const sent = group.steps.flatMap((st) => st.outputs.map((o) => o.itemName)).filter((item) => usedElsewhere.has(item));
        const opts: ModuleOptions = {
            ...options,
            moduleGroups: undefined,
            stackBlocks: group.tower || options.stackBlocks,
            exportItems: [...new Set([...(options.exportItems ?? []), ...sent])],
            onProgress: options.onProgress && report(k, `Module of ${products[k]}`),
        };
        return generateBlocks(group.steps, opts, TIME_BUDGET_MS / stages, false);
    });

    // Belts between modules: feeds[i][j] belts from module i come in at module j's front
    const madeIn = groups.map((g) => new Set(g.steps.flatMap((st) => st.outputs.map((o) => o.itemName))));
    const feeds = subs.map((_, i) => subs.map((sub, j) => (i === j ? 0 : sub.io.filter((p) => p.kind === "import" && madeIn[i].has(p.itemName)).length)));
    const order = moduleOrder(feeds);
    // Belts into a module come up the gaps beside it: each gap gets those from its side
    const crossing = order.map((j, pos) => {
        if (pos === 0) return 0;
        const left = order.slice(0, pos);
        const right = order.slice(pos);
        return left.reduce((sum, i) => sum + feeds[i][j], 0) + right.reduce((sum, i) => sum + feeds[i][order[pos - 1]], 0);
    });
    const names = order.map((k, pos) => `Module ${pos + 1} (${products[k]})`);

    const leftovers = leftoversOf(allSteps);
    const failed = (m: GeneratedModule) => m.routes.filter((r) => !r.ok).length;
    let best: GeneratedModule | null = null;
    for (const [g, spacing] of MODULE_SPACINGS.entries()) {
        const onProgress = options.onProgress && report(groups.length + g, `Belting ${subs.length} modules together`);
        const gaps = crossing.map((n) => MODULE_GAP + n * spacing.perBelt);
        const result = joinModules(order.map((k) => subs[k]), names, gaps, spacing.margin, { ...options, onProgress }, can, leftovers);
        if (!best || failed(result) < failed(best)) best = result;
        if (failed(best) === 0) break;
    }
    best!.locked = lockedBuildings(new Set(best!.placements.map((p) => p.id)), options.unlocks);
    options.onProgress?.(1, "Done");
    return best!;
}

/** Most modules for trying every order; past that they stay in production order */
const MAX_ORDERED_MODULES = 7;

/**
 * Left-to-right order of the modules that keeps the belts between them short: the fewest
 * belts times modules passed. Ties keep production order.
 */
function moduleOrder(feeds: number[][]): number[] {
    const n = feeds.length;
    const identity = feeds.map((_, i) => i);
    if (n > MAX_ORDERED_MODULES) return identity;
    const cost = (order: number[]) => {
        const pos = new Map(order.map((k, p) => [k, p]));
        let sum = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sum += feeds[i][j] * Math.abs(pos.get(i)! - pos.get(j)!);
        return sum;
    };
    let best = identity;
    let bestCost = cost(identity);
    const permute = (prefix: number[], rest: number[]) => {
        if (rest.length === 0) {
            const c = cost(prefix);
            if (c < bestCost) [best, bestCost] = [prefix, c];
            return;
        }
        rest.forEach((k, i) => permute([...prefix, k], [...rest.slice(0, i), ...rest.slice(i + 1)]));
    };
    permute([], identity);
    return best;
}

function cellBounds(placements: Placement[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity;
    for (const p of placements)
        for (const c of placementCells(p)) {
            minX = Math.min(minX, c.x);
            minY = Math.min(minY, c.y);
            maxX = Math.max(maxX, c.x);
        }
    return { minX, minY, maxX };
}

/**
 * Stands the modules side by side with their fronts in line and belts them together:
 * each module's imports and exports become lane ends, so the router feeds one module's
 * outputs into another's inputs, brings raw materials in at the front and sends the
 * products out at the back.
 */
function joinModules(subs: GeneratedModule[], names: string[], gaps: number[], margin: number, options: ModuleOptions, can: Capabilities, leftovers: Set<string>): GeneratedModule {
    const placements: Placement[] = [];
    const tiers: TierInfo[] = [];
    const routes: RouteResult[] = [];
    const io: IoPoint[] = [];
    const surplus = new Map<string, number>();
    // Lane ends at a module's edge are owned by the whole module, named after the blocks
    const moduleBase = subs.reduce((sum, m) => sum + m.tiers.length, 0);
    const isEdge = (p: IoPoint) => p.kind === "import" || p.kind === "export";
    let cursor = 0;
    subs.forEach((sub, k) => {
        if (sub.placements.length === 0) return;
        // `gaps`: free cells to the left of each module
        if (k > 0) cursor += gaps[k];
        const b = cellBounds(sub.placements);
        const dx = cursor - b.minX;
        const dy = -b.minY;
        const blockBase = tiers.length;
        const edges = new Map(sub.io.filter(isEdge).map((p) => [cellKey(p.cell[0], p.cell[1], p.cell[2]), p]));
        for (const p of sub.placements) {
            const moved: Placement = { ...p, uid: `g${k}.${p.uid}`, x: p.x + dx, y: p.y + dy };
            if (p.block !== undefined) moved.block = p.block + blockBase;
            const edge = p.lane === "route" && p.id.startsWith("belt") ? edges.get(cellKey(p.x, p.y, p.z)) : undefined;
            if (edge) {
                moved.laneEnd = { kind: edge.kind === "import" ? "in" : "out", items: [{ itemName: edge.itemName, rate: edge.rate }] };
                moved.block = moduleBase + k;
            }
            placements.push(moved);
        }
        sub.tiers.forEach((t, i) => tiers.push({ ...t, index: blockBase + i, x: t.x + dx, y: t.y + dy }));
        const rename = (end: string) => (end === "module edge (import)" ? `${names[k]} front` : end === "module edge (export)" ? `${names[k]} back` : end);
        routes.push(...sub.routes.map((r) => ({ ...r, from: rename(r.from), to: rename(r.to), key: r.key && `g${k}.${r.key}` })));
        // Sinks stay; edge imports and exports are now belted to the other modules
        io.push(...sub.io.filter((p) => !isEdge(p)).map((p) => ({ ...p, cell: [p.cell[0] + dx, p.cell[1] + dy, p.cell[2]] as [number, number, number] })));
        sub.surplus.forEach((s) => surplus.set(s.itemName, (surplus.get(s.itemName) ?? 0) + s.rate));
        cursor += b.maxX - b.minX + 1;
    });

    const joined = routeAndFinish(placements, tiers, names, options, can, leftovers, true, margin);
    joined.surplus.forEach((s) => surplus.set(s.itemName, (surplus.get(s.itemName) ?? 0) + s.rate));
    return {
        ...joined,
        routes: [...routes, ...joined.routes],
        io: [...io, ...joined.io],
        surplus: [...surplus].map(([itemName, rate]) => ({ itemName, rate })),
    };
}
