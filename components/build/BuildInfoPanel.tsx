"use client";

import { useMemo } from "react";
import type { TierInfo } from "../../engine/build/generator";
import type { IoPoint, RouteResult } from "../../engine/build/router";
import { billOfMaterials, countBuildings, layoutBounds, type LayoutIssue, type Placement, type PortStatus } from "../../engine/build/layout";
import { buildingName, isMachine, itemDisplayName, STARTER_BOX_COLOR } from "../../lib/buildCatalog";
import { formatRate } from "../../lib/beltDisplay";

interface BuildInfoPanelProps {
    placements: Placement[];
    issues: LayoutIssue[];
    ports: PortStatus[];
    tiers: TierInfo[];
    routes: RouteResult[];
    io: IoPoint[];
    surplus: { itemName: string; rate: number }[];
    finalProducts: string[];
    onToggleExport: (itemName: string, on: boolean) => void;
    onSelect: (uid: string) => void;
    onGoToLevel: (z: number) => void;
}

const ISSUE_TEXT: Record<LayoutIssue["kind"], string> = {
    collision: "overlaps another building",
    unsupported: "has nothing to stand on",
    underground: "is below the ground",
    unknown: "unknown building",
    unheated: "needs a heating device under it",
};

const DISPOSAL_LABEL = { altar: "Into a knowledge altar", trash: "Into a trash barrel", sell: "Sold at a dispatch portal" } as const;

export function BuildInfoPanel({ placements, issues, ports, tiers, routes, io, surplus, finalProducts, onToggleExport, onSelect, onGoToLevel }: BuildInfoPanelProps) {
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

            {placements.filter((p) => p.starterBox).map((box) => (
                <section key={box.uid} className="flex flex-col gap-1">
                    <h4 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold">Starter box</h4>
                    <button
                        onClick={() => {
                            onSelect(box.uid);
                            onGoToLevel(box.z);
                        }}
                        className="text-left cursor-pointer hover:underline"
                        style={{ color: STARTER_BOX_COLOR }}
                    >
                        Red box at {box.x},{box.y} (level {box.z}): fill it once with {box.label?.replace("Starter box: ", "")} to start the module
                    </button>
                    <p className="text-[var(--text-muted)]">The nurseries need fertilizer before the module makes its own. After that it just passes through.</p>
                </section>
            ))}

            {routes.length > 0 && <ConnectionsSection routes={routes} io={io} />}
            {routes.length > 0 && (
                <SurplusSection io={io} surplus={surplus} finalProducts={finalProducts} onToggle={onToggleExport} />
            )}

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
                                    {t.fedBy ? ` · each fed directly by a ${buildingName(t.fedBy.deviceId)} (${t.fedBy.itemName}), no belt between` : ""}
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

/** Belt connections between blocks, plus where items enter and leave the module */
function ConnectionsSection({ routes, io }: { routes: RouteResult[]; io: IoPoint[] }) {
    const failed = routes.filter((r) => !r.ok);
    // Group block-to-block connections by item and direction for a compact overview
    const groups = new Map<string, { itemName: string; from: string; to: string; rate: number; count: number }>();
    for (const r of routes) {
        if (!r.ok || r.from.includes("module edge") || r.to.includes("module edge")) continue;
        const key = `${r.itemName}|${r.from}|${r.to}`;
        const g = groups.get(key) ?? { itemName: r.itemName, from: r.from, to: r.to, rate: 0, count: 0 };
        g.rate += r.rate;
        g.count++;
        groups.set(key, g);
    }
    const sum = (kind: IoPoint["kind"]) => {
        const totals = new Map<string, number>();
        io.filter((p) => p.kind === kind).forEach((p) => totals.set(p.itemName, (totals.get(p.itemName) ?? 0) + p.rate));
        return [...totals.entries()];
    };
    return (
        <section className="flex flex-col gap-1">
            <h4 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold">Connections</h4>
            <p className={failed.length ? "text-[var(--warning)]" : "text-[var(--success)]"}>
                {routes.length - failed.length} of {routes.length} belt connections routed
            </p>
            {sum("import").map(([item, rate]) => (
                <span key={`i${item}`} className="text-[var(--info)]">
                    IN at the edge: {item} {formatRate(rate)}/m
                </span>
            ))}
            {sum("export").map(([item, rate]) => (
                <span key={`e${item}`} className="text-[var(--warning)]">
                    OUT at the edge: {item} {formatRate(rate)}/m
                </span>
            ))}
            {(["altar", "trash", "sell"] as const).flatMap((kind) =>
                sum(kind).map(([item, rate]) => (
                    <span key={`${kind}${item}`} className="text-[var(--text-muted)]">
                        {DISPOSAL_LABEL[kind]}: {item} {formatRate(rate)}/m
                    </span>
                )),
            )}
            {[...groups.values()].map((g) => (
                <span key={`${g.itemName}${g.from}${g.to}`} className="text-[var(--text-secondary)]">
                    {g.itemName} {formatRate(g.rate)}/m: {g.from} → {g.to}
                    {g.count > 1 ? <span className="text-[var(--text-muted)]"> ({g.count} belts)</span> : null}
                </span>
            ))}
            {failed.map((r, i) => (
                <span key={`f${i}`} className="text-[var(--error)]">
                    Not routed: {r.itemName} {formatRate(r.rate)}/m {r.from} → {r.to}
                </span>
            ))}
        </section>
    );
}

/**
 * Output nobody in the module uses (rounded-up machines). Final products always leave at
 * the edge. Surplus stays in the line by default (it only slows its machines); the player
 * can send it out, through a priority splitter so the module's own consumers come first.
 */
function SurplusSection({
    io,
    surplus,
    finalProducts,
    onToggle,
}: {
    io: IoPoint[];
    surplus: { itemName: string; rate: number }[];
    finalProducts: string[];
    onToggle: (itemName: string, on: boolean) => void;
}) {
    const exported = new Map<string, number>();
    io.filter((p) => p.kind === "export").forEach((p) => exported.set(p.itemName, (exported.get(p.itemName) ?? 0) + p.rate));
    // Surplus stays in the line unless sent out (it only slows its machines); byproducts
    // that share a belt go to a sink and are listed under Connections
    const rows = [
        ...[...exported.entries()].filter(([item]) => !finalProducts.includes(item)).map(([itemName, rate]) => ({ itemName, rate, on: true })),
        ...surplus.map((x) => ({ ...x, on: false })),
    ].filter((r, i, all) => all.findIndex((o) => o.itemName === r.itemName) === i);
    if (rows.length === 0) return null;
    return (
        <section className="flex flex-col gap-1">
            <h4 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold">Surplus and byproducts</h4>
            {rows.map((r) => (
                <label key={r.itemName} className="flex items-center gap-2 cursor-pointer text-[var(--text-secondary)]">
                    <input type="checkbox" checked={r.on} onChange={(e) => onToggle(r.itemName, e.target.checked)} className="accent-[var(--accent-gold)]" />
                    <span>
                        {r.itemName} {formatRate(r.rate)}/m
                        <span className="text-[var(--text-muted)]">{r.on ? " · overflow sent out (priority splitter: consumers first)" : " · stays in the line"}</span>
                    </span>
                </label>
            ))}
            <p className="text-[var(--text-muted)]">Final products always leave at the edge. Changing this lays the module out again.</p>
        </section>
    );
}
