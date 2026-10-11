import { describe, expect, test } from "bun:test";
import itemsData from "../../data/items.json";
import { calculateProductionLP } from "../lp-planner";
import { analyzeBelts } from "../belt-analysis";
import { collectPlanGraph } from "../plan-graph";
import { getItem } from "../item-utils";
import { PlannerConfig } from "../types";
import { DEFAULT_MODULE_OPTIONS, generateModule } from "./generator";
import { stepsFromReport } from "./module-steps";

// The game names six items "Refined Sand" (sand2..sand7). Everything downstream of the
// planner tells items apart by name, so the data gives each tier its own name.
const config = (item: string, rate: number): PlannerConfig => ({
  targets: [{ item, rate }],
  availableResources: [],
  fuelEfficiency: 0,
  alchemySkill: 0,
  factoryEfficiency: 7,
  logisticsEfficiency: 7,
  throwingEfficiency: 0,
  fertilizerEfficiency: 0,
  salesAbility: 0,
  negotiationSkill: 0,
  customerMgmt: 0,
  relicKnowledge: 0,
  selectedFertilizer: "Basic Fertilizer",
  selfFertilizer: false,
  selectedFuel: "Coal",
  selfFuel: false,
});

function plan(item: string, rate: number) {
  const cfg = config(item, rate);
  const trees = calculateProductionLP(cfg);
  return { trees, report: analyzeBelts(trees, cfg, { planParallelLines: true, machineRounding: "up" }) };
}

describe("Refined Sand tiers", () => {
  test("every item has its own name, so lookups by name find the right one", () => {
    const names = (itemsData as { id: string; name: string }[]).map((i) => i.name.toLowerCase());
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    ["sand2", "sand3", "sand4", "sand5", "sand6", "sand7"].forEach((id) => {
      expect(getItem(getItem(id)!.name)?.id).toBe(id);
    });
  });

  test("Shattered Crystal: each refiner stage takes the tier below it, without warnings or shortfalls", () => {
    const { trees, report } = plan("Shattered Crystal", 1);
    const chain = ["sand", "sand2", "sand3", "sand4", "sand5", "sand6", "sand8", "shard1", "shard2", "shard3", "crystal1"];
    const key = (id: string) => `${id}-prod-${id}`;
    chain.slice(1).forEach((id, i) => {
      expect(report.edges[`${key(chain[i])}___${key(id)}`]).toBeDefined();
      expect(report.nodes[key(id)].perMachineInputs.map((f) => f.itemName)).toEqual([report.nodes[key(chain[i])].itemName]);
    });
    // One producer per input: no stage is fed by another tier
    const { edgeRates } = collectPlanGraph(trees);
    chain.forEach((id) => expect([...edgeRates.keys()].filter((e) => e.endsWith(`___${key(id)}`))).toHaveLength(1));

    expect(report.warnings).toEqual([]);
    expect(Object.values(report.edges).filter((e) => e.short)).toEqual([]);
    expect(report.surpluses.filter((s) => s.surplus < 0)).toEqual([]);
    expect(report.targets[0].delivered).toBeGreaterThanOrEqual(1);
    expect(report.lines.filter((l) => l.itemName.startsWith("Refined Sand"))).toHaveLength(5);
  });

  test("build module: belts run from each tier to the next, never between other tiers", () => {
    const { report } = plan("Fully Refined Sand", 5);
    const steps = stepsFromReport(report).filter((s) => s.deviceId === "refiner");
    const mod = generateModule(steps, { ...DEFAULT_MODULE_OPTIONS, beltSpeed: report.beltSpeed, finalProducts: ["Fully Refined Sand"] });
    const stepOf = (block: string) => steps.find((s) => block.startsWith(`${s.itemName} (`));

    const between = mod.routes.filter((r) => stepOf(r.from) && stepOf(r.to));
    expect(between.length).toBeGreaterThan(0);
    between.forEach((r) => {
      expect(stepOf(r.from)!.outputs.map((o) => o.itemName)).toContain(r.itemName);
      expect(stepOf(r.to)!.inputs.map((i) => i.itemName)).toContain(r.itemName);
    });
    expect(mod.routes.every((r) => r.ok)).toBe(true);
    expect(mod.io.filter((p) => p.kind === "import").every((p) => p.itemName === "Sand")).toBe(true);
    expect(mod.io.filter((p) => p.kind === "export").map((p) => p.itemName)).toEqual(["Fully Refined Sand"]);
  }, 30_000);
});
