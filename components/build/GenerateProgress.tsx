"use client";

import { X } from "lucide-react";

interface GenerateProgressProps {
    fraction: number;
    label: string;
    onAbort: () => void;
}

/** Progress of a running module generation, with a way out */
export function GenerateProgress({ fraction, label, onAbort }: GenerateProgressProps) {
    const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    return (
        <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)]/80 text-xs">
            <span className="text-[var(--text-secondary)] shrink-0">Generating module</span>
            <div className="flex-1 h-2 rounded-full bg-[var(--background)] border border-[var(--border)] overflow-hidden" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-[var(--accent-gold)] transition-[width] duration-150" style={{ width: `${percent}%` }} />
            </div>
            <span className="font-mono text-[var(--text-primary)] w-10 text-right">{percent}%</span>
            <span className="text-[var(--text-muted)] truncate max-w-[40%]">{label}</span>
            <button
                onClick={onAbort}
                className="px-2 py-1 rounded-md flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider cursor-pointer border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--error)] hover:border-[var(--error)]"
                title="Stop generating; the current layout stays"
            >
                <X size={12} /> Abort
            </button>
        </div>
    );
}
