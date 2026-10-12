/**
 * Starter box for self-made fertilizer: the nurseries need fertilizer before the module
 * makes any, so a small storage box sits in their fertilizer belt. The player fills it once;
 * after that the fertilizer just passes through it.
 */
import { getFootprint, type Rotation } from "./footprint";
import { buildOccupancy, placementCells, placementIssues, placementPorts, portConnections, type Placement } from "./layout";
import type { Side } from "./types";

const BOX_ID = "small-container-side";

/** Rotation that turns the box's input (left in its footprint) to face `side` */
function boxRotation(inSide: Side): Rotation {
    const order: Side[] = ["left", "up", "right", "down"];
    return ((order.indexOf(inSide) + 4) % 4) as Rotation;
}

/**
 * Puts boxes into the belts that feed the nurseries taking `fertilizer`, each on two straight
 * belt pieces in a row: one where all their feeds share a stretch, more where they don't.
 */
export function addStarterBox(placements: Placement[], fertilizer: string, makeUid: () => string): Placement[] {
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
    const carries = (p: Placement) => p.id.startsWith("belt") || p.id.startsWith("conveyer-lift") || p.id === "splitter-vert";
    const nurseries = placements.filter((p) => p.id.includes("nursery"));
    // Belt pieces upstream of each nursery's fertilizer, and how far up
    const upstream = nurseries.map((n) => {
        const dist = new Map<string, number>();
        const queue = [...(feeding.get(n.uid) ?? [])].filter((u) => byUid.get(u)?.label === fertilizer || byUid.get(u)?.id.startsWith("conveyer-lift"));
        queue.forEach((u) => dist.set(u, 1));
        for (let i = 0; i < queue.length; i++) {
            for (const u of feeding.get(queue[i]) ?? []) {
                const p = byUid.get(u);
                if (!p || dist.has(u) || !carries(p) || (p.label !== fertilizer && !p.id.startsWith("conveyer-lift"))) continue;
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
    /** The box on this piece and the one feeding it, or null when it doesn't fit there */
    const boxAt = (uid: string, current: Placement[]) => {
        const a = byUid.get(uid)!;
        const sa = straight(a);
        if (!sa || !current.includes(a)) return null;
        const before = (feeding.get(uid) ?? []).map((u) => byUid.get(u)!).find((p) => current.includes(p) && p.z === a.z && straight(p)?.outSide === sa.outSide);
        if (!before) return null;
        const box: Placement = { uid: makeUid(), id: BOX_ID, x: Math.min(a.x, before.x), y: Math.min(a.y, before.y), z: a.z, rot: boxRotation(sa.inSide), label: `Starter box: ${fertilizer}` };
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
        return [box, ...above].some((p) => placementIssues(p, occupancy).length) ? null : next;
    };
    if (!getFootprint(BOX_ID)) return placements;
    // As few boxes as cover every nursery: the stretch that feeds the most first, nearest them
    let result = placements;
    const open = new Set(upstream.map((d, i) => (d.size ? i : -1)).filter((i) => i >= 0));
    const pieces = [...new Set(upstream.flatMap((d) => [...d.keys()]))];
    while (open.size) {
        const covers = (u: string) => [...open].filter((i) => upstream[i].has(u));
        const ranked = pieces
            .filter((u) => covers(u).length > 0)
            .sort((a, b) => covers(b).length - covers(a).length || Math.max(...covers(a).map((i) => upstream[i].get(a)!)) - Math.max(...covers(b).map((i) => upstream[i].get(b)!)));
        let placed = false;
        for (const u of ranked) {
            const next = boxAt(u, result);
            if (!next) continue;
            covers(u).forEach((i) => open.delete(i));
            result = next;
            placed = true;
            break;
        }
        if (!placed) break;
    }
    return result;
}
