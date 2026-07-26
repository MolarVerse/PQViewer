import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { frameArray } from "./api";
import type {
  FigureAnnotation,
  FigureBackground,
  FigureCorner,
} from "./figureRecipe";
import {
  flipRgbaRowsInPlace,
  hasVisiblePngContent,
  MAX_PNG_EXPORT_PIXELS,
  pngExportAoScale,
  pngExportSampleLevel,
  resolvePngExportOptions,
} from "./scene/pngExport";
import type { PngExportLimits, PngExportOptions, ResolvedPngExportOptions } from "./scene/pngExport";
import { encodeFigurePng, encodeFigureTiff } from "./scene/figureEncoding";
import { publicationCamera, publicationContextUsesPoints } from "./scene/publication";
import { loadPublicationFont } from "./scene/publicationFont";
import {
  backboneResidues,
  cellImageCorners,
  centeredFramePositions,
  detectWaterAtoms,
  fractionalStructureCenter,
  framePbc,
  frameGeometryLayout,
  hasFrameCell,
  imageTranslation,
  imageLayoutShape,
  includeCellInFit,
  MAX_BOND_INSTANCES,
  MAX_SPHERE_INSTANCES,
  periodicBondSegments,
  prepareFrameGeometry,
  prepareScene,
  prepareTopology,
  publicationBondGeometry,
  sameFrameGeometryLayout,
  transformDisplayVector,
  unwrapPointNear,
  usesHighDetailGeometry,
  usesPointAtoms,
} from "./scene/model";
import type {
  CellBasis,
  FrameGeometryLayout,
  FrameGeometryPlan,
  PreparedScene,
  PreparedTopology,
  Segment,
} from "./scene/model";
import type {
  Appearance,
  AtomSelection,
  CellOffset,
  FrameData,
  Manifest,
  SceneCapabilities,
  ScenePresentation,
} from "./types";
import type { SceneSelectionContext } from "./scientificSelection";

type GtaoPassConstructor = typeof import("three/examples/jsm/postprocessing/GTAOPass.js").GTAOPass;
type LineMaterialConstructor = typeof import("three/examples/jsm/lines/LineMaterial.js").LineMaterial;
type LineSegments2Constructor = typeof import("three/examples/jsm/lines/LineSegments2.js").LineSegments2;
type LineSegmentsGeometryConstructor = typeof import("three/examples/jsm/lines/LineSegmentsGeometry.js").LineSegmentsGeometry;

const MAX_SELECTION_RING_MARKERS = 512;
export const MAX_TRAIL_ATOMS = 16;
export const MAX_TRAIL_POINTS = 512;
export const MAX_DISPLACEMENT_ATOMS = 32;

const emptyTrajectoryOverlays: TrajectoryOverlays = Object.freeze({
  trails: Object.freeze([]),
  displacements: Object.freeze([]),
});

export interface SelectionMarkerState {
  mode: "rings" | "points";
  pointCapacity: number;
  reusePointBuffer: boolean;
  clearRingMarkers: boolean;
}

export interface SelectionRenderState {
  selection: THREE.Group;
  selectionGeometry: THREE.RingGeometry;
  selectionMaterial: THREE.MeshBasicMaterial;
  selectionPoints: THREE.Points;
  instanceToAtom: Uint32Array;
  instanceImages: Int8Array;
  baseImages: Int32Array;
  model: PreparedScene | null;
}

export function selectionMarkerState(
  selectedCount: number,
  instanceCount: number,
  currentPointCapacity: number | null,
): SelectionMarkerState {
  const mode = selectedCount > MAX_SELECTION_RING_MARKERS ? "points" : "rings";
  const pointCapacity = mode === "points"
    ? Math.min(selectedCount, instanceCount)
    : 0;
  return {
    mode,
    pointCapacity,
    reusePointBuffer: mode === "points"
      && currentPointCapacity !== null
      && currentPointCapacity >= pointCapacity,
    clearRingMarkers: mode === "points",
  };
}

export {
  centeredFramePositions,
  fractionalStructureCenter,
  framePbc,
  hasFrameCell,
  periodicBondSegments,
} from "./scene/model";
export type { PngExportOptions } from "./scene/pngExport";

interface SelectionRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface MoleculeSceneProps {
  manifest: Manifest;
  frame: FrameData | null;
  presentation: ScenePresentation;
  selectedAtoms: AtomSelection[];
  trajectoryOverlays?: TrajectoryOverlays;
  resetSignal: number;
  forceScale: number;
  velocityScale: number;
  appearance: Appearance;
  viewPreset?: ViewPreset;
  viewSignal?: number;
  onSelect: (selection: AtomSelection | null, additive: boolean) => void;
  onSelectMany?: (selections: AtomSelection[], additive: boolean) => void;
  onSceneInfo?: (info: RenderedSceneInfo | null) => void;
  onSelectionContext?: (context: SceneSelectionContext | null) => void;
  onSelectionPositions?: (positions: Float64Array | null) => void;
}

export type ViewPreset = "perspective" | "xy" | "xz" | "yz";

export interface SceneCameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  zoom: number;
  near: number;
  far: number;
}

export interface MoleculeSceneHandle {
  exportPng: (options: PngExportOptions) => Promise<Blob>;
  exportFigure: (options: FigureExportOptions) => Promise<Blob>;
  captureCamera: () => SceneCameraState;
  restoreCamera: (camera: SceneCameraState) => void;
}

export interface FigureExportOptions extends PngExportOptions {
  format?: "png" | "tiff";
  dpi?: number;
  background?: FigureBackground;
  annotations?: readonly FigureAnnotation[];
}

interface ResolvedFigureExportOptions extends ResolvedPngExportOptions {
  format: "png" | "tiff";
  dpi: number;
  background: FigureBackground;
  annotations: readonly FigureAnnotation[];
}

export interface RenderedSceneInfo {
  imageCount: number;
  forceCount: number;
  forceTotal: number;
  velocityCount: number;
  velocityTotal: number;
  capabilities: SceneCapabilities;
}

export interface AtomTrailOverlay {
  id: string;
  atom: number;
  image: CellOffset;
  points: Float32Array;
}

export interface AtomDisplacementOverlay {
  id: string;
  atom: number;
  image: CellOffset;
  from: [number, number, number];
  to: [number, number, number];
}

export interface TrajectoryOverlays {
  trails: readonly AtomTrailOverlay[];
  displacements: readonly AtomDisplacementOverlay[];
}

export function isAdditivePick(
  event: Pick<PointerEvent, "pointerType" | "shiftKey" | "metaKey" | "ctrlKey">,
): boolean {
  return event.pointerType === "touch"
    || event.pointerType === "pen"
    || event.shiftKey
    || event.metaKey
    || event.ctrlKey;
}

interface FitContext {
  model: PreparedScene;
  presentation: ScenePresentation;
  preset: ViewPreset;
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  hemisphere: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  root: THREE.Group;
  atomObject: THREE.InstancedMesh | THREE.Points | null;
  bonds: THREE.Object3D | null;
  cell: THREE.LineSegments | null;
  forces: THREE.Group | null;
  velocities: THREE.Group | null;
  ribbon: THREE.Mesh | null;
  trajectoryOverlays: THREE.Group;
  selection: THREE.Group;
  selectionGeometry: THREE.RingGeometry;
  selectionMaterial: THREE.MeshBasicMaterial;
  selectionPoints: THREE.Points;
  selectionPointsMaterial: THREE.PointsMaterial;
  keyboardFocus: THREE.Mesh;
  keyboardFocusMaterial: THREE.MeshBasicMaterial;
  pickables: THREE.Object3D[];
  instanceToAtom: Uint32Array;
  instanceImages: Int8Array;
  baseImages: Int32Array;
  model: PreparedScene | null;
  topologyManifest: Manifest | null;
  preparedTopology: PreparedTopology | null;
  renderTopology: PreparedTopology | null;
  renderConfigKey: string;
  frameLayout: FrameGeometryLayout | null;
  fittedKey: string;
  lastResetSignal: number;
  lastViewSignal: number;
  lastFittedAspect: number;
  fitContext: FitContext | null;
  cameraMode: "fit" | "manual";
}

interface PublicationSnapshot {
  model: PreparedScene;
  manifest: Manifest;
  presentation: ScenePresentation;
  forces: THREE.Group | null;
  velocities: THREE.Group | null;
  camera: THREE.PerspectiveCamera;
  target: THREE.Vector3;
}

interface ScenePalette {
  background: string;
  bond: string;
  bondOpacity: number;
  cell: string;
  cellOpacity: number;
  selection: string;
  selectionOpacity: number;
  force: string;
  velocity: string;
  displacement: string;
  ribbon: string;
  hemisphereSky: string;
  hemisphereGround: string;
  hemisphereIntensity: number;
  key: string;
  keyIntensity: number;
  rim: string;
  rimIntensity: number;
  exposure: number;
}

const scenePalettes: Record<Appearance, ScenePalette> = {
  light: {
    background: "#F6F8F8",
    bond: "#375159",
    bondOpacity: 0.9,
    cell: "#2D7DA4",
    cellOpacity: 0.58,
    selection: "#3DACCB",
    selectionOpacity: 0.34,
    force: "#B8522D",
    velocity: "#6B62A8",
    displacement: "#087F8C",
    ribbon: "#3D879D",
    hemisphereSky: "#ffffff",
    hemisphereGround: "#c6d2d5",
    hemisphereIntensity: 1.55,
    key: "#ffffff",
    keyIntensity: 2.25,
    rim: "#8fcbd3",
    rimIntensity: 0.22,
    exposure: 0.95,
  },
  dark: {
    background: "#1e2e33",
    bond: "#c0c9cb",
    bondOpacity: 0.9,
    cell: "#5db8d2",
    cellOpacity: 0.74,
    selection: "#72d4df",
    selectionOpacity: 0.42,
    force: "#f0a75a",
    velocity: "#9e98d7",
    displacement: "#72d4df",
    ribbon: "#6cb9ca",
    hemisphereSky: "#f5f6f2",
    hemisphereGround: "#17272c",
    hemisphereIntensity: 1.42,
    key: "#eef2ef",
    keyIntensity: 2,
    rim: "#62b7cd",
    rimIntensity: 0.34,
    exposure: 0.96,
  },
};

const yAxis = new THREE.Vector3(0, 1, 0);

export function sceneCapabilities(manifest: Manifest, frame: FrameData | null): SceneCapabilities {
  const water = detectWaterAtoms(manifest, frame).size > 0;
  const ribbon = backboneResidues(manifest).length >= 3;
  const periodic = hasFrameCell(frame) && framePbc(frame).some(Boolean);
  return buildSceneCapabilities(manifest, water, ribbon, periodic);
}

function buildSceneCapabilities(
  manifest: Manifest,
  water: boolean,
  ribbon: boolean,
  periodic: boolean,
): SceneCapabilities {
  let ribbonReason = "Backbone available";
  if (!ribbon) {
    ribbonReason = manifest.topology.residues?.length && manifest.topology.atom_names?.length
      ? "Three complete backbone residues required"
      : "Backbone topology unavailable";
  }
  return {
    water,
    ribbon,
    ribbonReason,
    suggestedProfile: ribbon ? "protein" : periodic && !water ? "crystal" : "molecule",
  };
}

function renderedSceneInfo(
  manifest: Manifest,
  model: PreparedScene,
  geometry: FrameGeometryPlan,
): RenderedSceneInfo {
  return {
    imageCount: model.images.length,
    forceCount: geometry.forceInstances.length,
    forceTotal: geometry.forceTotal,
    velocityCount: geometry.velocityInstances.length,
    velocityTotal: geometry.velocityTotal,
    capabilities: buildSceneCapabilities(
      manifest,
      model.waterAtoms.size > 0,
      model.backbone.length >= 3,
      Boolean(model.basis && model.pbc.some(Boolean)),
    ),
  };
}

function sceneSelectionContext(
  manifest: Manifest,
  model: PreparedScene,
): SceneSelectionContext {
  const cell = model.basis
    ? Float64Array.from(model.basis.vectors.flatMap((vector) => [
        vector.x,
        vector.y,
        vector.z,
      ]))
    : null;
  return {
    count: model.count,
    atomicNumbers: model.atomicNumbers,
    positions: model.positions,
    baseImages: model.baseImages,
    cell,
    bonds: model.bonds,
    waterAtoms: model.waterAtoms,
    instanceToAtom: model.instanceToAtom,
    instanceImages: model.instanceImages,
    atomResidueIndex: manifest.topology.atom_residue_index,
  };
}

function sameRenderedSceneInfo(left: RenderedSceneInfo, right: RenderedSceneInfo): boolean {
  return left.imageCount === right.imageCount
    && left.forceCount === right.forceCount
    && left.forceTotal === right.forceTotal
    && left.velocityCount === right.velocityCount
    && left.velocityTotal === right.velocityTotal
    && left.capabilities.water === right.capabilities.water
    && left.capabilities.ribbon === right.capabilities.ribbon
    && left.capabilities.ribbonReason === right.capabilities.ribbonReason
    && left.capabilities.suggestedProfile === right.capabilities.suggestedProfile;
}

