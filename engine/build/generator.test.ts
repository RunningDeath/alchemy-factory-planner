import { describe, expect, test } from "bun:test";
import { calculateProductionLP } from "../lp-planner";
import { analyzeBelts } from "../belt-analysis";
import { PlannerConfig } from "../types";
import { beltPieceFor } from "./belt-pieces";
import { getFootprint } from "./footprint";
import { DEFAULT_MODULE_OPTIONS, generateModule, machineRotation, moduleTooBig, stackingFor, type GeneratedModule, type ModuleStep } from "./generator";
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

  test("steps sit side by side on the ground; nurseries stack on beam decks; one storey high", () => {
    const mod = generateModule(
      [
        step({ nodeKey: "a", deviceId: "nursery", machines: 8, inputs: [{ itemName: "Growth Potion", perMachineRate: 1 }], outputs: [{ itemName: "Flax", perMachineRate: 165 }] }),
        step({ nodeKey: "b", machines: 3, inputs: [{ itemName: "Flax Fiber", perMachineRate: 30 }], outputs: [{ itemName: "Linen", perMachineRate: 10 }] }),
      ],
      options,
    );
    expect(mod.tiers.every((t) => t.z === 0)).toBe(true);
    expect(mod.size[2]).toBeLessThanOrEqual(16);
    expect(mod.placements.some((p) => p.id.startsWith("construct-floor"))).toBe(false);
    const nurseries = mod.tiers.filter((t) => t.nodeKey === "a");
    expect(nurseries.some((t) => t.stacking === "beam-deck" && t.levels > 1)).toBe(true);
    expect(mod.placements.some((p) => p.id === "metal-stand")).toBe(false);
    expect(mod.placements.some((p) => p.id === "beam5")).toBe(true);
    expect(mod.tiers.every((t) => t.lanes.every((l) => !l.overBelt))).toBe(true);
    expect(validateLayout(mod.placements)).toEqual([]);
    expect(unconnectedMachinePorts(mod)).toEqual([]);
  });

  test("assemblers stack on beam decks, with belts carried on every level", () => {
    const fp = getFootprint("assembler")!;
    expect(stackingFor(fp, machineRotation(fp))).toMatchObject({ kind: "beam-deck", pitch: 4, beamId: "beam5" });
    const mod = generateModule(
      [step({ machines: 12, inputs: [{ itemName: "A", perMachineRate: 20 }], outputs: [{ itemName: "B", perMachineRate: 10 }] })],
      { ...options, maxWidth: 10, maxDepth: 10 },
    );
    expect(mod.tiers.some((t) => t.levels > 1)).toBe(true);
    expect(validateLayout(mod.placements)).toEqual([]);
    expect(unconnectedMachinePorts(mod)).toEqual([]);
  });

  test("too many machines for one block spill into more blocks", () => {
    const mod = generateModule(
      [step({ machines: 40, inputs: [{ itemName: "X", perMachineRate: 5 }], outputs: [{ itemName: "Y", perMachineRate: 5 }] })],
      { ...options, maxWidth: 10, maxDepth: 10, maxStack: 1 },
    );
    expect(mod.tiers.length).toBeGreaterThan(1);
    expect(mod.tiers.reduce((s, t) => s + t.machines, 0)).toBe(40);
    expect(mod.tiers.every((t) => t.width <= 10 && t.depth <= 10)).toBe(true);
    expect(validateLayout(mod.placements)).toEqual([]);
  });
});

describe("stepsFromReport → generateModule", () => {
  test("Bandage 30/min: raw side first, valid layout within one storey", () => {
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
    expect(unconnectedMachinePorts(mod)).toEqual([]);
    expect(mod.size[2]).toBeLessThanOrEqual(16);
    const grinders = mod.placements.filter((p) => p.id === "grinder").length;
    expect(grinders).toBe(steps.filter((s) => s.deviceId === "grinder").reduce((sum, s) => sum + s.machines, 0));
  }, 30_000);
});

