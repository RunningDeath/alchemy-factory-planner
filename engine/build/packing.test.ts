import { describe, expect, test } from "bun:test";
import { portConnections, validateLayout, type Placement } from "./layout";
import { packBlocks, transformBlock } from "./packing";

describe("packBlocks", () => {
  test("never overlaps and stays within the width limit", () => {
    const items = [
      { width: 12, depth: 6 },
      { width: 5, depth: 9 },
      { width: 7, depth: 4 },
      { width: 3, depth: 3 },
      { width: 10, depth: 2 },
    ];
    const { positions, width } = packBlocks(items, 16);
    expect(width).toBeLessThanOrEqual(16);
    const rects = positions.map((p, i) => ({
      x: p.x,
      y: p.y,
      w: p.rot ? items[i].depth : items[i].width,
      d: p.rot ? items[i].width : items[i].depth,
    }));
    for (let a = 0; a < rects.length; a++)
      for (let b = a + 1; b < rects.length; b++) {
        const A = rects[a], B = rects[b];
        const overlap = A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.d && B.y < A.y + A.d;
        expect(overlap).toBe(false);
      }
  });

  test("two tall blocks go side by side rather than in a long row", () => {
    const { width, depth } = packBlocks([{ width: 2, depth: 8 }, { width: 2, depth: 8 }], 16);
    expect(width * depth).toBe(32);
  });
});

describe("transformBlock", () => {
  test("turning a belted assembler keeps it valid and connected", () => {
    const block: Placement[] = [
      { uid: "a", id: "assembler", x: 1, y: 0, z: 0, rot: 0 },
      { uid: "b", id: "belt-fixed", x: 0, y: 0, z: 0, rot: 0 },
    ];
    const turned = transformBlock(block, 2, 1, 5, 5);
    expect(validateLayout(turned)).toEqual([]);
    const input = portConnections(turned).find((s) => s.port.uid === "a" && s.port.dir === "in" && s.connectedTo);
    expect(input?.connectedTo).toBe("b");
    expect(turned.every((p) => p.x >= 5 && p.y >= 5)).toBe(true);
  });
});