export const MoleculeScene = forwardRef<MoleculeSceneHandle, MoleculeSceneProps>(function MoleculeScene({
  manifest,
  frame,
  presentation,
  selectedAtoms,
  trajectoryOverlays = emptyTrajectoryOverlays,
  resetSignal,
  forceScale,
  velocityScale,
  appearance,
  viewPreset = "perspective",
  viewSignal = 0,
  onSelect,
  onSelectMany,
  onSceneInfo,
  onSelectionContext,
  onSelectionPositions,
}: MoleculeSceneProps, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<SceneState | null>(null);
  const selectRef = useRef(onSelect);
  const selectManyRef = useRef(onSelectMany);
  const selectedAtomsRef = useRef(selectedAtoms);
  const sceneInfoRef = useRef(onSceneInfo);
  const selectionContextRef = useRef(onSelectionContext);
  const selectionPositionsRef = useRef(onSelectionPositions);
  const reportedInfoRef = useRef<{ manifest: Manifest; info: RenderedSceneInfo } | null>(null);
  const exportActiveRef = useRef(false);
  const [keyboardSelection, setKeyboardSelection] = useState<AtomSelection | null>(null);
  const [boxSelection, setBoxSelection] = useState<SelectionRectangle | null>(null);
  const keyboardSelectionRef = useRef<AtomSelection | null>(null);
  const keyboardInstanceRef = useRef<number | null>(null);
  selectRef.current = onSelect;
  selectManyRef.current = onSelectMany;
  selectedAtomsRef.current = selectedAtoms;
  keyboardSelectionRef.current = keyboardSelection;
  sceneInfoRef.current = onSceneInfo;
  selectionContextRef.current = onSelectionContext;
  selectionPositionsRef.current = onSelectionPositions;

  useImperativeHandle(ref, () => ({
    exportPng: async (options) => {
      if (exportActiveRef.current) throw new Error("A figure export is already in progress");
      const state = stateRef.current;
      if (!state?.model) throw new Error("The molecular scene is not ready to export");
      const snapshot = capturePublicationSnapshot(state);
      exportActiveRef.current = true;
      try {
        return await exportSceneFigure(state.renderer, snapshot, {
          ...options,
          format: "png",
        });
      } finally {
        exportActiveRef.current = false;
      }
    },
    exportFigure: async (options) => {
      if (exportActiveRef.current) throw new Error("A figure export is already in progress");
      const state = stateRef.current;
      if (!state?.model) throw new Error("The molecular scene is not ready to export");
      const snapshot = capturePublicationSnapshot(state);
      exportActiveRef.current = true;
      try {
        return await exportSceneFigure(state.renderer, snapshot, options);
      } finally {
        exportActiveRef.current = false;
      }
    },
    captureCamera: () => {
      const state = stateRef.current;
      if (!state) throw new Error("The molecular scene is not ready");
      return captureCameraState(state.camera, state.controls.target);
    },
    restoreCamera: (camera) => {
      const state = stateRef.current;
      if (!state) throw new Error("The molecular scene is not ready");
      restoreCameraState(state, camera);
    },
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    let pixelRatio = Math.min(window.devicePixelRatio, 2);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    const palette = scenePalettes.light;
    scene.background = new THREE.Color(palette.background);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 5000);
    camera.position.set(7, 5, 9);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    const root = new THREE.Group();
    scene.add(root);
    const hemisphere = new THREE.HemisphereLight(
      palette.hemisphereSky,
      palette.hemisphereGround,
      palette.hemisphereIntensity,
    );
    scene.add(hemisphere);
    const key = new THREE.DirectionalLight(palette.key, palette.keyIntensity);
    key.position.set(7, 10, 8);
    scene.add(key);
    const rim = new THREE.DirectionalLight(palette.rim, palette.rimIntensity);
    rim.position.set(-8, -2, -5);
    scene.add(rim);
    const selection = new THREE.Group();
    const selectionGeometry = new THREE.RingGeometry(0.94, 1, 64);
    const selectionMaterial = new THREE.MeshBasicMaterial({
      color: palette.selection,
      transparent: true,
      opacity: palette.selectionOpacity,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    root.add(selection);
    const selectionPointsMaterial = new THREE.PointsMaterial({
      color: palette.selection,
      size: 7,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    });
    const selectionPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      selectionPointsMaterial,
    );
    selectionPoints.renderOrder = 10;
    selectionPoints.frustumCulled = false;
    selectionPoints.visible = false;
    root.add(selectionPoints);
    const keyboardFocusMaterial = new THREE.MeshBasicMaterial({
      color: palette.selection,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    const keyboardFocus = new THREE.Mesh(selectionGeometry, keyboardFocusMaterial);
    keyboardFocus.renderOrder = 11;
    keyboardFocus.visible = false;
    root.add(keyboardFocus);
    const trajectoryOverlayGroup = new THREE.Group();
    trajectoryOverlayGroup.renderOrder = 7;
    root.add(trajectoryOverlayGroup);
    const state: SceneState = {
      renderer,
      scene,
      hemisphere,
      key,
      rim,
      camera,
      controls,
      root,
      atomObject: null,
      bonds: null,
      cell: null,
      forces: null,
      velocities: null,
      ribbon: null,
      trajectoryOverlays: trajectoryOverlayGroup,
      selection,
      selectionGeometry,
      selectionMaterial,
      selectionPoints,
      selectionPointsMaterial,
      keyboardFocus,
      keyboardFocusMaterial,
      pickables: [],
      instanceToAtom: new Uint32Array(),
      instanceImages: new Int8Array(),
      baseImages: new Int32Array(),
      model: null,
      topologyManifest: null,
      preparedTopology: null,
      renderTopology: null,
      renderConfigKey: "",
      frameLayout: null,
      fittedKey: "",
      lastResetSignal: resetSignal,
      lastViewSignal: viewSignal,
      lastFittedAspect: 1,
      fitContext: null,
      cameraMode: "fit",
    };
    stateRef.current = state;
    const markCameraManual = () => {
      state.cameraMode = "manual";
    };
    controls.addEventListener("start", markCameraManual);

    let renderWidth = 0;
    let renderHeight = 0;
    const resize = () => {
      const width = Math.max(canvas.clientWidth, 1);
      const height = Math.max(canvas.clientHeight, 1);
      const nextPixelRatio = Math.min(window.devicePixelRatio, 2);
      const pixelRatioChanged = nextPixelRatio !== pixelRatio;
      if (width === renderWidth && height === renderHeight && !pixelRatioChanged) return;
      pixelRatio = nextPixelRatio;
      renderWidth = width;
      renderHeight = height;
      renderer.setDrawingBufferSize(width, height, pixelRatio);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (
        state.cameraMode === "fit"
        && state.fitContext
        && Math.abs(Math.log(camera.aspect / state.lastFittedAspect)) > 0.06
      ) {
        fitCamera(state, state.fitContext);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener("resize", resize);
    resize();

    const pointerStart = new THREE.Vector2();
    let pickPointerId: number | null = null;
    let boxPointerId: number | null = null;
    let multiPointerGesture = false;
    const pointer = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points!.threshold = 0.24;
    const pickAt = (event: PointerEvent, additive = isAdditivePick(event)) => {
      const bounds = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(state.pickables, false)[0];
      const picked = hit ? pickedAtom(hit, state) : null;
      if (document.activeElement === canvas) {
        keyboardSelectionRef.current = picked;
        keyboardInstanceRef.current = hit && hit.object === state.atomObject
          ? hit.instanceId ?? hit.index ?? null
          : null;
        setKeyboardSelection(picked);
      }
      selectRef.current(picked, additive);
    };
    const resetBoxSelection = () => {
      if (boxPointerId !== null && canvas.hasPointerCapture(boxPointerId)) {
        canvas.releasePointerCapture(boxPointerId);
      }
      boxPointerId = null;
      controls.enabled = true;
      setBoxSelection(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.pointerType === "mouse"
        && event.button === 0
        && event.shiftKey
        && boxPointerId === null
      ) {
        boxPointerId = event.pointerId;
        pointerStart.set(event.clientX, event.clientY);
        controls.enabled = false;
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (pickPointerId !== null && event.pointerId !== pickPointerId) {
        multiPointerGesture = true;
        return;
      }
      if (!event.isPrimary) return;
      pickPointerId = event.pointerId;
      multiPointerGesture = false;
      pointerStart.set(event.clientX, event.clientY);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== boxPointerId) return;
      const bounds = canvas.getBoundingClientRect();
      const left = Math.max(bounds.left, Math.min(pointerStart.x, event.clientX));
      const right = Math.min(bounds.right, Math.max(pointerStart.x, event.clientX));
      const top = Math.max(bounds.top, Math.min(pointerStart.y, event.clientY));
      const bottom = Math.min(bounds.bottom, Math.max(pointerStart.y, event.clientY));
      if (pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5) {
        setBoxSelection({
          left,
          top,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top),
        });
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === boxPointerId) {
        const moved = pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5;
        if (moved) {
          selectManyRef.current?.(
            selectionsInRectangle(state, canvas.getBoundingClientRect(), pointerStart, {
              x: event.clientX,
              y: event.clientY,
            }),
            true,
          );
        } else {
          pickAt(event, true);
        }
        resetBoxSelection();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.pointerId !== pickPointerId) return;
      pickPointerId = null;
      const moved = pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5;
      const gesture = multiPointerGesture;
      multiPointerGesture = false;
      if (moved || gesture) return;
      pickAt(event);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === boxPointerId) {
        resetBoxSelection();
        return;
      }
      if (event.pointerId !== pickPointerId) return;
      pickPointerId = null;
      multiPointerGesture = false;
    };
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || boxPointerId === null) return;
      resetBoxSelection();
      event.preventDefault();
    };
    const updateKeyboardSelection = (
      selection: AtomSelection | null,
      instance: number | null,
    ) => {
      keyboardSelectionRef.current = selection;
      keyboardInstanceRef.current = instance;
      setKeyboardSelection(selection);
    };
    const onFocus = () => {
      if (keyboardSelectionRef.current) return;
      const cursor = nextKeyboardAtomCursor(
        state.instanceToAtom,
        state.instanceImages,
        selectedAtomsRef.current.at(-1) ?? null,
        null,
        0,
        state.baseImages,
      );
      updateKeyboardSelection(cursor?.selection ?? null, cursor?.instance ?? null);
    };
    const onBlur = () => updateKeyboardSelection(null, null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const direction = event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowUp"
          ? -1
          : 0;
      if (direction !== 0) {
        event.preventDefault();
        const cursor = nextKeyboardAtomCursor(
          state.instanceToAtom,
          state.instanceImages,
          keyboardSelectionRef.current,
          keyboardInstanceRef.current,
          direction,
          state.baseImages,
        );
        updateKeyboardSelection(cursor?.selection ?? null, cursor?.instance ?? null);
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (event.repeat) return;
      const cursor = nextKeyboardAtomCursor(
        state.instanceToAtom,
        state.instanceImages,
        keyboardSelectionRef.current ?? selectedAtomsRef.current.at(-1) ?? null,
        keyboardInstanceRef.current,
        0,
        state.baseImages,
      );
      if (!cursor) return;
      updateKeyboardSelection(cursor.selection, cursor.instance);
      selectRef.current(cursor.selection, true);
    };
    canvas.addEventListener("pointerdown", onPointerDown, true);
    canvas.addEventListener("pointermove", onPointerMove, true);
    canvas.addEventListener("pointerup", onPointerUp, true);
    canvas.addEventListener("pointercancel", onPointerCancel, true);
    canvas.addEventListener("focus", onFocus);
    canvas.addEventListener("blur", onBlur);
    canvas.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onWindowKeyDown);
    renderer.setAnimationLoop(() => {
      controls.update();
      selection.children.forEach((marker) => {
        if (marker.visible) marker.quaternion.copy(camera.quaternion);
      });
      if (keyboardFocus.visible) keyboardFocus.quaternion.copy(camera.quaternion);
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("pointermove", onPointerMove, true);
      canvas.removeEventListener("pointerup", onPointerUp, true);
      canvas.removeEventListener("pointercancel", onPointerCancel, true);
      canvas.removeEventListener("focus", onFocus);
      canvas.removeEventListener("blur", onBlur);
      canvas.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onWindowKeyDown);
      controls.removeEventListener("start", markCameraManual);
      controls.dispose();
      root.remove(selection);
      root.remove(selectionPoints);
      root.remove(keyboardFocus);
      root.remove(trajectoryOverlayGroup);
      disposeObject(root);
      disposeObject(trajectoryOverlayGroup);
      selection.clear();
      selectionGeometry.dispose();
      selectionMaterial.dispose();
      selectionPoints.geometry.dispose();
      selectionPointsMaterial.dispose();
      keyboardFocusMaterial.dispose();
      renderer.dispose();
      stateRef.current = null;
      selectionContextRef.current?.(null);
      selectionPositionsRef.current?.(null);
    };
  }, []);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const palette = scenePalettes[appearance];
    applyScenePalette(state, palette);
    if (state.model) applyRenderablePalette(state, manifest, state.model, presentation, appearance, palette);
  }, [appearance]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    if (state.topologyManifest !== manifest || !state.preparedTopology) {
      state.topologyManifest = manifest;
      state.preparedTopology = prepareTopology(manifest, frame);
    }
    const model = prepareScene(manifest, frame, presentation, state.preparedTopology);
    if (!model) {
      if (reportedInfoRef.current) {
        reportedInfoRef.current = null;
        sceneInfoRef.current?.(null);
      }
      selectionContextRef.current?.(null);
      return;
    }
    const forces = frameArray(frame, ["forces", "force"]);
    const velocities = frameArray(frame, ["velocities", "velocity", "vel"]);
    const frameGeometry = prepareFrameGeometry(model, presentation, forces, velocities);
    const info = renderedSceneInfo(manifest, model, frameGeometry);
    if (
      reportedInfoRef.current?.manifest !== manifest
      || !sameRenderedSceneInfo(reportedInfoRef.current.info, info)
    ) {
      reportedInfoRef.current = { manifest, info };
      sceneInfoRef.current?.(info);
    }
    const frameLayout = frameGeometryLayout(frameGeometry);
    const configKey = renderConfigKey(presentation);
    const reuse = presentation.mode !== "ribbon"
      && state.preparedTopology?.count === model.count
      && state.renderTopology === state.preparedTopology
      && state.renderConfigKey === configKey
      && state.frameLayout !== null
      && sameFrameGeometryLayout(state.frameLayout, frameLayout)
      && updateFrameRenderables(
        state,
        model,
        presentation,
        forces,
        velocities,
        forceScale,
        velocityScale,
        frameGeometry,
      );

    if (!reuse) {
      clearRenderables(state);
      buildFrameRenderables(
        state,
        model,
        manifest,
        presentation,
        appearance,
        forces,
        velocities,
        forceScale,
        velocityScale,
        frameGeometry,
      );
    }
    state.model = model;
    state.instanceToAtom = model.instanceToAtom;
    state.instanceImages = model.instanceImages;
    state.baseImages = model.baseImages;
    state.renderTopology = state.preparedTopology;
    state.renderConfigKey = configKey;
    state.frameLayout = frameLayout;
    selectionContextRef.current?.(sceneSelectionContext(manifest, model));

    const fitContext = { model, presentation, preset: viewPreset };
    state.fitContext = fitContext;
    const fitKey = layoutKey(model, presentation);
    if (
      state.fittedKey !== fitKey
      || state.lastResetSignal !== resetSignal
      || state.lastViewSignal !== viewSignal
    ) {
      fitCamera(state, fitContext);
      state.fittedKey = fitKey;
      state.lastResetSignal = resetSignal;
      state.lastViewSignal = viewSignal;
    }
  }, [
    forceScale,
    velocityScale,
    frame,
    manifest,
    presentation,
    resetSignal,
    viewPreset,
    viewSignal,
  ]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    updateTrajectoryOverlayGroup(
      state.trajectoryOverlays,
      state.model,
      trajectoryOverlays,
      appearance,
    );
  }, [appearance, frame, presentation, trajectoryOverlays]);

  useEffect(() => {
    const state = stateRef.current;
    const positions = state
      ? updateSelectionMarkers(state, selectedAtoms, Boolean(selectionPositionsRef.current))
      : null;
    let resolved = keyboardSelection;
    let resolvedInstance = keyboardInstanceRef.current;
    const canvasFocused = document.activeElement === canvasRef.current;
    const currentInstance = state
      ? updateKeyboardFocus(state, resolved, resolvedInstance)
      : null;
    const currentVisible = currentInstance !== null;
    if (currentVisible) resolvedInstance = currentInstance;
    if (canvasFocused && !currentVisible && state) {
      const cursor = nextKeyboardAtomCursor(
        state.instanceToAtom,
        state.instanceImages,
        selectedAtoms.at(-1) ?? null,
        null,
        0,
        state.baseImages,
      );
      resolved = cursor?.selection ?? null;
      resolvedInstance = cursor?.instance ?? null;
      if (cursor) updateKeyboardFocus(state, cursor.selection, cursor.instance);
    } else if ((!state || !currentVisible) && resolved) {
      resolved = null;
      resolvedInstance = null;
      if (state) updateKeyboardFocus(state, null, null);
    }
    keyboardInstanceRef.current = resolvedInstance;
    if (!sameAtomSelection(resolved, keyboardSelection)) {
      keyboardSelectionRef.current = resolved;
      setKeyboardSelection(resolved);
    }
    selectionPositionsRef.current?.(positions);
  }, [frame, keyboardSelection, presentation, selectedAtoms]);

  const keyboardLabel = keyboardSelection
    ? keyboardAtomLabel(manifest, keyboardSelection)
    : "";
  return <>
    <canvas
      ref={canvasRef}
      className={boxSelection ? "molecule-canvas is-box-selecting" : "molecule-canvas"}
      role="region"
      aria-label="Molecular structure"
      aria-description="Use Up and Down to browse visible atoms. Press Enter to toggle an atom selection. Shift-drag to select a box."
      aria-keyshortcuts="ArrowUp ArrowDown Enter"
      tabIndex={0}
    />
    {boxSelection && (
      <div
        className="selection-marquee"
        data-testid="selection-marquee"
        style={boxSelection}
        aria-hidden="true"
      />
    )}
    <span className="sr-only" aria-live="polite">
      {keyboardLabel ? `${keyboardLabel}. Press Enter to toggle selection.` : ""}
    </span>
  </>;
});

