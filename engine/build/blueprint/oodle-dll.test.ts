/**
 * Checks against the real Oodle library. Skipped unless OODLE_DLL points at
 * oo2core_9_win64.dll. With BLUEPRINT_DIR set (e.g. %LOCALAPPDATA%/AlchemyFactory/Saved/Blueprints)
 * every blueprint there is also decoded, validated and re-encoded.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { validateLayout } from "../layout";
import { bytesEqual } from "./bytes";
import { buildingsOf, decodeBuilding } from "./decode";
import { readBlueprintFile, readBlueprintTail } from "./file";
import { exportBlueprint, placementsToBody, readBlueprint } from "./index";
import { loadOodle } from "../../../scripts/oodle";
import { oodleStore } from "./oodle";

const oodle = loadOodle();
const FIXTURES = `${import.meta.dir}/fixtures/`;

describe.skipIf(!oodle)("real Oodle library", () => {
    test.each(["leinoel", "monteur"])("%s: the game's compressed body decompresses to the fixture", (name) => {
        const file = readBlueprintTail(new Uint8Array(readFileSync(`${FIXTURES}${name}.tail.bin`)));
        const body = new Uint8Array(gunzipSync(readFileSync(`${FIXTURES}${name}.body.bin.gz`)));
        expect(bytesEqual(oodle!.decompress(file.compressed, file.uncompressedSize), body)).toBe(true);
    });

    test("OodleLZ_Decompress accepts our stored-block streams (one and many blocks)", () => {
        for (const size of [1, 1000, 0x40000, 0x40000 * 5 + 17]) {
            const data = new Uint8Array(size).map((_, i) => (i * 31 + (i >> 9)) & 255);
            expect(bytesEqual(oodle!.decompress(oodleStore(data), size), data)).toBe(true);
        }
    });

    test("an exported blueprint's body decompresses with the real library", () => {
        const placements = [
            { uid: "a", id: "wood-block", x: 0, y: 0, z: 0, rot: 0 as const },
            { uid: "b", id: "grinder", x: 0, y: 0, z: 1, rot: 1 as const },
        ];
        const tinyPng = Uint8Array.from(
            atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
            (c) => c.charCodeAt(0),
        );
        const { bytes } = exportBlueprint(placements, { title: "dll check" }, tinyPng);
        const read = readBlueprint(bytes, (c, n) => oodle!.decompress(c, n));
        expect(read.placements.map((p) => p.id).sort()).toEqual(["grinder", "wood-block"]);
    });

    const dir = process.env.BLUEPRINT_DIR;
    test.skipIf(!dir)("every blueprint in BLUEPRINT_DIR decodes, validates and re-encodes", () => {
        for (const f of readdirSync(dir!).filter((f) => f.endsWith(".png"))) {
            const bytes = new Uint8Array(readFileSync(`${dir}/${f}`));
            const file = readBlueprintFile(bytes);
            const read = readBlueprint(bytes, (c, n) => oodle!.decompress(c, n));
            expect(read.unknown).toEqual([]);
            expect(validateLayout(read.placements)).toEqual([]);
            const again = buildingsOf(placementsToBody(read.placements).body).map(decodeBuilding);
            const before = buildingsOf(read.body).map(decodeBuilding);
            const sig = (d: ReturnType<typeof decodeBuilding>) => `${d.row}@${d.pivot}r${d.rot}x${d.extension.length}`;
            expect(again.map(sig).sort()).toEqual(before.map(sig).sort());
            expect(file.uncompressedSize).toBeGreaterThan(0);
        }
    });
});
