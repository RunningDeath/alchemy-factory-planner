import type { Metadata } from "next";
import { CauldronRanking } from "@/components/cauldron/CauldronRanking";
import { cauldronRows } from "@/lib/codex/cauldron-rows";

export const metadata: Metadata = {
    title: "Advanced Cauldron Recipes | Alchemy Factory Tools",
    description: "Every advanced cauldron mix by what it makes, rated by how well it builds.",
};

export default function AdvancedCauldronPage() {
    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="mb-8">
                <h1 className="font-cinzel text-3xl font-bold text-[var(--accent-gold)] mb-2">Advanced Cauldron</h1>
                <p className="text-[var(--text-secondary)]">
                    Two materials in, one out. The same material twice: out comes the material with the next higher cauldron target than its value.
                    Two different ones: out comes the material whose target is nearest the difference of their values, among those below the higher
                    value. Unlocked at level 8.
                </p>
            </div>
            <CauldronRanking rows={cauldronRows("advanced")} slots={2} />
        </div>
    );
}