function capturePublicationSnapshot(state: SceneState): PublicationSnapshot {
  const model = state.model;
  const manifest = state.topologyManifest;
  const presentation = state.fitContext?.presentation;
  if (!model || !manifest || !presentation) throw new Error("The molecular scene is not ready to export");
  return {
    model,
    manifest,
    presentation: {
      ...presentation,
      cellOrigin: [...presentation.cellOrigin] as CellOffset,
      mirror: [...presentation.mirror] as [boolean, boolean, boolean],
      images: {
        min: [...presentation.images.min] as CellOffset,
        max: [...presentation.images.max] as CellOffset,
      },
    },
    forces: state.forces?.clone(true) ?? null,
    velocities: state.velocities?.clone(true) ?? null,
    camera: state.camera.clone(),
    target: state.controls.target.clone(),
  };
}

async function exportSceneFigure(
  renderer: THREE.WebGLRenderer,
  snapshot: PublicationSnapshot,
  options: FigureExportOptions,
): Promise<Blob> {
  const gl = renderer.getContext();
  if (gl.isContextLost()) throw new Error("Figure export is unavailable because the WebGL context was lost");
  const [
    { GTAOPass },
    { OutputPass },
    { SSAARenderPass },
    { LineMaterial },
    { LineSegments2 },
    { LineSegmentsGeometry },
  ] = await Promise.all([
    import("three/examples/jsm/postprocessing/GTAOPass.js"),
    import("three/examples/jsm/postprocessing/OutputPass.js"),
    import("three/examples/jsm/postprocessing/SSAARenderPass.js"),
    import("three/examples/jsm/lines/LineMaterial.js"),
    import("three/examples/jsm/lines/LineSegments2.js"),
    import("three/examples/jsm/lines/LineSegmentsGeometry.js"),
  ]);
  const resolved = resolveFigureExportOptions(options, rendererPngLimits(renderer, gl));
  const publication = buildPublicationScene(snapshot, resolved, { LineMaterial, LineSegments2, LineSegmentsGeometry });
  const camera = publicationCamera(
    publication.root,
    snapshot.camera,
    snapshot.target,
    resolved.width,
    resolved.height,
    resolved.projection,
    resolved.fit,
    resolved.padding,
  );
  addPublicationLights(publication.scene, publication.root, camera);

  const supportsHdrTargets = renderer.capabilities.isWebGL2
    ? renderer.extensions.has("EXT_color_buffer_float")
    : renderer.extensions.has("EXT_color_buffer_half_float");
  const hdrType = supportsHdrTargets
    ? THREE.HalfFloatType
    : THREE.UnsignedByteType;
  const beautyTarget = new THREE.WebGLRenderTarget(resolved.width, resolved.height, {
    depthBuffer: true,
    format: THREE.RGBAFormat,
    stencilBuffer: false,
    type: hdrType,
  });
  beautyTarget.texture.name = "Publication beauty";
  const outputTarget = new THREE.WebGLRenderTarget(resolved.width, resolved.height, {
    depthBuffer: false,
    format: THREE.RGBAFormat,
    stencilBuffer: false,
    type: THREE.UnsignedByteType,
  });
  outputTarget.texture.name = "Publication sRGB";

  const pixelsCount = resolved.width * resolved.height;
  const sampleLevel = supportsHdrTargets ? pngExportSampleLevel(pixelsCount) : 0;
  const aoScale = supportsHdrTargets && renderer.capabilities.isWebGL2 && publication.hasAoGeometry
    ? pngExportAoScale(pixelsCount)
    : 0;
  const aoTarget = aoScale > 0
    ? new THREE.WebGLRenderTarget(resolved.width, resolved.height, {
      depthBuffer: false,
      format: THREE.RGBAFormat,
      stencilBuffer: false,
      type: hdrType,
    })
    : null;
  if (aoTarget) aoTarget.texture.name = "Publication ambient occlusion";
  const ssaaPass = sampleLevel > 0
    ? new SSAARenderPass(publication.scene, camera, 0x000000, 0)
    : null;
  if (ssaaPass) {
    ssaaPass.sampleLevel = sampleLevel;
    ssaaPass.unbiased = true;
  }
  const gtaoPass = aoTarget
    ? publicationGtaoPass(GTAOPass, publication.scene, publication.root, camera, resolved, aoScale)
    : null;
  const outputPass = new OutputPass();
  outputPass.renderToScreen = false;
  configurePublicationOutput(outputPass, resolved.background);

  const previousTarget = renderer.getRenderTarget();
  const previousCubeFace = renderer.getActiveCubeFace();
  const previousMipmapLevel = renderer.getActiveMipmapLevel();
  const previousViewport = renderer.getViewport(new THREE.Vector4()).clone();
  const previousScissor = renderer.getScissor(new THREE.Vector4()).clone();
  const previousScissorTest = renderer.getScissorTest();
  const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousClearAlpha = renderer.getClearAlpha();
  const previousXrEnabled = renderer.xr.enabled;
  const previousToneMapping = renderer.toneMapping;
  const previousExposure = renderer.toneMappingExposure;
  const previousOutputColorSpace = renderer.outputColorSpace;
  const previousAutoClear = renderer.autoClear;
  const pixels = new Uint8Array(resolved.width * resolved.height * 4);
  let renderError: unknown = null;

  try {
    drainWebGlErrors(gl);
    renderer.initRenderTarget(beautyTarget);
    renderer.initRenderTarget(outputTarget);
    if (aoTarget) renderer.initRenderTarget(aoTarget);
    renderer.xr.enabled = false;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = publicationPalette.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = true;
    renderer.setScissorTest(false);

    if (ssaaPass) {
      ssaaPass.render(renderer, beautyTarget, beautyTarget, 0, false);
    } else {
      renderer.setRenderTarget(beautyTarget);
      renderer.setViewport(0, 0, resolved.width, resolved.height);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(publication.scene, camera);
    }

    let colorTarget = beautyTarget;
    if (gtaoPass && aoTarget) {
      gtaoPass.render(renderer, aoTarget, beautyTarget, 0, false);
      colorTarget = aoTarget;
    }
    outputPass.render(renderer, outputTarget, colorTarget, 0, false);
    renderer.readRenderTargetPixels(outputTarget, 0, 0, resolved.width, resolved.height, pixels);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(webGlExportError(error, gl));
    if (!hasVisiblePngContent(pixels, resolved.transparent)) {
      throw new Error("the rendered image was blank");
    }
    flipRgbaRowsInPlace(pixels, resolved.width, resolved.height);
    await applyFigureAnnotations(pixels, publication, camera, snapshot, resolved);
  } catch (error) {
    renderError = error;
  } finally {
    renderer.xr.enabled = previousXrEnabled;
    renderer.toneMapping = previousToneMapping;
    renderer.toneMappingExposure = previousExposure;
    renderer.outputColorSpace = previousOutputColorSpace;
    renderer.autoClear = previousAutoClear;
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    ssaaPass?.dispose();
    if (gtaoPass) {
      gtaoPass.gtaoMaterial.dispose();
      gtaoPass.blendMaterial.dispose();
      gtaoPass.dispose();
    }
    outputPass.dispose();
    beautyTarget.dispose();
    aoTarget?.dispose();
    outputTarget.dispose();
    disposePublicationScene(publication);
  }

  if (renderError) {
    const detail = renderError instanceof Error ? renderError.message : "unknown rendering error";
    throw new Error(`Figure export failed: ${detail}`);
  }
  return resolved.format === "tiff"
    ? encodeFigureTiff(pixels, resolved)
    : encodeFigurePng(pixels, resolved);
}

function resolveFigureExportOptions(
  options: FigureExportOptions,
  limits: PngExportLimits,
): ResolvedFigureExportOptions {
  const background = options.background ?? (
    options.transparent
      ? { kind: "transparent" as const }
      : { kind: "solid" as const, color: "#ffffff" }
  );
  if (
    background.kind === "solid"
    && !/^#[0-9a-f]{6}$/i.test(background.color)
  ) {
    throw new Error("Figure background must use #RRGGBB");
  }
  const dpi = options.dpi ?? 300;
  if (!Number.isFinite(dpi) || dpi <= 0 || dpi > 1_000_000) {
    throw new Error("Figure DPI must be between 0 and 1,000,000");
  }
  const base = resolvePngExportOptions({
    ...options,
    transparent: background.kind === "transparent",
  }, limits);
  return {
    ...base,
    format: options.format ?? "png",
    dpi,
    background,
    annotations: options.annotations ?? [],
  };
}

async function applyFigureAnnotations(
  pixels: Uint8Array,
  publication: PublicationScene,
  camera: THREE.Camera,
  snapshot: PublicationSnapshot,
  options: ResolvedFigureExportOptions,
): Promise<void> {
  if (options.annotations.length === 0) return;
  if (typeof document === "undefined") {
    throw new Error("Figure annotations require a browser canvas");
  }
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Figure annotations are unavailable");
  const image = context.createImageData(options.width, options.height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);

  const fontSize = Math.max(
    12,
    Math.min(34, Math.round(Math.min(options.width, options.height) / 70)),
  );
  const margin = Math.max(16, Math.round(fontSize * 1.25));
  context.font = await loadPublicationFont(
    fontSize,
    figureAnnotationFontSample(snapshot, options.annotations),
  );
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const annotation of options.annotations) {
    if (annotation.kind === "atom-label") {
      const position = annotationAtomPosition(snapshot.model, annotation.atom);
      if (!position) {
        throw new Error("A figure atom label is outside the rendered scene");
      }
      const screen = projectFigurePoint(
        position,
        camera,
        options.width,
        options.height,
      );
      if (!screen || screen.depth < -1 || screen.depth > 1) continue;
      const label = annotation.text
        ?? defaultAtomLabel(snapshot.manifest, annotation.atom.atom);
      const offset = annotation.offset ?? [fontSize * 0.72, -fontSize * 0.72];
      drawHaloText(
        context,
        label,
        screen.x + offset[0],
        screen.y + offset[1],
        fontSize,
        "left",
      );
      continue;
    }
    if (annotation.kind === "legend") {
      drawFigureLegend(
        context,
        figureLegendEntries(snapshot, annotation.content),
        annotation.position,
        options.width,
        options.height,
        fontSize,
        margin,
      );
      continue;
    }
    drawFigureScaleBar(
      context,
      publication.root,
      camera,
      annotation.length,
      annotation.unit,
      annotation.position,
      options.width,
      options.height,
      fontSize,
      margin,
    );
  }
  pixels.set(context.getImageData(0, 0, options.width, options.height).data);
}

function figureAnnotationFontSample(
  snapshot: PublicationSnapshot,
  annotations: readonly FigureAnnotation[],
): string {
  const labels = ["PQ", "Å", "nm"];
  for (const annotation of annotations) {
    if (annotation.kind === "atom-label") {
      labels.push(
        annotation.text
        ?? defaultAtomLabel(snapshot.manifest, annotation.atom.atom),
      );
      continue;
    }
    if (annotation.kind === "legend") {
      labels.push(...figureLegendEntries(snapshot, annotation.content).map(({ label }) => label));
      continue;
    }
    labels.push(formatAnnotationNumber(annotation.length));
  }
  return labels.join(" ");
}

