/**
 * Follows items through a layout like the game moves them: out of portals and machines,
 * along belts, lifts, splitters and filters, into machine inputs. Finds what a layout
 * gets wrong in game: machines missing an ingredient, machines fed something they can't
 * use (it clogs them), output ports with nothing to take their items, blocked pipe ports.
 */
import itemsData from "../../data/items.json";
import recipesData from "../../data/recipes.json";
import { isFluidItem } from "../belt-analysis";
import { cauldronOutput, cauldronRecipeById } from "../cauldron";
import type { Item, Recipe } from "../types";
import { getFootprint } from "./footprint";
import { buildOccupancy, placementPorts, portConnections, portTarget, type Placement, type WorldPort } from "./layout";

/** Item names compared loosely: display names, ids and the game's internal names all match */
export const itemKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

const items = itemsData as unknown as Item[];
const recipes = recipesData as unknown as Recipe[];
const itemName = new Map(items.flatMap((i) => [[itemKey(i.id), i.name], [itemKey(i.name), i.name]]));
const nameOf = (key: string) => itemName.get(key) ?? key;
const isFluid = (name: string) => isFluidItem(items.find((i) => itemKey(i.name) === itemKey(name))?.id ?? "");

/** What a machine takes and makes */
export interface MachineRecipe {
    inputs: string[];
    outputs: string[];
}

export interface MachineReport {
    uid: string;
    id: string;
    at: [number, number, number];
    recipe?: MachineRecipe;
    received: string[];
    missing: string[];
    /** Items arriving that the machine can't use: they block its input */
    foreign: string[];
    /** Belt output ports with nothing taking from them */
    blockedOutputs: number;
    /** Pipe ports whose cell in front is taken by something that isn't a pipe */
    blockedPipes: number;
}

export interface FlowReport {
    machines: MachineReport[];
    /** Belt pieces whose items spill at an open end (an export or a mistake) */
    openEnds: { uid: string; at: [number, number, number]; items: string[] }[];
}

const isMachine = (p: Placement) => {
    const category = getFootprint(p.id)?.category;
    return category === "production" || category === "portal";
};
const LIFT_IN = new Set(["conveyer-lift-upwards", "conveyer-lift-end-downwards"]);
const LIFT_OUT = new Set(["conveyer-lift-end-upwards", "conveyer-lift-downwards"]);
const PASS_THROUGH = new Set(["splitter-vert", "splitter-sym", "merger-vert", "merger-sym"]);
const FERTILIZERS = new Set(items.filter((i) => (i as Item & { fertilizer_value?: number }).fertilizer_value || /fertilizer|growth potion/i.test(i.name)).map((i) => itemKey(i.name)));

/** Recipe of a machine from what it is set to, or (machines that pick by input) from what reaches it */
export type RecipeOf = (p: Placement, received: Set<string>) => MachineRecipe | undefined;

/** Recipes for generated layouts: from each machine's plan node */
export function recipeFromNode(p: Placement, received: Set<string>): MachineRecipe | undefined {
    if (p.supplyItem) return { inputs: [], outputs: [nameOf(itemKey(p.supplyItem))] };
    const id = p.nodeKey?.split("-prod-")[1];
    const r = id ? cauldronRecipeById(id) ?? recipes.find((x) => x.id === id) : undefined;
    if (r) return withFertilizer(p, { inputs: r.inputs.map((i) => i.name), outputs: r.outputs.map((o) => o.name) }, received);
    return recipeByInput(p, received);
}

/** Nurseries take fertilizer too (any kind), not listed in their recipe */
function withFertilizer(p: Placement, r: MachineRecipe, received: Set<string>): MachineRecipe {
    if (!p.id.includes("nursery")) return r;
    const fertilizer = [...received].find((k) => FERTILIZERS.has(k));
    // Seeds are planted by hand once; the nursery keeps itself going
    return { inputs: fertilizer ? [nameOf(fertilizer)] : ["(fertilizer)"], outputs: r.outputs };
}

/** A recipe of this machine whose inputs all arrive */
export function recipeByInput(p: Placement, received: Set<string>): MachineRecipe | undefined {
    const device = p.id.replace(/-sym$/, "");
    const r = recipes.find((x) => x.crafted_in === device && x.inputs.length > 0 && x.inputs.every((i) => received.has(itemKey(i.name))));
    return r && { inputs: r.inputs.map((i) => i.name), outputs: r.outputs.map((o) => o.name) };
}

/** A cauldron makes what its three filtered inputs add up to */
export function cauldronRecipe(filters: string[]): MachineRecipe | undefined {
    const ids = filters.map((f) => items.find((i) => itemKey(i.id) === itemKey(f) || itemKey(i.name) === itemKey(f))?.id);
    if (ids.length !== 3 || ids.some((i) => !i)) return undefined;
    const out = cauldronOutput(ids as [string, string, string]);
    return out ? { inputs: [...new Set(ids.map((i) => nameOf(itemKey(i!))))], outputs: [nameOf(itemKey(out))] } : undefined;
}

