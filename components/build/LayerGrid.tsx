"use client";

import { useMemo, useState } from "react";
import { isBeltPiece } from "../../engine/build/belt-pieces";
import { beltPath, lPath } from "../../engine/build/edit";
import { footprintPorts, getFootprint, rotatedSize, SIDE_OFFSET } from "../../engine/build/footprint";
import { placementCells, placementIssues, type LayoutIssue, type Placement, type PortStatus, type WorldCell } from "../../engine/build/layout";
import { QUAD, type Side } from "../../engine/build/types";
import { placementsAt } from "../../engine/build/edit";
import { BELT_COLORS, buildingName, carriedItem, describePlacement, isMachine, isSupport, itemIdByName, placementColor, showsIcons } from "../../lib/buildCatalog";
import { gameIconUrl, useGameIcons } from "../../lib/gameIcons";

export interface BuildTool {
    id: string;
    rot: Placement["rot"];
    nodeKey?: string;
    label?: string;
}

interface LayerGridProps {
    placements: Placement[];
    occupancy: Map<string, WorldCell[]>;
    level: number;
    issuesByUid: Map<string, LayoutIssue[]>;
    ports: PortStatus[];
    itemColors: Map<string, string>;
    /** Only this item's belts and machines at full strength */
    highlightItem: string | null;
    selectedUid: string | null;
    tool: BuildTool | null;
    cellSize: number;
    /** Draw lab stands, metal stands and blocks */
    showSupports: boolean;
    makeUid: () => string;
    onPlace: (placements: Placement[]) => void;
    onRemoveAt: (x: number, y: number) => void;
    onSelectAt: (x: number, y: number) => void;
    onHoverCell?: (cell: [number, number] | null) => void;
}

const MARGIN = 4;
const MIN_EXTENT = 24;

/** Quadrant rectangles inside a unit cell: NW, NE, SE, SW */
const QUAD_RECTS: [number, number, number][] = [
    [QUAD.NW, 0, 0],
    [QUAD.NE, 0.5, 0],
    [QUAD.SE, 0.5, 0.5],
    [QUAD.SW, 0, 0.5],
];

function cellOpacity(layers: number): number {
    // Bottom or middle used: a solid obstacle at walking height; top/side only: overhead or legs
    return layers & 3 ? 0.85 : 0.4;
}