function annotationAtomPosition(
  model: PreparedScene,
  selection: AtomSelection,
): THREE.Vector3 | null {
  const point = new THREE.Vector3();
  for (let instance = 0; instance < model.instanceToAtom.length; instance += 1) {
    if (
      selectionMatchesInstance(
        model.instanceToAtom,
        model.instanceImages,
        instance,
        selection,
        model.baseImages,
      )
    ) {
      return setInstancePosition(point, model, instance).clone();
    }
  }
  return null;
}

function projectFigurePoint(
  position: THREE.Vector3,
  camera: THREE.Camera,
  width: number,
  height: number,
): { x: number; y: number; depth: number } | null {
  const projected = position.clone().project(camera);
  if (![projected.x, projected.y, projected.z].every(Number.isFinite)) return null;
  return {
    x: (projected.x + 1) * width * 0.5,
    y: (1 - projected.y) * height * 0.5,
    depth: projected.z,
  };
}

function defaultAtomLabel(manifest: Manifest, atom: number): string {
  const symbol = manifest.topology.symbols?.[atom]
    ?? manifest.topology.atom_names?.[atom]
    ?? "Atom";
  return `${symbol}${atom + 1}`;
}

interface FigureLegendEntry {
  color: string;
  label: string;
}

function figureLegendEntries(
  snapshot: PublicationSnapshot,
  content: Extract<FigureAnnotation, { kind: "legend" }>["content"],
): FigureLegendEntry[] {
  if (content === "forces") {
    return [{ color: publicationPalette.force, label: "Forces" }];
  }
  if (content === "velocities") {
    return [{ color: publicationPalette.velocity, label: "Velocities" }];
  }
  const { manifest, model, presentation } = snapshot;
  const atoms = [...new Set(model.instanceToAtom)];
  if (content === "residues") {
    const residueIndices = manifest.topology.atom_residue_index;
    const residues = manifest.topology.residues;
    if (!residueIndices || !residues) return [];
    const firstAtoms = new Map<number, number>();
    for (const atom of atoms) {
      const residue = residueIndices[atom];
      if (Number.isInteger(residue) && !firstAtoms.has(residue)) {
        firstAtoms.set(residue, atom);
      }
    }
    return [...firstAtoms.entries()].slice(0, 12).map(([residue, atom]) => ({
      color: `#${atomColor(manifest, atom, model.atomicNumbers[atom], "residue", "light")
        .getHexString(THREE.SRGBColorSpace)}`,
      label: residues[residue]?.name?.trim() || `Residue ${residue + 1}`,
    }));
  }
  const firstAtoms = new Map<number, number>();
  for (const atom of atoms) {
    const atomicNumber = model.atomicNumbers[atom];
    if (!firstAtoms.has(atomicNumber)) firstAtoms.set(atomicNumber, atom);
  }
  return [...firstAtoms.entries()]
    .sort(([left], [right]) => left - right)
    .slice(0, 16)
    .map(([atomicNumber, atom]) => ({
      color: `#${atomColor(manifest, atom, atomicNumber, presentation.color, "light")
        .getHexString(THREE.SRGBColorSpace)}`,
      label: manifest.topology.symbols?.[atom] ?? `Z ${atomicNumber}`,
    }));
}

function drawFigureLegend(
  context: CanvasRenderingContext2D,
  entries: readonly FigureLegendEntry[],
  position: Extract<FigureAnnotation, { kind: "legend" }>["position"],
  width: number,
  height: number,
  fontSize: number,
  margin: number,
): void {
  if (entries.length === 0) return;
  const gap = Math.max(6, Math.round(fontSize * 0.45));
  const dot = Math.max(8, Math.round(fontSize * 0.72));
  const rowHeight = Math.round(fontSize * 1.4);
  const boxWidth = Math.max(...entries.map(({ label }) => context.measureText(label).width))
    + dot + gap + fontSize;
  const boxHeight = entries.length * rowHeight + fontSize;
  const { x, y } = figureCornerBox(position, width, height, boxWidth, boxHeight, margin);
  context.save();
  context.fillStyle = "rgba(255, 255, 255, 0.88)";
  context.fillRect(x, y, boxWidth, boxHeight);
  entries.forEach((entry, index) => {
    const centerY = y + fontSize * 0.5 + rowHeight * (index + 0.5);
    context.fillStyle = entry.color;
    context.beginPath();
    context.arc(x + fontSize, centerY, dot * 0.5, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#17302e";
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(entry.label, x + fontSize + dot * 0.5 + gap, centerY);
  });
  context.restore();
}

function drawFigureScaleBar(
  context: CanvasRenderingContext2D,
  root: THREE.Object3D,
  camera: THREE.Camera,
  length: number,
  unit: "angstrom" | "nanometer",
  position: FigureCorner,
  width: number,
  height: number,
  fontSize: number,
  margin: number,
): void {
  if (!(camera instanceof THREE.OrthographicCamera)) {
    throw new Error("Scale bars require orthographic projection");
  }
  const angstrom = unit === "nanometer" ? length * 10 : length;
  const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const start = projectFigurePoint(center, camera, width, height);
  const end = projectFigurePoint(
    center.clone().addScaledVector(right, angstrom),
    camera,
    width,
    height,
  );
  if (!start || !end) throw new Error("Scale bar could not be projected");
  const pixelLength = Math.hypot(end.x - start.x, end.y - start.y);
  if (!Number.isFinite(pixelLength) || pixelLength < 8 || pixelLength > width * 0.7) {
    throw new Error("Scale bar length does not fit the figure");
  }
  const boxWidth = pixelLength + fontSize * 1.5;
  const boxHeight = fontSize * 2.6;
  const corner = figureCornerBox(position, width, height, boxWidth, boxHeight, margin);
  const lineY = corner.y + fontSize * 0.78;
  const lineX = corner.x + fontSize * 0.75;
  context.save();
  context.strokeStyle = "#17302e";
  context.fillStyle = "#17302e";
  context.lineWidth = Math.max(2, Math.round(fontSize * 0.12));
  context.beginPath();
  context.moveTo(lineX, lineY);
  context.lineTo(lineX + pixelLength, lineY);
  context.moveTo(lineX, lineY - fontSize * 0.22);
  context.lineTo(lineX, lineY + fontSize * 0.22);
  context.moveTo(lineX + pixelLength, lineY - fontSize * 0.22);
  context.lineTo(lineX + pixelLength, lineY + fontSize * 0.22);
  context.stroke();
  context.textAlign = "center";
  context.textBaseline = "top";
  context.fillText(
    `${formatAnnotationNumber(length)} ${unit === "nanometer" ? "nm" : "Å"}`,
    lineX + pixelLength * 0.5,
    lineY + fontSize * 0.45,
  );
  context.restore();
}

function figureCornerBox(
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right",
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
  margin: number,
): { x: number; y: number } {
  return {
    x: position.endsWith("right") ? width - margin - boxWidth : margin,
    y: position.startsWith("bottom") ? height - margin - boxHeight : margin,
  };
}

function drawHaloText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  align: CanvasTextAlign,
): void {
  context.save();
  context.textAlign = align;
  context.textBaseline = "middle";
  context.strokeStyle = "rgba(255, 255, 255, 0.94)";
  context.lineWidth = Math.max(3, fontSize * 0.28);
  context.strokeText(text, x, y);
  context.fillStyle = "#17302e";
  context.fillText(text, x, y);
  context.restore();
}

function formatAnnotationNumber(value: number): string {
  return Number(value.toPrecision(5)).toString();
}

function rendererPngLimits(
  renderer: THREE.WebGLRenderer,
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): PngExportLimits {
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[];
  const texture = renderer.capabilities.maxTextureSize;
  const renderbuffer = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  return {
    maxWidth: Math.max(1, Math.floor(Math.min(texture, renderbuffer, Number(viewport[0])))),
    maxHeight: Math.max(1, Math.floor(Math.min(texture, renderbuffer, Number(viewport[1])))),
    maxPixels: MAX_PNG_EXPORT_PIXELS,
  };
}

interface PublicationResources {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
}

interface PublicationScene {
  scene: THREE.Scene;
  root: THREE.Group;
  resources: PublicationResources;
  hasAoGeometry: boolean;
}

interface PublicationLineConstructors {
  LineMaterial: LineMaterialConstructor;
  LineSegments2: LineSegments2Constructor;
  LineSegmentsGeometry: LineSegmentsGeometryConstructor;
}

const publicationPalette: ScenePalette = {
  background: "#ffffff",
  bond: "#48575a",
  bondOpacity: 1,
  cell: "#4f7882",
  cellOpacity: 0.46,
  selection: "#3DACCB",
  selectionOpacity: 0,
  force: "#b34c2b",
  velocity: "#625c9f",
  displacement: "#087F8C",
  ribbon: "#347f96",
  hemisphereSky: "#ffffff",
  hemisphereGround: "#d8e0df",
  hemisphereIntensity: 1.18,
  key: "#ffffff",
  keyIntensity: 2.1,
  rim: "#c9e0e4",
  rimIntensity: 0.2,
  exposure: 0.98,
};

const publicationContextPalette: ScenePalette = {
  ...publicationPalette,
  bond: "#9aa7a9",
  cellOpacity: 0.45,
};

function buildPublicationScene(
  snapshot: PublicationSnapshot,
  options: ResolvedPngExportOptions,
  lineConstructors: PublicationLineConstructors,
): PublicationScene {
  const { model, manifest, presentation } = snapshot;
  const scene = new THREE.Scene();
  scene.background = null;
  const root = new THREE.Group();
  scene.add(root);
  const resources: PublicationResources = {
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
  };
  const publicationPresentation: ScenePresentation = model.instanceToAtom.length <= 12_000
    ? { ...presentation, quality: "high" }
    : presentation;

  if (presentation.mode === "ribbon") {
    const ribbon = buildRibbon(model, manifest, publicationPresentation, "light", publicationPalette);
    if (ribbon) {
      stylePublicationMaterials(ribbon, resources);
      ownPublicationObject(ribbon, resources);
      root.add(ribbon);
    }
  } else {
    const atoms = buildAtoms(model, manifest, publicationPresentation, "light", true);
    if (atoms) {
      stylePublicationMaterials(atoms, resources);
      ownPublicationObject(atoms, resources);
      root.add(atoms);
    }

    const geometry = publicationBondGeometry(model, presentation, options.periodicContext);
    const primarySegments = geometry.segments.filter((segment) => !segment.context);
    const contextSegments = geometry.segments.filter((segment) => segment.context);
    const pointAtoms = atoms instanceof THREE.Points;
    const bondKind = presentation.mode === "lines" || pointAtoms || geometry.segments.length > MAX_BOND_INSTANCES
      ? "lines"
      : "instances";
    const primaryBonds = buildBonds(publicationPresentation, publicationPalette, bondKind, primarySegments, true);
    if (primaryBonds) {
      stylePublicationMaterials(primaryBonds, resources);
      ownPublicationObject(primaryBonds, resources);
      root.add(primaryBonds);
    }
    const contextBonds = buildBonds(publicationPresentation, publicationContextPalette, bondKind, contextSegments, true);
    if (contextBonds) {
      stylePublicationMaterials(contextBonds, resources);
      ownPublicationObject(contextBonds, resources);
      root.add(contextBonds);
    }
    const contextAtoms = buildPublicationContextAtoms(
      model,
      manifest,
      presentation,
      geometry.contextAtoms,
      publicationContextUsesPoints(
        pointAtoms,
        model.instanceToAtom.length + geometry.contextAtoms.length,
        MAX_SPHERE_INSTANCES,
      ),
    );
    if (contextAtoms) {
      stylePublicationMaterials(contextAtoms, resources);
      ownPublicationObject(contextAtoms, resources);
      root.add(contextAtoms);
    }
  }

  if (presentation.cell) {
    const cell = buildPublicationCells(model, options.width, options.height, lineConstructors);
    if (cell) {
      ownPublicationObject(cell, resources);
      root.add(cell);
    }
  }
  if (snapshot.forces) root.add(clonePublicationVectors(snapshot.forces, publicationPalette.force, resources));
  if (snapshot.velocities) root.add(clonePublicationVectors(snapshot.velocities, publicationPalette.velocity, resources));

  let hasAoGeometry = false;
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && object.userData.publicationExcludeFromAo !== true) hasAoGeometry = true;
  });
  return { scene, root, resources, hasAoGeometry };
}

