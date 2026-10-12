/**
 * Suggests how to split a plan into modules (see ModuleOptions.moduleGroups).
 *
 * One module per product: the step that makes it plus the steps that exist only to feed
 * it (exclusive feeders: everything they make goes into that one step). A step that feeds
 * several steps, or makes a final product, starts a module of its own. A module with more
 * than `maxSteps` steps or `maxFloor` cells of machines is split at its biggest feeder
 * chain, until it fits or can't be split any more. A chain that sends more than
 * MAX_SPLIT_BELTS belts into its module stays: so many belts between modules don't route well.
 */
import { getFootprint } from "./footprint";
import type { ModuleStep } from "./generator";

export interface SuggestOptions {
    /** Final products of the plan: their steps always start a module */
    finalProducts?: string[];
    /** Most steps per module */
    maxSteps?: number;
    /** Most machine floor per module, in cells (machines × footprint) */
    maxFloor?: number;
    /** Belt speed in items per minute, to count the belts a feeder chain sends; absent: chains split anyway */
    beltSpeed?: number;
}

export const DEFAULT_MAX_STEPS = 4;
export const DEFAULT_MAX_FLOOR = 150;
export const MAX_SPLIT_BELTS = 4;

/** What a step takes in, fuel included (it travels on a belt too) */
function takes(st: ModuleStep): Set<string> {
    const items = new Set(st.inputs.map((i) => i.itemName));
    if (st.heating) items.add(st.heating.fuelItem);
    return items;
}

function floorOf(st: ModuleStep): number {
    const fp = getFootprint(st.deviceId);
    return Math.ceil(st.machines) * (fp ? fp.size.x * fp.size.y : 1);
}

/** Groups of step nodeKeys, in production order (steps are expected in production order too) */
export function suggestModuleGroups(steps: ModuleStep[], options: SuggestOptions = {}): string[][] {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    const maxFloor = options.maxFloor ?? DEFAULT_MAX_FLOOR;
    const finals = new Set(options.finalProducts ?? []);
    const consumers = (st: ModuleStep) => {
        const made = new Set(st.outputs.map((o) => o.itemName));
        return steps.filter((o) => o !== st && [...takes(o)].some((item) => made.has(item)));
    };

    // Consumers first: a step joins its only consumer's module, otherwise starts one
    const parent = new Map<string, string>();
    const roots: ModuleStep[] = [];
    for (const st of [...steps].reverse()) {
        const fed = consumers(st);
        if (fed.length === 1 && !finals.has(st.itemName)) parent.set(st.nodeKey, fed[0].nodeKey);
        else roots.push(st);
    }
    const byKey = new Map(steps.map((st) => [st.nodeKey, st]));
    // A loop of exclusive feeders: the step where it closes starts the module
    for (const st of steps) {
        const path = new Set<string>();
        let key: string | undefined = st.nodeKey;
        while (key && !path.has(key)) {
            path.add(key);
            key = parent.get(key);
        }
        if (key) {
            parent.delete(key);
            roots.push(byKey.get(key)!);
        }
    }
    const rootOf = (key: string): string => {
        while (parent.has(key)) key = parent.get(key)!;
        return key;
    };

    const children = (key: string, members: Set<string>) => [...members].filter((k) => parent.get(k) === key);
    const subtree = (key: string, members: Set<string>): string[] => [key, ...children(key, members).flatMap((c) => subtree(c, members))];
    const floor = (keys: string[]) => keys.reduce((sum, k) => sum + floorOf(byKey.get(k)!), 0);

    // Too big: the root's biggest feeder chain becomes a module of its own
    const groups: string[][] = [];
    const queue = roots.map((r) => steps.filter((st) => rootOf(st.nodeKey) === r.nodeKey).map((st) => st.nodeKey));
    while (queue.length) {
        const group = queue.shift()!;
        const members = new Set(group);
        const root = group.find((k) => !members.has(parent.get(k) ?? ""))!;
        // Belts from the chain into the rest: everything its first step makes
        const belts = (head: string) => {
            const st = byKey.get(head)!;
            return options.beltSpeed ? (Math.ceil(st.machines) * st.outputs.reduce((sum, o) => sum + o.perMachineRate, 0)) / options.beltSpeed : 0;
        };
        const chains = children(root, members).filter((c) => belts(c) <= MAX_SPLIT_BELTS).map((c) => subtree(c, members));
        if ((group.length <= maxSteps && floor(group) <= maxFloor) || chains.length === 0) {
            groups.push(group);
            continue;
        }
        const biggest = chains.reduce((a, b) => (floor(b) > floor(a) ? b : a));
        queue.push(group.filter((k) => !biggest.includes(k)), biggest);
    }
    const order = new Map(steps.map((st, i) => [st.nodeKey, i]));
    return groups
        .map((g) => [...g].sort((a, b) => order.get(a)! - order.get(b)!))
        .sort((a, b) => order.get(a[a.length - 1])! - order.get(b[b.length - 1])!);
}

/** A module's name: the product of its last step (steps in production order) */
export function moduleProduct(steps: ModuleStep[], keys: string[]): string | undefined {
    const members = steps.filter((st) => keys.includes(st.nodeKey));
    return members[members.length - 1]?.itemName;
}
