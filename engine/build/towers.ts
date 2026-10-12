/**
 * Block towers: small blocks go on top of other blocks instead of next to them, so a
 * module uses the storey's height rather than floor space. The upper block rests on
 * wood block and lab stand columns down to whatever is below (machine tops that take a
 * load, or the ground); lab stands let lane belts underneath keep running.
 */
import { cellKey, cellsCollide, placementCells, type Placement } from "./layout";
import { transformBlock } from "./packing";
import { findLaneEnds } from "./router";
import { addToOccupancy, isSupported, supportColumn, type Occupancy } from "./supports";

export interface TowerMember {
    /** Block index */
    index: number;
    /** Where the block sits in the tower's frame */
    dx: number;
    dy: number;
    dz: number;
    /** Turned a quarter before mounting (lanes run along x instead of y) */
    turned?: boolean;
}

export interface Tower {
    members: TowerMember[];
    /** Every member's placements in the tower's frame, plus the columns under upper blocks */
    placements: Placement[];
    width: number;
    depth: number;
}

export interface TowerBlock {
    placements: Placement[];
    width: number;
    depth: number;
    /** Heated blocks need their platform on the ground */
    canGoUp: boolean;
    /** Others may stand on it (purchasing portals stay free, in the front row) */
    canCarry?: boolean;
    /** Score taken off for putting it up (machines that would rather stay on the floor) */
    upCost?: number;
    /** Only shares a tower with blocks of the same group (unset: the common pool) */
    group?: string;
    /** Machine kind: the same machines rather stack together (nurseries on nurseries) */
    kind?: string;
    /** Small machines (grinders): blocks of them don't stack on each other, each would need its own lifts */
    small?: boolean;
}

interface TowerOptions {
    maxHeight: number;
    /** Blocks that exchange items: stacking them keeps belts short */
    related: (a: number, b: number) => boolean;
    makeUid: () => string;
}

/** Upper block must save at least this share of its own floor */
const MIN_SAVING = 0.15;
/** How far an upper block may reach past the tower's edge */
const OVERHANG = 3;
/** Score per support column cell (wood is cheap, but a forest of columns isn't) */
const SUPPORT_COST = 0.1;
const RELATED_BONUS = 6;
/** Tower that already holds the same machines: consistent stacks, one kind of upkeep per tower */
const SAME_KIND_BONUS = 5;
/** Per level up: high blocks mean long lifts and belts on tall columns */
const HEIGHT_COST = 0.5;

/**
 * Lane ends a connecting belt can't reach: the cell in front of the end is taken, or (up
 * in the air) neither it nor a neighbour has a free shaft to the ground for a lift or
 * supports. Mounting a block must not add any: those connections would fail.
 */
function blockedEnds(placements: Placement[]): number {
    const occupied = new Set<string>();
    // Highest cell over each spot that a belt can't pass (lab stands let belts through)
    const above = new Map<string, number>();
    for (const p of placements)
        for (const c of placementCells(p)) {
            occupied.add(`${c.x},${c.y},${c.z}`);
            if (p.id !== "frame-single") above.set(`${c.x},${c.y}`, Math.max(above.get(`${c.x},${c.y}`) ?? -1, c.z));
        }
    const shaftFree = (x: number, y: number, z: number) => {
        for (let k = 0; k <= z; k++) if (occupied.has(`${x},${y},${k}`)) return false;
        return true;
    };
    return findLaneEnds(placements).filter(({ port: [x, y, z] }) => {
        if (occupied.has(`${x},${y},${z}`)) return true;
        // Nothing but lab stands over the cell in front of a lane end: the belt comes in there
        if ((above.get(`${x},${y}`) ?? -1) > z) return true;
        if (z === 0) return false;
        return ![[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oy]) => shaftFree(x + ox, y + oy, z - 1));
    }).length;
}

const shift = (ps: Placement[], dx: number, dy: number, dz: number) => ps.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy, z: p.z + dz }));

