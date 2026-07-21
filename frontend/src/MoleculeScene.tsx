import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { frameArray } from "./api";
import type { FrameData, LayerState, Manifest } from "./types";

interface MoleculeSceneProps {
  manifest: Manifest;
  frame: FrameData | null;
  layers: LayerState;
  selectedAtom: number | null;
  resetSignal: number;
  onSelect: (index: number | null) => void;
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  root: THREE.Group;
  atoms: THREE.InstancedMesh | null;
  bonds: THREE.LineSegments | null;
  cell: THREE.LineSegments | null;
  forces: THREE.LineSegments | null;
  selection: THREE.Mesh;
  atomCount: number;
  bondPairs: Array<[number, number]>;
  bondsForCount: number;
  radii: number[];
  positions: Float32Array | null;
  fittedForCount: number;
  lastResetSignal: number;
}

const accent = new THREE.Color("#40d9ff");

export function MoleculeScene({
  manifest,
  frame,
  layers,
  selectedAtom,
  resetSignal,
  onSelect,
}: MoleculeSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<SceneState | null>(null);
  const selectRef = useRef(onSelect);
  const selectedRef = useRef(selectedAtom);

  selectRef.current = onSelect;
  selectedRef.current = selectedAtom;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0d1012");
    scene.fog = new THREE.FogExp2("#0d1012", 0.018);

    const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 5000);
    camera.position.set(7, 5, 9);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;

    const root = new THREE.Group();
    scene.add(root);
    scene.add(new THREE.HemisphereLight("#f5f0e8", "#151a1d", 2.4));
    const key = new THREE.DirectionalLight("#ffffff", 3.2);
    key.position.set(7, 10, 8);
    scene.add(key);
    const rim = new THREE.DirectionalLight("#6bdcf5", 0.9);
    rim.position.set(-8, -2, -5);
    scene.add(rim);

    const selection = new THREE.Mesh(
      new THREE.SphereGeometry(1, 22, 14),
      new THREE.MeshBasicMaterial({
        color: accent,
        wireframe: true,
        transparent: true,
        opacity: 0.72,
      }),
    );
    selection.visible = false;
    root.add(selection);

    const state: SceneState = {
      renderer,
      scene,
      camera,
      controls,
      root,
      atoms: null,
      bonds: null,
      cell: null,
      forces: null,
      selection,
      atomCount: 0,
      bondPairs: [],
      bondsForCount: -1,
      radii: [],
      positions: null,
      fittedForCount: -1,
      lastResetSignal: resetSignal,
    };
    stateRef.current = state;

    const resize = () => {
      const width = Math.max(canvas.clientWidth, 1);
      const height = Math.max(canvas.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const pointerStart = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onPointerDown = (event: PointerEvent) => pointerStart.set(event.clientX, event.clientY);
    const onPointerUp = (event: PointerEvent) => {
      if (pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5) return;
      if (!state.atoms || !state.atoms.visible) {
        selectRef.current(null);
        return;
      }
      const bounds = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(state.atoms, false)[0];
      selectRef.current(hit?.instanceId ?? null);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      controls.update();
      if (selection.visible && selection.material instanceof THREE.MeshBasicMaterial) {
        selection.material.opacity = 0.66 + Math.sin(clock.getElapsedTime() * 4.2) * 0.16;
      }
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      disposeObject(root);
      renderer.dispose();
      stateRef.current = null;
    };
  }, []);

  useEffect(() => {
    const state = stateRef.current;
    const positions = frameArray(frame, ["positions", "position", "pos", "coordinates", "coords"]);
    if (!state || !positions) return;

    const count = Math.min(manifest.topology.atom_count, Math.floor(positions.length / 3));
    const atomicNumbers = resolveAtomicNumbers(manifest, count);
    const topologyChanged = count !== state.atomCount;
    if (topologyChanged) {
      replaceAtoms(state, count, atomicNumbers);
      state.bondsForCount = -1;
      state.fittedForCount = -1;
    }
    state.positions = positions;
    updateAtoms(state, positions, atomicNumbers);

    if (state.bondsForCount !== count) {
      const declared = normalizeBonds(manifest.topology.bonds, count);
      state.bondPairs = declared.length > 0 ? declared : inferBonds(positions, state.radii, count);
      state.bondsForCount = count;
    }
    updateBonds(state, positions);
    const cell = frameArray(frame, ["cell", "cell_vectors", "box"]);
    const forces = frameArray(frame, ["forces", "force"]);
    updateCell(state, cell);
    updateForces(state, positions, forces, count);

    state.atoms && (state.atoms.visible = layers.atoms);
    state.bonds && (state.bonds.visible = layers.bonds);
    state.cell && (state.cell.visible = layers.cell && Boolean(cell && cell.length >= 9));
    state.forces && (state.forces.visible = layers.forces && Boolean(forces && forces.length >= count * 3));

    const selected = selectedAtom !== null && selectedAtom >= 0 && selectedAtom < count ? selectedAtom : null;
    if (selected !== null && layers.atoms) {
      const radius = state.radii[selected] ?? 0.35;
      state.selection.position.fromArray(positions, selected * 3);
      state.selection.scale.setScalar(radius * 1.48);
      state.selection.visible = true;
    } else {
      state.selection.visible = false;
    }

    if (state.fittedForCount !== count || state.lastResetSignal !== resetSignal) {
      fitCamera(state, positions, count);
      state.fittedForCount = count;
      state.lastResetSignal = resetSignal;
    }
  }, [frame, layers, manifest, resetSignal, selectedAtom]);

  return <canvas ref={canvasRef} className="molecule-canvas" aria-label="Molecular structure" />;
}

