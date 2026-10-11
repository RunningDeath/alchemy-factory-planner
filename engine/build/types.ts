/**
 * Building footprints from the game's DT_Buildings table (data/building-footprints.json).
 *
 * The game builds on a cell grid. A building occupies cells, and within a cell it
 * occupies vertical layers (bottom / middle / top / side) and horizontal quadrants.
 * Two buildings collide only when they share a cell, a layer and a quadrant. That is
 * how a metal stand's legs fit into the cut corners of a nursery.
 */

/** Vertical layers inside one cell (EGridOccupationConfig bits) */
export const LAYER = { BOTTOM: 1, MIDDLE: 2, TOP: 4, SIDE: 8 } as const;

/** Horizontal quadrants inside one cell (OccupationValue >> 4): NW, NE, SE, SW with y pointing "down" */
export const QUAD = { NW: 1, NE: 2, SE: 4, SW: 8, ALL: 15 } as const;

/** Horizontal sides. "left" = -x, "right" = +x, "up" = -y, "down" = +y (the game's Left/Right/Up/Bottom) */
export type Side = "left" | "up" | "right" | "down";
/** Vertical port faces (pipes) */
export type VerticalFace = "top" | "base";

export type BuildingCategory =
    | "production"
    | "heating"
    | "logistics"
    | "pipe"
    | "structure"
    | "floor"
    | "storage"
    | "portal";

/** Occupation shared by every cell of a box or a single cell */
export interface CellOccupation {
    /** LAYER bits */
    layers: number;
    /** QUAD bits */
    quads: number;
    /** Needs support from below (ground or a stackable cell) */
    foundation?: boolean;
    /** Other buildings can stand on top of this cell */
    stackable?: boolean;
    /** Belts / pipes / floors replace each other in this cell instead of colliding */
    overlay?: "belt" | "pipe" | "construct";
}

/** A box of cells with the same occupation, as stored in the data file (inclusive bounds) */
export interface FootprintBox extends CellOccupation {
    min: [number, number, number];
    max: [number, number, number];
}

export interface FootprintCell extends CellOccupation {
    x: number;
    y: number;
    z: number;
}

export interface FootprintPort {
    x: number;
    y: number;
    z: number;
    face: Side | VerticalFace;
    dir: "in" | "out" | "both";
    medium: "belt" | "pipe";
}

export interface BuildingFootprint {
    /** Device id (matches data/devices.json for production machines) */
    id: string;
    /** Row name in DT_Buildings */
    row: string;
    name: string;
    category: BuildingCategory;
    /** Bounding box in cells (from 0,0,0 after normalization) */
    size: { x: number; y: number; z: number };
    boxes: FootprintBox[];
    ports: FootprintPort[];
    cost: { item: string; count: number }[];
    heatCost?: number;
    /** Variant only reachable through another building's build option (e.g. mirrored) */
    hidden?: boolean;
    /**
     * Cell of the game's building origin when it isn't 0,0,0 (a few buildings, e.g. beams,
     * extend into negative grid offsets). Blueprints position buildings by this cell.
     */
    origin?: [number, number, number];
    /** The game's ESecondaryType when not None (Belt, Pipeline, ConveyerLift, BeltSlope, ...) */
    secondary?: string;
    /** Alternative build option, e.g. the mirrored version */
    alt?: string;
}

/** When a building becomes available in game (data/building-unlocks.json) */
export interface BuildingUnlock {
    /** Player level needed */
    level: number;
    via: "research" | "workbench" | "quest";
    /** Skill, building or quest that unlocks it */
    by: string;
}
