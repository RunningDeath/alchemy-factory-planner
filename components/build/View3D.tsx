"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { isBeltPiece } from "../../engine/build/belt-pieces";
import type { TierInfo } from "../../engine/build/generator";
import type { IoPoint } from "../../engine/build/router";
import { formatRate } from "../../lib/beltDisplay";
import { getFootprint, rotatedSize } from "../../engine/build/footprint";
import { placementCells, type LayoutIssue, type Placement, type PortStatus } from "../../engine/build/layout";
import { LAYER, QUAD } from "../../engine/build/types";
import { BELT_COLORS, beltColor, buildingName, isMachine, isSupport, placementColor } from "../../lib/buildCatalog";

interface View3DProps {
    placements: Placement[];
    tiers: TierInfo[];
    io: IoPoint[];
    ports: PortStatus[];
    stepIndex: Map<string, number>;
    issuesByUid: Map<string, LayoutIssue[]>;
    selectedUid: string | null;
    /** Hide everything above this level (null = show all) */
    cutLevel: number | null;
    showSupports: boolean;
    showLabels: boolean;
}

/** Vertical extent of the occupied layers inside one cell (0 = bottom, 1 = top) */
function layerSpan(layers: number): [number, number] {
    const bottom = layers & LAYER.BOTTOM ? 0 : layers & LAYER.MIDDLE ? 0.3 : layers & LAYER.TOP ? 0.7 : 0;
    const top = layers & LAYER.TOP ? 1 : layers & LAYER.MIDDLE ? 0.7 : layers & LAYER.BOTTOM ? 0.3 : 1;
    return [bottom, top];
}

const QUAD_OFFSETS: [number, number, number][] = [
    [QUAD.NW, 0, 0],
    [QUAD.NE, 0.5, 0],
    [QUAD.SE, 0.5, 0.5],
    [QUAD.SW, 0, 0.5],
];

interface Box {
    x: number;
    y: number;
    z: number;
    w: number;
    d: number;
    h: number;
    color: THREE.Color;
    uid: string;
}

function boxesFor(p: Placement, color: THREE.Color, cutLevel: number | null): Box[] {
    const boxes: Box[] = [];
    const belt = isBeltPiece(p.id);
    const isFloor = getFootprint(p.id)?.category === "floor";
    for (const c of placementCells(p)) {
        if (cutLevel !== null && c.z > cutLevel) continue;
        // Belts are thin tracks so machines stand out
        const [z0, z1] = belt ? [0, 0.18] : isFloor ? [0.85, 1] : layerSpan(c.layers);
        const sideOnly = (c.layers & ~LAYER.SIDE) === 0;
        if ((c.quads === QUAD.ALL && !sideOnly) || belt) {
            boxes.push({ x: c.x, y: c.y, z: c.z + z0, w: 1, d: 1, h: z1 - z0, color, uid: p.uid });
            continue;
        }
        for (const [bit, ox, oy] of QUAD_OFFSETS) {
            if (!(c.quads & bit)) continue;
            // Side-only cells are legs/posts: a thin post in the quadrant's outer corner
            if (sideOnly) {
                boxes.push({ x: c.x + (ox === 0 ? 0 : 0.85), y: c.y + (oy === 0 ? 0 : 0.85), z: c.z, w: 0.15, d: 0.15, h: 1, color, uid: p.uid });
            } else {
                boxes.push({ x: c.x + ox, y: c.y + oy, z: c.z + z0, w: 0.5, d: 0.5, h: z1 - z0, color, uid: p.uid });
            }
        }
    }
    return boxes;
}

function instancedMesh(boxes: Box[], material: THREE.Material): THREE.InstancedMesh {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0.5, 0.5, 0.5);
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, boxes.length));
    mesh.count = boxes.length;
    const matrix = new THREE.Matrix4();
    // Game axes → three.js: x → x, y → z, z (height) → y
    boxes.forEach((b, i) => {
        matrix.makeScale(b.w * 0.97, b.h * 0.97, b.d * 0.97);
        matrix.setPosition(b.x, b.z, b.y);
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, b.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
}

/** Bounding-box outlines of machines, so neighbours don't blend into one block */
function machineOutlines(placements: Placement[], cutLevel: number | null): THREE.LineSegments {
    const points: number[] = [];
    for (const p of placements) {
        const fp = getFootprint(p.id);
        if (!fp || !isMachine(p)) continue;
        const size = rotatedSize(fp, p.rot);
        const top = cutLevel !== null ? Math.min(p.z + size.z, cutLevel + 1) : p.z + size.z;
        if (top <= p.z) continue;
        const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, top - p.z, size.y));
        const cx = p.x + size.x / 2;
        const cy = (p.z + top) / 2;
        const cz = p.y + size.y / 2;
        const pos = edges.attributes.position.array;
        for (let i = 0; i < pos.length; i += 3) points.push(pos[i] + cx, pos[i + 1] + cy, pos[i + 2] + cz);
        edges.dispose();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x120c06 }));
}