function replaceAtoms(state: SceneState, count: number, atomicNumbers: number[]): void {
  if (state.atoms) {
    state.root.remove(state.atoms);
    state.atoms.geometry.dispose();
    disposeMaterial(state.atoms.material);
  }
  const geometry = new THREE.SphereGeometry(1, 28, 18);
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.48,
    metalness: 0.03,
  });
  const atoms = new THREE.InstancedMesh(geometry, material, count);
  atoms.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  state.radii = atomicNumbers.map(displayRadius);
  state.atoms = atoms;
  state.atomCount = count;
  state.root.add(atoms);
}

function updateAtoms(state: SceneState, positions: Float32Array, atomicNumbers: number[]): void {
  const atoms = state.atoms;
  if (!atoms) return;
  const dummy = new THREE.Object3D();
  for (let index = 0; index < state.atomCount; index += 1) {
    dummy.position.fromArray(positions, index * 3);
    dummy.scale.setScalar(state.radii[index]);
    dummy.updateMatrix();
    atoms.setMatrixAt(index, dummy.matrix);
    atoms.setColorAt(index, elementColor(atomicNumbers[index]));
  }
  atoms.instanceMatrix.needsUpdate = true;
  if (atoms.instanceColor) atoms.instanceColor.needsUpdate = true;
  atoms.computeBoundingSphere();
}

function updateBonds(state: SceneState, positions: Float32Array): void {
  const values = new Float32Array(state.bondPairs.length * 6);
  state.bondPairs.forEach(([a, b], index) => {
    values.set(positions.subarray(a * 3, a * 3 + 3), index * 6);
    values.set(positions.subarray(b * 3, b * 3 + 3), index * 6 + 3);
  });
  state.bonds = replaceLines(
    state,
    state.bonds,
    values,
    new THREE.LineBasicMaterial({ color: "#899197", transparent: true, opacity: 0.56 }),
  );
}

