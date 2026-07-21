import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { frameArray } from "./api";
import type { CellOffset, FrameData, LayerState, Manifest } from "./types";

interface MoleculeSceneProps {
  manifest: Manifest;
  frame: FrameData | null;
  layers: LayerState;
  selectedAtom: number | null;
  resetSignal: number;
  cellOffset: CellOffset;
  forceScale: number;
  onSelect: (index: number | null) => void;
}

type Pbc = [boolean, boolean, boolean];

interface CellBasis {
  vectors: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  reciprocal: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  root: THREE.Group;
  atoms: THREE.InstancedMesh | null;
  bonds: THREE.InstancedMesh | null;
  cell: THREE.Group | null;
  forces: THREE.Group | null;
  selection: THREE.Mesh;
  atomCount: number;
  bondPairs: Array<[number, number]>;
  bondsForCount: number;
  inferredForFrame: FrameData | null;
  radii: number[];
  positions: Float32Array | null;
  fittedForCount: number;
  lastResetSignal: number;
}

interface Segment {
  from: THREE.Vector3;
  to: THREE.Vector3;
}

const accent = new THREE.Color("#55ddff");
const forceColor = new THREE.Color("#ffba55");
const yAxis = new THREE.Vector3(0, 1, 0);

export function centeredFramePositions(frame: FrameData | null, count: number): Float32Array | null {
  const positions = frameArray(frame, ["positions", "position", "pos", "coordinates", "coords"]);
  if (!positions) return null;
  const basis = createCellBasis(frameArray(frame, ["cell", "cell_vectors", "box"]));
  return wrapPositions(positions, Math.min(count, Math.floor(positions.length / 3)), basis, resolvePbc(frame, basis));
}

export function hasFrameCell(frame: FrameData | null): boolean {
  return Boolean(createCellBasis(frameArray(frame, ["cell", "cell_vectors", "box"])));
}

export function framePbc(frame: FrameData | null): Pbc {
  const basis = createCellBasis(frameArray(frame, ["cell", "cell_vectors", "box"]));
  return resolvePbc(frame, basis);
}

export function MoleculeScene({
  manifest,
  frame,
  layers,
  selectedAtom,
  resetSignal,
  cellOffset,
  forceScale,
  onSelect,
}: MoleculeSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<SceneState | null>(null);
  const selectRef = useRef(onSelect);

  selectRef.current = onSelect;

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
    renderer.toneMappingExposure = 1.2;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#090c0e");
    scene.fog = new THREE.FogExp2("#090c0e", 0.014);

    const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 5000);
    camera.position.set(7, 5, 9);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;

    const root = new THREE.Group();
    scene.add(root);
    scene.add(new THREE.HemisphereLight("#fffaf0", "#12181c", 3.1));
    const key = new THREE.DirectionalLight("#ffffff", 3.8);
    key.position.set(7, 10, 8);
    scene.add(key);
    const rim = new THREE.DirectionalLight("#70e1ff", 1.25);
    rim.position.set(-8, -2, -5);
    scene.add(rim);

    const selection = new THREE.Mesh(
      new THREE.SphereGeometry(1, 22, 14),
      new THREE.MeshBasicMaterial({
        color: accent,
        wireframe: true,
        transparent: true,
        opacity: 0.8,
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
      inferredForFrame: null,
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
        selection.material.opacity = 0.72 + Math.sin(clock.getElapsedTime() * 4.2) * 0.14;
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
    const sourcePositions = frameArray(frame, ["positions", "position", "pos", "coordinates", "coords"]);
    if (!state || !sourcePositions) return;

    const count = Math.min(manifest.topology.atom_count, Math.floor(sourcePositions.length / 3));
    const atomicNumbers = resolveAtomicNumbers(manifest, count);
    const cellArray = frameArray(frame, ["cell", "cell_vectors", "box"]);
    const basis = createCellBasis(cellArray);
    const pbc = resolvePbc(frame, basis);
    const positions = centeredFramePositions(frame, count) ?? sourcePositions;
    const topologyChanged = count !== state.atomCount;

    if (topologyChanged) {
      replaceAtoms(state, count, atomicNumbers);
      state.bondsForCount = -1;
      state.inferredForFrame = null;
      state.fittedForCount = -1;
    }
    state.positions = positions;
    updateAtoms(state, positions, atomicNumbers);

    const declared = normalizeBonds(manifest.topology.bonds, count);
    if (declared.length > 0 && state.bondsForCount !== count) {
      state.bondPairs = declared;
      state.bondsForCount = count;
      state.inferredForFrame = null;
    } else if (declared.length === 0 && state.inferredForFrame !== frame) {
      state.bondPairs = inferBonds(positions, state.radii, count, basis, pbc);
      state.bondsForCount = -1;
      state.inferredForFrame = frame;
    }
    updateBonds(state, positions, basis, pbc);
    updateCell(state, basis, cellOffset);
    const forces = frameArray(frame, ["forces", "force"]);
    updateForces(state, positions, forces, count, forceScale);

    if (state.atoms) state.atoms.visible = layers.atoms;
    if (state.bonds) state.bonds.visible = layers.bonds;
    if (state.cell) state.cell.visible = layers.cell && Boolean(basis);
    if (state.forces) state.forces.visible = layers.forces && Boolean(forces && forces.length >= count * 3);

    const selected = selectedAtom !== null && selectedAtom >= 0 && selectedAtom < count ? selectedAtom : null;
    if (selected !== null && layers.atoms) {
      const radius = state.radii[selected] ?? 0.35;
      state.selection.position.fromArray(positions, selected * 3);
      state.selection.scale.setScalar(radius * 1.5);
      state.selection.visible = true;
    } else {
      state.selection.visible = false;
    }

    if (state.fittedForCount !== count || state.lastResetSignal !== resetSignal) {
      fitCamera(state, positions, count);
      state.fittedForCount = count;
      state.lastResetSignal = resetSignal;
    }
  }, [cellOffset, forceScale, frame, layers, manifest, resetSignal, selectedAtom]);

  return <canvas ref={canvasRef} className="molecule-canvas" aria-label="Molecular structure" />;
}