function buildPublicationContextAtoms(
  model: PreparedScene,
  manifest: Manifest,
  presentation: ScenePresentation,
  atoms: Array<{ atomIndex: number; position: THREE.Vector3 }>,
  usePoints: boolean,
): THREE.Object3D | null {
  if (atoms.length === 0) return null;
  if (usePoints) {
    const positions = new Float32Array(atoms.length * 3);
    const colors = new Float32Array(atoms.length * 3);
    atoms.forEach(({ atomIndex, position }, instance) => {
      position.toArray(positions, instance * 3);
      atomColor(manifest, atomIndex, model.atomicNumbers[atomIndex], presentation.color, "light")
        .toArray(colors, instance * 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    return new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        vertexColors: true,
        size: presentation.mode === "lines" ? 0.14 : 0.22,
        sizeAttenuation: true,
      }),
    );
  }

  const contextCount = model.instanceToAtom.length + atoms.length;
  const sphereSegments = contextCount <= 5_000 ? [40, 28] : [24, 16];
  const geometry = new THREE.SphereGeometry(1, sphereSegments[0], sphereSegments[1]);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geometry, material, atoms.length);
  const dummy = new THREE.Object3D();
  atoms.forEach(({ atomIndex, position }, instance) => {
    dummy.position.copy(position);
    dummy.scale.setScalar((model.radii[atomIndex] ?? 0.25) * 0.9);
    dummy.updateMatrix();
    mesh.setMatrixAt(instance, dummy.matrix);
    mesh.setColorAt(
      instance,
      atomColor(manifest, atomIndex, model.atomicNumbers[atomIndex], presentation.color, "light"),
    );
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

function buildPublicationCells(
  model: PreparedScene,
  width: number,
  height: number,
  { LineMaterial, LineSegments2, LineSegmentsGeometry }: PublicationLineConstructors,
): THREE.Object3D | null {
  if (!model.basis || model.images.length === 0) return null;
  const positions: number[] = [];
  const seen = new Set<string>();
  for (const image of model.images) {
    const values: number[] = [];
    appendCellLines(values, model.basis, image, model.cellCenter);
    for (let offset = 0; offset < values.length; offset += 6) {
      const from = values.slice(offset, offset + 3);
      const to = values.slice(offset + 3, offset + 6);
      const fromKey = from.map(coordinateKey).join(",");
      const toKey = to.map(coordinateKey).join(",");
      const key = fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      positions.push(...from, ...to);
    }
  }
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  const material = new LineMaterial({
    color: publicationPalette.cell,
    linewidth: THREE.MathUtils.clamp(1.4 * Math.min(width / 2400, height / 1800), 1.1, 3.2),
    transparent: true,
    opacity: publicationPalette.cellOpacity,
    depthWrite: false,
    alphaToCoverage: true,
  });
  const lines = new LineSegments2(geometry, material);
  (lines as unknown as { isLine2: boolean }).isLine2 = true;
  lines.userData.publicationExcludeFromAo = true;
  lines.userData.publicationFitPositions = positions;
  lines.frustumCulled = false;
  return lines;
}

function coordinateKey(value: number): string {
  return Math.abs(value) < 5e-7 ? "0" : value.toFixed(6);
}

function clonePublicationVectors(
  source: THREE.Group,
  color: string,
  resources: PublicationResources,
): THREE.Group {
  const clone = source.clone(true);
  clone.traverse((object) => {
    const renderable = object as THREE.Object3D & { material?: THREE.Material | THREE.Material[] };
    if (!renderable.material) return;
    const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
    const copies = materials.map((material) => {
      const copy = material.clone();
      if ("color" in copy && copy.color instanceof THREE.Color) copy.color.set(color);
      resources.materials.add(copy);
      return copy;
    });
    renderable.material = Array.isArray(renderable.material) ? copies : copies[0];
  });
  return clone;
}

function stylePublicationMaterials(object: THREE.Object3D, resources: PublicationResources): void {
  object.traverse((child) => {
    const renderable = child as THREE.Object3D & { material?: THREE.Material | THREE.Material[] };
    const materials = Array.isArray(renderable.material)
      ? renderable.material
      : renderable.material ? [renderable.material] : [];
    for (const material of materials) {
      material.opacity = 1;
      material.transparent = false;
      if (material instanceof THREE.MeshStandardMaterial) {
        material.roughness = 0.64;
        material.metalness = 0;
      }
      if (material instanceof THREE.PointsMaterial) {
        const texture = publicationPointTexture();
        material.map = texture;
        material.alphaTest = 0.04;
        material.transparent = true;
        material.depthWrite = true;
        material.size *= 1.08;
        resources.textures.add(texture);
      }
      material.needsUpdate = true;
    }
  });
}

function publicationPointTexture(): THREE.DataTexture {
  const size = 48;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = (y + 0.5) / size * 2 - 1;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const alpha = THREE.MathUtils.clamp((1 - radius) * 12, 0, 1);
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

function ownPublicationObject(object: THREE.Object3D, resources: PublicationResources): void {
  object.traverse((child) => {
    const renderable = child as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (renderable.geometry) resources.geometries.add(renderable.geometry);
    const materials = Array.isArray(renderable.material)
      ? renderable.material
      : renderable.material ? [renderable.material] : [];
    materials.forEach((material) => resources.materials.add(material));
  });
}

function addPublicationLights(
  scene: THREE.Scene,
  root: THREE.Object3D,
  camera: THREE.Camera,
): void {
  const bounds = new THREE.Box3().setFromObject(root);
  const center = bounds.getCenter(new THREE.Vector3());
  const span = Math.max(bounds.getSize(new THREE.Vector3()).length(), 1);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  scene.add(new THREE.HemisphereLight(
    publicationPalette.hemisphereSky,
    publicationPalette.hemisphereGround,
    publicationPalette.hemisphereIntensity,
  ));
  const key = new THREE.DirectionalLight(publicationPalette.key, publicationPalette.keyIntensity);
  key.position.copy(center)
    .addScaledVector(right, -span * 0.75)
    .addScaledVector(up, span)
    .addScaledVector(back, span * 1.1);
  key.target.position.copy(center);
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight("#dce9eb", 0.48);
  fill.position.copy(center)
    .addScaledVector(right, span)
    .addScaledVector(up, span * 0.2)
    .addScaledVector(back, span * 0.45);
  fill.target.position.copy(center);
  scene.add(fill, fill.target);
  const rim = new THREE.DirectionalLight(publicationPalette.rim, publicationPalette.rimIntensity);
  rim.position.copy(center)
    .addScaledVector(right, -span * 0.4)
    .addScaledVector(up, -span * 0.3)
    .addScaledVector(back, -span);
  rim.target.position.copy(center);
  scene.add(rim, rim.target);
}

function publicationGtaoPass(
  GtaoPass: GtaoPassConstructor,
  scene: THREE.Scene,
  root: THREE.Object3D,
  camera: THREE.Camera,
  options: ResolvedPngExportOptions,
  scale: number,
): InstanceType<GtaoPassConstructor> {
  const width = Math.max(1, Math.round(options.width * scale));
  const height = Math.max(1, Math.round(options.height * scale));
  const bounds = new THREE.Box3().setFromObject(root);
  const radius = THREE.MathUtils.clamp(bounds.getSize(new THREE.Vector3()).length() * 0.018, 0.18, 0.55);
  const pass = new GtaoPass(scene, camera, width, height);
  pass.pdNoiseTexture.dispose();
  pass.pdNoiseTexture = publicationNoiseTexture();
  pass.pdMaterial.uniforms.tNoise.value = pass.pdNoiseTexture;
  pass.renderToScreen = false;
  pass.blendIntensity = 0.38;
  pass.setSceneClipBox(bounds);
  pass.updateGtaoMaterial({
    radius,
    thickness: radius * 2.5,
    distanceExponent: 1,
    distanceFallOff: 1,
    scale: 1,
    samples: 16,
    screenSpaceRadius: false,
  });
  pass.updatePdMaterial({ samples: 8, rings: 2, radius: 4, radiusExponent: 2 });
  return pass;
}

function publicationNoiseTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  let state = 0x6d2b79f5;
  for (let index = 0; index < data.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[index] = state >>> 24;
  }
  const texture = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function configurePublicationOutput(
  pass: InstanceType<typeof import("three/examples/jsm/postprocessing/OutputPass.js").OutputPass>,
  background: FigureBackground,
): void {
  const sample = "gl_FragColor = texture2D( tDiffuse, vUv );";
  const source = pass.material.fragmentShader;
  const fragmentShader = source
    .replace(
      "uniform sampler2D tDiffuse;",
      "uniform sampler2D tDiffuse;\nuniform float publicationTransparent;\nuniform vec3 publicationBackground;",
    )
    .replace(sample, `${sample}
      float publicationCoverage = gl_FragColor.a;
      gl_FragColor.rgb = publicationCoverage > 0.000001
        ? gl_FragColor.rgb / publicationCoverage
        : vec3( 0.0 );`)
    .replace("// color space", `if ( publicationTransparent < 0.5 ) {
        gl_FragColor.rgb = gl_FragColor.rgb * publicationCoverage + publicationBackground * ( 1.0 - publicationCoverage );
        gl_FragColor.a = 1.0;
      }

      // color space`);
  if (fragmentShader === source || !fragmentShader.includes("publicationCoverage")) {
    throw new Error("Publication output shader is incompatible");
  }
  pass.material.fragmentShader = fragmentShader;
  pass.material.uniforms.publicationTransparent = {
    value: background.kind === "transparent" ? 1 : 0,
  };
  pass.material.uniforms.publicationBackground = {
    value: new THREE.Color(
      background.kind === "solid" ? background.color : "#000000",
    ),
  };
  pass.material.needsUpdate = true;
}

function disposePublicationScene(publication: PublicationScene): void {
  publication.root.traverse((object) => {
    if (object instanceof THREE.InstancedMesh) object.dispose();
  });
  publication.resources.geometries.forEach((geometry) => geometry.dispose());
  publication.resources.materials.forEach((material) => material.dispose());
  publication.resources.textures.forEach((texture) => texture.dispose());
}

function drainWebGlErrors(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  for (let index = 0; index < 16 && gl.getError() !== gl.NO_ERROR; index += 1) {
    // Clear stale errors so export failures can be attributed accurately.
  }
}

function webGlExportError(error: number, gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  if (error === gl.OUT_OF_MEMORY) return "the GPU could not allocate the requested image";
  if (error === gl.INVALID_VALUE) return "the requested image dimensions are unsupported";
  if (error === gl.INVALID_FRAMEBUFFER_OPERATION) return "the export framebuffer is incomplete";
  return `WebGL error 0x${error.toString(16)}`;
}

function applyScenePalette(state: SceneState, palette: ScenePalette): void {
  if (state.scene.background instanceof THREE.Color) state.scene.background.set(palette.background);
  state.renderer.toneMappingExposure = palette.exposure;
  state.hemisphere.color.set(palette.hemisphereSky);
  state.hemisphere.groundColor.set(palette.hemisphereGround);
  state.hemisphere.intensity = palette.hemisphereIntensity;
  state.key.color.set(palette.key);
  state.key.intensity = palette.keyIntensity;
  state.rim.color.set(palette.rim);
  state.rim.intensity = palette.rimIntensity;
  state.selectionMaterial.color.set(palette.selection);
  state.selectionMaterial.opacity = palette.selectionOpacity;
  state.selectionPointsMaterial.color.set(palette.selection);
  state.keyboardFocusMaterial.color.set(palette.selection);
}

function applyRenderablePalette(
  state: SceneState,
  manifest: Manifest,
  model: PreparedScene,
  presentation: ScenePresentation,
  appearance: Appearance,
  palette: ScenePalette,
): void {
  if (state.atomObject instanceof THREE.Points) {
    const colors = state.atomObject.geometry.getAttribute("color") as THREE.BufferAttribute;
    for (let instance = 0; instance < model.instanceToAtom.length; instance += 1) {
      const atom = model.instanceToAtom[instance];
      const color = atomColor(manifest, atom, model.atomicNumbers[atom], presentation.color, appearance);
      colors.setXYZ(instance, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
  } else if (state.atomObject instanceof THREE.InstancedMesh) {
    for (let instance = 0; instance < model.instanceToAtom.length; instance += 1) {
      const atom = model.instanceToAtom[instance];
      state.atomObject.setColorAt(
        instance,
        atomColor(manifest, atom, model.atomicNumbers[atom], presentation.color, appearance),
      );
    }
    if (state.atomObject.instanceColor) state.atomObject.instanceColor.needsUpdate = true;
  }

  setMaterialPalette(state.bonds, palette.bond, palette.bondOpacity);
  setMaterialPalette(state.cell, palette.cell, palette.cellOpacity);
  state.forces?.children.forEach((object) => setMaterialPalette(object, palette.force));
  state.velocities?.children.forEach((object) => setMaterialPalette(object, palette.velocity));
  if (state.ribbon) {
    const colors = state.ribbon.geometry.getAttribute("color") as THREE.BufferAttribute;
    const atoms = state.ribbon.geometry.getAttribute("atomIndex") as THREE.BufferAttribute;
    for (let vertex = 0; vertex < atoms.count; vertex += 1) {
      const atom = Math.round(atoms.getX(vertex));
      const color = presentation.color === "element"
        ? atomColor(manifest, atom, model.atomicNumbers[atom], presentation.color, appearance)
        : new THREE.Color(palette.ribbon);
      colors.setXYZ(vertex, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
  }
}

function setMaterialPalette(object: THREE.Object3D | null, color: string, opacity?: number): void {
  if (!object) return;
  object.traverse((child) => {
    const material = (child as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material;
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    materials.forEach((entry) => {
      if ("color" in entry && entry.color instanceof THREE.Color) entry.color.set(color);
      if (opacity !== undefined && "opacity" in entry) entry.opacity = opacity;
    });
  });
}

function clearRenderables(state: SceneState): void {
  for (const object of [state.atomObject, state.bonds, state.cell, state.forces, state.velocities, state.ribbon]) {
    if (!object) continue;
    state.root.remove(object);
    disposeObject(object);
  }
  state.atomObject = null;
  state.bonds = null;
  state.cell = null;
  state.forces = null;
  state.velocities = null;
  state.ribbon = null;
  state.pickables = [];
}

function updateTrajectoryOverlayGroup(
  group: THREE.Group,
  model: PreparedScene | null,
  overlays: TrajectoryOverlays,
  appearance: Appearance,
): void {
  while (group.children.length > 0) {
    const child = group.children[group.children.length - 1];
    group.remove(child);
    disposeObject(child);
  }
  if (!model) return;

  const palette = scenePalettes[appearance];
  const fade = new THREE.Color(palette.background);
  const trailColor = new THREE.Color(palette.selection);
  for (const overlay of overlays.trails.slice(0, MAX_TRAIL_ATOMS)) {
    const positions = alignedTrailSegments(model, overlay);
    if (positions.length === 0) continue;
    const segmentCount = positions.length / 6;
    const colors = new Float32Array(segmentCount * 6);
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const from = segmentCount === 1 ? 0.35 : segment / segmentCount;
      const to = (segment + 1) / segmentCount;
      fade.clone().lerp(trailColor, 0.16 + from * 0.84).toArray(colors, segment * 6);
      fade.clone().lerp(trailColor, 0.16 + to * 0.84).toArray(colors, segment * 6 + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const line = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      }),
    );
    line.name = `trail:${overlay.id}`;
    line.renderOrder = 7;
    group.add(line);
  }

  const arrows = overlays.displacements
    .slice(0, MAX_DISPLACEMENT_ATOMS)
    .map((overlay) => alignedDisplacementArrow(model, overlay))
    .filter((arrow): arrow is VectorArrow => arrow !== null);
  const displacement = buildExplicitVectors(arrows, palette.displacement);
  if (displacement) {
    displacement.name = "reference-displacements";
    group.add(displacement);
  }
}

export function alignedTrailSegments(
  model: Pick<
    PreparedScene,
    "count" | "positions" | "baseImages" | "basis" | "displayTransform"
  >,
  overlay: AtomTrailOverlay,
): Float32Array {
  if (
    !Number.isSafeInteger(overlay.atom)
    || overlay.atom < 0
    || overlay.atom >= model.count
    || overlay.image.length !== 3
    || !overlay.image.every(Number.isInteger)
    || overlay.points.length < 6
    || overlay.points.length % 3 !== 0
  ) {
    return new Float32Array();
  }
  const pointCount = Math.min(
    MAX_TRAIL_POINTS,
    Math.floor(overlay.points.length / 3),
  );
  const firstPoint = Math.floor(overlay.points.length / 3) - pointCount;
  const lastOffset = overlay.points.length - 3;
  const last = new THREE.Vector3().fromArray(overlay.points, lastOffset);
  if (![last.x, last.y, last.z].every(Number.isFinite)) return new Float32Array();
  const anchor = selectedDisplayedPosition(model, overlay.atom, overlay.image);
  if (!anchor) return new Float32Array();
  const aligned: THREE.Vector3[] = [];
  const point = new THREE.Vector3();
  for (let index = firstPoint; index < firstPoint + pointCount; index += 1) {
    point.fromArray(overlay.points, index * 3);
    if (![point.x, point.y, point.z].every(Number.isFinite)) {
      aligned.push(new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN));
      continue;
    }
    aligned.push(
      point.clone()
        .sub(last)
        .applyMatrix3(model.displayTransform)
        .add(anchor),
    );
  }
  const segments: number[] = [];
  for (let index = 1; index < aligned.length; index += 1) {
    const from = aligned[index - 1];
    const to = aligned[index];
    if (
      ![from.x, from.y, from.z, to.x, to.y, to.z].every(Number.isFinite)
    ) continue;
    segments.push(...from.toArray(), ...to.toArray());
  }
  return new Float32Array(segments);
}

export function selectedDisplayedPosition(
  model: Pick<
    PreparedScene,
    "count" | "positions" | "baseImages" | "basis"
  >,
  atom: number,
  image: CellOffset,
): THREE.Vector3 | null {
  if (
    !Number.isSafeInteger(atom)
    || atom < 0
    || atom >= model.count
    || image.length !== 3
    || !image.every(Number.isInteger)
  ) return null;
  const point = new THREE.Vector3().fromArray(model.positions, atom * 3);
  if (!model.basis) return point;
  const offset = atom * 3;
  const relative: CellOffset = [
    image[0] - (model.baseImages[offset] ?? 0),
    image[1] - (model.baseImages[offset + 1] ?? 0),
    image[2] - (model.baseImages[offset + 2] ?? 0),
  ];
  return point.add(imageTranslation(relative, model.basis));
}

function alignedDisplacementArrow(
  model: Pick<
    PreparedScene,
    "count" | "positions" | "baseImages" | "basis" | "displayTransform" | "radii"
  >,
  overlay: AtomDisplacementOverlay,
): VectorArrow | null {
  const tip = selectedDisplayedPosition(model, overlay.atom, overlay.image);
  if (!tip || ![...overlay.from, ...overlay.to].every(Number.isFinite)) return null;
  const displacement = new THREE.Vector3(
    overlay.to[0] - overlay.from[0],
    overlay.to[1] - overlay.from[1],
    overlay.to[2] - overlay.from[2],
  ).applyMatrix3(model.displayTransform);
  const length = displacement.length();
  if (!Number.isFinite(length) || length <= 1e-10) return null;
  const direction = displacement.clone().multiplyScalar(1 / length);
  const head = Math.min(0.22, Math.max(0.07, length * 0.18), length * 0.45);
  return {
    tail: tip.clone().sub(displacement),
    tip,
    direction,
    head,
  };
}

function buildExplicitVectors(
  arrows: readonly VectorArrow[],
  color: string,
): THREE.Group | null {
  if (arrows.length === 0) return null;
  const group = new THREE.Group();
  const shafts = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.014, 0.014, 1, 8, 1, false),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    }),
    arrows.length,
  );
  shafts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(shafts);
  const heads = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1, 1, 9),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    }),
    arrows.length,
  );
  heads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(heads);
  updateVectors(group, [...arrows]);
  return group;
}

