/**
 * Turns the planner's belt report into module steps: one per production node with
 * machines, ordered from raw materials to the final products.
 */
import type { BeltReport, NodeBeltInfo } from "../belt-analysis";
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

export function stepsFromReport(report: BeltReport): ModuleStep[] {
    return productionOrder(report)
        .map((key) => report.nodes[key])
        .filter((info) => info.deviceId && getFootprint(info.deviceId) && machinesFor(info) > 0)
        .map((info) => ({
            nodeKey: info.nodeKey,
            itemName: info.itemName,
            deviceId: info.deviceId!,
            machines: machinesFor(info),
            inputs: info.perMachineInputs
                .filter((f) => !f.isFluid)
                .map((f) => ({ itemName: f.itemName, perMachineRate: f.perMachineRate })),
            outputs: info.perMachineOutputs
                .filter((f) => !f.isFluid)
                .map((f) => ({ itemName: f.itemName, perMachineRate: f.perMachineRate })),
            fluidInputs: info.perMachineInputs.filter((f) => f.isFluid).map((f) => f.itemName),
        }));
}
