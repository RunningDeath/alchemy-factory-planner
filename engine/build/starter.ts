/**
 * Starter box for self-made fertilizer: the nurseries need fertilizer before the module
 * makes any, so a small storage box sits in their fertilizer belt. The player fills it once;
 * after that the fertilizer just passes through it. It goes where the player reaches it:
 * at the module's outline, nothing above it, on the belt back to the nurseries.
 */
import { beltPieceFor } from "./belt-pieces";
import { getFootprint, oppositeSide, rotateSide, type Rotation } from "./footprint";
import { buildOccupancy, placementCells, placementIssues, placementPorts, portConnections, type Placement } from "./layout";
import type { Side } from "./types";

export const STARTER_BOX_ID = "small-container-side";

/** Rotation that turns the box's input (left in its footprint) to face `side` */
function boxRotation(inSide: Side): Rotation {
    const order: Side[] = ["left", "up", "right", "down"];
    return order.indexOf(inSide) as Rotation;
}

/**
 * A box laid back into the two straight belt pieces it stands in for, in lab stands: the box
 * carried what stood on it, a belt doesn't (stands nothing rests on go when supports are tidied)
 */
function boxToBelts(box: Placement, fertilizer: string): Placement[] {
    const inSide = rotateSide("left", box.rot);
    const piece = beltPieceFor([inSide], [oppositeSide(inSide)])!;
    return placementCells(box).flatMap((c, k): Placement[] => [
        { uid: `${box.uid}:b${k}`, id: piece.id, x: c.x, y: c.y, z: c.z, rot: piece.rot, lane: "route", label: fertilizer },
        { uid: `${box.uid}:s${k}`, id: "frame-single", x: c.x, y: c.y, z: c.z, rot: 0 },
    ]);
}

/**
 * Puts the starter box into the belts that feed the nurseries taking `fertilizer` (moving a
 * box the blocks already have when a better reachable spot feeds them all): one box on two
 * straight belt pieces where all their feeds share a stretch, more only where they don't.
 */
