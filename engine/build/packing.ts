/**
 * Packs rectangular blocks onto the ground as tightly as possible.
 *
 * Skyline packing: blocks go in biggest first, each at the lowest spot along the
 * current skyline, in whichever orientation ends lower. Several module widths are
 * tried; the most compact result wins: shortest longest side, then smallest area.
 */
import { getFootprint, rotatedSize, type Rotation } from "./footprint";
import type { Placement } from "./layout";

export interface PackItem {
    width: number;
    depth: number;
}

export interface PackedItem {
    x: number;
    y: number;
    /** Quarter turns clockwise applied to the block */
    rot: 0 | 1;
}

export function packBlocks(items: PackItem[], maxWidth: number): { positions: PackedItem[]; width: number; depth: number } {
    if (items.length === 0) return { positions: [], width: 0, depth: 0 };
    const order = items.map((_, i) => i).sort((a, b) => Math.max(items[b].width, items[b].depth) - Math.max(items[a].width, items[a].depth));
    const minWidth = Math.max(...items.map((it) => Math.min(it.width, it.depth)));
    const limit = Math.max(minWidth, maxWidth);

    let best: { positions: PackedItem[]; width: number; depth: number } | null = null;
    for (let width = minWidth; width <= limit; width++) {
        const result = skyline(items, order, width);
        if (!result) continue;
        if (!best || compactness(result) < compactness(best)) best = result;
    }
    return best!;
}

/** Longest side first (no long strips), then area */
function compactness(r: { width: number; depth: number }): number {
    return Math.max(r.width, r.depth) * 10000 + r.width * r.depth;
}

function skyline(items: PackItem[], order: number[], width: number) {
    const heights = new Array<number>(width).fill(0);
    const positions = new Array<PackedItem>(items.length);

    for (const i of order) {
        let choice: { x: number; y: number; rot: 0 | 1; top: number } | null = null;
        for (const rot of [0, 1] as const) {
            const w = rot ? items[i].depth : items[i].width;
            const d = rot ? items[i].width : items[i].depth;
            if (w > width) continue;
            for (let x = 0; x + w <= width; x++) {
                const y = Math.max(...heights.slice(x, x + w));
                const top = y + d;
                if (!choice || top < choice.top || (top === choice.top && (y < choice.y || (y === choice.y && x < choice.x)))) {
                    choice = { x, y, rot, top };
                }
            }
        }
        if (!choice) return null;
        const w = choice.rot ? items[i].depth : items[i].width;
        for (let x = choice.x; x < choice.x + w; x++) heights[x] = choice.top;
        positions[i] = { x: choice.x, y: choice.y, rot: choice.rot };
    }

    const usedWidth = Math.max(...order.map((i) => positions[i].x + (positions[i].rot ? items[i].depth : items[i].width)));
    return { positions, width: usedWidth, depth: Math.max(...heights) };
}

/**
 * Turns a block (placements with coordinates inside 0..width-1 × 0..depth-1) a quarter
 * turn clockwise and moves it to (dx, dy). Every building turns with it.
 */
export function transformBlock(placements: Placement[], depth: number, rot: 0 | 1, dx: number, dy: number): Placement[] {
    return placements.map((p) => {
        if (rot === 0) return { ...p, x: p.x + dx, y: p.y + dy };
        const fp = getFootprint(p.id);
        const size = fp ? rotatedSize(fp, p.rot) : { x: 1, y: 1 };
        return {
            ...p,
            x: depth - (p.y + size.y) + dx,
            y: p.x + dy,
            rot: ((p.rot + 1) % 4) as Rotation,
        };
    });
}

export interface FlowItem extends PackItem {
    /** Production stage: 0 for blocks fed only from outside, then one more per step */
    stage: number;
    /** Blocks that make this block's inputs */
    feeders: number[];
}

/**
 * Flow layout: one row of blocks per production stage, from raw materials (top) to the
 * final products (bottom). Inputs face the previous row and outputs the next, so most
 * belts run straight down. Within a row, blocks sit under the blocks that feed them.
 */
