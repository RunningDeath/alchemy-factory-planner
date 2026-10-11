/**
 * What the player has unlocked, so generated modules only use buildings they can place.
 * Levels and sources come from the game data (data/building-unlocks.json); the player
 * picks their level and can switch single unlocks on or off (research is bought with
 * points, so a level alone doesn't say everything).
 */
import unlockData from "../../data/building-unlocks.json";
import { isBeltPiece } from "./belt-pieces";
import { getFootprint } from "./footprint";
import type { BuildingUnlock } from "./types";

const UNLOCKS = unlockData as Record<string, BuildingUnlock>;

export const MAX_LEVEL = 10;

export interface BuildUnlocks {
    /** Player level (1–10) */
    level: number;
    /** Per unlock (see unlockKey): forced on or off, whatever the level */
    overrides?: Record<string, boolean>;
}

export function unlockOf(id: string): BuildingUnlock | undefined {
    return UNLOCKS[isBeltPiece(id) ? "belt" : id];
}

/** Buildings unlocked together share a key: the skill, building or quest that unlocks them */
export function unlockKey(id: string): string {
    return unlockOf(id)?.by ?? id;
}

/** Whether the player can place this building. No settings means everything is available */
export function isUnlocked(id: string, unlocks?: BuildUnlocks): boolean {
    if (!unlocks) return true;
    const forced = unlocks.overrides?.[unlockKey(id)];
    if (forced !== undefined) return forced;
    const unlock = unlockOf(id);
    // Not unlocked by any research, workbench recipe or quest: not buildable in game
    return !!unlock && unlock.level <= unlocks.level;
}

/** The building families the generator chooses between, for the unlock settings */
export const OPTIONAL_BUILDINGS = [
    { id: "conveyer-lift-upwards", label: "Conveyor Lifters", what: "levels above the ground (vertical belts)" },
    { id: "frame-single", label: "Lab Stands", what: "supports that belts can pass through" },
    { id: "beam3", label: "Beams", what: "decks for stacked machines and cheap supports under belts" },
    { id: "draw-bridge", label: "Drawbridge Conveyors", what: "belts across gaps" },
    { id: "filter-vert", label: "Filter Splitters", what: "sorting byproducts onto their own belts" },
    { id: "splitter-vert", label: "Priority Splitters", what: "consumers first, surplus to the edge" },
    { id: "steam-heater", label: "Steam Heating Pads", what: "heating with steam" },
    { id: "stone-stove", label: "Stone Furnaces", what: "heating with fuel" },
    { id: "knowledge-altar", label: "Knowledge Altars", what: "turning byproducts nobody needs into knowledge" },
    { id: "junk-barrel", label: "Trash Barrels", what: "throwing away byproducts nobody needs" },
    { id: "dispatch-portal", label: "Dispatch Portals", what: "selling byproducts nobody needs" },
    { id: "purchasing-portal", label: "Purchasing Portals", what: "buying raw materials inside the module" },
] as const;

/** What the generator may use */
export interface Capabilities {
    lifts: boolean;
    stands: boolean;
    beams: boolean;
    bridges: boolean;
    filters: boolean;
    prioritySplitters: boolean;
    steam: boolean;
    stoves: boolean;
    trash: boolean;
    sell: boolean;
    altar: boolean;
    buy: boolean;
}

export function capabilities(unlocks?: BuildUnlocks): Capabilities {
    const can = (id: string) => isUnlocked(id, unlocks);
    return {
        lifts: can("conveyer-lift-upwards"),
        stands: can("frame-single"),
        beams: can("beam3"),
        bridges: can("draw-bridge"),
        filters: can("filter-vert"),
        prioritySplitters: can("splitter-vert"),
        steam: can("steam-heater"),
        stoves: can("stone-stove"),
        trash: can("junk-barrel"),
        sell: can("dispatch-portal"),
        altar: can("knowledge-altar"),
        buy: can("purchasing-portal"),
    };
}

/** Names of the locked buildings a layout uses, each once */
export function lockedBuildings(ids: Iterable<string>, unlocks?: BuildUnlocks): string[] {
    const names = new Set<string>();
    for (const id of ids) {
        if (isUnlocked(id, unlocks)) continue;
        // The lifter's parts have internal names; it's one building in game
        names.add(id.startsWith("conveyer-lift") ? "Conveyor Lifter" : (getFootprint(id)?.name ?? id));
    }
    return [...names].sort();
}