export function placeStarterBox(input: Placement[], fertilizer: string, maxHeight: number, makeUid: () => string): Placement[] {
    if (!getFootprint(STARTER_BOX_ID)) return input;
    const existing = input.find((p) => p.starterBox);
    const placements = existing ? [...input.filter((p) => p !== existing), ...boxToBelts(existing, fertilizer)] : input;
    const byUid = new Map(placements.map((p) => [p.uid, p]));
    const links = portConnections(placements);
    const feeding = new Map<string, string[]>();
    for (const l of links) if (l.connectedTo && l.port.dir === "out") feeding.set(l.connectedTo, [...(feeding.get(l.connectedTo) ?? []), l.port.uid]);
    // A lift's exit is fed by its entry at the other end of the shaft
    const byCell = new Map(placements.map((p) => [`${p.x},${p.y},${p.z}`, p]));
    for (const p of placements.filter((q) => q.id === "conveyer-lift-end-upwards" || q.id === "conveyer-lift-downwards")) {
        const up = p.id === "conveyer-lift-end-upwards";
        for (let z = p.z + (up ? -1 : 1); z >= 0 && z < 64; z += up ? -1 : 1) {
            const q = byCell.get(`${p.x},${p.y},${z}`);
            if (!q || !q.id.startsWith("conveyer-lift")) break;
            if (q.id === "conveyer-lift-upwards" || q.id === "conveyer-lift-end-downwards") {
                feeding.set(p.uid, [...(feeding.get(p.uid) ?? []), q.uid]);
                break;
            }
        }
    }
    const lift = (p?: Placement) => !!p?.id.startsWith("conveyer-lift");
    const carries = (p: Placement) => p.id.startsWith("belt") || lift(p) || p.id === "splitter-vert";
    const nurseries = placements.filter((p) => p.id.includes("nursery"));
    // Belt pieces upstream of each nursery's fertilizer, and how far up
    const upstream = nurseries.map((n) => {
        const dist = new Map<string, number>();
        const queue = [...(feeding.get(n.uid) ?? [])].filter((u) => byUid.get(u)?.label === fertilizer || lift(byUid.get(u)));
        queue.forEach((u) => dist.set(u, 1));
        for (let i = 0; i < queue.length; i++) {
            for (const u of feeding.get(queue[i]) ?? []) {
                const p = byUid.get(u);
                if (!p || dist.has(u) || !carries(p) || (p.label !== fertilizer && !lift(p))) continue;
                dist.set(u, dist.get(queue[i])! + 1);
                queue.push(u);
            }
        }
        return dist;
    });
    const straight = (p: Placement) => {
        const ports = placementPorts(p);
        const ins = ports.filter((q) => q.dir === "in");
        const outs = ports.filter((q) => q.dir === "out");
        return p.id === "belt-fixed" && ins.length === 1 && outs.length === 1 ? { inSide: ins[0].face as Side, outSide: outs[0].face as Side } : null;
    };
    /** The layout with a box on this piece and the one feeding it, or null when it doesn't fit there */
    const boxAt = (uid: string, current: Placement[]) => {
        const a = byUid.get(uid)!;
        const sa = straight(a);
        if (!sa || !current.includes(a)) return null;
        const before = (feeding.get(uid) ?? []).map((u) => byUid.get(u)!).find((p) => current.includes(p) && p.z === a.z && straight(p)?.outSide === sa.outSide);
        if (!before) return null;
        const box: Placement = { uid: makeUid(), id: STARTER_BOX_ID, x: Math.min(a.x, before.x), y: Math.min(a.y, before.y), z: a.z, rot: boxRotation(sa.inSide), label: `Starter box: ${fertilizer}`, starterBox: true };
        // Its input on the upstream cell, its output on the downstream one
        const ports = placementPorts(box);
        const inPort = ports.find((q) => q.dir === "in");
        const outPort = ports.find((q) => q.dir === "out");
        if (!inPort || !outPort || inPort.x !== before.x || inPort.y !== before.y || outPort.x !== a.x || outPort.y !== a.y) return null;
        // The box carries what stands on it, so it takes the place of lab stands the belt ran through
        const cells = new Set(placementCells(box).map((c) => `${c.x},${c.y},${c.z}`));
        const stand = (p: Placement) => p.id === "frame-single" && cells.has(`${p.x},${p.y},${p.z}`);
        const next = [...current.filter((p) => p !== a && p !== before && !stand(p)), box];
        // Nothing else in its cells, it stands on something, and so does everything on top of it
        const occupancy = buildOccupancy(next);
        const above = next.filter((p) => placementCells(p).some((c) => cells.has(`${c.x},${c.y},${c.z - 1}`)));
        return [box, ...above].some((p) => placementIssues(p, occupancy).length) ? null : { layout: next, box };
    };

    // How hard the box is to reach: far from the outline, high up, or built over
    const all = placements.flatMap(placementCells);
    const [minX, maxX, minY, maxY] = [Math.min(...all.map((c) => c.x)), Math.max(...all.map((c) => c.x)), Math.min(...all.map((c) => c.y)), Math.max(...all.map((c) => c.y))];
    const reach = (box: Placement, layout: Placement[]) => {
        const occupancy = buildOccupancy(layout);
        const cells = placementCells(box);
        const covered = cells.some((c) => {
            for (let z = c.z + 1; z < maxHeight; z++) if (occupancy.get(`${c.x},${c.y},${z}`)?.length) return true;
            return false;
        });
        const edge = Math.min(...cells.map((c) => Math.min(c.x - minX, maxX - c.x, c.y - minY, maxY - c.y)));
        return (covered ? 100 : 0) + edge * 3 + box.z;
    };

    // One box for every nursery, the easiest to reach
    const fed = upstream.map((d, i) => (d.size ? i : -1)).filter((i) => i >= 0);
    const pieces = [...new Set(upstream.flatMap((d) => [...d.keys()]))];
    let best: { layout: Placement[]; score: number } | null = null;
    for (const u of pieces.filter((u) => fed.every((i) => upstream[i].has(u)))) {
        const placed = boxAt(u, placements);
        if (!placed) continue;
        const score = reach(placed.box, placed.layout);
        if (!best || score < best.score) best = { layout: placed.layout, score };
    }
    if (best) return best.layout;
    // The blocks' own box feeds them all already: keep it where it is
    if (existing) return input;
    // No stretch they all share: as few boxes as reach every nursery, the stretch feeding the most first
    let result = placements;
    const open = new Set(fed);
    while (open.size) {
        const covers = (u: string) => [...open].filter((i) => upstream[i].has(u));
        const ranked = pieces
            .filter((u) => covers(u).length > 0)
            .sort((a, b) => covers(b).length - covers(a).length || Math.max(...covers(a).map((i) => upstream[i].get(a)!)) - Math.max(...covers(b).map((i) => upstream[i].get(b)!)));
        const chosen = ranked.map((u) => ({ u, placed: boxAt(u, result) })).find((c) => c.placed);
        if (!chosen) break;
        covers(chosen.u).forEach((i) => open.delete(i));
        result = chosen.placed!.layout;
    }
    return result;
}
