/**
 * Builder score for cauldron mixes: how well a mix builds in a module, 0 to 100. The same
 * things the planner and generator weigh (see lp-planner/model-builder.ts):
 * - plant-based inputs, weighted most: a nursery (and a grinder) is all they need;
 * - a different item in every slot: an item in two slots waits for the first to fill up;
 * - few production steps behind the inputs;
 * - no heated machine behind the inputs (a stove or heating pad more to build and fuel);
 * - light on fertilizer: plants that need few nutrients per item.
 */
import itemsData from "../data/items.json";
import recipesData from "../data/recipes.json";
import devicesData from "../data/devices.json";
import { cauldronHeatFor, cauldronMixesByOutput, PLANT_BASED, productionSteps, type CauldronRecipe } from "./cauldron";
import { recipeNutrients } from "./item-utils";
import type { Item, Recipe } from "./types";

const items = itemsData as unknown as Item[];
const recipes = recipesData as unknown as Recipe[];
const itemById = new Map(items.map((i) => [i.id, i]));
const devices = (Array.isArray(devicesData) ? devicesData : Object.values(devicesData)) as { id: string; heat_consuming_speed?: number }[];
const heated = new Set(devices.filter((d) => d.heat_consuming_speed).map((d) => d.id));

/** Weights of the score parts (plants count most) */
const WEIGHTS = { plants: 3, distinct: 2, simple: 2, unheated: 1, light: 1 };

export interface ScoreParts {
    /** Share of slots with a plant-based input */
    plants: number;
    /** Share of slots with an item no other slot takes */
    distinct: number;
    /** Few production steps behind the inputs */
    simple: number;
    /** No heated machine behind the inputs */
    unheated: number;
    /** Little fertilizer for the plants among the inputs */
    light: number;
}

export interface ScoredMix {
    recipe: CauldronRecipe;
    output: { id: string; name: string };
    inputs: { id: string; name: string; count: number; plant: boolean }[];
    score: number;
    parts: ScoreParts;
    steps: number;
    /** Seconds per craft and heat per craft (from the output's cauldron target) */
    time: number;
    heat: number;
}

/** The usual recipe of an item (the first that makes it, not a cauldron one) */
function usualRecipe(id: string): Recipe | undefined {
    return recipes.find((r) => r.crafted_in !== "cauldron" && r.outputs.some((o) => (o.id ?? o.name) === id));
}

/** Whether making an item takes a heated machine somewhere (two steps deep is enough here) */
function needsHeat(id: string, depth = 2): boolean {
    const r = usualRecipe(id);
    if (!r) return false;
    if (heated.has(r.crafted_in ?? "")) return true;
    return depth > 1 && r.inputs.some((i) => needsHeat(i.id ?? i.name, depth - 1));
}

/**
 * Nutrients per item of a plant-based input: its nursery cycle's nutrients over every output
 * (gentian nectar comes with gentian, and those are hungry), or the plant it is made from
 */
function nutrientsOf(id: string): number {
    const r = usualRecipe(id);
    if (!r) return 0;
    if (r.crafted_in === "nursery") {
        const count = Number(r.outputs.find((o) => (o.id ?? o.name) === id)?.count ?? 1);
        return recipeNutrients(r) / Math.max(1, count);
    }
    const source = r.inputs.length === 1 ? (r.inputs[0].id ?? r.inputs[0].name) : undefined;
    return source ? nutrientsOf(source) : 0;
}

export function scoreMix(recipe: CauldronRecipe): ScoredMix {
    const slots = recipe.inputs.reduce((n, i) => n + (i.count ?? 1), 0);
    const inputs = recipe.inputs.map((i) => ({ id: i.id ?? "", name: i.name, count: i.count ?? 1, plant: PLANT_BASED.has(i.id ?? "") }));
    const plantSlots = inputs.filter((i) => i.plant).reduce((n, i) => n + i.count, 0);
    const chain = inputs.reduce((n, i) => n + productionSteps(i.id), 0);
    const nutrients = inputs.filter((i) => i.plant).reduce((n, i) => n + nutrientsOf(i.id) * i.count, 0) / Math.max(1, slots);
    const parts: ScoreParts = {
        plants: plantSlots / slots,
        distinct: inputs.length / slots,
        simple: 1 / (1 + chain / 2),
        unheated: inputs.some((i) => needsHeat(i.id)) ? 0 : 1,
        light: 1 / (1 + nutrients / 1000),
    };
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    const score = (100 * (Object.keys(WEIGHTS) as (keyof ScoreParts)[]).reduce((sum, k) => sum + WEIGHTS[k] * parts[k], 0)) / total;
    const out = recipe.outputs[0];
    return {
        recipe,
        output: { id: out.id ?? "", name: out.name },
        inputs,
        score: Math.round(score),
        parts,
        steps: recipe.steps,
        time: recipe.time,
        heat: cauldronHeatFor(out.id ?? ""),
    };
}

/** The best mixes per material for a cauldron, best first */
export function rankedMixes(kind: "basic" | "advanced", perOutput = 6): ScoredMix[] {
    const result: ScoredMix[] = [];
    for (const list of cauldronMixesByOutput(kind).values()) {
        const scored = list.map(scoreMix).sort((a, b) => b.score - a.score || a.steps - b.steps);
        result.push(...scored.slice(0, perOutput));
    }
    return result.sort((a, b) => a.output.name.localeCompare(b.output.name) || b.score - a.score);
}