/** A text label that always faces the camera and stays on top */
function textSprite(lines: string[], color: string, cellHeight: number): THREE.Sprite {
    const fontSize = 40;
    const padding = 14;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `bold ${fontSize}px sans-serif`;
    const width = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + padding * 2;
    const height = lines.length * (fontSize + 8) + padding * 2;
    canvas.width = width;
    canvas.height = height;
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = "rgba(14, 10, 22, 0.88)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(2, 2, width - 4, height - 4, 12);
    ctx.fill();
    ctx.stroke();
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
        ctx.fillStyle = i === 0 ? color : "#e8e0d4";
        ctx.fillText(line, padding, padding + i * (fontSize + 8));
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    const scale = (cellHeight * lines.length) / height * (fontSize + 8);
    sprite.scale.set((width / height) * scale, scale, 1);
    sprite.renderOrder = 10;
    return sprite;
}

/** Block names above each block, imports/exports at the edge, and any lane left unconnected */
function blockLabels(tiers: TierInfo[], io: IoPoint[], placements: Placement[], ports: PortStatus[]): THREE.Sprite[] {
    const sprites: THREE.Sprite[] = [];
    for (const point of io) {
        const importing = point.kind === "import";
        const sprite = textSprite([`${importing ? "IN" : "OUT"}: ${point.itemName}`, `${formatRate(point.rate)}/m`], importing ? BELT_COLORS.in : BELT_COLORS.out, 0.7);
        sprite.position.set(point.cell[0] + 0.5, point.cell[2] + 1.6, point.cell[1] + 0.5);
        sprites.push(sprite);
    }
    const byUid = new Map(placements.map((p) => [p.uid, p]));

    tiers.forEach((t, index) => {
        const stacked = t.levels > 1 ? (t.stacking === "beam-deck" ? `${t.levels} levels on beam decks` : `${t.levels} levels, each fed by its own belt`) : "";
        const label = textSprite([t.itemName, `${t.machines}× ${buildingName(t.deviceId)}`, ...(stacked ? [stacked] : [])], "#f0d078", 0.9);
        label.position.set(t.x + t.width / 2, t.z + t.height + 2.2, t.y + t.depth / 2);
        sprites.push(label);

        // Lane ends that still connect to nothing
        for (const kind of ["in", "out"] as const) {
            const ends = ports.filter((s) => {
                const p = byUid.get(s.port.uid);
                return !s.connectedTo && p?.block === index && p.lane === kind && s.port.dir === kind;
            });
            if (ends.length === 0) continue;
            const items = (kind === "in" ? t.lanes.find((l) => l.kind === "in") : t.lanes.find((l) => l.kind === "out"))?.items ?? [];
            const names = items.map((i) => i.itemName).join(" + ");
            const cx = ends.reduce((s, e) => s + e.port.x, 0) / ends.length + 0.5;
            const cy = ends.reduce((s, e) => s + e.port.y, 0) / ends.length + 0.5;
            const z = Math.max(...ends.map((e) => e.port.z));
            const sprite = textSprite([`OPEN ${kind === "in" ? "input" : "output"}: ${names}`, `${ends.length} belt${ends.length === 1 ? "" : "s"} not connected`], "#e05555", 0.6);
            sprite.position.set(cx, z + 1.2, cy);
            sprites.push(sprite);
        }
    });
    return sprites;
}

interface SceneState {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    objects: THREE.Object3D[];
    pickable: THREE.InstancedMesh | null;
    owners: string[];
    framed: boolean;
}

function disposeObject(o: THREE.Object3D) {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
    } else if (o instanceof THREE.Sprite) {
        o.material.map?.dispose();
        o.material.dispose();
    }
}

