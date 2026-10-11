import { describe, expect, test } from "bun:test";
import { calculateProductionLP } from "../lp-planner";
import { analyzeBelts } from "../belt-analysis";
import { PlannerConfig } from "../types";
import { DEFAULT_MODULE_OPTIONS, generateModule, type GeneratedModule, type ModuleStep } from "./generator";
import { portConnections, validateLayout } from "./layout";
import { stepsFromReport } from "./module-steps";
import { assignFlows, findLaneEnds, type LaneEnd } from "./router";

const options = { ...DEFAULT_MODULE_OPTIONS, beltSpeed: 165 };

function step(overrides: Partial<ModuleStep>): ModuleStep {
  return { nodeKey: "n", itemName: "Thing", deviceId: "assembler", machines: 1, inputs: [], outputs: [], fluidInputs: [], ...overrides };
}

/** Belt ports of routed belts and lifts that lead nowhere (import/export cells excepted) */
function danglingRoutePorts(mod: GeneratedModule) {
  const ioCells = new Set(mod.io.map((p) => p.cell.join(",")));
  const routed = new Map(mod.placements.filter((p) => p.uid.startsWith("rb-") || p.uid.startsWith("rl-")).map((p) => [p.uid, p]));
  return portConnections(mod.placements).filter((s) => {
    const p = routed.get(s.port.uid);
    if (!p || s.connectedTo) return false;
    return !ioCells.has(`${s.port.x},${s.port.y},${s.port.z}`);
  });
}

function expectFullyConnected(mod: GeneratedModule) {
  expect(mod.routes.filter((r) => !r.ok)).toEqual([]);
  expect(findLaneEnds(mod.placements)).toEqual([]);
  expect(validateLayout(mod.placements)).toEqual([]);
  expect(danglingRoutePorts(mod)).toEqual([]);
}

describe("assignFlows", () => {
  const end = (uid: string, kind: "in" | "out", rate: number, x: number): LaneEnd => ({
    uid,
    kind,
    items: [{ itemName: "Flax", rate }],
    port: [x, 0, 0],
    dir: "down",
  });

  test("splits producers over consumers without exceeding either", () => {
    const flows = assignFlows([end("p1", "out", 110, 0), end("p2", "out", 55, 5), end("c1", "in", 80, 0), end("c2", "in", 85, 5)]);
    const total = (uid: string) => flows.filter((f) => (f.from !== "import" && f.from.uid === uid) || (f.to !== "export" && f.to.uid === uid)).reduce((s, f) => s + f.rate, 0);
    expect(total("p1")).toBeCloseTo(110, 6);
    expect(total("p2")).toBeCloseTo(55, 6);
    expect(total("c1")).toBeCloseTo(80, 6);
    expect(total("c2")).toBeCloseTo(85, 6);
  });

  test("imports what nobody makes, exports what nobody uses", () => {
    const flows = assignFlows([
      { uid: "c", kind: "in", items: [{ itemName: "Seeds", rate: 5 }], port: [0, 0, 0], dir: "down" },
      { uid: "p", kind: "out", items: [{ itemName: "Bandage", rate: 10 }], port: [3, 0, 0], dir: "down" },
    ]);
    expect(flows.map((f) => [f.itemName, f.from === "import" ? "import" : "block", f.to === "export" ? "export" : "block"])).toEqual([
      ["Seeds", "import", "block"],
      ["Bandage", "block", "export"],
    ]);
  });

  test("rounded-up consumers share what is made instead of importing the difference", () => {
    const flows = assignFlows([end("p", "out", 100, 0), end("c1", "in", 60, 0), end("c2", "in", 60, 5)]);
    expect(flows.some((f) => f.from === "import")).toBe(false);
    expect(flows.reduce((s, f) => s + f.rate, 0)).toBeCloseTo(100, 6);
  });
});

describe("routeModule via generateModule", () => {
  test("two steps: grinders feed assemblers; everything belted end to end", () => {
    const mod = generateModule(
      [
        step({ nodeKey: "g", itemName: "Flax Fiber", deviceId: "grinder", machines: 4, inputs: [{ itemName: "Flax", perMachineRate: 30 }], outputs: [{ itemName: "Flax Fiber", perMachineRate: 30 }] }),
        step({ nodeKey: "a", itemName: "Linen", machines: 2, inputs: [{ itemName: "Flax Fiber", perMachineRate: 60 }], outputs: [{ itemName: "Linen", perMachineRate: 10 }] }),
      ],
      options,
    );
    expectFullyConnected(mod);
    expect(mod.io.map((p) => `${p.kind} ${p.itemName}`).sort()).toEqual(["export Linen", "import Flax"]);
  });

  test("Bandage 30/min: every lane connected, raw inputs imported, Bandage exported", () => {
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
    const mod = generateModule(stepsFromReport(report), { ...options, beltSpeed: report.beltSpeed });
    expectFullyConnected(mod);
    expect(mod.io.some((p) => p.kind === "export" && p.itemName === "Bandage")).toBe(true);
    expect(mod.io.some((p) => p.kind === "import" && p.itemName === "Growth Potion")).toBe(true);
    expect(mod.size[2]).toBeLessThanOrEqual(16);
  }, 30_000);
});

describe("one input belt per item per block", () => {
  test("stacked grinders with a light input get a single entry: levels chained by lifts, columns fed by one header", () => {
    const mod = generateModule(
      [step({ nodeKey: "g", itemName: "Dust", deviceId: "grinder", machines: 12, inputs: [{ itemName: "Ore", perMachineRate: 5 }], outputs: [{ itemName: "Dust", perMachineRate: 5 }] })],
      options,
    );
    expectFullyConnected(mod);
    expect(mod.routes.filter((r) => r.itemName === "Ore")).toHaveLength(1);
    expect(mod.tiers[0].levels).toBeGreaterThan(1);
  });

  test("bridges on: still fully connected and valid", () => {
    const mod = generateModule(
      [
        step({ nodeKey: "g", itemName: "Flax Fiber", deviceId: "grinder", machines: 6, inputs: [{ itemName: "Flax", perMachineRate: 30 }], outputs: [{ itemName: "Flax Fiber", perMachineRate: 30 }] }),
        step({ nodeKey: "a", itemName: "Linen", machines: 3, inputs: [{ itemName: "Flax Fiber", perMachineRate: 60 }], outputs: [{ itemName: "Linen", perMachineRate: 10 }] }),
      ],
      { ...options, useBridges: true },
    );
    expectFullyConnected(mod);
  });
});