function replaceAtoms(state: SceneState, count: number, atomicNumbers: number[]): void {
  if (state.atoms) {
    state.root.remove(state.atoms);
    disposeObject(state.atoms);
  }
  const geometry = new THREE.SphereGeometry(1, 30, 20);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.34, metalness: 0.02 });
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

function updateBonds(state: SceneState, positions: Float32Array, basis: CellBasis | null, pbc: Pbc): void {
  if (state.bonds) {
    state.root.remove(state.bonds);
    disposeObject(state.bonds);
    state.bonds = null;
  }

  const segments = state.bondPairs.flatMap(([a, b]) => periodicBondSegments(positions, a, b, basis, pbc));
  if (segments.length === 0) return;

  const geometry = new THREE.CylinderGeometry(0.038, 0.038, 1, 9, 1, false);
  const material = new THREE.MeshStandardMaterial({
    color: "#b8c2c7",
    roughness: 0.56,
    metalness: 0.01,
    transparent: true,
    opacity: 0.82,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, segments.length);
  const dummy = new THREE.Object3D();
  const direction = new THREE.Vector3();
  segments.forEach(({ from, to }, index) => {
    direction.subVectors(to, from);
    const length = direction.length();
    dummy.position.copy(from).add(to).multiplyScalar(0.5);
    dummy.quaternion.setFromUnitVectors(yAxis, direction.normalize());
    dummy.scale.set(1, length, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  state.bonds = mesh;
  state.root.add(mesh);
}

function updateCell(state: SceneState, basis: CellBasis | null, offset: CellOffset): void {
  if (state.cell) {
    state.root.remove(state.cell);
    disposeObject(state.cell);
    state.cell = null;
  }
  if (!basis) {
    return;
  }
  const group = new THREE.Group();
  const isPrimary = offset.every((value) => value === 0);
  if (!isPrimary) {
    group.add(cellLines(
      basis,
      [0, 0, 0],
      new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.2 }),
    ));
  }
  group.add(cellLines(
    basis,
    offset,
    new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.78 }),
  ));
  state.cell = group;
  state.root.add(group);
}

