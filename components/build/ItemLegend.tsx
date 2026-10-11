"use client";

import { cn } from "../../lib/utils";

interface ItemLegendProps {
    itemColors: Map<string, string>;
    highlightItem: string | null;
    onHighlight: (item: string | null) => void;
}

/** Item colours used for belts and machines; click one to see only its belts and machines */
export function ItemLegend({ itemColors, highlightItem, onHighlight }: ItemLegendProps) {
    if (itemColors.size === 0) return null;
    return (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border)] text-[11px]">
            <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-bold mr-1">Items</span>
            {[...itemColors.entries()].map(([item, color]) => (
                <button
                    key={item}
                    onClick={() => onHighlight(highlightItem === item ? null : item)}
                    title={highlightItem === item ? "Show everything again" : `Show only belts and machines for ${item}`}
                    className={cn(
                        "flex items-center gap-1.5 px-2 py-0.5 rounded border cursor-pointer transition-colors",
                        highlightItem === item
                            ? "border-[var(--accent-gold)] bg-[var(--accent-gold)]/10 text-[var(--text-primary)]"
                            : highlightItem
                              ? "border-transparent text-[var(--text-muted)]"
                              : "border-transparent text-[var(--text-secondary)] hover:border-[var(--border)]",
                    )}
                >
                    <span className="inline-block w-3 h-3 rounded-sm" style={{ background: color }} />
                    {item}
                </button>
            ))}
            {highlightItem && (
                <button onClick={() => onHighlight(null)} className="text-[var(--accent-gold)] hover:underline cursor-pointer ml-1">
                    show all
                </button>
            )}
        </div>
    );
}
