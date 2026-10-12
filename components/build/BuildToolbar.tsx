"use client";

import { ChevronDown, ChevronUp, Download, FlipHorizontal2, Redo2, RotateCw, Sparkles, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { useState } from "react";
import type { ModuleOptions } from "../../engine/build/generator";
import type { BuildUnlocks } from "../../engine/build/unlocks";
import { buildingName } from "../../lib/buildCatalog";
import { cn } from "../../lib/utils";
import type { BuildTool } from "./LayerGrid";
import { UnlocksMenu } from "./UnlocksMenu";

export type BuildViewMode = "2d" | "split" | "3d";
type GeneratorOptions = Omit<ModuleOptions, "beltSpeed" | "unlocks">;

interface BuildToolbarProps {
    options: GeneratorOptions;
    onOptionsChange: (options: GeneratorOptions) => void;
    canGenerate: boolean;
    onGenerate: () => void;
    onClear: () => void;
    level: number;
    onLevelChange: (level: number) => void;
    tool: BuildTool | null;
    onRotate: () => void;
    onVariant: () => void;
    cellSize: number;
    onCellSizeChange: (size: number) => void;
    view: BuildViewMode;
    onViewChange: (view: BuildViewMode) => void;
    cutAbove: boolean;
    onCutAboveChange: (cut: boolean) => void;
    showSupports: boolean;
    onShowSupportsChange: (show: boolean) => void;
    showLabels: boolean;
    onShowLabelsChange: (show: boolean) => void;
    showPorts: boolean;
    onShowPortsChange: (show: boolean) => void;
    onUndo: () => void;
    onRedo: () => void;
    onExport: () => void;
    unlocks: BuildUnlocks;
    onUnlocksChange: (unlocks: BuildUnlocks) => void;
}

const buttonClass =
    "px-2 py-1.5 rounded-md flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent-gold)] hover:border-[var(--accent-gold-dim)] disabled:opacity-40 disabled:cursor-not-allowed";

function NumberField({ label, value, min, max, onChange, title }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; title: string }) {
    // Typed freely; the value is checked and applied on Enter or when leaving the field
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
        if (draft === null) return;
        const v = Number(draft);
        if (draft.trim() !== "" && Number.isFinite(v)) onChange(Math.min(max, Math.max(min, Math.round(v))));
        setDraft(null);
    };
    return (
        <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]" title={`${title} (${min}–${max})`}>
            {label}
            <input
                type="number"
                min={min}
                max={max}
                value={draft ?? value}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    if (e.key === "Escape") setDraft(null);
                }}
                className="w-12 bg-[var(--background)] border border-[var(--border)] rounded px-1 py-0.5 text-[var(--text-primary)] font-mono text-xs"
            />
        </label>
    );
}