function cellLines(
  basis: CellBasis,
  offset: CellOffset,
  material: THREE.LineBasicMaterial,
): THREE.LineSegments {
  const corners: THREE.Vector3[] = [];
  for (let i = 0; i <= 1; i += 1) {
    for (let j = 0; j <= 1; j += 1) {
      for (let k = 0; k <= 1; k += 1) {
        corners.push(toCartesian(
          new THREE.Vector3(offset[0] + i - 0.5, offset[1] + j - 0.5, offset[2] + k - 0.5),
          basis,
        ));
      }
    }
  }
  const index = (i: number, j: number, k: number) => i * 4 + j * 2 + k;
  const edges: Array<[number, number]> = [];
  for (let i = 0; i <= 1; i += 1) {
    for (let j = 0; j <= 1; j += 1) edges.push([index(i, j, 0), index(i, j, 1)]);
    for (let k = 0; k <= 1; k += 1) edges.push([index(i, 0, k), index(i, 1, k)]);
  }
  for (let j = 0; j <= 1; j += 1) {
    for (let k = 0; k <= 1; k += 1) edges.push([index(0, j, k), index(1, j, k)]);
  }

  const values = new Float32Array(edges.length * 6);
  edges.forEach(([from, to], edge) => {
    corners[from].toArray(values, edge * 6);
    corners[to].toArray(values, edge * 6 + 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(values, 3));
  return new THREE.LineSegments(geometry, material);
}

function updateForces(
  state: SceneState,
  positions: Float32Array,
  forces: Float32Array | null,
  count: number,
  forceScale: number,
): void {
  if (state.forces) {
    state.root.remove(state.forces);
    disposeObject(state.forces);
    state.forces = null;
  }
  if (!forces || forces.length < count * 3) return;

  const magnitudes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const magnitude = Math.hypot(forces[offset], forces[offset + 1], forces[offset + 2]);
    if (Number.isFinite(magnitude) && magnitude > 1e-12) magnitudes.push(magnitude);
  }
  if (magnitudes.length === 0) return;
  magnitudes.sort((a, b) => a - b);
  const reference = magnitudes[Math.floor((magnitudes.length - 1) * 0.9)];
  const scale = (1.45 / reference) * forceScale;
  const arrows: Array<{ tail: THREE.Vector3; tip: THREE.Vector3; direction: THREE.Vector3; head: number }> = [];
  const direction = new THREE.Vector3();
  const atom = new THREE.Vector3();

  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    direction.set(forces[offset], forces[offset + 1], forces[offset + 2]);
    const magnitude = direction.length();
    if (!Number.isFinite(magnitude) || magnitude <= 1e-12) continue;
    direction.normalize();
    atom.fromArray(positions, offset);
    const length = magnitude * scale;
    const head = Math.min(0.24, Math.max(0.075, length * 0.24));
    const startGap = (state.radii[index] ?? 0.3) * 1.03;
    arrows.push({
      tail: atom.clone().addScaledVector(direction, startGap),
      tip: atom.clone().addScaledVector(direction, startGap + length),
      direction: direction.clone(),
      head: Math.min(head, length * 0.5),
    });
  }
  if (arrows.length === 0) return;

  const group = new THREE.Group();
  const shaftGeometry = new THREE.CylinderGeometry(0.018, 0.018, 1, 8, 1, false);
  const shafts = new THREE.InstancedMesh(
    shaftGeometry,
    new THREE.MeshBasicMaterial({ color: forceColor }),
    arrows.length,
  );
  const dummy = new THREE.Object3D();
  const shaftEnd = new THREE.Vector3();
  arrows.forEach((arrow, index) => {
    shaftEnd.copy(arrow.tip).addScaledVector(arrow.direction, -arrow.head * 0.48);
    const length = arrow.tail.distanceTo(shaftEnd);
    dummy.position.copy(arrow.tail).add(shaftEnd).multiplyScalar(0.5);
    dummy.quaternion.setFromUnitVectors(yAxis, arrow.direction);
    dummy.scale.set(1, length, 1);
    dummy.updateMatrix();
    shafts.setMatrixAt(index, dummy.matrix);
  });
  shafts.instanceMatrix.needsUpdate = true;
  group.add(shafts);

  const headGeometry = new THREE.ConeGeometry(1, 1, 9);
  const heads = new THREE.InstancedMesh(
    headGeometry,
    new THREE.MeshBasicMaterial({ color: forceColor }),
    arrows.length,
  );
  arrows.forEach((arrow, index) => {
    dummy.position.copy(arrow.tip).addScaledVector(arrow.direction, -arrow.head * 0.5);
    dummy.quaternion.setFromUnitVectors(yAxis, arrow.direction);
    dummy.scale.set(arrow.head * 0.34, arrow.head, arrow.head * 0.34);
    dummy.updateMatrix();
    heads.setMatrixAt(index, dummy.matrix);
  });
  heads.instanceMatrix.needsUpdate = true;
  group.add(heads);
  state.forces = group;
  state.root.add(group);
}

