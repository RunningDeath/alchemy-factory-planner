import { describe, expect, test } from "bun:test";
import { validateLayout, type Placement } from "./layout";
import { addToOccupancy, beamsUnderRuns, preferBlocks, supportColumn, type Occupancy } from "./supports";

let n = 0;
const uid = () => `t${n++}`;

/** A straight belt run at height z along x, carried by support columns */
function raisedRun(length: number, z: number): Placement[] {
  const belts: Placement[] = Array.from({ length }, (_, i) => ({ uid: uid(), id: "belt-fixed", x: i, y: 0, z, rot: 0 }));
  const occupancy: Occupancy = new Map();
  belts.forEach((b) => addToOccupancy(occupancy, b));
  const supports = belts.flatMap((b) => supportColumn(occupancy, b.x, b.y, b.z, 0, uid));
  return [...belts, ...supports];
}

describe("preferBlocks", () => {
  test("a lab stand alone in its cell becomes a wood block; one sharing a belt's cell stays", () => {
    const alone: Placement = { uid: "a", id: "frame-single", x: 0, y: 0, z: 0, rot: 0 };
    const shared: Placement = { uid: "s", id: "frame-single", x: 2, y: 0, z: 0, rot: 0 };
    const belt: Placement = { uid: "b", id: "belt-fixed", x: 2, y: 0, z: 0, rot: 0 };
    const result = preferBlocks([alone, shared, belt]);
    expect(result.find((p) => p.uid === "a")!.id).toBe("wood-block");
    expect(result.find((p) => p.uid === "s")!.id).toBe("frame-single");
  });
});

describe("beamsUnderRuns", () => {
  test("a raised run gets a beam; middle pillars go, the result is still valid", () => {
    const before = preferBlocks(raisedRun(5, 3));
    expect(validateLayout(before)).toEqual([]);
    const after = beamsUnderRuns(before, uid);
    expect(after.some((p) => p.id.startsWith("beam"))).toBe(true);
    expect(after.length).toBeLessThan(before.length);
    expect(validateLayout(after)).toEqual([]);
  });

  test("belts right above the ground keep their single supports", () => {
    const before = preferBlocks(raisedRun(5, 1));
    expect(beamsUnderRuns(before, uid).some((p) => p.id.startsWith("beam"))).toBe(false);
  });
});