function buildFrameRenderables(
  state: SceneState,
  model: PreparedScene,
  manifest: Manifest,
  presentation: ScenePresentation,
  appearance: Appearance,
  forces: Float32Array | null,
  velocities: Float32Array | null,
  forceScale: number,
  velocityScale: number,
  frameGeometry: FrameGeometryPlan,
): void {
  const palette = scenePalettes[appearance];
  if (presentation.mode === "ribbon") {
    state.ribbon = buildRibbon(model, manifest, presentation, appearance, palette);
    if (state.ribbon) {
      state.root.add(state.ribbon);
      state.pickables.push(state.ribbon);
    }
  } else {
    state.atomObject = buildAtoms(model, manifest, presentation, appearance);
    if (state.atomObject) {
      state.root.add(state.atomObject);
      state.pickables.push(state.atomObject);
    }
    state.bonds = buildBonds(presentation, palette, frameGeometry.bondKind, frameGeometry.bondSegments);
    if (state.bonds) state.root.add(state.bonds);
  }
  state.cell = presentation.cell ? buildCells(model, palette) : null;
  if (state.cell) state.root.add(state.cell);
  state.forces = presentation.forces
    ? buildVectors(model, forces, forceScale, palette.force, frameGeometry.forceInstances)
    : null;
  if (state.forces) state.root.add(state.forces);
  state.velocities = presentation.velocities
    ? buildVectors(model, velocities, velocityScale, palette.velocity, frameGeometry.velocityInstances)
    : null;
  if (state.velocities) state.root.add(state.velocities);
}

function updateFrameRenderables(
  state: SceneState,
  model: PreparedScene,
  presentation: ScenePresentation,
  forces: Float32Array | null,
  velocities: Float32Array | null,
  forceScale: number,
  velocityScale: number,
  frameGeometry: FrameGeometryPlan,
): boolean {
  if (!renderablesMatchFrameGeometry(state, frameGeometry)) return false;
  const forceArrows = frameGeometry.forceInstances.length > 0
    ? vectorArrows(model, forces, forceScale, frameGeometry.forceInstances)
    : [];
  const velocityArrows = frameGeometry.velocityInstances.length > 0
    ? vectorArrows(model, velocities, velocityScale, frameGeometry.velocityInstances)
    : [];
  if (forceArrows.length !== frameGeometry.forceInstances.length) return false;
  if (velocityArrows.length !== frameGeometry.velocityInstances.length) return false;

  if (state.atomObject) updateAtoms(state.atomObject, model);
  if (state.bonds) updateBonds(state.bonds, frameGeometry.bondSegments);
  if (state.cell) updateCells(state.cell, model);
  if (state.forces) updateVectors(state.forces, forceArrows);
  if (state.velocities) updateVectors(state.velocities, velocityArrows);
  return presentation.mode !== "ribbon";
}

function renderablesMatchFrameGeometry(state: SceneState, frameGeometry: FrameGeometryPlan): boolean {
  if (state.ribbon) return false;
  if (frameGeometry.atomKind === "none") {
    if (state.atomObject) return false;
  } else if (frameGeometry.atomKind === "points") {
    if (!(state.atomObject instanceof THREE.Points)
      || state.atomObject.geometry.getAttribute("position").count !== frameGeometry.atomCount) return false;
  } else if (!(state.atomObject instanceof THREE.InstancedMesh)
    || state.atomObject.instanceMatrix.count !== frameGeometry.atomCount) return false;

  if (frameGeometry.bondKind === "none") {
    if (state.bonds) return false;
  } else if (frameGeometry.bondKind === "lines") {
    if (!(state.bonds instanceof THREE.LineSegments)
      || state.bonds.geometry.getAttribute("position").count !== frameGeometry.bondSegments.length * 2) return false;
  } else if (!(state.bonds instanceof THREE.InstancedMesh)
    || state.bonds.instanceMatrix.count !== frameGeometry.bondSegments.length) return false;

  if (frameGeometry.cellLineCount === 0) {
    if (state.cell) return false;
  } else if (!state.cell
    || state.cell.geometry.getAttribute("position").count !== frameGeometry.cellLineCount * 2) return false;

  return vectorLayoutMatches(state.forces, frameGeometry.forceInstances.length)
    && vectorLayoutMatches(state.velocities, frameGeometry.velocityInstances.length);
}

function vectorLayoutMatches(group: THREE.Group | null, count: number): boolean {
  if (count === 0) return group === null;
  const [shafts, heads] = group?.children ?? [];
  return shafts instanceof THREE.InstancedMesh
    && heads instanceof THREE.InstancedMesh
    && shafts.instanceMatrix.count === count
    && heads.instanceMatrix.count === count;
}

function updateAtoms(object: THREE.InstancedMesh | THREE.Points, model: PreparedScene): void {
  const point = new THREE.Vector3();
  if (object instanceof THREE.Points) {
    const positions = object.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let instance = 0; instance < model.instanceToAtom.length; instance += 1) {
      setInstancePosition(point, model, instance);
      positions.setXYZ(instance, point.x, point.y, point.z);
    }
    positions.needsUpdate = true;
    object.geometry.computeBoundingSphere();
    return;
  }

  const dummy = new THREE.Object3D();
  for (let instance = 0; instance < model.instanceToAtom.length; instance += 1) {
    const atom = model.instanceToAtom[instance];
    setInstancePosition(dummy.position, model, instance);
    dummy.scale.setScalar(model.radii[atom]);
    dummy.updateMatrix();
    object.setMatrixAt(instance, dummy.matrix);
  }
  object.instanceMatrix.needsUpdate = true;
  object.computeBoundingSphere();
}

function updateBonds(object: THREE.Object3D, segments: Segment[]): void {
  if (object instanceof THREE.LineSegments) {
    const positions = object.geometry.getAttribute("position") as THREE.BufferAttribute;
    segments.forEach(({ from, to }, index) => {
      positions.setXYZ(index * 2, from.x, from.y, from.z);
      positions.setXYZ(index * 2 + 1, to.x, to.y, to.z);
    });
    positions.needsUpdate = true;
    object.geometry.computeBoundingSphere();
    return;
  }
  if (!(object instanceof THREE.InstancedMesh)) return;
  updateBondMatrices(object, segments);
}

function updateCells(cell: THREE.LineSegments, model: PreparedScene): void {
  if (!model.basis) return;
  const values: number[] = [];
  model.images.forEach((image) => appendCellLines(values, model.basis!, image, model.cellCenter));
  const positions = cell.geometry.getAttribute("position") as THREE.BufferAttribute;
  (positions.array as Float32Array).set(values);
  positions.needsUpdate = true;
  cell.geometry.computeBoundingSphere();
}

function renderConfigKey(presentation: ScenePresentation): string {
  return JSON.stringify([
    presentation.mode,
    presentation.water,
    presentation.hydrogens,
    presentation.images.min,
    presentation.images.max,
    presentation.cell,
    presentation.forces,
    presentation.velocities,
    presentation.atomScale,
    presentation.bondScale,
    presentation.color,
    presentation.quality,
  ]);
}

function buildAtoms(
  model: PreparedScene,
  manifest: Manifest,
  presentation: ScenePresentation,
  appearance: Appearance,
  publication = false,
): THREE.InstancedMesh | THREE.Points | null {
  const count = model.instanceToAtom.length;
  if (count === 0) return null;
  const usePoints = usesPointAtoms(presentation, count);
  if (usePoints) {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const point = new THREE.Vector3();
    for (let instance = 0; instance < count; instance += 1) {
      const atom = model.instanceToAtom[instance];
      setInstancePosition(point, model, instance).toArray(positions, instance * 3);
      atomColor(manifest, atom, model.atomicNumbers[atom], presentation.color, appearance)
        .toArray(colors, instance * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    return new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        vertexColors: true,
        size: presentation.mode === "lines" ? 0.14 : 0.22,
        sizeAttenuation: true,
      }),
    );
  }

  const segments = publication && count <= 5_000
    ? [48, 32]
    : publication && count <= 12_000
      ? [32, 24]
      : usesHighDetailGeometry(presentation, count) ? [30, 20] : [18, 12];
  const geometry = new THREE.SphereGeometry(1, segments[0], segments[1]);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.34, metalness: 0.02 });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const dummy = new THREE.Object3D();
  for (let instance = 0; instance < count; instance += 1) {
    const atom = model.instanceToAtom[instance];
    setInstancePosition(dummy.position, model, instance);
    dummy.scale.setScalar(model.radii[atom]);
    dummy.updateMatrix();
    mesh.setMatrixAt(instance, dummy.matrix);
    mesh.setColorAt(instance, atomColor(manifest, atom, model.atomicNumbers[atom], presentation.color, appearance));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

function buildBonds(
  presentation: ScenePresentation,
  palette: ScenePalette,
  kind: FrameGeometryPlan["bondKind"],
  segments: Segment[],
  publication = false,
): THREE.Object3D | null {
  if (segments.length === 0) return null;
  if (kind === "lines") {
    const values = new Float32Array(segments.length * 6);
    segments.forEach(({ from, to }, index) => {
      from.toArray(values, index * 6);
      to.toArray(values, index * 6 + 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(values, 3).setUsage(THREE.DynamicDrawUsage));
    return new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: palette.bond, transparent: true, opacity: palette.bondOpacity }),
    );
  }
  const radius = (presentation.mode === "licorice" ? 0.14 : 0.045) * Math.max(0.1, presentation.bondScale);
  const radialSegments = publication && segments.length <= 12_000
    ? 16
    : usesHighDetailGeometry(presentation, segments.length) ? 12 : 8;
  const geometry = new THREE.CylinderGeometry(radius, radius, 1, radialSegments, 1, false);
  const material = new THREE.MeshStandardMaterial({
    color: palette.bond,
    roughness: 0.56,
    metalness: 0.01,
    transparent: true,
    opacity: palette.bondOpacity,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, segments.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  updateBondMatrices(mesh, segments);
  return mesh;
}

function updateBondMatrices(mesh: THREE.InstancedMesh, segments: Segment[]): void {
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
}

function buildCells(model: PreparedScene, palette: ScenePalette): THREE.LineSegments | null {
  if (!model.basis || model.images.length === 0) return null;
  const values: number[] = [];
  model.images.forEach((image) => appendCellLines(values, model.basis!, image, model.cellCenter));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(values, 3).setUsage(THREE.DynamicDrawUsage));
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: palette.cell, transparent: true, opacity: palette.cellOpacity }),
  );
}