export function View3D({ placements, tiers, io, ports, stepIndex, issuesByUid, selectedUid, cutLevel, showSupports, showLabels }: View3DProps) {
    const mountRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<SceneState | null>(null);
    const byUid = useRef(new Map<string, Placement>());
    const [hover, setHover] = useState<{ text: string; x: number; y: number } | null>(null);

    // Scene setup once
    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return;
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / Math.max(1, mount.clientHeight), 0.1, 2000);
        camera.position.set(30, 30, 30);
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        // Size the drawing buffer only; CSS keeps the canvas at the container's size
        renderer.setSize(mount.clientWidth, mount.clientHeight, false);
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        renderer.domElement.style.display = "block";
        mount.appendChild(renderer.domElement);

        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const sun = new THREE.DirectionalLight(0xffffff, 0.9);
        sun.position.set(20, 40, 10);
        scene.add(sun);
        const grid = new THREE.GridHelper(64, 64, 0x6b4db8, 0x352a4d);
        grid.position.set(32, 0, 32);
        scene.add(grid);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;

        let frame = 0;
        const animate = () => {
            frame = requestAnimationFrame(animate);
            controls.update();
            renderer.render(scene, camera);
        };
        animate();

        const observer = new ResizeObserver(() => {
            camera.aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
            camera.updateProjectionMatrix();
            renderer.setSize(mount.clientWidth, mount.clientHeight, false);
        });
        observer.observe(mount);

        // Hover: name of the building under the pointer
        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        const onMove = (e: PointerEvent) => {
            const s = sceneRef.current;
            if (!s?.pickable) return;
            const rect = renderer.domElement.getBoundingClientRect();
            pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
            raycaster.setFromCamera(pointer, camera);
            const hit = raycaster.intersectObject(s.pickable)[0];
            const p = hit?.instanceId !== undefined ? byUid.current.get(s.owners[hit.instanceId]) : undefined;
            setHover(
                p
                    ? {
                          text: `${buildingName(p.id)}${p.label ? ` · ${p.lane === "in" ? "carries in " : p.lane === "out" ? "carries out " : ""}${p.label}` : ""} · level ${p.z}`,
                          x: e.clientX - rect.left,
                          y: e.clientY - rect.top,
                      }
                    : null,
            );
        };
        const onLeave = () => setHover(null);
        renderer.domElement.addEventListener("pointermove", onMove);
        renderer.domElement.addEventListener("pointerleave", onLeave);

        sceneRef.current = { scene, camera, renderer, controls, objects: [], pickable: null, owners: [], framed: false };
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            renderer.domElement.removeEventListener("pointermove", onMove);
            renderer.domElement.removeEventListener("pointerleave", onLeave);
            controls.dispose();
            renderer.dispose();
            mount.removeChild(renderer.domElement);
            sceneRef.current = null;
        };
    }, []);

    // Rebuild meshes when the layout changes
    useEffect(() => {
        const s = sceneRef.current;
        if (!s) return;
        byUid.current = new Map(placements.map((p) => [p.uid, p]));
        s.objects.forEach((o) => {
            s.scene.remove(o);
            disposeObject(o);
        });

        const error = new THREE.Color("#e05555");
        const selectedColor = new THREE.Color("#f0d078");
        const solid: Box[] = [];
        const supports: Box[] = [];
        for (const p of placements) {
            const support = isSupport(p);
            if (support && !showSupports && p.uid !== selectedUid) continue;
            const base = new THREE.Color(isBeltPiece(p.id) ? beltColor(p) : placementColor(p, stepIndex));
            const color = p.uid === selectedUid ? selectedColor : issuesByUid.get(p.uid)?.length ? base.clone().lerp(error, 0.6) : base;
            (support ? supports : solid).push(...boxesFor(p, color, cutLevel));
        }

        const solidMesh = instancedMesh(solid, new THREE.MeshLambertMaterial());
        const supportMesh = instancedMesh(supports, new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.22, depthWrite: false }));
        const outlines = machineOutlines(placements, cutLevel);
        const labels = showLabels ? blockLabels(tiers, io, placements, ports) : [];
        s.objects = [solidMesh, supportMesh, outlines, ...labels];
        s.objects.forEach((o) => s.scene.add(o));
        s.pickable = solidMesh;
        s.owners = solid.map((b) => b.uid);

        // Frame the camera on the first non-empty layout
        if (!s.framed && solid.length > 0) {
            const maxX = Math.max(...solid.map((b) => b.x + b.w));
            const maxY = Math.max(...solid.map((b) => b.y + b.d));
            const maxZ = Math.max(...solid.map((b) => b.z + b.h));
            const center = new THREE.Vector3(maxX / 2, maxZ / 2, maxY / 2);
            const radius = Math.max(maxX, maxY, maxZ);
            s.controls.target.copy(center);
            s.camera.position.set(center.x + radius * 0.9, center.y + radius * 1.0, center.z + radius * 1.1);
            s.framed = true;
        }
    }, [placements, tiers, io, ports, stepIndex, issuesByUid, selectedUid, cutLevel, showSupports, showLabels]);

    return (
        <div className="relative w-full h-full min-h-[320px]">
            <div ref={mountRef} className="absolute inset-0" />
            {hover && (
                <div
                    className="absolute pointer-events-none px-2 py-1 rounded bg-[var(--surface-elevated)] border border-[var(--border)] text-[11px] text-[var(--text-primary)] whitespace-nowrap"
                    style={{ left: hover.x + 12, top: hover.y + 12 }}
                >
                    {hover.text}
                </div>
            )}
            <div className="absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--text-muted)] pointer-events-none">
                <span>
                    <span style={{ color: BELT_COLORS.in }}>■</span> belt into machines
                </span>
                <span>
                    <span style={{ color: BELT_COLORS.out }}>■</span> belt out of machines
                </span>
                <span>
                    <span style={{ color: BELT_COLORS.route }}>■</span> belt/lift between blocks
                </span>
                <span>hatched/faded: supports</span>
                <span>drag orbit · right-drag pan · scroll zoom · hover for names</span>
            </div>
        </div>
    );
}