export function flowRows(items: FlowItem[], maxWidth: number, gapX: number, gapY: number): { positions: PackedItem[]; width: number; depth: number } {
    const positions = new Array<PackedItem>(items.length);
    const stages = [...new Set(items.map((it) => it.stage))].sort((a, b) => a - b);
    let y = 0;
    let width = 0;

    for (const stage of stages) {
        const members = items.map((_, i) => i).filter((i) => items[i].stage === stage);
        const center = (i: number) => {
            const placed = items[i].feeders.filter((f) => positions[f]);
            if (placed.length === 0) return Infinity;
            return placed.reduce((s, f) => s + positions[f].x + items[f].width / 2, 0) / placed.length;
        };
        members.sort((a, b) => center(a) - center(b));

        let x = 0;
        let rowDepth = 0;
        for (const i of members) {
            if (x > 0 && x + items[i].width > maxWidth) {
                y += rowDepth + gapY;
                x = 0;
                rowDepth = 0;
            }
            // Line up under the feeders where there's room
            const target = Math.round(center(i) - items[i].width / 2);
            if (Number.isFinite(target) && target > x && target + items[i].width <= Math.max(maxWidth, width)) x = target;
            positions[i] = { x, y, rot: 0 };
            x += items[i].width + gapX;
            width = Math.max(width, x - gapX);
            rowDepth = Math.max(rowDepth, items[i].depth);
        }
        y += rowDepth + gapY;
    }
    return { positions, width, depth: y - gapY };
}

export interface FeedItem extends FlowItem {
    /** How many belts' worth comes from each feeder (parallel to feeders) */
    feederWeights: number[];
}

/**
 * Near-feeder layout: blocks go in production order, each at the free spot (below, beside
 * or above an already placed block) that keeps its belts shortest: the distance from each
 * feeder's output edge to this block's input edge, weighted by how much flows between them,
 * plus a little for growing the module. Inputs face up (-y), outputs down (+y), so a spot
 * right below the main feeder is usually best.
 */
export function nearFeeders(items: FeedItem[], maxWidth: number): { positions: PackedItem[]; width: number; depth: number } {
    const positions = new Array<PackedItem>(items.length);
    const placed: number[] = [];
    const order = items.map((_, i) => i).sort((a, b) => items[a].stage - items[b].stage || a - b);
    const overlaps = (x: number, y: number, w: number, d: number) =>
        placed.some((j) => {
            const p = positions[j];
            return x < p.x + items[j].width && p.x < x + w && y < p.y + items[j].depth && p.y < y + d;
        });
    const bounds = (extra?: { x: number; y: number; w: number; d: number }) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const rects = placed.map((j) => ({ x: positions[j].x, y: positions[j].y, w: items[j].width, d: items[j].depth }));
        if (extra) rects.push(extra);
        for (const r of rects) {
            minX = Math.min(minX, r.x);
            minY = Math.min(minY, r.y);
            maxX = Math.max(maxX, r.x + r.w);
            maxY = Math.max(maxY, r.y + r.d);
        }
        return { minX, minY, maxX, maxY };
    };

    for (const i of order) {
        const it = items[i];
        if (placed.length === 0) {
            positions[i] = { x: 0, y: 0, rot: 0 };
            placed.push(i);
            continue;
        }
        // Candidate spots around every placed block, aligned to its edges and center
        const candidates: [number, number][] = [];
        for (const j of placed) {
            const p = positions[j];
            const o = items[j];
            const xs = [p.x, p.x + Math.round((o.width - it.width) / 2), p.x + o.width - it.width];
            const ys = [p.y, p.y + o.depth - it.depth];
            for (const x of xs) candidates.push([x, p.y + o.depth], [x, p.y - it.depth]);
            for (const y of ys) candidates.push([p.x + o.width, y], [p.x - it.width, y]);
        }
        let best: { x: number; y: number; score: number } | null = null;
        const before = bounds();
        const area = (b: ReturnType<typeof bounds>) => (b.maxX - b.minX) * (b.maxY - b.minY);
        for (const [x, y] of candidates) {
            if (overlaps(x, y, it.width, it.depth)) continue;
            const after = bounds({ x, y, w: it.width, d: it.depth });
            if (after.maxX - after.minX > maxWidth && after.maxX - after.minX > before.maxX - before.minX) continue;
            let belts = 0;
            it.feeders.forEach((f, k) => {
                if (!positions[f]) return;
                const fp = positions[f];
                const fo = items[f];
                // From the feeder's output edge (bottom) to this block's input edge (top)
                const dx = Math.abs(fp.x + fo.width / 2 - (x + it.width / 2));
                const dy = Math.abs(fp.y + fo.depth - y);
                // Belts going back up around a block are much longer than the straight distance
                const upward = y < fp.y + fo.depth ? fo.depth + it.depth : 0;
                belts += (dx + dy + upward) * it.feederWeights[k];
            });
            const score = belts + (area(after) - area(before)) * 0.05;
            if (!best || score < best.score) best = { x, y, score };
        }
        // Nothing fits within the width: start below everything
        positions[i] = best ? { x: best.x, y: best.y, rot: 0 } : { x: before.minX, y: before.maxY, rot: 0 };
        placed.push(i);
    }

    // Shift to start at 0,0
    const b = bounds();
    for (const i of placed) positions[i] = { ...positions[i], x: positions[i].x - b.minX, y: positions[i].y - b.minY };
    return { positions, width: b.maxX - b.minX, depth: b.maxY - b.minY };
}