/** `inject`: items arriving from outside, by cell ("x,y,z" of the piece they enter) */
export function simulateFlow(placements: Placement[], recipeOf: RecipeOf = recipeFromNode, inject: Map<string, string[]> = new Map()): FlowReport {
    const byUid = new Map(placements.map((p) => [p.uid, p]));
    const ports = new Map<string, WorldPort[]>();
    for (const p of placements) ports.set(p.uid, placementPorts(p));
    const links = portConnections(placements);
    // A lift's items come out at its other end
    const liftSource = new Map<string, string>();
    const byCell = new Map(placements.map((p) => [`${p.x},${p.y},${p.z}`, p]));
    for (const p of placements.filter((q) => LIFT_OUT.has(q.id))) {
        const up = p.id === "conveyer-lift-end-upwards";
        for (let z = p.z + (up ? -1 : 1); z >= 0 && z < 64; z += up ? -1 : 1) {
            const q = byCell.get(`${p.x},${p.y},${z}`);
            if (!q || !q.id.startsWith("conveyer-lift")) break;
            if (LIFT_IN.has(q.id)) {
                liftSource.set(p.uid, q.uid);
                break;
            }
        }
    }

    const received = new Map<string, Set<string>>(placements.map((p) => [p.uid, new Set<string>()]));
    for (const [cell, list] of inject) {
        const p = byCell.get(cell);
        if (p) list.forEach((i) => received.get(p.uid)!.add(itemKey(i)));
    }
    const recipeCache = new Map<string, MachineRecipe | undefined>();
    const outItems = (p: Placement, port: WorldPort, index: number): Set<string> => {
        if (isMachine(p)) {
            const r = recipeOf(p, received.get(p.uid)!);
            recipeCache.set(p.uid, r);
            // Every machine runs (a starter box primes loops like self-made fertilizer, fluids come by
            // pipe): what matters here is whether the belts take each product where it is needed
            return new Set(r ? r.outputs.map(itemKey) : []);
        }
        const source = received.get(liftSource.get(p.uid) ?? p.uid)!;
        if (p.id.startsWith("filter") && p.filterItem) {
            const outs = ports.get(p.uid)!.filter((q) => q.dir === "out");
            // Tall filter: the lower output; flat filter: the side output
            const filteredPort = p.id === "filter-vert" ? outs[0] : outs[1];
            const key = itemKey(p.filterItem);
            return new Set([...source].filter((k) => (port === filteredPort ? k === key : k !== key)));
        }
        void index;
        return source;
    };

    for (let round = 0; round < 500; round++) {
        let changed = false;
        for (const link of links) {
            if (!link.connectedTo || link.port.dir === "in") continue;
            const from = byUid.get(link.port.uid)!;
            const to = byUid.get(link.connectedTo)!;
            const portList = ports.get(from.uid)!;
            const port = portList.find((q) => q.x === link.port.x && q.y === link.port.y && q.z === link.port.z && q.face === link.port.face && q.dir === link.port.dir)!;
            const into = received.get(to.uid)!;
            for (const k of outItems(from, port, portList.indexOf(port)))
                if (!into.has(k)) {
                    into.add(k);
                    changed = true;
                }
        }
        if (!changed) break;
    }

    const occupancy = buildOccupancy(placements);
    const machines: MachineReport[] = placements.filter(isMachine).map((p) => {
        const got = received.get(p.uid)!;
        const r = recipeOf(p, got);
        const wanted = new Set((r?.inputs ?? []).map(itemKey));
        const own = links.filter((l) => l.port.uid === p.uid);
        const blockedPipes = own.filter((l) => {
            if (l.port.medium !== "pipe" || l.connectedTo) return false;
            const [x, y, z] = portTarget(l.port);
            return (occupancy.get(`${x},${y},${z}`) ?? []).some((o) => !o.id.startsWith("pipe"));
        }).length;
        return {
            uid: p.uid,
            id: p.id,
            at: [p.x, p.y, p.z],
            recipe: r,
            received: [...got].map(nameOf),
            missing: (r?.inputs ?? []).filter((i) => (i !== "(fertilizer)" ? !got.has(itemKey(i)) && !isFluid(i) : true)),
            foreign: [...got].filter((k) => !wanted.has(k) && !(p.id.includes("nursery") && FERTILIZERS.has(k)) && !(p.id === "purchasing-portal" && k === "coppercoin")).map(nameOf),
            blockedOutputs: own.filter((l) => l.port.medium === "belt" && l.port.dir === "out" && !l.connectedTo).length,
            blockedPipes,
        };
    });
    const openEnds = links
        .filter((l) => l.port.medium === "belt" && l.port.dir === "out" && !l.connectedTo && !isMachine(byUid.get(l.port.uid)!))
        .map((l) => {
            const p = byUid.get(l.port.uid)!;
            const port = ports.get(p.uid)!.find((q) => q.x === l.port.x && q.y === l.port.y && q.z === l.port.z && q.face === l.port.face)!;
            return { uid: p.uid, at: [p.x, p.y, p.z] as [number, number, number], items: [...outItems(p, port, 0)].map(nameOf) };
        });
    return { machines, openEnds };
}
