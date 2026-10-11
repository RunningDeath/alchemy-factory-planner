import { describe, test, expect } from "bun:test";
import { footprintCells, footprintPorts, getFootprint, rotateQuads, rotatedSize } from "./footprint";
import { billOfMaterials, layoutBounds, portConnections, validateLayout, type Placement } from "./layout";

let n = 0;
const place = (id: string, x: number, y: number, z: number, rot: Placement["rot"] = 0): Placement => ({
  uid: `${id}-${n++}`,
  id,
  x,
  y,
  z,
  rot,
});

describe("rotation", () => {
  test("quadrants turn clockwise: NW → NE → SE → SW", () => {
    expect(rotateQuads(1, 1)).toBe(2);
    expect(rotateQuads(8, 1)).toBe(1);
    expect(rotateQuads(14, 2)).toBe(11);
  });

  test("assembler turned once: inputs face up, output faces down, footprint stays inside 2x2", () => {
    const asm = getFootprint("assembler")!;
    const ports = footprintPorts(asm, 1);
    expect(ports.filter((p) => p.dir === "in").every((p) => p.face === "up")).toBe(true);
    expect(ports.find((p) => p.dir === "out")!.face).toBe("down");
    expect(ports.filter((p) => p.dir === "in").every((p) => p.y === 0)).toBe(true);
    const cells = footprintCells(asm, 1);
    expect(Math.max(...cells.map((c) => c.x))).toBe(1);
    expect(Math.max(...cells.map((c) => c.y))).toBe(1);
  });

  test("non-square footprints swap width and depth", () => {
    expect(rotatedSize(getFootprint("table-saw")!, 1)).toEqual({ x: 3, y: 4, z: 3 });
  });
});

describe("validateLayout", () => {
  test("machines side by side are fine, overlapping ones collide", () => {
    expect(validateLayout([place("assembler", 0, 0, 0), place("assembler", 2, 0, 0)])).toEqual([]);
    const issues = validateLayout([place("assembler", 0, 0, 0), place("assembler", 1, 0, 0)]);
    expect(issues.some((i) => i.kind === "collision")).toBe(true);
  });

  test("a belt can't float, but stands on a grinder (stackable) and not on an assembler", () => {
    expect(validateLayout([place("belt-fixed", 0, 0, 1)])).toContainEqual(
      expect.objectContaining({ kind: "unsupported" }),
    );
    expect(validateLayout([place("grinder", 0, 0, 0), place("belt-fixed", 0, 0, 1)])).toEqual([]);
    const onAssembler = validateLayout([place("assembler", 0, 0, 0), place("belt-fixed", 0, 0, 3)]);
    expect(onAssembler.some((i) => i.kind === "unsupported")).toBe(true);
  });

  test("grinders stack directly on each other", () => {
    expect(validateLayout([place("grinder", 0, 0, 0), place("grinder", 0, 0, 1), place("grinder", 0, 0, 2)])).toEqual([]);
  });

  test("a belt shares a cell with a frame (different layers) and the frame carries the belt above", () => {
    const layout = [place("frame-single", 0, 0, 0), place("belt-fixed", 0, 0, 0), place("frame-single", 0, 0, 1), place("belt-fixed", 0, 0, 1)];
    expect(validateLayout(layout)).toEqual([]);
  });

  test("machines carry nothing except grinder-sized ones: no metal stand on a nursery", () => {
    const layout = [place("nursery", 0, 0, 0), place("metal-stand", 0, 0, 1)];
    expect(validateLayout(layout).some((i) => i.kind === "unsupported")).toBe(true);
  });

  test("an assembler may rest partly on a grinder and partly on lab stands (as in player blueprints)", () => {
    const layout = [
      place("grinder", 0, 0, 0),
      place("frame-single", 1, 0, 0),
      place("frame-single", 0, 1, 0),
      place("frame-single", 1, 1, 0),
      place("assembler", 0, 0, 1),
    ];
    expect(validateLayout(layout)).toEqual([]);
  });

  test("anything on a wooden floor is supported", () => {
    expect(validateLayout([place("construct-floor-wood-8x8", 0, 0, 3), place("assembler", 2, 2, 4)])).toEqual([]);
  });
});

describe("portConnections", () => {
  test("a belt pointing into an assembler input connects; one pointing away doesn't", () => {
    const asm = place("assembler", 1, 0, 0);
    const feeding = place("belt-fixed", 0, 0, 0); // left → right, into the input at (1,0)
    const away = place("belt-fixed", 0, 1, 0, 2); // right → left, away from the input at (1,1)
    const status = portConnections([asm, feeding, away]);
    const inputs = status.filter((s) => s.port.uid === asm.uid && s.port.dir === "in");
    expect(inputs.find((s) => s.port.y === 0)!.connectedTo).toBe(feeding.uid);
    expect(inputs.find((s) => s.port.y === 1)!.connectedTo).toBeUndefined();
  });
});

describe("summary helpers", () => {
  test("bounds and bill of materials", () => {
    const layout = [place("assembler", 0, 0, 0), place("assembler", 2, 0, 0)];
    expect(layoutBounds(layout)!.size).toEqual([4, 2, 3]);
    expect(billOfMaterials(layout).get("woodgear")).toBe(30);
  });
});
