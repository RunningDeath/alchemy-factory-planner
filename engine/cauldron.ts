/**
 * The cauldron: any three materials in, one material out. Each material has a cauldron
 * value; the three values are added (times 0.65 when two are the same, 0.5 when all
 * three are), and out comes the material whose cauldron target is nearest that sum.
 * Formula as used by the community calculators (e.g. the Alchemy Codex and
 * Children-of-Sun's cauldron tool); values from the game data (data/items.json).
 *
 * With "use cauldron" the planner swaps a material's production chain for a cauldron
 * recipe when that takes fewer steps: three simple inputs instead of a long chain.
 */
import recipesData from "../data/recipes.json";
import itemsData from "../data/items.json";
import { FLUID_CATEGORIES, FLUID_ITEMS } from "./game-constants";
import type { Item, Recipe } from "./types";

const items = itemsData as unknown as Item[];
const baseRecipes = recipesData as unknown as Recipe[];
const itemById = new Map(items.map((i) => [i.id, i]));

/** Liquids travel in pipes and can't go into the cauldron */
function isFluidItem(id: string): boolean {
    const item = itemById.get(id);
    if (!item) return false;
    if ((FLUID_ITEMS as readonly string[]).includes(id)) return true;
    const categories: string[] = Array.isArray(item.category) ? item.category : [item.category];
    return categories.some((c) => (FLUID_CATEGORIES as readonly string[]).includes(c));
}

/** Time (s) and heat per craft by target value, interpolated between these points */
const TARGETS = [1, 100, 1000, 10000, 1000000];
const TIMES = [3, 6, 12, 24, 60];
const HEATS = [1, 20, 200, 1500, 10000];

function interpolate(target: number, values: number[]): number {
    if (target <= TARGETS[0]) return values[0];
    for (let i = 0; i < TARGETS.length - 1; i++) {
        if (target <= TARGETS[i + 1]) {
            const p = (target - TARGETS[i]) / (TARGETS[i + 1] - TARGETS[i]);
            return Math.round((values[i] + p * (values[i + 1] - values[i])) * 10) / 10;
        }
    }
    return values[values.length - 1];
}

export function cauldronTime(target: number): number {
    return interpolate(target, TIMES);
}

/** Heat one craft uses; the cauldron stands on a heating pad or stove */
export function cauldronHeat(target: number): number {
    return interpolate(target, HEATS);
}

/** Heat per craft of the cauldron making this item */
export function cauldronHeatFor(itemId: string): number {
    const target = itemById.get(itemId)?.cauldron_target;
    return target === undefined ? 0 : cauldronHeat(target);
}

/** Materials the cauldron can make: a target value and a non-zero weight */
const outputs = items
    .filter((i) => i.cauldron_target !== undefined && (i.cauldron_coef ?? 0) > 0 && !isFluidItem(i.id))
    .map((i) => ({ id: i.id, target: i.cauldron_target!, weight: i.cauldron_coef! }))
    .sort((a, b) => a.target - b.target);

/** What the cauldron makes from these three materials */
export function cauldronOutput(ids: [string, string, string]): string | null {
    const values = ids.map((id) => itemById.get(id)?.cauldron_cost);
    if (values.some((v) => v === undefined)) return null;
    const distinct = new Set(ids).size;
    const ratio = distinct === 1 ? 0.5 : distinct === 2 ? 0.65 : 1;
    const sum = values.reduce((s, v) => s! + v!, 0)! * ratio;
    let best: (typeof outputs)[number] | null = null;
    let bestDistance = Infinity;
    for (const o of outputs) {
        const d = Math.abs(sum - o.target) * o.weight;
        if (d < bestDistance - 1e-9) {
            best = o;
            bestDistance = d;
        }
    }
    return best?.id ?? null;
}

