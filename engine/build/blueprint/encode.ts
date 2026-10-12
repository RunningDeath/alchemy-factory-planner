/**
 * App layout → blueprint body (property tree) → blueprint file bytes.
 */
import { isBeltPiece } from "../belt-pieces";
import { canSupport, getFootprint, oppositeSide, SIDE_OFFSET, type Rotation } from "../footprint";
import { buildOccupancy, cellKey, placementCells, placementPorts, type Placement } from "../layout";
import type { BuildingFootprint, Side } from "../types";
import { beltActiveIndex, beltFront, beltOutput, beltRotationFor } from "./belts";
import { writeBlueprintFile } from "./file";
import { baseArea, buildPos, gridArea, GRID_ROTATIONS, pivotFromPlacement } from "./grid";
import { oodleStore } from "./oodle";
import { cloneProperties, encodeProperties, getProp, setProp, type Property, type Value } from "./properties";
import { gameItemName, machineSettings } from "./names";
import { blueprintTemplate, setPath } from "./template";

const LIFT_BOTTOMS = new Set(["conveyer-lift-upwards", "conveyer-lift-downwards"]);
const LIFT_TOPS = new Set(["conveyer-lift-end-upwards", "conveyer-lift-end-downwards"]);
const LIFT_BODY = "conveyer-lift-body";

/** One building in the blueprint */
interface Record {
    row: string;
    rot: Rotation;
    pivot: [number, number, number];
    base: [number, number];
    secondary?: string;
    activeIndex: number;
    /** Stacked lift pieces, bottom first */
    pieces?: { row: string; rot: Rotation }[];
    /** App placements this building stands for */
    uids: string[];
    /** Internal names the game stores: sorted item, recipe, nursery seed, item a purchasing portal buys */
    filterName?: string;
    recipeName?: string;
    seedName?: string;
    /** Cauldrons: the item each of its three input slots takes */
    cauldronFilters?: string[];
    /** Custom colour as the game stores it (blue, green, red, alpha); unset keeps the default */
    color?: number[];
    supplyName?: string;
}

export interface BlueprintBody {
    body: Property[];
    /** Buildings in the blueprint (a conveyor lift counts once) */
    buildingCount: number;
    warnings: string[];
}

/**
 * The game's red, as a player-coloured box stores it (blue, green, red, alpha; uncoloured
 * buildings keep 255,255,255,0)
 */
const STARTER_BOX_COLOR = [64, 64, 255, 255];

/** Whether something at the cell `out` of `p` takes items in from `p` */
function outputConnected(p: Placement, out: Side, byCell: Map<string, Placement[]>): boolean {
    const [dx, dy] = SIDE_OFFSET[out];
    const target = byCell.get(cellKey(p.x + dx, p.y + dy, p.z)) ?? [];
    return target.some(
        (t) =>
            t.uid !== p.uid &&
            (t.id === "belt" ||
                placementPorts(t).some((port) => port.x === p.x + dx && port.y === p.y + dy && port.z === p.z && port.face === oppositeSide(out) && port.dir !== "out")),
    );
}

function plainRecord(p: Placement, fp: BuildingFootprint): Record {
    return {
        row: fp.row,
        rot: p.rot,
        pivot: pivotFromPlacement(fp, p),
        base: baseArea(fp),
        secondary: fp.secondary,
        activeIndex: 0,
        uids: [p.uid],
        filterName: p.filterItem ? gameItemName(p.filterItem) : undefined,
        supplyName: p.supplyItem ? gameItemName(p.supplyItem) : undefined,
        // The starter box shows red in game, so the player finds it to fill it
        color: p.starterBox ? STARTER_BOX_COLOR : undefined,
        ...machineSettings(p, fp),
    };
}

/**
 * Every belt piece, splits and merges included, becomes a plain belt: that is all player
 * blueprints use, and the fixed pieces are a separate unlock in game.
 */
function beltRecord(p: Placement, byCell: Map<string, Placement[]>): Record {
    const belt = getFootprint("belt")!;
    const ports = placementPorts(p);
    const outs = p.id === "belt" ? [beltOutput(p.rot)] : ports.filter((q) => q.dir === "out").map((q) => q.face as Side);
    const ins = p.id === "belt" ? [oppositeSide(outs[0])] : ports.filter((q) => q.dir === "in").map((q) => q.face as Side);
    const front = beltFront(ins, outs);
    const connected = outs.filter((o) => outputConnected(p, o, byCell));
    return { ...plainRecord({ ...p, rot: beltRotationFor(front) }, belt), activeIndex: beltActiveIndex(front, ins, connected) };
}

/**
 * A plain pipe: BaseActiveIndex holds its connected sides relative to its front, like a
 * belt's inputs (front 1, right 2, back 4, left 8), plus 16 down and 32 up. Checked against
 * the pipes in three player blueprints.
 */
