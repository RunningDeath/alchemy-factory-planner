import type { Metadata } from "next";
import Link from "next/link";
import { Flame, Lock } from "lucide-react";
import { allDevices, DEVICE_CATEGORY_LABEL, deviceCategories } from "@/lib/codex/devices";

export const metadata: Metadata = {
    title: "Devices | Alchemy Factory Tools",
    description: "Every machine, heating device, portal and storage: size, ports, heat, build cost and unlock level.",
};

export default function DevicesPage() {
    const devices = allDevices();
    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
            <div>
                <h1 className="font-cinzel text-3xl font-bold text-[var(--accent-gold)] mb-2">Devices</h1>
                <p className="text-[var(--text-secondary)]">Machines, heating, portals and storage: size, ports, heat, build cost and when they unlock.</p>
            </div>
            {deviceCategories().map((category) => {
                const list = devices.filter((d) => d.category === category);
                if (!list.length) return null;
                return (
                    <section key={category} className="space-y-3">
                        <h2 className="font-cinzel text-xl font-bold text-[var(--text-primary)]">{DEVICE_CATEGORY_LABEL[category]}</h2>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {list.map((d) => (
                                <Link
                                    key={d.id}
                                    href={`/devices/${d.id}`}
                                    className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 hover:border-[var(--accent-gold-dim)] transition-colors"
                                >
                                    <div className="flex items-baseline justify-between gap-2">
                                        <span className="font-semibold text-[var(--accent-gold)]">{d.name}</span>
                                        <span className="font-mono text-xs text-[var(--text-muted)]">
                                            {d.size.x}×{d.size.y}×{d.size.z}
                                        </span>
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-[var(--text-muted)]">
                                        {d.unlock && (
                                            <span className="flex items-center gap-1">
                                                <Lock className="w-3 h-3" /> Level {d.unlock.level}
                                            </span>
                                        )}
                                        {d.heat ? (
                                            <span className="flex items-center gap-1 text-orange-400">
                                                <Flame className="w-3 h-3" /> {d.heat}/s
                                            </span>
                                        ) : null}
                                        {d.recipes.length > 0 && <span>{d.recipes.length} recipes</span>}
                                        {d.mixes ? <span>{d.mixes} mixes</span> : null}
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </section>
                );
            })}
        </div>
    );
}