function makeSteps(leaf: (id: string) => number) {
    const memo = new Map<string, number>();
    const steps = (id: string, seen = new Set<string>()): number => {
        if (memo.has(id)) return memo.get(id)!;
        if (seen.has(id)) return Infinity;
        const recipes = baseRecipes.filter((r) => r.crafted_in !== "cauldron" && r.outputs.some((o) => (o.id ?? o.name) === id));
        if (recipes.length === 0) {
            memo.set(id, leaf(id));
            return leaf(id);
        }
        seen.add(id);
        let best = Infinity;
        for (const r of recipes) {
            const inputs = [...new Set(r.inputs.map((i) => i.id ?? i.name))];
            best = Math.min(best, 1 + inputs.reduce((sum, i) => sum + steps(i, seen), 0));
        }
        seen.delete(id);
        if (seen.size === 0) memo.set(id, best);
        return best;
    };
    return steps;
}

/**
 * Production steps an item takes when made the usual way: its recipe tree counted in
 * distinct steps (anything without a recipe is bought, like the planner does)
 */
export const productionSteps = makeSteps(() => 0);
/** Steps from what the purchasing portal sells; Infinity when the chain needs something it doesn't */
const stepsFromPortal = makeSteps((id) => (itemById.get(id)?.purchasable ? 0 : Infinity));

export interface CauldronRecipe extends Recipe {
    /** Steps of the cauldron route: the cauldron plus making its inputs */
    steps: number;
    /** Steps the usual route takes */
    usualSteps: number;
    /** Some input comes straight from the purchasing portal */
    buysInputs: boolean;
}

export interface CauldronOptions {
    /** Inputs may be bought at the purchasing portal (seeds, sigils, ores); otherwise they are made in the module */
    buyInputs: boolean;
}

/** Recipe ids of the advanced cauldron start with this */
const ADVANCED_PREFIX = "advcauldron";

/** Materials worth putting in: a cauldron value, not a fluid, and bought or made from bought ones in a step or two */
const MAX_INPUT_STEPS = 2;
const candidates = items
    .filter((i) => (i.cauldron_cost ?? 0) > 0 && !isFluidItem(i.id) && stepsFromPortal(i.id) <= MAX_INPUT_STEPS)
    .map((i) => {
        const steps = stepsFromPortal(i.id);
        // Rough price to rank variants by; the planner works out the real cost
        return { id: i.id, name: i.name, value: i.cauldron_cost!, steps, bought: steps === 0, price: (steps === 0 ? i.cost : i.base_cost) ?? i.cost ?? 0 };
    });
type Candidate = (typeof candidates)[number];

interface Variant {
    picks: Candidate[];
    steps: number;
    distinct: number;
    off: number;
    price: number;
    bought: boolean;
}

/** Every three-input mix, by what it makes */
function allMixes(): Map<string, Variant[]> {
    const byOutput = new Map<string, Variant[]>();
    const n = candidates.length;
    for (let a = 0; a < n; a++)
        for (let b = a; b < n; b++)
            for (let c = b; c < n; c++) {
                const picks = [candidates[a], candidates[b], candidates[c]];
                const out = cauldronOutput([picks[0].id, picks[1].id, picks[2].id]);
                if (!out || picks.some((p) => p.id === out)) continue;
                const distinct = [...new Map(picks.map((p) => [p.id, p])).values()];
                const target = itemById.get(out)!.cauldron_target!;
                const ratio = distinct.length === 1 ? 0.5 : distinct.length === 2 ? 0.65 : 1;
                const variant: Variant = {
                    picks,
                    steps: 1 + distinct.reduce((s, p) => s + p.steps, 0),
                    distinct: distinct.length,
                    off: Math.abs(picks.reduce((s, p) => s + p.value, 0) * ratio - target) / Math.max(1, target),
                    price: picks.reduce((s, p) => s + p.price, 0),
                    bought: picks.some((p) => p.bought),
                };
                const list = byOutput.get(out);
                if (list) list.push(variant);
                else byOutput.set(out, [variant]);
            }
    return byOutput;
}

let mixes: Map<string, Variant[]> | null = null;

