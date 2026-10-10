import { describe, test, expect } from "bun:test";
import footprints from "../data/building-footprints.json";
import devices from "../data/devices.json";
import { categoryFor, toFootprint, type RawBuilding } from "./build-footprints";
import type { BuildingFootprint } from "../engine/build/types";

const all = footprints as BuildingFootprint[];
const byId = (id: string) => all.find((f) => f.id === id)!;

function raw(overrides: Partial<RawBuilding>): RawBuilding {
  return {
    ID: 1,
    DisplayName: { Key: "Building_Name_Test", SourceString: "测试" },
    FurnitureType: "EFurnitureType::CanInteract",
    bHideInGame: false,
    HeatCost: 0,
    GridConfigList: [],
    VolumeList: [],
    InOutList: [],
    CostList: [],
    BuildingTags: ["Building.Crafting.ActiveCrafting"],
    AlterBuildOption: "None",
    ...overrides,
  };
}

const grid = (x: number, y: number, z: number, config = "WHOLE", value = 240) => ({
  position: { X: x, Y: y, Z: z },
  OccupationConfig: `EGridOccupationConfig::${config}`,
  OccupationValue: value,
  IsFoundationGrid: z === 0,
  IsOverrideGrid: "EOverrideGridType::NoOverride",
  IsStackableGrid: false,
});

describe("toFootprint", () => {
  test("maps occupation bits, normalizes negative offsets and uses the English name", () => {
    const fp = toFootprint(
      "TestMachine",
      raw({
        GridConfigList: [grid(-1, 0, 0), grid(0, 0, 1, "BOTTOM_MIDDLE", 96)],
        CostList: [{ IngredientName: "WoodBoard", Count: 3 }],
      }),
      { Building_Name_Test: "Test Machine" },
    )!;
    expect(fp.id).toBe("test-machine");
    expect(fp.name).toBe("Test Machine");
    expect(fp.size).toEqual({ x: 2, y: 1, z: 2 });
    expect(fp.boxes[0]).toMatchObject({ min: [0, 0, 0], layers: 15, quads: 15, foundation: true });
    expect(fp.boxes[1]).toMatchObject({ min: [1, 0, 1], layers: 3, quads: 6 });
    expect(fp.cost).toEqual([{ item: "woodboard", count: 3 }]);
  });

  test("skips decor and rails", () => {
    expect(categoryFor("FlowerVase1", raw({ BuildingTags: ["Building.Decoration.Others"] }))).toBeNull();
    expect(categoryFor("RailroadTurn", raw({ BuildingTags: ["Building.Logistics.Track"] }))).toBeNull();
  });
});

describe("building-footprints.json", () => {
  test("every production device used by recipes has a footprint", () => {
    const missing = devices
      .filter((d) => d.category === "production" || d.category === "raw material production")
      .map((d) => d.id)
      .filter((id) => !all.some((f) => f.id === id));
    expect(missing).toEqual([]);
  });

  test("assembler: 2x2, two inputs on the left, output on the right, top layer only partly used", () => {
    const asm = byId("assembler");
    expect(asm.size).toEqual({ x: 2, y: 2, z: 3 });
    expect(asm.ports.filter((p) => p.dir === "in").map((p) => [p.x, p.y, p.face])).toEqual([
      [0, 0, "left"],
      [0, 1, "left"],
    ]);
    expect(asm.ports.find((p) => p.dir === "out")).toMatchObject({ x: 1, y: 0, face: "right" });
    expect(asm.boxes.find((b) => b.min[2] === 2)?.layers).toBe(3); // bottom + middle
  });

  test("metal stand legs fit the nursery's cut corners", () => {
    const nursery = byId("nursery");
    const stand = byId("metal-stand");
    const corner = nursery.boxes.find((b) => b.min[0] === 0 && b.min[1] === 0 && b.min[2] === 1)!;
    const leg = stand.boxes.find((b) => b.min[0] === 0 && b.min[1] === 0 && b.min[2] === 0)!;
    expect(corner.quads & leg.quads).toBe(0);
  });
});
