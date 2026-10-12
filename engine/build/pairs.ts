/**
 * Machine pairs: a machine whose whole output goes into one machine of the next step stands
 * right at that machine's input, no belt between them (a nursery's output port straight
 * into a grinder). The pair is laid out as one made-up building, so blocks, towers and the
 * router treat it like any machine; `expandPairs` turns it back into the two real machines.
 */
import { footprintCells, footprintPorts, getFootprint, oppositeSide, registerFootprint, rotatePoint, SIDE_OFFSET, type Rotation } from "./footprint";
import type { Placement } from "./layout";
import type { BuildingFootprint, FootprintBox, Side } from "./types";
import type { ModuleStep } from "./generator";

interface PairMember {
    deviceId: string;
    nodeKey: string;
    itemName: string;
    /** Where the member sits in the pair's frame (unrotated pair) and how it is turned */
    x: number;
    y: number;
    rot: Rotation;
}

interface Pair {
    first: PairMember;
    second: PairMember;
}

const PAIR_PREFIX = "pair:";
/** Pair steps by nodeKey: what to put back in place of the made-up building */
const pairs = new Map<string, Pair>();

/** Machines that can't pair: heated, piped or portals have their own layouts */
function pairable(st: ModuleStep): boolean {
    const fp = getFootprint(st.deviceId);
    return (
        !!fp &&
        fp.category === "production" &&
        !st.deviceId.startsWith(PAIR_PREFIX) &&
        !st.heating &&
        !st.fluidInputs.length &&
        !st.fluids?.inputs.length &&
        !st.fluids?.outputs.length &&
        !fp.ports.some((p) => p.medium === "pipe") &&
        !fp.heatCost
    );
}

/**
 * The two footprints joined: `second` turned so one of its input ports faces `first`'s only
 * output port, right in front of it; the smallest such pair, or null when none fits
 */
function joinFootprints(first: BuildingFootprint, second: BuildingFootprint): { fp: BuildingFootprint; a: [number, number]; b: [number, number]; rot: Rotation } | null {
    const outs = first.ports.filter((p) => p.medium === "belt" && p.dir === "out");
    if (outs.length !== 1) return null;
    const out = outs[0];
    const face = out.face as Side;
    const [tx, ty] = [out.x + SIDE_OFFSET[face][0], out.y + SIDE_OFFSET[face][1]];
    const firstCells = new Set(footprintCells(first).map((c) => `${c.x},${c.y}`));
    let best: { fp: BuildingFootprint; a: [number, number]; b: [number, number]; rot: Rotation; area: number } | null = null;
    for (const rot of [0, 1, 2, 3] as Rotation[]) {
        const ports = footprintPorts(second, rot);
        for (const port of ports.filter((p) => p.medium === "belt" && p.dir === "in" && p.face === oppositeSide(face) && p.z === out.z)) {
            const [ox, oy] = [tx - port.x, ty - port.y];
            const cells = footprintCells(second, rot).map((c) => ({ ...c, x: c.x + ox, y: c.y + oy }));
            if (cells.some((c) => firstCells.has(`${c.x},${c.y}`))) continue;
            const all = [...footprintCells(first), ...cells];
            const minX = Math.min(...all.map((c) => c.x)), minY = Math.min(...all.map((c) => c.y));
            const maxX = Math.max(...all.map((c) => c.x)), maxY = Math.max(...all.map((c) => c.y));
            const area = (maxX - minX + 1) * (maxY - minY + 1);
            if (best && area >= best.area) continue;
            const box = (c: (typeof all)[number]): FootprintBox => {
                const { x, y, z, ...occupation } = c;
                return { ...occupation, min: [x - minX, y - minY, z], max: [x - minX, y - minY, z] };
            };
            const id = `${PAIR_PREFIX}${first.id}+${second.id}`;
            const fp: BuildingFootprint = {
                id,
                row: id,
                name: `${first.name} + ${second.name}`,
                category: "production",
                size: { x: maxX - minX + 1, y: maxY - minY + 1, z: Math.max(first.size.z, second.size.z) },
                boxes: all.map(box),
                // The first machine's inputs and the second one's outputs; the joined ports are inside
                ports: [
                    ...first.ports.filter((p) => p.medium === "belt" && p.dir === "in").map((p) => ({ ...p, x: p.x - minX, y: p.y - minY })),
                    ...ports.filter((p) => p.medium === "belt" && p.dir === "out").map((p) => ({ ...p, x: p.x + ox - minX, y: p.y + oy - minY })),
                ],
                cost: [...first.cost, ...second.cost],
            };
            best = { fp, a: [-minX, -minY], b: [ox - minX, oy - minY], rot, area };
        }
    }
    return best && { fp: best.fp, a: best.a, b: best.b, rot: best.rot };
}