function updateCell(state: SceneState, cell: Float32Array | null): void {
  if (!cell || cell.length < 9) {
    if (state.cell) state.cell.visible = false;
    return;
  }
  const a = new THREE.Vector3(cell[0], cell[1], cell[2]);
  const b = new THREE.Vector3(cell[3], cell[4], cell[5]);
  const c = new THREE.Vector3(cell[6], cell[7], cell[8]);
  const corners = [
    new THREE.Vector3(),
    a,
    b,
    c,
    a.clone().add(b),
    a.clone().add(c),
    b.clone().add(c),
    a.clone().add(b).add(c),
  ];
  const edges = [
    [0, 1], [0, 2], [0, 3], [1, 4], [1, 5], [2, 4],
    [2, 6], [3, 5], [3, 6], [4, 7], [5, 7], [6, 7],
  ];
  const values = new Float32Array(edges.length * 6);
  edges.forEach(([from, to], index) => {
    corners[from].toArray(values, index * 6);
    corners[to].toArray(values, index * 6 + 3);
  });
  state.cell = replaceLines(
    state,
    state.cell,
    values,
    new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.42 }),
  );
}

function updateForces(
  state: SceneState,
  positions: Float32Array,
  forces: Float32Array | null,
  count: number,
): void {
  if (!forces || forces.length < count * 3) {
    if (state.forces) state.forces.visible = false;
    return;
  }
  let largest = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    largest = Math.max(largest, Math.hypot(forces[offset], forces[offset + 1], forces[offset + 2]));
  }
  const scale = largest > 0 ? Math.min(1, 1.8 / largest) : 0;
  const values = new Float32Array(count * 6);
  for (let index = 0; index < count; index += 1) {
    const source = index * 3;
    const target = index * 6;
    values.set(positions.subarray(source, source + 3), target);
    values[target + 3] = positions[source] + forces[source] * scale;
    values[target + 4] = positions[source + 1] + forces[source + 1] * scale;
    values[target + 5] = positions[source + 2] + forces[source + 2] * scale;
  }
  state.forces = replaceLines(
    state,
    state.forces,
    values,
    new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.9 }),
  );
}

