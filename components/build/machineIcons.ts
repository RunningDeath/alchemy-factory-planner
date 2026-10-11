import * as THREE from "three";
import { getFootprint, rotatedSize } from "../../engine/build/footprint";
import type { Placement } from "../../engine/build/layout";
import { buildingName, carriedItem, itemIdByName, showsIcons } from "../../lib/buildCatalog";
import { gameIconUrl, initials, type GameIconManifest } from "../../lib/gameIcons";

const SIZE = 128;
const MACHINE_BORDER = "#f0d078";

interface CachedIcon {
    texture: THREE.CanvasTexture;
    /** Whether the game icon has been requested (it may arrive after the fallback is drawn) */
    requested: boolean;
}

/** One texture per icon for the whole session: rebuilds and thousands of machines share them */
const cache = new Map<string, CachedIcon>();

/** Rounded plate with a coloured rim: dark under generated text, light parchment under game icons */
function badge(ctx: CanvasRenderingContext2D, border: string, light = false) {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = light ? "rgba(236, 226, 204, 0.95)" : "rgba(14, 10, 22, 0.9)";
    ctx.strokeStyle = border;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.roundRect(4, 4, SIZE - 8, SIZE - 8, 18);
    ctx.fill();
    ctx.stroke();
}

/** Text fitted to the badge: one big line, then smaller wrapped lines under it */
function fallbackText(ctx: CanvasRenderingContext2D, big: string, small: string, color: string) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    let size = 54;
    ctx.font = `bold ${size}px sans-serif`;
    while (size > 18 && ctx.measureText(big).width > SIZE - 28) ctx.font = `bold ${(size -= 4)}px sans-serif`;
    ctx.fillText(big, SIZE / 2, small ? 52 : SIZE / 2);
    if (!small) return;
    ctx.fillStyle = "#e8e0d4";
    ctx.font = "bold 18px sans-serif";
    const words = small.split(/\s+/);
    const lines: string[] = [];
    for (const word of words) {
        const last = lines[lines.length - 1];
        if (last && ctx.measureText(`${last} ${word}`).width <= SIZE - 24) lines[lines.length - 1] = `${last} ${word}`;
        else lines.push(word);
    }
    lines.slice(0, 2).forEach((line, i) => ctx.fillText(line, SIZE / 2, 88 + i * 20, SIZE - 20));
}

/**
 * Texture for an item or machine icon. Draws a generated badge (initials and name) right
 * away, and swaps in the game icon when it was exported and has loaded.
 */
function iconTexture(key: string, url: string | null, border: string, big: string, small: string): THREE.CanvasTexture {
    let entry = cache.get(key);
    if (!entry) {
        const canvas = document.createElement("canvas");
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext("2d")!;
        badge(ctx, border);
        fallbackText(ctx, big, small, border);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        entry = { texture, requested: false };
        cache.set(key, entry);
    }
    if (url && !entry.requested) {
        entry.requested = true;
        const { texture } = entry;
        const image = new Image();
        image.onload = () => {
            const ctx = (texture.image as HTMLCanvasElement).getContext("2d")!;
            badge(ctx, border, true);
            ctx.drawImage(image, 14, 14, SIZE - 28, SIZE - 28);
            texture.needsUpdate = true;
        };
        image.src = url;
    }
    return entry.texture;
}

function itemTexture(icons: GameIconManifest, item: string, color: string): THREE.CanvasTexture {
    const id = itemIdByName(item);
    const url = id ? gameIconUrl(icons, "items", id) : null;
    return iconTexture(`item\u0000${item}\u0000${color}`, url, color, initials(item), item.length > 18 ? "" : item);
}

function machineTexture(icons: GameIconManifest, buildingId: string): THREE.CanvasTexture {
    const name = buildingName(buildingId);
    return iconTexture(`building\u0000${buildingId}`, gameIconUrl(icons, "buildings", buildingId), MACHINE_BORDER, initials(name), name);
}

const DIMMED = new THREE.Color("#3a3446");
const FULL = new THREE.Color("#ffffff");
const TOP = new THREE.Euler(-Math.PI / 2, 0, 0);
/** Plane rotations for the four sides, facing +z, -z, +x, -x (three.js axes) */
const SIDES: { rot: THREE.Euler; normal: [number, number] }[] = [
    { rot: new THREE.Euler(0, 0, 0), normal: [0, 1] },
    { rot: new THREE.Euler(0, Math.PI, 0), normal: [0, -1] },
    { rot: new THREE.Euler(0, Math.PI / 2, 0), normal: [1, 0] },
    { rot: new THREE.Euler(0, -Math.PI / 2, 0), normal: [-1, 0] },
];
/** How far decals sit off the machine's bounding box, so they never fight its faces */
const LIFT = 0.02;

/**
 * Icons on the production machines themselves: what each one makes on its top face, what
 * machine it is on its four sides. Decals are grouped by texture into instanced planes, so
 * a few dozen draw calls cover any number of machines.
 */
export function machineIconMeshes(placements: Placement[], cutLevel: number | null, itemColors: Map<string, string>, highlightItem: string | null, icons: GameIconManifest): THREE.InstancedMesh[] {
    const groups = new Map<THREE.Texture, { matrix: THREE.Matrix4; color: THREE.Color }[]>();
    const add = (texture: THREE.Texture, position: THREE.Vector3, rotation: THREE.Euler, size: number, color: THREE.Color) => {
        const matrix = new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(rotation), new THREE.Vector3(size, size, 1));
        let list = groups.get(texture);
        if (!list) groups.set(texture, (list = []));
        list.push({ matrix, color });
    };

    for (const p of placements) {
        const fp = getFootprint(p.id);
        if (!fp || !showsIcons(p.id)) continue;
        if (cutLevel !== null && p.z > cutLevel) continue;
        const size = rotatedSize(fp, p.rot);
        const top = cutLevel !== null ? Math.min(p.z + size.z, cutLevel + 1) : p.z + size.z;
        const height = top - p.z;
        const item = carriedItem(p);
        const color = highlightItem && item !== highlightItem ? DIMMED : FULL;
        const machine = machineTexture(icons, p.id);
        // Game axes → three.js: x → x, y → z, z (height) → y
        const cx = p.x + size.x / 2;
        const cz = p.y + size.y / 2;

        const topSize = Math.min(size.x, size.y) * 0.8;
        add(item ? itemTexture(icons, item, itemColors.get(item) ?? MACHINE_BORDER) : machine, new THREE.Vector3(cx, top + LIFT, cz), TOP, topSize, color);

        for (const side of SIDES) {
            const faceWidth = side.normal[0] === 0 ? size.x : size.y;
            const s = Math.min(faceWidth * 0.8, height * 0.75, 2);
            if (s < 0.3) continue;
            const position = new THREE.Vector3(
                cx + side.normal[0] * (size.x / 2 + LIFT),
                p.z + height / 2,
                cz + side.normal[1] * (size.y / 2 + LIFT),
            );
            add(machine, position, side.rot, s, color);
        }
    }

    const geometry = new THREE.PlaneGeometry(1, 1);
    return [...groups].map(([texture, decals]) => {
        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const mesh = new THREE.InstancedMesh(geometry, material, decals.length);
        decals.forEach((d, i) => {
            mesh.setMatrixAt(i, d.matrix);
            mesh.setColorAt(i, d.color);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        return mesh;
    });
}