export function BuildToolbar(props: BuildToolbarProps) {
    const { options, onOptionsChange, tool, view } = props;
    return (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)]/60 pt-12 lg:pt-3">
            <button onClick={props.onGenerate} disabled={!props.canGenerate} className={cn(buttonClass, "text-[var(--accent-gold)] border-[var(--accent-gold-dim)]")} title="Lay out every machine of the plan as a stacked module">
                <Sparkles size={12} /> Generate module
            </button>
            <NumberField label="Max W" value={options.maxWidth} min={4} max={64} title="Module width in cells; blocks wrap into a new row past this (a wooden floor is 16)" onChange={(maxWidth) => onOptionsChange({ ...options, maxWidth })} />
            <NumberField label="Max D" value={options.maxDepth} min={4} max={64} title="Deepest a block may get, in cells" onChange={(maxDepth) => onOptionsChange({ ...options, maxDepth })} />
            <NumberField label="Max H" value={options.maxHeight} min={3} max={64} title="Module height in cells (one storey = 16)" onChange={(maxHeight) => onOptionsChange({ ...options, maxHeight })} />
            <NumberField label="Levels" value={options.maxStack} min={1} max={16} title="Most machine levels per block (grinders stack directly, other machines on beam decks)" onChange={(maxStack) => onOptionsChange({ ...options, maxStack })} />
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer" title="Let belts cross gaps on drawbridge conveyors (only the anchor needs support). Needs the unlock and costs linen rope.">
                <input type="checkbox" checked={!!options.useBridges} onChange={(e) => onOptionsChange({ ...options, useBridges: e.target.checked })} className="accent-[var(--accent-gold)]" />
                Bridges
            </label>
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer" title="Put small blocks on top of others (on beam decks and wood block columns) to save floor space">
                <input type="checkbox" checked={options.stackBlocks !== false} onChange={(e) => onOptionsChange({ ...options, stackBlocks: e.target.checked })} className="accent-[var(--accent-gold)]" />
                Stack blocks
            </label>
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer" title="Purchasing portals next to the machines that use raw materials (logs, limestone, ores, seeds), all paid through one coin belt from outside. Needs the purchasing portal unlock; otherwise raw materials come in at the edge.">
                <input type="checkbox" checked={options.buyRaw !== false} onChange={(e) => onOptionsChange({ ...options, buyRaw: e.target.checked })} className="accent-[var(--accent-gold)]" />
                Buy raw materials in the module
            </label>
            <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]" title="Where output nobody in the module needs goes (byproducts, overflow), so it doesn't block the belts. Auto: knowledge altar, else trash barrel, else dispatch portal, whichever is unlocked">
                Leftovers
                <select
                    value={options.disposal ?? "auto"}
                    onChange={(e) => onOptionsChange({ ...options, disposal: e.target.value === "auto" ? undefined : (e.target.value as NonNullable<GeneratorOptions["disposal"]>) })}
                    className="bg-[var(--background)] border border-[var(--border)] rounded px-1 py-0.5 text-[var(--text-primary)] normal-case tracking-normal"
                >
                    <option value="auto">Auto</option>
                    <option value="altar">Knowledge altar</option>
                    <option value="trash">Trash barrel</option>
                    <option value="sell">Dispatch portal</option>
                    <option value="export">Send out</option>
                </select>
            </label>
            <UnlocksMenu unlocks={props.unlocks} onChange={props.onUnlocksChange} buttonClass={buttonClass} />

            <span className="w-px h-6 bg-[var(--border)] mx-1" />

            <div className="flex items-center gap-1">
                <button onClick={() => props.onLevelChange(props.level - 1)} className={buttonClass} title="Level down (Q)">
                    <ChevronDown size={12} />
                </button>
                <span className="text-xs font-mono text-[var(--text-primary)] min-w-[64px] text-center">Level {props.level}</span>
                <button onClick={() => props.onLevelChange(props.level + 1)} className={buttonClass} title="Level up (E)">
                    <ChevronUp size={12} />
                </button>
            </div>
            <button onClick={props.onRotate} disabled={!tool} className={buttonClass} title="Rotate (R)">
                <RotateCw size={12} /> {tool ? `${tool.rot * 90}°` : "Rotate"}
            </button>
            <button onClick={props.onVariant} disabled={!tool || !tool.id} className={buttonClass} title="Next build option, e.g. mirrored or another belt shape (F)">
                <FlipHorizontal2 size={12} /> {tool ? buildingName(tool.id) : "Variant"}
            </button>

            <span className="w-px h-6 bg-[var(--border)] mx-1" />

            <button onClick={props.onUndo} className={buttonClass} title="Undo (Ctrl+Z)">
                <Undo2 size={12} />
            </button>
            <button onClick={props.onRedo} className={buttonClass} title="Redo (Ctrl+Y)">
                <Redo2 size={12} />
            </button>
            <button onClick={() => props.onCellSizeChange(Math.max(10, props.cellSize - 4))} className={buttonClass} title="Zoom out">
                <ZoomOut size={12} />
            </button>
            <button onClick={() => props.onCellSizeChange(Math.min(48, props.cellSize + 4))} className={buttonClass} title="Zoom in">
                <ZoomIn size={12} />
            </button>
            <button onClick={props.onClear} className={buttonClass} title="Remove everything">
                <Trash2 size={12} />
            </button>
            <button onClick={props.onExport} className={buttonClass} title="Download the layout as a blueprint file for the game">
                <Download size={12} /> Blueprint
            </button>

            <div className="flex-1" />

            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer" title="Show lab stands, metal stands and blocks">
                <input type="checkbox" checked={props.showSupports} onChange={(e) => props.onShowSupportsChange(e.target.checked)} className="accent-[var(--accent-gold)]" />
                Supports
            </label>
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer" title="Names of blocks and the items going in and out, in 3D">
                <input type="checkbox" checked={props.showLabels} onChange={(e) => props.onShowLabelsChange(e.target.checked)} className="accent-[var(--accent-gold)]" />
                Labels
            </label>
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer" title="Arrows on machine inputs/outputs and on belts, in 3D">
                <input type="checkbox" checked={props.showPorts} onChange={(e) => props.onShowPortsChange(e.target.checked)} className="accent-[var(--accent-gold)]" />
                Ports
            </label>
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer" title="Hide everything above the current level in 3D">
                <input type="checkbox" checked={props.cutAbove} onChange={(e) => props.onCutAboveChange(e.target.checked)} className="accent-[var(--accent-gold)]" />
                Cut 3D at level
            </label>
            <div className="flex bg-[var(--surface)] p-1 rounded-lg border border-[var(--border)] gap-1">
                {(["2d", "split", "3d"] as BuildViewMode[]).map((mode) => (
                    <button
                        key={mode}
                        onClick={() => props.onViewChange(mode)}
                        className={cn(
                            "px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider cursor-pointer",
                            view === mode ? "text-[var(--accent-gold)] bg-[var(--accent-gold)]/10" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
                        )}
                    >
                        {mode}
                    </button>
                ))}
            </div>
        </div>
    );
}