function createCellBasis(cell: Float32Array | null): CellBasis | null {
  if (!cell || cell.length < 9) return null;
  const a = new THREE.Vector3(cell[0], cell[1], cell[2]);
  const b = new THREE.Vector3(cell[3], cell[4], cell[5]);
  const c = new THREE.Vector3(cell[6], cell[7], cell[8]);
  const bCrossC = new THREE.Vector3().crossVectors(b, c);
  const determinant = a.dot(bCrossC);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  return {
    vectors: [a, b, c],
    reciprocal: [
      bCrossC.multiplyScalar(1 / determinant),
      new THREE.Vector3().crossVectors(c, a).multiplyScalar(1 / determinant),
      new THREE.Vector3().crossVectors(a, b).multiplyScalar(1 / determinant),
    ],
  };
}

function resolvePbc(frame: FrameData | null, basis: CellBasis | null): Pbc {
  if (!basis) return [false, false, false];
  const values = frame?.header.pbc;
  if (!values) return [true, true, true];
  return [Boolean(values?.[0]), Boolean(values?.[1]), Boolean(values?.[2])];
}

function wrapPositions(source: Float32Array, count: number, basis: CellBasis | null, pbc: Pbc): Float32Array {
  const result = new Float32Array(source.subarray(0, count * 3));
  if (!basis || !pbc.some(Boolean)) return result;
  const point = new THREE.Vector3();
  for (let index = 0; index < count; index += 1) {
    point.fromArray(source, index * 3);
    const fractional = toFractional(point, basis);
    if (pbc[0]) fractional.x -= Math.floor(fractional.x + 0.5);
    if (pbc[1]) fractional.y -= Math.floor(fractional.y + 0.5);
    if (pbc[2]) fractional.z -= Math.floor(fractional.z + 0.5);
    toCartesian(fractional, basis).toArray(result, index * 3);
  }
  return result;
}

function toFractional(point: THREE.Vector3, basis: CellBasis): THREE.Vector3 {
  return new THREE.Vector3(
    point.dot(basis.reciprocal[0]),
    point.dot(basis.reciprocal[1]),
    point.dot(basis.reciprocal[2]),
  );
}

function toCartesian(fractional: THREE.Vector3, basis: CellBasis): THREE.Vector3 {
  return new THREE.Vector3()
    .addScaledVector(basis.vectors[0], fractional.x)
    .addScaledVector(basis.vectors[1], fractional.y)
    .addScaledVector(basis.vectors[2], fractional.z);
}

function minimumImageFraction(delta: THREE.Vector3, basis: CellBasis, pbc: Pbc): THREE.Vector3 {
  const base = delta.clone();
  if (pbc[0]) base.x -= Math.floor(base.x + 0.5);
  if (pbc[1]) base.y -= Math.floor(base.y + 0.5);
  if (pbc[2]) base.z -= Math.floor(base.z + 0.5);

  let best = base.clone();
  let bestLength = toCartesian(best, basis).lengthSq();
  for (let i = pbc[0] ? -1 : 0; i <= (pbc[0] ? 1 : 0); i += 1) {
    for (let j = pbc[1] ? -1 : 0; j <= (pbc[1] ? 1 : 0); j += 1) {
      for (let k = pbc[2] ? -1 : 0; k <= (pbc[2] ? 1 : 0); k += 1) {
        const candidate = new THREE.Vector3(base.x + i, base.y + j, base.z + k);
        const length = toCartesian(candidate, basis).lengthSq();
        if (length < bestLength - 1e-12) {
          best = candidate;
          bestLength = length;
        }
      }
    }
  }
  return best;
}