function toRecipe(out: string, v: Variant, machine: "cauldron" | "advanced-cauldron" = "cauldron"): CauldronRecipe {
    const item = itemById.get(out)!;
    const counts = new Map<string, { id: string; name: string; count: number }>();
    for (const p of v.picks) counts.set(p.id, { id: p.id, name: p.name, count: (counts.get(p.id)?.count ?? 0) + 1 });
    return {
        id: `${machine === "cauldron" ? "cauldron" : ADVANCED_PREFIX}-${out}-${v.picks.map((p) => p.id).join("+")}`,
        inputs: [...counts.values()],
        outputs: [{ id: out, name: item.name, count: 1 }],
        time: cauldronTime(item.cauldron_target!),
        crafted_in: machine,
        steps: v.steps,
        usualSteps: productionSteps(out),
        buysInputs: v.bought,
    };
}

/** What nurseries grow, and what is made from one of those alone (sage powder, flax fiber): light and quick to make */
export const PLANT_BASED: Set<string> = (() => {
    const grown = new Set(baseRecipes.filter((r) => r.crafted_in === "nursery").flatMap((r) => r.outputs.map((o) => o.id ?? o.name)));
    const fromOne = baseRecipes.filter((r) => r.crafted_in !== "cauldron" && r.inputs.length === 1 && grown.has(r.inputs[0].id ?? r.inputs[0].name)).flatMap((r) => r.outputs.map((o) => o.id ?? o.name));
    return new Set([...grown, ...fromOne]);
})();
const PLANTS = PLANT_BASED;

/** Variants offered per material: the simplest few, the cheapest few and a few with three different inputs; the planner picks */
const PER_KIND = 4;
const bySimplicity = (a: Variant, b: Variant) => a.steps - b.steps || a.distinct - b.distinct || a.price - b.price || a.off - b.off;
const byPrice = (a: Variant, b: Variant) => a.price - b.price || a.steps - b.steps || a.off - b.off;

/**
 * Cauldron recipes for materials where the cauldron takes fewer steps than the usual
 * route: the ones "use cauldron" switches to, a few variants each
 */
export function cauldronRecipesFor(options: CauldronOptions): CauldronRecipe[] {
    mixes ??= allMixes();
    const result: CauldronRecipe[] = [];
    for (const [out, variants] of mixes) {
        const usual = productionSteps(out);
        const allowed = variants.filter((v) => v.steps < usual && (options.buyInputs || !v.bought));
        // Three different plant-based inputs always count (the step count adds sage twice for
        // sage + sage powder, though one nursery feeds both)
        const plantMixes = variants.filter((v) => v.distinct === 3 && v.picks.every((p) => PLANTS.has(p.id)) && (options.buyInputs || !v.bought));
        // Only where the cauldron beats the usual route at all (salt stays rock salt in a crusher)
        if (allowed.length === 0) continue;
        // Also three different inputs, plants first: a slot with an item twice waits for the first
        // one to fill up before the second gets any, which delays the start
        const plantShare = (v: Variant) => v.picks.filter((p) => PLANTS.has(p.id)).length;
        const threeKinds = [...new Set([...plantMixes, ...allowed.filter((v) => v.distinct === 3)])].sort((a, b) => plantShare(b) - plantShare(a) || bySimplicity(a, b));
        const picked = new Set([...[...allowed].sort(bySimplicity).slice(0, PER_KIND), ...[...allowed].sort(byPrice).slice(0, PER_KIND), ...threeKinds.slice(0, PER_KIND)]);
        picked.forEach((v) => result.push(toRecipe(out, v)));
    }
    return result;
}

/**
 * The advanced cauldron (two slots). The same material twice: its cauldron value, and out
 * comes the material with the next higher target (not the input itself). Two different
 * ones: the difference of their values, and out comes the material whose target is nearest
 * it among those below the higher value (not the dearer input). Rules as in the community
 * calculator (starfi5h's AlchemyFactoryCalculator).
 */
