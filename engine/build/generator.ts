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
import { buildOccupancy, placementPorts, type Placement } from "./layout";
import { preferBlocks, supportColumn, beamsUnderRuns } from "./supports";
import deviceMetadata from "../../data/device-metadata.json";
import { flowRows, packBlocks, transformBlock } from "./packing";
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
}

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
    return step.outputs.length >= 2 ? 3 : 0;
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

        // One lane per input item, stacked one level apart, entering at the top edge
        for (const [laneX, byItem] of [...feedHits.entries()].sort((a, b) => a[0] - b[0])) {
            for (const [item, byY] of byItem) {
                const lz = z + item;
                const yEnd = Math.max(...byY.keys());
                const served = new Set([...byY.values()].flatMap((h) => [...h.machines])).size;
                for (let y = top; y <= yEnd; y++) {
                    const outs: Side[] = [...new Set(byY.get(y)?.sides ?? [])];
                    if (y < yEnd) outs.push("down");
                    const piece = beltPieceFor(["up"], outs) ?? beltPieceFor(["up"], ["down"])!;
                    const belt: Placement = { uid: nextUid("b"), id: piece.id, x: laneX, y, z: lz, rot: piece.rot, nodeKey: step.nodeKey, lane: "in", label: feed.items[item].itemName };
                    if (y === top) belt.laneEnd = { kind: "in", items: laneItems([feed.items[item]], served) };
                    belts.push(belt);
                }
                lanes.push(laneInfo("in", laneX - origin.x, level, lz, [feed.items[item]], served, beltSpeed));
            }
        }

        for (const [laneX, byY] of [...hits.entries()].sort((a, b) => a[0] - b[0])) {
            const ys = [...byY.keys()];
            const feeds = ys.some((y) => byY.get(y)!.outs.length > 0);
            const collects = ys.some((y) => byY.get(y)!.ins.length > 0);
            const yStart = feeds ? top : Math.min(...ys.filter((y) => byY.get(y)!.ins.length > 0));
            const yEnd = collects ? bottom : Math.max(...ys.filter((y) => byY.get(y)!.outs.length > 0));

            const laneMachines = (pick: "ins" | "outs") =>
                new Set([...byY.values()].flatMap((h) => h[pick].map((p) => p.machine.uid))).size;
            const sorted = collects && step.outputs.length >= 2;

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
    placements.push(...lifts);
    placements.push(...belts);

    // Heated machines stand on a platform of steam heaters or stone stoves
    const platform = step.heating ? heatingPlatform(step, shape.width, shape.depth, origin, count, step.deviceId) : null;
    if (platform) placements.push(...platform.placements);

    // Beam ends rest on lab stand pillars; upper belts rest on beams, elsewhere on pillars too
    const occupancy = buildOccupancy(placements);
    const makeUid = () => nextUid("f");
    for (const d of [...decks].sort((a, c) => a.z - c.z)) {
        const length = stacking.beamLength!;
        for (const endX of [d.x, d.x + length - 1]) placements.push(...supportColumn(occupancy, endX, d.y, d.z, 0, makeUid));
    }
    const raised = [...belts, ...(platform?.belts ?? [])].filter((bb) => bb.z > 0).sort((a, c) => a.z - c.z);
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
function heatingPlatform(step: ModuleStep, width: number, depth: number, origin: { x: number; y: number; z: number }, machines: number, deviceId: string) {
    const heating = step.heating!;
    const placements: Placement[] = [];
    const belts: Placement[] = [];
    const cols = Math.ceil(width / 3);
    const top = origin.y;
    let devices = 0;
    let platformDepth = 0;

    if (heating.kind === "steam") {
        const rows = Math.ceil(depth / 3);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const heater: Placement = { uid: nextUid("h"), id: STEAM_HEATER_ID, x: origin.x + c * 3, y: top + r * 3, z: 0, rot: 0 };
                // The first heater of a row takes the steam; the rest get it through their neighbour
                if (c === 0) heater.pipeEnd = { kind: "in", items: [{ itemName: heating.fuelItem, rate: heating.fuelRate / rows }] };
                placements.push(heater);
                devices++;
            }
        }
        platformDepth = rows * 3;
    } else {
        const fuelRows: number[] = [];
        for (let u = 0; u * STOVE_UNIT < depth; u++) {
            const y0 = u * STOVE_UNIT;
            const lower = y0 + FUEL_ROW + 1 < depth;
            for (let c = 0; c < cols; c++) {
                placements.push({ uid: nextUid("h"), id: STOVE_ID, x: origin.x + c * 3, y: top + y0, z: 0, rot: 0 });
                devices++;
                if (lower) {
                    placements.push({ uid: nextUid("h"), id: STOVE_ID, x: origin.x + c * 3, y: top + y0 + FUEL_ROW + 1, z: 0, rot: 2 });
                    devices++;
                }
            }
            fuelRows.push(y0 + FUEL_ROW);
            platformDepth = lower ? y0 + STOVE_UNIT : y0 + FUEL_ROW + 1;
            // Fuel belt: in from the left, splitting up and down into every stove's fuel port
            const lastPort = (cols - 1) * 3 + 1;
            for (let x = 0; x <= lastPort; x++) {
                const port = x % 3 === 1;
                const outs: Side[] = [];
                if (port) {
                    outs.push("up");
                    if (lower) outs.push("down");
                }
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
            slotsUsed: machines * slotsRequired(deviceId),
            slotsAvailable: devices * HEATER_SLOTS,
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
        // Heated machines need their heat source right under them: no stacking
        const stacking: Stacking = step.heating ? { kind: "none", pitch: fp.size.z } : stackingFor(fp, rot);
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
        return {
            stage: stageOf(st),
            feeders: blocks.map((o, i) => (feederNodes.has(o.info.nodeKey) ? i : -1)).filter((i) => i >= 0),
        };
    });

    // Keep the layout that routes everything with the fewest lifts and the least floor
    let best: GeneratedModule | null = null;
    const score = (m: GeneratedModule) =>
        m.routes.filter((r) => !r.ok).length * 100000 +
        m.placements.filter((p) => p.id === "conveyer-lift-upwards" || p.id === "conveyer-lift-downwards").length * 40 +
        m.size[0] * m.size[1];
    // Flow layout first, with wider corridors if belts don't fit; tight packing only as a last resort
    const attempts: [number, "flow" | "packed"][] = [...CORRIDORS.map((c): [number, "flow"] => [c, "flow"]), [CORRIDORS[CORRIDORS.length - 1], "packed"]];
    for (const [corridor, mode] of attempts) {
        const result = layOut(blocks, flow, corridor, mode, options);
        if (!best || score(result) < score(best)) best = result;
        if (best.routes.every((r) => r.ok)) break;
    }
    return best!;
}

