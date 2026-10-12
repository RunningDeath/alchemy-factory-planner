"use client";

import { useState, type DragEvent, type ReactNode } from "react";
import { Wand2, X } from "lucide-react";
import type { ModuleStep } from "../../engine/build/generator";
import { moduleProduct, suggestModuleGroups } from "../../engine/build/module-groups";
import { buildingName } from "../../lib/buildCatalog";
import { cn } from "../../lib/utils";

interface ModuleGroupsPanelProps {
    steps: ModuleStep[];
    /** Build as modules (off: one module for everything, as before) */
    enabled: boolean;
    /** Step nodeKeys per module */
    groups: string[][];
    finalProducts: string[];
    beltSpeed?: number;
    onChange: (enabled: boolean, groups: string[][]) => void;
}

/** Where a dragged step goes: a module, a new module, or out of every module */
type DropTarget = number | "new" | "none";

const DRAG_TYPE = "text/plain";

/**
 * Which steps are built together as one module (stacked into towers, inputs at its front,
 * outputs at its back). Steps are dragged between modules; Suggest fills them from the plan.
 */
export function ModuleGroupsPanel({ steps, enabled, groups, finalProducts, beltSpeed, onChange }: ModuleGroupsPanelProps) {
    const [over, setOver] = useState<DropTarget | null>(null);
    const byKey = new Map(steps.map((st) => [st.nodeKey, st]));
    // Steps that left the plan drop out; empty modules go
    const current = groups.map((g) => g.filter((k) => byKey.has(k))).filter((g) => g.length > 0);
    const grouped = new Set(current.flat());
    const loose = steps.filter((st) => !grouped.has(st.nodeKey));
    const suggest = () => suggestModuleGroups(steps, { finalProducts, beltSpeed });

    const move = (key: string, target: DropTarget) => {
        const without = current.map((g) => g.filter((k) => k !== key));
        const next = target === "new" ? [...without, [key]] : target === "none" ? without : without.map((g, i) => (i === target ? [...g, key] : g));
        // Keep each module's steps in production order
        const order = new Map(steps.map((st, i) => [st.nodeKey, i]));
        onChange(enabled, next.filter((g) => g.length > 0).map((g) => [...g].sort((a, b) => order.get(a)! - order.get(b)!)));
    };

    const dropProps = (target: DropTarget) => ({
        onDragOver: (e: DragEvent) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (over !== target) setOver(target);
        },
        onDragLeave: () => setOver((o) => (o === target ? null : o)),
        onDrop: (e: DragEvent) => {
            e.preventDefault();
            setOver(null);
            const key = e.dataTransfer.getData(DRAG_TYPE);
            if (byKey.has(key)) move(key, target);
        },
    });

    const zoneClass = (target: DropTarget) =>
        cn("flex flex-col gap-1 p-1.5 rounded border border-dashed transition-colors", over === target ? "border-[var(--accent-gold)] bg-[var(--accent-gold)]/10" : "border-[var(--border)]");

    const stepChip = (st: ModuleStep): ReactNode => (
        <div
            key={st.nodeKey}
            draggable
            onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, st.nodeKey);
                e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => setOver(null)}
            title="Drag into another module"
            className="flex items-center justify-between gap-2 px-1.5 py-1 rounded bg-[var(--surface-elevated)] border border-[var(--border)] cursor-grab active:cursor-grabbing"
        >
            <span className="text-[var(--text-primary)] font-semibold truncate">{st.itemName}</span>
            <span className="text-[10px] text-[var(--text-muted)] font-mono shrink-0">
                {st.machines}× {buildingName(st.deviceId)}
            </span>
        </div>
    );

    return (
        <div className="flex flex-col gap-2 text-xs">
            <div className="flex items-center justify-between gap-2">
                <h4 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold">Modules</h4>
                <button
                    onClick={() => onChange(true, suggest())}
                    disabled={steps.length === 0}
                    className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-[var(--text-secondary)] hover:text-[var(--accent-gold)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    title="One module per product: the step that makes it and the steps that only feed it. Big modules are split at their biggest feeder chain (unless it sends many belts)."
                >
                    <Wand2 size={11} /> Suggest
                </button>
            </div>
            <label
                className="flex items-center gap-1.5 text-[var(--text-secondary)] cursor-pointer"
                title="Build each module on its own (stacked into towers, inputs at its front, outputs at its back), stand them side by side and belt them together. Off: one module for the whole plan."
            >
                <input
                    type="checkbox"
                    checked={enabled}
                    // Turning it on for the first time starts from the suggestion
                    onChange={(e) => onChange(e.target.checked, e.target.checked && current.length === 0 ? suggest() : current)}
                    className="accent-[var(--accent-gold)]"
                />
                Build as modules
            </label>

            {enabled && (
                <>
                    {current.map((group, i) => (
                        <div key={i} className={zoneClass(i)} {...dropProps(i)}>
                            <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-[var(--accent-gold)] font-bold">
                                <span className="truncate">
                                    Module {i + 1}: {moduleProduct(steps, group)}
                                </span>
                                <button
                                    onClick={() => onChange(enabled, current.filter((_, j) => j !== i))}
                                    className="text-[var(--text-muted)] hover:text-[var(--accent-gold)] cursor-pointer"
                                    title="Dissolve this module (its steps go back to the rest)"
                                >
                                    <X size={11} />
                                </button>
                            </div>
                            {group.map((k) => stepChip(byKey.get(k)!))}
                        </div>
                    ))}
                    <div className={cn(zoneClass("new"), "items-center py-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]")} {...dropProps("new")}>
                        Drop here for a new module
                    </div>
                    <div className={zoneClass("none")} {...dropProps("none")}>
                        <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">Not in a module</span>
                        {loose.length === 0 ? (
                            <span className="text-[10px] text-[var(--text-muted)]">Every step is in a module.</span>
                        ) : (
                            <>
                                <span className="text-[10px] text-[var(--text-muted)]">Laid out together as usual, as one more module.</span>
                                {loose.map(stepChip)}
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
