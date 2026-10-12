"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cycleVariant, inferBeltItems, placeBuilding, placementsAt, removePlacement } from "../../engine/build/edit";
import { DEFAULT_MODULE_OPTIONS, moduleTooBig, type ModuleStep } from "../../engine/build/generator";
import { buildOccupancy, placementIssues, portConnections, type LayoutIssue, type Placement } from "../../engine/build/layout";
import { stepsFromReport } from "../../engine/build/module-steps";
import { suggestModuleGroups } from "../../engine/build/module-groups";
import { lockedBuildings } from "../../engine/build/unlocks";
import type { BuildLayoutState } from "../../engine/types";
import { BELT_COLORS, buildingName, carriedItem, itemColorMap } from "../../lib/buildCatalog";
import { ExportBlueprintDialog } from "./ExportBlueprintDialog";
import { GenerateProgress } from "./GenerateProgress";
import type { GenerateMessage, GenerateRequest } from "./generate.worker";
import { ItemLegend } from "./ItemLegend";
import { useFactoryStore } from "../../store/useFactoryStore";
import { BuildInfoPanel } from "./BuildInfoPanel";
import { BuildPalette } from "./BuildPalette";
import { BuildToolbar, type BuildViewMode } from "./BuildToolbar";
import { LayerGrid, type BuildTool } from "./LayerGrid";
import { ModuleGroupsPanel } from "./ModuleGroupsPanel";
import { View3D } from "./View3D";

const EMPTY: Placement[] = [];

/** What's under the pointer in the level grid */
function HoverInfo({ placements }: { placements: Placement[] }) {
    if (placements.length === 0) return null;
    return (
        <span className="text-[var(--text-secondary)]">
            Here:{" "}
            {placements.map((p, i) => (
                <span key={p.uid}>
                    {i > 0 && " + "}
                    <b className="text-[var(--text-primary)]">{buildingName(p.id)}</b>
                    {p.label && (
                        <span style={{ color: p.lane ? BELT_COLORS[p.lane] : undefined }}>
                            {" "}
                            ({p.lane === "in" ? "in: " : p.lane === "out" ? "out: " : ""}
                            {p.label})
                        </span>
                    )}
                </span>
            ))}
        </span>
    );
}
const HISTORY_LIMIT = 50;

/** Identifies the plan a module was generated for: its steps and machine counts */
function planKeyOf(steps: ModuleStep[]): string {
    return steps.map((s) => `${s.nodeKey}:${s.machines}`).join("|");
}

