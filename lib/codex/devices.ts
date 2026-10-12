/**
 * Devices for the codex: machines, heating, portals and storage, from the building
 * footprints (size, ports, build cost), devices.json (heat, heater slots), the unlock table
 * and the recipes made in them.
 */
import footprintsData from "@/data/building-footprints.json";
import devicesData from "@/data/devices.json";
import unlocksData from "@/data/building-unlocks.json";
import itemsData from "@/data/items.json";
import recipesData from "@/data/recipes.json";
import { cauldronMixesByOutput } from "@/engine/cauldron";
import type { BuildingFootprint } from "@/engine/build/types";
import type { Item, Recipe } from "@/engine/types";

const footprints = footprintsData as unknown as BuildingFootprint[];
const deviceRows = (Array.isArray(devicesData) ? devicesData : Object.values(devicesData)) as {
    id: string;
    heat_consuming_speed?: number;
    heat_self?: number;
    slots?: number;
    slots_required?: number;
    parent?: string;
}[];
const unlocks = unlocksData as Record<string, { level: number; via: string; by?: string }>;
const items = itemsData as unknown as Item[];
const recipes = recipesData as unknown as Recipe[];
const itemName = new Map(items.map((i) => [i.id, i.name]));

const DEVICE_CATEGORIES = ["production", "heating", "portal", "storage"] as const;
export type DeviceCategory = (typeof DEVICE_CATEGORIES)[number];

export const DEVICE_CATEGORY_LABEL: Record<DeviceCategory, string> = {
    production: "Production",
    heating: "Heating",
    portal: "Portals",
    storage: "Storage and sinks",
};

export interface DeviceInfo {
    id: string;
    name: string;
    category: DeviceCategory;
    size: { x: number; y: number; z: number };
    beltIn: number;
    beltOut: number;
    pipes: number;
    cost: { id: string; name: string; count: number }[];
    unlock?: { level: number; via: string; by?: string };
    /** Heat a second while working */
    heat?: number;
    /** Heat a heating device uses itself, and the slots it offers */
    heatSelf?: number;
    slots?: number;
    /** Heater slots the machine takes */
    slotsRequired?: number;
    recipes: { id: string; output: string; outputId: string; time: number }[];
    /** Cauldrons: how many mixes they know */
    mixes?: number;
}

function toInfo(fp: BuildingFootprint): DeviceInfo {
    const device = deviceRows.find((d) => d.id === fp.id);
    const made = recipes.filter((r) => r.crafted_in === fp.id);
    const mixes = fp.id === "cauldron" ? cauldronMixesByOutput("basic") : fp.id === "advanced-cauldron" ? cauldronMixesByOutput("advanced") : null;
    return {
        id: fp.id,
        name: fp.name,
        category: fp.category as DeviceCategory,
        size: fp.size,
        beltIn: fp.ports.filter((p) => p.medium === "belt" && p.dir === "in").length,
        beltOut: fp.ports.filter((p) => p.medium === "belt" && p.dir === "out").length,
        pipes: fp.ports.filter((p) => p.medium === "pipe").length,
        cost: fp.cost.map((c) => ({ id: c.item, name: itemName.get(c.item) ?? c.item, count: c.count })),
        unlock: unlocks[fp.id],
        heat: device?.heat_consuming_speed ?? fp.heatCost,
        heatSelf: device?.heat_self,
        slots: device?.slots,
        slotsRequired: device?.slots_required,
        recipes: made.map((r) => ({ id: r.id, output: r.outputs[0]?.name ?? r.id, outputId: r.outputs[0]?.id ?? "", time: r.time })),
        mixes: mixes ? [...mixes.values()].reduce((n, list) => n + list.length, 0) : undefined,
    };
}

let cache: DeviceInfo[] | null = null;

export function allDevices(): DeviceInfo[] {
    cache ??= footprints
        .filter((f) => (DEVICE_CATEGORIES as readonly string[]).includes(f.category) && !f.hidden)
        .map(toInfo)
        .sort((a, b) => DEVICE_CATEGORIES.indexOf(a.category) - DEVICE_CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name));
    return cache;
}

export function deviceById(id: string): DeviceInfo | undefined {
    return allDevices().find((d) => d.id === id);
}

export function deviceCategories(): DeviceCategory[] {
    return [...DEVICE_CATEGORIES];
}
