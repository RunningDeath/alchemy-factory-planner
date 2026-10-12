/**
 * The Paradox Crucible. When idle it takes its whole input slot as one batch and brews one
 * product from it: Oblivion Essence (mors) from anything, Vitality Essence (vitae) from
 * Oblivion Essence. The batch's value is stack size times the input's cauldron value, and
 * the brew takes 1500 / value seconds, at least 0.5 s and at most 1500 s; the two essences
 * as input take a flat 5 s. It burns 1200 heat a second while it brews. Belt input only.
 * (Mechanics as documented by the community, e.g. Gschrooyen's planner fork.)
 */
import itemsData from "../data/items.json";
import { FLUID_CATEGORIES, FLUID_ITEMS } from "./game-constants";
import type { Item } from "./types";

const items = itemsData as unknown as Item[];
const itemById = new Map(items.map((i) => [i.id, i]));

export const PARADOX_HEAT_PER_SECOND = 1200;
export const MORS = "mors";
export const VITAE = "vitae";
const VALUE_TIME = 1500;
const MIN_SECONDS = 0.5;
const MAX_SECONDS = 1500;
const ESSENCE_SECONDS = 5;

function isFluid(item: Item): boolean {
    if ((FLUID_ITEMS as readonly string[]).includes(item.id)) return true;
    const categories: string[] = Array.isArray(item.category) ? item.category : [item.category];
    return categories.some((c) => (FLUID_CATEGORIES as readonly string[]).includes(c));
}

/** What can go in: belt items with a cauldron value */
export function paradoxInputs(): Item[] {
    return items.filter((i) => (i.cauldron_cost ?? 0) > 0 && !isFluid(i)).sort((a, b) => a.name.localeCompare(b.name));
}

export interface ParadoxBrew {
    product: Item;
    /** Seconds for one product */
    seconds: number;
    /** Products a minute, one crucible */
    perMinute: number;
    /** Heat one product takes */
    heatPerProduct: number;
    /** Input items a minute */
    inputPerMinute: number;
}

/** One batch of `stack` items of `inputId` */
export function paradoxBrew(inputId: string, stack: number): ParadoxBrew | null {
    const input = itemById.get(inputId);
    if (!input?.cauldron_cost || stack <= 0) return null;
    const product = itemById.get(inputId === MORS ? VITAE : MORS);
    if (!product) return null;
    const essence = inputId === MORS || inputId === VITAE;
    const value = stack * input.cauldron_cost;
    const seconds = essence ? ESSENCE_SECONDS : Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, VALUE_TIME / value));
    return {
        product,
        seconds,
        perMinute: 60 / seconds,
        heatPerProduct: PARADOX_HEAT_PER_SECOND * seconds,
        inputPerMinute: (60 / seconds) * stack,
    };
}
