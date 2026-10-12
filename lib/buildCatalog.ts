/**
 * Build planner catalog: palette groups, colors and display helpers for buildings.
 */
import itemsData from "../data/items.json";
import { getAllFootprints, getFootprint } from "../engine/build/footprint";
import type { Placement } from "../engine/build/layout";
import type { BuildingCategory, BuildingFootprint } from "../engine/build/types";
import type { Item } from "../engine/types";

const itemNames = new Map((itemsData as unknown as Item[]).map((i) => [i.id, i.name]));

export function itemDisplayName(itemId: string): string {
    return itemNames.get(itemId) ?? itemId;
}

const itemIds = new Map([...itemNames].map(([id, name]) => [name, id]));

/** Item id for a display name (placements carry names); names are unique in items.json */
export function itemIdByName(name: string): string | undefined {
    return itemIds.get(name);
}

/** Parts the game names only internally */
const NAME_OVERRIDES: Record<string, string> = {
    "conveyer-lift-body": "Conveyor Lifter (shaft)",
    "conveyer-lift-end-upwards": "Conveyor Lifter (top, out)",
    "conveyer-lift-end-downwards": "Conveyor Lifter (top, in)",
    "conveyer-lift-upwards": "Conveyor Lifter (bottom, in)",
    "conveyer-lift-downwards": "Conveyor Lifter (bottom, out)",
};

/**
 * The app draws belts with the game's fixed pieces (each knows its sides), but they are
 * plain conveyor belts in game and in exported blueprints: only the shape differs
 */
function beltShape(id: string): string | null {
    if (id === "belt-fixed") return "";
    if (id === "belt-fixed-cw" || id === "belt-fixed-c-c-w") return " (turn)";
    if (id.startsWith("belt-fixed-") && id.includes("split")) return " (split)";
    if (id.startsWith("belt-fixed-") && id.includes("merge")) return " (merge)";
    return null;
}

export function buildingName(id: string): string {
    if (NAME_OVERRIDES[id]) return NAME_OVERRIDES[id];
    const shape = beltShape(id);
    if (shape !== null) return `Conveyor Belt${shape}`;
    const fp = getFootprint(id);
    if (!fp) return id;
    // Variants share a name: say how long or high they are
    if (id.startsWith("beam")) return `${fp.name} (${Math.max(fp.size.x, fp.size.y)} long)`;
    if (fp.category === "structure" && fp.size.z > 1 && fp.name === "Lab Stands") return `${fp.name} (${fp.size.z} high)`;
    return fp.name;
}

export interface PaletteGroup {
    label: string;
    buildings: BuildingFootprint[];
}

/** Hand-picked logistics/structure pieces first; everything else follows by category */
const FEATURED: Partial<Record<BuildingCategory, string[]>> = {
    logistics: ["belt-fixed", "splitter-vert", "merger-vert", "filter-vert", "conveyer-lift-upwards", "conveyer-lift-downwards", "conveyer-lift-body", "conveyer-lift-end-upwards", "belt-slope-up", "hopper"],
    structure: ["frame-single", "metal-stand", "iron-stand", "small-platform", "beam3"],
    floor: ["construct-floor-wood-8x8", "construct-floor-wood"],
};

const GROUPS: { label: string; category: BuildingCategory }[] = [
    { label: "Logistics", category: "logistics" },
    { label: "Pipes", category: "pipe" },
    { label: "Structures", category: "structure" },
    { label: "Floors", category: "floor" },
    { label: "Production", category: "production" },
    { label: "Heating", category: "heating" },
    { label: "Storage", category: "storage" },
    { label: "Portals", category: "portal" },
];

export function paletteGroups(): PaletteGroup[] {
    const all = getAllFootprints();
    return GROUPS.map(({ label, category }) => {
        const featured = (FEATURED[category] ?? []).map((id) => getFootprint(id)).filter((f): f is BuildingFootprint => !!f);
        const rest = all.filter((f) => f.category === category && !f.hidden && !featured.includes(f));
        return { label, buildings: [...featured, ...rest] };
    }).filter((g) => g.buildings.length > 0);
}

