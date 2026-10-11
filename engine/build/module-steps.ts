/**
 * Turns the planner's belt report into module steps: one per production node with
 * machines, ordered from raw materials to the final products.
 */
import { isFluidItem, type BeltReport, type NodeBeltInfo } from "../belt-analysis";
import { splitEdgeKey } from "../plan-graph";
import { getFootprint } from "./footprint";
import type { ModuleStep } from "./generator";

/** Producers before consumers; cycles are broken in report order */
function productionOrder(report: BeltReport): string[] {
    const keys = Object.keys(report.nodes);
    const inputsOf = new Map<string, string[]>(keys.map((k) => [k, []]));
    Object.keys(report.edges).forEach((edge) => {
        const [source, target] = splitEdgeKey(edge);
        inputsOf.get(target)?.push(source);
    });

    const order: string[] = [];
    const done = new Set<string>();
    const visiting = new Set<string>();
    const visit = (key: string) => {
        if (done.has(key) || visiting.has(key)) return;
        visiting.add(key);
        (inputsOf.get(key) ?? []).forEach(visit);
        visiting.delete(key);
        done.add(key);
        order.push(key);
    };
    keys.forEach(visit);
    return order;
}

function machinesFor(info: NodeBeltInfo): number {
    return info.build?.machines ?? Math.ceil(info.machinesBuilt - 1e-9);
}

const heatingKind = (item: string) => (isFluidItem(item) ? "steam" : "stove");

/**
 * Fuel for a heated step: the incoming edge whose item isn't one of the recipe inputs.
 * When the fuel is also an ingredient (planks for charcoal) both share one edge; the
 * fuel is then what the edge carries beyond the recipe's share.
 */
function heatingFor(report: BeltReport, info: NodeBeltInfo, fuel?: string): ModuleStep["heating"] {
    if (!info.deviceId || !getFootprint(info.deviceId)?.heatCost) return undefined;
    const recipeInputs = new Set(info.perMachineInputs.map((f) => f.itemName));
    const incoming = Object.entries(report.edges)
        .map(([edge, flow]) => ({ source: splitEdgeKey(edge)[0], target: splitEdgeKey(edge)[1], flow }))
        .filter((e) => e.target === info.nodeKey)
        .map((e) => ({ item: report.nodes[e.source]?.itemName, demand: e.flow.demand }));
    const separate = incoming.find((e) => e.item && !recipeInputs.has(e.item));
    if (separate?.item) return { kind: heatingKind(separate.item), fuelItem: separate.item, fuelRate: separate.demand };
    if (!fuel || !recipeInputs.has(fuel)) return undefined;
    // Recipe share: the node's output rate times inputs per output
    const input = info.perMachineInputs.find((f) => f.itemName === fuel)!;
    const output = info.perMachineOutputs.find((f) => f.itemName === info.itemName) ?? info.perMachineOutputs[0];
    const recipeShare = output?.perMachineRate ? (info.demandRate * input.perMachineRate) / output.perMachineRate : 0;
    const demand = incoming.filter((e) => e.item === fuel).reduce((sum, e) => sum + e.demand, 0);
    return { kind: heatingKind(fuel), fuelItem: fuel, fuelRate: Math.max(0, demand - recipeShare) };
}

const flows = (list: NodeBeltInfo["perMachineInputs"], fluid: boolean) =>
    list.filter((f) => f.isFluid === fluid).map((f) => ({ itemName: f.itemName, perMachineRate: f.perMachineRate }));

/** `fuel`: the plan's selected fuel, for heated steps that also use it as an ingredient */
export function stepsFromReport(report: BeltReport, fuel?: string): ModuleStep[] {
    return productionOrder(report)
        .map((key) => report.nodes[key])
        .filter((info) => info.deviceId && getFootprint(info.deviceId) && machinesFor(info) > 0)
        .map((info) => ({
            nodeKey: info.nodeKey,
            itemName: info.itemName,
            deviceId: info.deviceId!,
            machines: machinesFor(info),
            inputs: flows(info.perMachineInputs, false),
            outputs: flows(info.perMachineOutputs, false),
            fluidInputs: info.perMachineInputs.filter((f) => f.isFluid).map((f) => f.itemName),
            fluids: { inputs: flows(info.perMachineInputs, true), outputs: flows(info.perMachineOutputs, true) },
            heating: heatingFor(report, info, fuel),
        }));
}
