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

/** Fuel for a heated step: the incoming edge whose item isn't one of the recipe inputs */
function heatingFor(report: BeltReport, info: NodeBeltInfo): ModuleStep["heating"] {
    if (!info.deviceId || !getFootprint(info.deviceId)?.heatCost) return undefined;
    const recipeInputs = new Set(info.perMachineInputs.map((f) => f.itemName));
    for (const [edge, flow] of Object.entries(report.edges)) {
        const [source, target] = splitEdgeKey(edge);
        if (target !== info.nodeKey) continue;
        const item = report.nodes[source]?.itemName;
        if (!item || recipeInputs.has(item)) continue;
        return { kind: isFluidItem(item) ? "steam" : "stove", fuelItem: item, fuelRate: flow.demand };
    }
    return undefined;
}

const flows = (list: NodeBeltInfo["perMachineInputs"], fluid: boolean) =>
    list.filter((f) => f.isFluid === fluid).map((f) => ({ itemName: f.itemName, perMachineRate: f.perMachineRate }));

export function stepsFromReport(report: BeltReport): ModuleStep[] {
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
            heating: heatingFor(report, info),
        }));
}
