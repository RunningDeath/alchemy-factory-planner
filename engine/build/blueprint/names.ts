/**
 * The game's internal names for what a blueprint building is set to: the recipe of a
 * machine, the seed of a nursery, the item of a filter splitter (data/blueprint-names.json).
 */
import namesData from "../../../data/blueprint-names.json";
import itemsData from "../../../data/items.json";
import recipesData from "../../../data/recipes.json";
import type { Item, Recipe } from "../../types";
import type { Placement } from "../layout";
import type { BuildingFootprint } from "../types";
import { cauldronRecipeById } from "../../cauldron";

const names = namesData as { recipes: Record<string, string>; seeds: Record<string, string>; items: Record<string, string>; activeCrafting: string[] };
const recipeById = new Map((recipesData as unknown as Recipe[]).map((r) => [r.id, r]));
const itemIdByName = new Map((itemsData as unknown as Item[]).map((i) => [i.name, i.id]));
/** Machines where the player picks the recipe; mirrored variants count as their base machine */
const activeCrafting = new Set(names.activeCrafting);
const baseMachine = (id: string) => id.replace(/-sym$/, "");

/** Internal name of an item, from its display name or id (unchanged when unknown) */
export function gameItemName(item: string): string {
    const id = itemIdByName.get(item) ?? item;
    return names.items[id] ?? item;
}

/** Recipe of a production node key ("<item>-prod-<recipe>") */
function recipeOf(nodeKey?: string): Recipe | undefined {
    const id = nodeKey?.split("-prod-")[1];
    return id ? recipeById.get(id) : undefined;
}

/**
 * What a machine is set to in game: the recipe for machines where the player picks it
 * (grinders, crucibles and the like pick theirs from the input), the seed for a nursery
 */
export function machineSettings(p: Placement, fp: BuildingFootprint): { recipeName?: string; seedName?: string; cauldronFilters?: string[] } {
    if (fp.category !== "production") return {};
    // A cauldron makes whatever its three inputs add up to: its filters take only the mix's ingredients
    const mix = cauldronRecipeById(p.nodeKey?.split("-prod-")[1] ?? "");
    if (mix) return { cauldronFilters: mix.inputs.flatMap((i) => Array<string>(i.count ?? 1).fill(gameItemName(i.id ?? i.name))) };
    const recipe = recipeOf(p.nodeKey);
    if (!recipe) return {};
    const machine = baseMachine(p.id);
    if (machine === "nursery" || machine === "world-tree-nursery") {
        const product = recipe.outputs[0]?.id;
        return product && names.seeds[product] ? { seedName: names.seeds[product] } : {};
    }
    if (!activeCrafting.has(machine) && !activeCrafting.has(p.id)) return {};
    return names.recipes[recipe.id] ? { recipeName: names.recipes[recipe.id] } : {};
}
