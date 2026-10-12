import { describe, expect, test } from "bun:test";
import { calculateProductionLP } from "./lp-planner";
import { analyzeBelts } from "./belt-analysis";
import type { PlannerConfig } from "./types";

describe("fertilizer efficiency", () => {
  // Checked in game: with Fertilizer Efficiency 1 a Growth Potion lasts 3.6 s in a
  // chamomile nursery capped by its belt (165/min): 6480 x 1.1 nutrients / (165 x 720 / 60) per s
  test("raises the nutrients per fertilizer item, not the growth speed", () => {
    const cfg: PlannerConfig = {
      targets: [{ item: "Chamomile", rate: 165 }],
      availableResources: [],
      fuelEfficiency: 0,
      alchemySkill: 0,
      factoryEfficiency: 7,
      logisticsEfficiency: 7,
      throwingEfficiency: 0,
      fertilizerEfficiency: 1,
      salesAbility: 0,
      negotiationSkill: 0,
      customerMgmt: 0,
      relicKnowledge: 0,
      selectedFertilizer: "Growth Potion",
      selfFertilizer: false,
      selectedFuel: "",
      selfFuel: true,
    };
    const report = analyzeBelts(calculateProductionLP(cfg), cfg, { planParallelLines: true, machineRounding: "up" });
    const nursery = Object.values(report.nodes).find((n) => n.itemName === "Chamomile" && n.deviceId)!;
    expect(nursery.machinesBuilt).toBe(1);
    const fertilizer = nursery.perMachineInputs.find((i) => i.itemName === "Growth Potion")!;
    // One potion every 3.6 s
    expect(fertilizer.perMachineRate).toBeCloseTo(60 / 3.6, 1);
  });
});
