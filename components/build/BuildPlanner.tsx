"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cycleVariant, placeBuilding, placementsAt, removePlacement } from "../../engine/build/edit";
import { DEFAULT_MODULE_OPTIONS, generateModule } from "../../engine/build/generator";
import { buildOccupancy, placementIssues, portConnections, type LayoutIssue, type Placement } from "../../engine/build/layout";
import { stepsFromReport } from "../../engine/build/module-steps";
import type { BuildLayoutState } from "../../engine/types";
import { buildingName } from "../../lib/buildCatalog";
import { useFactoryStore } from "../../store/useFactoryStore";
import { BuildInfoPanel } from "./BuildInfoPanel";
import { BuildPalette } from "./BuildPalette";
import { BuildToolbar, type BuildViewMode } from "./BuildToolbar";
import { LayerGrid, type BuildTool } from "./LayerGrid";
import { View3D } from "./View3D";

const EMPTY: Placement[] = [];
const HISTORY_LIMIT = 50;

export function BuildPlanner() {
    const factory = useFactoryStore((s) => s.factories.find((f) => f.id === s.activeFactoryId));
    const setBuildLayout = useFactoryStore((s) => s.setBuildLayout);

    const layout = factory?.buildLayout;
    const placements = layout?.placements ?? EMPTY;
    const options = layout?.options ?? DEFAULT_MODULE_OPTIONS;
    const report = factory?.beltReport ?? null;

    const [tool, setTool] = useState<BuildTool | null>(null);
    const [level, setLevel] = useState(0);
    const [selectedUid, setSelectedUid] = useState<string | null>(null);
    const [cellSize, setCellSize] = useState(22);
    const [view, setView] = useState<BuildViewMode>("split");
    const [cutAbove, setCutAbove] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const undoStack = useRef<BuildLayoutState[]>([]);
    const redoStack = useRef<BuildLayoutState[]>([]);
    const uidCounter = useRef(0);
    const makeUid = useCallback(() => `p${Date.now().toString(36)}-${++uidCounter.current}`, []);

    const steps = useMemo(() => (report ? stepsFromReport(report) : []), [report]);
    const stepIndex = useMemo(() => new Map(steps.map((s, i) => [s.nodeKey, i])), [steps]);

    const occupancy = useMemo(() => buildOccupancy(placements), [placements]);
    const issues = useMemo(() => placements.flatMap((p) => placementIssues(p, occupancy)), [placements, occupancy]);
    const issuesByUid = useMemo(() => {
        const map = new Map<string, LayoutIssue[]>();
        issues.forEach((i) => map.set(i.uid, [...(map.get(i.uid) ?? []), i]));
        return map;
    }, [issues]);
    const ports = useMemo(() => portConnections(placements), [placements]);
    const placedByNode = useMemo(() => {
        const map = new Map<string, number>();
        placements.forEach((p) => p.nodeKey && stepIndex.has(p.nodeKey) && p.id === steps[stepIndex.get(p.nodeKey)!].deviceId && map.set(p.nodeKey, (map.get(p.nodeKey) ?? 0) + 1));
        return map;
    }, [placements, stepIndex, steps]);

    const commit = useCallback(
        (next: BuildLayoutState) => {
            if (!factory) return;
            undoStack.current = [...undoStack.current.slice(-HISTORY_LIMIT + 1), layout ?? { placements: [] }];
            redoStack.current = [];
            setBuildLayout(factory.id, next);
        },
        [factory, layout, setBuildLayout],
    );

    const setPlacements = useCallback(
        (next: Placement[]) => commit({ ...(layout ?? {}), placements: next }),
        [commit, layout],
    );

    const flash = (text: string) => {
        setMessage(text);
        setTimeout(() => setMessage((m) => (m === text ? null : m)), 2500);
    };

    const handleGenerate = () => {
        if (!report || steps.length === 0) return;
        if (placements.length > 0 && !window.confirm("Replace the current layout with a generated module?")) return;
        const mod = generateModule(steps, { ...options, beltSpeed: report.beltSpeed });
        commit({ placements: mod.placements, options, tiers: mod.tiers });
        setLevel(0);
        setSelectedUid(null);
    };

    const handlePlace = (pending: Placement[]) => {
        let next = placements;
        for (const p of pending) {
            const result = placeBuilding(next, p);
            if (!result.ok) {
                const blocker = next.find((x) => x.uid === result.blockedBy);
                flash(`Blocked by ${blocker ? buildingName(blocker.id) : "another building"}`);
                if (pending.length === 1) return;
                continue;
            }
            next = result.placements;
        }
        setPlacements(next);
    };

    const handleRemoveAt = (x: number, y: number) => {
        const target = placementsAt(placements, x, y, level)[0];
        if (!target) return;
        if (target.uid === selectedUid) setSelectedUid(null);
        setPlacements(removePlacement(placements, target.uid));
    };

    const handleSelectAt = (x: number, y: number) => setSelectedUid(placementsAt(placements, x, y, level)[0]?.uid ?? null);

    /** Replace the selected building with a changed copy, if it still fits */
    const changeSelected = useCallback(
        (change: (p: Placement) => Placement) => {
            const current = placements.find((p) => p.uid === selectedUid);
            if (!current) return;
            const result = placeBuilding(removePlacement(placements, current.uid), change(current));
            if (result.ok) setPlacements(result.placements);
            else flash("Doesn't fit there");
        },
        [placements, selectedUid, setPlacements],
    );

    const undo = useCallback(() => {
        const prev = undoStack.current.pop();
        if (!prev || !factory) return;
        redoStack.current.push(layout ?? { placements: [] });
        setBuildLayout(factory.id, prev);
    }, [factory, layout, setBuildLayout]);

    const redo = useCallback(() => {
        const next = redoStack.current.pop();
        if (!next || !factory) return;
        undoStack.current.push(layout ?? { placements: [] });
        setBuildLayout(factory.id, next);
    }, [factory, layout, setBuildLayout]);

    // Keyboard shortcuts
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
            const key = e.key.toLowerCase();
            if ((e.ctrlKey || e.metaKey) && key === "z") {
                e.preventDefault();
                if (e.shiftKey) redo();
                else undo();
            } else if ((e.ctrlKey || e.metaKey) && key === "y") {
                e.preventDefault();
                redo();
            } else if (key === "r") {
                if (tool) setTool({ ...tool, rot: ((tool.rot + 1) % 4) as Placement["rot"] });
                else changeSelected((p) => ({ ...p, rot: ((p.rot + 1) % 4) as Placement["rot"] }));
            } else if (key === "f") {
                if (tool) setTool({ ...tool, id: cycleVariant(tool.id) });
                else changeSelected((p) => ({ ...p, id: cycleVariant(p.id) }));
            } else if (key === "e" || e.key === "PageUp") {
                setLevel((l) => l + 1);
            } else if (key === "q" || e.key === "PageDown") {
                setLevel((l) => Math.max(0, l - 1));
            } else if (e.key === "Escape") {
                setTool(null);
                setSelectedUid(null);
            } else if ((e.key === "Delete" || e.key === "Backspace") && selectedUid) {
                setPlacements(removePlacement(placements, selectedUid));
                setSelectedUid(null);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [tool, selectedUid, placements, changeSelected, setPlacements, undo, redo]);

    if (!factory) return null;

    const selected = placements.find((p) => p.uid === selectedUid);

    return (
        <div className="flex flex-col h-[calc(100vh-2rem)] min-h-[680px]">
            <BuildToolbar
                options={options}
                onOptionsChange={(next) => factory && setBuildLayout(factory.id, { ...(layout ?? { placements: [] }), options: next })}
                canGenerate={steps.length > 0}
                onGenerate={handleGenerate}
                onClear={() => placements.length > 0 && window.confirm("Remove every building from this layout?") && commit({ placements: [], options })}
                level={level}
                onLevelChange={(l) => setLevel(Math.max(0, l))}
                tool={tool}
                onRotate={() => tool && setTool({ ...tool, rot: ((tool.rot + 1) % 4) as Placement["rot"] })}
                onVariant={() => tool && setTool({ ...tool, id: cycleVariant(tool.id) })}
                cellSize={cellSize}
                onCellSizeChange={setCellSize}
                view={view}
                onViewChange={setView}
                cutAbove={cutAbove}
                onCutAboveChange={setCutAbove}
                onUndo={undo}
                onRedo={redo}
            />
            <div className="flex flex-1 min-h-0">
                <aside className="w-56 shrink-0 border-r border-[var(--border)] p-3 overflow-y-auto custom-scrollbar">
                    <BuildPalette steps={steps} placedByNode={placedByNode} tool={tool} onSelectTool={setTool} />
                </aside>

                <div className="flex-1 min-w-0 flex flex-col">
                    <div className="px-3 py-1.5 text-[11px] text-[var(--text-muted)] border-b border-[var(--border)] flex flex-wrap gap-x-4 gap-y-1">
                        {tool ? (
                            <span>
                                Placing <b className="text-[var(--accent-gold)]">{buildingName(tool.id)}</b>
                                {tool.label ? ` for ${tool.label}` : ""}: click to place
                                {tool.id.startsWith("belt") ? ", drag to draw a belt" : ""} · R rotate · F variant · Esc stop
                            </span>
                        ) : selected ? (
                            <span>
                                Selected <b className="text-[var(--accent-gold)]">{buildingName(selected.id)}</b>
                                {selected.label ? ` (${selected.label})` : ""} at {selected.x},{selected.y},{selected.z} · R rotate · F variant · Del remove
                            </span>
                        ) : (
                            <span>Pick a building on the left. Click selects, right-click removes. Q/E change level.</span>
                        )}
                        {message && <span className="text-[var(--warning)] font-semibold">{message}</span>}
                    </div>
                    <div className={view === "split" ? "flex-1 min-h-0 grid grid-rows-2 xl:grid-rows-1 xl:grid-cols-2" : "flex-1 min-h-0 flex"}>
                        {view !== "3d" && (
                            <div className="overflow-auto custom-scrollbar min-h-0 flex-1">
                                <LayerGrid
                                    placements={placements}
                                    occupancy={occupancy}
                                    level={level}
                                    issuesByUid={issuesByUid}
                                    ports={ports}
                                    stepIndex={stepIndex}
                                    selectedUid={selectedUid}
                                    tool={tool}
                                    cellSize={cellSize}
                                    makeUid={makeUid}
                                    onPlace={handlePlace}
                                    onRemoveAt={handleRemoveAt}
                                    onSelectAt={handleSelectAt}
                                />
                            </div>
                        )}
                        {view !== "2d" && (
                            <div className="min-h-0 flex-1 border-l border-[var(--border)] bg-[var(--background-deep)]">
                                <View3D
                                    placements={placements}
                                    stepIndex={stepIndex}
                                    issuesByUid={issuesByUid}
                                    selectedUid={selectedUid}
                                    cutLevel={cutAbove ? level : null}
                                />
                            </div>
                        )}
                    </div>
                </div>

                <aside className="w-72 shrink-0 border-l border-[var(--border)] p-3 overflow-y-auto custom-scrollbar">
                    <BuildInfoPanel
                        placements={placements}
                        issues={issues}
                        ports={ports}
                        tiers={layout?.tiers ?? []}
                        onSelect={setSelectedUid}
                        onGoToLevel={setLevel}
                    />
                </aside>
            </div>
        </div>
    );
}
