#!/usr/bin/env bun

/**
 * Builds data/building-unlocks.json: when each building becomes available in game.
 * Reads the dump made by tools/extract-game-data (research tree, workbench and quests).
 *
 * Buildings come from three places:
 * - research (DT_SkillPoints): a skill node; its level is the highest LevelN node on its predecessor path
 * - workbench (DT_Workbench): unlocked by a skill or by another building
 * - quests (DT_Quests): awarded by a quest; MainN quests raise the level to N+1
 * Hidden rotation variants (AlterBuildOption cycles) share the unlock of the visible one.
 *
 * Usage: bun run scripts/build-unlocks.ts <dt_buildings.json>
 */

import { readFile, writeFile } from 'node:fs/promises';
import { buildingIdFor } from './building-ids';
import type { BuildingUnlock } from '../engine/build/types';

const OUT_FILE = './data/building-unlocks.json';
const FOOTPRINTS = './data/building-footprints.json';

interface SkillRow {
  Predecessors: string[];
  UnlockItem: { ConfigName: string; ConfigType: string };
  ExtraUnlockConstructions: string[];
}
interface WorkbenchRow {
  UnlockSkillName: string;
  UnlockBuilding: string;
  PrerequisiteBuilding: string;
  ExtraUnlockBuildings: string[];
}
interface QuestRow {
  Conditions: { RequireQuests: string[] };
  Awards: { Buildings: string[]; LevelUp: boolean };
  IsMain: boolean;
}
interface BuildingRow {
  bHideInGame: boolean;
  AlterBuildOption: string;
}
interface Dump {
  buildings: Record<string, BuildingRow>;
  skillPoints: Record<string, SkillRow>;
  workbench: Record<string, WorkbenchRow>;
  quests: Record<string, QuestRow>;
}

const LEVEL_SKILL = /^Level(\d+)$/;
const MAIN_QUEST = /^Main(\d+)$/;

function memo<T>(fn: (key: string, self: (k: string) => T) => T, fallback: T): (key: string) => T {
  const cache = new Map<string, T>();
  const visiting = new Set<string>();
  const self = (key: string): T => {
    if (cache.has(key)) return cache.get(key)!;
    if (visiting.has(key)) return fallback;
    visiting.add(key);
    const value = fn(key, self);
    visiting.delete(key);
    cache.set(key, value);
    return value;
  };
  return self;
}

export function buildUnlocks(dump: Dump, ids: string[]): Record<string, BuildingUnlock> {
  const skillLevel = memo<number>((name, self) => {
    const row = dump.skillPoints[name];
    if (!row) return 1;
    const own = Number(LEVEL_SKILL.exec(name)?.[1] ?? 1);
    return Math.max(own, ...row.Predecessors.map(self));
  }, 1);
  const questLevel = memo<number>((name, self) => {
    const row = dump.quests[name];
    if (!row) return 1;
    // Finishing MainN brings level N+1, so quests after it need that level
    const after = (q: string) => (MAIN_QUEST.test(q) && dump.quests[q]?.Awards.LevelUp ? Number(MAIN_QUEST.exec(q)![1]) + 1 : self(q));
    return Math.max(1, ...row.Conditions.RequireQuests.map(after));
  }, 1);

  // Direct sources per building row; the lowest level wins
  const direct = new Map<string, BuildingUnlock>();
  const offer = (row: string, unlock: BuildingUnlock) => {
    const prev = direct.get(row);
    if (!prev || unlock.level < prev.level) direct.set(row, unlock);
  };
  for (const [name, row] of Object.entries(dump.skillPoints)) {
    if (row.UnlockItem.ConfigType.endsWith('::ConstructOptions')) offer(row.UnlockItem.ConfigName, { level: skillLevel(name), via: 'research', by: name });
    for (const extra of row.ExtraUnlockConstructions) offer(extra, { level: skillLevel(name), via: 'research', by: name });
  }
  const workbenchLevel = memo<number>((building, self) => {
    const row = Object.values(dump.workbench).find((r) => r.UnlockBuilding === building || r.ExtraUnlockBuildings.includes(building));
    if (!row) return direct.get(building)?.level ?? 1;
    const bySkill = row.UnlockSkillName !== 'None' ? skillLevel(row.UnlockSkillName) : 1;
    const byBuilding = row.PrerequisiteBuilding !== 'None' ? self(row.PrerequisiteBuilding) : 1;
    return Math.max(bySkill, byBuilding);
  }, 1);
  for (const row of Object.values(dump.workbench)) {
    const by = row.UnlockSkillName !== 'None' ? row.UnlockSkillName : row.PrerequisiteBuilding;
    for (const b of [row.UnlockBuilding, ...row.ExtraUnlockBuildings]) offer(b, { level: workbenchLevel(b), via: 'workbench', by });
  }
  for (const [name, row] of Object.entries(dump.quests))
    for (const b of row.Awards.Buildings) offer(b, { level: questLevel(name), via: 'quest', by: name });

  // Rotation variants: walk the AlterBuildOption cycle to a member with a source
  const sourceOf = (row: string): BuildingUnlock | undefined => {
    const seen = new Set<string>();
    for (let r: string | undefined = row; r && r !== 'None' && !seen.has(r); r = dump.buildings[r]?.AlterBuildOption) {
      seen.add(r);
      if (direct.has(r)) return direct.get(r);
    }
    return undefined;
  };

  const rowById = new Map(Object.keys(dump.buildings).map((row) => [buildingIdFor(row), row]));
  const out: Record<string, BuildingUnlock> = {};
  for (const id of ids) {
    const row = rowById.get(id);
    const unlock = row && sourceOf(row);
    if (unlock) out[id] = unlock;
  }
  return out;
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: bun run scripts/build-unlocks.ts <dt_buildings.json>');
    process.exit(1);
  }
  const dump = JSON.parse(await readFile(input, 'utf8')) as Dump;
  const ids = (JSON.parse(await readFile(FOOTPRINTS, 'utf8')) as { id: string }[]).map((f) => f.id);
  const unlocks = buildUnlocks(dump, ids);
  await writeFile(OUT_FILE, JSON.stringify(unlocks, null, 1));
  console.log(`Wrote unlocks for ${Object.keys(unlocks).length} of ${ids.length} buildings to ${OUT_FILE}`);
}

if (import.meta.main) main();