/** Places the blocks with free corridors between them and belts them together */
function layOut(
    blocks: { placements: Placement[]; info: TierInfo }[],
    flow: { stage: number; feeders: number[] }[],
    corridor: number,
    mode: "flow" | "packed",
    options: ModuleOptions,
): GeneratedModule {
    const pad = corridor * 2;
    const sizes = blocks.map((b) => ({ width: b.info.width + pad, depth: b.info.depth + pad }));
    const packed =
        mode === "flow"
            ? flowRows(sizes.map((sz, i) => ({ ...sz, ...flow[i] })), options.maxWidth + pad, 0, 1)
            : packBlocks(sizes, options.maxWidth + pad);
    const blockPlacements: Placement[] = [];
    const tiers = blocks.map((b, i) => {
        const pos = packed.positions[i];
        const padded = b.placements.map((p) => ({ ...p, x: p.x + corridor, y: p.y + corridor }));
        blockPlacements.push(...transformBlock(padded, b.info.depth + pad, pos.rot, pos.x, pos.y));
        const turned = pos.rot === 1;
        return {
            ...b.info,
            x: pos.x + corridor,
            y: pos.y + corridor,
            width: turned ? b.info.depth : b.info.width,
            depth: turned ? b.info.width : b.info.depth,
            turned,
        };
    });

    // Belt the blocks to each other, to the imports and to the exports
    const routed = blockPlacements.length
        ? routeModule(blockPlacements, {
              beltSpeed: options.beltSpeed,
              margin: ROUTING_MARGIN,
              maxHeight: options.maxHeight,
              blockNames: tiers.map((t) => `${t.itemName} (${t.machines}× ${getFootprint(t.deviceId)?.name ?? t.deviceId})`),
          })
        : { placements: [], routes: [], io: [] };
    // Cheaper supports now that routing is done: wood blocks where no belt shares the cell,
    // beams instead of pillars under longer raised belt runs
    routed.placements = beamsUnderRuns(preferBlocks(routed.placements), () => nextUid("bm"));

    const cells = routed.placements.map((p) => {
        const fp = getFootprint(p.id);
        const size = fp ? rotatedSize(fp, p.rot) : { x: 1, y: 1, z: 1 };
        return [p.x, p.y, p.z, p.x + size.x, p.y + size.y, p.z + size.z];
    });
    const size: [number, number, number] = cells.length
        ? [
              Math.max(...cells.map((c) => c[3])) - Math.min(...cells.map((c) => c[0])),
              Math.max(...cells.map((c) => c[4])) - Math.min(...cells.map((c) => c[1])),
              Math.max(...cells.map((c) => c[5])),
          ]
        : [0, 0, 0];
    return { placements: routed.placements, tiers, size, routes: routed.routes, io: routed.io };
}
