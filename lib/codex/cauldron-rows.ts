import { rankedMixes } from "@/engine/cauldron-score";
import type { MixRow } from "@/components/cauldron/CauldronRanking";

/** Ranked mixes of a cauldron as plain rows for the codex page (computed when the page is built) */
export function cauldronRows(kind: "basic" | "advanced"): MixRow[] {
    return rankedMixes(kind).map((m) => ({
        id: m.recipe.id,
        output: m.output,
        inputs: m.inputs,
        score: m.score,
        parts: m.parts,
        steps: m.steps,
        time: m.time,
        heat: m.heat,
    }));
}
