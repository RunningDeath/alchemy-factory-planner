#!/usr/bin/env bun

/**
 * Blueprint tools for local use.
 *
 *   bun run scripts/export-blueprint.ts info <blueprint.png>
 *       Title, buildings and layout check. The game's own blueprints are Oodle-compressed:
 *       set OODLE_DLL to oo2core_9_win64.dll to read them.
 *   bun run scripts/export-blueprint.ts recompress <in.png> <out.png>
 *       Re-compresses an exported blueprint (stored, uncompressed Oodle blocks) with real
 *       Oodle Kraken, like the game does. Needs OODLE_DLL. The result is much smaller.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { validateLayout } from '../engine/build/layout';
import { readBlueprintFile, writeBlueprintFile } from '../engine/build/blueprint/file';
import { readBlueprint, type Decompressor } from '../engine/build/blueprint/index';
import { oodleUnstore } from '../engine/build/blueprint/oodle';
import { loadOodle } from './oodle';

const [command, input, output] = process.argv.slice(2);
const oodle = loadOodle();

function decompressor(): Decompressor {
  return (compressed, size) => {
    try {
      return oodleUnstore(compressed, size);
    } catch {
      if (!oodle) throw new Error('This blueprint is Oodle-compressed: set OODLE_DLL to oo2core_9_win64.dll');
      return oodle.decompress(compressed, size);
    }
  };
}

if (command === 'info' && input) {
  const bp = readBlueprint(new Uint8Array(readFileSync(input)), decompressor());
  const counts = new Map<string, number>();
  for (const p of bp.placements) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
  console.log(`Title: ${bp.title}`);
  if (bp.description) console.log(`Description: ${bp.description}`);
  console.log(`Body: ${bp.file.compressed.length} bytes compressed, ${bp.file.uncompressedSize} uncompressed`);
  console.log(`Buildings: ${[...counts].map(([id, n]) => `${n}× ${id}`).join(', ')}`);
  if (bp.unknown.length) console.log(`Not in the app: ${bp.unknown.join(', ')}`);
  const issues = validateLayout(bp.placements);
  console.log(issues.length ? `${issues.length} layout issues: ${JSON.stringify(issues.slice(0, 5))}` : 'Layout valid');
} else if (command === 'recompress' && input && output) {
  if (!oodle) throw new Error('Set OODLE_DLL to oo2core_9_win64.dll');
  const file = readBlueprintFile(new Uint8Array(readFileSync(input)));
  const raw = decompressor()(file.compressed, file.uncompressedSize);
  const compressed = oodle.compress(raw);
  if (oodle.decompress(compressed, raw.length).some((b, i) => b !== raw[i])) throw new Error('Oodle round trip failed');
  writeFileSync(output, writeBlueprintFile({ ...file, compressed }));
  console.log(`${file.compressed.length} → ${compressed.length} bytes: ${output}`);
} else {
  console.error('Usage: bun run scripts/export-blueprint.ts info <blueprint.png> | recompress <in.png> <out.png>');
  process.exit(1);
}
