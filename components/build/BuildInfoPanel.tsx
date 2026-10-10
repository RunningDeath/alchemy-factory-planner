"use client";

import { useMemo } from "react";
import type { TierInfo } from "../../engine/build/generator";
import { billOfMaterials, countBuildings, layoutBounds, type LayoutIssue, type Placement, type PortStatus } from "../../engine/build/layout";
import { buildingName, isMachine, itemDisplayName } from "../../lib/buildCatalog";
import { formatRate } from "../../lib/beltDisplay";

interface BuildInfoPanelProps {
    placements: Placement[];
    issues: LayoutIssue[];
    ports: PortStatus[];
    tiers: TierInfo[];
    onSelect: (uid: string) => void;
    onGoToLevel: (z: number) => void;
}

const ISSUE_TEXT: Record<LayoutIssue["kind"], string> = {
    collision: "overlaps another building",
    unsupported: "has nothing to stand on",
    underground: "is below the ground",
    unknown: "unknown building",
};

export function BuildInfoPanel({ placements, issues, ports, tiers, onSelect, onGoToLevel }: BuildInfoPanelProps) {
    const byUid = useMemo(() => new Map(placements.map((p) => [p.uid, p])), [placements]);
    const bounds = useMemo(() => layoutBounds(placements), [placements]);
    const bill = useMemo(() => [...billOfMaterials(placements).entries()].sort((a, b) => b[1] - a[1]), [placements]);
    const counts = useMemo(() => [...countBuildings(placements).entries()].sort((a, b) => b[1] - a[1]), [placements]);
    const openPorts = useMemo(
        () => ports.filter((s) => !s.connectedTo && s.port.medium === "belt" && isMachine(byUid.get(s.port.uid)!)),
        [ports, byUid],
    );

    return (
        <div className="flex flex-col gap-4 text-xs">
            <section className="flex flex-col gap-1">
                <h4 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold">Module</h4>
                {bounds ? (
                    <p className="text-[var(--text-secondary)]">
                        <span className="font-mono text-[var(--text-primary)]">
                            {bounds.size[0]} × {bounds.size[1]} × {bounds.size[2]}
                        </span>{" "}
                        cells (W × D × H), {placements.length} buildings
                    </p>
                ) : (
                    <p className="text-[var(--text-muted)]">Empty. Generate from the plan or place buildings.</p>
                )}
            </section>

            <section className="flex flex-col gap-1">
                <h4 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold">Checks</h4>
                {issues.length === 0 && openPorts.length === 0 && placements.length > 0 && (
                    <p className="text-[var(--success)]">No collisions, everything supported, all machine ports belted.</p>
                )}
                {issues.slice(0, 12).map((issue, i) => {
                    const p = byUid.get(issue.uid);
                    return (
                        <button
                            key={i}
                            onClick={() => {
                                onSelect(issue.uid);
                                if (p) onGoToLevel("cell" in issue ? issue.cell[2] : p.z);
                            }}
                            className="text-left text-[var(--error)] hover:underline cursor-pointer"
                        >
                            {p ? buildingName(p.id) : issue.uid} {ISSUE_TEXT[issue.kind]}
                            {"cell" in issue && <span className="text-[var(--text-muted)]"> (level {issue.cell[2]})</span>}
                        </button>
                    );
                })}
                {issues.length > 12 && <p className="text-[var(--text-muted)]">…and {issues.length - 12} more</p>}
                {openPorts.length > 0 && (
                    <p className="text-[var(--warning)]">
                        {openPorts.length} machine port{openPorts.length === 1 ? "" : "s"} without a belt (red markers)
                    </p>
                )}
            </section>

            {tiers.length > 0 && (
                <section className="flex flex-col gap-2">
                    <h4 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold">Blocks</h4>
                    {tiers.map((t) => (
                        <div key={t.index} className="flex flex-col gap-0.5 border-l-2 border-[var(--accent-gold-dim)] pl-2">
                            <button onClick={() => onGoToLevel(t.z)} className="text-left cursor-pointer hover:underline">
                                <span className="font-semibold text-[var(--text-primary)]">{t.itemName}</span>{" "}
                                <span className="text-[var(--text-muted)]">
                                    · {t.machines}× {buildingName(t.deviceId)} · at {t.x ?? 0},{t.y ?? 0} · {t.width}×{t.depth}×{t.height}
                                    {t.levels > 1 ? ` · ${t.levels} levels ${t.stacking === "beam-deck" ? "on beam decks" : "stacked directly"}` : ""}
                                </span>
                            </button>
                            {t.lanes.map((lane, i) => (
                                <span key={i} className={lane.overBelt ? "text-[var(--error)]" : "text-[var(--text-secondary)]"}>
                                    {lane.kind === "in" ? "in" : "out"} belt {i + 1}
                                    {t.levels > 1 ? ` (level ${lane.z})` : ""}: {formatRate(lane.rate)}/m{" "}
                                    <span className="text-[var(--text-muted)]">
                                        {lane.items.map((f) => f.itemName).join(" + ")}
                                        {lane.items.length > 1 ? " (mixed)" : ""}
                                    </span>
                                </span>
                            ))}
                            {t.fluidInputs.length > 0 && <span className="text-[var(--info)]">Pipe in: {t.fluidInputs.join(", ")}</span>}
                            {t.offLanePorts > 0 && (
                                <span className="text-[var(--warning)]">{t.offLanePorts} port(s) need a manual belt</span>
                            )}
                        </div>
                    ))}
                    <p className="text-[var(--text-muted)]">
                        Input lanes enter at the top edge of each block, output lanes leave at the bottom edge. Connect the
                        blocks with belts (and lifts for upper levels).
                    </p>
                </section>
            )}

            {counts.length > 0 && (
                <section className="flex flex-col gap-1">
                    <h4 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold">Buildings</h4>
                    {counts.map(([id, count]) => (
                        <div key={id} className="flex justify-between gap-2">
                            <span className="text-[var(--text-secondary)]">{buildingName(id)}</span>
                            <span className="font-mono text-[var(--text-primary)]">{count}</span>
                        </div>
                    ))}
                </section>
            )}

            {bill.length > 0 && (
                <section className="flex flex-col gap-1">
                    <h4 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold">Build cost</h4>
                    {bill.map(([item, count]) => (
                        <div key={item} className="flex justify-between gap-2">
                            <span className="text-[var(--text-secondary)]">{itemDisplayName(item)}</span>
                            <span className="font-mono text-[var(--text-primary)]">{count}</span>
                        </div>
                    ))}
                </section>
            )}
        </div>
    );
}