function appendCellLines(
  values: number[],
  basis: CellBasis,
  offset: CellOffset,
  center: THREE.Vector3,
): void {
  const corners = cellImageCorners(basis, offset, center);
  const index = (a: number, b: number, c: number) => a * 4 + b * 2 + c;
  const edges: Array<[number, number]> = [];
  for (let a = 0; a <= 1; a += 1) {
    for (let b = 0; b <= 1; b += 1) edges.push([index(a, b, 0), index(a, b, 1)]);
    for (let c = 0; c <= 1; c += 1) edges.push([index(a, 0, c), index(a, 1, c)]);
  }
  for (let b = 0; b <= 1; b += 1) {
    for (let c = 0; c <= 1; c += 1) edges.push([index(0, b, c), index(1, b, c)]);
  }
  edges.forEach(([from, to]) => values.push(...corners[from].toArray(), ...corners[to].toArray()));
}

function buildVectors(
  model: PreparedScene,
  vectors: Float32Array | null,
  scaleFactor: number,
  color: string,
  instances: number[],
): THREE.Group | null {
  const arrows = vectorArrows(model, vectors, scaleFactor, instances);
  if (arrows.length === 0) return null;
  const group = new THREE.Group();
  const shafts = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.018, 0.018, 1, 8, 1, false),
    new THREE.MeshBasicMaterial({ color }),
    arrows.length,
  );
  shafts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(shafts);
  const heads = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1, 1, 9),
    new THREE.MeshBasicMaterial({ color }),
    arrows.length,
  );
  heads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(heads);
  updateVectors(group, arrows);
  return group;
}

interface VectorArrow {
  tail: THREE.Vector3;
  tip: THREE.Vector3;
  direction: THREE.Vector3;
  head: number;
}

function vectorArrows(
  model: PreparedScene,
  vectors: Float32Array | null,
  scaleFactor: number,
  instances: number[],
): VectorArrow[] {
  if (!vectors || vectors.length < model.count * 3) return [];
  const magnitudes = instances
    .map((instance) => {
      const atom = model.instanceToAtom[instance];
      return Math.hypot(vectors[atom * 3], vectors[atom * 3 + 1], vectors[atom * 3 + 2]);
    })
    .filter((value) => Number.isFinite(value) && value > 1e-12)
    .sort((left, right) => left - right);
  if (magnitudes.length === 0) return [];
  const reference = magnitudes[Math.floor((magnitudes.length - 1) * 0.9)];
  const scale = (1.45 / reference) * scaleFactor;
  const arrows: VectorArrow[] = [];
  const direction = new THREE.Vector3();
  const atomPosition = new THREE.Vector3();
  for (const instance of instances) {
    const atom = model.instanceToAtom[instance];
    const offset = atom * 3;
    direction.set(vectors[offset], vectors[offset + 1], vectors[offset + 2]);
    const magnitude = direction.length();
    transformDisplayVector(direction.normalize(), model);
    setInstancePosition(atomPosition, model, instance);
    const length = magnitude * scale;
    const head = Math.min(Math.min(0.24, Math.max(0.075, length * 0.24)), length * 0.5);
    const gap = (model.radii[atom] ?? 0.3) * 1.03;
    arrows.push({
      tail: atomPosition.clone().addScaledVector(direction, gap),
      tip: atomPosition.clone().addScaledVector(direction, gap + length),
      direction: direction.clone(),
      head,
    });
  }
  return arrows;
}

function updateVectors(group: THREE.Group, arrows: VectorArrow[]): void {
  const [shafts, heads] = group.children;
  if (!(shafts instanceof THREE.InstancedMesh) || !(heads instanceof THREE.InstancedMesh)) return;
  const dummy = new THREE.Object3D();
  const shaftEnd = new THREE.Vector3();
  arrows.forEach((arrow, index) => {
    shaftEnd.copy(arrow.tip).addScaledVector(arrow.direction, -arrow.head * 0.48);
    dummy.position.copy(arrow.tail).add(shaftEnd).multiplyScalar(0.5);
    dummy.quaternion.setFromUnitVectors(yAxis, arrow.direction);
    dummy.scale.set(1, arrow.tail.distanceTo(shaftEnd), 1);
    dummy.updateMatrix();
    shafts.setMatrixAt(index, dummy.matrix);
  });
  shafts.instanceMatrix.needsUpdate = true;
  arrows.forEach((arrow, index) => {
    dummy.position.copy(arrow.tip).addScaledVector(arrow.direction, -arrow.head * 0.5);
    dummy.quaternion.setFromUnitVectors(yAxis, arrow.direction);
    dummy.scale.set(arrow.head * 0.34, arrow.head, arrow.head * 0.34);
    dummy.updateMatrix();
    heads.setMatrixAt(index, dummy.matrix);
  });
  heads.instanceMatrix.needsUpdate = true;
  shafts.computeBoundingSphere();
  shafts.boundingBox = null;
  heads.computeBoundingSphere();
  heads.boundingBox = null;
}

