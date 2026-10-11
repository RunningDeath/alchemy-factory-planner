import { describe, expect, test } from "bun:test";
import { DEFAULT_MODULE_OPTIONS, generateModule, type ModuleStep } from "./generator";
import { capabilities, isUnlocked, lockedBuildings, unlockOf } from "./unlocks";

const grinders: ModuleStep = {
    nodeKey: "g",
    itemName: "Sand",
    deviceId: "grinder",
    machines: 12,
    inputs: [{ itemName: "Stone", perMachineRate: 10 }],
    outputs: [{ itemName: "Sand", perMachineRate: 10 }],
    fluidInputs: [],
};

describe("unlocks", () => {
    test("game data: lifts at level 3, filters at 5, steam heaters at 6, fixed belts are the plain belt", () => {
        expect(unlockOf("conveyer-lift-upwards")?.level).toBe(3);
        expect(unlockOf("conveyer-lift-body")?.level).toBe(3);
        expect(unlockOf("filter-vert")?.level).toBe(5);
        expect(unlockOf("steam-heater")?.level).toBe(6);
        expect(unlockOf("belt-fixed-2-split-1")).toEqual(unlockOf("belt"));
    });

    test("level and overrides decide; no settings means everything", () => {
        expect(isUnlocked("filter-vert")).toBe(true);
        expect(isUnlocked("filter-vert", { level: 4 })).toBe(false);
        expect(isUnlocked("filter-vert", { level: 5 })).toBe(true);
        expect(isUnlocked("filter-vert", { level: 9, overrides: { Filter_Vert: false } })).toBe(false);
        expect(isUnlocked("filter-sym", { level: 1, overrides: { Filter_Vert: true } })).toBe(true);
        expect(capabilities({ level: 2 })).toMatchObject({ lifts: false, beams: false, filters: false });
        expect(lockedBuildings(["grinder", "filter-vert", "filter"], { level: 2 })).toEqual(["Filter Splitter"]);
    });

    test("without lifts a module stays on the ground and uses nothing locked", () => {
        const unlocks = { level: 2 };
        const mod = generateModule([grinders], { ...DEFAULT_MODULE_OPTIONS, beltSpeed: 165, unlocks });
        expect(mod.placements.filter((p) => p.id === "grinder")).toHaveLength(12);
        expect(mod.placements.every((p) => p.z === 0)).toBe(true);
        expect(mod.locked).toEqual([]);
    });

    test("with lifts grinders stack", () => {
        const mod = generateModule([grinders], { ...DEFAULT_MODULE_OPTIONS, beltSpeed: 165, unlocks: { level: 10 } });
        expect(mod.placements.some((p) => p.id === "grinder" && p.z > 0)).toBe(true);
        expect(mod.locked).toEqual([]);
    });
});
