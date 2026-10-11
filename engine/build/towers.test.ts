import { describe, expect, test } from "bun:test";
import { analyzeBelts } from "../belt-analysis";
import { calculateProductionLP } from "../lp-planner";
import type { PlannerConfig } from "../types";
import { DEFAULT_MODULE_OPTIONS, generateModule } from "./generator";
import { cellKey, placementCells, validateLayout } from "./layout";
import { stepsFromReport } from "./module-steps";

const cfg = {
    targets: [{ item: "Bandage", rate: 10 }],
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
    selectedFuel: "Coal",
    selfFuel: false,
} as PlannerConfig;

describe("block towers", () => {
    test("Bandage 10/min: stacked blocks take less floor, stay valid and leave no idle supports", () => {
        const report = analyzeBelts(calculateProductionLP(cfg), cfg, { planParallelLines: true, machineRounding: "up" });
        const steps = stepsFromReport(report);
        const options = { ...DEFAULT_MODULE_OPTIONS, beltSpeed: report.beltSpeed, finalProducts: ["Bandage"] };
        const flat = generateModule(steps, { ...options, stackBlocks: false });
        const stacked = generateModule(steps, options);

        expect(stacked.routes.every((r) => r.ok)).toBe(true);
        expect(validateLayout(stacked.placements)).toEqual([]);
        expect(stacked.size[0] * stacked.size[1]).toBeLessThan(flat.size[0] * flat.size[1] * 0.75);
        expect(stacked.size[2]).toBeLessThanOrEqual(16);
        expect(stacked.tiers.some((t) => t.z > 0)).toBe(true);

        // Every support carries something
        const carried = new Set<string>();
        for (const p of stacked.placements) for (const c of placementCells(p)) if (c.foundation) carried.add(cellKey(c.x, c.y, c.z - 1));
        const idle = stacked.placements.filter((p) => (p.id === "wood-block" || p.id === "frame-single") && !carried.has(cellKey(p.x, p.y, p.z)));
        expect(idle).toEqual([]);
    }, 60_000);
});