function periodicBondSegments(
  positions: Float32Array,
  aIndex: number,
  bIndex: number,
  basis: CellBasis | null,
  pbc: Pbc,
): Segment[] {
  const a = new THREE.Vector3().fromArray(positions, aIndex * 3);
  const b = new THREE.Vector3().fromArray(positions, bIndex * 3);
  if (!basis || !pbc.some(Boolean)) return [{ from: a, to: b }];

  const start = toFractional(a, basis);
  const directDelta = toFractional(b, basis).sub(start);
  const delta = minimumImageFraction(directDelta, basis, pbc);
  const crossings = [0, 1];
  const starts = [start.x, start.y, start.z];
  const changes = [delta.x, delta.y, delta.z];

  for (let axis = 0; axis < 3; axis += 1) {
    if (!pbc[axis] || Math.abs(changes[axis]) < 1e-12) continue;
    const end = starts[axis] + changes[axis];
    const low = Math.min(starts[axis], end);
    const high = Math.max(starts[axis], end);
    const firstFace = Math.ceil(low - 0.5 + 1e-9);
    const lastFace = Math.floor(high - 0.5 - 1e-9);
    for (let image = firstFace; image <= lastFace; image += 1) {
      const time = (image + 0.5 - starts[axis]) / changes[axis];
      if (time > 1e-9 && time < 1 - 1e-9) crossings.push(time);
    }
  }

  crossings.sort((left, right) => left - right);
  const times = crossings.filter((value, index) => index === 0 || Math.abs(value - crossings[index - 1]) > 1e-8);
  const result: Segment[] = [];
  for (let index = 0; index + 1 < times.length; index += 1) {
    const fromTime = times[index];
    const toTime = times[index + 1];
    const middle = start.clone().addScaledVector(delta, (fromTime + toTime) * 0.5);
    const shift = new THREE.Vector3(
      pbc[0] ? Math.floor(middle.x + 0.5) : 0,
      pbc[1] ? Math.floor(middle.y + 0.5) : 0,
      pbc[2] ? Math.floor(middle.z + 0.5) : 0,
    );
    const from = toCartesian(start.clone().addScaledVector(delta, fromTime).sub(shift), basis);
    const to = toCartesian(start.clone().addScaledVector(delta, toTime).sub(shift), basis);
    if (from.distanceToSquared(to) > 1e-10) result.push({ from, to });
  }
  return result;
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

function inferBonds(
  positions: Float32Array,
  radii: number[],
  count: number,
  basis: CellBasis | null,
  pbc: Pbc,
): Array<[number, number]> {
  if (count > 5000) return [];
  const result: Array<[number, number]> = [];
  const largestRadius = radii.reduce((largest, radius) => Math.max(largest, radius), 0.35);
  const cellSize = largestRadius * 5.8;
  const cells = new Map<string, Array<[number, number, number, number]>>();
  const shifts = periodicShifts(basis, pbc);

  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    const cz = Math.floor(z / cellSize);
    const nearest = new Map<number, number>();

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const images = cells.get(`${cx + dx}:${cy + dy}:${cz + dz}`) ?? [];
          for (const [peer, px, py, pz] of images) {
            const distance = Math.hypot(x - px, y - py, z - pz);
            const previous = nearest.get(peer);
            if (previous === undefined || distance < previous) nearest.set(peer, distance);
          }
        }
      }
    }

    for (const [peer, distance] of nearest) {
      const cutoff = (radii[index] + radii[peer]) * 2.9;
      if (distance > 0.2 && distance <= cutoff) result.push([peer, index]);
    }

    for (const shift of shifts) {
      const px = x + shift.x;
      const py = y + shift.y;
      const pz = z + shift.z;
      const key = `${Math.floor(px / cellSize)}:${Math.floor(py / cellSize)}:${Math.floor(pz / cellSize)}`;
      const bucket = cells.get(key) ?? [];
      bucket.push([index, px, py, pz]);
      cells.set(key, bucket);
    }
  }
  return result;
}

function periodicShifts(basis: CellBasis | null, pbc: Pbc): THREE.Vector3[] {
  if (!basis || !pbc.some(Boolean)) return [new THREE.Vector3()];
  const shifts: THREE.Vector3[] = [];
  for (let i = pbc[0] ? -1 : 0; i <= (pbc[0] ? 1 : 0); i += 1) {
    for (let j = pbc[1] ? -1 : 0; j <= (pbc[1] ? 1 : 0); j += 1) {
      for (let k = pbc[2] ? -1 : 0; k <= (pbc[2] ? 1 : 0); k += 1) {
        shifts.push(toCartesian(new THREE.Vector3(i, j, k), basis));
      }
    }
  }
  return shifts;
}

function fitCamera(state: SceneState, positions: Float32Array, count: number): void {
  if (count === 0) return;
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let index = 0; index < count; index += 1) bounds.expandByPoint(point.fromArray(positions, index * 3));
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 1.6);
  const distance = radius / Math.tan(THREE.MathUtils.degToRad(state.camera.fov * 0.5)) * 1.2;
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
  return new THREE.Color(elementColors[atomicNumber] ?? "#c7ced1");
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
  1: "#fffdf7", 2: "#e4ffff", 3: "#c69bea", 4: "#d3e795", 5: "#e4ab82", 6: "#9da9af",
  7: "#7399ef", 8: "#f2766d", 9: "#89d394", 10: "#9aebed", 11: "#b18ce4", 12: "#a0bf82",
  13: "#c7b8ae", 14: "#d5aa82", 15: "#ed9e54", 16: "#ead462", 17: "#74ca88", 18: "#8bdce2",
  19: "#aa7bdd", 20: "#99ba7b", 26: "#cf8964", 29: "#d19a71", 30: "#adb3b7", 35: "#b65a4c", 53: "#8d61b5",
};
