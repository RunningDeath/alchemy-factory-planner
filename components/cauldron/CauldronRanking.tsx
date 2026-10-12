"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Flame, Leaf, Search, Timer, X } from "lucide-react";
import type { ScoreParts } from "@/engine/cauldron-score";

/** One mix as the page gets it (plain data, ranked at build time) */
export interface MixRow {
    id: string;
    output: { id: string; name: string };
    inputs: { id: string; name: string; count: number; plant: boolean }[];
    score: number;
    parts: ScoreParts;
    steps: number;
    time: number;
    heat: number;
}

const PART_LABELS: Record<keyof ScoreParts, string> = {
    plants: "Plant-based inputs",
    distinct: "A different item per slot",
    simple: "Few production steps",
    unheated: "No heated machine behind the inputs",
    light: "Light on fertilizer",
};

function scoreColor(score: number): string {
    if (score >= 75) return "var(--success)";
    if (score >= 55) return "var(--accent-gold)";
    return "var(--text-muted)";
}

/**
 * Cauldron mixes by what they make, each with its builder score: how well it builds in a
 * module (the same things the planner and the build generator weigh)
 */
export function CauldronRanking({ rows, slots }: { rows: MixRow[]; slots: number }) {
    const [query, setQuery] = useState("");
    const [plantsOnly, setPlantsOnly] = useState(false);
    const [bestOnly, setBestOnly] = useState(true);

    const groups = useMemo(() => {
        const q = query.trim().toLowerCase();
        const byOutput = new Map<string, MixRow[]>();
        for (const row of rows) {
            if (plantsOnly && !row.inputs.every((i) => i.plant)) continue;
            const text = `${row.output.name} ${row.inputs.map((i) => i.name).join(" ")}`.toLowerCase();
            if (q && !text.includes(q)) continue;
            byOutput.set(row.output.name, [...(byOutput.get(row.output.name) ?? []), row]);
        }
        return [...byOutput.entries()]
            .map(([name, list]) => [name, [...list].sort((a, b) => b.score - a.score).slice(0, bestOnly ? 3 : undefined)] as const)
            .sort((a, b) => b[1][0].score - a[1][0].score || a[0].localeCompare(b[0]));
    }, [rows, query, plantsOnly, bestOnly]);

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row gap-4 sm:items-center">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                    <input
                        type="text"
                        placeholder="Search a product or an ingredient..."
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        className="w-full pl-10 pr-10 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-gold-dim)] transition-colors"
                    />
                    {query && (
                        <button onClick={() => setQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
                <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
                    <input type="checkbox" checked={plantsOnly} onChange={(e) => setPlantsOnly(e.target.checked)} className="accent-[var(--accent-gold)]" />
                    Plant-based only
                </label>
                <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
                    <input type="checkbox" checked={bestOnly} onChange={(e) => setBestOnly(e.target.checked)} className="accent-[var(--accent-gold)]" />
                    Best 3 per product
                </label>
            </div>

            <p className="text-sm text-[var(--text-muted)]">
                {groups.length} products. The builder score (0–100) rates how well a mix builds in a module: plant-based inputs count most, then a
                different item in each of the {slots} slots, few production steps, no heated machine behind the inputs and little fertilizer.
            </p>

            <div className="grid gap-4 md:grid-cols-2">
                {groups.map(([name, list]) => (
                    <div key={name} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
                        <div className="flex items-baseline justify-between gap-2">
                            <Link href={`/items/${list[0].output.id}`} className="font-cinzel text-lg font-bold text-[var(--accent-gold)] hover:underline">
                                {name}
                            </Link>
                            <span className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                                <span className="flex items-center gap-1" title="Seconds per craft">
                                    <Timer className="w-3 h-3" />
                                    {list[0].time}s
                                </span>
                                <span className="flex items-center gap-1" title="Heat per craft">
                                    <Flame className="w-3 h-3" />
                                    {list[0].heat}
                                </span>
                            </span>
                        </div>
                        {list.map((row) => (
                            <div key={row.id} className="flex items-center gap-3 border-t border-[var(--border)] pt-2 first:border-t-0 first:pt-0">
                                <span
                                    className="font-mono text-lg font-bold w-10 text-right shrink-0"
                                    style={{ color: scoreColor(row.score) }}
                                    title={(Object.keys(PART_LABELS) as (keyof ScoreParts)[]).map((k) => `${PART_LABELS[k]}: ${Math.round(row.parts[k] * 100)}%`).join("\n")}
                                >
                                    {row.score}
                                </span>
                                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                                    {row.inputs.map((i, k) => (
                                        <span key={i.id} className="flex items-center gap-1">
                                            {k > 0 && <span className="text-[var(--text-muted)]">+</span>}
                                            <Link href={`/items/${i.id}`} className="flex items-center gap-1 text-[var(--text-primary)] hover:text-[var(--accent-gold)]">
                                                {i.count > 1 && <span className="text-[var(--text-muted)]">{i.count}×</span>}
                                                {i.name}
                                                {i.plant && <Leaf className="w-3 h-3 text-[var(--success)]" aria-label="plant-based" />}
                                            </Link>
                                        </span>
                                    ))}
                                    <span className="text-xs text-[var(--text-muted)]">· {row.steps} steps</span>
                                </div>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
