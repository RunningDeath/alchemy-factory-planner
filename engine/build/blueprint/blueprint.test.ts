import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { beltPieceFor } from "../belt-pieces";
import { getFootprint, type Rotation } from "../footprint";
import { DEFAULT_MODULE_OPTIONS, generateModule } from "../generator";
import { placementCells, validateLayout, type Placement } from "../layout";
import { beltActiveIndex, beltOutput, beltPieceForBlueprint, beltRotationFor } from "./belts";
import { bytesEqual, concatBytes } from "./bytes";
import { buildingsOf, decodeBuilding, footprintForRow } from "./decode";
import { readBlueprintTail, writeBlueprintFile } from "./file";
import { baseArea, buildPos, gridArea, pivotFromPlacement, placementFromPivot } from "./grid";
import { blueprintToPlacements, exportBlueprint, placementsToBody, randomBlueprintId, readBlueprint } from "./index";
import { oodleStore, oodleUnstore } from "./oodle";
import { decodeProperties, encodeProperties, getProp, type Property } from "./properties";
import { blueprintTemplate } from "./template";

const FIXTURES = `${import.meta.dir}/fixtures/`;
const SAMPLES = ["leinoel", "monteur"] as const;

const tail = (name: string) => new Uint8Array(readFileSync(`${FIXTURES}${name}.tail.bin`));
const bodyBytes = (name: string) => new Uint8Array(gunzipSync(readFileSync(`${FIXTURES}${name}.body.bin.gz`)));
const body = (name: string) => decodeProperties(bodyBytes(name));

/** Smallest valid PNG: 1×1 transparent pixel */
const PNG_1PX = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
    (c) => c.charCodeAt(0),
);

describe("tagged properties", () => {
    test.each(SAMPLES)("%s: decode → encode reproduces the body byte for byte", (name) => {
        const bytes = bodyBytes(name);
        expect(bytesEqual(encodeProperties(decodeProperties(bytes)), bytes)).toBe(true);
    });

    test("every building has the template's fields in the template's order", () => {
        const names = (b: Property[]) => b.map((p) => `${p.name}#${p.arrayIndex ?? 0}`).join(",");
        const expected = names(blueprintTemplate().building);
        for (const name of SAMPLES) for (const b of buildingsOf(body(name))) expect(names(b)).toBe(expected);
    });
});

describe("file container", () => {
    test.each(SAMPLES)("%s: header, compressed body and trailer round-trip", (name) => {
        const t = tail(name);
        const file = { png: PNG_1PX, ...readBlueprintTail(t) };
        expect(file.uncompressedSize).toBe(bodyBytes(name).length);
        expect(file.compressed[0]).toBe(0x8c); // Oodle block header: Kraken, restart
        expect(file.compressed[1]).toBe(0x06);
        expect(bytesEqual(writeBlueprintFile(file), concatBytes([PNG_1PX, t]))).toBe(true);
    });
});

describe("oodle stored stream", () => {
    test("round-trips across several 256 KiB blocks", () => {
        const data = new Uint8Array(0x40000 * 2 + 1234).map((_, i) => (i * 7) & 255);
        const stream = oodleStore(data);
        expect(stream.length).toBe(data.length + 3 * 2);
        expect([stream[0], stream[1]]).toEqual([0xcc, 0x06]);
        expect(stream[0x40002]).toBe(0xcc);
        expect(bytesEqual(oodleUnstore(stream, data.length), data)).toBe(true);
    });

    test("refuses real compressed blocks", () => {
        expect(() => oodleUnstore(readBlueprintTail(tail("leinoel")).compressed, 100)).toThrow();
    });
});

describe("grid conventions (from the player's blueprints)", () => {
    test.each(SAMPLES)("%s: BaseArea, GridArea and BuildPos follow from footprint, rotation and pivot", (name) => {
        const b = body(name);
        const parentPivot = getProp<number[]>(getProp<Property[]>(b, "ParentGridGroup"), "Pivot");
        for (const raw of buildingsOf(b)) {
            const d = decodeBuilding(raw);
            const fp = footprintForRow(d.row)!;
            expect(fp).toBeDefined();
            expect(d.base).toEqual(baseArea(fp));
            expect(d.area).toEqual(gridArea(d.base, d.rot));
            expect(d.buildPos).toEqual(buildPos(parentPivot, d.pivot, d.area));
        }
    });

    test("beams are positioned by their origin cell at the +y end", () => {
        const beam = getFootprint("beam5")!;
        expect(baseArea(beam)).toEqual([1, 1]);
        // rot 0: the beam runs from the pivot towards -y
        expect(placementFromPivot(beam, 0, [3, 10, 2])).toEqual({ x: 3, y: 6, z: 2 });
        // rot 1 (clockwise): -y turns to +x
        expect(placementFromPivot(beam, 1, [3, 10, 2])).toEqual({ x: 3, y: 10, z: 2 });
        for (const rot of [0, 1, 2, 3] as Rotation[]) {
            const pos = placementFromPivot(beam, rot, [3, 10, 2]);
            expect(pivotFromPlacement(beam, { ...pos, rot })).toEqual([3, 10, 2]);
        }
    });

    test("plain belts point to +x unrotated and record their inputs", () => {
        expect(beltOutput(0)).toBe("right");
        expect(beltOutput(1)).toBe("down");
        expect(beltRotationFor("up")).toBe(3);
        // Straight belt fed from behind, passing on to the next belt: the most common value (20)
        expect(beltActiveIndex("right", ["left"], true)).toBe(20);
        expect(beltPieceForBlueprint(0, 20)).toEqual(beltPieceFor(["left"], ["right"])!);
        // Fed from its right side only (18): a turn
        expect(beltPieceForBlueprint(0, 18)).toEqual(beltPieceFor(["down"], ["right"])!);
    });
});