function pipeRecord(p: Placement, fp: BuildingFootprint): Record {
    const front = beltOutput(p.rot);
    let bits = 0;
    for (const side of p.pipeSides ?? []) {
        if (side === "base") bits |= 16;
        else if (side === "top") bits |= 32;
        else bits |= beltActiveIndex(front, [side], []);
    }
    return { ...plainRecord(p, fp), activeIndex: bits };
}

/** Converts placements to blueprint buildings; lifts are grouped into one building each */
function toRecords(placements: Placement[], warnings: string[]): Record[] {
    // Every cell a building takes: a belt feeding a big machine meets it away from its origin
    const byCell = new Map<string, Placement[]>();
    for (const p of placements)
        for (const c of placementCells(p)) {
            const key = cellKey(c.x, c.y, c.z);
            byCell.set(key, [...(byCell.get(key) ?? []), p]);
        }
    const used = new Set<string>();
    const records: Record[] = [];

    for (const p of placements) {
        if (!LIFT_BOTTOMS.has(p.id)) continue;
        const stack = [p];
        for (let z = p.z + 1; ; z++) {
            const next = (byCell.get(cellKey(p.x, p.y, z)) ?? []).find((q) => q.id === LIFT_BODY || LIFT_TOPS.has(q.id));
            if (!next) break;
            stack.push(next);
            if (LIFT_TOPS.has(next.id)) break;
        }
        if (!LIFT_TOPS.has(stack[stack.length - 1].id)) warnings.push(`Conveyor lift at ${p.x},${p.y},${p.z} has no top piece`);
        stack.forEach((q) => used.add(q.uid));
        const fp = getFootprint(p.id)!;
        records.push({ ...plainRecord(p, fp), uids: stack.map((q) => q.uid), pieces: stack.map((q) => ({ row: getFootprint(q.id)!.row, rot: q.rot })) });
    }

    for (const p of placements) {
        if (used.has(p.uid)) continue;
        const fp = getFootprint(p.id);
        if (!fp) {
            warnings.push(`Unknown building "${p.id}" skipped`);
            continue;
        }
        if (p.id === LIFT_BODY || LIFT_TOPS.has(p.id)) {
            warnings.push(`Conveyor lift piece at ${p.x},${p.y},${p.z} without a bottom piece skipped`);
            continue;
        }
        records.push(isBeltPiece(p.id) ? beltRecord(p, byCell) : p.id === "pipe" ? pipeRecord(p, fp) : plainRecord(p, fp));
    }
    return records;
}

/** Keys of the buildings each record rests on (supporting cells directly below its foundation) */
function dependencies(records: Record[], placements: Placement[]): { keys: number[]; foundation: boolean }[] {
    const byUid = new Map(placements.map((p) => [p.uid, p]));
    const recordOf = new Map<string, number>();
    records.forEach((r, i) => r.uids.forEach((u) => recordOf.set(u, i)));
    const occupancy = buildOccupancy(placements.filter((p) => recordOf.has(p.uid)));
    return records.map((r, i) => {
        const cells = r.uids.flatMap((u) => placementCells(byUid.get(u)!));
        const own = new Set(cells.map((c) => cellKey(c.x, c.y, c.z)));
        const keys = new Set<number>();
        for (const c of cells) {
            if (!c.foundation || own.has(cellKey(c.x, c.y, c.z - 1))) continue;
            for (const b of occupancy.get(cellKey(c.x, c.y, c.z - 1)) ?? []) {
                const j = recordOf.get(b.uid)!;
                if (j !== i && b.stackable && (b.quads & c.quads) !== 0 && canSupport(getFootprint(b.id)!)) keys.add(j + 1);
            }
        }
        return { keys: [...keys].sort((a, b) => a - b), foundation: cells.some((c) => c.foundation) };
    });
}