function replaceLines(
  state: SceneState,
  current: THREE.LineSegments | null,
  positions: Float32Array,
  material: THREE.LineBasicMaterial,
): THREE.LineSegments {
  if (current) {
    state.root.remove(current);
    current.geometry.dispose();
    disposeMaterial(current.material);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(geometry, material);
  state.root.add(lines);
  return lines;
}

function normalizeBonds(input: Manifest["topology"]["bonds"], count: number): Array<[number, number]> {
  if (!input || input.length === 0) return [];
  const result: Array<[number, number]> = [];
  if (typeof input[0] === "number") {
    const flat = input as number[];
    for (let index = 0; index + 1 < flat.length; index += 2) addBond(result, flat[index], flat[index + 1], count);
    return result;
  }
  for (const bond of input as Exclude<(typeof input)[number], number>[]) {
    if (Array.isArray(bond)) addBond(result, bond[0], bond[1], count);
    else addBond(result, bond.a ?? bond.source, bond.b ?? bond.target, count);
  }
  return result;
}

function addBond(result: Array<[number, number]>, a: number | undefined, b: number | undefined, count: number): void {
  if (Number.isInteger(a) && Number.isInteger(b) && a !== b && a! >= 0 && b! >= 0 && a! < count && b! < count) {
    result.push([a!, b!]);
  }
}

function inferBonds(positions: Float32Array, radii: number[], count: number): Array<[number, number]> {
  if (count > 5000) return [];
  const cellSize = 3.2;
  const cells = new Map<string, number[]>();
  const result: Array<[number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const cell = [
      Math.floor(positions[offset] / cellSize),
      Math.floor(positions[offset + 1] / cellSize),
      Math.floor(positions[offset + 2] / cellSize),
    ];
    for (let x = -1; x <= 1; x += 1) {
      for (let y = -1; y <= 1; y += 1) {
        for (let z = -1; z <= 1; z += 1) {
          const peers = cells.get(`${cell[0] + x}:${cell[1] + y}:${cell[2] + z}`) ?? [];
          for (const peer of peers) {
            const other = peer * 3;
            const distance = Math.hypot(
              positions[offset] - positions[other],
              positions[offset + 1] - positions[other + 1],
              positions[offset + 2] - positions[other + 2],
            );
            const cutoff = (radii[index] + radii[peer]) * 2.9;
            if (distance > 0.2 && distance <= cutoff) result.push([peer, index]);
          }
        }
      }
    }
    const key = `${cell[0]}:${cell[1]}:${cell[2]}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(index);
    cells.set(key, bucket);
  }
  return result;
}

function fitCamera(state: SceneState, positions: Float32Array, count: number): void {
  if (count === 0) return;
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let index = 0; index < count; index += 1) bounds.expandByPoint(point.fromArray(positions, index * 3));
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 1.6);
  const distance = radius / Math.tan(THREE.MathUtils.degToRad(state.camera.fov * 0.5)) * 1.25;
  const direction = new THREE.Vector3(1, 0.68, 1.15).normalize();
  state.camera.position.copy(center).addScaledVector(direction, distance);
  state.camera.near = Math.max(distance / 500, 0.01);
  state.camera.far = Math.max(distance * 30, 100);
  state.camera.updateProjectionMatrix();
  state.controls.target.copy(center);
  state.controls.update();
}

function resolveAtomicNumbers(manifest: Manifest, count: number): number[] {
  if (manifest.topology.atomic_numbers?.length) return manifest.topology.atomic_numbers.slice(0, count);
  return Array.from({ length: count }, (_, index) => symbolToNumber[manifest.topology.symbols?.[index] ?? ""] ?? 0);
}

function displayRadius(atomicNumber: number): number {
  return Math.max(0.22, (covalentRadii[atomicNumber] ?? 0.78) * 0.43);
}

function elementColor(atomicNumber: number): THREE.Color {
  return new THREE.Color(elementColors[atomicNumber] ?? "#b7bdc0");
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      disposeMaterial(child.material);
    }
  });
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
  else material.dispose();
}

const symbolToNumber: Record<string, number> = {
  H: 1, He: 2, Li: 3, Be: 4, B: 5, C: 6, N: 7, O: 8, F: 9, Ne: 10,
  Na: 11, Mg: 12, Al: 13, Si: 14, P: 15, S: 16, Cl: 17, Ar: 18, K: 19, Ca: 20,
  Sc: 21, Ti: 22, V: 23, Cr: 24, Mn: 25, Fe: 26, Co: 27, Ni: 28, Cu: 29, Zn: 30,
  Br: 35, I: 53,
};

const covalentRadii: Record<number, number> = {
  1: 0.31, 2: 0.28, 3: 1.28, 4: 0.96, 5: 0.84, 6: 0.76, 7: 0.71, 8: 0.66,
  9: 0.57, 10: 0.58, 11: 1.66, 12: 1.41, 13: 1.21, 14: 1.11, 15: 1.07, 16: 1.05,
  17: 1.02, 18: 1.06, 19: 2.03, 20: 1.76, 26: 1.32, 29: 1.32, 30: 1.22, 35: 1.20, 53: 1.39,
};

const elementColors: Record<number, string> = {
  1: "#f2efe8", 2: "#d9f6f5", 3: "#b890d8", 4: "#c6d787", 5: "#d6a07b", 6: "#7e878d",
  7: "#6689d7", 8: "#e36961", 9: "#79bd82", 10: "#8dd6d8", 11: "#a583d0", 12: "#91ad75",
  13: "#b8aaa0", 14: "#c49b78", 15: "#d78f50", 16: "#d8c45e", 17: "#68b77b", 18: "#82c9ce",
  19: "#9972c4", 20: "#88a86e", 26: "#b87a59", 29: "#b98964", 30: "#9a9fa3", 35: "#9d4e43", 53: "#795499",
};
