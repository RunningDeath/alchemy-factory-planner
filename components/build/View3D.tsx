"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getFootprint } from "../../engine/build/footprint";
import { placementCells, type LayoutIssue, type Placement } from "../../engine/build/layout";
import { LAYER, QUAD } from "../../engine/build/types";
import { placementColor } from "../../lib/buildCatalog";

interface View3DProps {
    placements: Placement[];
    stepIndex: Map<string, number>;
    issuesByUid: Map<string, LayoutIssue[]>;
    selectedUid: string | null;
    /** Hide everything above this level (null = show all) */
    cutLevel: number | null;
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
}

function boxesFor(placements: Placement[], stepIndex: Map<string, number>, issuesByUid: Map<string, LayoutIssue[]>, selectedUid: string | null, cutLevel: number | null): Box[] {
    const boxes: Box[] = [];
    const error = new THREE.Color("#e05555");
    const selected = new THREE.Color("#f0d078");
    for (const p of placements) {
        const base = new THREE.Color(placementColor(p, stepIndex));
        const color = p.uid === selectedUid ? selected : issuesByUid.get(p.uid)?.length ? base.clone().lerp(error, 0.6) : base;
        const isFloor = getFootprint(p.id)?.category === "floor";
        for (const c of placementCells(p)) {
            if (cutLevel !== null && c.z > cutLevel) continue;
            const [z0, z1] = isFloor ? [0.85, 1] : layerSpan(c.layers);
            const sideOnly = (c.layers & ~LAYER.SIDE) === 0;
            if (c.quads === QUAD.ALL && !sideOnly) {
                boxes.push({ x: c.x, y: c.y, z: c.z + z0, w: 1, d: 1, h: z1 - z0, color });
                continue;
            }
            for (const [bit, ox, oy] of QUAD_OFFSETS) {
                if (!(c.quads & bit)) continue;
                // Side-only cells are legs/posts: draw a thin post in the quadrant's outer corner
                if (sideOnly) {
                    const px = ox === 0 ? 0 : 0.85;
                    const py = oy === 0 ? 0 : 0.85;
                    boxes.push({ x: c.x + px, y: c.y + py, z: c.z, w: 0.15, d: 0.15, h: 1, color });
                } else {
                    boxes.push({ x: c.x + ox, y: c.y + oy, z: c.z + z0, w: 0.5, d: 0.5, h: z1 - z0, color });
                }
            }
        }
    }
    return boxes;
}

export function View3D({ placements, stepIndex, issuesByUid, selectedUid, cutLevel }: View3DProps) {
    const mountRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<{
        scene: THREE.Scene;
        camera: THREE.PerspectiveCamera;
        renderer: THREE.WebGLRenderer;
        controls: OrbitControls;
        mesh: THREE.InstancedMesh | null;
        framed: boolean;
    } | null>(null);

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

        scene.add(new THREE.AmbientLight(0xffffff, 0.55));
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

        const resize = () => {
            camera.aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
            camera.updateProjectionMatrix();
            renderer.setSize(mount.clientWidth, mount.clientHeight, false);
        };
        const observer = new ResizeObserver(resize);
        observer.observe(mount);

        sceneRef.current = { scene, camera, renderer, controls, mesh: null, framed: false };
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            controls.dispose();
            renderer.dispose();
            mount.removeChild(renderer.domElement);
            sceneRef.current = null;
        };
    }, []);

    // Rebuild the instanced boxes when the layout changes
    useEffect(() => {
        const s = sceneRef.current;
        if (!s) return;
        if (s.mesh) {
            s.scene.remove(s.mesh);
            s.mesh.geometry.dispose();
            (s.mesh.material as THREE.Material).dispose();
        }

        const boxes = boxesFor(placements, stepIndex, issuesByUid, selectedUid, cutLevel);
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        geometry.translate(0.5, 0.5, 0.5);
        const material = new THREE.MeshLambertMaterial();
        const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, boxes.length));
        mesh.count = boxes.length;
        const matrix = new THREE.Matrix4();
        // Game axes → three.js: x → x, y → z, z (height) → y
        boxes.forEach((b, i) => {
            matrix.makeScale(b.w * 0.98, b.h * 0.98, b.d * 0.98);
            matrix.setPosition(b.x, b.z, b.y);
            mesh.setMatrixAt(i, matrix);
            mesh.setColorAt(i, b.color);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        s.scene.add(mesh);
        s.mesh = mesh;

        // Frame the camera on the first non-empty layout
        if (!s.framed && boxes.length > 0) {
            const maxX = Math.max(...boxes.map((b) => b.x + b.w));
            const maxY = Math.max(...boxes.map((b) => b.y + b.d));
            const maxZ = Math.max(...boxes.map((b) => b.z + b.h));
            const center = new THREE.Vector3(maxX / 2, maxZ / 2, maxY / 2);
            const radius = Math.max(maxX, maxY, maxZ);
            s.controls.target.copy(center);
            s.camera.position.set(center.x + radius * 1.2, center.y + radius * 1.1, center.z + radius * 1.4);
            s.framed = true;
        }
    }, [placements, stepIndex, issuesByUid, selectedUid, cutLevel]);

    return (
        <div className="relative w-full h-full min-h-[320px]">
            <div ref={mountRef} className="absolute inset-0" />
            <span className="absolute bottom-2 left-2 text-[10px] text-[var(--text-muted)] pointer-events-none">
                Drag to orbit · right-drag to pan · scroll to zoom
            </span>
        </div>
    );
}