export function LayerGrid({
    placements,
    occupancy,
    level,
    issuesByUid,
    ports,
    itemColors,
    highlightItem,
    selectedUid,
    tool,
    cellSize: cs,
    showSupports,
    makeUid,
    onPlace,
    onRemoveAt,
    onSelectAt,
    onHoverCell,
}: LayerGridProps) {
    const [hover, setHover] = useState<[number, number] | null>(null);
    const icons = useGameIcons();
    /** Cells the mouse passed over while drawing a belt, in order */
    const [dragPath, setDragPath] = useState<[number, number][] | null>(null);

    // Grid extent: everything placed plus a margin, at least MIN_EXTENT cells
    const extent = useMemo(() => {
        let minX = 0, minY = 0, maxX = MIN_EXTENT - 1, maxY = MIN_EXTENT - 1;
        for (const p of placements) {
            const fp = getFootprint(p.id);
            if (!fp) continue;
            const size = rotatedSize(fp, p.rot);
            minX = Math.min(minX, p.x - MARGIN);
            minY = Math.min(minY, p.y - MARGIN);
            maxX = Math.max(maxX, p.x + size.x - 1 + MARGIN);
            maxY = Math.max(maxY, p.y + size.y - 1 + MARGIN);
        }
        return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    }, [placements]);

    const px = (x: number) => (x - extent.minX) * cs;
    const py = (y: number) => (y - extent.minY) * cs;

    const byUid = useMemo(() => new Map(placements.map((p) => [p.uid, p])), [placements]);

    // Cells on this level and the one below (shown faintly)
    const { here, below } = useMemo(() => {
        const hereCells: WorldCell[] = [];
        const belowCells: WorldCell[] = [];
        occupancy.forEach((cells) => {
            for (const c of cells) {
                if (c.z === level) hereCells.push(c);
                else if (c.z === level - 1) belowCells.push(c);
            }
        });
        // Floors and structures underneath, machines and belts on top
        const rank = (c: WorldCell) => {
            const cat = getFootprint(byUid.get(c.uid)?.id ?? "")?.category;
            return cat === "floor" ? 0 : cat === "structure" ? 1 : 2;
        };
        hereCells.sort((a, b) => rank(a) - rank(b));
        return { here: hereCells, below: belowCells };
    }, [occupancy, level, byUid]);

    const onLevel = useMemo(
        () => placements.filter((p) => placementCells(p).some((c) => c.z === level)),
        [placements, level],
    );

    const portsHere = useMemo(() => ports.filter((s) => s.port.z === level && s.port.medium === "belt"), [ports, level]);

    // Preview of what the tool would place
    const preview = useMemo(() => {
        if (!tool || !hover) return null;
        let pending: Placement[];
        if (isBeltPiece(tool.id) && dragPath && dragPath.length >= 2) {
            pending = beltPath(dragPath, level, makeUid);
        } else {
            pending = [{ uid: "preview", id: tool.id, x: hover[0], y: hover[1], z: level, rot: tool.rot, nodeKey: tool.nodeKey, label: tool.label }];
        }
        const valid = pending.every((p) =>
            placementIssues(p, occupancy).every((i) => i.kind !== "collision" || isBeltPiece(p.id)),
        );
        return { pending, valid };
    }, [tool, hover, dragPath, level, occupancy, makeUid]);

    const cellFromEvent = (e: React.MouseEvent<SVGSVGElement>): [number, number] => {
        const rect = e.currentTarget.getBoundingClientRect();
        return [Math.floor((e.clientX - rect.left) / cs) + extent.minX, Math.floor((e.clientY - rect.top) / cs) + extent.minY];
    };

    const handleDown = (e: React.MouseEvent<SVGSVGElement>) => {
        if (e.button !== 0) return;
        const cell = cellFromEvent(e);
        if (tool && isBeltPiece(tool.id)) setDragPath([cell]);
    };

    /** Follow the mouse: add the cells it passes, fill skipped ones, step back when it returns */
    const extendPath = (cell: [number, number]) => {
        setDragPath((path) => {
            if (!path) return path;
            const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
            const last = path[path.length - 1];
            if (same(last, cell)) return path;
            const seen = path.findIndex((c) => same(c, cell));
            // Back onto the drawn path: cut it there (undo the last stretch)
            if (seen >= 0) return path.slice(0, seen + 1);
            const gap = Math.abs(cell[0] - last[0]) + Math.abs(cell[1] - last[1]);
            return gap === 1 ? [...path, cell] : [...path, ...lPath(last, cell).slice(1)];
        });
    };

    const handleUp = (e: React.MouseEvent<SVGSVGElement>) => {
        if (e.button !== 0) return;
        const cell = cellFromEvent(e);
        if (!tool) {
            onSelectAt(cell[0], cell[1]);
            return;
        }
        if (preview) onPlace(preview.pending.map((p) => (p.uid === "preview" ? { ...p, uid: makeUid() } : p)));
        setDragPath(null);
    };

    const width = extent.width * cs;
    const height = extent.height * cs;

    /** Fade everything that isn't the highlighted item's belt or machine */
    function dim(p: Placement): number {
        if (!highlightItem) return 1;
        return carriedItem(p) === highlightItem ? 1 : 0.18;
    }

    /** The exported game icon of what a production machine makes, if there is one */
    function productIcon(p: Placement): string | null {
        if (!showsIcons(p.id)) return null;
        const item = carriedItem(p);
        const id = item ? itemIdByName(item) : undefined;
        return id ? gameIconUrl(icons, "items", id) : null;
    }

    const hovered = hover && !tool ? placementsAt(placements, hover[0], hover[1], level) : [];

    return (
        <div className="relative inline-block">
        {hovered.length > 0 && hover && (
            <div
                className="absolute z-10 pointer-events-none px-2 py-1 rounded bg-[var(--surface-elevated)] border border-[var(--border)] text-[11px] text-[var(--text-primary)] whitespace-nowrap shadow-lg"
                style={{ left: (hover[0] - extent.minX + 1) * cs + 6, top: (hover[1] - extent.minY + 1) * cs + 6 }}
            >
                {hovered.map((p) => (
                    <div key={p.uid} className="flex items-center gap-1.5">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: placementColor(p, itemColors) }} />
                        {describePlacement(p)}
                    </div>
                ))}
            </div>
        )}
        <svg
            width={width}
            height={height}
            className="select-none block"
            onMouseMove={(e) => {
                const cell = cellFromEvent(e);
                if (!hover || hover[0] !== cell[0] || hover[1] !== cell[1]) {
                    setHover(cell);
                    onHoverCell?.(cell);
                    if (dragPath) extendPath(cell);
                }
            }}
            onMouseLeave={() => {
                setHover(null);
                onHoverCell?.(null);
                setDragPath(null);
            }}
            onMouseDown={handleDown}
            onMouseUp={handleUp}
            onContextMenu={(e) => {
                e.preventDefault();
                const [x, y] = cellFromEvent(e);
                onRemoveAt(x, y);
            }}
        >
            <defs>
                <pattern id="build-grid" width={cs} height={cs} patternUnits="userSpaceOnUse" x={0} y={0}>
                    <path d={`M ${cs} 0 L 0 0 0 ${cs}`} fill="none" stroke="var(--border-subtle)" strokeWidth={1} />
                </pattern>
                <pattern id="support-hatch" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1={0} y1={0} x2={0} y2={6} stroke="#9a7a55" strokeWidth={2} />
                </pattern>
            </defs>
            <rect width={width} height={height} fill="var(--background-deep)" />
            <rect width={width} height={height} fill="url(#build-grid)" />
            {/* Origin marker */}
            <rect x={px(0)} y={py(0)} width={cs} height={cs} fill="none" stroke="var(--accent-purple-dim)" strokeDasharray="2 2" />

            {/* Level below, faint */}
            {below.map((c, i) => (
                <rect key={`b${i}`} x={px(c.x) + 1} y={py(c.y) + 1} width={cs - 2} height={cs - 2} fill="var(--text-muted)" opacity={0.12} />
            ))}

            {/* Cells on this level */}
            {here.map((c, i) => {
                const p = byUid.get(c.uid);
                if (!p) return null;
                // Belts: dark track (the arrow on top shows direction and lane)
                if (isBeltPiece(p.id)) {
                    return <rect key={i} x={px(c.x) + 1} y={py(c.y) + 1} width={cs - 2} height={cs - 2} rx={3} fill={BELT_COLORS.track} opacity={dim(p)} />;
                }
                // Supports: hatched, so belts and machines stay readable
                if (isSupport(p)) {
                    if (!showSupports) return null;
                    return <rect key={i} x={px(c.x) + 2} y={py(c.y) + 2} width={cs - 4} height={cs - 4} fill="url(#support-hatch)" opacity={0.55} />;
                }
                const color = placementColor(p, itemColors);
                const opacity = cellOpacity(c.layers) * (getFootprint(p.id)?.category === "floor" ? 0.45 : 1) * dim(p);
                if (c.quads === QUAD.ALL) {
                    return <rect key={i} x={px(c.x)} y={py(c.y)} width={cs} height={cs} fill={color} opacity={opacity} />;
                }
                return QUAD_RECTS.filter(([bit]) => c.quads & bit).map(([bit, ox, oy]) => (
                    <rect key={`${i}-${bit}`} x={px(c.x) + ox * cs} y={py(c.y) + oy * cs} width={cs / 2} height={cs / 2} fill={color} opacity={opacity} />
                ));
            })}

            {/* Building outlines and labels */}
            {onLevel.map((p) => {
                const fp = getFootprint(p.id);
                if (!fp || fp.category === "floor") return null;
                const size = rotatedSize(fp, p.rot);
                const issues = issuesByUid.get(p.uid) ?? [];
                const selected = p.uid === selectedUid;
                const showLabel = isMachine(p) && p.z === level && size.x * cs >= 18;
                const plain = (isBeltPiece(p.id) || isSupport(p)) && !selected && issues.length === 0;
                if (isSupport(p) && !showSupports && !selected && issues.length === 0) return null;
                return (
                    <g key={p.uid} pointerEvents="none">
                        {!plain && <rect
                            x={px(p.x) + 0.5}
                            y={py(p.y) + 0.5}
                            width={size.x * cs - 1}
                            height={size.y * cs - 1}
                            fill="none"
                            stroke={selected ? "var(--accent-gold-bright)" : issues.length ? "var(--error)" : "rgba(0,0,0,0.6)"}
                            strokeWidth={selected ? 2.5 : issues.length ? 2 : 1.5}
                            rx={isMachine(p) ? 3 : 0}
                            strokeDasharray={issues.length && !selected ? "4 2" : undefined}
                        />}
                        {isBeltPiece(p.id) && <BeltArrows p={p} x={px(p.x)} y={py(p.y)} cs={cs} color={placementColor(p, itemColors)} opacity={dim(p)} />}
                        {showLabel && productIcon(p) ? (
                            <MachineIcons
                                x={px(p.x)}
                                y={py(p.y)}
                                w={size.x * cs}
                                h={size.y * cs}
                                product={productIcon(p)!}
                                machine={gameIconUrl(icons, "buildings", p.id)}
                                opacity={dim(p)}
                            />
                        ) : showLabel && (
                            <text
                                x={px(p.x) + (size.x * cs) / 2}
                                y={py(p.y) + (size.y * cs) / 2}
                                textAnchor="middle"
                                dominantBaseline="central"
                                fontSize={Math.min(11, cs * 0.45)}
                                fontWeight={700}
                                fill="#1a1208"
                            >
                                {shortName(buildingName(p.id), size.x * cs)}
                            </text>
                        )}
                    </g>
                );
            })}

            {/* Machine ports: green = connected, red = open */}
            {portsHere.map((s, i) => {
                const p = byUid.get(s.port.uid);
                if (!p || isBeltPiece(p.id) || s.port.face === "top" || s.port.face === "base") return null;
                return <PortMarker key={i} x={px(s.port.x)} y={py(s.port.y)} cs={cs} face={s.port.face} dir={s.port.dir} connected={!!s.connectedTo} />;
            })}

            {/* Tool preview */}
            {preview &&
                preview.pending.map((p, i) => {
                    const fp = getFootprint(p.id);
                    if (!fp) return null;
                    const size = rotatedSize(fp, p.rot);
                    return (
                        <g key={`pv${i}`} pointerEvents="none">
                            {placementCells(p)
                                .filter((c) => c.z === level)
                                .map((c, j) => (
                                    <rect key={j} x={px(c.x)} y={py(c.y)} width={cs} height={cs} fill={preview.valid ? "var(--success)" : "var(--error)"} opacity={0.35} />
                                ))}
                            <rect x={px(p.x)} y={py(p.y)} width={size.x * cs} height={size.y * cs} fill="none" stroke={preview.valid ? "var(--success)" : "var(--error)"} strokeWidth={2} />
                            {isBeltPiece(p.id) ? (
                                <BeltArrows p={p} x={px(p.x)} y={py(p.y)} cs={cs} color={BELT_COLORS.manual} opacity={1} />
                            ) : (
                                footprintPorts(fp, p.rot)
                                    .filter((port) => port.z === 0 && port.medium === "belt" && port.face !== "top" && port.face !== "base")
                                    .map((port, j) => (
                                        <PortMarker key={j} x={px(p.x + port.x)} y={py(p.y + port.y)} cs={cs} face={port.face as Side} dir={port.dir} connected />
                                    ))
                            )}
                        </g>
                    );
                })}
        </svg>
        </div>
    );
}

