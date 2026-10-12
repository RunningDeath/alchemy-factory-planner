import { describe, expect, test } from "bun:test";
import { analyzeBelts } from "../belt-analysis";
import { calculateProductionLP } from "../lp-planner";
import type { PlannerConfig } from "../types";
import { DEFAULT_MODULE_OPTIONS, generateModule, type GeneratedModule, type ModuleStep } from "./generator";
import { validateLayout } from "./layout";
import { moduleProduct, suggestModuleGroups } from "./module-groups";
import { stepsFromReport } from "./module-steps";

function step(nodeKey: string, inputs: string[], output: string, machines = 1, deviceId = "assembler"): ModuleStep {
    return {
        nodeKey,
        itemName: output,
        deviceId,
        machines,
        inputs: inputs.map((itemName) => ({ itemName, perMachineRate: 10 })),
        outputs: [{ itemName: output, perMachineRate: 10 }],
        fluidInputs: [],
    };
}

function bandageSteps(rate: number) {
    const cfg: PlannerConfig = {
        targets: [{ item: "Bandage", rate }],
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
    return { steps: stepsFromReport(report), beltSpeed: report.beltSpeed, finals: report.targets.map((t) => t.itemName) };
}

/** Each group's blocks (tiers) cover a ground area no other group's blocks reach into */
function groupsContiguous(mod: GeneratedModule, groups: string[][]): boolean {
    const box = (keys: string[]) => {
        const tiers = mod.tiers.filter((t) => keys.includes(t.nodeKey));
        return {
            minX: Math.min(...tiers.map((t) => t.x)),
            maxX: Math.max(...tiers.map((t) => t.x + t.width)),
            minY: Math.min(...tiers.map((t) => t.y)),
            maxY: Math.max(...tiers.map((t) => t.y + t.depth)),
        };
    };
    const boxes = groups.map(box);
    return boxes.every((a, i) => boxes.every((b, j) => i === j || a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY));
}

describe("suggestModuleGroups", () => {
    test("exclusive feeders join the step they feed; a shared step starts its own module", () => {
        const steps = [
            step("ore", [], "Ore"),
            step("dust", ["Ore"], "Dust"),
            step("a", ["Dust"], "A"),
            step("b", ["Dust"], "B"),
            step("final", ["A", "B"], "Final"),
        ];
        const groups = suggestModuleGroups(steps, { finalProducts: ["Final"] });
        // Dust feeds two steps: it and its only feeder (Ore) are one module; A and B only feed Final
        expect(groups).toEqual([
            ["ore", "dust"],
            ["a", "b", "final"],
        ]);
        expect(moduleProduct(steps, groups[1])).toBe("Final");
    });

    test("big modules split at their biggest feeder chain", () => {
        const steps = [
            step("x1", [], "X1"),
            step("x2", ["X1"], "X2"),
            step("y1", [], "Y1", 20),
            step("y2", ["Y1"], "Y2"),
            step("top", ["X2", "Y2"], "Top"),
        ];
        expect(suggestModuleGroups(steps, { maxSteps: 10 })).toHaveLength(1);
        const groups = suggestModuleGroups(steps, { maxSteps: 3 });
        // The Y chain has the most machine floor: it goes first, leaving X and the top together
        expect(groups).toEqual([
            ["y1", "y2"],
            ["x1", "x2", "top"],
        ]);
        // Every step is in exactly one group
        expect(groups.flat().sort()).toEqual(steps.map((s) => s.nodeKey).sort());
        // A chain sending many belts into its module stays in it (y1 alone makes 200/min: 5 belts at 40/min)
        const heavy = [step("y1", [], "Y1", 20), step("top", ["Y1"], "Top")];
        expect(suggestModuleGroups(heavy, { maxSteps: 1, beltSpeed: 40 })).toEqual([["y1", "top"]]);
        expect(suggestModuleGroups(heavy, { maxSteps: 1, beltSpeed: 100 })).toEqual([["y1"], ["top"]]);
    });

    test("Bandage 30/min: every step in one module, the shared flax fiber on its own", () => {
        const { steps, finals, beltSpeed } = bandageSteps(30);
        const groups = suggestModuleGroups(steps, { finalProducts: finals, beltSpeed });
        expect(groups.flat().sort()).toEqual(steps.map((s) => s.nodeKey).sort());
        expect(groups.length).toBeGreaterThan(1);
        const fiber = groups.find((g) => moduleProduct(steps, g) === "Flax Fiber");
        expect(fiber?.map((k) => steps.find((s) => s.nodeKey === k)!.itemName)).toEqual(["Flax", "Flax Fiber"]);
    });
});

describe("generateModule with module groups", () => {
    test("small chain: modules side by side, valid, every belt routed, groups kept together", () => {
        const steps = [
            step("ore", ["Rock"], "Ore", 2, "grinder"),
            step("dust", ["Ore"], "Dust", 2, "grinder"),
            step("a", ["Dust"], "A", 2),
            step("final", ["A", "Dust"], "Final", 1),
        ];
        const groups = [["ore", "dust"], ["a", "final"]];
        const mod = generateModule(steps, { ...DEFAULT_MODULE_OPTIONS, beltSpeed: 165, finalProducts: ["Final"], moduleGroups: groups });
        expect(validateLayout(mod.placements)).toEqual([]);
        expect(mod.routes.filter((r) => !r.ok)).toEqual([]);
        expect(groupsContiguous(mod, groups)).toBe(true);
        expect(new Set(mod.placements.map((p) => p.uid)).size).toBe(mod.placements.length);
        // Rock comes in at the front, the product leaves at the back
        const ys = mod.placements.flatMap((p) => [p.y]);
        expect(mod.io.find((p) => p.kind === "import" && p.itemName === "Rock")?.cell[1]).toBeLessThanOrEqual(Math.min(...ys));
        expect(mod.io.find((p) => p.kind === "export" && p.itemName === "Final")?.cell[1]).toBeGreaterThanOrEqual(Math.max(...ys));
        // Dust is made in the first module only: no second import of it
        expect(mod.io.some((p) => p.kind === "import" && p.itemName === "Dust")).toBe(false);
    }, 60_000);

    test("no groups or unknown keys: the usual single module", () => {
        const steps = [step("a", ["Rock"], "A", 2), step("b", ["A"], "B", 1)];
        const opts = { ...DEFAULT_MODULE_OPTIONS, beltSpeed: 165, finalProducts: ["B"] };
        const plain = generateModule(steps, opts);
        const unknown = generateModule(steps, { ...opts, moduleGroups: [["nope"]] });
        expect(unknown.tiers.map((t) => [t.nodeKey, t.x, t.y])).toEqual(plain.tiers.map((t) => [t.nodeKey, t.x, t.y]));
        expect(unknown.placements.length).toBe(plain.placements.length);
    });

    test("Bandage 30/min with the suggested modules: valid, routed, groups together, in time", () => {
        const { steps, beltSpeed, finals } = bandageSteps(30);
        const groups = suggestModuleGroups(steps, { finalProducts: finals, beltSpeed });
        const started = Date.now();
        const mod = generateModule(steps, { ...DEFAULT_MODULE_OPTIONS, beltSpeed, finalProducts: finals, moduleGroups: groups });
        expect(Date.now() - started).toBeLessThan(60_000);
        expect(validateLayout(mod.placements)).toEqual([]);
        expect(mod.routes.filter((r) => !r.ok)).toEqual([]);
        expect(groupsContiguous(mod, groups)).toBe(true);
        expect(mod.size[2]).toBeLessThanOrEqual(16);
        const grinders = mod.placements.filter((p) => p.id === "grinder").length;
        expect(grinders).toBe(steps.filter((s) => s.deviceId === "grinder").reduce((sum, s) => sum + s.machines, 0));
    }, 120_000);
});
