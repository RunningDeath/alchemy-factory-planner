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

export function buildingName(id: string): string {
    return getFootprint(id)?.name ?? id;
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

/** Distinct hues for production steps, so each step's machines stand out */
const STEP_COLORS = ["#d4a43a", "#5dd97a", "#6db8e8", "#e8a840", "#b794ff", "#e05e8a", "#4fd1c5", "#c7d65b", "#f0845c", "#8fa8ff"];

export function placementColor(p: Placement, stepIndex: Map<string, number>): string {
    if (p.lane) return beltColor(p);
    const fp = getFootprint(p.id);
    if (fp?.category === "production" && p.nodeKey && stepIndex.has(p.nodeKey)) {
        return STEP_COLORS[stepIndex.get(p.nodeKey)! % STEP_COLORS.length];
    }
    return CATEGORY_COLORS[fp?.category ?? "logistics"];
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
