/**
 * The game's own item and building icons, when exported locally into public/game-icons
 * (see tools/extract-game-data/README.md). They aren't in the repo, so everything that
 * uses them needs a fallback; manifest.json says which ones exist, so missing icons are
 * never requested.
 */
import { useEffect, useState } from "react";

export type IconKind = "items" | "buildings";

export interface GameIconManifest {
    items: Set<string>;
    buildings: Set<string>;
}

const EMPTY: GameIconManifest = { items: new Set(), buildings: new Set() };

let manifest: Promise<GameIconManifest> | null = null;

/** Loads the manifest once; resolves to an empty one when no icons were exported */
export function loadGameIcons(): Promise<GameIconManifest> {
    manifest ??= fetch("/game-icons/manifest.json")
        .then((r) => (r.ok ? r.json() : null))
        .then((json: { items?: string[]; buildings?: string[] } | null) =>
            json ? { items: new Set(json.items ?? []), buildings: new Set(json.buildings ?? []) } : EMPTY,
        )
        .catch(() => EMPTY);
    return manifest;
}

/** URL of an exported icon, or null when there is none */
export function gameIconUrl(icons: GameIconManifest, kind: IconKind, id: string): string | null {
    return icons[kind].has(id) ? `/game-icons/${kind}/${id}.png` : null;
}

/** The manifest for components; empty until it has loaded */
export function useGameIcons(): GameIconManifest {
    const [icons, setIcons] = useState(EMPTY);
    useEffect(() => {
        let live = true;
        loadGameIcons().then((m) => live && setIcons(m));
        return () => {
            live = false;
        };
    }, []);
    return icons;
}

/** Up to three initials for a badge: "Healing Potion" → "HP", "Glass" → "Gla" */
export function initials(name: string): string {
    const words = name.split(/[\s-]+/).filter((w) => /^[A-Za-z0-9]/.test(w));
    if (words.length === 0) return "?";
    if (words.length === 1) return words[0].slice(0, 3);
    return words
        .slice(0, 3)
        .map((w) => w[0].toUpperCase())
        .join("");
}