describe("blueprint → layout", () => {
    test.each(SAMPLES)("%s: decoded layout passes validateLayout", (name) => {
        const { placements, unknown } = blueprintToPlacements(body(name));
        expect(unknown).toEqual([]);
        expect(placements.length).toBeGreaterThan(0);
        expect(validateLayout(placements)).toEqual([]);
    });

    test("conveyor lifts expand to one piece per storey", () => {
        const { placements } = blueprintToPlacements(body("monteur"));
        const lifts = placements.filter((p) => p.id.startsWith("conveyer-lift"));
        expect(lifts.filter((p) => p.id === "conveyer-lift-upwards")).toHaveLength(4);
        expect(lifts.filter((p) => p.id === "conveyer-lift-end-upwards")).toHaveLength(4);
        for (const top of lifts.filter((p) => p.id === "conveyer-lift-end-upwards"))
            expect(lifts.some((p) => p.id === "conveyer-lift-upwards" && p.x === top.x && p.y === top.y && p.z === top.z - 1)).toBe(true);
    });
});

/** Placement identity without uid, for comparing layouts */
const key = (p: Placement) => `${p.id}@${p.x},${p.y},${p.z}r${p.rot}${p.filterItem ? ":" + p.filterItem : ""}`;
const normalize = (ps: Placement[]) => {
    const cells = ps.flatMap(placementCells);
    const min = ["x", "y", "z"].map((k) => Math.min(...cells.map((c) => c[k as "x"])));
    return ps.map((p) => key({ ...p, x: p.x - min[0], y: p.y - min[1], z: p.z - min[2] })).sort();
};

describe("layout → blueprint", () => {
    test.each(SAMPLES)("%s: re-encoding the decoded layout reproduces every building's grid data and dependencies", (name) => {
        const original = buildingsOf(body(name)).map(decodeBuilding);
        const { body: encoded } = placementsToBody(blueprintToPlacements(body(name)).placements);
        const again = buildingsOf(encoded).map(decodeBuilding);
        expect(again).toHaveLength(original.length);

        const at = (d: ReturnType<typeof decodeBuilding>) => `${d.pivot}`;
        const byPivot = new Map(again.map((d) => [at(d) + d.row, d]));
        const keyMapOrig = new Map(original.map((d) => [d.settleKey, at(d) + d.row]));
        const keyMapNew = new Map(again.map((d) => [d.settleKey, at(d) + d.row]));
        for (const o of original) {
            const n = byPivot.get(at(o) + o.row)!;
            expect(n).toBeDefined();
            expect([n.rot, n.base, n.area, n.extension]).toEqual([o.rot, o.base, o.area, o.extension]);
            for (const flag of ["IsDepend", "DependOthers"]) expect(getProp(n.props, flag)).toBe(getProp(o.props, flag));
            expect(n.dependKeys.map((k) => keyMapNew.get(k)).sort()).toEqual(o.dependKeys.map((k) => keyMapOrig.get(k)).sort());
            if (o.row === "Belt") {
                // Input sides and the output-connected bit; higher bits are unknown and not written
                const bai = (d: typeof o) => getProp<number>(getProp<Property[]>(d.props, "building"), "BaseActiveIndex");
                expect(bai(n) & 0x1e).toBe(bai(o) & 0x1e);
            }
        }
    });

    test("a generated module survives export → read → decode", () => {
        const mod = generateModule(
            [
                {
                    nodeKey: "n",
                    itemName: "Healing Potion",
                    deviceId: "assembler",
                    machines: 4,
                    inputs: [
                        { itemName: "Flax Fiber", perMachineRate: 30 },
                        { itemName: "Sage Powder", perMachineRate: 30 },
                    ],
                    outputs: [{ itemName: "Healing Potion", perMachineRate: 10 }],
                    fluidInputs: [],
                },
            ],
            { ...DEFAULT_MODULE_OPTIONS, beltSpeed: 165 },
        );
        expect(validateLayout(mod.placements)).toEqual([]);

        const out = exportBlueprint(mod.placements, { title: "Test module", description: "4 assemblers" }, PNG_1PX);
        expect(out.warnings).toEqual([]);
        const read = readBlueprint(out.bytes);
        expect(read.title).toBe("Test module");
        expect(read.description).toBe("4 assemblers");
        expect(read.unknown).toEqual([]);
        expect(validateLayout(read.placements)).toEqual([]);
        // Belt pieces with one output come back as the same piece; everything else unchanged
        expect(normalize(read.placements)).toEqual(normalize(mod.placements));
    });

    test("titles with umlauts are stored as UTF-16 like the game does", () => {
        const out = exportBlueprint([{ uid: "a", id: "wood-block", x: 0, y: 0, z: 0, rot: 0 }], { title: "450 leinöl" }, PNG_1PX);
        expect(readBlueprint(out.bytes).title).toBe("450 leinöl");
        // Same header bytes as the player's blueprint with that title (sizes differ)
        const theirs = readBlueprintTail(tail("leinoel")).header;
        const ours = readBlueprint(out.bytes).file.header;
        const strip = (h: Property[]) => encodeProperties(h.filter((p) => !p.name.endsWith("Size")));
        expect(bytesEqual(strip(ours), strip(theirs))).toBe(true);
    });

    test("random ids look like the game's", () => {
        expect(randomBlueprintId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });
});
