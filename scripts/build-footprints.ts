#!/usr/bin/env bun

/**
 * Builds data/building-footprints.json from a DT_Buildings dump made by
 * tools/extract-game-data (see tools/extract-game-data/README.md).
 *
 * Usage: bun run scripts/build-footprints.ts <dt_buildings.json>
 */

import { readFile, writeFile } from 'node:fs/promises';
import { buildingIdFor } from './building-ids';
import type {
  BuildingCategory,
  BuildingFootprint,
  CellOccupation,
  FootprintBox,
  FootprintPort,
  Side,
} from '../engine/build/types';

const OUT_FILE = './data/building-footprints.json';

interface Vec { X: number; Y: number; Z: number }
interface RawGridConfig {
  position: Vec;
  OccupationConfig: string;
  OccupationValue: number;
  IsFoundationGrid: boolean;
  IsOverrideGrid: string;
  IsStackableGrid: boolean;
}
interface RawPortSide { IsInput: boolean; IsOutput: boolean }
interface RawPort {
  InOutType: string;
  IsPipeGrid: boolean;
  position: Vec;
  Left: RawPortSide;
  Right: RawPortSide;
  Up: RawPortSide;
  Bottom: RawPortSide;
  Vertical: { base: boolean; Top: boolean };
}
export interface RawBuilding {
  ID: number;
  DisplayName: { Key: string; SourceString: string };
  FurnitureType: string;
  SecondaryType?: string;
  bHideInGame: boolean;
  HeatCost: number;
  GridConfigList: RawGridConfig[];
  VolumeList: { min: Vec; max: Vec; GridConfig: RawGridConfig }[];
  InOutList: RawPort[];
  CostList: { IngredientName: string; Count: number }[];
  BuildingTags: string[];
  AlterBuildOption: string;
}

const OCCUPATION_LAYERS: Record<string, number> = {
  EMPTY: 0, BOTTOM: 1, MIDDLE: 2, TOP: 4, SIDE: 8,
  BOTTOM_MIDDLE: 3, BOTTOM_TOP: 5, BOTTOM_SIDE: 9, MIDDLE_TOP: 6, MIDDLE_SIDE: 10, TOP_SIDE: 12,
  BOTTOM_MIDDLE_TOP: 7, BOTTOM_MIDDLE_SIDE: 11, BOTTOM_TOP_SIDE: 13, MIDDLE_TOP_SIDE: 14, WHOLE: 15,
};

const OVERLAYS: Record<string, FootprintCell['overlay']> = {
  Belt: 'belt',
  Pipeline: 'pipe',
  Construct: 'construct',
};

const PORT_SIDES: [keyof RawPort & ('Left' | 'Right' | 'Up' | 'Bottom'), Side][] = [
  ['Left', 'left'],
  ['Up', 'up'],
  ['Right', 'right'],
  ['Bottom', 'down'],
];

/** Rows not useful for factory modules: rails, elevators, expandable pieces, launchers, payload actors */
const EXCLUDED_ROWS = /^(Railroad|Track|Elevator|Expandable|Catapult|Cannon|SmartCannon|DrawBridgeR|CrossTunnel|ConveyerLift_Payload|BounceShroom|PhantomTempBag|SpawnTrain)/;

/**
 * The drawbridge conveyor lists both ports on its anchor cell. It carries items across
 * its unsupported deck, so items enter at the anchor and leave at the far end of the deck.
 */
const PORT_OVERRIDES: Record<string, (raw: RawBuilding) => FootprintPort[]> = {
  DrawBridge: () => [
    { x: 0, y: 0, z: 0, face: "down", dir: "in", medium: "belt" },
    { x: 0, y: -3, z: 0, face: "up", dir: "out", medium: "belt" },
  ],
};

export function categoryFor(row: string, raw: RawBuilding): BuildingCategory | null {
  const tags = raw.BuildingTags.join(',');
  if (EXCLUDED_ROWS.test(row)) return null;
  // Takes items in and turns them into knowledge: a sink like the trash barrel
  if (row === 'KnowledgeAltar') return 'storage';
  if (/^Construct_Floor/.test(row)) return 'floor';
  // Shop furniture that recipes craft in
  if (/^(BrewBarrel|GrandPortal)$/.test(row)) return 'production';
  if (tags.includes('Building.Crafting.Heating')) return 'heating';
  if (tags.includes('Building.Crafting.Portal')) return 'portal';
  if (tags.includes('Building.Crafting')) return 'production';
  if (raw.FurnitureType.endsWith('Pipeline')) return 'pipe';
  if (tags.includes('Building.Logistics.Logistics')) return 'logistics';
  if (tags.includes('Building.Logistics.Structure')) return 'structure';
  // Building blocks are the other common support under raised machines and belts
  if (/^(WoodBlock|StoneBlock|BrickBlock|IronBlock|MarbleBlock)$/.test(row)) return 'structure';
  if (tags.includes('Building.Logistics.Storage')) return 'storage';
  return null;
}