function buildRibbon(
  model: PreparedScene,
  manifest: Manifest,
  presentation: ScenePresentation,
  appearance: Appearance,
  palette: ScenePalette,
): THREE.Mesh | null {
  if (model.backbone.length < 3) return null;
  const centers: THREE.Vector3[] = [];
  const sides: THREE.Vector3[] = [];
  for (const residue of model.backbone) {
    const raw = new THREE.Vector3().fromArray(model.positions, residue.ca * 3);
    centers.push(centers.length === 0 ? raw : unwrapPointNear(centers[centers.length - 1], raw, model.basis, model.pbc));
    const c = new THREE.Vector3().fromArray(model.positions, residue.c * 3);
    const o = new THREE.Vector3().fromArray(model.positions, residue.o * 3);
    sides.push(unwrapPointNear(c, o, model.basis, model.pbc).sub(c).normalize());
  }
  const positions: number[] = [];
  const colors: number[] = [];
  const atomIndices: number[] = [];
  const indices: number[] = [];
  const width = 0.34 * Math.max(0.2, presentation.atomScale);
  for (const image of model.images) {
    const vertexStart = positions.length / 3;
    const shift = imageTranslation(image, model.basis);
    centers.forEach((center, index) => {
      const previous = centers[Math.max(0, index - 1)];
      const next = centers[Math.min(centers.length - 1, index + 1)];
      const tangent = next.clone().sub(previous).normalize();
      const side = sides[index].clone().addScaledVector(tangent, -sides[index].dot(tangent));
      if (side.lengthSq() < 1e-8) side.crossVectors(tangent, Math.abs(tangent.y) < 0.9 ? yAxis : new THREE.Vector3(1, 0, 0));
      side.normalize().multiplyScalar(width);
      const atom = model.backbone[index].ca;
      const color = presentation.color === "element"
        ? atomColor(manifest, atom, model.atomicNumbers[atom], presentation.color, appearance)
        : new THREE.Color(palette.ribbon);
      positions.push(...center.clone().add(shift).sub(side).toArray(), ...center.clone().add(shift).add(side).toArray());
      colors.push(...color.toArray(), ...color.toArray());
      atomIndices.push(atom, atom);
      if (index > 0) {
        const left = vertexStart + index * 2;
        indices.push(left - 2, left - 1, left, left, left - 1, left + 1);
      }
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("atomIndex", new THREE.Float32BufferAttribute(atomIndices, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.48,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
  );
}

export function updateSelectionMarkers(
  state: SelectionRenderState,
  selectedAtoms: AtomSelection[],
  collectPositions = true,
): Float64Array | null {
  const model = state.model;
  if (!model) {
    state.selection.clear();
    state.selectionPoints.visible = false;
    return null;
  }

  let visible = 0;
  const selected = new Map<string, number>();
  selectedAtoms.forEach(({ atom, image }, index) => {
    if (atom >= 0 && atom < model.count && validCellOffset(image)) {
      selected.set(selectionKey(atom, image), index);
    }
  });
  const positions = collectPositions ? new Float64Array(selectedAtoms.length * 3) : null;
  let pointAttribute: THREE.BufferAttribute | null = null;
  let pointPositions: Float32Array | null = null;
  const currentPointAttribute = state.selectionPoints.geometry.getAttribute("position");
  const reusablePointAttribute = currentPointAttribute instanceof THREE.BufferAttribute
    && currentPointAttribute.itemSize === 3
    && currentPointAttribute.array instanceof Float32Array
    ? currentPointAttribute
    : null;
  const markers = selectionMarkerState(
    selectedAtoms.length,
    state.instanceToAtom.length,
    reusablePointAttribute?.count ?? null,
  );
  if (markers.mode === "points") {
    if (markers.reusePointBuffer) {
      pointAttribute = reusablePointAttribute!;
    } else {
      pointAttribute = new THREE.BufferAttribute(
        new Float32Array(markers.pointCapacity * 3),
        3,
      );
      pointAttribute.setUsage(THREE.DynamicDrawUsage);
      state.selectionPoints.geometry.setAttribute("position", pointAttribute);
    }
    pointPositions = pointAttribute.array as Float32Array;
  }
  const found = collectPositions ? new Uint8Array(selectedAtoms.length) : null;
  const point = new THREE.Vector3();
  for (let instance = 0; instance < state.instanceToAtom.length; instance += 1) {
    const selectedAtom = state.instanceToAtom[instance];
    const imageOffset = instance * 3;
    const baseOffset = selectedAtom * 3;
    const image: CellOffset = [
      (state.baseImages[baseOffset] ?? 0) + state.instanceImages[imageOffset],
      (state.baseImages[baseOffset + 1] ?? 0) + state.instanceImages[imageOffset + 1],
      (state.baseImages[baseOffset + 2] ?? 0) + state.instanceImages[imageOffset + 2],
    ];
    const selectedIndex = selected.get(selectionKey(selectedAtom, image));
    if (selectedIndex === undefined) continue;
    setInstancePosition(point, model, instance);
    if (positions) point.toArray(positions, selectedIndex * 3);
    if (pointPositions) {
      point.toArray(pointPositions, visible * 3);
    } else {
      let marker = state.selection.children[visible] as THREE.Mesh | undefined;
      if (!marker) {
        marker = new THREE.Mesh(state.selectionGeometry, state.selectionMaterial);
        marker.renderOrder = 10;
        state.selection.add(marker);
      }
      marker.position.copy(point);
      marker.scale.setScalar(Math.max(0.24, model.radii[selectedAtom] || 0.3) * 1.35);
      marker.visible = true;
    }
    if (found) found[selectedIndex] = 1;
    visible += 1;
  }
  const visibleRings = markers.clearRingMarkers ? 0 : visible;
  while (state.selection.children.length > visibleRings) {
    state.selection.remove(state.selection.children[state.selection.children.length - 1]);
  }
  if (pointPositions) {
    pointAttribute!.needsUpdate = true;
    state.selectionPoints.geometry.setDrawRange(0, visible);
    state.selectionPoints.visible = visible > 0;
  } else {
    state.selectionPoints.geometry.setDrawRange(0, 0);
    state.selectionPoints.visible = false;
  }
  return positions && found && selectedAtoms.length > 0 && found.every((value) => value === 1)
    ? positions
    : null;
}

function updateKeyboardFocus(
  state: SceneState,
  selection: AtomSelection | null,
  preferredInstance: number | null,
): number | null {
  const model = state.model;
  state.keyboardFocus.visible = false;
  if (!model || !selection) return null;
  if (preferredInstance !== null && selectionMatchesInstance(
      state.instanceToAtom,
      state.instanceImages,
      preferredInstance,
      selection,
      state.baseImages,
    )) {
    setKeyboardFocusInstance(state, selection, preferredInstance);
    return preferredInstance;
  }
  for (let instance = 0; instance < state.instanceToAtom.length; instance += 1) {
    if (!selectionMatchesInstance(
      state.instanceToAtom,
      state.instanceImages,
      instance,
      selection,
      state.baseImages,
    )) continue;
    setKeyboardFocusInstance(state, selection, instance);
    return instance;
  }
  return null;
}

function setKeyboardFocusInstance(
  state: SceneState,
  selection: AtomSelection,
  instance: number,
): void {
  const model = state.model;
  if (!model) return;
  setInstancePosition(state.keyboardFocus.position, model, instance);
  state.keyboardFocus.scale.setScalar(
    Math.max(0.24, model.radii[selection.atom] || 0.3) * 1.62,
  );
  state.keyboardFocus.visible = true;
}

export interface KeyboardAtomCursor {
  selection: AtomSelection;
  instance: number;
}

export function nextKeyboardAtomCursor(
  instanceToAtom: Uint32Array,
  instanceImages: Int8Array,
  current: AtomSelection | null,
  currentInstance: number | null,
  direction: number,
  baseImages: Int32Array = new Int32Array(),
): KeyboardAtomCursor | null {
  const count = Math.min(instanceToAtom.length, Math.floor(instanceImages.length / 3));
  if (count === 0) return null;
  let currentIndex = currentInstance !== null && selectionMatchesInstance(
      instanceToAtom,
      instanceImages,
      currentInstance,
      current,
      baseImages,
    )
    ? currentInstance
    : -1;
  if (currentIndex < 0 && current) {
    for (let instance = 0; instance < count; instance += 1) {
      if (!selectionMatchesInstance(
        instanceToAtom,
        instanceImages,
        instance,
        current,
        baseImages,
      )) continue;
      currentIndex = instance;
      break;
    }
  }
  const instance = direction === 0
    ? currentIndex >= 0 ? currentIndex : 0
    : currentIndex >= 0
      ? (currentIndex + Math.sign(direction) + count) % count
      : direction < 0 ? count - 1 : 0;
  const selection = atomSelectionForInstance(
    instanceToAtom,
    instanceImages,
    instance,
    baseImages,
  );
  return selection ? { selection, instance } : null;
}

export function nextKeyboardAtomSelection(
  instanceToAtom: Uint32Array,
  instanceImages: Int8Array,
  current: AtomSelection | null,
  direction: number,
  baseImages: Int32Array = new Int32Array(),
): AtomSelection | null {
  return nextKeyboardAtomCursor(
    instanceToAtom,
    instanceImages,
    current,
    null,
    direction,
    baseImages,
  )?.selection ?? null;
}

function selectionMatchesInstance(
  instanceToAtom: Uint32Array,
  instanceImages: Int8Array,
  instance: number,
  selection: AtomSelection | null,
  baseImages: Int32Array = new Int32Array(),
): boolean {
  if (
    !selection
    || !Number.isInteger(instance)
    || instance < 0
    || instance >= instanceToAtom.length
  ) return false;
  const offset = instance * 3;
  const atomOffset = instanceToAtom[instance] * 3;
  return offset + 2 < instanceImages.length
    && instanceToAtom[instance] === selection.atom
    && (baseImages[atomOffset] ?? 0) + instanceImages[offset] === selection.image[0]
    && (baseImages[atomOffset + 1] ?? 0) + instanceImages[offset + 1] === selection.image[1]
    && (baseImages[atomOffset + 2] ?? 0) + instanceImages[offset + 2] === selection.image[2];
}

function pickedAtom(hit: THREE.Intersection, state: SceneState): AtomSelection | null {
  if (hit.object === state.atomObject) {
    const instance = hit.instanceId ?? hit.index;
    return instance === undefined
      ? null
      : atomSelectionForInstance(
        state.instanceToAtom,
        state.instanceImages,
        instance,
        state.baseImages,
      );
  }
  if (hit.object === state.ribbon && hit.face) {
    const attribute = state.ribbon.geometry.getAttribute("atomIndex");
    const atom = Math.round(attribute.getX(hit.face.a));
    const offset = atom * 3;
    return {
      atom,
      image: [
        state.baseImages[offset] ?? 0,
        state.baseImages[offset + 1] ?? 0,
        state.baseImages[offset + 2] ?? 0,
      ],
    };
  }
  return null;
}

export function atomSelectionForInstance(
  instanceToAtom: Uint32Array,
  instanceImages: Int8Array,
  instance: number,
  baseImages: Int32Array = new Int32Array(),
): AtomSelection | null {
  if (!Number.isInteger(instance) || instance < 0 || instance >= instanceToAtom.length) return null;
  const imageOffset = instance * 3;
  if (imageOffset + 2 >= instanceImages.length) return null;
  const atom = instanceToAtom[instance];
  const atomOffset = atom * 3;
  return {
    atom,
    image: [
      (baseImages[atomOffset] ?? 0) + instanceImages[imageOffset],
      (baseImages[atomOffset + 1] ?? 0) + instanceImages[imageOffset + 1],
      (baseImages[atomOffset + 2] ?? 0) + instanceImages[imageOffset + 2],
    ],
  };
}

function validCellOffset(image: CellOffset): boolean {
  return image.length === 3 && image.every(Number.isInteger);
}

function selectionKey(atom: number, image: CellOffset): string {
  return `${atom}:${image[0]}:${image[1]}:${image[2]}`;
}

function sameAtomSelection(
  left: AtomSelection | null,
  right: AtomSelection | null,
): boolean {
  if (!left || !right) return left === right;
  return selectionKey(left.atom, left.image) === selectionKey(right.atom, right.image);
}

function keyboardAtomLabel(manifest: Manifest, selection: AtomSelection): string {
  const atom = `${manifest.topology.symbols?.[selection.atom] ?? "Atom"} ${selection.atom + 1}`;
  const image = selection.image
    .map((value, axis) => {
      if (value === 0) return "";
      const sign = value > 0 ? "+" : "−";
      const magnitude = Math.abs(value) === 1 ? "" : Math.abs(value);
      return `${sign}${magnitude}${"abc"[axis]}`;
    })
    .join("");
  return image ? `${atom} (${image})` : atom;
}

function selectionsInRectangle(
  state: SceneState,
  bounds: DOMRect,
  start: Pick<THREE.Vector2, "x" | "y">,
  end: Pick<THREE.Vector2, "x" | "y">,
): AtomSelection[] {
  const model = state.model;
  if (!model || !state.atomObject || bounds.width <= 0 || bounds.height <= 0) return [];
  const left = Math.max(bounds.left, Math.min(start.x, end.x));
  const right = Math.min(bounds.right, Math.max(start.x, end.x));
  const top = Math.max(bounds.top, Math.min(start.y, end.y));
  const bottom = Math.min(bounds.bottom, Math.max(start.y, end.y));
  if (right <= left || bottom <= top) return [];

  state.camera.updateMatrixWorld();
  const point = new THREE.Vector3();
  const result: AtomSelection[] = [];
  const seen = new Set<string>();
  for (let instance = 0; instance < state.instanceToAtom.length; instance += 1) {
    setInstancePosition(point, model, instance);
    point.project(state.camera);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.z < -1 || point.z > 1) {
      continue;
    }
    const x = bounds.left + ((point.x + 1) * 0.5) * bounds.width;
    const y = bounds.top + ((1 - point.y) * 0.5) * bounds.height;
    if (x < left || x > right || y < top || y > bottom) continue;
    const selection = atomSelectionForInstance(
      state.instanceToAtom,
      state.instanceImages,
      instance,
      state.baseImages,
    );
    if (!selection) continue;
    const key = selectionKey(selection.atom, selection.image);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(selection);
  }
  return result;
}

function setInstancePosition(
  target: THREE.Vector3,
  model: PreparedScene,
  instance: number,
): THREE.Vector3 {
  const atom = model.instanceToAtom[instance];
  target.fromArray(model.positions, atom * 3);
  if (!model.basis) return target;
  const offset = instance * 3;
  return target
    .addScaledVector(model.basis.vectors[0], model.instanceImages[offset])
    .addScaledVector(model.basis.vectors[1], model.instanceImages[offset + 1])
    .addScaledVector(model.basis.vectors[2], model.instanceImages[offset + 2]);
}

function atomColor(
  manifest: Manifest,
  atom: number,
  atomicNumber: number,
  mode: ScenePresentation["color"],
  appearance: Appearance,
): THREE.Color {
  if (mode === "element") return elementColor(atomicNumber, appearance);
  if (mode === "chain") return new THREE.Color(appearance === "light" ? "#2D7DA4" : "#59a9bd");
  const residue = manifest.topology.atom_residue_index?.[atom] ?? atom;
  const hue = ((residue * 0.173) % 1 + 1) % 1;
  return new THREE.Color().setHSL(hue, appearance === "light" ? 0.42 : 0.5, appearance === "light" ? 0.43 : 0.62);
}

function elementColor(atomicNumber: number, appearance: Appearance): THREE.Color {
  const colors = appearance === "light" ? lightElementColors : darkElementColors;
  return new THREE.Color(colors[atomicNumber] ?? (appearance === "light" ? "#65757a" : "#c7ced1"));
}

function sceneFitBounds(state: SceneState, context: FitContext): THREE.Box3 | null {
  const { model, presentation } = context;
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let instance = 0; instance < model.instanceToAtom.length; instance += 1) {
    const atom = model.instanceToAtom[instance];
    setInstancePosition(point, model, instance);
    const radius = presentation.mode === "ribbon" ? 0.4 : (model.radii[atom] ?? 0.25);
    bounds.expandByPoint(new THREE.Vector3(point.x - radius, point.y - radius, point.z - radius));
    bounds.expandByPoint(new THREE.Vector3(point.x + radius, point.y + radius, point.z + radius));
  }
  if (state.forces) {
    state.forces.updateMatrixWorld(true);
    bounds.union(new THREE.Box3().setFromObject(state.forces));
  }
  if (state.velocities) {
    state.velocities.updateMatrixWorld(true);
    bounds.union(new THREE.Box3().setFromObject(state.velocities));
  }
  if (presentation.cell && model.basis) {
    const cellBounds = new THREE.Box3();
    model.images.forEach((image) => expandByCell(cellBounds, model.basis!, image, model.cellCenter));
    const atomSpan = bounds.getSize(new THREE.Vector3()).length();
    const cellSpan = cellBounds.getSize(new THREE.Vector3()).length();
    if (includeCellInFit(atomSpan, cellSpan, model.images)) bounds.union(cellBounds);
  }
  return bounds.isEmpty() ? null : bounds;
}

function fitCamera(state: SceneState, context: FitContext): void {
  const bounds = sceneFitBounds(state, context);
  if (!bounds) return;
  clearOrbitMotion(state.controls);
  const center = bounds.getCenter(new THREE.Vector3());
  const verticalHalfFov = THREE.MathUtils.degToRad(state.camera.fov * 0.5);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * state.camera.aspect);
  const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
  const { direction, up } = cameraOrientation(context.preset);
  const right = new THREE.Vector3().crossVectors(up, direction).normalize();
  const cameraUp = new THREE.Vector3().crossVectors(direction, right).normalize();
  const fill = 0.78;
  let distance = 1.6 / Math.tan(limitingHalfFov) * 1.08;
  for (const corner of boxCorners(bounds)) {
    const relative = corner.sub(center);
    const depth = relative.dot(direction);
    distance = Math.max(
      distance,
      depth + Math.abs(relative.dot(right)) / (Math.tan(horizontalHalfFov) * fill),
      depth + Math.abs(relative.dot(cameraUp)) / (Math.tan(verticalHalfFov) * fill),
    );
  }
  state.camera.up.copy(up);
  state.camera.position.copy(center).addScaledVector(direction, distance);
  state.camera.near = Math.max(distance / 500, 0.01);
  state.camera.far = Math.max(distance * 30, 100);
  state.camera.updateProjectionMatrix();
  state.controls.target.copy(center);
  state.controls.update();
  state.lastFittedAspect = state.camera.aspect;
  state.cameraMode = "fit";
}

export function captureCameraState(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
): SceneCameraState {
  return {
    position: camera.position.toArray(),
    target: target.toArray(),
    up: camera.up.toArray(),
    fov: camera.fov,
    zoom: camera.zoom,
    near: camera.near,
    far: camera.far,
  };
}

function restoreCameraState(state: SceneState, value: SceneCameraState): void {
  const numbers = [
    ...value.position,
    ...value.target,
    ...value.up,
    value.fov,
    value.zoom,
    value.near,
    value.far,
  ];
  if (
    numbers.some((entry) => !Number.isFinite(entry))
    || value.fov <= 0
    || value.fov >= 180
    || value.zoom <= 0
    || value.near <= 0
    || value.far <= value.near
  ) {
    throw new Error("The saved camera is invalid");
  }
  clearOrbitMotion(state.controls);
  state.camera.position.fromArray(value.position);
  state.camera.up.fromArray(value.up).normalize();
  state.camera.fov = value.fov;
  state.camera.zoom = value.zoom;
  state.camera.near = value.near;
  state.camera.far = value.far;
  state.controls.target.fromArray(value.target);
  state.camera.updateProjectionMatrix();
  state.controls.update();
  state.cameraMode = "manual";
}

export function clearOrbitMotion(controls: OrbitControls): void {
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  try {
    controls.update();
  } finally {
    controls.enableDamping = damping;
  }
}

function layoutKey(model: PreparedScene, presentation: ScenePresentation): string {
  const imageLayout = imageLayoutShape(model.images);
  return [
    presentation.mode,
    presentation.wrap,
    presentation.cellOrigin.join(","),
    presentation.mirror.join(","),
    presentation.cell,
    model.visibleAtoms.length,
    imageLayout.count,
    imageLayout.span.join(","),
  ].join(":");
}

function expandByCell(
  bounds: THREE.Box3,
  basis: CellBasis,
  offset: CellOffset,
  center: THREE.Vector3,
): void {
  cellImageCorners(basis, offset, center).forEach((corner) => bounds.expandByPoint(corner));
}

function boxCorners(bounds: THREE.Box3): THREE.Vector3[] {
  const result: THREE.Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) result.push(new THREE.Vector3(x, y, z));
    }
  }
  return result;
}

function cameraOrientation(preset: ViewPreset): { direction: THREE.Vector3; up: THREE.Vector3 } {
  if (preset === "xy") return { direction: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) };
  if (preset === "xz") return { direction: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) };
  if (preset === "yz") return { direction: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1) };
  return { direction: new THREE.Vector3(1, 0.68, 1.15).normalize(), up: new THREE.Vector3(0, 1, 0) };
}

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((child) => {
    const renderable = child as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    if (child instanceof THREE.InstancedMesh) child.dispose();
    if (renderable.geometry && !geometries.has(renderable.geometry)) {
      geometries.add(renderable.geometry);
      renderable.geometry.dispose();
    }
    const entries = Array.isArray(renderable.material)
      ? renderable.material
      : renderable.material ? [renderable.material] : [];
    entries.forEach((material) => {
      if (materials.has(material)) return;
      materials.add(material);
      material.dispose();
    });
  });
}

const darkElementColors: Record<number, string> = {
  1: "#f0eee7", 2: "#d8f2f2", 3: "#b889df", 4: "#bed17f", 5: "#d4956d", 6: "#94a3a7",
  7: "#5680dd", 8: "#df6259", 9: "#6cba79", 10: "#7bcdd0", 11: "#9874ce", 12: "#89a86d",
  13: "#c7b8ae", 14: "#d5aa82", 15: "#ed9e54", 16: "#ead462", 17: "#74ca88", 18: "#8bdce2",
  19: "#aa7bdd", 20: "#99ba7b", 26: "#cf8964", 29: "#d19a71", 30: "#adb3b7", 35: "#b65a4c", 53: "#8d61b5",
};

const lightElementColors: Record<number, string> = {
  ...darkElementColors,
  1: "#aab5b3",
  6: "#273a3f",
  7: "#315bb8",
  8: "#c94138",
  9: "#318448",
  15: "#d87924",
  16: "#c5a51c",
  17: "#348b4c",
};
