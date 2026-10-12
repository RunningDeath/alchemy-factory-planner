import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { OrnatePanel } from "@/components/ui/OrnatePanel";
import { allDevices, DEVICE_CATEGORY_LABEL, deviceById } from "@/lib/codex/devices";

interface PageProps {
    params: Promise<{ id: string }>;
}

export async function generateStaticParams() {
    return allDevices().map((d) => ({ id: d.id }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const { id } = await params;
    const device = deviceById(id);
    return device
        ? { title: `${device.name} | Alchemy Factory Tools`, description: `${device.name}: size, ports, heat, build cost and recipes.` }
        : { title: "Device Not Found" };
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="space-y-1">
            <div className="text-xs text-[var(--text-muted)]">{label}</div>
            <div className="font-semibold text-[var(--text-primary)]">{value}</div>
        </div>
    );
}

/** Pages with more on a device: the cauldron rankings and the paradox calculator */
const MORE: Record<string, { href: string; label: (mixes?: number) => string }> = {
    cauldron: { href: "/cauldron", label: (n) => `All ${n} mixes with their builder score` },
    "advanced-cauldron": { href: "/advanced-cauldron", label: (n) => `All ${n} mixes with their builder score` },
    "paradox-crucible": { href: "/paradox-crucible", label: () => "Open the calculator" },
};

export default async function DevicePage({ params }: PageProps) {
    const { id } = await params;
    const d = deviceById(id);
    if (!d) notFound();
    const more = MORE[d.id];
    return (
        <div className="flex flex-col max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 gap-6">
            <Link href="/devices" className="inline-flex items-center gap-2 text-[var(--text-muted)] hover:text-[var(--accent-gold)] transition-colors">
                <ArrowLeft className="w-4 h-4" />
                <span>Back to Devices</span>
            </Link>
            <OrnatePanel className="p-6">
                <div className="space-y-4">
                    <div>
                        <h1 className="font-cinzel text-3xl font-bold text-[var(--accent-gold)] mb-1">{d.name}</h1>
                        <p className="text-[var(--text-secondary)]">{DEVICE_CATEGORY_LABEL[d.category]}</p>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-[var(--border)]">
                        <Stat label="Size (W × D × H)" value={`${d.size.x} × ${d.size.y} × ${d.size.z}`} />
                        <Stat label="Ports" value={`${d.beltIn} in · ${d.beltOut} out${d.pipes ? ` · ${d.pipes} pipe` : ""}`} />
                        {d.unlock && <Stat label="Unlocks" value={`Level ${d.unlock.level} (${d.unlock.via}${d.unlock.by ? `: ${d.unlock.by}` : ""})`} />}
                        {d.heat ? <Stat label="Heat while working" value={<span className="text-orange-400">{d.heat}/s</span>} /> : null}
                        {d.slots ? <Stat label="Heater slots" value={`${d.slots} (uses ${d.heatSelf ?? 0} heat/s itself)`} /> : null}
                        {d.slotsRequired ? <Stat label="Takes heater slots" value={`${d.slotsRequired} of a stove's 9`} /> : null}
                    </div>
                    {d.cost.length > 0 && (
                        <div className="pt-4 border-t border-[var(--border)] space-y-2">
                            <div className="text-xs text-[var(--text-muted)]">Build cost</div>
                            <div className="flex flex-wrap gap-2">
                                {d.cost.map((c) => (
                                    <Link key={c.id} href={`/items/${c.id}`} className="rounded border border-[var(--border)] px-2 py-1 text-sm hover:border-[var(--accent-gold-dim)]">
                                        {c.count}× {c.name}
                                    </Link>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </OrnatePanel>
            {more && (
                <Link href={more.href} className="text-[var(--accent-gold)] hover:underline">
                    {more.label(d.mixes)} →
                </Link>
            )}
            {d.recipes.length > 0 && (
                <OrnatePanel className="p-6 space-y-3">
                    <h2 className="font-cinzel text-xl font-bold text-[var(--accent-gold)]">Recipes ({d.recipes.length})</h2>
                    <div className="grid gap-2 sm:grid-cols-2">
                        {d.recipes.map((r) => (
                            <Link key={r.id} href={`/items/${r.outputId}`} className="flex justify-between rounded border border-[var(--border)] px-3 py-2 text-sm hover:border-[var(--accent-gold-dim)]">
                                <span className="text-[var(--text-primary)]">{r.output}</span>
                                <span className="text-[var(--text-muted)]">{r.time}s</span>
                            </Link>
                        ))}
                    </div>
                </OrnatePanel>
            )}
        </div>
    );
}
