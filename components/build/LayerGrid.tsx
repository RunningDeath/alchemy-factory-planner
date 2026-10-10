"use client";

import { useMemo, useState } from "react";
import { isBeltPiece } from "../../engine/build/belt-pieces";
import { beltPath, lPath } from "../../engine/build/edit";
import { footprintPorts, getFootprint, rotatedSize, SIDE_OFFSET } from "../../engine/build/footprint";
import { placementCells, placementIssues, type LayoutIssue, type Placement, type PortStatus, type WorldCell } from "../../engine/build/layout";
import { QUAD, type Side } from "../../engine/build/types";
import { buildingName, isMachine, placementColor } from "../../lib/buildCatalog";

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
    stepIndex: Map<string, number>;
    selectedUid: string | null;
    tool: BuildTool | null;
    cellSize: number;
    makeUid: () => string;
    onPlace: (placements: Placement[]) => void;
    onRemoveAt: (x: number, y: number) => void;
    onSelectAt: (x: number, y: number) => void;
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
    stepIndex,
    selectedUid,
    tool,
    cellSize: cs,
    makeUid,
    onPlace,
    onRemoveAt,
    onSelectAt,
}: LayerGridProps) {
    const [hover, setHover] = useState<[number, number] | null>(null);
    const [dragStart, setDragStart] = useState<[number, number] | null>(null);

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
        if (isBeltPiece(tool.id) && dragStart && (dragStart[0] !== hover[0] || dragStart[1] !== hover[1])) {
            pending = beltPath(lPath(dragStart, hover), level, makeUid);
        } else {
            pending = [{ uid: "preview", id: tool.id, x: hover[0], y: hover[1], z: level, rot: tool.rot, nodeKey: tool.nodeKey, label: tool.label }];
        }
        const valid = pending.every((p) =>
            placementIssues(p, occupancy).every((i) => i.kind !== "collision" || isBeltPiece(p.id)),
        );
        return { pending, valid };
    }, [tool, hover, dragStart, level, occupancy, makeUid]);

    const cellFromEvent = (e: React.MouseEvent<SVGSVGElement>): [number, number] => {
        const rect = e.currentTarget.getBoundingClientRect();
        return [Math.floor((e.clientX - rect.left) / cs) + extent.minX, Math.floor((e.clientY - rect.top) / cs) + extent.minY];
    };

    const handleDown = (e: React.MouseEvent<SVGSVGElement>) => {
        if (e.button !== 0) return;
        const cell = cellFromEvent(e);
        if (tool && isBeltPiece(tool.id)) setDragStart(cell);
    };

    const handleUp = (e: React.MouseEvent<SVGSVGElement>) => {
        if (e.button !== 0) return;
        const cell = cellFromEvent(e);
        if (!tool) {
            onSelectAt(cell[0], cell[1]);
            return;
        }
        if (preview) onPlace(preview.pending.map((p) => (p.uid === "preview" ? { ...p, uid: makeUid() } : p)));
        setDragStart(null);
    };

    const width = extent.width * cs;
    const height = extent.height * cs;

    return (
        <svg
            width={width}
            height={height}
            className="select-none block"
            onMouseMove={(e) => setHover(cellFromEvent(e))}
            onMouseLeave={() => {
                setHover(null);
                setDragStart(null);
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
                const color = placementColor(p, stepIndex);
                const opacity = cellOpacity(c.layers) * (getFootprint(p.id)?.category === "floor" ? 0.45 : 1);
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
                const showLabel = isMachine(p) && p.z === level && size.x * cs >= 26;
                return (
                    <g key={p.uid} pointerEvents="none">
                        <rect
                            x={px(p.x) + 0.5}
                            y={py(p.y) + 0.5}
                            width={size.x * cs - 1}
                            height={size.y * cs - 1}
                            fill="none"
                            stroke={selected ? "var(--accent-gold-bright)" : issues.length ? "var(--error)" : "rgba(0,0,0,0.35)"}
                            strokeWidth={selected ? 2.5 : issues.length ? 2 : 1}
                            strokeDasharray={issues.length && !selected ? "4 2" : undefined}
                        />
                        {isBeltPiece(p.id) && <BeltArrows p={p} x={px(p.x)} y={py(p.y)} cs={cs} />}
                        {showLabel && (
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
                                <BeltArrows p={p} x={px(p.x)} y={py(p.y)} cs={cs} />
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
function BeltArrows({ p, x, y, cs }: { p: Placement; x: number; y: number; cs: number }) {
    const fp = getFootprint(p.id);
    if (!fp) return null;
    const ports = footprintPorts(fp, p.rot).filter((port) => port.face !== "top" && port.face !== "base");
    const cx = x + cs / 2;
    const cy = y + cs / 2;
    return (
        <g stroke="#1a1208" strokeWidth={Math.max(1.5, cs / 10)} strokeLinecap="round" fill="none" opacity={0.85}>
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
