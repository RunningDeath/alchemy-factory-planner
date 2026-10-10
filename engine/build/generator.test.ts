import { describe, expect, test } from "bun:test";
import { calculateProductionLP } from "../lp-planner";
import { analyzeBelts } from "../belt-analysis";
import { PlannerConfig } from "../types";
import { beltPieceFor } from "./belt-pieces";
import { DEFAULT_MODULE_OPTIONS, generateModule, type GeneratedModule, type ModuleStep } from "./generator";
import { portConnections, validateLayout } from "./layout";
import { stepsFromReport } from "./module-steps";

const options = { ...DEFAULT_MODULE_OPTIONS, beltSpeed: 165 };

function step(overrides: Partial<ModuleStep>): ModuleStep {
  return {
    nodeKey: "n",
    itemName: "Thing",
    deviceId: "assembler",
    machines: 1,
    inputs: [],
    outputs: [],
    fluidInputs: [],
    ...overrides,
  };
}

/** Machine ports (not belt pieces) that aren't connected to anything */
function unconnectedMachinePorts(mod: GeneratedModule) {
  const machines = new Set(mod.placements.filter((p) => p.nodeKey && !p.id.startsWith("belt")).map((p) => p.uid));
  return portConnections(mod.placements).filter(
    (s) => machines.has(s.port.uid) && s.port.medium === "belt" && !s.connectedTo,
  );
}

describe("beltPieceFor", () => {
  test("finds straights, turns, splits and merges in any direction", () => {
    expect(beltPieceFor(["up"], ["down"])?.id).toBe("belt-fixed");
    expect(beltPieceFor(["up"], ["right"])).not.toBeNull();
    expect(beltPieceFor(["up"], ["down", "right"])?.id).toMatch(/2-split/);
    expect(beltPieceFor(["up"], ["left", "right", "down"])?.id).toBe("belt-fixed-3-split");
    expect(beltPieceFor(["up", "left", "right"], ["down"])?.id).toBe("belt-fixed-3-merge");
  });
});

describe("generateModule", () => {
  test("6 assemblers: valid layout, every machine port belted, lanes within one belt", () => {
    const mod = generateModule(
      [
        step({
          machines: 6,
          inputs: [
            { itemName: "Flax Fiber", perMachineRate: 30 },
            { itemName: "Sage Powder", perMachineRate: 30 },
          ],
          outputs: [{ itemName: "Healing Potion", perMachineRate: 10 }],
        }),
      ],
      options,
    );
    expect(mod.placements.filter((p) => p.id === "assembler")).toHaveLength(6);
    expect(validateLayout(mod.placements)).toEqual([]);
    expect(unconnectedMachinePorts(mod)).toEqual([]);
    expect(mod.tiers[0].lanes.every((l) => !l.overBelt)).toBe(true);
  });

  test("24 grinders at 55/min stack up on frames and keep every lane at or under 165/min", () => {
    const mod = generateModule(
      [
        step({
          deviceId: "grinder",
          machines: 24,
          inputs: [{ itemName: "Flax", perMachineRate: 55 }],
          outputs: [{ itemName: "Flax Fiber", perMachineRate: 55 }],
        }),
      ],
      options,
    );
    expect(mod.placements.filter((p) => p.id === "grinder")).toHaveLength(24);
    expect(validateLayout(mod.placements)).toEqual([]);
    expect(unconnectedMachinePorts(mod)).toEqual([]);
    const lanes = mod.tiers.flatMap((t) => t.lanes);
    expect(lanes.every((l) => l.rate <= 165 + 1e-9)).toBe(true);
    expect(Math.max(...mod.tiers.map((t) => t.levels))).toBeGreaterThan(1);
    expect(mod.placements.some((p) => p.id === "frame-single")).toBe(true);
  });

  test("steps stack as tiers on wooden floors", () => {
    const mod = generateModule(
      [
        step({ nodeKey: "a", deviceId: "nursery", machines: 4, inputs: [{ itemName: "Growth Potion", perMachineRate: 1 }], outputs: [{ itemName: "Flax", perMachineRate: 165 }] }),
        step({ nodeKey: "b", machines: 3, inputs: [{ itemName: "Flax Fiber", perMachineRate: 30 }], outputs: [{ itemName: "Linen", perMachineRate: 10 }] }),
      ],
      options,
    );
    // Each nursery fills a belt, so it gets its own output lane: 3 fit in 16 cells, the 4th goes up a tier
    expect(mod.tiers.map((t) => t.nodeKey)).toEqual(["a", "a", "b"]);
    expect(mod.tiers.every((t) => t.lanes.every((l) => !l.overBelt))).toBe(true);
    expect(mod.tiers[1].z).toBeGreaterThan(mod.tiers[0].z + mod.tiers[0].height);
    expect(mod.placements.some((p) => p.id === "construct-floor-wood-8x8")).toBe(true);
    expect(validateLayout(mod.placements)).toEqual([]);
    expect(unconnectedMachinePorts(mod)).toEqual([]);
  });

  test("too many machines for one tier spill into more tiers", () => {
    const mod = generateModule(
      [step({ machines: 40, inputs: [{ itemName: "X", perMachineRate: 5 }], outputs: [{ itemName: "Y", perMachineRate: 5 }] })],
      { ...options, maxWidth: 10, maxDepth: 10 },
    );
    expect(mod.tiers.length).toBeGreaterThan(1);
    expect(mod.tiers.reduce((s, t) => s + t.machines, 0)).toBe(40);
    expect(mod.tiers.every((t) => t.width <= 10 && t.depth <= 10)).toBe(true);
    expect(validateLayout(mod.placements)).toEqual([]);
  });
});

describe("stepsFromReport → generateModule", () => {
  test("Bandage 30/min: one tier per step, raw side first, valid layout", () => {
    const cfg: PlannerConfig = {
      targets: [{ item: "Bandage", rate: 30 }],
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
      selectedFertilizer: "Growth Potion",
      selfFertilizer: false,
    };
    const report = analyzeBelts(calculateProductionLP(cfg), cfg, { planParallelLines: true, machineRounding: "up" });
    const steps = stepsFromReport(report);
    const items = steps.map((s) => s.itemName);
    expect(items.indexOf("Flax")).toBeLessThan(items.indexOf("Flax Fiber"));
    expect(items.indexOf("Flax Fiber")).toBeLessThan(items.indexOf("Bandage"));

    const mod = generateModule(steps, { ...options, beltSpeed: report.beltSpeed });
    expect(validateLayout(mod.placements)).toEqual([]);
    const grinders = mod.placements.filter((p) => p.id === "grinder").length;
    expect(grinders).toBe(steps.filter((s) => s.deviceId === "grinder").reduce((sum, s) => sum + s.machines, 0));
  });
});