function occupancyOf(placements: Placement[]): Occupancy {
    const occupancy: Occupancy = new Map();
    placements.forEach((p) => addToOccupancy(occupancy, p));
    return occupancy;
}

/** Height of the tower's top per ground cell (one above its highest cell) */
function topMap(placements: Placement[]): Map<string, number> {
    const top = new Map<string, number>();
    for (const p of placements)
        for (const c of placementCells(p)) {
            const key = `${c.x},${c.y}`;
            top.set(key, Math.max(top.get(key) ?? 0, c.z + 1));
        }
    return top;
}

/** Wooden beams, longest first; they only need support at both ends */
const DECK_BEAMS: [number, string][] = [
    [5, "beam5"],
    [3, "beam3"],
];

interface Fit {
    dz: number;
    moved: Placement[];
    supports: Placement[];
}

function fits(occupancy: Occupancy, p: Placement): boolean {
    return placementCells(p).every((c) => (occupancy.get(cellKey(c.x, c.y, c.z)) ?? []).every((o) => !cellsCollide(c, o)));
}

/** A column of supports under (x, y, z) that reaches the ground or something carrying it, added to the occupancy */
function carry(occupancy: Occupancy, x: number, y: number, z: number, makeUid: () => string): Placement[] | null {
    if (isSupported(occupancy, x, y, z)) return [];
    const column = supportColumn(occupancy, x, y, z, 0, makeUid);
    const lowest = column.length ? column[column.length - 1].z : z;
    return isSupported(occupancy, x, y, lowest) ? column : null;
}

/** Upper block placed `dz` up, standing on columns only */
function onColumns(tower: Tower, moved: Placement[], dz: number, opts: TowerOptions): Fit | null {
    const occupancy = occupancyOf(tower.placements);
    moved.forEach((p) => addToOccupancy(occupancy, p));
    const supports: Placement[] = [];
    for (const c of moved.flatMap(placementCells).filter((c) => c.z === dz && c.foundation)) {
        const column = carry(occupancy, c.x, c.y, c.z, opts.makeUid);
        if (!column) return null;
        supports.push(...column);
    }
    return { dz, moved, supports };
}

/**
 * Upper block on a deck of beams one level up: most machines can't carry a load, so the
 * beams span across them and rest on columns at their ends (lanes, gaps, the ground)
 */
function onDeck(tower: Tower, moved: Placement[], dz: number, axis: "x" | "y", opts: TowerOptions): Fit | null {
    const deckZ = dz - 1;
    const occupancy = occupancyOf(tower.placements);
    moved.forEach((p) => addToOccupancy(occupancy, p));
    const supports: Placement[] = [];
    const needed = moved.flatMap(placementCells).filter((c) => c.z === dz && c.foundation);
    const lineOf = (c: { x: number; y: number }) => (axis === "x" ? c.y : c.x);
    const posOf = (c: { x: number; y: number }) => (axis === "x" ? c.x : c.y);
    const lines = new Map<number, number[]>();
    for (const c of needed) lines.set(lineOf(c), [...(lines.get(lineOf(c)) ?? []), posOf(c)]);
    const at = (line: number, pos: number) => (axis === "x" ? { x: pos, y: line } : { x: line, y: pos });

    for (const [line, list] of lines) {
        const todo = [...new Set(list)].sort((p, q) => p - q);
        while (todo.length) {
            const first = todo[0];
            let placed: Placement[] | null = null;
            for (const [length, id] of DECK_BEAMS) {
                // Start so the beam covers the first open cell, as many others as it can
                for (let start = first; start > first - length && !placed; start--) {
                    const origin = at(line, start);
                    const beam: Placement = { uid: opts.makeUid(), id, x: origin.x, y: origin.y, z: deckZ, rot: axis === "x" ? 1 : 0 };
                    const cells = placementCells(beam);
                    if (!fits(occupancy, beam) || !cells.some((c) => posOf(c) === first && lineOf(c) === line)) continue;
                    const trial = new Map([...occupancy].map(([k, v]) => [k, [...v]]));
                    addToOccupancy(trial, beam);
                    const ends = cells.filter((c) => c.foundation);
                    const columns = ends.map((c) => carry(trial, c.x, c.y, c.z, opts.makeUid));
                    if (columns.some((col) => !col)) continue;
                    placed = [beam, ...columns.flatMap((col) => col!)];
                    trial.forEach((v, k) => occupancy.set(k, v));
                    const covered = new Set(cells.map(posOf));
                    for (let i = todo.length - 1; i >= 0; i--) if (covered.has(todo[i])) todo.splice(i, 1);
                }
                if (placed) break;
            }
            if (!placed) return null;
            supports.push(...placed);
        }
    }
    return { dz, moved, supports };
}

