/**
 * Blueprint body (property tree) → app layout.
 */
import { getAllFootprints, getFootprint, type Rotation } from "../footprint";
import type { Placement } from "../layout";
import type { BuildingFootprint } from "../types";
import { beltPieceForBlueprint } from "./belts";
import { placementFromPivot, rotationFromEnum } from "./grid";
import { getProp, type Property, type Value } from "./properties";

const BY_ROW = new Map(getAllFootprints().map((f) => [f.row, f]));

export function footprintForRow(row: string): BuildingFootprint | undefined {
    return BY_ROW.get(row);
}

export interface DecodedBuilding {
    row: string;
    rot: Rotation;
    pivot: [number, number, number];
    base: [number, number];
    area: [number, number];
    buildPos: [number, number, number];
    settleKey: number;
    dependKeys: number[];
    /** Stacked pieces of a conveyor lift, bottom to top (the first is the building itself) */
    extension: { row: string; rot: Rotation }[];
    props: Property[];
}

export function buildingsOf(body: Property[]): Property[][] {
    return getProp<Value[]>(body, "Buildings") as Property[][];
}

export function decodeBuilding(b: Property[]): DecodedBuilding {
    const pkg = getProp<Property[]>(b, "building");
    const group = getProp<Property[]>(b, "RelativeGridGroup");
    return {
        row: getProp<string>(pkg, "BuildingName"),
        rot: rotationFromEnum(getProp<string>(pkg, "GridRotation")),
        pivot: getProp<number[]>(group, "Pivot") as [number, number, number],
        area: getProp<number[]>(group, "GridArea") as [number, number],
        base: getProp<number[]>(pkg, "BaseArea") as [number, number],
        buildPos: getProp<number[]>(pkg, "BuildPos") as [number, number, number],
        settleKey: getProp<number>(pkg, "SettleKey"),
        dependKeys: getProp<number[]>(b, "DependKeys"),
        extension: (getProp<Value[]>(b, "Extension") as Property[][]).map((e) => ({
            row: getProp<string>(e, "BuildingName"),
            rot: rotationFromEnum(getProp<string>(e, "GridRotation")),
        })),
        props: b,
    };
}

export interface DecodedLayout {
    placements: Placement[];
    /** Building rows without a footprint in the app */
    unknown: string[];
    /** What machines are set to, by placement uid (internal game names) */
    settings: Map<string, { recipe?: string; seed?: string; cauldronFilters?: string[] }>;
}

/**
 * Converts a blueprint body to app placements, relative to the blueprint's min corner.
 * Plain belts become the app's fixed belt pieces, with inputs from BaseActiveIndex.
 */
export function blueprintToPlacements(body: Property[]): DecodedLayout {
    const placements: Placement[] = [];
    const unknown: string[] = [];
    const settings: DecodedLayout["settings"] = new Map();
    let n = 0;
    const add = (row: string, rot: Rotation, pivot: [number, number, number], base?: [number, number], extra?: Partial<Placement>) => {
        const fp = BY_ROW.get(row);
        if (!fp) {
            unknown.push(row);
            return;
        }
        placements.push({ uid: `bp${n++}`, id: fp.id, rot, ...placementFromPivot(fp, rot, pivot, base), ...extra });
    };
    const named = (v: string | undefined) => (v && v !== "None" ? v : undefined);
    for (const raw of buildingsOf(body)) {
        const b = decodeBuilding(raw);
        const filter = getProp<string>(raw, "FilterName");
        const supply = getProp<string>(raw, "SupplyName");
        const extra = {
            ...(filter && filter !== "None" && { filterItem: filter.toLowerCase() }),
            ...(supply && supply !== "None" && { supplyItem: supply.toLowerCase() }),
        };
        if (b.extension.length) {
            // Conveyor lift: one blueprint building, one piece per storey
            b.extension.forEach((e, i) => add(e.row, e.rot, [b.pivot[0], b.pivot[1], b.pivot[2] + i]));
        } else if (b.row === "Belt") {
            const piece = beltPieceForBlueprint(b.rot, getProp<number>(getProp<Property[]>(raw, "building"), "BaseActiveIndex"));
            add(getFootprint(piece.id)!.row, piece.rot, b.pivot, b.base);
        } else {
            const before = n;
            add(b.row, b.rot, b.pivot, b.base, extra);
            if (n === before) continue;
            const cauldron = raw.filter((p) => p.name === "CauldronFilterName").map((p) => named(p.value as string));
            settings.set(`bp${n - 1}`, {
                recipe: named(getProp<string>(raw, "RecipeName")),
                seed: named(getProp<string>(raw, "SeedName")),
                ...(cauldron.some(Boolean) && { cauldronFilters: cauldron.filter((c): c is string => !!c) }),
            });
        }
    }
    return { placements, unknown, settings };
}
