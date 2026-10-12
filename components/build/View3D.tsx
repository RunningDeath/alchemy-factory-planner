"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { isBeltPiece } from "../../engine/build/belt-pieces";
import type { TierInfo } from "../../engine/build/generator";
import type { IoPoint } from "../../engine/build/router";
import { formatRate } from "../../lib/beltDisplay";
import { getFootprint, rotatedSize, SIDE_OFFSET } from "../../engine/build/footprint";
import { placementCells, type LayoutIssue, type Placement, type PortStatus } from "../../engine/build/layout";
import { LAYER, QUAD, type Side } from "../../engine/build/types";
import { BELT_COLORS, buildingName, carriedItem, describePlacement, isMachine, isSupport, placementColor, STARTER_BOX_COLOR } from "../../lib/buildCatalog";
import { useGameIcons } from "../../lib/gameIcons";
import { machineIconMeshes } from "./machineIcons";

interface View3DProps {
    placements: Placement[];
    tiers: TierInfo[];
    io: IoPoint[];
    ports: PortStatus[];
    itemColors: Map<string, string>;
    highlightItem: string | null;
    issuesByUid: Map<string, LayoutIssue[]>;
    selectedUid: string | null;
    /** Hide everything above this level (null = show all) */
    cutLevel: number | null;
    showSupports: boolean;
    showLabels: boolean;
    /** Arrows on machine ports and on belts */
    showPorts: boolean;
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

/** Corner posts (and a top plate) for frame-like supports: lab stands, iron stands, stand legs */
function frameBoxes(x: number, y: number, z: number, quads: number, withTop: boolean, color: THREE.Color, uid: string): Box[] {
    const boxes: Box[] = [];
    const post = 0.12;
    for (const [bit, ox, oy] of QUAD_OFFSETS) {
        if (!(quads & bit)) continue;
        boxes.push({ x: x + (ox === 0 ? 0.02 : 0.98 - post), y: y + (oy === 0 ? 0.02 : 0.98 - post), z, w: post, d: post, h: 1, color, uid });
    }
    if (withTop) {
        // Plate over the quadrants the stand covers
        const full = quads === QUAD.ALL;
        for (const [bit, ox, oy] of full ? ([[QUAD.ALL, 0, 0]] as [number, number, number][]) : QUAD_OFFSETS) {
            if (!(quads & bit)) continue;
            const size = full ? 1 : 0.5;
            boxes.push({ x: x + ox, y: y + oy, z: z + 0.86, w: size, d: size, h: 0.14, color, uid });
        }
    }
    return boxes;
}

function boxesFor(p: Placement, color: THREE.Color, cutLevel: number | null): Box[] {
    const boxes: Box[] = [];
    const belt = isBeltPiece(p.id);
    const isFloor = getFootprint(p.id)?.category === "floor";
    const support = isSupport(p);
    for (const c of placementCells(p)) {
        if (cutLevel !== null && c.z > cutLevel) continue;
        // Lab stands and stand legs: posts and a plate, so it's clear what carries the belt above
        if (support && c.layers & LAYER.SIDE && !(c.layers & LAYER.BOTTOM)) {
            boxes.push(...frameBoxes(c.x, c.y, c.z, c.quads, (c.layers & LAYER.TOP) !== 0, color, p.uid));
            continue;
        }
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

/**
 * Per-vertex shade for machine boxes: sides darken towards the floor and the top face is
 * a little darker than the sides' upper edge, so stacked and neighbouring machines read
 * as separate bodies. Multiplied with the instance colour (needs vertexColors).
 */
function shadeBoxGeometry(geometry: THREE.BoxGeometry) {
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    const shades = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
        const isTop = normal.getY(i) > 0.5;
        const isBottom = normal.getY(i) < -0.5;
        // y runs 0..1 after the translate
        const shade = isTop ? 0.78 : isBottom ? 0.5 : 0.6 + 0.4 * position.getY(i);
        shades.set([shade, shade, shade], i * 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(shades, 3));
}

function instancedMesh(boxes: Box[], material: THREE.Material, shaded = false): THREE.InstancedMesh {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0.5, 0.5, 0.5);
    if (shaded) shadeBoxGeometry(geometry);
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

const MACHINE_LABEL_FONT = 30;
const MACHINE_LABEL_MAX_CHARS = 24;

function shorten(text: string): string {
    return text.length > MACHINE_LABEL_MAX_CHARS ? `${text.slice(0, MACHINE_LABEL_MAX_CHARS - 1)}…` : text;
}

/** Canvas for one machine label: the product in its item colour, the machine name below */
function machineLabelMaterial(product: string, machine: string, color: string, dimmed: boolean): { material: THREE.SpriteMaterial; aspect: number } {
    const fontSize = MACHINE_LABEL_FONT;
    const padding = 8;
    const lineHeight = fontSize + 6;
    const lines = product ? [product, machine] : [machine];
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const font = (bold: boolean) => `${bold ? "bold " : ""}${fontSize}px sans-serif`;
    const widths = lines.map((line, i) => {
        ctx.font = font(i === 0);
        return ctx.measureText(line).width;
    });
    const width = Math.ceil(Math.max(...widths)) + padding * 2;
    const height = lines.length * lineHeight + padding * 2 - 6;
    canvas.width = width;
    canvas.height = height;
    ctx.fillStyle = "rgba(14, 10, 22, 0.82)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(1.5, 1.5, width - 3, height - 3, 8);
    ctx.fill();
    ctx.stroke();
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
        ctx.font = font(i === 0);
        ctx.fillStyle = i === 0 && product ? color : "#e8e0d4";
        ctx.fillText(line, padding, padding + i * lineHeight);
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: dimmed ? 0.35 : 1 });
    return { material, aspect: width / height };
}

/**
 * A small camera-facing label above every production machine: what it makes and what
 * it is. Identical labels share one texture and material, so thousands stay cheap.
 */
function machineLabels(placements: Placement[], cutLevel: number | null, itemColors: Map<string, string>, highlightItem: string | null): THREE.Sprite[] {
    const sprites: THREE.Sprite[] = [];
    const cache = new Map<string, { material: THREE.SpriteMaterial; aspect: number }>();
    for (const p of placements) {
        const fp = getFootprint(p.id);
        // The starter box gets a label too, seen from afar: the player has to find it once
        if (!fp || (fp.category !== "production" && !p.starterBox)) continue;
        if (cutLevel !== null && p.z > cutLevel) continue;
        const size = rotatedSize(fp, p.rot);
        const top = cutLevel !== null ? Math.min(p.z + size.z, cutLevel + 1) : p.z + size.z;
        const product = p.starterBox ? "Starter box" : p.label ? shorten(p.label) : "";
        const machine = p.starterBox ? "fill once" : shorten(buildingName(p.id));
        const item = carriedItem(p);
        const color = p.starterBox ? STARTER_BOX_COLOR : (item && itemColors.get(item)) || "#f0d078";
        const dimmed = !!highlightItem && item !== highlightItem;
        const key = `${product}\u0000${machine}\u0000${color}\u0000${dimmed}`;
        let entry = cache.get(key);
        if (!entry) {
            entry = machineLabelMaterial(product, machine, color, dimmed);
            cache.set(key, entry);
        }
        const sprite = new THREE.Sprite(entry.material);
        // Fit the label to the machine's footprint, within readable limits
        const labelWidth = Math.min(Math.max(Math.min(size.x, size.y) * 1.1, 1.4), 3);
        const labelHeight = labelWidth / entry.aspect;
        sprite.scale.set(labelWidth, labelHeight, 1);
        sprite.position.set(p.x + size.x / 2, top + 0.15 + labelHeight / 2, p.y + size.y / 2);
        sprite.renderOrder = 5;
        sprite.userData.machineLabel = !p.starterBox;
        sprites.push(sprite);
    }
    return sprites;
}

/** Machine labels only show up close to the camera, so the overview stays readable */
const MACHINE_LABEL_DISTANCE = 55;

/** Block names above each block, imports/exports at the edge, and any lane left unconnected */
function blockLabels(tiers: TierInfo[], io: IoPoint[], placements: Placement[], ports: PortStatus[]): THREE.Sprite[] {
    const sprites: THREE.Sprite[] = [];
    for (const point of io) {
        const importing = point.kind === "import";
        const tag = importing ? "IN" : point.kind === "export" ? "OUT" : point.kind === "altar" ? "ALTAR" : point.kind === "trash" ? "TRASH" : "SELL";
        const sprite = textSprite([`${tag}: ${point.itemName}`, `${formatRate(point.rate)}/m`], importing ? BELT_COLORS.in : BELT_COLORS.out, 0.7);
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

interface Arrow {
    /** Center in game coordinates */
    x: number;
    y: number;
    z: number;
    dir: Side | "top" | "base";
    size: number;
    color: THREE.Color;
}

const PORT_IN = new THREE.Color("#5dd97a");
const PORT_OUT = new THREE.Color("#f0a040");
const PORT_OPEN = new THREE.Color("#e05555");
const BELT_ARROW = new THREE.Color("#f4eee6");

/**
 * Where items go: on every machine port a cone at the port edge (green pointing in =
 * input, orange pointing out = output, red = nothing connected), and on every belt or
 * lift end a small light cone in the direction items move.
 */
function portArrows(placements: Placement[], ports: PortStatus[], cutLevel: number | null): Arrow[] {
    const arrows: Arrow[] = [];
    const byUid = new Map(placements.map((p) => [p.uid, p]));
    for (const status of ports) {
        const port = status.port;
        if (port.medium !== "belt" || (cutLevel !== null && port.z > cutLevel)) continue;
        const p = byUid.get(port.uid);
        if (!p) continue;
        const face = port.face;
        const [dx, dy] = face === "top" || face === "base" ? [0, 0] : SIDE_OFFSET[face];
        // Machines, lifts, splitters, filters and mergers: where items go in and come out
        if (isMachine(p) || (!isBeltPiece(p.id) && getFootprint(p.id)?.category === "logistics")) {
            const color = !status.connectedTo ? PORT_OPEN : port.dir === "in" ? PORT_IN : PORT_OUT;
            const pointing: Side | "top" | "base" = port.dir === "in" && face !== "top" && face !== "base" ? oppositeOf(face) : face;
            arrows.push({ x: port.x + 0.5 + dx * 0.62, y: port.y + 0.5 + dy * 0.62, z: port.z + 0.5, dir: pointing, size: 0.32, color });
        } else if (port.dir === "out" && isBeltPiece(p.id)) {
            arrows.push({ x: port.x + 0.5 + dx * 0.25, y: port.y + 0.5 + dy * 0.25, z: port.z + 0.3, dir: face, size: 0.2, color: BELT_ARROW });
        }
    }
    // Lifts: an arrow on the top piece shows which way they carry, seen from any angle
    for (const p of placements) {
        if (p.id !== "conveyer-lift-end-upwards" && p.id !== "conveyer-lift-end-downwards") continue;
        if (cutLevel !== null && p.z > cutLevel) continue;
        arrows.push({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 1.25, dir: p.id.endsWith("upwards") ? "top" : "base", size: 0.4, color: BELT_ARROW });
    }
    return arrows;
}

function oppositeOf(side: Side): Side {
    return ({ left: "right", right: "left", up: "down", down: "up" } as const)[side];
}

/** Cones for the arrows; game axes → three.js: x → x, y → z, z → y */
function arrowMesh(arrows: Arrow[]): THREE.InstancedMesh {
    const geometry = new THREE.ConeGeometry(0.5, 1, 4);
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), Math.max(1, arrows.length));
    mesh.count = arrows.length;
    const turn: Record<Side | "top" | "base", THREE.Euler> = {
        right: new THREE.Euler(0, 0, -Math.PI / 2),
        left: new THREE.Euler(0, 0, Math.PI / 2),
        down: new THREE.Euler(Math.PI / 2, 0, 0),
        up: new THREE.Euler(-Math.PI / 2, 0, 0),
        top: new THREE.Euler(0, 0, 0),
        base: new THREE.Euler(Math.PI, 0, 0),
    };
    const matrix = new THREE.Matrix4();
    arrows.forEach((a, i) => {
        matrix.compose(
            new THREE.Vector3(a.x, a.z, a.y),
            new THREE.Quaternion().setFromEuler(turn[a.dir]),
            new THREE.Vector3(a.size, a.size * 1.4, a.size),
        );
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, a.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
}

interface SceneState {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    objects: THREE.Object3D[];
    /** Meshes that answer hover, with the placement behind each instance */
    pickables: { mesh: THREE.InstancedMesh; owners: string[] }[];
    /** Per-machine labels, hidden when far from the camera */
    machineLabels: THREE.Sprite[];
    framed: boolean;
}

function disposeObject(o: THREE.Object3D, disposed: Set<THREE.Material>) {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
    } else if (o instanceof THREE.Sprite) {
        if (disposed.has(o.material)) return;
        disposed.add(o.material);
        o.material.map?.dispose();
        o.material.dispose();
    }
}

export function View3D({ placements, tiers, io, ports, itemColors, highlightItem, issuesByUid, selectedUid, cutLevel, showSupports, showLabels, showPorts }: View3DProps) {
    const mountRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<SceneState | null>(null);
    const byUid = useRef(new Map<string, Placement>());
    const [hover, setHover] = useState<{ text: string; x: number; y: number } | null>(null);
    const icons = useGameIcons();

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
            const labels = sceneRef.current?.machineLabels ?? [];
            const maxDistanceSq = MACHINE_LABEL_DISTANCE * MACHINE_LABEL_DISTANCE;
            for (const label of labels) label.visible = label.position.distanceToSquared(camera.position) < maxDistanceSq;
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
            if (!s || s.pickables.length === 0) return;
            const rect = renderer.domElement.getBoundingClientRect();
            pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
            raycaster.setFromCamera(pointer, camera);
            const hit = raycaster.intersectObjects(s.pickables.map((pk) => pk.mesh))[0];
            const owners = s.pickables.find((pk) => pk.mesh === hit?.object)?.owners;
            const p = hit?.instanceId !== undefined && owners ? byUid.current.get(owners[hit.instanceId]) : undefined;
            setHover(
                p
                    ? {
                          text: `${describePlacement(p)} · level ${p.z}`,
                          x: e.clientX - rect.left,
                          y: e.clientY - rect.top,
                      }
                    : null,
            );
        };
        const onLeave = () => setHover(null);
        renderer.domElement.addEventListener("pointermove", onMove);
        renderer.domElement.addEventListener("pointerleave", onLeave);

        sceneRef.current = { scene, camera, renderer, controls, objects: [], pickables: [], machineLabels: [], framed: false };
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
        const disposed = new Set<THREE.Material>();
        s.objects.forEach((o) => {
            s.scene.remove(o);
            disposeObject(o, disposed);
        });

        const error = new THREE.Color("#e05555");
        const selectedColor = new THREE.Color("#f0d078");
        const solid: Box[] = [];
        const machines: Box[] = [];
        const supports: Box[] = [];
        for (const p of placements) {
            const support = isSupport(p);
            if (support && !showSupports && p.uid !== selectedUid) continue;
            let base = new THREE.Color(placementColor(p, itemColors));
            // Highlighting an item fades everything else into the background
            if (highlightItem && carriedItem(p) !== highlightItem) base = base.clone().lerp(new THREE.Color("#120d1c"), 0.82);
            const color = p.uid === selectedUid ? selectedColor : issuesByUid.get(p.uid)?.length ? base.clone().lerp(error, 0.6) : base;
            (support ? supports : isMachine(p) ? machines : solid).push(...boxesFor(p, color, cutLevel));
        }

        const solidMesh = instancedMesh(solid, new THREE.MeshLambertMaterial());
        const machineMesh = instancedMesh(machines, new THREE.MeshLambertMaterial({ vertexColors: true }), true);
        const supportMesh = instancedMesh(supports, new THREE.MeshLambertMaterial());
        const outlines = machineOutlines(placements, cutLevel);
        const labels = showLabels ? blockLabels(tiers, io, placements, ports) : [];
        const perMachine = showLabels ? machineLabels(placements, cutLevel, itemColors, highlightItem) : [];
        const machineIcons = machineIconMeshes(placements, cutLevel, itemColors, highlightItem, icons);
        const arrows = showPorts ? [arrowMesh(portArrows(placements, ports, cutLevel))] : [];
        s.objects = [solidMesh, machineMesh, supportMesh, outlines, ...machineIcons, ...arrows, ...labels, ...perMachine];
        s.objects.forEach((o) => s.scene.add(o));
        s.machineLabels = perMachine;
        s.pickables = [
            { mesh: solidMesh, owners: solid.map((b) => b.uid) },
            { mesh: machineMesh, owners: machines.map((b) => b.uid) },
            { mesh: supportMesh, owners: supports.map((b) => b.uid) },
        ];

        // Frame the camera on the first non-empty layout
        const visible = [...solid, ...machines];
        if (!s.framed && visible.length > 0) {
            const maxX = Math.max(...visible.map((b) => b.x + b.w));
            const maxY = Math.max(...visible.map((b) => b.y + b.d));
            const maxZ = Math.max(...visible.map((b) => b.z + b.h));
            const center = new THREE.Vector3(maxX / 2, maxZ / 2, maxY / 2);
            const radius = Math.max(maxX, maxY, maxZ);
            s.controls.target.copy(center);
            s.camera.position.set(center.x + radius * 0.9, center.y + radius * 1.0, center.z + radius * 1.1);
            s.framed = true;
        }
    }, [placements, tiers, io, ports, itemColors, highlightItem, issuesByUid, selectedUid, cutLevel, showSupports, showLabels, showPorts, icons]);

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
                <span>belts and machines are coloured by item (see the legend above) · brown: lab stands, beams and wood blocks carrying raised belts</span>
                <span>
                    ports: <span style={{ color: "#5dd97a" }}>▲ input</span> <span style={{ color: "#f0a040" }}>▲ output</span>{" "}
                    <span style={{ color: "#e05555" }}>▲ not connected</span> · light cones: belt direction
                </span>
                <span>drag orbit · right-drag pan · scroll zoom · machines show what they make on top and what they are on the sides · hover for names · zoom in for text labels</span>
            </div>
        </div>
    );
}
