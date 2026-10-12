/**
 * What happens to output nobody in the module needs (byproducts like the sand from
 * crushing rock salt, overflow): it can't stay on the belts, it would block the line.
 * At each such exit the module gets a knowledge altar (turns it into knowledge), a trash
 * barrel (lifted up to its input) or a dispatch portal that sells it; otherwise it just
 * leaves at the edge.
 */
import { oppositeSide, SIDE_OFFSET, SIDES, type Rotation } from "./footprint";
import { cellKey, cellsCollide, placementCells, placementPorts, type Placement, type WorldCell } from "./layout";
import type { IoPoint } from "./router";
import type { Side } from "./types";

export type Disposal = "altar" | "trash" | "sell" | "export";

const ALTAR_ID = "knowledge-altar";
const TRASH_ID = "junk-barrel";
const SELL_ID = "dispatch-portal";
/** The trash barrel takes belts at this height */
const TRASH_INPUT_Z = 3;

type Occupancy = Map<string, WorldCell[]>;

function occupancyOf(placements: Placement[]): Occupancy {
    const occ: Occupancy = new Map();
    for (const p of placements)
        for (const c of placementCells(p)) {
            const k = cellKey(c.x, c.y, c.z);
            occ.set(k, [...(occ.get(k) ?? []), c]);
        }
    return occ;
}

const fits = (occ: Occupancy, p: Placement) => placementCells(p).every((c) => (occ.get(cellKey(c.x, c.y, c.z)) ?? []).every((o) => !cellsCollide(c, o)));

/** Whether `p` takes items at (x, y, z) coming in through its `face` side */
function takesAt(p: Placement, x: number, y: number, z: number, face: Side): boolean {
    return placementPorts(p).some((q) => q.dir !== "out" && q.medium === "belt" && q.x === x && q.y === y && q.z === z && q.face === face);
}

/** A building of `id` placed so it takes items at (x, y, z) entering through `face`, without collisions */
function placeTaking(occ: Occupancy, id: string, x: number, y: number, z: number, face: Side, makeUid: () => string, baseZ = 0): Placement | null {
    for (const rot of [0, 1, 2, 3] as Rotation[])
        for (let ox = -3; ox <= 3; ox++)
            for (let oy = -3; oy <= 3; oy++) {
                const p: Placement = { uid: makeUid(), id, x: x + ox, y: y + oy, z: baseZ, rot };
                if (takesAt(p, x, y, z, face) && fits(occ, p)) return p;
            }
    return null;
}

/** The side the belt at `cell` sends items out of the module through */
function exitSide(placements: Placement[], occ: Occupancy, cell: [number, number, number]): Side | null {
    const belt = placements.find((p) => p.x === cell[0] && p.y === cell[1] && p.z === cell[2] && p.lane === "route");
    if (!belt) return null;
    const out = placementPorts(belt).find((q) => q.dir === "out" && q.face !== "top" && q.face !== "base" && !occ.has(cellKey(q.x + SIDE_OFFSET[q.face as Side][0], q.y + SIDE_OFFSET[q.face as Side][1], q.z)));
    return (out?.face as Side) ?? null;
}

/** Trash barrel behind a lift that carries the belt up to the barrel's input */
function trashAt(occ: Occupancy, x: number, y: number, inFace: Side, item: string, makeUid: () => string): Placement[] | null {
    for (const rot of [0, 1, 2, 3] as Rotation[]) {
        const bottom: Placement = { uid: makeUid(), id: "conveyer-lift-upwards", x, y, z: 0, rot, label: item, lane: "route" };
        if (!takesAt(bottom, x, y, 0, inFace) || !fits(occ, bottom)) continue;
        const body = Array.from({ length: TRASH_INPUT_Z - 1 }, (_, i): Placement => ({ uid: makeUid(), id: "conveyer-lift-body", x, y, z: i + 1, rot: 0, label: item, lane: "route" }));
        if (!body.every((b) => fits(occ, b))) continue;
        for (const topRot of [0, 1, 2, 3] as Rotation[]) {
            const top: Placement = { uid: makeUid(), id: "conveyer-lift-end-upwards", x, y, z: TRASH_INPUT_Z, rot: topRot, label: item, lane: "route" };
            const out = placementPorts(top).find((q) => q.dir === "out");
            if (!out || !fits(occ, top) || !SIDES.includes(out.face as Side)) continue;
            const side = out.face as Side;
            const [dx, dy] = SIDE_OFFSET[side];
            const trial = new Map(occ);
            for (const p of [bottom, ...body, top]) for (const c of placementCells(p)) trial.set(cellKey(c.x, c.y, c.z), [...(trial.get(cellKey(c.x, c.y, c.z)) ?? []), c]);
            const barrel = placeTaking(trial, TRASH_ID, x + dx, y + dy, TRASH_INPUT_Z, oppositeSide(side), makeUid);
            if (barrel) return [bottom, ...body, top, { ...barrel, label: item }];
        }
    }
    return null;
}

/**
 * Turns the exits of unneeded items into trash barrels or dispatch portals. Final
 * products and items the player chose to send out keep leaving at the edge.
 */
export function attachDisposal(
    placements: Placement[],
    io: IoPoint[],
    keepExporting: (itemName: string) => boolean,
    /** Sinks to try, best first; the first that fits at an exit is built */
    order: Disposal[],
    makeUid: () => string,
): { placements: Placement[]; io: IoPoint[] } {
    const sinks = order.filter((d) => d !== "export");
    if (sinks.length === 0) return { placements, io };
    const all = [...placements];
    const occ = occupancyOf(all);
    const result = io.map((point): IoPoint => {
        if (point.kind !== "export" || (!point.dispose && keepExporting(point.itemName)) || point.cell[2] !== 0) return point;
        const side = exitSide(all, occ, point.cell);
        if (!side) return point;
        const [dx, dy] = SIDE_OFFSET[side];
        const [x, y] = [point.cell[0] + dx, point.cell[1] + dy];
        const onGround = (id: string) => {
            const sink = placeTaking(occ, id, x, y, 0, oppositeSide(side), makeUid);
            return sink ? [{ ...sink, label: point.itemName }] : null;
        };
        let added: Placement[] | null = null;
        let used: Disposal = "export";
        for (const sink of sinks) {
            added = sink === "trash" ? trashAt(occ, x, y, oppositeSide(side), point.itemName, makeUid) : onGround(sink === "altar" ? ALTAR_ID : SELL_ID);
            used = sink;
            if (added) break;
        }
        if (!added) return point;
        for (const p of added) {
            all.push(p);
            for (const c of placementCells(p)) occ.set(cellKey(c.x, c.y, c.z), [...(occ.get(cellKey(c.x, c.y, c.z)) ?? []), c]);
        }
        return { ...point, kind: used as IoPoint["kind"] };
    });
    return { placements: all, io: result };
}