/** Puts `upper` on `tower` at (dx, dy): the columns and beams it needs, or null when it can't stand there */
function mount(tower: Tower, top: Map<string, number>, upper: TowerBlock, dx: number, dy: number, opts: TowerOptions): Fit | null {
    const cells = upper.placements.flatMap(placementCells);
    // Lowest height where every cell of the upper block clears the tower
    let dz = 0;
    for (const c of cells) dz = Math.max(dz, (top.get(`${c.x + dx},${c.y + dy}`) ?? 0) - c.z);
    // Nothing under it: that's placing it beside, the packer's job
    if (dz === 0) return null;
    const height = Math.max(...cells.map((c) => c.z)) + 1;
    if (dz + height > opts.maxHeight) return null;
    const direct = onColumns(tower, shift(upper.placements, dx, dy, dz), dz, opts);
    if (direct) return direct;
    if (dz + 1 + height > opts.maxHeight) return null;
    const raised = shift(upper.placements, dx, dy, dz + 1);
    // Beams the way that needs the fewest supports
    const decks = [onDeck(tower, raised, dz + 1, "x", opts), onDeck(tower, raised, dz + 1, "y", opts)].filter((d): d is Fit => !!d);
    return decks.sort((a, b) => a.supports.length - b.supports.length)[0] ?? null;
}

function bounds(placements: Placement[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of placements)
        for (const c of placementCells(p)) {
            minX = Math.min(minX, c.x);
            minY = Math.min(minY, c.y);
            maxX = Math.max(maxX, c.x);
            maxY = Math.max(maxY, c.y);
        }
    return { minX, minY, maxX, maxY };
}

/**
 * Groups blocks into towers. Small blocks first look for a tower they fit on; a block
 * that already carries another stays a base.
 */
