import type { Metadata } from "next";
import { CauldronRanking } from "@/components/cauldron/CauldronRanking";
import { cauldronRows } from "@/lib/codex/cauldron-rows";

export const metadata: Metadata = {
    title: "Cauldron Recipes | Alchemy Factory Tools",
    description: "Every cauldron mix by what it makes, rated by how well it builds: plant-based inputs, a different item per slot, few steps.",
};

export default function CauldronPage() {
    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="mb-8">
                <h1 className="font-cinzel text-3xl font-bold text-[var(--accent-gold)] mb-2">Cauldron</h1>
                <p className="text-[var(--text-secondary)]">
                    Three materials in, one out: their cauldron values are added (times 0.65 when two are the same, 0.5 when all three are), and out
                    comes the material whose cauldron target is nearest the sum.
                </p>
            </div>
            <CauldronRanking rows={cauldronRows("basic")} slots={3} />
        </div>
    );
}