/**
 * Joins producer and consumer steps into pair steps where the producer's only product goes
 * into one consumer step that takes nothing else and needs no more machines than the producer.
 * `keepOnBelt`: items that must reach a belt (final products, exports, bought items).
 */
export function pairSteps(steps: ModuleStep[], keepOnBelt: (item: string) => boolean): ModuleStep[] {
    const result = [...steps];
    for (const first of steps) {
        if (!pairable(first) || first.outputs.length !== 1) continue;
        const item = first.outputs[0].itemName;
        if (keepOnBelt(item)) continue;
        const takers = steps.filter((st) => st !== first && (st.inputs.some((i) => i.itemName === item) || st.heating?.fuelItem === item));
        const makers = steps.filter((st) => st.outputs.some((o) => o.itemName === item));
        if (takers.length !== 1 || makers.length !== 1) continue;
        const second = takers[0];
        // One consumer per producer: fine as long as the plan doesn't need more consumers than that
        // (each then takes one producer's output, no more than the planned ones took)
        if (!pairable(second) || second.inputs.length !== 1 || Math.ceil(second.machines) > Math.ceil(first.machines)) continue;
        // A consumer with one belt input: a second one would stay open next to its producer
        if (getFootprint(second.deviceId)!.ports.filter((p) => p.medium === "belt" && p.dir === "in").length !== 1) continue;
        if (!result.includes(first) || !result.includes(second)) continue;
        const joined = joinFootprints(getFootprint(first.deviceId)!, getFootprint(second.deviceId)!);
        if (!joined) continue;
        registerFootprint(joined.fp);
        const nodeKey = `${PAIR_PREFIX}${first.nodeKey}>${second.nodeKey}`;
        pairs.set(nodeKey, {
            first: { deviceId: first.deviceId, nodeKey: first.nodeKey, itemName: first.itemName, x: joined.a[0], y: joined.a[1], rot: 0 },
            second: { deviceId: second.deviceId, nodeKey: second.nodeKey, itemName: second.itemName, x: joined.b[0], y: joined.b[1], rot: joined.rot },
        });
        const step: ModuleStep = {
            nodeKey,
            itemName: second.itemName,
            deviceId: joined.fp.id,
            machines: Math.ceil(first.machines),
            inputs: first.inputs,
            // The same output spread over one consumer per producer
            outputs: second.outputs.map((o) => ({ ...o, perMachineRate: (o.perMachineRate * Math.ceil(second.machines)) / Math.ceil(first.machines) })),
            fluidInputs: [],
            unsorted: second.unsorted,
        };
        // In the place of the consumer: steps stay in production order
        result.splice(result.indexOf(first), 1);
        result.splice(result.indexOf(second), 1, step);
    }
    return result;
}

/** The pair's two machines in place of each made-up pair building */
export function expandPairs(placements: Placement[]): Placement[] {
    return placements.flatMap((p) => {
        const pair = p.nodeKey ? pairs.get(p.nodeKey) : undefined;
        const fp = getFootprint(p.id);
        // Lane belts of the pair belong to its second machine
        if (pair && !p.id.startsWith(PAIR_PREFIX)) return [{ ...p, nodeKey: pair.second.nodeKey }];
        if (!pair || !fp) return [p];
        return [pair.first, pair.second].map((m, k): Placement => {
            const own = getFootprint(m.deviceId)!;
            const size = m.rot % 2 === 0 ? own.size : { x: own.size.y, y: own.size.x };
            // The member's corners in the pair's frame, turned with the pair
            const corners = [rotatePoint(m.x, m.y, fp, p.rot), rotatePoint(m.x + size.x - 1, m.y + size.y - 1, fp, p.rot)];
            return {
                uid: `${p.uid}:${k}`,
                id: m.deviceId,
                x: p.x + Math.min(corners[0][0], corners[1][0]),
                y: p.y + Math.min(corners[0][1], corners[1][1]),
                z: p.z,
                rot: ((m.rot + p.rot) % 4) as Rotation,
                nodeKey: m.nodeKey,
                label: m.itemName,
                block: p.block,
            };
        });
    });
}

/** Blocks of pairs shown as the second machine, fed directly by the first */
export function pairTiers<T extends { nodeKey: string; deviceId: string; fedBy?: { itemName: string; deviceId: string } }>(tiers: T[]): T[] {
    return tiers.map((t) => {
        const pair = pairs.get(t.nodeKey);
        return pair && t.deviceId.startsWith(PAIR_PREFIX) ? { ...t, nodeKey: pair.second.nodeKey, deviceId: pair.second.deviceId, fedBy: { itemName: pair.first.itemName, deviceId: pair.first.deviceId } } : t;
    });
}