export function advancedCauldronOutput(a: string, b: string): string | null {
    const [ca, cb] = [itemById.get(a)?.cauldron_cost, itemById.get(b)?.cauldron_cost];
    if (ca === undefined || cb === undefined || outputs.length === 0) return null;
    if (a === b) {
        let best: string | null = null;
        let bestDistance = Infinity;
        for (const o of outputs) {
            const d = o.target - ca;
            if (d > 1e-7 && d < bestDistance && o.id !== a) {
                best = o.id;
                bestDistance = d;
            }
        }
        return best ?? outputs[outputs.length - 1].id;
    }
    const t = Math.abs(ca - cb);
    const [higher, higherCost] = ca > cb ? [a, ca] : [b, cb];
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const o of outputs) {
        const d = Math.abs(t - o.target);
        if (d < bestDistance && o.target < higherCost && o.id !== higher) {
            best = o.id;
            bestDistance = d;
        }
    }
    return best ?? outputs[0].id;
}

/** Every two-input mix of the advanced cauldron, by what it makes */
function allAdvancedMixes(): Map<string, Variant[]> {
    const byOutput = new Map<string, Variant[]>();
    const n = candidates.length;
    for (let a = 0; a < n; a++)
        for (let b = a; b < n; b++) {
            const picks = [candidates[a], candidates[b]];
            const out = advancedCauldronOutput(picks[0].id, picks[1].id);
            if (!out || picks.some((p) => p.id === out)) continue;
            const distinct = [...new Map(picks.map((p) => [p.id, p])).values()];
            const variant: Variant = {
                picks,
                steps: 1 + distinct.reduce((sum, p) => sum + p.steps, 0),
                distinct: distinct.length,
                off: 0,
                price: picks.reduce((sum, p) => sum + p.price, 0),
                bought: picks.some((p) => p.bought),
            };
            const list = byOutput.get(out);
            if (list) list.push(variant);
            else byOutput.set(out, [variant]);
        }
    return byOutput;
}

let advancedMixes: Map<string, Variant[]> | null = null;

/** Advanced cauldron recipes, picked like the cauldron's (see cauldronRecipesFor) */
export function advancedCauldronRecipesFor(options: CauldronOptions): CauldronRecipe[] {
    advancedMixes ??= allAdvancedMixes();
    const result: CauldronRecipe[] = [];
    for (const [out, variants] of advancedMixes) {
        const usual = productionSteps(out);
        const allowed = variants.filter((v) => v.steps < usual && (options.buyInputs || !v.bought));
        if (allowed.length === 0) continue;
        const plantShare = (v: Variant) => v.picks.filter((p) => PLANTS.has(p.id)).length;
        const twoKinds = allowed.filter((v) => v.distinct === 2).sort((a, b) => plantShare(b) - plantShare(a) || bySimplicity(a, b));
        const picked = new Set([...[...allowed].sort(bySimplicity).slice(0, PER_KIND), ...[...allowed].sort(byPrice).slice(0, PER_KIND), ...twoKinds.slice(0, PER_KIND)]);
        picked.forEach((v) => result.push(toRecipe(out, v, "advanced-cauldron")));
    }
    return result;
}

/** Every mix of either cauldron as a recipe, by what it makes (for the codex) */
export function cauldronMixesByOutput(kind: "basic" | "advanced"): Map<string, CauldronRecipe[]> {
    const source = kind === "basic" ? (mixes ??= allMixes()) : (advancedMixes ??= allAdvancedMixes());
    const machine = kind === "basic" ? "cauldron" : "advanced-cauldron";
    return new Map([...source].map(([out, variants]) => [out, variants.map((v) => toRecipe(out, v, machine))]));
}

let everything: Map<string, CauldronRecipe> | null = null;
/** Any cauldron recipe (either cauldron) the planner may have used, by id */
export function cauldronRecipeById(id: string): CauldronRecipe | undefined {
    if (!id.startsWith("cauldron-") && !id.startsWith(`${ADVANCED_PREFIX}-`)) return undefined;
    everything ??= new Map(
        [true, false].flatMap((buyInputs) => [...cauldronRecipesFor({ buyInputs }), ...advancedCauldronRecipesFor({ buyInputs })]).map((r) => [r.id, r]),
    );
    return everything.get(id);
}