describe("separate inputs, filters and heating", () => {
  test("a two-input assembler gets one lane per item; no lane carries both", () => {
    const mod = generateModule(
      [
        step({
          machines: 4,
          inputs: [
            { itemName: "Flax Fiber", perMachineRate: 30 },
            { itemName: "Sage Powder", perMachineRate: 30 },
          ],
          outputs: [{ itemName: "Healing Potion", perMachineRate: 10 }],
        }),
      ],
      options,
    );
    expect(validateLayout(mod.placements)).toEqual([]);
    expect(unconnectedMachinePorts(mod)).toEqual([]);
    const lanes = mod.tiers[0].lanes.filter((l) => l.kind === "in");
    expect(lanes.every((l) => l.items.length === 1)).toBe(true);
    expect(new Set(lanes.map((l) => l.items[0].itemName))).toEqual(new Set(["Flax Fiber", "Sage Powder"]));
    expect(mod.tiers[0].mixedInputs).toBe(false);
    // Every belt carries one item (routed belts included)
    expect(mod.placements.filter((p) => p.id.startsWith("belt")).every((p) => !p.label?.includes("+"))).toBe(true);
  });

  test("an output lane with a byproduct ends in a filter and two single-item belts", () => {
    const mod = generateModule(
      [
        step({
          deviceId: "grinder",
          machines: 2,
          inputs: [{ itemName: "Ore", perMachineRate: 20 }],
          outputs: [
            { itemName: "Dust", perMachineRate: 15 },
            { itemName: "Grit", perMachineRate: 5 },
          ],
        }),
      ],
      options,
    );
    expect(validateLayout(mod.placements)).toEqual([]);
    const filters = mod.placements.filter((p) => p.id === "filter-vert");
    expect(filters.length).toBeGreaterThan(0);
    expect(filters.every((f) => f.filterItem === "Dust")).toBe(true);
    expect(mod.routes.every((r) => r.ok)).toBe(true);
    expect(mod.io.filter((p) => p.kind === "export").map((p) => p.itemName).sort()).toEqual(["Dust", "Grit"]);
  });

  test("stove heating: crucibles stand on stone stoves, fed by a fuel belt", () => {
    const mod = generateModule(
      [
        step({
          deviceId: "crucible",
          machines: 4,
          inputs: [{ itemName: "Stone", perMachineRate: 18 }],
          outputs: [{ itemName: "Quicklime", perMachineRate: 18 }],
          heating: { kind: "stove", fuelItem: "Coal", fuelRate: 4 },
        }),
      ],
      options,
    );
    expect(validateLayout(mod.placements)).toEqual([]);
    expect(mod.placements.some((p) => p.id === "stone-stove")).toBe(true);
    expect(mod.tiers[0].heating?.slotsUsed).toBeLessThanOrEqual(mod.tiers[0].heating!.slotsAvailable);
    expect(mod.io.some((p) => p.kind === "import" && p.itemName === "Coal")).toBe(true);
    expect(mod.routes.every((r) => r.ok)).toBe(true);
  });

  test("steam heating: crucibles stand on steam heaters placed back to back", () => {
    const mod = generateModule(
      [
        step({
          deviceId: "crucible",
          machines: 4,
          inputs: [{ itemName: "Stone", perMachineRate: 18 }],
          outputs: [{ itemName: "Quicklime", perMachineRate: 18 }],
          heating: { kind: "steam", fuelItem: "Steam", fuelRate: 60 },
        }),
      ],
      options,
    );
    expect(validateLayout(mod.placements)).toEqual([]);
    expect(mod.placements.some((p) => p.id === "steam-heater")).toBe(true);
    expect(mod.placements.some((p) => p.id === "stone-stove")).toBe(false);
  });

  test("a heated machine without a heating device under it is flagged", () => {
    const issues = validateLayout([{ uid: "c", id: "crucible", x: 0, y: 0, z: 0, rot: 0 }]);
    expect(issues.map((i) => i.kind)).toContain("unheated");
  });
});

describe("moduleTooBig", () => {
  test("refuses plans with thousands of machines instead of grinding for minutes", () => {
    expect(moduleTooBig([step({ deviceId: "grinder", machines: 5000 })])?.machines).toBe(5000);
    expect(moduleTooBig([step({ machines: 12 })])).toBeNull();
  });
});
