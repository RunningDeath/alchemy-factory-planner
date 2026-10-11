/**
 * Alchemy Factory blueprint files: read, convert to and from app layouts, write.
 * See README.md in this folder for the format.
 */
import { blueprintToPlacements, type DecodedLayout } from "./decode";
import { readBlueprintFile, type BlueprintFile } from "./file";
import { oodleUnstore } from "./oodle";
import { decodeProperties, getProp, type Property, type TextValue } from "./properties";

export { blueprintToPlacements } from "./decode";
export { exportBlueprint, placementsToBody, blueprintHeader, randomBlueprintId, type BlueprintMeta, type ExportedBlueprint } from "./encode";

/** Turns a stored Oodle stream back into bytes; the default only handles stored blocks */
export type Decompressor = (compressed: Uint8Array, size: number) => Uint8Array;

export interface ReadBlueprint extends DecodedLayout {
    file: BlueprintFile;
    body: Property[];
    title: string;
    description: string;
}

export function readBlueprint(bytes: Uint8Array, decompress: Decompressor = oodleUnstore): ReadBlueprint {
    const file = readBlueprintFile(bytes);
    const body = decodeProperties(decompress(file.compressed, file.uncompressedSize));
    const text = (name: string) => getProp<TextValue>(file.header, name).text?.invariant ?? "";
    return { file, body, title: text("Title"), description: text("Description"), ...blueprintToPlacements(body) };
}