/** Builds the blueprint body for a layout, copying every other field from the template */
export function placementsToBody(placements: Placement[]): BlueprintBody {
    const warnings: string[] = [];
    const template = blueprintTemplate();
    const unsorted = toRecords(placements, warnings);
    if (unsorted.length === 0) throw new Error("The layout has no buildings to export");

    // Supporters before what rests on them, like the game settles them
    const records = unsorted.sort((a, b) => a.pivot[2] - b.pivot[2] || a.pivot[1] - b.pivot[1] || a.pivot[0] - b.pivot[0]);
    const deps = dependencies(records, placements);

    // Blueprint origin: min corner of all grid areas and occupied cells
    const byUid = new Map(placements.map((p) => [p.uid, p]));
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity];
    for (const r of records) {
        const area = gridArea(r.base, r.rot);
        const rects: [number, number, number, number, number][] = [[r.pivot[0], r.pivot[1], r.pivot[2], r.pivot[0] + area[0], r.pivot[1] + area[1]]];
        for (const u of r.uids) for (const c of placementCells(byUid.get(u)!)) rects.push([c.x, c.y, c.z, c.x + 1, c.y + 1]);
        for (const [x0, y0, z0, x1, y1] of rects) {
            min[0] = Math.min(min[0], x0);
            min[1] = Math.min(min[1], y0);
            min[2] = Math.min(min[2], z0);
            max[0] = Math.max(max[0], x1);
            max[1] = Math.max(max[1], y1);
        }
    }

    const parentGroup = getProp<Property[]>(template.body, "ParentGridGroup");
    const parentPivot = getProp<number[]>(parentGroup, "Pivot");
    setProp(parentGroup, "GridArea", [max[0] - min[0], max[1] - min[1]]);

    let lifts = 0;
    const buildings: Property[][] = records.map((r, i) => {
        const b = cloneProperties(r.pieces ? template.lift : template.building);
        const pivot = [r.pivot[0] - min[0], r.pivot[1] - min[1], r.pivot[2] - min[2]];
        const area = gridArea(r.base, r.rot);
        const { keys, foundation } = deps[i];
        setProp(b, "IsDepend", keys.length > 0);
        setProp(b, "DependOthers", keys.length === 0 && foundation);
        setProp(b, "DependKeys", keys);
        setProp(b, "FilterName", r.filterName ?? "None");
        setProp(b, "RecipeName", r.recipeName ?? "None");
        setProp(b, "SeedName", r.seedName ?? "None");
        setProp(b, "SupplyName", r.supplyName ?? "None");
        b.filter((p) => p.name === "CauldronFilterName").forEach((p, k) => (p.value = r.cauldronFilters?.[k] ?? "None"));
        if (r.color) setProp(b, "CustomColor", r.color);
        setPath(b, ["RelativeGridGroup", "Pivot"], pivot);
        setPath(b, ["RelativeGridGroup", "GridArea"], area);
        const pkg = getProp<Property[]>(b, "building");
        setProp(pkg, "Secondary", `ESecondaryType::${r.secondary ?? "None"}`);
        setProp(pkg, "GridRotation", GRID_ROTATIONS[r.rot]);
        setProp(pkg, "BaseActiveIndex", r.activeIndex);
        setProp(pkg, "SettleKey", i + 1);
        setProp(pkg, "BaseArea", r.base);
        setProp(pkg, "BuildPos", buildPos(parentPivot, pivot, area));
        setProp(pkg, "BuildingName", r.row);
        const entity = getProp<Property[]>(pkg, "BuildingEntity");
        if (r.pieces) {
            setProp(entity, "Type", "ESecondaryType::ConveyerLift");
            setProp(entity, "Version", lifts + 1);
            setProp(entity, "EntityIndex", lifts++);
            setProp(
                b,
                "Extension",
                r.pieces.map((piece) => {
                    const e = cloneProperties(template.piece);
                    setProp(e, "GridRotation", GRID_ROTATIONS[piece.rot]);
                    setProp(e, "BuildingName", piece.row);
                    return e;
                }) as Value[],
            );
        } else {
            setProp(entity, "Type", "ESecondaryType::None");
            setProp(entity, "Version", 0);
            setProp(entity, "EntityIndex", -1);
            setProp(b, "Extension", []);
        }
        return b;
    });

    const body = template.body.map((p) => (p.name === "Buildings" ? { ...p, value: buildings as Value[] } : p));
    return { body, buildingCount: records.length, warnings };
}

export interface BlueprintMeta {
    title: string;
    description?: string;
    /** Item whose icon the game may show for the blueprint (game item row name, case-insensitive) */
    itemName?: string;
    /** Marks the preview as a custom image. The player's own blueprints all have false. */
    uploadedImage?: boolean;
}

function text(s: string | undefined) {
    return s ? { text: { flags: 2, invariant: s } } : { text: { flags: 0, invariant: null } };
}

/** Header properties for a blueprint, from the template */
export function blueprintHeader(meta: BlueprintMeta): Property[] {
    const header = blueprintTemplate().header;
    setProp(header, "Title", text(meta.title));
    setProp(header, "Description", text(meta.description));
    if (meta.itemName) setProp(header, "ItemName", meta.itemName);
    setProp(header, "UploadedImage", meta.uploadedImage ?? false);
    return header;
}

export interface ExportedBlueprint {
    bytes: Uint8Array;
    buildingCount: number;
    warnings: string[];
}

/** Complete blueprint file: PNG preview + header + body stored in an Oodle stream */
export function exportBlueprint(placements: Placement[], meta: BlueprintMeta, png: Uint8Array): ExportedBlueprint {
    const { body, buildingCount, warnings } = placementsToBody(placements);
    const raw = encodeProperties(body);
    const bytes = writeBlueprintFile({ png, header: blueprintHeader(meta), compressed: oodleStore(raw), uncompressedSize: raw.length });
    return { bytes, buildingCount, warnings };
}

/** Blueprint file name: 22 random base64url characters, like the game's */
export function randomBlueprintId(random: () => number = Math.random): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = "";
    for (let i = 0; i < 22; i++) id += alphabet[Math.floor(random() * 64)];
    return id;
}