/** The product's icon in the middle of the machine, the machine's own icon small in a corner */
function MachineIcons({ x, y, w, h, product, machine, opacity }: { x: number; y: number; w: number; h: number; product: string; machine: string | null; opacity: number }) {
    const s = Math.min(w, h) * 0.7;
    const m = Math.min(w, h) * 0.38;
    return (
        <g opacity={opacity}>
            <image href={product} x={x + (w - s) / 2} y={y + (h - s) / 2} width={s} height={s} />
            {machine && Math.min(w, h) >= 40 && <image href={machine} x={x + w - m - 2} y={y + h - m - 2} width={m} height={m} />}
        </g>
    );
}

function shortName(name: string, widthPx: number): string {
    if (name.length * 6 <= widthPx) return name;
    const initials = name.split(/\s+/).map((w) => w[0]).join("");
    return initials.length * 7 <= widthPx ? initials : initials.slice(0, 2);
}

const SIDE_POINT: Record<Side, [number, number]> = {
    left: [0, 0.5],
    right: [1, 0.5],
    up: [0.5, 0],
    down: [0.5, 1],
};

/** Lines from each input edge through the center to each output edge */
function BeltArrows({ p, x, y, cs, color, opacity }: { p: Placement; x: number; y: number; cs: number; color: string; opacity: number }) {
    const fp = getFootprint(p.id);
    if (!fp) return null;
    const ports = footprintPorts(fp, p.rot).filter((port) => port.face !== "top" && port.face !== "base");
    const cx = x + cs / 2;
    const cy = y + cs / 2;
    return (
        <g stroke={color} strokeWidth={Math.max(1.5, cs / 9)} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={opacity}>
            {ports.map((port, i) => {
                const [sx, sy] = SIDE_POINT[port.face as Side];
                // Port positions are local to the building
                const ex = x + port.x * cs + sx * cs;
                const ey = y + port.y * cs + sy * cs;
                if (port.dir === "in") return <line key={i} x1={ex} y1={ey} x2={cx} y2={cy} />;
                // Output: line plus an arrowhead at the edge
                const [dx, dy] = SIDE_OFFSET[port.face as Side];
                const h = cs * 0.2;
                return (
                    <g key={i}>
                        <line x1={cx} y1={cy} x2={ex} y2={ey} />
                        <polyline points={`${ex - dx * h - dy * h},${ey - dy * h - dx * h} ${ex},${ey} ${ex - dx * h + dy * h},${ey - dy * h + dx * h}`} />
                    </g>
                );
            })}
        </g>
    );
}

/** Small triangle on the port's cell edge, pointing the way items move */
function PortMarker({ x, y, cs, face, dir, connected }: { x: number; y: number; cs: number; face: Side; dir: "in" | "out" | "both"; connected: boolean }) {
    const [dx, dy] = SIDE_OFFSET[face];
    const [sx, sy] = SIDE_POINT[face];
    const ex = x + sx * cs;
    const ey = y + sy * cs;
    const s = cs * 0.22;
    // Inputs point into the machine (against the face), outputs point out of it
    const sign = dir === "in" ? -1 : 1;
    const tipX = ex + dx * s * sign * 0.6;
    const tipY = ey + dy * s * sign * 0.6;
    const baseX = ex - dx * s * sign * 0.6;
    const baseY = ey - dy * s * sign * 0.6;
    const points = `${tipX},${tipY} ${baseX - dy * s},${baseY - dx * s} ${baseX + dy * s},${baseY + dx * s}`;
    return (
        <polygon
            points={points}
            fill={connected ? "var(--success)" : "var(--error)"}
            stroke="#1a1208"
            strokeWidth={0.75}
            pointerEvents="none"
        />
    );
}
