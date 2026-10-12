import type { Metadata } from "next";
import { ParadoxCalculator } from "@/components/paradox/ParadoxCalculator";

export const metadata: Metadata = {
    title: "Paradox Crucible | Alchemy Factory Tools",
    description: "What a Paradox Crucible brews from a batch, how fast, and at what heat.",
};

export default function ParadoxCruciblePage() {
    return (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="mb-8">
                <h1 className="font-cinzel text-3xl font-bold text-[var(--accent-gold)] mb-2">Paradox Crucible</h1>
                <p className="text-[var(--text-secondary)]">
                    It takes its whole input slot as one batch and brews one Oblivion Essence from it (one Vitality Essence from Oblivion Essence).
                    The bigger the batch&apos;s value (stack × cauldron value), the faster: 1500 / value seconds, between 0.5 s and 1500 s. The
                    essences as input take 5 s. It burns 1200 heat a second while brewing.
                </p>
            </div>
            <ParadoxCalculator />
        </div>
    );
}
