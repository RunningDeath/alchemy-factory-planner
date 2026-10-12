/**
 * Takes out rows and columns that only carry belts running straight through them (plus
 * the supports under those belts): routing margins, gaps between modules and long
 * straight runs shrink to what the layout needs. Everything behind such a line moves up
 * by one, so the belts on both sides join up again.
 */
import { footprintPorts, getFootprint } from "./footprint";
import { placementCells, type Placement } from "./layout";
import type { IoPoint } from "./router";

/** Supports a removed belt may take along (one cell each) */
const SUPPORTS = new Set(["frame-single", "wood-block"]);

interface Compactable {
    placements: Placement[];
    io: IoPoint[];
    /** Blocks' extents: lines through a block stay */
    tiers: { x?: number; y?: number; width: number; depth: number }[];
}

export function removeStraightLines<T extends Compactable>(module: T): T {
    let current = module;
    for (const axis of ["y", "x"] as const) current = removeLines(current, axis);
    return current;
}

function removeLines<T extends Compactable>(module: T, axis: "x" | "y"): T {
    const pos = (c: { x: number; y: number }) => (axis === "x" ? c.x : c.y);
    // A belt straight along the axis: one in and one out, on the two faces across the line
    const along = axis === "y" ? ["up", "down"] : ["left", "right"];
    const lines = new Map<number, { ok: boolean }>();
    let min = Infinity, max = -Infinity;
    for (const p of module.placements) {
        const cells = placementCells(p);
        const values = [...new Set(cells.map(pos))];
        values.forEach((v) => {
            min = Math.min(min, v);
            max = Math.max(max, v);
        });
        const line = (v: number) => lines.get(v) ?? (lines.set(v, { ok: true }), lines.get(v)!);
        let ok = values.length === 1;
        if (ok && p.id === "pipe") {
            // A pipe running straight across the line, like a straight belt
            const sides = p.pipeSides ?? [];
            ok = sides.length === 2 && along.every((face) => sides.includes(face as never));
        } else if (ok && !SUPPORTS.has(p.id)) {
            const fp = getFootprint(p.id);
            const ports = fp ? footprintPorts(fp, p.rot) : [];
            ok = p.id.startsWith("belt-fixed") && ports.length === 2 && ports.every((q) => q.medium === "belt") && along.every((face) => ports.some((q) => q.face === face));
        }
        if (!ok) values.forEach((v) => (line(v).ok = false));
    }
    // Lines through a block, and lines with a module's edge points (imports, exports, sinks), stay
    const keep = new Set<number>();
    for (const t of module.tiers) {
        const start = axis === "x" ? t.x ?? 0 : t.y ?? 0;
        const size = axis === "x" ? t.width : t.depth;
        for (let v = start; v < start + size; v++) keep.add(v);
    }
    for (const p of module.io) keep.add(axis === "x" ? p.cell[0] : p.cell[1]);
    // Empty lines go too
    const removed: number[] = [];
    for (let v = min + 1; v < max; v++) if (!keep.has(v) && (lines.get(v)?.ok ?? true)) removed.push(v);
    if (removed.length === 0) return module;

    const removedSet = new Set(removed);
    // How far a coordinate moves: the removed lines before it
    const shiftOf = (v: number) => {
        let n = 0;
        for (const r of removed) if (r < v) n++;
        return n;
    };
    const placements = module.placements
        .filter((p) => !removedSet.has(pos(p)) || !placementCells(p).every((c) => removedSet.has(pos(c))))
        .map((p) => (axis === "x" ? { ...p, x: p.x - shiftOf(p.x) } : { ...p, y: p.y - shiftOf(p.y) }));
    const io = module.io.map((p) => {
        const cell: IoPoint["cell"] = axis === "x" ? [p.cell[0] - shiftOf(p.cell[0]), p.cell[1], p.cell[2]] : [p.cell[0], p.cell[1] - shiftOf(p.cell[1]), p.cell[2]];
        return { ...p, cell };
    });
    const tiers = module.tiers.map((t) => (axis === "x" ? { ...t, x: (t.x ?? 0) - shiftOf(t.x ?? 0) } : { ...t, y: (t.y ?? 0) - shiftOf(t.y ?? 0) }));
    return { ...module, placements, io, tiers };
}
