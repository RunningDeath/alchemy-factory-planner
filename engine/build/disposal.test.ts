import { describe, expect, test } from "bun:test";
import { DEFAULT_MODULE_OPTIONS, generateModule, type ModuleStep } from "./generator";
import { validateLayout } from "./layout";

/** Crushing rock salt: salt is wanted, the sand that comes with it on the same belt isn't */
const crusher: ModuleStep = {
    nodeKey: "salt",
    itemName: "Salt",
    deviceId: "stone-crusher",
    machines: 2,
    inputs: [{ itemName: "Rock Salt", perMachineRate: 10 }],
    outputs: [
        { itemName: "Salt", perMachineRate: 10 },
        { itemName: "Sand", perMachineRate: 10 },
    ],
    fluidInputs: [],
};
const base = { ...DEFAULT_MODULE_OPTIONS, beltSpeed: 165, finalProducts: ["Salt"] };
const sinks = (ids: string[]) => ids.filter((id) => ["knowledge-altar", "junk-barrel", "dispatch-portal"].includes(id));

describe("leftovers", () => {
    test("a byproduct sharing the product's belt ends in a knowledge altar when unlocked; the product leaves", () => {
        const mod = generateModule([crusher], { ...base, unlocks: { level: 10 } });
        expect(mod.io.find((p) => p.itemName === "Sand")?.kind).toBe("altar");
        expect(mod.io.filter((p) => p.kind === "export").map((p) => p.itemName)).toEqual(["Salt"]);
        expect(sinks(mod.placements.map((p) => p.id))).toEqual(["knowledge-altar"]);
        expect(validateLayout(mod.placements)).toEqual([]);
    }, 60_000);

    test("trash barrel when the altar isn't unlocked; nothing when sending out", () => {
        const low = generateModule([crusher], { ...base, unlocks: { level: 10, overrides: { KnowledgeAltar: false } } });
        expect(low.io.find((p) => p.itemName === "Sand")?.kind).toBe("trash");
        expect(validateLayout(low.placements)).toEqual([]);
        const out = generateModule([crusher], { ...base, disposal: "export" });
        expect(sinks(out.placements.map((p) => p.id))).toEqual([]);
    }, 60_000);
});
