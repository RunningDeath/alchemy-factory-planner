"use client";

import { useMemo, useState } from "react";
import type { ModuleStep } from "../../engine/build/generator";
import { buildingName, paletteGroups } from "../../lib/buildCatalog";
import { cn } from "../../lib/utils";
import type { BuildTool } from "./LayerGrid";

interface BuildPaletteProps {
    steps: ModuleStep[];
    /** Placed machines per plan node */
    placedByNode: Map<string, number>;
    tool: BuildTool | null;
    onSelectTool: (tool: BuildTool | null) => void;
}

export function BuildPalette({ steps, placedByNode, tool, onSelectTool }: BuildPaletteProps) {
    const groups = useMemo(() => paletteGroups(), []);
    const [openGroup, setOpenGroup] = useState<string>("Logistics");

    const pick = (next: BuildTool) =>
        onSelectTool(tool && tool.id === next.id && tool.nodeKey === next.nodeKey ? null : { ...next, rot: tool?.rot ?? 0 });

    return (
        <div className="flex flex-col gap-3 text-xs">
            <div className="flex flex-col gap-1">
                <h4 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold">From plan</h4>
                {steps.length === 0 && <p className="text-[var(--text-muted)]">No machines in the plan yet.</p>}
                {steps.map((step) => {
                    const placed = placedByNode.get(step.nodeKey) ?? 0;
                    const done = placed >= step.machines;
                    const active = tool?.nodeKey === step.nodeKey;
                    return (
                        <button
                            key={step.nodeKey}
                            onClick={() => pick({ id: step.deviceId, rot: 0, nodeKey: step.nodeKey, label: step.itemName })}
                            className={cn(
                                "flex items-center justify-between gap-2 px-2 py-1.5 rounded border text-left cursor-pointer transition-colors",
                                active
                                    ? "border-[var(--accent-gold)] bg-[var(--accent-gold)]/10"
                                    : "border-[var(--border)] hover:border-[var(--accent-gold-dim)]",
                            )}
                        >
                            <span className="flex flex-col">
                                <span className="text-[var(--text-primary)] font-semibold">{step.itemName}</span>
                                <span className="text-[10px] text-[var(--text-muted)]">{buildingName(step.deviceId)}</span>
                            </span>
                            <span className={cn("font-mono font-bold", done ? "text-[var(--success)]" : "text-[var(--warning)]")}>
                                {placed}/{step.machines}
                            </span>
                        </button>
                    );
                })}
            </div>

            {groups.map((group) => (
                <div key={group.label} className="flex flex-col gap-1">
                    <button
                        onClick={() => setOpenGroup(openGroup === group.label ? "" : group.label)}
                        className="text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold hover:text-[var(--text-secondary)] cursor-pointer"
                    >
                        {openGroup === group.label ? "▾" : "▸"} {group.label}
                    </button>
                    {openGroup === group.label && (
                        <div className="grid grid-cols-1 gap-1">
                            {group.buildings.map((fp) => {
                                const active = tool?.id === fp.id && !tool.nodeKey;
                                return (
                                    <button
                                        key={fp.id}
                                        onClick={() => pick({ id: fp.id, rot: 0 })}
                                        title={`${fp.size.x}×${fp.size.y}×${fp.size.z} cells`}
                                        className={cn(
                                            "flex items-center justify-between gap-2 px-2 py-1 rounded border text-left cursor-pointer transition-colors",
                                            active
                                                ? "border-[var(--accent-gold)] bg-[var(--accent-gold)]/10"
                                                : "border-transparent hover:border-[var(--border)]",
                                        )}
                                    >
                                        <span className="text-[var(--text-secondary)]">{fp.name}</span>
                                        <span className="text-[10px] font-mono text-[var(--text-muted)]">
                                            {fp.size.x}×{fp.size.y}×{fp.size.z}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
