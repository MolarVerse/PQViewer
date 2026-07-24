import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { frameArray } from "./api";
import {
  encodeRgbaPng,
  hasVisiblePngContent,
  MAX_PNG_EXPORT_PIXELS,
  pngExportAoScale,
  pngExportSampleLevel,
  resolvePngExportOptions,
} from "./scene/pngExport";
import type { PngExportLimits, PngExportOptions, ResolvedPngExportOptions } from "./scene/pngExport";
import { publicationCamera, publicationContextUsesPoints } from "./scene/publication";
import {
  backboneResidues,
  cellImageCorners,
  centeredFramePositions,
  detectWaterAtoms,
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

type GtaoPassConstructor = typeof import("three/examples/jsm/postprocessing/GTAOPass.js").GTAOPass;
type LineMaterialConstructor = typeof import("three/examples/jsm/lines/LineMaterial.js").LineMaterial;
type LineSegments2Constructor = typeof import("three/examples/jsm/lines/LineSegments2.js").LineSegments2;
type LineSegmentsGeometryConstructor = typeof import("three/examples/jsm/lines/LineSegmentsGeometry.js").LineSegmentsGeometry;

export {
  centeredFramePositions,
  framePbc,
  hasFrameCell,
  periodicBondSegments,
} from "./scene/model";
export type { PngExportOptions } from "./scene/pngExport";

interface MoleculeSceneProps {
  manifest: Manifest;
  frame: FrameData | null;
  presentation: ScenePresentation;
  selectedAtoms: AtomSelection[];
  resetSignal: number;
  forceScale: number;
  velocityScale: number;
  appearance: Appearance;
  viewPreset?: ViewPreset;
  viewSignal?: number;
  onSelect: (selection: AtomSelection | null, additive: boolean) => void;
  onSceneInfo?: (info: RenderedSceneInfo | null) => void;
  onSelectionPositions?: (positions: Float64Array | null) => void;
}

export type ViewPreset = "perspective" | "xy" | "xz" | "yz";

export interface MoleculeSceneHandle {
  exportPng: (options: PngExportOptions) => Promise<Blob>;
}

export interface RenderedSceneInfo {
  imageCount: number;
  forceCount: number;
  forceTotal: number;
  velocityCount: number;
  velocityTotal: number;
  capabilities: SceneCapabilities;
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
  selection: THREE.Group;
  selectionGeometry: THREE.RingGeometry;
  selectionMaterial: THREE.MeshBasicMaterial;
  pickables: THREE.Object3D[];
  instanceToAtom: Uint32Array;
  instanceImages: Int8Array;
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
  resetSignal,
  forceScale,
  velocityScale,
  appearance,
  viewPreset = "perspective",
  viewSignal = 0,
  onSelect,
  onSceneInfo,
  onSelectionPositions,
}: MoleculeSceneProps, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<SceneState | null>(null);
  const selectRef = useRef(onSelect);
  const sceneInfoRef = useRef(onSceneInfo);
  const selectionPositionsRef = useRef(onSelectionPositions);
  const reportedInfoRef = useRef<{ manifest: Manifest; info: RenderedSceneInfo } | null>(null);
  const exportActiveRef = useRef(false);
  selectRef.current = onSelect;
  sceneInfoRef.current = onSceneInfo;
  selectionPositionsRef.current = onSelectionPositions;

  useImperativeHandle(ref, () => ({
    exportPng: async (options) => {
      if (exportActiveRef.current) throw new Error("A PNG export is already in progress");
      const state = stateRef.current;
      if (!state?.model) throw new Error("The molecular scene is not ready to export");
      const snapshot = capturePublicationSnapshot(state);
      exportActiveRef.current = true;
      try {
        return await exportScenePng(state.renderer, snapshot, options);
      } finally {
        exportActiveRef.current = false;
      }
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
      selection,
      selectionGeometry,
      selectionMaterial,
      pickables: [],
      instanceToAtom: new Uint32Array(),
      instanceImages: new Int8Array(),
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
    };
    stateRef.current = state;

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
      if (state.fitContext && Math.abs(Math.log(camera.aspect / state.lastFittedAspect)) > 0.06) {
        fitCamera(state, state.fitContext);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener("resize", resize);
    resize();

    const pointerStart = new THREE.Vector2();
    let pickPointerId: number | null = null;
    let multiPointerGesture = false;
    const pointer = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points!.threshold = 0.24;
    const onPointerDown = (event: PointerEvent) => {
      if (pickPointerId !== null && event.pointerId !== pickPointerId) {
        multiPointerGesture = true;
        return;
      }
      if (!event.isPrimary) return;
      pickPointerId = event.pointerId;
      multiPointerGesture = false;
      pointerStart.set(event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pickPointerId) return;
      pickPointerId = null;
      const moved = pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5;
      const gesture = multiPointerGesture;
      multiPointerGesture = false;
      if (moved || gesture) return;
      const bounds = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(state.pickables, false)[0];
      selectRef.current(
        hit ? pickedAtom(hit, state) : null,
        isAdditivePick(event),
      );
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== pickPointerId) return;
      pickPointerId = null;
      multiPointerGesture = false;
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    renderer.setAnimationLoop(() => {
      controls.update();
      selection.children.forEach((marker) => {
        if (marker.visible) marker.quaternion.copy(camera.quaternion);
      });
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      controls.dispose();
      root.remove(selection);
      disposeObject(root);
      selection.clear();
      selectionGeometry.dispose();
      selectionMaterial.dispose();
      renderer.dispose();
      stateRef.current = null;
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
    state.renderTopology = state.preparedTopology;
    state.renderConfigKey = configKey;
    state.frameLayout = frameLayout;

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
    const positions = state ? updateSelection(state, selectedAtoms) : null;
    selectionPositionsRef.current?.(positions);
    if (selectedAtoms.length > 0 && positions === null) {
      selectRef.current(null, false);
    }
  }, [frame, presentation, selectedAtoms]);

  return <canvas ref={canvasRef} className="molecule-canvas" aria-label="Molecular structure" tabIndex={0} />;
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

async function exportScenePng(renderer: THREE.WebGLRenderer, snapshot: PublicationSnapshot, options: PngExportOptions): Promise<Blob> {
  const gl = renderer.getContext();
  if (gl.isContextLost()) throw new Error("PNG export is unavailable because the WebGL context was lost");
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
  const resolved = resolvePngExportOptions(options, rendererPngLimits(renderer, gl));
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
  configurePublicationOutput(outputPass, resolved.transparent);

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
    throw new Error(`PNG export failed: ${detail}`);
  }
  if (!hasVisiblePngContent(pixels, resolved.transparent)) {
    throw new Error("PNG export failed because the rendered image was blank");
  }
  return encodeRgbaPng(pixels, resolved.width, resolved.height);
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
    appendCellLines(values, model.basis, image);
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

function configurePublicationOutput(
  pass: InstanceType<typeof import("three/examples/jsm/postprocessing/OutputPass.js").OutputPass>,
  transparent: boolean,
): void {
  const sample = "gl_FragColor = texture2D( tDiffuse, vUv );";
  const source = pass.material.fragmentShader;
  const fragmentShader = source
    .replace("uniform sampler2D tDiffuse;", "uniform sampler2D tDiffuse;\nuniform float publicationTransparent;")
    .replace(sample, `${sample}
      float publicationCoverage = gl_FragColor.a;
      gl_FragColor.rgb = publicationCoverage > 0.000001
        ? gl_FragColor.rgb / publicationCoverage
        : vec3( 0.0 );`)
    .replace("// color space", `if ( publicationTransparent < 0.5 ) {
        gl_FragColor.rgb = gl_FragColor.rgb * publicationCoverage + vec3( 1.0 ) * ( 1.0 - publicationCoverage );
        gl_FragColor.a = 1.0;
      }

      // color space`);
  if (fragmentShader === source || !fragmentShader.includes("publicationCoverage")) {
    throw new Error("Publication output shader is incompatible");
  }
  pass.material.fragmentShader = fragmentShader;
  pass.material.uniforms.publicationTransparent = { value: transparent ? 1 : 0 };
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
  model.images.forEach((image) => appendCellLines(values, model.basis!, image));
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
    presentation.wrap,
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
  model.images.forEach((image) => appendCellLines(values, model.basis!, image));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(values, 3).setUsage(THREE.DynamicDrawUsage));
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: palette.cell, transparent: true, opacity: palette.cellOpacity }),
  );
}

function appendCellLines(values: number[], basis: CellBasis, offset: CellOffset): void {
  const corners = cellImageCorners(basis, offset);
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
    direction.normalize();
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

function updateSelection(state: SceneState, selectedAtoms: AtomSelection[]): Float64Array | null {
  const model = state.model;
  if (!model) {
    state.selection.clear();
    return null;
  }

  let visible = 0;
  const selected = new Map<string, number>();
  selectedAtoms.forEach(({ atom, image }, index) => {
    if (atom >= 0 && atom < model.count && validCellOffset(image)) {
      selected.set(selectionKey(atom, image), index);
    }
  });
  const positions = new Float64Array(selectedAtoms.length * 3);
  const found = new Uint8Array(selectedAtoms.length);
  for (let instance = 0; instance < state.instanceToAtom.length; instance += 1) {
    const selectedAtom = state.instanceToAtom[instance];
    const imageOffset = instance * 3;
    const image: CellOffset = [
      state.instanceImages[imageOffset],
      state.instanceImages[imageOffset + 1],
      state.instanceImages[imageOffset + 2],
    ];
    const selectedIndex = selected.get(selectionKey(selectedAtom, image));
    if (selectedIndex === undefined) continue;
    let marker = state.selection.children[visible] as THREE.Mesh | undefined;
    if (!marker) {
      marker = new THREE.Mesh(state.selectionGeometry, state.selectionMaterial);
      marker.renderOrder = 10;
      state.selection.add(marker);
    }
    setInstancePosition(marker.position, model, instance);
    marker.position.toArray(positions, selectedIndex * 3);
    found[selectedIndex] = 1;
    marker.scale.setScalar(Math.max(0.24, model.radii[selectedAtom] || 0.3) * 1.35);
    marker.visible = true;
    visible += 1;
  }
  while (state.selection.children.length > visible) {
    state.selection.remove(state.selection.children[state.selection.children.length - 1]);
  }
  return selectedAtoms.length > 0 && found.every((value) => value === 1)
    ? positions
    : null;
}

function pickedAtom(hit: THREE.Intersection, state: SceneState): AtomSelection | null {
  if (hit.object === state.atomObject) {
    const instance = hit.instanceId ?? hit.index;
    return instance === undefined
      ? null
      : atomSelectionForInstance(state.instanceToAtom, state.instanceImages, instance);
  }
  if (hit.object === state.ribbon && hit.face) {
    const attribute = state.ribbon.geometry.getAttribute("atomIndex");
    return { atom: Math.round(attribute.getX(hit.face.a)), image: [0, 0, 0] };
  }
  return null;
}

export function atomSelectionForInstance(
  instanceToAtom: Uint32Array,
  instanceImages: Int8Array,
  instance: number,
): AtomSelection | null {
  if (!Number.isInteger(instance) || instance < 0 || instance >= instanceToAtom.length) return null;
  const imageOffset = instance * 3;
  if (imageOffset + 2 >= instanceImages.length) return null;
  return {
    atom: instanceToAtom[instance],
    image: [
      instanceImages[imageOffset],
      instanceImages[imageOffset + 1],
      instanceImages[imageOffset + 2],
    ],
  };
}

function validCellOffset(image: CellOffset): boolean {
  return image.length === 3 && image.every(Number.isInteger);
}

function selectionKey(atom: number, image: CellOffset): string {
  return `${atom}:${image[0]}:${image[1]}:${image[2]}`;
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
    model.images.forEach((image) => expandByCell(cellBounds, model.basis!, image));
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
  return `${presentation.mode}:${presentation.wrap}:${presentation.cell}:${model.visibleAtoms.length}:${imageLayout.count}:${imageLayout.span.join(",")}`;
}

function expandByCell(bounds: THREE.Box3, basis: CellBasis, offset: CellOffset): void {
  cellImageCorners(basis, offset).forEach((corner) => bounds.expandByPoint(corner));
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