function boxFrom(min: Vec, max: Vec, g: RawGridConfig): FootprintBox {
  const occupation: CellOccupation = {
    layers: OCCUPATION_LAYERS[g.OccupationConfig.replace('EGridOccupationConfig::', '')] ?? 15,
    quads: (g.OccupationValue >> 4) & 15,
  };
  if (g.IsFoundationGrid) occupation.foundation = true;
  if (g.IsStackableGrid) occupation.stackable = true;
  const overlay = OVERLAYS[g.IsOverrideGrid.replace('EOverrideGridType::', '')];
  if (overlay) occupation.overlay = overlay;
  return { min: [min.X, min.Y, min.Z], max: [max.X, max.Y, max.Z], ...occupation };
}

function portsFrom(raw: RawPort): FootprintPort[] {
  const base = { x: raw.position.X, y: raw.position.Y, z: raw.position.Z };
  const medium = raw.IsPipeGrid ? 'pipe' : 'belt';
  const ports: FootprintPort[] = [];
  for (const [key, face] of PORT_SIDES) {
    const s = raw[key];
    if (!s.IsInput && !s.IsOutput) continue;
    const dir = s.IsInput && s.IsOutput ? 'both' : s.IsInput ? 'in' : 'out';
    ports.push({ ...base, face, dir, medium });
  }
  // Vertical faces only appear on pipes, which are always two-way
  if (raw.Vertical.Top) ports.push({ ...base, face: 'top', dir: 'both', medium });
  if (raw.Vertical.base) ports.push({ ...base, face: 'base', dir: 'both', medium });
  return ports;
}

export function toFootprint(row: string, raw: RawBuilding, english: Record<string, string>): BuildingFootprint | null {
  const category = categoryFor(row, raw);
  if (!category) return null;

  const boxes = [
    ...raw.VolumeList.map((v) => boxFrom(v.min, v.max, v.GridConfig)),
    ...raw.GridConfigList.map((g) => boxFrom(g.position, g.position, g)),
  ];
  if (boxes.length === 0) return null;

  let ports = PORT_OVERRIDES[row]?.(raw) ?? raw.InOutList.flatMap(portsFrom);

  // Normalize so the bounding box starts at 0,0,0 (a few buildings use negative offsets)
  const offset = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i])));
  if (offset.some((o) => o !== 0)) {
    const shift = (v: [number, number, number]) => v.map((n, i) => n - offset[i]) as [number, number, number];
    boxes.forEach((b) => { b.min = shift(b.min); b.max = shift(b.max); });
    ports = ports.map((p) => ({ ...p, x: p.x - offset[0], y: p.y - offset[1], z: p.z - offset[2] }));
  }
  const max = (i: number) => Math.max(...boxes.map((b) => b.max[i])) + 1;

  const footprint: BuildingFootprint = {
    id: buildingIdFor(row),
    row,
    name: english[raw.DisplayName.Key] ?? row,
    category,
    size: { x: max(0), y: max(1), z: max(2) },
    boxes,
    ports,
    cost: raw.CostList.map((c) => ({ item: c.IngredientName.toLowerCase(), count: c.Count })),
  };
  if (raw.HeatCost) footprint.heatCost = raw.HeatCost;
  if (raw.bHideInGame) footprint.hidden = true;
  if (offset.some((o) => o !== 0)) footprint.origin = offset.map((o) => -o) as [number, number, number];
  const secondary = raw.SecondaryType?.replace('ESecondaryType::', '');
  if (secondary && secondary !== 'None') footprint.secondary = secondary;
  if (raw.AlterBuildOption && raw.AlterBuildOption !== 'None') footprint.alt = buildingIdFor(raw.AlterBuildOption);
  return footprint;
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: bun run scripts/build-footprints.ts <dt_buildings.json>');
    process.exit(1);
  }
  const dump = JSON.parse(await readFile(input, 'utf8')) as {
    buildings: Record<string, RawBuilding>;
    english: Record<string, string>;
  };

  const footprints = Object.entries(dump.buildings)
    .map(([row, raw]) => toFootprint(row, raw, dump.english))
    .filter((f): f is BuildingFootprint => f !== null);

  // Drop alt links to rows that were filtered out
  const ids = new Set(footprints.map((f) => f.id));
  footprints.forEach((f) => { if (f.alt && !ids.has(f.alt)) delete f.alt; });

  await writeFile(OUT_FILE, JSON.stringify(footprints));
  console.log(`Wrote ${footprints.length} building footprints to ${OUT_FILE}`);
}

if (import.meta.main) main();