export function buildTowers(blocks: TowerBlock[], opts: TowerOptions): Tower[] {
    const towers: (Tower | null)[] = blocks.map((b, index) => ({
        members: [{ index, dx: 0, dy: 0, dz: 0 }],
        placements: b.placements,
        width: b.width,
        depth: b.depth,
    }));
    const order = blocks.map((_, i) => i).sort((a, b) => blocks[a].width * blocks[a].depth - blocks[b].width * blocks[b].depth);

    // First the same machines among themselves (nurseries on nurseries, a consistent stack on
    // the floor), then whatever fits anywhere
    type Candidate = { t: number; dx: number; dy: number; score: number; fit: NonNullable<ReturnType<typeof mount>>; upper: TowerBlock; turned: boolean };
    // Best spot per block on each tower, until that tower changes: the second pass reuses the first's
    const version = towers.map(() => 0);
    const memo = new Map<string, Candidate | null>();
    for (const sameOnly of [true, false])
    for (const i of order) {
        const own = towers[i];
        if (!blocks[i].canGoUp || !own || own.members.length > 1) continue;
        const area = blocks[i].width * blocks[i].depth;
        let best: Candidate | null = null;
        // As built and turned a quarter: a turned block often fits where the other doesn't
        const variants = [
            { upper: blocks[i], turned: false },
            { upper: { ...blocks[i], placements: transformBlock(blocks[i].placements, blocks[i].depth, 1, 0, 0), width: blocks[i].depth, depth: blocks[i].width }, turned: true },
        ];

        for (let t = 0; t < towers.length; t++) {
            const tower = towers[t];
            if (!tower || t === i || tower.members.some((m) => blocks[m.index].canCarry === false || blocks[m.index].group !== blocks[i].group)) continue;
            if (sameOnly && !tower.members.every((m) => blocks[m.index].kind === blocks[i].kind)) continue;
            if (blocks[i].small && tower.members.some((m) => blocks[m.index].small)) continue;
            const key = `${t}|${version[t]}|${i}`;
            if (!memo.has(key)) {
            let towerBest: Candidate | null = null;
            for (const { upper, turned } of variants) {
            const top = topMap(tower.placements);
            const apart = [...tower.placements, ...upper.placements.map((p) => ({ ...p, x: p.x + 10000 }))];
            const blockedBefore = blockedEnds(apart);
            const related = tower.members.some((m) => opts.related(m.index, i));
            const sameKind = !!blocks[i].kind && tower.members.some((m) => blocks[m.index].kind === blocks[i].kind);
            // Up to a few cells past the edge, so the upper block's lane ends can reach down
            const xs = [Math.min(0, tower.width - upper.width) - OVERHANG, Math.max(0, tower.width - upper.width) + OVERHANG];
            const ys = [Math.min(0, tower.depth - upper.depth) - OVERHANG, Math.max(0, tower.depth - upper.depth) + OVERHANG];
            for (let dx = xs[0]; dx <= xs[1]; dx++)
                for (let dy = ys[0]; dy <= ys[1]; dy++) {
                    const fit = mount(tower, top, upper, dx, dy, opts);
                    if (!fit) continue;
                    const together = [...tower.placements, ...fit.moved, ...fit.supports];
                    if (blockedEnds(together) > blockedBefore) continue;
                    const reach = bounds([...fit.moved, ...fit.supports]);
                    const width = Math.max(tower.width, dx + upper.width, reach.maxX + 1) - Math.min(0, dx, reach.minX);
                    const depth = Math.max(tower.depth, dy + upper.depth, reach.maxY + 1) - Math.min(0, dy, reach.minY);
                    const saved = tower.width * tower.depth + area - width * depth;
                    if (saved < area * MIN_SAVING) continue;
                    const score = saved - fit.supports.length * SUPPORT_COST + (related ? RELATED_BONUS : 0) + (sameKind ? SAME_KIND_BONUS : 0) - fit.dz * HEIGHT_COST - (blocks[i].upCost ?? 0);
                    if (!towerBest || score > towerBest.score) towerBest = { t, dx, dy, score, fit, upper, turned };
                }
            }
            memo.set(key, towerBest);
            }
            const candidate = memo.get(key);
            if (candidate && (!best || candidate.score > best.score)) best = candidate;
        }
        if (!best) continue;
        const { t, dx, dy, fit, upper, turned } = best;
        const tower = towers[t]!;
        const all = [...tower.placements, ...fit.moved, ...fit.supports];
        const members = [...tower.members, { index: i, dx, dy, dz: fit.dz, turned }];
        // Keep the tower's frame at 0,0
        const b = bounds(all);
        const ox = Math.min(0, b.minX), oy = Math.min(0, b.minY);
        towers[t] = {
            members: members.map((m) => ({ ...m, dx: m.dx - ox, dy: m.dy - oy })),
            placements: shift(all, -ox, -oy, 0),
            // Deck beams may reach past both blocks
            width: Math.max(tower.width, dx + upper.width, b.maxX + 1) - ox,
            depth: Math.max(tower.depth, dy + upper.depth, b.maxY + 1) - oy,
        };
        towers[i] = null;
        version[t]++;
    }
    return towers.filter((t): t is Tower => t !== null);
}

