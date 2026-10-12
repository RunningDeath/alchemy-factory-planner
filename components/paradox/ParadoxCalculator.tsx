"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Flame, Timer } from "lucide-react";
import { paradoxBrew, paradoxInputs } from "@/engine/paradox";

const fmt = (n: number) => (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(n >= 10 ? 1 : 2));

/** What one Paradox Crucible makes from a batch: pick the input and the stack size */
export function ParadoxCalculator() {
    const inputs = useMemo(() => paradoxInputs(), []);
    const [inputId, setInputId] = useState("stone");
    const [stack, setStack] = useState(100);
    const brew = paradoxBrew(inputId, stack);
    // Inputs that reach the fastest brew (0.5 s) with the smallest stack
    const fastest = useMemo(
        () =>
            inputs
                .filter((i) => i.id !== "mors" && i.id !== "vitae")
                .map((i) => ({ item: i, stack: Math.ceil(1500 / 0.5 / i.cauldron_cost!) }))
                .sort((a, b) => a.stack - b.stack)
                .slice(0, 12),
        [inputs],
    );

    return (
        <div className="space-y-8">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
                <div className="flex flex-col sm:flex-row gap-4">
                    <label className="flex-1 flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
                        Input
                        <select
                            value={inputId}
                            onChange={(e) => setInputId(e.target.value)}
                            className="px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[var(--text-primary)]"
                        >
                            {inputs.map((i) => (
                                <option key={i.id} value={i.id}>
                                    {i.name} (value {i.cauldron_cost})
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)] sm:w-40">
                        Stack in the slot
                        <input
                            type="number"
                            min={1}
                            value={stack}
                            onChange={(e) => setStack(Math.max(1, Number(e.target.value) || 1))}
                            className="px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[var(--text-primary)]"
                        />
                    </label>
                </div>
                {brew && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-[var(--border)]">
                        <div>
                            <div className="text-xs text-[var(--text-muted)]">Product</div>
                            <Link href={`/items/${brew.product.id}`} className="font-semibold text-[var(--accent-gold)] hover:underline">
                                {brew.product.name}
                            </Link>
                        </div>
                        <div>
                            <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                                <Timer className="w-3 h-3" /> Per product
                            </div>
                            <div className="font-semibold text-[var(--text-primary)]">{fmt(brew.seconds)} s</div>
                        </div>
                        <div>
                            <div className="text-xs text-[var(--text-muted)]">Per minute</div>
                            <div className="font-semibold text-[var(--text-primary)]">
                                {fmt(brew.perMinute)} out · {fmt(brew.inputPerMinute)} in
                            </div>
                        </div>
                        <div>
                            <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                                <Flame className="w-3 h-3" /> Heat per product
                            </div>
                            <div className="font-semibold text-orange-400">{fmt(brew.heatPerProduct)}</div>
                        </div>
                    </div>
                )}
            </div>

            <div className="space-y-2">
                <h2 className="font-cinzel text-xl font-bold text-[var(--accent-gold)]">Fastest brew with the smallest stack</h2>
                <p className="text-sm text-[var(--text-muted)]">
                    A batch worth 3000 or more brews in the minimum 0.5 s. These inputs get there with the fewest items in the slot.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {fastest.map(({ item, stack: needed }) => (
                        <button
                            key={item.id}
                            onClick={() => {
                                setInputId(item.id);
                                setStack(needed);
                            }}
                            className="flex justify-between gap-2 rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left text-sm hover:border-[var(--accent-gold-dim)]"
                        >
                            <span className="text-[var(--text-primary)]">{item.name}</span>
                            <span className="text-[var(--text-muted)]">{needed} in the slot</span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