export function BuildPlanner() {
    const factory = useFactoryStore((s) => s.factories.find((f) => f.id === s.activeFactoryId));
    const setBuildLayout = useFactoryStore((s) => s.setBuildLayout);
    const unlocks = useFactoryStore((s) => s.buildUnlocks);
    const setUnlocks = useFactoryStore((s) => s.setBuildUnlocks);

    const layout = factory?.buildLayout;
    const placements = layout?.placements ?? EMPTY;
    const options = useMemo(() => ({ ...DEFAULT_MODULE_OPTIONS, ...layout?.options }), [layout?.options]);
    const report = factory?.beltReport ?? null;

    const [tool, setTool] = useState<BuildTool | null>(null);
    const [level, setLevel] = useState(0);
    const [selectedUid, setSelectedUid] = useState<string | null>(null);
    const [cellSize, setCellSize] = useState(22);
    const [view, setView] = useState<BuildViewMode>("split");
    const [cutAbove, setCutAbove] = useState(false);
    const [showSupports, setShowSupports] = useState(true);
    const [showLabels, setShowLabels] = useState(true);
    const [showPorts, setShowPorts] = useState(true);
    const [hoverCell, setHoverCell] = useState<[number, number] | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
    const worker = useRef<Worker | null>(null);

    const undoStack = useRef<BuildLayoutState[]>([]);
    const redoStack = useRef<BuildLayoutState[]>([]);
    const uidCounter = useRef(0);
    const makeUid = useCallback(() => `p${Date.now().toString(36)}-${++uidCounter.current}`, []);

    const fuel = factory?.config.selectedFuel;
    const steps = useMemo(() => (report ? stepsFromReport(report, fuel) : []), [report, fuel]);
    const stepIndex = useMemo(() => new Map(steps.map((s, i) => [s.nodeKey, i])), [steps]);
    const [highlightItem, setHighlightItem] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);

    const occupancy = useMemo(() => buildOccupancy(placements), [placements]);
    const issues = useMemo(() => placements.flatMap((p) => placementIssues(p, occupancy)), [placements, occupancy]);
    const issuesByUid = useMemo(() => {
        const map = new Map<string, LayoutIssue[]>();
        issues.forEach((i) => map.set(i.uid, [...(map.get(i.uid) ?? []), i]));
        return map;
    }, [issues]);
    const ports = useMemo(() => portConnections(placements), [placements]);
    // One colour per item, in production order: what each step makes, then what comes in from outside
    const itemColors = useMemo(() => {
        const order = [
            ...steps.map((st) => st.itemName),
            ...steps.flatMap((st) => [...st.outputs, ...st.inputs].map((fl) => fl.itemName)),
            ...(layout?.io ?? []).map((p) => p.itemName),
            ...placements.map(carriedItem).filter((i): i is string => !!i),
        ];
        return itemColorMap(order.filter((item) => placements.some((p) => carriedItem(p) === item)));
    }, [steps, layout?.io, placements]);
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
        // Hand-drawn belts pick up the item that reaches them, for colour and tooltip
        (next: Placement[]) => commit({ ...(layout ?? {}), placements: inferBeltItems(next) }),
        [commit, layout],
    );

    const flash = (text: string) => {
        setMessage(text);
        setTimeout(() => setMessage((m) => (m === text ? null : m)), 2500);
    };

    const runGenerate = (given: typeof options) => {
        if (!report || steps.length === 0) return;
        // Modules made for another plan (the product isn't in any of them): suggest them anew
        const finals = report.targets.map((t) => t.itemName);
        const grouped = new Set((given.moduleGroups ?? []).flat());
        const stale = given.modules && steps.some((st) => finals.includes(st.itemName) && !grouped.has(st.nodeKey));
        const opts = stale ? { ...given, moduleGroups: suggestModuleGroups(steps, { finalProducts: finals, beltSpeed: report.beltSpeed }) } : given;
        const tooBig = moduleTooBig(steps);
        if (tooBig) {
            setMessage(
                `This plan needs ${tooBig.machines.toLocaleString()} machines (${Math.ceil(tooBig.biggest.machines).toLocaleString()}× ${buildingName(tooBig.biggest.deviceId)} for ${tooBig.biggest.itemName}) - too many for one module. Lower the rate or split the plan.`,
            );
            return;
        }
        // Layout and routing run in a worker: the page stays usable and shows progress
        worker.current?.terminate();
        const w = new Worker(new URL("./generate.worker.ts", import.meta.url));
        worker.current = w;
        setMessage(null);
        setProgress({ fraction: 0, label: "Starting" });
        w.onmessage = (event: MessageEvent<GenerateMessage>) => {
            const msg = event.data;
            if (msg.type === "progress") {
                setProgress({ fraction: msg.fraction, label: msg.label });
                return;
            }
            w.terminate();
            worker.current = null;
            setProgress(null);
            if (msg.type === "error") {
                setMessage(`Generating failed: ${msg.message}`);
                return;
            }
            const mod = msg.module;
            commit({ placements: mod.placements, options: opts, tiers: mod.tiers, routes: mod.routes, io: mod.io, surplus: mod.surplus, planKey: planKeyOf(steps) });
            const failed = mod.routes.filter((r) => !r.ok).length;
            flash(failed ? `${failed} belt connection${failed === 1 ? "" : "s"} could not be routed` : `All ${mod.routes.length} belt connections routed`);
            setLevel(0);
            setSelectedUid(null);
        };
        // Final products always leave at the edge; surplus only if the player chose it.
        // Fertilizer and fuel the factory buys reach their machines from outside.
        // Module groups only count while "Build as modules" is on
        const config = factory?.config;
        // (unset means made in the factory, as in the planner)
        const boughtItems = [config?.selfFertilizer === false ? config.selectedFertilizer : undefined, config?.selfFuel === false ? config.selectedFuel : undefined].filter((i): i is string => !!i);
        const request: GenerateRequest = {
            steps,
            options: { ...opts, moduleGroups: opts.modules ? opts.moduleGroups : undefined, beltSpeed: report.beltSpeed, finalProducts: report.targets.map((t) => t.itemName), unlocks, boughtItems },
        };
        w.postMessage(request);
    };

    const abortGenerate = () => {
        worker.current?.terminate();
        worker.current = null;
        setProgress(null);
        flash("Generating aborted");
    };

    // A running generation doesn't outlive the view
    useEffect(() => () => worker.current?.terminate(), []);

    const handleGenerate = () => {
        if (placements.length > 0 && !window.confirm("Replace the current layout with a generated module?")) return;
        runGenerate(options);
    };

    /** Send an item's surplus out at the edge (via a priority splitter) or keep it in the line, then lay out again */
    const toggleExport = (itemName: string, on: boolean) => {
        const chosen = options.exportItems ?? [];
        runGenerate({ ...options, exportItems: on ? [...new Set([...chosen, itemName])] : chosen.filter((i) => i !== itemName) });
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
    const locked = lockedBuildings(new Set(placements.map((p) => p.id)), unlocks);

    return (
        <div className="flex flex-col h-[calc(100vh-2rem)] min-h-[680px]">
            {exporting && (
                <ExportBlueprintDialog
                    placements={placements}
                    itemColors={itemColors}
                    defaultTitle={`${factory.name}: ${report?.targets.map((t) => t.itemName).join(", ") || "module"}`}
                    mainItem={report?.targets[0]?.itemName}
                    locked={locked}
                    onClose={() => setExporting(false)}
                />
            )}
            <BuildToolbar
                options={options}
                onOptionsChange={(next) => factory && setBuildLayout(factory.id, { ...(layout ?? { placements: [] }), options: next })}
                canGenerate={steps.length > 0 && !progress}
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
                showSupports={showSupports}
                onShowSupportsChange={setShowSupports}
                showLabels={showLabels}
                onShowLabelsChange={setShowLabels}
                showPorts={showPorts}
                onShowPortsChange={setShowPorts}
                onUndo={undo}
                onRedo={redo}
                onExport={() => (placements.length > 0 ? setExporting(true) : flash("Nothing to export yet"))}
                unlocks={unlocks}
                onUnlocksChange={setUnlocks}
            />
            {progress && <GenerateProgress fraction={progress.fraction} label={progress.label} onAbort={abortGenerate} />}
            <div className="flex flex-1 min-h-0">
                <aside className="w-56 shrink-0 border-r border-[var(--border)] p-3 overflow-y-auto custom-scrollbar flex flex-col gap-4">
                    <ModuleGroupsPanel
                        steps={steps}
                        enabled={!!options.modules}
                        groups={options.moduleGroups ?? []}
                        finalProducts={report?.targets.map((t) => t.itemName) ?? []}
                        beltSpeed={report?.beltSpeed}
                        onChange={(modules, moduleGroups) => setBuildLayout(factory.id, { ...(layout ?? { placements: [] }), options: { ...options, modules, moduleGroups } })}
                    />
                    <BuildPalette steps={steps} placedByNode={placedByNode} tool={tool} onSelectTool={setTool} />
                </aside>

                <div className="flex-1 min-w-0 flex flex-col">
                    <div className="px-3 py-1.5 text-[11px] text-[var(--text-muted)] border-b border-[var(--border)] flex flex-wrap gap-x-4 gap-y-1">
                        {tool ? (
                            <span>
                                Placing <b className="text-[var(--accent-gold)]">{buildingName(tool.id)}</b>
                                {tool.label ? ` for ${tool.label}` : ""}: click to place
                                {tool.id.startsWith("belt") ? ", drag to draw a belt along your path (drag back to undo)" : ""} · R rotate · F variant · Esc stop
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
                        {layout?.planKey && placements.length > 0 && layout.planKey !== planKeyOf(steps) && (
                            <span className="text-[var(--warning)]" title="The production plan (targets, options such as the cauldron, research) changed after this module was generated">
                                Plan changed since this module was generated: generate again
                            </span>
                        )}
                        {locked.length > 0 && (
                            <span className="text-[var(--warning)]" title="Not unlocked at your level (see Unlocks). The game won't place a blueprint with these.">
                                Locked: {locked.join(", ")}
                            </span>
                        )}
                        {hoverCell && <HoverInfo placements={placementsAt(placements, hoverCell[0], hoverCell[1], level)} />}
                    </div>
                    <ItemLegend itemColors={itemColors} highlightItem={highlightItem} onHighlight={setHighlightItem} />
                    <div className={view === "split" ? "flex-1 min-h-0 grid grid-rows-2 xl:grid-rows-1 xl:grid-cols-2" : "flex-1 min-h-0 flex"}>
                        {view !== "3d" && (
                            <div className="overflow-auto custom-scrollbar min-h-0 flex-1">
                                <LayerGrid
                                    placements={placements}
                                    occupancy={occupancy}
                                    level={level}
                                    issuesByUid={issuesByUid}
                                    ports={ports}
                                    itemColors={itemColors}
                                    highlightItem={highlightItem}
                                    selectedUid={selectedUid}
                                    tool={tool}
                                    cellSize={cellSize}
                                    showSupports={showSupports}
                                    makeUid={makeUid}
                                    onPlace={handlePlace}
                                    onRemoveAt={handleRemoveAt}
                                    onSelectAt={handleSelectAt}
                                    onHoverCell={setHoverCell}
                                />
                            </div>
                        )}
                        {view !== "2d" && (
                            <div className="min-h-0 flex-1 border-l border-[var(--border)] bg-[var(--background-deep)]">
                                <View3D
                                    placements={placements}
                                    tiers={layout?.tiers ?? []}
                                    io={layout?.io ?? []}
                                    ports={ports}
                                    showSupports={showSupports}
                                    showLabels={showLabels}
                                    showPorts={showPorts}
                                    itemColors={itemColors}
                                    highlightItem={highlightItem}
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
                        routes={layout?.routes ?? []}
                        io={layout?.io ?? []}
                        surplus={layout?.surplus ?? []}
                        finalProducts={report?.targets.map((t) => t.itemName) ?? []}
                        onToggleExport={toggleExport}
                        onSelect={setSelectedUid}
                        onGoToLevel={setLevel}
                    />
                </aside>
            </div>
        </div>
    );
}
