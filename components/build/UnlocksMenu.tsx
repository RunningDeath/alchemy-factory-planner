"use client";

import { Lock } from "lucide-react";
import { useState } from "react";
import { isUnlocked, MAX_LEVEL, OPTIONAL_BUILDINGS, unlockKey, unlockOf, type BuildUnlocks } from "../../engine/build/unlocks";
import { cn } from "../../lib/utils";

interface UnlocksMenuProps {
    unlocks: BuildUnlocks;
    onChange: (unlocks: BuildUnlocks) => void;
    buttonClass: string;
}

const VIA: Record<string, string> = { research: "research", workbench: "workbench", quest: "quest" };

/** Player level plus single unlocks: the generator only uses what is switched on here */
export function UnlocksMenu({ unlocks, onChange, buttonClass }: UnlocksMenuProps) {
    const [open, setOpen] = useState(false);
    const overrides = unlocks.overrides ?? {};
    const overridden = Object.keys(overrides).length;

    const setLevel = (level: number) => onChange({ ...unlocks, level });
    const toggle = (id: string, on: boolean) => {
        const key = unlockKey(id);
        const next = { ...overrides };
        // Back to what the level says: drop the override
        if (isUnlocked(id, { level: unlocks.level }) === on) delete next[key];
        else next[key] = on;
        onChange({ ...unlocks, overrides: next });
    };

    return (
        <div className="relative">
            <button onClick={() => setOpen(!open)} className={buttonClass} title="Your level and unlocks: generated modules only use buildings you can place">
                <Lock size={12} /> Unlocks · Lv {unlocks.level}
                {overridden > 0 && <span className="text-[var(--accent-gold)]">+{overridden}</span>}
            </button>
            {open && (
                <div className="absolute z-40 mt-1 w-80 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xl flex flex-col gap-2 text-xs">
                    <label className="flex items-center justify-between gap-2 text-[var(--text-secondary)]">
                        Your level
                        <select
                            value={unlocks.level}
                            onChange={(e) => setLevel(Number(e.target.value))}
                            className="bg-[var(--background)] border border-[var(--border)] rounded px-1 py-0.5 text-[var(--text-primary)]"
                        >
                            {Array.from({ length: MAX_LEVEL }, (_, i) => i + 1).map((l) => (
                                <option key={l} value={l}>
                                    Level {l}
                                </option>
                            ))}
                        </select>
                    </label>
                    <p className="text-[10px] text-[var(--text-muted)]">
                        Everything your level can unlock is on. Research costs points, so switch off what you haven&apos;t bought yet.
                    </p>
                    <div className="flex flex-col gap-1 border-t border-[var(--border)] pt-2">
                        {OPTIONAL_BUILDINGS.map(({ id, label, what }) => {
                            const unlock = unlockOf(id);
                            const on = isUnlocked(id, unlocks);
                            const forced = overrides[unlockKey(id)] !== undefined;
                            return (
                                <label key={id} className="flex items-start gap-2 cursor-pointer" title={unlock ? `${VIA[unlock.via]}: ${unlock.by}` : "Not unlockable in game"}>
                                    <input type="checkbox" checked={on} onChange={(e) => toggle(id, e.target.checked)} className="mt-0.5 accent-[var(--accent-gold)]" />
                                    <span className="flex-1">
                                        <span className={cn("text-[var(--text-primary)]", forced && "text-[var(--accent-gold)]")}>{label}</span>
                                        <span className="text-[var(--text-muted)]"> · Lv {unlock?.level ?? "–"}</span>
                                        <span className="block text-[10px] text-[var(--text-muted)]">{what}</span>
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                    {overridden > 0 && (
                        <button onClick={() => onChange({ level: unlocks.level })} className="self-start text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-gold)] cursor-pointer">
                            Reset to level {unlocks.level}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
