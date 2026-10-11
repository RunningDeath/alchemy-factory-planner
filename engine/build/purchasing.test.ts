import { describe, expect, test } from "bun:test";
import { DEFAULT_MODULE_OPTIONS, generateModule, type ModuleStep } from "./generator";
import { validateLayout } from "./layout";
import { placementsToBody } from "./blueprint/encode";
import { getProp, type Property, type Value } from "./blueprint/properties";
import { coinFor, purchaseSteps, PURCHASING_PORTAL } from "./purchasing";

const options = { ...DEFAULT_MODULE_OPTIONS, beltSpeed: 60 };

const planks = (machines: number, logs: number): ModuleStep => ({
    nodeKey: "plank",
    itemName: "Plank",
    deviceId: "table-saw",
    machines,
    inputs: [{ itemName: "Logs", perMachineRate: logs }],
    outputs: [{ itemName: "Plank", perMachineRate: logs }],
    fluidInputs: [],
});

describe("purchasing portals", () => {
    test("one portal per bought item; more only past one belt; one coin for all", () => {
        const steps = purchaseSteps([planks(2, 20), { ...planks(1, 10), nodeKey: "x", deviceId: "grinder", itemName: "Gravel", inputs: [{ itemName: "Limestone", perMachineRate: 100 }], outputs: [{ itemName: "Gravel", perMachineRate: 10 }] }], 60);
        expect(steps.map((s) => [s.itemName, s.machines])).toEqual([
            ["Logs", 1],
            ["Limestone", 2],
        ]);
        // 40 logs at 1 copper + 100 limestone at 4 copper: 440 copper a minute, too many copper coins for a 60/min belt
        expect(new Set(steps.map((s) => s.inputs[0].itemName))).toEqual(new Set(["Silver Coin"]));
        expect(coinFor(40, 60).itemName).toBe("Copper Coin");
        // Items nobody sells stay imports
        expect(purchaseSteps([{ ...planks(1, 10), inputs: [{ itemName: "Flax", perMachineRate: 10 }] }], 60)).toEqual([]);
    });

    test("planks from logs: one portal fed by one coin belt from the front, everything routed", () => {
        const mod = generateModule([planks(2, 20)], options);
        const portals = mod.placements.filter((p) => p.id === PURCHASING_PORTAL);
        expect(portals).toHaveLength(1);
        expect(portals[0].supplyItem).toBe("Logs");
        expect(mod.routes.every((r) => r.ok)).toBe(true);
        expect(validateLayout(mod.placements)).toEqual([]);
        const imports = mod.io.filter((p) => p.kind === "import");
        expect(imports.map((p) => p.itemName)).toEqual(["Copper Coin"]);
        expect(imports[0].rate).toBeCloseTo(40);
        // Coins come in at the front edge, like every other input
        const minY = Math.min(...mod.placements.map((p) => p.y));
        expect(imports[0].cell[1]).toBe(minY);

        // The blueprint tells the portal what to buy
        const buildings = getProp<Value[]>(placementsToBody(mod.placements).body, "Buildings") as Property[][];
        const supplies = buildings.map((b) => getProp<string>(b, "SupplyName")).filter((s) => s !== "None");
        expect(supplies).toEqual(["Wood"]);
    }, 60_000);

    test("several portals share the one coin belt", () => {
        const gravel: ModuleStep = { ...planks(2, 20), nodeKey: "g", deviceId: "grinder", itemName: "Gravel", inputs: [{ itemName: "Limestone", perMachineRate: 20 }], outputs: [{ itemName: "Gravel", perMachineRate: 20 }] };
        const mod = generateModule([planks(2, 20), gravel], { ...options, beltSpeed: 300 });
        expect(mod.placements.filter((p) => p.id === PURCHASING_PORTAL)).toHaveLength(2);
        expect(mod.routes.every((r) => r.ok)).toBe(true);
        expect(validateLayout(mod.placements)).toEqual([]);
        expect(mod.io.filter((p) => p.kind === "import").map((p) => p.itemName)).toEqual(["Copper Coin"]);
    }, 60_000);

    test("without the portal unlock (or with the option off) logs come in at the edge", () => {
        for (const opts of [{ ...options, unlocks: { level: 3 } }, { ...options, buyRaw: false }]) {
            const mod = generateModule([planks(2, 20)], opts);
            expect(mod.placements.some((p) => p.id === PURCHASING_PORTAL)).toBe(false);
            expect(mod.io.filter((p) => p.kind === "import").map((p) => p.itemName)).toEqual(["Logs"]);
            expect(mod.routes.every((r) => r.ok)).toBe(true);
            expect(validateLayout(mod.placements)).toEqual([]);
        }
    }, 60_000);
});