const CATEGORY_COLORS: Record<BuildingCategory, string> = {
    production: "#c9932e",
    heating: "#d0583c",
    logistics: "#7f8aa3",
    pipe: "#3fb5a8",
    structure: "#8a6a4a",
    floor: "#b89a6a",
    storage: "#8e6bd1",
    portal: "#b45cc8",
};

/** One colour per item: belts take the colour of what they carry, machines of what they make */
const ITEM_PALETTE = [
    "#f2c14e", "#5dd97a", "#5fb8f0", "#f07c5c", "#c084fc", "#4fd1c5", "#e86fa8", "#b8d64c",
    "#ff9f43", "#8fa8ff", "#e0e0e0", "#a3e635", "#f472b6", "#38bdf8", "#facc15", "#fb7185",
];
/** Belts that carry more than one item (before a filter) */
export const MIXED_COLOR = "#7a6f8f";

export function itemColorMap(items: string[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const item of items) if (!map.has(item)) map.set(item, ITEM_PALETTE[map.size % ITEM_PALETTE.length]);
    return map;
}

/** The single item a belt, lift or machine carries or makes, if it's just one */
export function carriedItem(p: Placement): string | null {
    if (p.supplyItem) return p.supplyItem;
    if (!p.label || p.label.includes(" + ") || p.label.startsWith("filter:")) return null;
    const category = getFootprint(p.id)?.category;
    if (category === "production" || category === "logistics" || category === "pipe" || p.lane) return p.label;
    return null;
}

/** Buildings that get icons in 3D and 2D: machines, portals, heaters and sinks */
const ICON_CATEGORIES = new Set(["production", "portal", "heating"]);
const ICON_SINKS = new Set(["knowledge-altar", "junk-barrel"]);
export function showsIcons(id: string): boolean {
    const category = getFootprint(id)?.category;
    return (!!category && ICON_CATEGORIES.has(category)) || ICON_SINKS.has(id);
}

/** The starter box stands out, as it does in game */
export const STARTER_BOX_COLOR = "#e0302a";

export function placementColor(p: Placement, itemColors: Map<string, string>): string {
    if (p.starterBox) return STARTER_BOX_COLOR;
    const item = carriedItem(p);
    if (item && itemColors.has(item)) return itemColors.get(item)!;
    if (p.label && (p.label.includes(" + ") || p.label.startsWith("filter:"))) return MIXED_COLOR;
    if (p.lane) return BELT_COLORS.manual;
    return CATEGORY_COLORS[getFootprint(p.id)?.category ?? "logistics"];
}

/** Hover text: what the building is and what it carries or makes */
export function describePlacement(p: Placement): string {
    const name = buildingName(p.id);
    const item = carriedItem(p);
    if (getFootprint(p.id)?.category === "production" && p.label) return `${name} making ${p.label}`;
    if (p.filterItem) return `${name}: ${p.filterItem} to the first output, the rest to the second`;
    if (p.supplyItem) return `${name} buying ${p.supplyItem}`;
    if (item) return `${name} carrying ${item}`;
    if (p.label) return `${name} carrying ${p.label}`;
    return name;
}

/** Belt arrows: blue feeds machines, orange collects output, purple connects blocks, grey is hand-drawn */
export const BELT_COLORS = { in: "#5fb8f0", out: "#f0a040", route: "#c084fc", manual: "#c8c0d8", track: "#2b2540" } as const;

export function beltColor(p: Placement): string {
    return p.lane ? BELT_COLORS[p.lane] : BELT_COLORS.manual;
}

export function isSupport(p: Placement): boolean {
    return getFootprint(p.id)?.category === "structure";
}

export function isMachine(p: Placement): boolean {
    const category = getFootprint(p.id)?.category;
    return category === "production" || category === "heating" || category === "portal";
}
