#!/usr/bin/env bun

/**
 * Builds data/blueprint-names.json: the game's internal names that blueprints store,
 * keyed by the ids this app uses.
 * - recipes: recipe id → craft name (RecipeName, for machines with more than one recipe)
 * - seeds: nursery product item id → seed config name (SeedName)
 * - items: item id → internal item name (FilterName of filter splitters)
 * - activeCrafting: machines where the player picks the recipe (the others pick it from their input)
 *
 * Usage: bun run scripts/blueprint-names.ts
 */

import { writeFile } from 'node:fs/promises';
import { buildingIdFor } from './building-ids';

const REMOTE_BASE_URL = 'https://raw.githubusercontent.com/faultyd3v/AlchemyFactoryData/main';
const OUT_FILE = './data/blueprint-names.json';

interface RemoteCraft { craftIdName: string }
interface RemoteSeed { id: string; product: { name: string } }
interface RemoteItem { name: string }
interface RemoteBuilding { idName: string; buildingTags?: { GameplayTags?: string[] } }

/** Same conversion scripts/sync-data.ts uses for recipe ids */
function nameToKebab(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/\s+/g, '-');
}

async function fetchJson<T>(file: string): Promise<T[]> {
  const res = await fetch(`${REMOTE_BASE_URL}/${file}`);
  if (!res.ok) throw new Error(`${file}: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : Object.values(data);
}

async function main() {
  const [crafting, seeds, items, buildings] = await Promise.all([
    fetchJson<RemoteCraft>('crafting.json'),
    fetchJson<RemoteSeed>('plantseeds.json'),
    fetchJson<RemoteItem>('items.json'),
    fetchJson<RemoteBuilding>('buildings.json'),
  ]);
  const sorted = (entries: [string, string][]) => Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  const names = {
    recipes: sorted(crafting.map((c) => [nameToKebab(c.craftIdName), c.craftIdName])),
    seeds: sorted(seeds.map((s) => [s.product.name.toLowerCase(), s.id])),
    items: sorted(items.filter((i) => i.name).map((i) => [i.name.toLowerCase(), i.name])),
    activeCrafting: buildings
      .filter((b) => b.buildingTags?.GameplayTags?.includes('Building.Crafting.ActiveCrafting'))
      .map((b) => buildingIdFor(b.idName))
      .sort(),
  };
  await writeFile(OUT_FILE, JSON.stringify(names, null, 1) + '\n');
  console.log(`Wrote ${Object.keys(names.recipes).length} recipes, ${Object.keys(names.seeds).length} seeds, ${Object.keys(names.items).length} items to ${OUT_FILE}`);
}

if (import.meta.main) main();
