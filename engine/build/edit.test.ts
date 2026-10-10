import { describe, expect, test } from "bun:test";
import { footprintPorts, getFootprint } from "./footprint";
import { beltPath, cycleVariant, lPath, placeBuilding, placementsAt } from "./edit";
import type { Placement } from "./layout";

let n = 0;
const uid = () => `u${n++}`;
const at = (id: string, x: number, y: number, z = 0): Placement => ({ uid: uid(), id, x, y, z, rot: 0 });

describe("placeBuilding", () => {
  test("blocks a machine on top of another machine", () => {
    const result = placeBuilding([at("assembler", 0, 0)], at("assembler", 1, 1));
    expect(result.ok).toBe(false);
  });

  test("a belt piece replaces the belt piece under it", () => {
    const first = at("belt-fixed", 0, 0);
    const result = placeBuilding([first], { ...at("belt-fixed", 0, 0), rot: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.placements).toHaveLength(1);
      expect(result.placements[0].rot).toBe(1);
    }
  });

  test("a belt can go into the same cell as a frame", () => {
    expect(placeBuilding([at("frame-single", 0, 0)], at("belt-fixed", 0, 0)).ok).toBe(true);
  });
});

describe("placementsAt", () => {
  test("lists machines before the floor under them", () => {
    const floor = at("construct-floor-wood-8x8", 0, 0, 0);
    const frame = at("frame-single", 1, 1, 0);
    const found = placementsAt([floor, frame], 1, 1, 0);
    expect(found.map((p) => p.id)).toEqual(["frame-single", "construct-floor-wood-8x8"]);
  });
});

describe("beltPath", () => {
  test("an L-shaped path gets straights and one turn, all chained", () => {
    const pieces = beltPath(lPath([0, 0], [2, 2]), 0, uid);
    expect(pieces).toHaveLength(5);
    const facing = pieces.map((p) => {
      const ports = footprintPorts(getFootprint(p.id)!, p.rot);
      return `${ports.find((x) => x.dir === "in")!.face}>${ports.find((x) => x.dir === "out")!.face}`;
    });
    expect(facing).toEqual(["left>right", "left>right", "left>down", "up>down", "up>down"]);
  });
});

describe("cycleVariant", () => {
  test("follows the game's build option chain", () => {
    expect(cycleVariant("assembler")).toBe("assembler-sym");
    expect(cycleVariant("assembler-sym")).toBe("assembler");
  });
});
