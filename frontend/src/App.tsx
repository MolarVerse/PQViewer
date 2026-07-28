import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { FormEvent } from "react";
import {
  DatasetChangedError,
  frameArray,
  FrameCache,
  getFrame,
  getInitialRecipe,
  getManifest,
  getSelectedPositions,
  isStaticDemoMode,
  normalizeSeries,
  openFiles,
  runRdfAnalysis,
} from "./api";
import type { RdfAnalysisResult } from "./api";
import { searchCommandActions } from "./commandSearch";
import { MeasurementPlot, PlotShelf } from "./MeasurementPlot";
import {
  calculateMeasurementComparison,
  calculateMeasurementSeries,
  measurementComparisonPlotData,
  measurementSeriesCsv,
  measurementSeriesPdf,
  measurementSeriesSvg,
  plotShelfCsv,
  plotShelfPdf,
  plotShelfSvg,
} from "./measurementSeries";
import type {
  MeasurementComparisonDefinition,
  MeasurementSeriesProgress,
} from "./measurementSeries";
import {
  cloneFigureRecipe,
  figureFrameFingerprint,
  figureSourceFromManifest,
  parseFigureRecipe,
  parseFigureRecipeJson,
  recipeMatchesManifestSource,
  sameFrameKey,
  stringifyFigureRecipe,
} from "./figureRecipe";
import type {
  FigureAnnotation,
  FigureOutput,
  FigureRecipe,
} from "./figureRecipe";
import {
  fractionalStructureCenter,
  framePbc,
  hasFrameCell,
  MoleculeScene,
  POLYHEDRA_REQUIREMENT,
  sceneCapabilities,
} from "./RendererScene";
import type {
  TrajectoryOverlays,
  FigureExportOptions,
  MoleculeSceneHandle,
  RenderedSceneInfo,
  ViewPreset,
} from "./RendererScene";
import { RdfSetup } from "./RdfSetup";
import type {
  AnalysisSelectionOption,
  RdfSetupValue,
} from "./RdfSetup";
import {
  advanceFrameIndex,
  parseVimPreference,
  resolveVimNavigation,
  shortcutLabelsForPlatform,
} from "./keyboard";
import type { ViewerShortcutLabels, VimNavigationAction, VimPrefix } from "./keyboard";
import { Icon } from "./Icon";
import {
  measureAtomSelection,
  updateSceneSelection,
} from "./selection";
import {
  MAX_ATOM_INSTANCES,
  MAX_PERIODIC_IMAGES,
  prepareTopology,
} from "./scene/model";
import type { PreparedTopology } from "./scene/model";
import {
  cloneSelections,
  createNamedSelection,
  createSelectionTopology,
  ELEMENT_NAMES,
  ELEMENT_SYMBOLS,
  hillFormula,
  mergeSelections,
  parseWithinSelectionCommand,
  replaceSelections,
  SelectionIndex,
} from "./scientificSelection";
import {
  cellFromParameters,
  cellMatrix,
  cellParameters,
  frameToExtxyz,
  suggestedCell,
  updateAtomElement,
  updateAtomPosition,
  updateCell,
  validateCell,
} from "./structureEditing";
import type { CellParameters } from "./structureEditing";
import type {
  NamedSelection,
  SceneSelectionContext,
  ScientificSelectionScope,
  SelectionSummary,
  SelectionTopology,
} from "./scientificSelection";
import {
  DEFAULT_PLAYBACK_FPS,
  playbackPrefetchIndices,
  playbackTimerDelay,
  runScheduledPlaybackTick,
  schedulePlaybackFrame,
} from "./trajectory";
import type { PlaybackDirection, PlaybackMode } from "./trajectory";
import {
  frameMark,
  frameMarkLabel,
  initialTrajectoryStudyState,
  trajectoryStudyReducer,
} from "./trajectoryStudy";
import type {
  FrameMark,
  PlotShelfData,
  TrackingMode,
} from "./trajectoryStudy";
import {
  MAX_TRACKED_SELECTIONS,
  trackingFrameIndices,
  trackingFrameMismatch,
  trajectoryOverlaysFromPositions,
} from "./trajectoryTracking";
import type {
  AtomSelection,
  Appearance,
  CellOffset,
  DisplaySeries,
  FrameData,
  Manifest,
  RepresentationMode,
  SceneCapabilities,
  ScenePresentation,
} from "./types";

type LoadState = "loading" | "ready" | "error";
type SceneProfile =
  | "auto"
  | "molecule"
  | "protein"
  | "liquid"
  | "crystal"
  | "mof"
  | "trajectory"
  | "custom";
type WorkbenchTab = "view" | "edit" | "analyze";
type EditTarget = "cell" | "atom";
type SelectionIntent = "measurement" | "set";
type NoticeState = { message: string; tone: "status" | "error" };
type RdfPlotContext = {
  requestId: number;
  referenceLabel: string;
  targetLabel: string;
};
type FocusTarget = Element & { focus: (options?: FocusOptions) => void };
type PinnedMeasurement = {
  id: number;
  selections: AtomSelection[];
  minimumImage: boolean;
};
type FigureBridgeOverrides = Partial<Pick<
  FigureOutput,
  "format" | "width" | "height" | "dpi"
>> & {
  transparent?: boolean;
};

declare global {
  interface Window {
    pqviewerFigure?: {
      ready: boolean;
      error: string | null;
      export: (overrides?: FigureBridgeOverrides) => Promise<void>;
    };
  }
}

const DATASET_CHANNEL = "pqviewer-dataset";
const MAX_FIGURE_RECIPE_BYTES = 1_048_576;
const MAX_RDF_SELECTION_ATOMS = 4_096;

const defaultFigureOutput: FigureOutput = {
  format: "png",
  width: 2400,
  height: 1800,
  dpi: 300,
  background: { kind: "solid", color: "#ffffff" },
  projection: "orthographic",
  fit: true,
  padding: 0.08,
  periodicContext: true,
};

const defaultPresentation: ScenePresentation = {
  mode: "ball-stick",
  water: "show",
  hydrogens: true,
  wrap: "molecule",
  images: { min: [0, 0, 0], max: [0, 0, 0] },
  cellOrigin: [0, 0, 0],
  mirror: [false, false, false],
  cell: true,
  bonds: true,
  forces: true,
  velocities: false,
  atomScale: 1,
  bondScale: 1,
  color: "element",
  quality: "auto",
};

export default function App() {
  const staticDemo = isStaticDemoMode();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [requestKey, setRequestKey] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [loadedFrame, setLoadedFrame] = useState<{ index: number; data: FrameData } | null>(null);
  const [frameError, setFrameError] = useState("");
  const [frameLoading, setFrameLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playbackFps, setPlaybackFps] = useState(DEFAULT_PLAYBACK_FPS);
  const [playbackStride, setPlaybackStride] = useState(1);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("loop");
  const [playbackDirection, setPlaybackDirection] = useState<PlaybackDirection>(1);
  const [playbackPulse, setPlaybackPulse] = useState(0);
  const [playbackOptionsOpen, setPlaybackOptionsOpen] = useState(false);
  const [presentation, setPresentation] = useState<ScenePresentation>(initialPresentation);
  const [appearance, setAppearance] = useState<Appearance>(initialAppearance);
  const [profile, setProfile] = useState<SceneProfile>("auto");
  const [selectedAtoms, setSelectedAtoms] = useState<AtomSelection[]>([]);
  const [selectionIntent, setSelectionIntent] = useState<SelectionIntent>("measurement");
  const [selectionAnchor, setSelectionAnchor] = useState<AtomSelection | null>(null);
  const [selectionContext, setSelectionContext] = useState<SceneSelectionContext | null>(null);
  const [namedSelections, setNamedSelections] = useState<NamedSelection[]>([]);
  const [pinnedMeasurements, setPinnedMeasurements] = useState<PinnedMeasurement[]>([]);
  const [minimumImage, setMinimumImage] = useState(true);
  const [measurementPlotOpen, setMeasurementPlotOpen] = useState(false);
  const [measurementSeries, setMeasurementSeries] = useState<MeasurementSeriesProgress | null>(null);
  const [study, dispatchStudy] = useReducer(
    trajectoryStudyReducer,
    initialTrajectoryStudyState,
  );
  const [trajectoryOverlays, setTrajectoryOverlays] = useState<TrajectoryOverlays>({
    trails: [],
    displacements: [],
  });
  const [rdfSetupOpen, setRdfSetupOpen] = useState(false);
  const [rdfInitialView, setRdfInitialView] = useState<"rdf" | "coordination">("rdf");
  const [rdfResult, setRdfResult] = useState<RdfAnalysisResult | null>(null);
  const [rdfView, setRdfView] = useState<"rdf" | "coordination">("rdf");
  const [rdfRunning, setRdfRunning] = useState(false);
  const [rdfContext, setRdfContext] = useState<RdfPlotContext | null>(null);
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget>("cell");
  const [workbenchExpanded, setWorkbenchExpanded] = useState(false);
  const [settingTarget, setSettingTarget] = useState<string | null>(null);
  const [canvasHintDismissed, setCanvasHintDismissed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [vimMode, setVimMode] = useState(initialVimMode);
  const [resetSignal, setResetSignal] = useState(0);
  const [viewPreset, setViewPreset] = useState<ViewPreset>("perspective");
  const [viewSignal, setViewSignal] = useState(0);
  const [sceneRevision, setSceneRevision] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [figureSheetOpen, setFigureSheetOpen] = useState(false);
  const [figureOutput, setFigureOutput] = useState<FigureOutput>(defaultFigureOutput);
  const [figureAnnotations, setFigureAnnotations] = useState<FigureAnnotation[]>([]);
  const [recipeApplying, setRecipeApplying] = useState(false);
  const [figureBridgeError, setFigureBridgeError] = useState("");
  const [forceScale, setForceScale] = useState(1);
  const [velocityScale, setVelocityScale] = useState(1);
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [sceneInfo, setSceneInfo] = useState<RenderedSceneInfo | null>(null);
  const [sceneTopology, setSceneTopology] = useState<{
    manifest: Manifest;
    value: PreparedTopology;
  } | null>(null);
  const [editedFrames, setEditedFrames] = useState<Set<number>>(() => new Set());
  const [topologyEdited, setTopologyEdited] = useState(false);
  const cache = useRef(new FrameCache());
  const moleculeSceneRef = useRef<MoleculeSceneHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recipeInputRef = useRef<HTMLInputElement>(null);
  const viewButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const analyzeButtonRef = useRef<HTMLButtonElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const workbenchRef = useRef<HTMLElement>(null);
  const vimSequenceRef = useRef<{ prefix: VimPrefix; at: number }>({ prefix: null, at: 0 });
  const dragDepth = useRef(0);
  const autoProfileKey = useRef("");
  const openRequest = useRef(0);
  const openController = useRef<AbortController | null>(null);
  const measurementRequest = useRef(0);
  const studyRequest = useRef(0);
  const studyController = useRef<AbortController | null>(null);
  const trackingController = useRef<AbortController | null>(null);
  const rdfController = useRef<AbortController | null>(null);
  const recipeRequest = useRef(0);
  const pendingFigureRecipe = useRef<FigureRecipe | null>(null);
  const nextPinnedMeasurement = useRef(1);
  const selectionAnchorAudit = useRef<{ selections: AtomSelection[] | null; key: string }>({
    selections: null,
    key: "",
  });
  const datasetReloadPending = useRef(false);
  const datasetCheckPending = useRef(false);
  const manifestGeneration = useRef("");
  const activeManifest = useRef<Manifest | null>(null);
  const originalManifest = useRef<Manifest | null>(null);
  const frameDrafts = useRef(new Map<string, FrameData>());
  const sceneTopologyRef = useRef<{
    manifest: Manifest;
    value: PreparedTopology;
  } | null>(null);
  const datasetChannel = useRef<BroadcastChannel | null>(null);
  const playbackClock = useRef<{ key: string; requestTimeMs: number | null }>({
    key: "",
    requestTimeMs: null,
  });
  const frameCoordinateMode = presentation.wrap === "unwrapped" ? "unwrapped" : "source";
  const frameCoordinateModeRef = useRef<"source" | "unwrapped">("source");
  const playbackState = useRef({
    playing,
    mode: playbackMode,
    direction: playbackDirection,
    stride: playbackStride,
  });
  playbackState.current = {
    playing,
    mode: playbackMode,
    direction: playbackDirection,
    stride: playbackStride,
  };
  const shortcutLabels = useMemo(() => shortcutLabelsForPlatform(browserPlatform()), []);

  const activateManifest = useCallback((
    value: Manifest,
    preserveStudyMarks = false,
  ) => {
    recipeRequest.current += 1;
    studyRequest.current += 1;
    studyController.current?.abort();
    studyController.current = null;
    trackingController.current?.abort();
    trackingController.current = null;
    rdfController.current?.abort();
    rdfController.current = null;
    cache.current.clear();
    cache.current = new FrameCache({ datasetGeneration: value.dataset_generation });
    frameCoordinateModeRef.current = "source";
    datasetReloadPending.current = false;
    manifestGeneration.current = value.dataset_generation ?? "";
    activeManifest.current = value;
    originalManifest.current = value;
    frameDrafts.current.clear();
    sceneTopologyRef.current = null;
    setSceneTopology(null);
    setSceneRevision(0);
    setEditedFrames(new Set());
    setTopologyEdited(false);
    setManifest(value);
    setFrameIndex(0);
    setLoadedFrame(null);
    setSelectedAtoms([]);
    setSelectionIntent("measurement");
    setSelectionAnchor(null);
    setSelectionContext(null);
    setNamedSelections([]);
    setPinnedMeasurements([]);
    setMinimumImage(true);
    setMeasurementPlotOpen(false);
    setMeasurementSeries(null);
    dispatchStudy({ type: "reset", preserveMarks: preserveStudyMarks });
    setTrajectoryOverlays({ trails: [], displacements: [] });
    setRdfSetupOpen(false);
    setRdfResult(null);
    setRdfRunning(false);
    setRdfContext(null);
    setPlaying(false);
    setPlaybackDirection(1);
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    setCommandOpen(false);
    setShortcutsOpen(false);
    setFigureSheetOpen(false);
    setFigureOutput(cloneFigureOutput(defaultFigureOutput));
    setFigureAnnotations([]);
    setRecipeApplying(false);
    setFigureBridgeError("");
    pendingFigureRecipe.current = null;
    setSceneInfo(null);
    setPresentation((current) => ({
      ...current,
      ...defaultPeriodicPresentation(),
    }));
    setLoadState("ready");
    setLoadError("");
    setProfile("auto");
    autoProfileKey.current = "";
    document.title = `${value.name || "Trajectory"} · PQViewer`;
  }, []);

  const stageFigureRecipe = useCallback((
    input: FigureRecipe,
    dataset: Manifest,
  ) => {
    const recipe = cloneFigureRecipe(input);
    if (!recipeMatchesManifestSource(recipe, dataset)) {
      throw new Error("This figure recipe belongs to a different source");
    }
    if (recipe.frame.index >= dataset.frame_count) {
      throw new Error("The saved frame is outside this trajectory");
    }
    if (recipe.scene.selection.atoms.some(
      ({ atom }) => atom >= dataset.topology.atom_count,
    )) {
      throw new Error("The saved selection is outside this structure");
    }
    if (recipe.annotations.some(
      (annotation) => annotation.kind === "atom-label"
        && annotation.atom.atom >= dataset.topology.atom_count,
    )) {
      throw new Error("The saved atom labels are outside this structure");
    }
    const request = recipeRequest.current + 1;
    recipeRequest.current = request;
    pendingFigureRecipe.current = null;
    setRecipeApplying(true);
    setFigureBridgeError("");
    void getFrame(
      recipe.frame.index,
      undefined,
      dataset.dataset_generation,
      recipe.scene.presentation.wrap === "unwrapped"
        ? "unwrapped"
        : "source",
    )
      .then((candidate) => {
        if (recipeRequest.current !== request) return;
        if (!sameFrameKey(candidate.header.frame_key, recipe.frame.key)) {
          throw new Error("The saved frame no longer matches this trajectory");
        }
        if (
          figureFrameFingerprint(dataset, candidate)
          !== recipe.frame.fingerprint
        ) {
          throw new Error("The saved frame content changed");
        }
        const activeTopology = sceneTopologyRef.current?.manifest === dataset
          ? sceneTopologyRef.current.value
          : null;
        const requestedTopology = activeTopology
          ?? prepareTopology(dataset, candidate);
        if (!requestedTopology) {
          throw new Error("The molecular topology is unavailable");
        }
        const requestedCapabilities = sceneCapabilities(
          dataset,
          candidate,
          recipe.scene.presentation,
          requestedTopology,
        );
        if (
          recipe.scene.presentation.mode === "polyhedra"
          && !requestedCapabilities.polyhedra
        ) {
          throw new Error(
            `Polyhedra unavailable · ${requestedCapabilities.polyhedraReason}`,
          );
        }
        if (!activeTopology) {
          const entry = { manifest: dataset, value: requestedTopology };
          sceneTopologyRef.current = entry;
          setSceneTopology(entry);
        }
        setPlaying(false);
        setPlaybackOptionsOpen(false);
        setMeasurementPlotOpen(false);
        setMeasurementSeries(null);
        studyRequest.current += 1;
        studyController.current?.abort();
        studyController.current = null;
        trackingController.current?.abort();
        trackingController.current = null;
        rdfController.current?.abort();
        rdfController.current = null;
        dispatchStudy({ type: "reset" });
        setTrajectoryOverlays({ trails: [], displacements: [] });
        setRdfSetupOpen(false);
        setRdfResult(null);
        setRdfRunning(false);
        setRdfContext(null);
        setWorkbenchTab(null);
        setCommandOpen(false);
        setShortcutsOpen(false);
        setFigureSheetOpen(false);
        setProfile("custom");
        autoProfileKey.current = `${dataset.name}:${dataset.topology.atom_count}`;
        setPresentation(recipe.scene.presentation);
        setSelectedAtoms(cloneSelections(recipe.scene.selection.atoms));
        setSelectionIntent(recipe.scene.selection.intent);
        setMinimumImage(recipe.scene.selection.minimumImage);
        setForceScale(recipe.scene.vectors.forceScale);
        setVelocityScale(recipe.scene.vectors.velocityScale);
        setFigureOutput(cloneFigureOutput(recipe.output));
        setFigureAnnotations(cloneFigureRecipe(recipe).annotations);
        setFrameError("");
        setFrameIndex(recipe.frame.index);
        pendingFigureRecipe.current = recipe;
      })
      .catch((error: unknown) => {
        if (recipeRequest.current !== request) return;
        const detail = message(error);
        setRecipeApplying(false);
        setFigureBridgeError(detail);
        setNotice({
          message: `Figure recipe unavailable · ${detail}`,
          tone: "error",
        });
      });
  }, []);

  const reloadChangedDataset = useCallback(() => {
    if (datasetReloadPending.current) return;
    recipeRequest.current += 1;
    studyRequest.current += 1;
    studyController.current?.abort();
    studyController.current = null;
    trackingController.current?.abort();
    trackingController.current = null;
    rdfController.current?.abort();
    rdfController.current = null;
    datasetReloadPending.current = true;
    manifestGeneration.current = "";
    activeManifest.current = null;
    sceneTopologyRef.current = null;
    setSceneTopology(null);
    cache.current.clear();
    frameCoordinateModeRef.current = "source";
    setManifest(null);
    setFrameIndex(0);
    setLoadedFrame(null);
    setFrameError("");
    setFrameLoading(false);
    setSelectedAtoms([]);
    setSelectionIntent("measurement");
    setSelectionAnchor(null);
    setSelectionContext(null);
    setNamedSelections([]);
    setPinnedMeasurements([]);
    setMeasurementPlotOpen(false);
    setMeasurementSeries(null);
    dispatchStudy({ type: "reset" });
    setTrajectoryOverlays({ trails: [], displacements: [] });
    setRdfSetupOpen(false);
    setRdfResult(null);
    setRdfRunning(false);
    setRdfContext(null);
    setPlaying(false);
    setPlaybackDirection(1);
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    setCommandOpen(false);
    setShortcutsOpen(false);
    setFigureSheetOpen(false);
    setFigureAnnotations([]);
    setRecipeApplying(false);
    setFigureBridgeError("");
    pendingFigureRecipe.current = null;
    setSceneInfo(null);
    setLoadState("loading");
    setLoadError("");
    setNotice({ message: "Trajectory changed in another tab · reloading", tone: "status" });
    setRequestKey((value) => value + 1);
  }, []);

  useEffect(() => {
    if (typeof window.BroadcastChannel !== "function") return;
    const channel = new BroadcastChannel(DATASET_CHANNEL);
    datasetChannel.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const generation = (
        typeof event.data === "object"
        && event.data !== null
        && "datasetGeneration" in event.data
        && typeof event.data.datasetGeneration === "string"
      )
        ? event.data.datasetGeneration
        : "";
      if (
        generation
        && manifestGeneration.current
        && generation !== manifestGeneration.current
      ) {
        reloadChangedDataset();
      }
    };
    return () => {
      if (datasetChannel.current === channel) datasetChannel.current = null;
      channel.close();
    };
  }, [reloadChangedDataset]);

  const revalidateDataset = useCallback(async () => {
    const expectedGeneration = manifestGeneration.current;
    if (
      !expectedGeneration
      || datasetCheckPending.current
      || datasetReloadPending.current
    ) {
      return;
    }
    datasetCheckPending.current = true;
    try {
      const current = await getManifest();
      if (manifestGeneration.current !== expectedGeneration) return;
      if (current.dataset_generation !== expectedGeneration) {
        activateManifest(
          current,
          compatibleManifestGrowth(activeManifest.current, current),
        );
        setNotice({ message: "Trajectory changed · updated", tone: "status" });
        datasetChannel.current?.postMessage({
          datasetGeneration: current.dataset_generation,
        });
      }
    } catch {
      // A transient focus check should not replace the loaded trajectory.
    } finally {
      datasetCheckPending.current = false;
    }
  }, [activateManifest]);

  useEffect(() => {
    const onFocus = () => {
      void revalidateDataset();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void revalidateDataset();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [revalidateDataset]);

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance;
    document.documentElement.style.colorScheme = appearance;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      appearance === "dark" ? "#1e2e33" : "#f6f8f8",
    );
    try {
      window.localStorage.setItem("pqviewer-appearance", appearance);
    } catch {}
  }, [appearance]);

  useEffect(() => {
    try {
      window.localStorage.setItem("pqviewer-presentation", JSON.stringify({
        mode: presentation.mode,
        water: presentation.water,
        cell: presentation.cell,
        bonds: presentation.bonds,
        forces: presentation.forces,
        velocities: presentation.velocities,
      }));
    } catch {}
  }, [presentation]);

  useEffect(() => {
    try {
      window.localStorage.setItem("pqviewer-vim-navigation", String(vimMode));
    } catch {}
  }, [vimMode]);

  useEffect(() => {
    let active = true;
    setLoadState("loading");
    setLoadError("");
    Promise.all([
      getManifest(),
      getInitialRecipe(),
    ])
      .then(([value, initialRecipe]) => {
        if (!active) return;
        activateManifest(value);
        if (initialRecipe !== null) {
          try {
            stageFigureRecipe(parseFigureRecipe(initialRecipe), value);
          } catch (error) {
            const detail = message(error);
            setFigureBridgeError(detail);
            setNotice({ message: `Figure recipe unavailable · ${detail}`, tone: "error" });
          }
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(message(error));
        setLoadState("error");
      });
    return () => {
      active = false;
    };
  }, [activateManifest, requestKey, stageFigureRecipe]);

  useEffect(() => {
    if (!manifest || frameCoordinateModeRef.current === frameCoordinateMode) return;
    cache.current.clear();
    cache.current = new FrameCache({
      datasetGeneration: manifest.dataset_generation,
      coordinates: frameCoordinateMode,
    });
    frameCoordinateModeRef.current = frameCoordinateMode;
    setFrameError("");
  }, [frameCoordinateMode, manifest]);

  useEffect(() => {
    if (!manifest || manifest.frame_count === 0) return;
    if (rendering) return;
    let active = true;
    cache.current.cancelPendingExcept(frameIndex);
    setFrameLoading(true);
    setFrameError("");
    cache.current
      .get(frameIndex)
      .then((data) => {
        if (!active) return;
        const draft = frameDrafts.current.get(frameDraftKey(frameCoordinateMode, frameIndex));
        setLoadedFrame({ index: frameIndex, data: draft ?? data });
        setFrameLoading(false);
        const playback = playbackState.current;
        const prefetch = playback.playing
          ? playbackPrefetchIndices(frameIndex, manifest.frame_count, {
              mode: playback.mode,
              direction: playback.direction,
              stride: playback.stride,
            })
          : Array.from(
              { length: Math.min(4, manifest.frame_count - 1) },
              (_, ahead) => (frameIndex + ahead + 1) % manifest.frame_count,
            );
        prefetch.forEach((index) => cache.current.prefetch(index, manifest.frame_count));
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof DatasetChangedError) {
          reloadChangedDataset();
          return;
        }
        if (frameCoordinateMode === "unwrapped") {
          setPresentation((current) => (
            current.wrap === "unwrapped"
              ? { ...current, wrap: "atom" }
              : current
          ));
          setNotice({
            message: `Unwrapped coordinates unavailable · showing atoms`,
            tone: "error",
          });
          setFrameLoading(false);
          setPlaying(false);
          return;
        }
        setFrameError(message(error));
        setFrameLoading(false);
        setPlaying(false);
      });
    return () => {
      active = false;
    };
  }, [frameCoordinateMode, frameIndex, manifest, reloadChangedDataset, rendering]);

  useEffect(() => {
    const recipe = pendingFigureRecipe.current;
    if (
      !recipe
      || !manifest
      || !loadedFrame
      || loadedFrame.index !== recipe.frame.index
      || frameLoading
    ) {
      return;
    }
    if (!sameFrameKey(loadedFrame.data.header.frame_key, recipe.frame.key)) {
      pendingFigureRecipe.current = null;
      setRecipeApplying(false);
      setFigureBridgeError("The saved frame no longer matches this trajectory");
      setNotice({
        message: "Figure recipe unavailable · saved frame changed",
        tone: "error",
      });
      return;
    }
    if (
      figureFrameFingerprint(manifest, loadedFrame.data)
      !== recipe.frame.fingerprint
    ) {
      pendingFigureRecipe.current = null;
      setRecipeApplying(false);
      setFigureBridgeError("The saved frame content changed");
      setNotice({
        message: "Figure recipe unavailable · saved frame changed",
        tone: "error",
      });
      return;
    }
    try {
      const scene = moleculeSceneRef.current;
      if (!scene) throw new Error("The molecular scene is not ready");
      scene.restoreCamera(recipe.camera);
      pendingFigureRecipe.current = null;
      setRecipeApplying(false);
      setFigureBridgeError("");
      if (!isHeadlessFigureMode()) {
        setNotice({ message: "Figure recipe restored", tone: "status" });
      }
    } catch (error) {
      pendingFigureRecipe.current = null;
      setRecipeApplying(false);
      const detail = message(error);
      setFigureBridgeError(detail);
      setNotice({ message: `Figure recipe unavailable · ${detail}`, tone: "error" });
    }
  }, [
    frameLoading,
    loadedFrame,
    manifest,
    presentation,
    forceScale,
    velocityScale,
  ]);

  const setFrame = useCallback(
    (value: number) => {
      if (!manifest?.frame_count) return;
      setPlaybackDirection(1);
      setFrameIndex(Math.max(0, Math.min(manifest.frame_count - 1, Math.round(value))));
    },
    [manifest?.frame_count],
  );

  const stepFrame = useCallback(
    (delta: number) => {
      if (!manifest?.frame_count) return;
      setPlaybackDirection(1);
      setFrameIndex((current) => advanceFrameIndex(current, delta, manifest.frame_count));
    },
    [manifest?.frame_count],
  );

  const focusWorkbench = useCallback(() => {
    requestAnimationFrame(() => workbenchRef.current?.focus());
  }, []);

  const openWorkbench = useCallback((tab: WorkbenchTab, focus = false) => {
    setPlaybackOptionsOpen(false);
    setFigureSheetOpen(false);
    setMeasurementPlotOpen(false);
    setMeasurementSeries(null);
    setWorkbenchExpanded(false);
    setCanvasHintDismissed(true);
    setWorkbenchTab(tab);
    if (focus) focusWorkbench();
  }, [focusWorkbench]);

  const closeWorkbench = useCallback((restoreFocus = false) => {
    const closingTab = workbenchTab;
    setWorkbenchTab(null);
    setWorkbenchExpanded(false);
    setSettingTarget(null);
    if (restoreFocus) requestAnimationFrame(() => {
      if (closingTab === "edit") editButtonRef.current?.focus();
      else if (closingTab === "analyze") analyzeButtonRef.current?.focus();
      else viewButtonRef.current?.focus();
    });
  }, [workbenchTab]);

  const selectAtom = useCallback((selection: AtomSelection | null, additive = false) => {
    setPlaybackOptionsOpen(false);
    setSelectionIntent("measurement");
    if (selection === null) {
      setSelectedAtoms([]);
      setSelectionAnchor(null);
      setMeasurementPlotOpen(false);
      setMeasurementSeries(null);
      setEditTarget("cell");
      return;
    }
    setSelectionAnchor({ atom: selection.atom, image: [...selection.image] });
    const nextSelection = updateSceneSelection(
      selectedAtoms,
      selection,
      additive ? "toggle" : "replace",
    );
    setSelectedAtoms(nextSelection);
    if (!additive) {
      if (workbenchTab === "edit") {
        setEditTarget("atom");
      } else {
        setWorkbenchTab("analyze");
      }
    } else if (workbenchTab === null && nextSelection.length === 1) {
      setWorkbenchTab("analyze");
    } else if (workbenchTab === "edit" && editTarget === "atom" && nextSelection.length !== 1) {
      setWorkbenchTab("analyze");
    }
    setCanvasHintDismissed(true);
  }, [editTarget, selectedAtoms, workbenchTab]);

  const selectManyAtoms = useCallback((
    selections: AtomSelection[],
    additive = false,
  ) => {
    if (selections.length === 0) return;
    setPlaybackOptionsOpen(false);
    setSelectionIntent("set");
    setMeasurementPlotOpen(false);
    setMeasurementSeries(null);
    setSelectedAtoms((current) => (
      additive
        ? mergeSelections(current, selections, "toggle")
        : replaceSelections(selections)
    ));
    const anchor = selections.at(-1);
    if (anchor) setSelectionAnchor({ atom: anchor.atom, image: [...anchor.image] });
    if (workbenchTab === "edit" && editTarget === "atom") setWorkbenchTab("analyze");
    setCanvasHintDismissed(true);
  }, [editTarget, workbenchTab]);

  useEffect(() => {
    if (selectedAtoms.length === 0) {
      setSelectionAnchor(null);
      setEditTarget("cell");
    } else if (
      !selectionAnchor
      || !selectedAtoms.some((selection) => sameAtomSelectionValue(selection, selectionAnchor))
    ) {
      const anchor = selectedAtoms.at(-1)!;
      setSelectionAnchor({ atom: anchor.atom, image: [...anchor.image] });
    }
    if (selectedAtoms.length < 2 || selectedAtoms.length > 4) {
      setMeasurementPlotOpen(false);
      setMeasurementSeries(null);
    }
    if (selectedAtoms.length !== 1 && workbenchTab === "edit" && editTarget === "atom") {
      setWorkbenchTab("analyze");
    }
  }, [editTarget, selectedAtoms, selectionAnchor, workbenchTab]);

  const selectView = useCallback((preset: ViewPreset) => {
    setViewPreset(preset);
    setViewSignal((value) => value + 1);
  }, []);

  const showOpen = useCallback(() => {
    if (rendering) return;
    setCommandOpen(false);
    setShortcutsOpen(false);
    setFigureSheetOpen(false);
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    fileInputRef.current?.click();
  }, [rendering]);

  const showCommands = useCallback(() => {
    if (rendering) return;
    setPlaying(false);
    setShortcutsOpen(false);
    setFigureSheetOpen(false);
    setPlaybackOptionsOpen(false);
    setCommandOpen(true);
  }, [rendering]);

  const showShortcuts = useCallback(() => {
    if (rendering) return;
    setCommandOpen(false);
    setFigureSheetOpen(false);
    setPlaybackOptionsOpen(false);
    setShortcutsOpen(true);
  }, [rendering]);

  const exportFigure = useCallback(async (
    options: FigureExportOptions,
    propagateError = false,
  ) => {
    const scene = moleculeSceneRef.current;
    if (!scene || rendering) return null;
    if (frameLoading) {
      setNotice({ message: "Wait for the current frame to finish loading.", tone: "status" });
      return null;
    }
    const format = options.format ?? "png";
    const activeElement = document.activeElement;
    const focusOrigin = activeElement
      && activeElement !== document.body
      && "focus" in activeElement
      ? activeElement as FocusTarget
      : null;
    setPlaying(false);
    setRendering(true);
    setNotice({ message: `Exporting ${format === "tiff" ? "TIFF" : "PNG"}…`, tone: "status" });
    try {
      const blob = await scene.exportFigure(options);
      downloadBlob(
        blob,
        figureFileName(manifest?.name, options.width, options.height, format),
      );
      setNotice({
        message: `Exported ${options.width.toLocaleString()} × ${options.height.toLocaleString()} px`,
        tone: "status",
      });
      return blob;
    } catch (error) {
      setNotice({ message: `Export failed · ${message(error)}`, tone: "error" });
      if (propagateError) throw error;
      return null;
    } finally {
      setRendering(false);
      requestAnimationFrame(() => restoreFocusWhenAvailable(
        focusOrigin?.isConnected ? focusOrigin : exportButtonRef.current,
      ));
    }
  }, [frameLoading, manifest?.name, rendering]);

  const frame = loadedFrame?.data ?? null;
  useEffect(() => {
    if (
      !manifest
      || !frame
      || sceneTopologyRef.current?.manifest === manifest
    ) {
      return;
    }
    const value = prepareTopology(manifest, frame);
    if (!value) return;
    const entry = { manifest, value };
    sceneTopologyRef.current = entry;
    setSceneTopology(entry);
  }, [frame, manifest]);
  const displayedFrameIndex = loadedFrame?.index ?? frameIndex;
  const displayedFrameMark = useMemo(
    () => frameMark(displayedFrameIndex, frame),
    [displayedFrameIndex, frame],
  );
  useEffect(() => {
    if (!displayedFrameMark) return;
    const bookmark = study.bookmarks.find(
      ({ index }) => index === displayedFrameMark.index,
    );
    if (bookmark && !sameFrameKey(bookmark.key, displayedFrameMark.key)) {
      dispatchStudy({ type: "toggle-bookmark", mark: bookmark });
      setNotice({ message: "Removed a stale bookmark", tone: "status" });
    }
    if (
      study.reference?.index === displayedFrameMark.index
      && !sameFrameKey(study.reference.key, displayedFrameMark.key)
    ) {
      dispatchStudy({ type: "clear-reference" });
      setNotice({ message: "Reference frame changed · cleared", tone: "status" });
    }
  }, [displayedFrameMark, study.bookmarks, study.reference]);
  const selectedAtom = selectedAtoms.at(-1)?.atom ?? null;
  const cellAvailable = hasFrameCell(frame);
  const forces = frameArray(frame, ["forces", "force"]);
  const forceAvailable = Boolean(forces && forces.length >= (manifest?.topology.atom_count ?? 0) * 3);
  const velocities = frameArray(frame, ["velocities", "velocity", "vel"]);
  const velocityAvailable = Boolean(velocities && velocities.length >= (manifest?.topology.atom_count ?? 0) * 3);
  const pbc = measurementPbc(frame);
  const periodicCentersNeeded = cellAvailable && (
    workbenchTab === "view"
    || commandOpen
  );
  const structureCellOrigin = useMemo(
    () => periodicCentersNeeded ? cellOriginForFrame(frame) : null,
    [frame, periodicCentersNeeded],
  );
  const selectionCellOrigin = useMemo(
    () => periodicCentersNeeded ? cellOriginForFrame(frame, selectedAtoms) : null,
    [frame, periodicCentersNeeded, selectedAtoms],
  );
  const selectionTopology = useMemo<SelectionTopology | null>(
    () => selectionContext ? createSelectionTopology(selectionContext) : null,
    [
      manifest,
      selectionContext?.atomResidueIndex,
      selectionContext?.bonds,
      selectionContext?.count,
    ],
  );
  const selectionIndex = useMemo(
    () => selectionContext && selectionTopology
      ? new SelectionIndex(selectionContext, selectionTopology)
      : null,
    [selectionContext, selectionTopology],
  );
  const scientificSelectionPositions = useMemo(
    () => selectionIndex && selectedAtoms.length <= 4
      ? positionsForSelections(selectionIndex, selectedAtoms)
      : null,
    [selectedAtoms, selectionIndex],
  );
  const activeSelectionPositions = scientificSelectionPositions;
  const selectionFormula = useMemo(
    () => selectionContext
      ? formulaForSelections(selectionContext, selectedAtoms)
      : "",
    [selectedAtoms, selectionContext?.atomicNumbers],
  );
  const selectionSummary = useMemo(
    () => workbenchTab === "analyze" && selectedAtoms.length > 4
      ? selectionIndex?.summarize(selectedAtoms) ?? null
      : null,
    [selectedAtoms, selectionIndex, workbenchTab],
  );
  const selectableElements = useMemo(() => {
    if (!selectionContext) return [];
    const numbers = new Set<number>();
    for (let atom = 0; atom < selectionContext.count; atom += 1) {
      const atomicNumber = selectionContext.atomicNumbers[atom];
      if (atomicNumber > 0 && atomicNumber < ELEMENT_SYMBOLS.length) numbers.add(atomicNumber);
    }
    return [...numbers].sort((left, right) => left - right);
  }, [selectionContext?.atomicNumbers, selectionContext?.count]);
  const selectionVisibilityKey = [
    presentation.wrap,
    presentation.water,
    presentation.hydrogens,
    presentation.images.min.join(","),
    presentation.images.max.join(","),
    presentation.cellOrigin.join(","),
  ].join(":");
  useEffect(() => {
    if (!selectionIndex || selectedAtoms.length === 0) return;
    if (
      selectionAnchorAudit.current.selections === selectedAtoms
      && selectionAnchorAudit.current.key === selectionVisibilityKey
    ) return;
    selectionAnchorAudit.current = {
      selections: selectedAtoms,
      key: selectionVisibilityKey,
    };
    if (selectionAnchor && selectionIndex.isVisible(selectionAnchor)) return;
    const visible = [...selectedAtoms].reverse().find((selection) => (
      selectionIndex.isVisible(selection)
    ));
    if (visible) setSelectionAnchor({ atom: visible.atom, image: [...visible.image] });
  }, [
    selectedAtoms,
    selectionAnchor,
    selectionIndex,
    selectionVisibilityKey,
  ]);
  const capabilities = sceneInfo?.capabilities ?? null;
  useEffect(() => {
    if (!shouldNormalizePolyhedra(
      presentation.mode,
      capabilities?.polyhedra ?? null,
      recipeApplying,
    )) {
      return;
    }
    setPresentation((current) => (
      current.mode === "polyhedra"
        ? { ...current, mode: "ball-stick" }
        : current
    ));
    setProfile("custom");
    setNotice({
      message: `Polyhedra unavailable · ${capabilities?.polyhedraReason ?? POLYHEDRA_REQUIREMENT}`,
      tone: "status",
    });
  }, [
    capabilities?.polyhedra,
    capabilities?.polyhedraReason,
    presentation.mode,
    recipeApplying,
  ]);
  const canPlay = (manifest?.frame_count ?? 0) > 1;
  const loadedCoordinateMode = frame?.header.coordinates === "unwrapped"
    ? "unwrapped"
    : "source";
  const canRender = Boolean(
    frame
    && capabilities
    && !frameLoading
    && !recipeApplying
    && loadedCoordinateMode === frameCoordinateMode
  );
  const canPlotMeasurement = canPlay
    && selectionIntent === "measurement"
    && selectedAtoms.length >= 2
    && selectedAtoms.length <= 4
    && selectedAtoms.every(({ atom }) => atom >= 0 && atom < (manifest?.topology.atom_count ?? 0));
  const propertySeries = useMemo(
    () => normalizeSeries(manifest?.series).filter(({ name, values }) => (
      values.length === (manifest?.frame_count ?? 0)
      && !["step", "time"].includes(normalizeName(name))
    )),
    [manifest?.frame_count, manifest?.series],
  );
  const analysisSelectionOptions = useMemo<AnalysisSelectionOption[]>(() => {
    if (!manifest) return [];
    const options: AnalysisSelectionOption[] = [];
    const selected = uniqueAtomIndices(
      selectedAtoms.map(({ atom }) => atom),
      manifest.topology.atom_count,
    );
    if (selected.length > 0 && selected.length <= MAX_RDF_SELECTION_ATOMS) {
      options.push({
        id: "selected",
        label: selectionFormula || "Selection",
        atomIndices: selected,
      });
    }
    namedSelections.forEach((named, index) => {
      const atoms = uniqueAtomIndices(
        named.selections.map(({ atom }) => atom),
        manifest.topology.atom_count,
      );
      if (atoms.length > 0 && atoms.length <= MAX_RDF_SELECTION_ATOMS) {
        options.push({
          id: `saved-${index}`,
          label: named.name,
          atomIndices: atoms,
        });
      }
    });
    const atomicNumbers = manifest.topology.atomic_numbers
      ?? (selectionContext?.atomicNumbers
        ? Array.from(selectionContext.atomicNumbers)
        : []);
    selectableElements.forEach((atomicNumber) => {
      const atoms = atomicNumbers.flatMap((value, atom) => (
        value === atomicNumber ? [atom] : []
      ));
      if (atoms.length > 0 && atoms.length <= MAX_RDF_SELECTION_ATOMS) {
        options.push({
          id: `element-${atomicNumber}`,
          label: `All ${ELEMENT_SYMBOLS[atomicNumber]} atoms`,
          atomIndices: atoms,
        });
      }
    });
    if (
      options.length === 0
      && manifest.topology.atom_count > 0
      && manifest.topology.atom_count <= MAX_RDF_SELECTION_ATOMS
    ) {
      options.push({
        id: "all",
        label: "All atoms",
        atomIndices: Array.from(
          { length: manifest.topology.atom_count },
          (_, atom) => atom,
        ),
      });
    }
    return options;
  }, [
    manifest,
    namedSelections,
    selectableElements,
    selectionContext?.atomicNumbers,
    selectedAtoms,
    selectionFormula,
  ]);
  const analysisAvailable = Boolean(
    !staticDemo
    && canPlay
    && manifest?.source?.path
    && pbc.every(Boolean)
    && analysisSelectionOptions.length > 0,
  );
  const trackingAvailable = canPlay
    && selectedAtoms.length > 0
    && selectedAtoms.length <= MAX_TRACKED_SELECTIONS;
  const currentBookmarked = Boolean(
    displayedFrameMark
    && study.bookmarks.some(({ key }) => sameFrameKey(key, displayedFrameMark.key)),
  );
  const comparablePins = useMemo(
    () => largestCompatibleMeasurementGroup(pinnedMeasurements),
    [pinnedMeasurements],
  );
  const hasStructureEdits = editedFrames.size > 0 || topologyEdited;
  const workbenchVisible = Boolean(workbenchTab && manifest && capabilities);
  const plotFrameAxis = useMemo(
    () => measurementPlotOpen && manifest
      ? Array.from({ length: manifest.frame_count }, (_, index) => index)
      : [],
    [manifest, measurementPlotOpen],
  );
  const emptyMeasurementValues = useMemo(
    () => plotFrameAxis.map(() => null),
    [plotFrameAxis],
  );

  const applyScientificSelection = useCallback((
    selections: readonly AtomSelection[],
    message?: string,
    intent: SelectionIntent = "set",
  ) => {
    const next = replaceSelections(selections);
    setSelectedAtoms(next);
    setSelectionIntent(intent);
    if (intent === "set") {
      setMeasurementPlotOpen(false);
      setMeasurementSeries(null);
    }
    const anchor = next.at(-1);
    setSelectionAnchor(anchor ? { atom: anchor.atom, image: [...anchor.image] } : null);
    if (message) setNotice({ message, tone: "status" });
  }, []);

  const selectScope = useCallback((scope: ScientificSelectionScope) => {
    const anchor = selectionAnchor ?? selectedAtoms.at(-1) ?? null;
    if (!selectionIndex || !anchor) return;
    const scoped = selectionIndex.selectScope(anchor, scope);
    if (scoped === null) {
      setNotice({
        message: scope === "residue"
          ? "Residue data is unavailable for this atom."
          : "Bond connectivity is unavailable for this structure.",
        tone: "status",
      });
      return;
    }
    if (scoped.length === 0) {
      setNotice({ message: "The anchor is not visible in the current view.", tone: "status" });
      return;
    }
    applyScientificSelection(scoped, `${scopeLabel(scope)} · ${atomCountLabel(scoped.length)}`);
  }, [applyScientificSelection, selectedAtoms, selectionAnchor, selectionIndex]);

  const selectWithinDistance = useCallback((distance: number) => {
    if (!selectionIndex || selectedAtoms.length === 0 || !Number.isFinite(distance) || distance <= 0) return;
    const nearby = selectionIndex.withinDistanceOf(selectedAtoms, distance);
    if (nearby.length === 0) {
      setNotice({ message: "No visible atoms are within that distance.", tone: "status" });
      return;
    }
    applyScientificSelection(
      nearby,
      `Within ${formatNumber(distance)} Å · ${atomCountLabel(nearby.length)}`,
    );
  }, [applyScientificSelection, selectedAtoms, selectionIndex]);

  const selectElement = useCallback((atomicNumber: number) => {
    if (!selectionIndex) return;
    const selections = selectionIndex.selectElement(atomicNumber);
    if (selections.length === 0) {
      setNotice({
        message: `No visible ${ELEMENT_NAMES[atomicNumber]} atoms.`,
        tone: "status",
      });
      return;
    }
    applyScientificSelection(
      selections,
      `${ELEMENT_SYMBOLS[atomicNumber]} · ${atomCountLabel(selections.length)}`,
    );
  }, [applyScientificSelection, selectionIndex]);

  const selectWater = useCallback(() => {
    if (!selectionIndex) return;
    const selections = selectionIndex.selectWater();
    if (selections.length === 0) {
      setNotice({ message: "No visible water molecules found.", tone: "status" });
      return;
    }
    applyScientificSelection(selections, `Water · ${atomCountLabel(selections.length)}`);
  }, [applyScientificSelection, selectionIndex]);

  const saveNamedSelection = useCallback((name: string): boolean => {
    if (selectedAtoms.length === 0) return false;
    try {
      const named = createNamedSelection(name, selectedAtoms);
      setNamedSelections((current) => [
        ...current.filter((item) => item.name.toLowerCase() !== named.name.toLowerCase()),
        named,
      ]);
      setNotice({ message: `Saved selection · ${named.name}`, tone: "status" });
      return true;
    } catch (error) {
      setNotice({ message: message(error), tone: "error" });
      return false;
    }
  }, [selectedAtoms]);

  const recallNamedSelection = useCallback((named: NamedSelection) => {
    applyScientificSelection(named.selections, `Selection · ${named.name}`);
  }, [applyScientificSelection]);

  const removeNamedSelection = useCallback((name: string) => {
    setNamedSelections((current) => current.filter((item) => item.name !== name));
  }, []);

  const pinSelectedMeasurement = useCallback(() => {
    if (
      selectionIntent !== "measurement"
      || selectedAtoms.length < 2
      || selectedAtoms.length > 4
    ) return;
    const id = nextPinnedMeasurement.current;
    nextPinnedMeasurement.current += 1;
    setPinnedMeasurements((current) => [
      ...current,
      {
        id,
        selections: cloneSelections(selectedAtoms),
        minimumImage,
      },
    ].slice(-8));
    setNotice({ message: "Measurement pinned.", tone: "status" });
  }, [minimumImage, selectedAtoms, selectionIntent]);

  const restorePinnedMeasurement = useCallback((pin: PinnedMeasurement) => {
    setMinimumImage(pin.minimumImage);
    applyScientificSelection(pin.selections, undefined, "measurement");
  }, [applyScientificSelection]);

  const closeStudyPlot = useCallback((restoreFocus = false) => {
    studyRequest.current += 1;
    studyController.current?.abort();
    studyController.current = null;
    rdfController.current?.abort();
    rdfController.current = null;
    setRdfRunning(false);
    setRdfResult(null);
    setRdfContext(null);
    dispatchStudy({ type: "close-plot" });
    if (restoreFocus) requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".timeline-options > summary")?.focus();
    });
  }, []);

  const closeMeasurementPlot = useCallback((restoreFocus = false) => {
    setMeasurementPlotOpen(false);
    setMeasurementSeries(null);
    if (restoreFocus) requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".selection-plot-button")?.focus();
    });
  }, []);

  const showMeasurementPlot = useCallback(() => {
    if (!canPlotMeasurement) return;
    setPlaying(false);
    setCommandOpen(false);
    setShortcutsOpen(false);
    setFigureSheetOpen(false);
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    setMeasurementSeries(null);
    closeStudyPlot(false);
    if (!cellAvailable || !pbc.some(Boolean)) setMinimumImage(false);
    setMeasurementPlotOpen(true);
  }, [
    canPlotMeasurement,
    cellAvailable,
    closeStudyPlot,
    pbc[0],
    pbc[1],
    pbc[2],
  ]);

  useEffect(() => {
    const request = measurementRequest.current + 1;
    measurementRequest.current = request;
    if (!measurementPlotOpen || !manifest || !canPlotMeasurement) return;

    const controller = new AbortController();
    setMeasurementSeries(null);
    void calculateMeasurementSeries({
      manifest,
      frameCount: manifest.frame_count,
      selections: selectedAtoms,
      wrap: presentation.wrap,
      minimumImage,
      signal: controller.signal,
      loadFrame: (index, signal) => getFrame(
        index,
        signal,
        manifest.dataset_generation,
      ),
      onProgress: (progress) => {
        if (measurementRequest.current === request && !controller.signal.aborted) {
          setMeasurementSeries(progress);
        }
      },
    })
      .then((series) => {
        if (measurementRequest.current === request && !controller.signal.aborted) {
          setMeasurementSeries(series);
        }
      })
      .catch((error: unknown) => {
        if (measurementRequest.current !== request || controller.signal.aborted) return;
        if (error instanceof DatasetChangedError) {
          reloadChangedDataset();
          return;
        }
        setMeasurementPlotOpen(false);
        setMeasurementSeries(null);
        setNotice({ message: `Plot unavailable · ${message(error)}`, tone: "error" });
      });

    return () => controller.abort();
  }, [
    canPlotMeasurement,
    manifest,
    measurementPlotOpen,
    minimumImage,
    presentation.wrap,
    reloadChangedDataset,
    selectedAtoms,
  ]);

  const toggleCurrentBookmark = useCallback(() => {
    if (!displayedFrameMark) {
      setNotice({ message: "This frame has no stable source identity.", tone: "status" });
      return;
    }
    dispatchStudy({ type: "toggle-bookmark", mark: displayedFrameMark });
  }, [displayedFrameMark]);

  const setCurrentReference = useCallback(() => {
    if (!displayedFrameMark) {
      setNotice({ message: "This frame has no stable source identity.", tone: "status" });
      return;
    }
    dispatchStudy({ type: "set-reference", mark: displayedFrameMark });
    setNotice({
      message: `Reference · ${frameMarkLabel(displayedFrameMark)}`,
      tone: "status",
    });
  }, [displayedFrameMark]);

  const setTrackingMode = useCallback((mode: TrackingMode) => {
    if (mode !== "off" && !trackingAvailable) {
      setNotice({
        message: selectedAtoms.length > MAX_TRACKED_SELECTIONS
          ? `Track up to ${MAX_TRACKED_SELECTIONS} selected atoms.`
          : "Select atoms in a trajectory first.",
        tone: "status",
      });
      return;
    }
    if (mode === "displacement" && study.reference === null) {
      setNotice({ message: "Set a reference frame first.", tone: "status" });
      return;
    }
    dispatchStudy({
      type: "set-tracking",
      mode: study.tracking === mode ? "off" : mode,
    });
  }, [selectedAtoms.length, study.reference, study.tracking, trackingAvailable]);

  useEffect(() => {
    trackingController.current?.abort();
    trackingController.current = null;
    if (
      study.tracking === "off"
      || !manifest
      || !trackingAvailable
      || selectedAtoms.length === 0
    ) {
      setTrajectoryOverlays({ trails: [], displacements: [] });
      if (study.tracking !== "off" && !trackingAvailable) {
        dispatchStudy({ type: "set-tracking", mode: "off" });
      }
      return;
    }
    const frameIndices = trackingFrameIndices(
      study.tracking,
      displayedFrameIndex,
      study.reference?.index ?? null,
      manifest.frame_count,
    );
    if (frameIndices.length === 0) {
      setTrajectoryOverlays({ trails: [], displacements: [] });
      return;
    }
    const controller = new AbortController();
    trackingController.current = controller;
    const selections = cloneSelections(selectedAtoms);
    void getSelectedPositions({
      datasetGeneration: manifest.dataset_generation ?? "",
      atomIndices: uniqueAtomIndices(
        selections.map(({ atom }) => atom),
        manifest.topology.atom_count,
      ),
      frameIndices,
      coordinates: "unwrapped",
    }, controller.signal)
      .then((positions) => {
        if (controller.signal.aborted) return;
        const mismatch = trackingFrameMismatch(
          positions,
          displayedFrameIndex,
          displayedFrameMark?.key ?? null,
          study.reference?.index ?? null,
          study.reference?.key ?? null,
        );
        if (mismatch === "reference") {
          dispatchStudy({ type: "clear-reference" });
          setTrajectoryOverlays({ trails: [], displacements: [] });
          setNotice({ message: "Reference frame changed · cleared", tone: "status" });
          return;
        }
        if (mismatch === "current") {
          reloadChangedDataset();
          return;
        }
        setTrajectoryOverlays(trajectoryOverlaysFromPositions(
          positions,
          selections,
          study.tracking,
          displayedFrameIndex,
          study.reference?.index ?? null,
        ));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DatasetChangedError) {
          reloadChangedDataset();
          return;
        }
        dispatchStudy({ type: "set-tracking", mode: "off" });
        setTrajectoryOverlays({ trails: [], displacements: [] });
        setNotice({ message: `Tracking unavailable · ${message(error)}`, tone: "error" });
      });
    return () => controller.abort();
  }, [
    displayedFrameIndex,
    displayedFrameMark,
    manifest,
    reloadChangedDataset,
    selectedAtoms,
    study.reference,
    study.tracking,
    trackingAvailable,
  ]);

  const showPropertyPlot = useCallback((series: DisplaySeries) => {
    if (!manifest || series.values.length !== manifest.frame_count) return;
    const requestId = studyRequest.current + 1;
    studyRequest.current = requestId;
    studyController.current?.abort();
    studyController.current = null;
    rdfController.current?.abort();
    rdfController.current = null;
    setRdfRunning(false);
    setRdfResult(null);
    setRdfContext(null);
    setPlaying(false);
    setPlaybackOptionsOpen(false);
    setMeasurementPlotOpen(false);
    setMeasurementSeries(null);
    dispatchStudy({
      type: "open-plot",
      plot: propertyPlotData(series, manifest.frame_count, requestId),
    });
  }, [manifest]);

  const comparePinnedMeasurements = useCallback(() => {
    if (!manifest || comparablePins.length < 2) return;
    const requestId = studyRequest.current + 1;
    studyRequest.current = requestId;
    studyController.current?.abort();
    const controller = new AbortController();
    studyController.current = controller;
    rdfController.current?.abort();
    rdfController.current = null;
    setRdfRunning(false);
    setRdfResult(null);
    setRdfContext(null);
    setPlaying(false);
    setMeasurementPlotOpen(false);
    setMeasurementSeries(null);
    const definitions = comparablePins.map((pin) => ({
      id: `pin-${pin.id}`,
      label: measurementSelectionTitle(manifest, pin.selections),
      selections: pin.selections,
      minimumImage: pin.minimumImage,
    }));
    dispatchStudy({
      type: "open-plot",
      plot: comparisonPlaceholder(definitions, manifest.frame_count, requestId),
    });
    void calculateMeasurementComparison({
      manifest,
      frameCount: manifest.frame_count,
      definitions,
      wrap: presentation.wrap,
      signal: controller.signal,
      loadFrame: (index, signal) => getFrame(
        index,
        signal,
        manifest.dataset_generation,
      ),
      onProgress: (progress) => {
        if (studyRequest.current !== requestId || controller.signal.aborted) return;
        dispatchStudy({
          type: "update-plot",
          plot: measurementComparisonPlotData(progress, requestId),
        });
      },
    })
      .then((comparison) => {
        if (studyRequest.current !== requestId || controller.signal.aborted) return;
        dispatchStudy({
          type: "update-plot",
          plot: measurementComparisonPlotData(comparison, requestId),
        });
      })
      .catch((error: unknown) => {
        if (studyRequest.current !== requestId || controller.signal.aborted) return;
        if (error instanceof DatasetChangedError) {
          reloadChangedDataset();
          return;
        }
        dispatchStudy({ type: "close-plot" });
        setNotice({ message: `Comparison unavailable · ${message(error)}`, tone: "error" });
      });
  }, [
    comparablePins,
    manifest,
    presentation.wrap,
    reloadChangedDataset,
  ]);

  const showRdfSetup = useCallback((view: "rdf" | "coordination") => {
    if (!analysisAvailable) {
      setNotice({
        message: "Pair analysis needs a trajectory with a full periodic cell.",
        tone: "status",
      });
      return;
    }
    setPlaying(false);
    setCommandOpen(false);
    setShortcutsOpen(false);
    setFigureSheetOpen(false);
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    setMeasurementPlotOpen(false);
    setMeasurementSeries(null);
    setRdfInitialView(view);
    setRdfSetupOpen(true);
  }, [analysisAvailable]);

  const runRdfSetup = useCallback((value: RdfSetupValue) => {
    if (!manifest) return;
    const requestId = studyRequest.current + 1;
    studyRequest.current = requestId;
    studyController.current?.abort();
    studyController.current = null;
    rdfController.current?.abort();
    const controller = new AbortController();
    rdfController.current = controller;
    const context = {
      requestId,
      referenceLabel: value.reference.label,
      targetLabel: value.target.label,
    };
    setRdfSetupOpen(false);
    setRdfInitialView(value.initialView);
    setRdfView(value.initialView);
    setRdfResult(null);
    setRdfContext(context);
    setRdfRunning(true);
    dispatchStudy({
      type: "open-plot",
      plot: rdfPlaceholder(value.initialView, context),
    });
    void runRdfAnalysis({
      datasetGeneration: manifest.dataset_generation ?? "",
      referenceIndices: value.reference.atomIndices,
      targetIndices: value.target.atomIndices,
      frameStart: value.frameStart,
      frameStop: value.frameStop,
      frameStep: value.frameStep,
      bins: value.bins,
      rMax: value.rMax,
    }, controller.signal)
      .then((result) => {
        if (studyRequest.current !== requestId || controller.signal.aborted) return;
        setRdfRunning(false);
        setRdfResult(result);
        dispatchStudy({
          type: "update-plot",
          plot: rdfPlotData(result, value.initialView, context),
        });
      })
      .catch((error: unknown) => {
        if (studyRequest.current !== requestId || controller.signal.aborted) return;
        setRdfRunning(false);
        setRdfResult(null);
        setRdfContext(null);
        dispatchStudy({ type: "close-plot" });
        if (error instanceof DatasetChangedError) {
          reloadChangedDataset();
          return;
        }
        setNotice({ message: `Pair analysis unavailable · ${message(error)}`, tone: "error" });
      });
  }, [manifest, reloadChangedDataset]);

  const selectRdfView = useCallback((view: "rdf" | "coordination") => {
    setRdfView(view);
    if (!rdfResult || !rdfContext) return;
    dispatchStudy({
      type: "update-plot",
      plot: rdfPlotData(rdfResult, view, rdfContext),
    });
  }, [rdfContext, rdfResult]);

  useEffect(() => () => {
    studyController.current?.abort();
    trackingController.current?.abort();
    rdfController.current?.abort();
  }, []);

  const showRender = useCallback(() => {
    if (!canRender || rendering) return;
    setCommandOpen(false);
    setShortcutsOpen(false);
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    void exportFigure({
      width: 2400,
      height: 1800,
      format: "png",
      dpi: 300,
      background: { kind: "solid", color: "#ffffff" },
      periodicContext: usesPeriodicFigureContext(presentation, pbc),
    });
  }, [canRender, exportFigure, pbc, presentation.mode, presentation.wrap, rendering]);

  const showFigureSheet = useCallback(() => {
    if (!canRender || rendering) return;
    setPlaying(false);
    setCommandOpen(false);
    setShortcutsOpen(false);
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    setFigureOutput((current) => ({
      ...current,
      periodicContext: usesPeriodicFigureContext(presentation, pbc),
    }));
    setFigureSheetOpen(true);
  }, [canRender, pbc, presentation, rendering]);

  const openSetting = useCallback((tab: WorkbenchTab, target: string) => {
    setCommandOpen(false);
    setSettingTarget(target);
    openWorkbench(tab, true);
  }, [openWorkbench]);

  const openFigureSetting = useCallback((target: string) => {
    setSettingTarget(target);
    showFigureSheet();
  }, [showFigureSheet]);

  useEffect(() => {
    if (!settingTarget) return;
    let frameRequest = 0;
    let clearTimer = 0;
    let attempts = 0;
    const reveal = () => {
      const target = document.querySelector<HTMLElement>(
        `[data-setting-id="${settingTarget}"]`,
      );
      if (!target) {
        attempts += 1;
        if (attempts < 6) frameRequest = requestAnimationFrame(reveal);
        else setSettingTarget((current) => current === settingTarget ? null : current);
        return;
      }
      if (target instanceof HTMLDetailsElement) target.open = true;
      target.closest<HTMLDetailsElement>("details")?.setAttribute("open", "");
      target.classList.add("is-search-target");
      target.scrollIntoView?.({ block: "center", behavior: "smooth" });
      const focusTarget = target.matches("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary")
        ? target
        : target.querySelector<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), summary",
        );
      requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
      clearTimer = window.setTimeout(() => {
        target.classList.remove("is-search-target");
        setSettingTarget((current) => current === settingTarget ? null : current);
      }, 1800);
    };
    frameRequest = requestAnimationFrame(reveal);
    return () => {
      cancelAnimationFrame(frameRequest);
      window.clearTimeout(clearTimer);
    };
  }, [figureSheetOpen, settingTarget, workbenchTab]);

  const exportConfiguredFigure = useCallback(() => {
    if (!canRender || rendering) return;
    setFigureSheetOpen(false);
    void exportFigure({
      ...cloneFigureOutput(figureOutput),
      transparent: figureOutput.background.kind === "transparent",
      annotations: cloneFigureAnnotations(figureAnnotations),
    });
  }, [
    canRender,
    exportFigure,
    figureAnnotations,
    figureOutput,
    rendering,
  ]);

  const currentFigureRecipe = useCallback((): FigureRecipe => {
    const scene = moleculeSceneRef.current;
    if (
      !manifest
      || !loadedFrame
      || loadedFrame.index !== frameIndex
      || (
        loadedFrame.data.header.coordinates === "unwrapped"
          ? "unwrapped"
          : "source"
      ) !== frameCoordinateMode
      || !scene
    ) {
      throw new Error("The current frame is not ready");
    }
    const source = figureSourceFromManifest(manifest);
    if (source.path.includes("pqviewer-upload-")) {
      throw new Error("Open the source from disk before saving a reusable recipe");
    }
    const key = loadedFrame.data.header.frame_key;
    if (!key) throw new Error("The current frame has no stable source key");
    return parseFigureRecipe({
      schema: "pqviewer.figure",
      schema_version: 1,
      source,
      frame: {
        index: loadedFrame.index,
        key,
        fingerprint: figureFrameFingerprint(manifest, loadedFrame.data),
      },
      scene: {
        presentation,
        selection: {
          atoms: cloneSelections(selectedAtoms),
          intent: selectionIntent,
          minimumImage,
        },
        vectors: {
          forceScale,
          velocityScale,
        },
      },
      camera: scene.captureCamera(),
      output: cloneFigureOutput(figureOutput),
      annotations: cloneFigureAnnotations(figureAnnotations),
    });
  }, [
    figureAnnotations,
    figureOutput,
    forceScale,
    frameIndex,
    loadedFrame,
    manifest,
    minimumImage,
    presentation,
    selectedAtoms,
    selectionIntent,
    velocityScale,
  ]);

  const saveFigureRecipe = useCallback(() => {
    if (hasStructureEdits) {
      setNotice({
        message: "Download and reopen the edited structure before saving a reproducible recipe",
        tone: "status",
      });
      return;
    }
    try {
      const recipe = currentFigureRecipe();
      downloadBlob(
        new Blob([stringifyFigureRecipe(recipe)], {
          type: "application/json;charset=utf-8",
        }),
        figureRecipeFileName(manifest?.name),
      );
      setNotice({ message: "Figure recipe saved", tone: "status" });
    } catch (error) {
      setNotice({ message: `Recipe unavailable · ${message(error)}`, tone: "error" });
    }
  }, [currentFigureRecipe, hasStructureEdits, manifest?.name]);

  const showRecipeOpen = useCallback(() => {
    if (!manifest || rendering) return;
    setCommandOpen(false);
    setShortcutsOpen(false);
    recipeInputRef.current?.click();
  }, [manifest, rendering]);

  const openFigureRecipeFile = useCallback(async (file: File) => {
    if (!manifest) return;
    try {
      if (file.size > MAX_FIGURE_RECIPE_BYTES) {
        throw new Error("Figure recipe is too large");
      }
      const recipe = parseFigureRecipeJson(await file.text());
      stageFigureRecipe(recipe, manifest);
    } catch (error) {
      const detail = message(error);
      setFigureBridgeError(detail);
      setNotice({ message: `Recipe unavailable · ${detail}`, tone: "error" });
    }
  }, [manifest, stageFigureRecipe]);

  const atomLabelsEnabled = figureAnnotations.some(
    (annotation) => annotation.kind === "atom-label",
  );
  const elementLegendEnabled = figureAnnotations.some(
    (annotation) => annotation.kind === "legend"
      && annotation.content === "elements",
  );
  const scaleBar = figureAnnotations.find(
    (annotation): annotation is Extract<FigureAnnotation, { kind: "scale-bar" }> => (
      annotation.kind === "scale-bar"
    ),
  ) ?? null;

  const setAtomLabelsEnabled = useCallback((enabled: boolean) => {
    setFigureAnnotations((current) => [
      ...current.filter((annotation) => annotation.kind !== "atom-label"),
      ...(enabled ? selectedAtoms.map((atom) => ({
        kind: "atom-label" as const,
        atom: { atom: atom.atom, image: [...atom.image] as CellOffset },
      })) : []),
    ]);
  }, [selectedAtoms]);

  const setElementLegendEnabled = useCallback((enabled: boolean) => {
    setFigureAnnotations((current) => [
      ...current.filter((annotation) => (
        annotation.kind !== "legend" || annotation.content !== "elements"
      )),
      ...(enabled ? [{
        kind: "legend" as const,
        content: "elements" as const,
        position: "top-right" as const,
      }] : []),
    ]);
  }, []);

  const setScaleBarEnabled = useCallback((enabled: boolean) => {
    setFigureAnnotations((current) => [
      ...current.filter((annotation) => annotation.kind !== "scale-bar"),
      ...(enabled ? [{
        kind: "scale-bar" as const,
        length: 5,
        unit: "angstrom" as const,
        position: "bottom-left" as const,
      }] : []),
    ]);
  }, []);

  const setScaleBarLength = useCallback((length: number) => {
    if (!Number.isFinite(length) || length <= 0) return;
    setFigureAnnotations((current) => current.map((annotation) => (
      annotation.kind === "scale-bar"
        ? { ...annotation, length }
        : annotation
    )));
  }, []);

  const updateFigureOutput = useCallback((change: Partial<FigureOutput>) => {
    setFigureOutput((current) => ({
      ...current,
      ...change,
      background: change.background ?? current.background,
    }));
    if (change.projection === "perspective") {
      setFigureAnnotations((current) => current.filter(
        (annotation) => annotation.kind !== "scale-bar",
      ));
    }
  }, []);

  useEffect(() => {
    if (!atomLabelsEnabled) return;
    setFigureAnnotations((current) => {
      const selected = new Map(selectedAtoms.map((atom) => [
        atomSelectionKey(atom),
        atom,
      ]));
      const retained = new Set<string>();
      const next = current.filter((annotation) => {
        if (annotation.kind !== "atom-label") return true;
        const key = atomSelectionKey(annotation.atom);
        if (!selected.has(key) || retained.has(key)) return false;
        retained.add(key);
        return true;
      });
      for (const atom of selectedAtoms) {
        const key = atomSelectionKey(atom);
        if (retained.has(key)) continue;
        next.push({
          kind: "atom-label",
          atom: { atom: atom.atom, image: [...atom.image] as CellOffset },
        });
      }
      return next;
    });
  }, [atomLabelsEnabled, selectedAtoms]);

  useEffect(() => {
    const bridge = {
      ready: canRender && !recipeApplying && !rendering && !figureBridgeError,
      error: figureBridgeError || null,
      export: async (overrides: FigureBridgeOverrides = {}) => {
        if (figureBridgeError) throw new Error(figureBridgeError);
        if (!canRender || recipeApplying) {
          throw new Error("The saved figure is not ready");
        }
        const background = overrides.transparent === undefined
          ? figureOutput.background
          : overrides.transparent
            ? { kind: "transparent" as const }
            : { kind: "solid" as const, color: "#ffffff" };
        await exportFigure({
          ...cloneFigureOutput(figureOutput),
          ...overrides,
          background,
          transparent: background.kind === "transparent",
          annotations: cloneFigureAnnotations(figureAnnotations),
        }, true);
      },
    };
    window.pqviewerFigure = bridge;
    return () => {
      if (window.pqviewerFigure === bridge) delete window.pqviewerFigure;
    };
  }, [
    canRender,
    exportFigure,
    figureAnnotations,
    figureBridgeError,
    figureOutput,
    recipeApplying,
    rendering,
  ]);

  const updatePresentation = useCallback((change: Partial<ScenePresentation>) => {
    if (change.mode === "polyhedra" && !capabilities?.polyhedra) {
      setNotice({
        message: `Polyhedra unavailable · ${capabilities?.polyhedraReason ?? POLYHEDRA_REQUIREMENT}`,
        tone: "status",
      });
      return;
    }
    setPresentation((current) => ({ ...current, ...change }));
    if (change.mode !== undefined) setProfile("custom");
  }, [capabilities]);

  const applySceneProfile = useCallback((
    selected: Exclude<SceneProfile, "auto" | "custom">,
  ) => {
    if (!capabilities) return;
    setPresentation((current) => selectedProfilePresentation(
      selected,
      current,
      cellAvailable,
      forceAvailable,
      canPlay,
      capabilities,
    ));
    setProfile(selected);
  }, [canPlay, capabilities, cellAvailable, forceAvailable]);

  const applyFrameDraft = useCallback((nextFrame: FrameData) => {
    const index = loadedFrame?.index ?? frameIndex;
    frameDrafts.current.set(frameDraftKey(frameCoordinateMode, index), nextFrame);
    setLoadedFrame({ index, data: nextFrame });
    setEditedFrames((current) => {
      const next = new Set(current);
      next.add(index);
      return next;
    });
  }, [frameCoordinateMode, frameIndex, loadedFrame?.index]);

  const editSelectedAtom = useCallback((
    atom: number,
    element: string,
    position: readonly number[],
  ) => {
    if (!manifest || !frame) return;
    try {
      const nextFrame = updateAtomPosition(frame, atom, position);
      const nextManifest = updateAtomElement(manifest, atom, element);
      applyFrameDraft(nextFrame);
      if (atomSymbol(manifest, atom) !== atomSymbol(nextManifest, atom)) {
        activeManifest.current = nextManifest;
        sceneTopologyRef.current = null;
        setSceneTopology(null);
        setManifest(nextManifest);
        setTopologyEdited(true);
        setSceneRevision((current) => current + 1);
      }
      setNotice({
        message: `${atomSymbol(nextManifest, atom)}${atom + 1} updated · local draft`,
        tone: "status",
      });
    } catch (error) {
      setNotice({ message: `Atom not updated · ${message(error)}`, tone: "error" });
      throw error;
    }
  }, [applyFrameDraft, frame, manifest]);

  const editCell = useCallback((
    values: readonly number[],
    axes: readonly boolean[],
    scaleAtoms: boolean,
  ) => {
    if (!frame) return;
    try {
      const nextFrame = updateCell(frame, values, axes, scaleAtoms);
      applyFrameDraft(nextFrame);
      setPresentation((current) => ({ ...current, cell: true }));
      setNotice({
        message: `Cell updated · ${scaleAtoms ? "fractional positions kept" : "Cartesian positions kept"}`,
        tone: "status",
      });
    } catch (error) {
      setNotice({ message: `Cell not updated · ${message(error)}`, tone: "error" });
      throw error;
    }
  }, [applyFrameDraft, frame]);

  const resetStructureEdits = useCallback(() => {
    const sourceManifest = originalManifest.current;
    if (!sourceManifest) return;
    frameDrafts.current.clear();
    setEditedFrames(new Set());
    setTopologyEdited(false);
    activeManifest.current = sourceManifest;
    sceneTopologyRef.current = null;
    setSceneTopology(null);
    setManifest(sourceManifest);
    setSceneRevision((current) => current + 1);
    void cache.current.get(frameIndex).then((data) => {
      setLoadedFrame({ index: frameIndex, data });
      setNotice({ message: "Local structure edits reset", tone: "status" });
    }).catch((error: unknown) => {
      setNotice({ message: `Could not reset edits · ${message(error)}`, tone: "error" });
    });
  }, [frameIndex]);

  const downloadStructure = useCallback(() => {
    if (!manifest || !frame) return;
    try {
      downloadBlob(
        new Blob([frameToExtxyz(manifest, frame)], { type: "chemical/x-xyz;charset=utf-8" }),
        structureFileName(manifest.name, displayedFrameIndex),
      );
      setNotice({ message: "Downloaded current structure", tone: "status" });
    } catch (error) {
      setNotice({ message: `Download unavailable · ${message(error)}`, tone: "error" });
    }
  }, [displayedFrameIndex, frame, manifest]);

  useEffect(() => {
    if (!manifest || !frame || !capabilities || profile !== "auto") return;
    const key = [
      manifest.name,
      manifest.topology.atom_count,
      capabilities.polyhedra ? "polyhedra" : "atoms",
    ].join(":");
    if (autoProfileKey.current === key) return;
    autoProfileKey.current = key;
    setPresentation((current) => selectedProfilePresentation(
      "auto",
      current,
      cellAvailable,
      forceAvailable,
      false,
      capabilities,
    ));
  }, [capabilities, cellAvailable, forceAvailable, frame, manifest, profile]);

  useEffect(() => {
    if (!playing || rendering || !manifest || manifest.frame_count < 2) {
      playbackClock.current = { key: "", requestTimeMs: null };
      return;
    }
    if (frameLoading || loadedFrame?.index !== frameIndex) return;
    const clockKey = [
      manifest.dataset_generation ?? manifest.name,
      playbackFps,
      playbackMode,
      playbackStride,
    ].join(":");
    if (playbackClock.current.key !== clockKey) {
      playbackClock.current = { key: clockKey, requestTimeMs: null };
    }
    const now = performance.now();
    const requestAnchor = playbackClock.current.requestTimeMs ?? now;
    const schedule = schedulePlaybackFrame(
      now,
      playbackClock.current.requestTimeMs,
      playbackFps,
    );
    let timer = 0;
    const commit = () => {
      const tick = runScheduledPlaybackTick(
        performance.now(),
        requestAnchor,
        playbackFps,
        frameIndex,
        manifest.frame_count,
        {
          mode: playbackMode,
          direction: playbackDirection,
          stride: playbackStride,
        },
        {
          onStep: (next) => {
            setFrameIndex(next.frameIndex);
            setPlaybackDirection(next.direction);
            if (!next.continuePlaying) setPlaying(false);
          },
          onPulse: () => setPlaybackPulse((value) => value + 1),
        },
      );
      if (!tick.committed) {
        timer = window.setTimeout(commit, playbackTimerDelay(tick.schedule.delayMs));
        return;
      }
      playbackClock.current.requestTimeMs = tick.schedule.requestTimeMs;
    };
    timer = window.setTimeout(commit, playbackTimerDelay(schedule.delayMs));
    return () => window.clearTimeout(timer);
  }, [
    frameIndex,
    frameLoading,
    loadedFrame?.index,
    manifest,
    playbackDirection,
    playbackFps,
    playbackMode,
    playbackPulse,
    playbackStride,
    playing,
    rendering,
  ]);

  const openSelectedFiles = useCallback(async (selected: File[]) => {
    if (selected.length === 0 || rendering) return;
    const request = openRequest.current + 1;
    openRequest.current = request;
    openController.current?.abort();
    const controller = new AbortController();
    openController.current = controller;
    setOpening(true);
    setNotice({ message: "Opening files…", tone: "status" });
    try {
      const value = await openFiles(selected, controller.signal);
      if (request !== openRequest.current) return;
      activateManifest(value);
      datasetChannel.current?.postMessage({
        datasetGeneration: value.dataset_generation,
      });
      setNotice({
        message: `Opened ${value.name} · ${frameCountLabel(value.frame_count)}`,
        tone: "status",
      });
    } catch (error) {
      if (request !== openRequest.current || controller.signal.aborted) return;
      setNotice({ message: message(error), tone: "error" });
    } finally {
      if (request === openRequest.current) {
        openController.current = null;
        setOpening(false);
      }
    }
  }, [activateManifest, rendering]);

  useEffect(() => () => openController.current?.abort(), []);

  useEffect(() => {
    if (!notice || notice.tone === "error" || opening || rendering) return;
    const timer = window.setTimeout(() => setNotice(null), noticeDurationMs(notice.message));
    return () => window.clearTimeout(timer);
  }, [notice, opening, rendering]);

  const dismissActive = useCallback((): boolean => {
    vimSequenceRef.current = { prefix: null, at: 0 };
    if (commandOpen) {
      setCommandOpen(false);
    } else if (shortcutsOpen) {
      setShortcutsOpen(false);
    } else if (rdfSetupOpen) {
      setRdfSetupOpen(false);
    } else if (figureSheetOpen) {
      setFigureSheetOpen(false);
    } else if (playbackOptionsOpen) {
      setPlaybackOptionsOpen(false);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(".timeline-options > summary")?.focus();
      });
    } else if (workbenchTab) {
      closeWorkbench(true);
    } else if (measurementPlotOpen) {
      closeMeasurementPlot(true);
    } else if (study.plot) {
      closeStudyPlot(true);
    } else if (selectedAtoms.length > 0) {
      setSelectedAtoms([]);
    } else {
      return false;
    }
    return true;
  }, [
    closeMeasurementPlot,
    closeStudyPlot,
    closeWorkbench,
    commandOpen,
    figureSheetOpen,
    measurementPlotOpen,
    rdfSetupOpen,
    playbackOptionsOpen,
    selectedAtoms.length,
    shortcutsOpen,
    study.plot,
    workbenchTab,
  ]);

  const runVimNavigation = useCallback((action: VimNavigationAction) => {
    if (action === "commands") {
      showCommands();
      return;
    }
    if (action === "first-frame") {
      setPlaying(false);
      setFrame(0);
      return;
    }
    if (action === "last-frame") {
      setPlaying(false);
      setFrame((manifest?.frame_count ?? 1) - 1);
      return;
    }
    const delta = {
      "next-frame": 1,
      "next-ten-frames": 10,
      "previous-frame": -1,
      "previous-ten-frames": -10,
    }[action];
    setPlaying(false);
    stepFrame(delta);
  }, [manifest?.frame_count, setFrame, showCommands, stepFrame]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      const primaryModifier = event.metaKey !== event.ctrlKey && !event.altKey;
      if (primaryModifier && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        showRender();
        return;
      }
      if (primaryModifier && !event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (!staticDemo) showOpen();
        return;
      }
      if (primaryModifier && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        showCommands();
        return;
      }
      if (rendering) return;
      if (vimMode && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === "[") {
        event.preventDefault();
        dismissActive();
        return;
      }
      if (event.key === "Escape") {
        if (dismissActive()) event.preventDefault();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextEditingTarget(target)) return;
      if (isActivationTarget(target) && (event.key === "Enter" || event.code === "Space")) return;
      if (event.key === "/") {
        event.preventDefault();
        if (!event.repeat) showCommands();
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        if (!event.repeat) showShortcuts();
        return;
      }
      if (commandOpen || shortcutsOpen) return;
      if (vimMode) {
        const now = performance.now();
        const activePrefix = now - vimSequenceRef.current.at <= 750
          ? vimSequenceRef.current.prefix
          : null;
        if (event.repeat && event.key === "g") {
          event.preventDefault();
          return;
        }
        const resolution = resolveVimNavigation(event.key, activePrefix);
        vimSequenceRef.current = { prefix: resolution.prefix, at: resolution.prefix ? now : 0 };
        if (resolution.prefix) {
          if (!event.repeat) event.preventDefault();
          return;
        }
        if (resolution.action) {
          event.preventDefault();
          runVimNavigation(resolution.action);
          return;
        }
      }
      if (event.key.toLowerCase() === "v" && capabilities && !event.repeat) {
        if (workbenchVisible && workbenchTab === "view") closeWorkbench(true);
        else openWorkbench("view", true);
      } else if (event.key.toLowerCase() === "e" && capabilities && !event.repeat) {
        if (workbenchVisible && workbenchTab === "edit") closeWorkbench(true);
        else {
          setEditTarget("cell");
          openWorkbench("edit", true);
        }
      } else if (event.key.toLowerCase() === "d" && !event.repeat) {
        setAppearance((current) => current === "dark" ? "light" : "dark");
      } else if (event.key.toLowerCase() === "w" && capabilities?.water && !event.repeat) {
        updatePresentation({ water: presentation.water === "hide" ? "show" : "hide" });
      } else if (event.key.toLowerCase() === "b" && !event.repeat) {
        updatePresentation({ mode: presentation.mode === "lines" ? "ball-stick" : "lines" });
      } else if (event.key.toLowerCase() === "c" && cellAvailable && !event.repeat) {
        updatePresentation({ cell: !presentation.cell });
      } else if (event.key.toLowerCase() === "f" && forceAvailable && !event.repeat) {
        updatePresentation({ forces: !presentation.forces });
      } else if (event.code === "Space" && !event.repeat) {
        event.preventDefault();
        if ((manifest?.frame_count ?? 0) > 1) setPlaying((value) => !value);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setPlaying(false);
        stepFrame(-(event.shiftKey ? 10 : 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        stepFrame(event.shiftKey ? 10 : 1);
      } else if (event.key === "Home" && !event.repeat) {
        event.preventDefault();
        setPlaying(false);
        setFrame(0);
      } else if (event.key === "End" && !event.repeat) {
        event.preventDefault();
        setPlaying(false);
        setFrame((manifest?.frame_count ?? 1) - 1);
      } else if (event.key.toLowerCase() === "m" && canPlay && !event.repeat) {
        event.preventDefault();
        toggleCurrentBookmark();
      } else if (event.key.toLowerCase() === "r" && !event.repeat) {
        event.preventDefault();
        setResetSignal((value) => value + 1);
      } else if (["1", "2", "3", "4"].includes(event.key) && !event.shiftKey && !event.repeat) {
        event.preventDefault();
        selectView(({ "1": "perspective", "2": "xy", "3": "xz", "4": "yz" } as const)[event.key as "1" | "2" | "3" | "4"]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    capabilities?.water,
    appearance,
    canPlay,
    cellAvailable,
    closeWorkbench,
    commandOpen,
    dismissActive,
    forceAvailable,
    manifest?.frame_count,
    openWorkbench,
    presentation,
    rendering,
    runVimNavigation,
    selectView,
    setFrame,
    shortcutsOpen,
    stepFrame,
    toggleCurrentBookmark,
    showCommands,
    showOpen,
    showRender,
    showShortcuts,
    updatePresentation,
    workbenchTab,
    workbenchVisible,
    vimMode,
  ]);

  const resolveCommandAction = useCallback((query: string): CommandAction | null => {
    const distance = parseWithinSelectionCommand(query);
    if (distance === null) return null;
    return {
      id: `select-within-${distance}`,
      label: `Select within ${formatNumber(distance)} Å of selection`,
      keywords: "nearby radius distance atoms",
      detail: selectedAtoms.length > 0 && selectionIndex ? "Run" : "Select atoms first",
      disabled: selectedAtoms.length === 0 || !selectionIndex,
      run: () => {
        selectWithinDistance(distance);
        setCommandOpen(false);
      },
    };
  }, [selectWithinDistance, selectedAtoms.length, selectionIndex]);

  const commands = useMemo<CommandAction[]>(() => {
    const run = (action: () => void) => () => {
      action();
      setCommandOpen(false);
    };
    const actions: CommandAction[] = [
      {
        id: "open",
        label: staticDemo ? "Open files in local PQViewer" : "Open files",
        keywords: "structure trajectory PQ ASE load",
        detail: staticDemo ? "Install locally" : shortcutLabels.open,
        disabled: staticDemo,
        run: run(showOpen),
      },
      { id: "play", label: playing ? "Pause trajectory" : "Play trajectory", keywords: "movie animation", detail: "Space", disabled: !canPlay, run: run(() => setPlaying((value) => !value)) },
      { id: "previous", label: "Previous frame", keywords: "back step", detail: "←", disabled: !canPlay || frameIndex === 0, run: run(() => { setPlaying(false); stepFrame(-1); }) },
      { id: "next", label: "Next frame", keywords: "forward step", detail: "→", disabled: !canPlay || frameIndex >= (manifest?.frame_count ?? 1) - 1, run: run(() => { setPlaying(false); stepFrame(1); }) },
      { id: "first", label: "First frame", keywords: "start beginning", detail: "Home", disabled: !canPlay || frameIndex === 0, run: run(() => { setPlaying(false); setFrame(0); }) },
      { id: "last", label: "Last frame", keywords: "end final", detail: "End", disabled: !canPlay || frameIndex >= (manifest?.frame_count ?? 1) - 1, run: run(() => { setPlaying(false); setFrame((manifest?.frame_count ?? 1) - 1); }) },
      {
        id: "frame-bookmark",
        label: currentBookmarked ? "Remove frame bookmark" : "Bookmark current frame",
        keywords: "trajectory mark remember frame",
        detail: "M",
        disabled: !displayedFrameMark,
        run: run(toggleCurrentBookmark),
      },
      {
        id: "frame-reference",
        label: "Set current frame as reference",
        keywords: "trajectory reference displacement compare",
        disabled: !displayedFrameMark,
        run: run(setCurrentReference),
      },
      ...(study.reference ? [{
        id: "frame-reference-go",
        label: "Go to reference frame",
        keywords: "trajectory reference jump",
        detail: `Frame ${study.reference.index + 1}`,
        run: run(() => {
          setPlaying(false);
          setFrame(study.reference!.index);
        }),
      }, {
        id: "frame-reference-clear",
        label: "Clear reference frame",
        keywords: "trajectory reference displacement",
        run: run(() => dispatchStudy({ type: "clear-reference" })),
      }] : []),
      {
        id: "track-trail",
        label: study.tracking === "trail" ? "Hide selected-atom trails" : "Track selected atoms",
        keywords: "trajectory trail path motion history",
        disabled: !trackingAvailable,
        run: run(() => setTrackingMode("trail")),
      },
      {
        id: "track-displacement",
        label: study.tracking === "displacement" ? "Hide displacement vectors" : "Show displacement from reference",
        keywords: "trajectory movement vector reference atoms",
        detail: study.reference ? frameMarkLabel(study.reference) : "Set a reference first",
        disabled: !trackingAvailable || !study.reference,
        run: run(() => setTrackingMode("displacement")),
      },
      ...(comparablePins.length >= 2 ? [{
        id: "measurement-compare",
        label: "Compare pinned measurements",
        keywords: "trajectory plot distance angle dihedral lines",
        detail: `${comparablePins.length} lines`,
        run: run(comparePinnedMeasurements),
      }] : []),
      ...propertySeries.map((series) => ({
        id: `plot-property-${series.name}`,
        label: `Plot ${series.label}`,
        keywords: `trajectory property scalar ${series.name}`,
        detail: series.unit,
        run: run(() => showPropertyPlot(series)),
      })),
      {
        id: "analysis-rdf",
        label: "Pair distribution",
        keywords: "trajectory rdf radial distribution structure analysis",
        detail: analysisAvailable
          ? "PQAnalysis"
          : staticDemo ? "Available locally" : "Full periodic cell required",
        disabled: !analysisAvailable,
        run: run(() => showRdfSetup("rdf")),
      },
      {
        id: "analysis-coordination",
        label: "Coordination",
        keywords: "trajectory coordination number rdf structure analysis",
        detail: analysisAvailable
          ? "PQAnalysis"
          : staticDemo ? "Available locally" : "Full periodic cell required",
        disabled: !analysisAvailable,
        run: run(() => showRdfSetup("coordination")),
      },
      { id: "fit", label: "Fit structure", keywords: "reset camera center", detail: "R", disabled: !manifest?.frame_count, run: run(() => setResetSignal((value) => value + 1)) },
      ...(["perspective", "xy", "xz", "yz"] as ViewPreset[]).map((view, index) => ({
        id: `view-${view}`,
        label: view === "perspective" ? "Perspective view" : `${view.toUpperCase()} view`,
        keywords: "camera orientation axis",
        detail: view === viewPreset ? "Current" : String(index + 1),
        run: run(() => selectView(view)),
      })),
      { id: "view-tools", label: workbenchVisible && workbenchTab === "view" ? "Close View tools" : "Open View tools", keywords: "display representation appearance settings", breadcrumb: "Viewer tools", detail: "V", disabled: !capabilities, run: run(() => workbenchVisible && workbenchTab === "view" ? closeWorkbench(false) : openWorkbench("view")) },
      { id: "edit-tools", label: workbenchVisible && workbenchTab === "edit" ? "Close Edit tools" : "Open Edit tools", keywords: "structure atom element coordinates lattice vectors pbc cell", breadcrumb: "Viewer tools", detail: "E", disabled: !manifest || !frame, run: run(() => {
        if (workbenchVisible && workbenchTab === "edit") closeWorkbench(false);
        else {
          setEditTarget("cell");
          openWorkbench("edit");
        }
      }) },
      { id: "analyze-tools", label: workbenchVisible && workbenchTab === "analyze" ? "Close Analyze tools" : "Open Analyze tools", keywords: "selection inspect measure distance angle dihedral rdf coordination", breadcrumb: "Viewer tools", disabled: !manifest || !frame, run: run(() => workbenchVisible && workbenchTab === "analyze" ? closeWorkbench(false) : openWorkbench("analyze")) },
      { id: "setting-representation", label: "Representation", keywords: "view display style ball stick spacefill licorice lines ribbon protein polyhedra surface", breadcrumb: "View › Representation", disabled: !capabilities, run: run(() => openSetting("view", "view-representation")) },
      { id: "setting-atom-appearance", label: "Atom color and size", keywords: "atom atoms color colour element residue chain radius size bond thickness quality hydrogen", breadcrumb: "View › Atoms", disabled: !capabilities, run: run(() => openSetting("view", "view-atoms")) },
      { id: "setting-bonds", label: "Bond display", keywords: "bond bonds connectivity crossing across through boundary periodic unit cell clip clutter connection", breadcrumb: "View › Layers › Bonds", disabled: !capabilities, run: run(() => openSetting("view", "view-bonds")) },
      { id: "setting-periodic", label: "Periodic images and wrapping", keywords: "unit cell box periodic pbc wrap unwrap reconstruct molecule repeat replicate supercell mirror centered crossing boundary", breadcrumb: "View › Periodic cell", disabled: !cellAvailable, discoverableWhenDisabled: true, run: run(() => openSetting("view", "view-periodic")) },
      { id: "setting-theme", label: "Light or dark appearance", keywords: "dark mode light theme appearance contrast colors", breadcrumb: "View › Appearance", run: run(() => openSetting("view", "view-appearance")) },
      { id: "setting-cell", label: "Cell lengths and angles", keywords: "edit unit cell lattice parameters lengths angles alpha beta gamma pbc periodic axes", breadcrumb: "Edit › Cell", disabled: !manifest || !frame, run: run(() => {
        setEditTarget("cell");
        openSetting("edit", "edit-cell");
      }) },
      { id: "setting-cell-vectors", label: "Cell lattice vectors", keywords: "edit cell lattice vectors matrix ax ay az bx by bz cx cy cz", breadcrumb: "Edit › Cell › Vectors", disabled: !manifest || !frame, run: run(() => {
        setEditTarget("cell");
        openSetting("edit", "edit-cell-vectors");
      }) },
      { id: "setting-atom-edit", label: "Edit selected atom", keywords: "edit atom element identity coordinates position x y z", breadcrumb: "Edit › Atom", disabled: selectedAtoms.length !== 1, discoverableWhenDisabled: true, detail: selectedAtoms.length === 1 ? undefined : "Select one atom first", run: run(() => {
        setEditTarget("atom");
        openSetting("edit", "edit-atom");
      }) },
      { id: "setting-measurement", label: "Distance, angle, and dihedral", keywords: "analyze measure measurement distance bond length angle dihedral select two three four atoms", breadcrumb: "Analyze › Measurements", disabled: !manifest || !frame, run: run(() => openSetting("analyze", "analyze-measurement")) },
      { id: "setting-export-background", label: "Transparent figure background", keywords: "export transparent transparency alpha background image png publication", breadcrumb: "Export › File", disabled: !canRender, run: run(() => openFigureSetting("export-background")) },
      { id: "download-structure", label: "Download current structure", keywords: "save export extxyz atoms cell", detail: "EXTXYZ", disabled: !manifest || !frame, run: run(downloadStructure) },
      ...(hasStructureEdits ? [{
        id: "reset-structure-edits",
        label: "Reset local structure edits",
        keywords: "undo restore atom cell",
        run: run(resetStructureEdits),
      }] : []),
      { id: "appearance", label: appearance === "dark" ? "Use light appearance" : "Use dark appearance", keywords: "theme colors light dark", detail: "D", run: run(() => setAppearance((current) => current === "dark" ? "light" : "dark")) },
      ...([
        ["molecule", "Molecule"],
        ["protein", "Protein"],
        ["liquid", "Liquid"],
        ["crystal", "Crystal"],
        ["mof", "MOF"],
        ["trajectory", "Trajectory"],
      ] as const).map(([selected, label]) => ({
        id: `profile-${selected}`,
        label: `Preset · ${label}`,
        keywords: "representation scientific view style",
        detail: profile === selected ? "Current" : undefined,
        disabled: selected === "protein"
          ? !capabilities?.ribbon
          : selected === "liquid"
            ? !cellAvailable || !capabilities?.water
            : selected === "crystal" || selected === "mof"
              ? !cellAvailable
            : selected === "trajectory" ? !canPlay : false,
        run: run(() => applySceneProfile(selected)),
      })),
      { id: "export", label: "Quick export PNG", keywords: "render image png publication save", breadcrumb: "Export", detail: shortcutLabels.export, disabled: !canRender, run: run(showRender) },
      { id: "figure-options", label: "Export figure", keywords: "render image tiff dpi transparent labels legend scale publication", breadcrumb: "Export", disabled: !canRender, run: run(showFigureSheet) },
      { id: "figure-save-recipe", label: "Save figure recipe", keywords: "reproducible view camera scene json", detail: hasStructureEdits ? "Download edited structure first" : undefined, disabled: !canRender || hasStructureEdits, run: run(saveFigureRecipe) },
      { id: "figure-open-recipe", label: "Open figure recipe", keywords: "restore reproducible view camera scene json", disabled: !manifest, run: run(showRecipeOpen) },
      ...(["ball-stick", "spacefill", "licorice", "lines"] as RepresentationMode[]).map((mode) => ({
        id: `mode-${mode}`,
        label: `Representation · ${representationLabel(mode)}`,
        keywords: "style atoms bonds",
        detail: mode === presentation.mode ? "Current" : undefined,
        run: run(() => updatePresentation({ mode })),
      })),
      ...(capabilities?.ribbon ? [{
        id: "mode-ribbon",
        label: "Representation · Ribbon",
        keywords: "style protein backbone",
        detail: presentation.mode === "ribbon" ? "Current" : undefined,
        run: run(() => updatePresentation({ mode: "ribbon" })),
      }] : []),
      {
        id: "mode-polyhedra",
        label: "Representation · Polyhedra",
        keywords: "style crystal coordination octahedra tetrahedra polygons",
        detail: capabilities?.polyhedra
          ? presentation.mode === "polyhedra" ? "Current" : "Bond-derived"
          : capabilities?.polyhedraReason ?? POLYHEDRA_REQUIREMENT,
        disabled: !capabilities?.polyhedra,
        discoverableWhenDisabled: true,
        run: run(() => updatePresentation({ mode: "polyhedra" })),
      },
      {
        id: "mode-surface",
        label: "Representation · Surface",
        keywords: "style molecular surface solvent vdw density",
        detail: presentation.mode === "surface" ? "Current · interactive" : "Interactive",
        run: run(() => updatePresentation({ mode: "surface" })),
      },
      ...(capabilities?.water ? [{ id: "water", label: presentation.water === "hide" ? "Show water" : "Hide water", keywords: "solvent", detail: "W", run: run(() => updatePresentation({ water: presentation.water === "hide" ? "show" : "hide" })) }] : []),
      {
        id: "bonds",
        label: presentation.bonds ? "Hide bonds" : "Show bonds",
        keywords: "connections topology periodic clutter",
        disabled: presentation.mode === "spacefill"
          || presentation.mode === "ribbon"
          || presentation.mode === "polyhedra",
        run: run(() => updatePresentation({ bonds: !presentation.bonds })),
      },
      ...(cellAvailable ? [{ id: "cell", label: presentation.cell ? "Hide cell" : "Show cell", keywords: "box periodic pbc", detail: "C", run: run(() => updatePresentation({ cell: !presentation.cell })) }] : []),
      ...(forceAvailable ? [{ id: "forces", label: presentation.forces ? "Hide forces" : "Show forces", keywords: "vectors arrows", detail: "F", run: run(() => updatePresentation({ forces: !presentation.forces })) }] : []),
      ...(velocityAvailable ? [{ id: "velocities", label: presentation.velocities ? "Hide velocities" : "Show velocities", keywords: "vectors arrows motion speed", run: run(() => updatePresentation({ velocities: !presentation.velocities })) }] : []),
      ...(cellAvailable ? ([
        ["atom", "Atom coordinates"],
        ["molecule", "Molecule coordinates"],
        ["unwrapped", "Unwrapped coordinates"],
        ["none", "Source coordinates"],
      ] as const).map(([wrap, label]) => ({
        id: `wrap-${wrap}`,
        label,
        keywords: "periodic cell boundary coordinates",
        detail: presentation.wrap === wrap ? "Current" : undefined,
        run: run(() => updatePresentation({ wrap })),
      })) : []),
      ...(cellAvailable ? [{
        id: "cell-center-pq",
        label: "Center cell at PQ origin",
        keywords: "periodic centered cell origin zero",
        detail: sameCellOrigin(presentation.cellOrigin, [0, 0, 0]) ? "Current" : undefined,
        run: run(() => updatePresentation({ cellOrigin: [0, 0, 0] })),
      }, {
        id: "cell-center-structure",
        label: "Center cell on structure",
        keywords: "periodic centered centroid atoms",
        disabled: structureCellOrigin === null,
        detail: structureCellOrigin && sameCellOrigin(presentation.cellOrigin, structureCellOrigin)
          ? "Current"
          : undefined,
        run: run(() => {
          if (structureCellOrigin) updatePresentation({ cellOrigin: structureCellOrigin });
        }),
      }, {
        id: "cell-center-selection",
        label: "Center cell on selection",
        keywords: "periodic centered centroid selected atoms",
        disabled: selectionCellOrigin === null,
        detail: selectionCellOrigin && sameCellOrigin(presentation.cellOrigin, selectionCellOrigin)
          ? "Current"
          : selectedAtoms.length === 0 ? "Select atoms first" : undefined,
        run: run(() => {
          if (selectionCellOrigin) updatePresentation({ cellOrigin: selectionCellOrigin });
        }),
      }, ...(["a", "b", "c"] as const).map((axis, index) => ({
        id: `mirror-${axis}`,
        label: `Mirror ${axis}`,
        keywords: "periodic reflect flip cell axis",
        detail: presentation.mirror[index] ? "On" : "Off",
        run: run(() => updatePresentation({
          mirror: presentation.mirror.map((value, current) => (
            current === index ? !value : value
          )) as [boolean, boolean, boolean],
        })),
      })), {
        id: "repeat-3-3-1",
        label: "Repeat 3 × 3 × 1",
        keywords: "periodic supercell images replicate",
        disabled: !canUseRepeatCounts([3, 3, 1], pbc, manifest?.topology.atom_count ?? 0),
        run: run(() => updatePresentation({
          images: repeatImages([3, 3, 1], pbc),
        })),
      }, {
        id: "periodic-reset",
        label: "Reset periodic display",
        keywords: "periodic cell coordinates mirror repeat default",
        run: run(() => updatePresentation(defaultPeriodicPresentation())),
      }] : []),
      ...selectableElements.map((atomicNumber) => ({
        id: `select-element-${atomicNumber}`,
        label: `Select ${ELEMENT_NAMES[atomicNumber]}`,
        keywords: `${ELEMENT_SYMBOLS[atomicNumber]} element atoms`,
        detail: ELEMENT_SYMBOLS[atomicNumber],
        run: run(() => selectElement(atomicNumber)),
      })),
      ...(selectionContext?.waterAtoms.size ? [{
        id: "select-water",
        label: "Select water",
        keywords: "solvent molecule H2O atoms",
        run: run(selectWater),
      }] : []),
      ...(selectionAnchor ? ([
        ["atom", "Select anchor atom"],
        ["element", "Select anchor element"],
        ["molecule", "Select anchor molecule"],
        ["residue", "Select anchor residue"],
        ["component", "Select connected component"],
      ] as const).map(([scope, label]) => ({
        id: `select-scope-${scope}`,
        label,
        keywords: "selection scope expand atoms",
        disabled: (scope === "component" && !selectionIndex?.hasConnectivity),
        run: run(() => selectScope(scope)),
      })) : []),
      ...namedSelections.map((named, index) => ({
        id: `selection-saved-${index}`,
        label: `Recall selection · ${named.name}`,
        keywords: "saved named atoms",
        detail: atomCountLabel(named.selections.length),
        run: run(() => recallNamedSelection(named)),
      })),
      ...(selectionIntent === "measurement"
        && selectedAtoms.length >= 2
        && selectedAtoms.length <= 4 ? [{
        id: "pin-measurement",
        label: "Pin measurement",
        keywords: "selection distance angle dihedral keep",
        run: run(pinSelectedMeasurement),
      }] : []),
      ...(selectionIntent === "measurement"
        && cellAvailable
        && pbc.some(Boolean)
        && selectedAtoms.length >= 2
        && selectedAtoms.length <= 4 ? [{
        id: "measurement-geometry",
        label: minimumImage ? "Use displayed-image geometry" : "Use minimum-image geometry",
        keywords: "selection measurement periodic distance image",
        detail: minimumImage ? "Minimum image" : "Displayed images",
        run: run(() => setMinimumImage((current) => !current)),
      }] : []),
      ...pinnedMeasurements.map((pin) => ({
        id: `measurement-pinned-${pin.id}`,
        label: `Recall pinned measurement ${pin.id}`,
        keywords: "selection distance angle dihedral",
        detail: `${pin.selections.length} atoms`,
        run: run(() => restorePinnedMeasurement(pin)),
      })),
      ...(canPlotMeasurement ? [{
        id: "plot-measurement",
        label: measurementPlotOpen ? "Hide measurement plot" : "Plot measurement",
        keywords: "selection trajectory distance angle dihedral graph",
        run: run(() => measurementPlotOpen
          ? closeMeasurementPlot(false)
          : showMeasurementPlot()),
      }] : []),
      ...(selectedAtoms.length === 1 && selectedAtom !== null ? [{
        id: "inspect-selection",
        label: "Inspect selected atom",
        keywords: "selection properties coordinates",
        breadcrumb: "Analyze › Atom",
        run: run(() => openWorkbench("analyze")),
      }] : []),
      ...(selectedAtoms.length > 0 ? [{
        id: "clear-selection",
        label: "Clear atom selection",
        keywords: "deselect atoms measurement",
        detail: "Esc",
        run: run(() => setSelectedAtoms([])),
      }] : []),
      { id: "shortcuts", label: "Keyboard shortcuts", keywords: "help keys vim", detail: "?", run: run(showShortcuts) },
      { id: "vim", label: vimMode ? "Disable Vim navigation" : "Enable Vim navigation", keywords: "keyboard linux hjkl", detail: vimMode ? "On" : "Off", run: run(() => setVimMode((value) => !value)) },
    ];
    return actions.map((action) => ({
      ...action,
      run: () => {
        action.run();
        setRecentCommandIds((current) => [action.id, ...current.filter((id) => id !== action.id)].slice(0, 8));
      },
    }));
  }, [
    appearance,
    applySceneProfile,
    canPlay,
    canPlotMeasurement,
    canRender,
    analysisAvailable,
    capabilities,
    cellAvailable,
    closeMeasurementPlot,
    closeWorkbench,
    comparablePins,
    comparePinnedMeasurements,
    currentBookmarked,
    displayedFrameMark,
    downloadStructure,
    frame,
    forceAvailable,
    frameIndex,
    hasStructureEdits,
    manifest,
    measurementPlotOpen,
    minimumImage,
    namedSelections,
    openFigureSetting,
    openSetting,
    openWorkbench,
    pinSelectedMeasurement,
    playing,
    pinnedMeasurements,
    pbc,
    profile,
    presentation,
    propertySeries,
    recallNamedSelection,
    restorePinnedMeasurement,
    resetStructureEdits,
    selectView,
    selectElement,
    selectScope,
    selectWater,
    selectableElements,
    selectionAnchor,
    selectionContext,
    selectionIndex,
    selectionIntent,
    selectionCellOrigin,
    setFrame,
    shortcutLabels,
    showOpen,
    showPropertyPlot,
    showRdfSetup,
    saveFigureRecipe,
    showFigureSheet,
    showMeasurementPlot,
    showRecipeOpen,
    showRender,
    showShortcuts,
    stepFrame,
    study.reference,
    study.tracking,
    setCurrentReference,
    setTrackingMode,
    toggleCurrentBookmark,
    trackingAvailable,
    updatePresentation,
    velocityAvailable,
    viewPreset,
    vimMode,
    workbenchTab,
    workbenchVisible,
    selectedAtom,
    selectedAtoms.length,
    structureCellOrigin,
  ]);
  const commandContextIds = useMemo(() => [
    ...(selectedAtoms.length === 1 && selectedAtom !== null ? ["inspect-selection", "clear-selection"] : []),
    ...(selectionAnchor ? ["select-scope-element", "select-scope-molecule"] : []),
    ...(selectionIntent === "measurement"
      && selectedAtoms.length >= 2
      && selectedAtoms.length <= 4 ? ["pin-measurement"] : []),
    ...(canPlotMeasurement ? ["plot-measurement"] : []),
    ...(displayedFrameMark ? ["frame-bookmark", "frame-reference"] : []),
    ...(trackingAvailable ? ["track-trail"] : []),
    ...(study.reference && trackingAvailable ? ["track-displacement"] : []),
    ...(comparablePins.length >= 2 ? ["measurement-compare"] : []),
    ...(analysisAvailable ? ["analysis-rdf"] : []),
    ...(canPlay ? ["play", "previous", "next"] : []),
    "fit",
    "view-tools",
    "edit-tools",
    "analyze-tools",
    "figure-options",
  ], [
    canPlay,
    canPlotMeasurement,
    analysisAvailable,
    comparablePins.length,
    displayedFrameMark,
    selectedAtom,
    selectedAtoms.length,
    selectionAnchor,
    selectionIntent,
    study.reference,
    trackingAvailable,
  ]);
  const workspaceClass = [
    "workspace",
    workbenchVisible ? "workbench-open" : "workbench-closed",
    workbenchExpanded ? "workbench-expanded" : "",
    rendering ? "is-rendering" : "",
    canPlay ? "timeline-present" : "timeline-absent",
    selectedAtoms.length > 0 ? "selection-present" : "",
    figureSheetOpen ? "figure-sheet-open" : "",
    measurementPlotOpen || study.plot ? "measurement-plot-open" : "",
    playbackOptionsOpen ? "playback-options-open" : "",
  ].filter(Boolean).join(" ");
  return (
    <main
      className="app-shell"
      onDragEnter={(event) => {
        event.preventDefault();
        if (rendering || staticDemo) return;
        dragDepth.current += 1;
        setDropActive(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDropActive(false);
        if (rendering || staticDemo) return;
        void openSelectedFiles([...event.dataTransfer.files]);
      }}
    >
      <input
        ref={fileInputRef}
        className="sr-only file-input"
        type="file"
        tabIndex={-1}
        disabled={rendering}
        multiple
        onChange={(event) => {
          if (rendering) return;
          void openSelectedFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={recipeInputRef}
        className="sr-only file-input"
        type="file"
        accept=".pqfigure.json,.pqv.json,application/json"
        tabIndex={-1}
        disabled={rendering}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file && !rendering) void openFigureRecipeFile(file);
          event.currentTarget.value = "";
        }}
      />
      <div className={workspaceClass} aria-busy={loadState === "loading" || frameLoading || opening || rendering}>
        <header className="topbar">
          <div className="identity" aria-label="Current structure">
            <img className="identity-mark" src={`${import.meta.env.BASE_URL}pq-logo.png`} alt="" />
            <div>
              <strong>PQViewer</strong>
              <span title={manifest?.name || "Molecular trajectory"}>
                {manifest?.name || "Molecular trajectory"}
              </span>
            </div>
          </div>
          <div className="topbar-tools">
            <button
              className="open-button"
              type="button"
              disabled={rendering || staticDemo}
              aria-keyshortcuts="Meta+O Control+O"
              title={staticDemo ? "Open local files with the installed Python viewer" : undefined}
              onClick={showOpen}
            ><Icon name="folder" />Open</button>
            <button
              className="command-button"
              type="button"
              aria-label="Search atoms, settings, and commands"
              aria-keyshortcuts="Meta+K Control+K"
              aria-haspopup="dialog"
              aria-expanded={commandOpen}
              disabled={rendering}
              title={`Search atoms, settings, and commands · ${shortcutLabels.commands}`}
              onClick={showCommands}
            ><Icon name="search" /><span>Search</span><kbd>{shortcutLabels.commands}</kbd></button>
            <nav className="task-navigation" aria-label="Viewer tools">
              <button
                ref={viewButtonRef}
                className="task-button"
                type="button"
                aria-controls="workbench"
                aria-expanded={workbenchVisible && workbenchTab === "view"}
                disabled={rendering || !capabilities}
                onClick={() => workbenchVisible && workbenchTab === "view"
                  ? closeWorkbench(false)
                  : openWorkbench("view", true)}
              >View</button>
              <button
                ref={editButtonRef}
                className="task-button"
                type="button"
                aria-controls="workbench"
                aria-expanded={workbenchVisible && workbenchTab === "edit"}
                disabled={rendering || !capabilities}
                onClick={() => {
                  if (workbenchVisible && workbenchTab === "edit") closeWorkbench(false);
                  else {
                    setEditTarget("cell");
                    openWorkbench("edit", true);
                  }
                }}
              >Edit</button>
              <button
                ref={analyzeButtonRef}
                className="task-button"
                type="button"
                aria-controls="workbench"
                aria-expanded={workbenchVisible && workbenchTab === "analyze"}
                disabled={rendering || !capabilities}
                onClick={() => workbenchVisible && workbenchTab === "analyze"
                  ? closeWorkbench(false)
                  : openWorkbench("analyze", true)}
              >Analyze</button>
            </nav>
            <button
              className="tools-button"
              type="button"
              aria-label="Open viewer tools"
              aria-controls="workbench"
              aria-expanded={workbenchVisible}
              disabled={rendering || !capabilities}
              onClick={() => workbenchVisible ? closeWorkbench(false) : openWorkbench("view", true)}
            ><Icon name="sliders" /><span>Tools</span></button>
            <button
              ref={exportButtonRef}
              className="render-button export-button"
              type="button"
              aria-label="Export figure"
              aria-controls="figure-sheet"
              aria-expanded={figureSheetOpen}
              aria-haspopup="dialog"
              disabled={!canRender || rendering}
              aria-keyshortcuts="Meta+Shift+S Control+Shift+S"
              onClick={() => figureSheetOpen ? setFigureSheetOpen(false) : showFigureSheet()}
            ><Icon name="image" />{rendering ? "Exporting…" : "Export"}</button>
            <button
              className="help-button"
              type="button"
              aria-label="Help and keyboard shortcuts"
              aria-keyshortcuts="?"
              disabled={rendering}
              onClick={showShortcuts}
            ><span>Help</span><strong aria-hidden="true">?</strong></button>
          </div>
        </header>

        {manifest && manifest.frame_count > 0 && capabilities && (
          <CanvasControls
            busy={rendering}
            viewPreset={viewPreset}
            onFit={() => setResetSignal((value) => value + 1)}
            onView={selectView}
          />
        )}

        {manifest && manifest.frame_count > 0 ? (
          <MoleculeScene
            key={sceneRevision}
            ref={moleculeSceneRef}
            manifest={manifest}
            frame={frame}
            preparedTopology={
              sceneTopology?.manifest === manifest
                ? sceneTopology.value
                : null
            }
            presentation={presentation}
            selectedAtoms={selectedAtoms}
            resetSignal={resetSignal}
            viewPreset={viewPreset}
            viewSignal={viewSignal}
            forceScale={forceScale}
            velocityScale={velocityScale}
            trajectoryOverlays={trajectoryOverlays}
            appearance={appearance}
            onSelect={selectAtom}
            onSelectMany={selectManyAtoms}
            onSceneInfo={setSceneInfo}
            onSelectionContext={setSelectionContext}
          />
        ) : (
          <div className="canvas-field" />
        )}

        {manifest
          && manifest.frame_count > 0
          && !canvasHintDismissed
          && selectedAtoms.length === 0
          && !workbenchVisible
          && !commandOpen
          && !figureSheetOpen
          && (
          <div className="canvas-hint" role="status" aria-label="Viewer controls">
            <span><strong>Drag</strong> to rotate</span>
            <span><strong>Click</strong> an atom to inspect</span>
            <span><strong>Shift-click</strong> to measure</span>
            <button type="button" aria-label="Dismiss viewer hint" onClick={() => setCanvasHintDismissed(true)}>
              <Icon name="close" />
            </button>
          </div>
        )}

        {manifest && capabilities && <aside
          ref={workbenchRef}
          className={`workbench${workbenchExpanded ? " is-expanded" : ""}`}
          id="workbench"
          aria-labelledby="workbench-title"
          hidden={!workbenchVisible}
          tabIndex={-1}
        >
          <div className="workbench-heading">
            <div className="workbench-heading-copy">
              <strong id="workbench-title">{
                workbenchTab === "view"
                  ? "View"
                  : workbenchTab === "edit"
                    ? editTarget === "atom" && selectedAtoms.length === 1 && selectedAtom !== null
                      ? `Edit ${atomSymbol(manifest, selectedAtom)} · ${selectedAtom + 1}`
                      : "Edit structure"
                    : "Analyze"
              }</strong>
              {workbenchTab === "edit" && (
                <span>{hasStructureEdits ? "Local draft · included in export" : `${manifest.topology.atom_count.toLocaleString()} atoms · frame ${displayedFrameIndex + 1}`}</span>
              )}
              {workbenchTab === "view" && (
                <span>{representationLabel(presentation.mode)} · interactive scene</span>
              )}
              {workbenchTab === "analyze" && (
                <span>{selectedAtoms.length === 0
                  ? "Selection and trajectory tools"
                  : `${selectedAtoms.length.toLocaleString()} selected · ${selectionFormula || "selection"}`}</span>
              )}
            </div>
            <div className="workbench-heading-actions">
              <button
                className="workbench-expand-button"
                type="button"
                aria-label={workbenchExpanded ? "Collapse tools" : "Expand tools"}
                aria-expanded={workbenchExpanded}
                onClick={() => setWorkbenchExpanded((current) => !current)}
              ><Icon name="next" /></button>
              <button className="icon-button" type="button" disabled={rendering} onClick={() => {
                closeWorkbench(true);
              }} aria-label="Close"><Icon name="close" /></button>
            </div>
          </div>
          <div className="workbench-tabs" role="tablist" aria-label="Viewer inspector">
            <button
              type="button"
              role="tab"
              className={workbenchTab === "view" ? "is-active" : ""}
              aria-selected={workbenchTab === "view"}
              onClick={() => setWorkbenchTab("view")}
            >View</button>
            <button
              type="button"
              role="tab"
              className={workbenchTab === "edit" ? "is-active" : ""}
              aria-selected={workbenchTab === "edit"}
              onClick={() => {
                if (selectedAtoms.length !== 1) setEditTarget("cell");
                setWorkbenchTab("edit");
              }}
            >Edit</button>
            <button
              type="button"
              role="tab"
              className={workbenchTab === "analyze" ? "is-active" : ""}
              aria-selected={workbenchTab === "analyze"}
              onClick={() => setWorkbenchTab("analyze")}
            >Analyze</button>
          </div>
          <div className="workbench-body">
            {workbenchTab === "view" && <ScenePanel
              presentation={presentation}
              capabilities={capabilities}
              appearance={appearance}
              cellAvailable={cellAvailable}
              forceAvailable={forceAvailable}
              velocityAvailable={velocityAvailable}
              pbc={pbc}
              atomCount={manifest.topology.atom_count}
              structureCellOrigin={structureCellOrigin}
              selectionCellOrigin={selectionCellOrigin}
              forceScale={forceScale}
              velocityScale={velocityScale}
              onPresentation={updatePresentation}
              onAppearance={setAppearance}
              onForceScale={setForceScale}
              onVelocityScale={setVelocityScale}
            />}
            {workbenchTab === "edit" && <div className="edit-panel">
              <div className="edit-target-options" role="group" aria-label="Edit target">
                <button
                  type="button"
                  className={editTarget === "cell" ? "is-active" : ""}
                  aria-pressed={editTarget === "cell"}
                  onClick={() => setEditTarget("cell")}
                >Cell + structure</button>
                <button
                  type="button"
                  className={editTarget === "atom" ? "is-active" : ""}
                  aria-pressed={editTarget === "atom"}
                  disabled={selectedAtoms.length !== 1}
                  title={selectedAtoms.length === 1 ? "Edit the selected atom" : "Select one atom first"}
                  onClick={() => setEditTarget("atom")}
                >Selected atom</button>
              </div>
              {editTarget === "cell" && <StructurePanel
                manifest={manifest}
                frame={frame}
                frameIndex={displayedFrameIndex}
                pbc={pbc}
                editedFrame={editedFrames.has(displayedFrameIndex)}
                topologyEdited={topologyEdited}
                revealCellMode={settingTarget === "edit-cell-vectors" ? "vectors" : undefined}
                onCellEdit={editCell}
                onDownload={downloadStructure}
                onReset={resetStructureEdits}
              />}
              {editTarget === "atom" && selectedAtoms.length === 1 && <div data-setting-id="edit-atom">
                <Inspector
                  manifest={manifest}
                  frame={frame}
                  selectedAtom={selectedAtom}
                  selectedPosition={selectedPosition(activeSelectionPositions, 0)}
                  cellAvailable={cellAvailable}
                  editedFrame={editedFrames.has(displayedFrameIndex)}
                  topologyEdited={topologyEdited}
                  editable
                  onEdit={editSelectedAtom}
                />
              </div>}
            </div>}
            {workbenchTab === "analyze" && selectedAtoms.length === 1 && <Inspector
              manifest={manifest}
              frame={frame}
              selectedAtom={selectedAtom}
              selectedPosition={selectedPosition(activeSelectionPositions, 0)}
              cellAvailable={cellAvailable}
              editedFrame={editedFrames.has(displayedFrameIndex)}
              topologyEdited={topologyEdited}
              editable={false}
              onEdit={editSelectedAtom}
              onRequestEdit={() => {
                setEditTarget("atom");
                setWorkbenchTab("edit");
              }}
            />}
            {workbenchTab === "analyze" && selectedAtoms.length !== 1 && <AnalyzePanel
              selectedCount={selectedAtoms.length}
              selectionFormula={selectionFormula}
              summary={selectionSummary}
              uniqueAtoms={new Set(selectedAtoms.map(({ atom }) => atom)).size}
              canPlot={canPlotMeasurement}
              plotOpen={measurementPlotOpen}
              canPin={selectionIntent === "measurement" && selectedAtoms.length >= 2 && selectedAtoms.length <= 4}
              analysisAvailable={analysisAvailable}
              staticDemo={staticDemo}
              onPlot={() => measurementPlotOpen ? closeMeasurementPlot(false) : showMeasurementPlot()}
              onPin={pinSelectedMeasurement}
              onRdf={() => showRdfSetup("rdf")}
              onCoordination={() => showRdfSetup("coordination")}
              onClear={() => setSelectedAtoms([])}
            />}
          </div>
        </aside>}

        {manifest && pinnedMeasurements.length > 0 && selectionIndex && (
          <PinnedMeasurements
            manifest={manifest}
            pins={pinnedMeasurements}
            index={selectionIndex}
            cell={selectionContext?.cell ?? null}
            pbc={pbc}
            activeId={selectionIntent === "measurement"
              ? pinnedMeasurements.find((pin) => (
                  pin.minimumImage === minimumImage
                  && sameSelectionList(pin.selections, selectedAtoms)
                ))?.id ?? null
              : null}
            onRestore={restorePinnedMeasurement}
            onRemove={(id) => setPinnedMeasurements((current) => current.filter((pin) => pin.id !== id))}
            canCompare={comparablePins.length >= 2}
            onCompare={comparePinnedMeasurements}
          />
        )}

        {manifest && selectedAtoms.length > 0 && !rdfSetupOpen && (
          <SelectionBar
            manifest={manifest}
            selectedAtoms={selectedAtoms}
            displayedPositions={activeSelectionPositions}
            cell={selectionContext?.cell ?? null}
            pbc={pbc}
            selectionFormula={selectionFormula}
            namedSelections={namedSelections}
            selectionAnchor={selectionAnchor}
            connectivityAvailable={Boolean(selectionIndex?.hasConnectivity)}
            minimumImage={minimumImage}
            measurementEnabled={selectionIntent === "measurement"}
            canPlot={canPlotMeasurement}
            plotOpen={measurementPlotOpen}
            trackingAvailable={trackingAvailable}
            trackingMode={study.tracking}
            analysisAvailable={analysisAvailable}
            onMinimumImage={() => setMinimumImage((current) => !current)}
            onPlot={() => measurementPlotOpen
              ? closeMeasurementPlot(false)
              : showMeasurementPlot()}
            onClear={() => {
              setSelectedAtoms([]);
              setSelectionIntent("measurement");
              setSelectionAnchor(null);
              closeMeasurementPlot(false);
            }}
            onScope={selectScope}
            onWithin={selectWithinDistance}
            onSave={saveNamedSelection}
            onRecall={recallNamedSelection}
            onRemoveSaved={removeNamedSelection}
            onPin={pinSelectedMeasurement}
            onTracking={setTrackingMode}
            onAnalyze={() => showRdfSetup("rdf")}
            onDetails={() => workbenchVisible && workbenchTab === "analyze"
              ? closeWorkbench(false)
              : openWorkbench("analyze", true)}
            onSummary={() => workbenchVisible && workbenchTab === "analyze"
              ? closeWorkbench(false)
              : openWorkbench("analyze", true)}
          />
        )}

        {manifest && measurementPlotOpen && canPlotMeasurement && (
          <MeasurementPlot
            title={measurementSeries?.title ?? measurementSelectionTitle(manifest, selectedAtoms)}
            unit={measurementUnitLabel(
              measurementSeries?.unit ?? (selectedAtoms.length === 2 ? "angstrom" : "degree"),
            )}
            axisLabel={measurementSeries?.axis.label ?? "Frame"}
            axisUnit={measurementSeries?.axis.unit}
            xValues={measurementSeries?.xValues ?? plotFrameAxis}
            values={measurementSeries?.values ?? emptyMeasurementValues}
            loadedCount={measurementSeries?.loadedCount ?? 0}
            complete={measurementSeries?.complete ?? false}
            currentFrame={displayedFrameIndex}
            onFrame={(index) => {
              setPlaying(false);
              setFrame(index);
            }}
            onExportCsv={() => {
              if (!measurementSeries?.complete) return;
              downloadBlob(
                new Blob([measurementSeriesCsv(measurementSeries)], { type: "text/csv;charset=utf-8" }),
                measurementFileName(manifest.name, measurementSeries.kind, "csv"),
              );
            }}
            onExportSvg={() => {
              if (!measurementSeries?.complete) return;
              downloadBlob(
                new Blob([measurementSeriesSvg(measurementSeries)], { type: "image/svg+xml;charset=utf-8" }),
                measurementFileName(manifest.name, measurementSeries.kind, "svg"),
              );
            }}
            onExportPdf={() => {
              if (!measurementSeries?.complete) return;
              const pdf = measurementSeriesPdf(measurementSeries);
              const bytes = pdf.buffer.slice(
                pdf.byteOffset,
                pdf.byteOffset + pdf.byteLength,
              ) as ArrayBuffer;
              downloadBlob(
                new Blob([bytes], { type: "application/pdf" }),
                measurementFileName(manifest.name, measurementSeries.kind, "pdf"),
              );
            }}
          />
        )}

        {manifest && study.plot && (
          <PlotShelf
            plot={study.plot}
            currentFrame={displayedFrameIndex}
            onFrame={study.plot.frameIndices ? (index) => {
              setPlaying(false);
              setFrame(index);
            } : undefined}
            onRestoreLine={(line) => {
              if (!line.selection) return;
              if (line.minimumImage !== undefined) setMinimumImage(line.minimumImage);
              applyScientificSelection(line.selection, undefined, "measurement");
            }}
            headerActions={study.plot.kind === "rdf" ? (
              <div className="rdf-view-toggle" role="group" aria-label="Pair analysis view">
                <button
                  type="button"
                  className={rdfView === "rdf" ? "is-active" : ""}
                  aria-pressed={rdfView === "rdf"}
                  disabled={rdfRunning}
                  onClick={() => selectRdfView("rdf")}
                >g(r)</button>
                <button
                  type="button"
                  className={rdfView === "coordination" ? "is-active" : ""}
                  aria-pressed={rdfView === "coordination"}
                  disabled={rdfRunning}
                  onClick={() => selectRdfView("coordination")}
                >N(r)</button>
              </div>
            ) : undefined}
            onClose={() => closeStudyPlot(false)}
            onExportCsv={() => {
              if (!study.plot?.complete) return;
              downloadBlob(
                new Blob([plotShelfCsv(study.plot)], { type: "text/csv;charset=utf-8" }),
                plotFileName(manifest.name, study.plot, "csv"),
              );
            }}
            onExportSvg={() => {
              if (!study.plot?.complete) return;
              downloadBlob(
                new Blob([plotShelfSvg(study.plot)], { type: "image/svg+xml;charset=utf-8" }),
                plotFileName(manifest.name, study.plot, "svg"),
              );
            }}
            onExportPdf={() => {
              if (!study.plot?.complete) return;
              const pdf = plotShelfPdf(study.plot);
              const bytes = pdf.buffer.slice(
                pdf.byteOffset,
                pdf.byteOffset + pdf.byteLength,
              ) as ArrayBuffer;
              downloadBlob(
                new Blob([bytes], { type: "application/pdf" }),
                plotFileName(manifest.name, study.plot, "pdf"),
              );
            }}
          />
        )}

        {manifest && manifest.frame_count > 1 && (
          <Timeline
            busy={rendering}
            frameCount={manifest.frame_count}
            frameIndex={frameIndex}
            displayedFrameIndex={displayedFrameIndex}
            playing={playing}
            canPlay={canPlay}
            frameError={frameError}
            frame={frame}
            fps={playbackFps}
            stride={playbackStride}
            mode={playbackMode}
            optionsOpen={playbackOptionsOpen}
            bookmarks={study.bookmarks}
            reference={study.reference}
            currentBookmarked={currentBookmarked}
            propertySeries={propertySeries}
            analysisAvailable={analysisAvailable}
            trackingAvailable={trackingAvailable}
            trackingMode={study.tracking}
            onFrame={(index) => {
              setPlaying(false);
              setFrame(index);
            }}
            onPlay={() => canPlay && setPlaying((value) => !value)}
            onFps={setPlaybackFps}
            onStride={setPlaybackStride}
            onOptionsOpen={(open) => {
              setPlaybackOptionsOpen(open);
              if (open && measurementPlotOpen) closeMeasurementPlot(false);
            }}
            onToggleBookmark={toggleCurrentBookmark}
            onSetReference={setCurrentReference}
            onClearReference={() => dispatchStudy({ type: "clear-reference" })}
            onGoToReference={() => {
              if (!study.reference) return;
              setPlaying(false);
              setFrame(study.reference.index);
            }}
            onProperty={showPropertyPlot}
            onAnalyze={showRdfSetup}
            onTracking={setTrackingMode}
            onMode={(mode) => {
              setPlaybackMode(mode);
              setPlaybackDirection(1);
            }}
          />
        )}

        {loadState === "loading" && <CenteredState title="Opening files" busy />}
        {loadState === "error" && (
          <CenteredState
            title="Trajectory unavailable"
            detail={loadError}
            alert
            action="Try again"
            onAction={() => setRequestKey((value) => value + 1)}
          />
        )}
        {loadState === "ready" && manifest?.frame_count === 0 && (
          <CenteredState
            title={manifest.name === "No trajectory" ? "Open files" : "No frames found"}
            detail="Drop a structure, trajectory, or PQ run bundle."
            action="Open"
            onAction={showOpen}
          />
        )}
        {notice && (
          <div
            className={`${opening || rendering ? "notice is-busy" : "notice"}${notice.tone === "error" ? " is-error" : ""}`}
            role={notice.tone === "error" ? "alert" : "status"}
            title={notice.message}
          >
            <span>{notice.message}</span>
            {notice.tone === "error" && (
              <button
                className="notice-dismiss"
                type="button"
                aria-label="Dismiss message"
                onClick={() => setNotice(null)}
              >
                <Icon name="close" />
              </button>
            )}
          </div>
        )}
        {figureSheetOpen && (
          <FigureSheet
            output={figureOutput}
            selectedCount={selectedAtoms.length}
            atomLabels={atomLabelsEnabled}
            elementLegend={elementLegendEnabled}
            scaleBar={scaleBar}
            busy={rendering}
            onOutput={updateFigureOutput}
            onAtomLabels={setAtomLabelsEnabled}
            onElementLegend={setElementLegendEnabled}
            onScaleBar={setScaleBarEnabled}
            onScaleBarLength={setScaleBarLength}
            onExport={exportConfiguredFigure}
            onSaveRecipe={saveFigureRecipe}
            recipeSaveDisabled={hasStructureEdits}
            onOpenRecipe={showRecipeOpen}
            onClose={() => setFigureSheetOpen(false)}
            returnFocusRef={exportButtonRef}
          />
        )}
        {manifest && (
          <RdfSetup
            open={rdfSetupOpen}
            frameCount={manifest.frame_count}
            options={analysisSelectionOptions}
            defaultReferenceId={analysisSelectionOptions[0]?.id}
            initialView={rdfInitialView}
            onRun={runRdfSetup}
            onClose={() => setRdfSetupOpen(false)}
          />
        )}
        {dropActive && <DropOverlay replacing={Boolean(manifest)} />}
        {commandOpen && <CommandPalette
          actions={commands}
          contextIds={commandContextIds}
          recentIds={recentCommandIds}
          resolveAction={resolveCommandAction}
          onClose={() => setCommandOpen(false)}
        />}
        {shortcutsOpen && <ShortcutSheet
          shortcutLabels={shortcutLabels}
          vimMode={vimMode}
          onVimMode={setVimMode}
          onClose={() => setShortcutsOpen(false)}
        />}
      </div>
    </main>
  );
}

interface CommandAction {
  id: string;
  label: string;
  keywords?: string;
  breadcrumb?: string;
  detail?: string;
  disabled?: boolean;
  discoverableWhenDisabled?: boolean;
  run: () => void;
}

export function shouldNormalizePolyhedra(
  mode: RepresentationMode,
  available: boolean | null,
  recipeApplying: boolean,
): boolean {
  return mode === "polyhedra" && available === false && !recipeApplying;
}

export function filterCommandActions<T extends { label: string; keywords?: string; breadcrumb?: string; detail?: string; disabled?: boolean }>(
  actions: readonly T[],
  query: string,
): T[] {
  const searchable = actions.map((action, index) => ({
    id: `command-${index}`,
    action,
    label: action.label,
    keywords: action.keywords,
    breadcrumb: action.breadcrumb,
    detail: action.detail,
    disabled: action.disabled,
  }));
  return searchCommandActions(searchable, query).map(({ action }) => action);
}

function useModalFocus<T extends HTMLElement>(
  panelRef: Readonly<{ current: T | null }>,
  initialRef?: Readonly<{ current: HTMLElement | null }>,
) {
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modalRoot = panel.parentElement;
    const background = modalRoot?.parentElement
      ? [...modalRoot.parentElement.children]
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== modalRoot)
        .map((element) => ({ element, inert: element.inert }))
      : [];
    background.forEach(({ element }) => { element.inert = true; });

    const focusable = () => [...panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.offsetParent !== null);
    const focusInitial = () => (initialRef?.current ?? focusable()[0] ?? panel).focus();
    const animation = requestAnimationFrame(focusInitial);
    const keepFocusInside = (event: FocusEvent) => {
      if (!panel.contains(event.target as Node)) focusInitial();
    };
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("focusin", keepFocusInside);
    panel.addEventListener("keydown", trapTab);
    return () => {
      cancelAnimationFrame(animation);
      document.removeEventListener("focusin", keepFocusInside);
      panel.removeEventListener("keydown", trapTab);
      background.forEach(({ element, inert }) => { element.inert = inert; });
      restoreFocusWhenAvailable(restoreFocus);
    };
  }, []);
}

function usePanelFocusRestore<T extends HTMLElement>(
  panelRef: Readonly<{ current: T | null }>,
  fallbackRef: Readonly<{ current: HTMLElement | null }>,
) {
  useEffect(() => {
    const panel = panelRef.current;
    const origin = document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body
      ? document.activeElement
      : null;
    if (!panel) return;
    return () => {
      const active = document.activeElement;
      if (
        active === document.body
        || active === null
        || panel.contains(active)
      ) {
        restoreFocusWhenAvailable(
          origin?.isConnected ? origin : fallbackRef.current,
        );
      }
    };
  }, [fallbackRef]);
}

function restoreFocusWhenAvailable(element: FocusTarget | null) {
  if (!element?.isConnected) return;
  if (!element.matches(":disabled")) {
    element.focus();
    return;
  }
  const observer = new MutationObserver(() => {
    if (!element.isConnected || element.matches(":disabled")) return;
    window.clearTimeout(timeout);
    observer.disconnect();
    element.focus();
  });
  const timeout = window.setTimeout(() => observer.disconnect(), 30_000);
  observer.observe(element, { attributes: true, attributeFilter: ["disabled"] });
}

function FigureSheet({
  output,
  selectedCount,
  atomLabels,
  elementLegend,
  scaleBar,
  busy,
  onOutput,
  onAtomLabels,
  onElementLegend,
  onScaleBar,
  onScaleBarLength,
  onExport,
  onSaveRecipe,
  recipeSaveDisabled,
  onOpenRecipe,
  onClose,
  returnFocusRef,
}: {
  output: FigureOutput;
  selectedCount: number;
  atomLabels: boolean;
  elementLegend: boolean;
  scaleBar: Extract<FigureAnnotation, { kind: "scale-bar" }> | null;
  busy: boolean;
  onOutput: (change: Partial<FigureOutput>) => void;
  onAtomLabels: (enabled: boolean) => void;
  onElementLegend: (enabled: boolean) => void;
  onScaleBar: (enabled: boolean) => void;
  onScaleBarLength: (length: number) => void;
  onExport: () => void;
  onSaveRecipe: () => void;
  recipeSaveDisabled: boolean;
  onOpenRecipe: () => void;
  onClose: () => void;
  returnFocusRef: Readonly<{ current: HTMLElement | null }>;
}) {
  const panelRef = useRef<HTMLElement>(null);
  usePanelFocusRestore(panelRef, returnFocusRef);
  const presets = [
    { label: "Landscape", width: 2400, height: 1800 },
    { label: "Square", width: 2400, height: 2400 },
    { label: "Wide", width: 3200, height: 1800 },
  ];
  return (
    <aside
      ref={panelRef}
      className="figure-sheet export-sheet"
      id="figure-sheet"
      role="dialog"
      aria-label="Export figure"
      tabIndex={-1}
    >
      <header className="export-heading">
        <div>
          <strong>Export figure</strong>
          <span>{output.width.toLocaleString()} × {output.height.toLocaleString()} px · {formatNumber(output.dpi)} DPI</span>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close export"><Icon name="close" /></button>
      </header>
      <div className="export-body">
        <section className="figure-section">
          <span className="figure-section-label">Size</span>
          <div
            className="figure-presets"
            role="group"
            aria-label="Figure size preset"
          >
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={output.width === preset.width && output.height === preset.height ? "is-active" : ""}
                aria-pressed={output.width === preset.width && output.height === preset.height}
                onClick={() => onOutput({ width: preset.width, height: preset.height })}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="figure-number-grid">
            <label>
              <span>Width</span>
              <input
                type="number"
                min="1"
                max="8192"
                step="1"
                value={output.width}
                onChange={(event) => onOutput({ width: Number(event.currentTarget.value) })}
              />
            </label>
            <label>
              <span>Height</span>
              <input
                type="number"
                min="1"
                max="8192"
                step="1"
                value={output.height}
                onChange={(event) => onOutput({ height: Number(event.currentTarget.value) })}
              />
            </label>
            <label>
              <span>DPI</span>
              <input
                type="number"
                min="1"
                max="2400"
                step="1"
                value={output.dpi}
                onChange={(event) => onOutput({ dpi: Number(event.currentTarget.value) })}
              />
            </label>
          </div>
        </section>

        <section className="figure-section">
          <span className="figure-section-label">File</span>
          <div className="figure-choice-row" role="group" aria-label="Figure format">
            {(["png", "tiff"] as const).map((format) => (
              <button
                key={format}
                type="button"
                className={output.format === format ? "is-active" : ""}
                aria-pressed={output.format === format}
                onClick={() => onOutput({ format })}
              >
                {format === "png" ? "PNG" : "TIFF"}
              </button>
            ))}
          </div>
          <div className="figure-choice-row" data-setting-id="export-background" role="group" aria-label="Figure background">
            <button
              type="button"
              className={output.background.kind === "solid" ? "is-active" : ""}
              aria-pressed={output.background.kind === "solid"}
              onClick={() => onOutput({ background: { kind: "solid", color: "#ffffff" } })}
            >
              White
            </button>
            <button
              type="button"
              className={output.background.kind === "transparent" ? "is-active" : ""}
              aria-pressed={output.background.kind === "transparent"}
              onClick={() => onOutput({ background: { kind: "transparent" } })}
            >
              Transparent
            </button>
          </div>
        </section>

        <section className="figure-section">
          <span className="figure-section-label">Camera</span>
          <div className="figure-choice-row" role="group" aria-label="Figure projection">
            {(["orthographic", "perspective"] as const).map((projection) => (
              <button
                key={projection}
                type="button"
                className={output.projection === projection ? "is-active" : ""}
                aria-pressed={output.projection === projection}
                onClick={() => onOutput({ projection })}
              >
                {projection === "orthographic" ? "Orthographic" : "Perspective"}
              </button>
            ))}
          </div>
        </section>

        <section className="figure-section">
          <span className="figure-section-label">Annotations</span>
          <label className="figure-toggle">
            <span><strong>Selected atom labels</strong><small>{selectedCount > 0 ? `${selectedCount} selected` : "Select atoms first"}</small></span>
            <input
              type="checkbox"
              checked={atomLabels}
              disabled={selectedCount === 0}
              onChange={(event) => onAtomLabels(event.currentTarget.checked)}
            />
          </label>
          <label className="figure-toggle">
            <span><strong>Element legend</strong><small>Visible elements</small></span>
            <input
              type="checkbox"
              checked={elementLegend}
              onChange={(event) => onElementLegend(event.currentTarget.checked)}
            />
          </label>
          <label className="figure-toggle">
            <span><strong>Scale bar</strong><small>Orthographic figures</small></span>
            <input
              type="checkbox"
              checked={Boolean(scaleBar)}
              disabled={output.projection !== "orthographic"}
              onChange={(event) => onScaleBar(event.currentTarget.checked)}
            />
          </label>
          {scaleBar && (
            <label className="figure-scale-length">
              <span>Length</span>
              <input
                type="number"
                min="0.0001"
                step="any"
                value={scaleBar.length}
                onChange={(event) => onScaleBarLength(Number(event.currentTarget.value))}
              />
              <span>Å</span>
            </label>
          )}
        </section>

        <section className="figure-section figure-recipe-actions">
          <span className="figure-section-label">Recipe</span>
          <p>Save this source, frame, scene, and camera as one reproducible view.</p>
          <div>
            <button type="button" onClick={onOpenRecipe}>Open</button>
            <button
              type="button"
              disabled={recipeSaveDisabled}
              title={recipeSaveDisabled ? "Download and reopen the edited structure first" : undefined}
              onClick={onSaveRecipe}
            >Save</button>
          </div>
        </section>
      </div>
      <footer className="export-footer">
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" type="button" disabled={busy} onClick={onExport}>
          {busy ? "Exporting…" : `Export ${output.format === "tiff" ? "TIFF" : "PNG"}`}
        </button>
      </footer>
    </aside>
  );
}

function CommandPalette({
  actions,
  contextIds,
  recentIds,
  resolveAction,
  onClose,
}: {
  actions: CommandAction[];
  contextIds: string[];
  recentIds: string[];
  resolveAction?: (query: string) => CommandAction | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visible = useMemo(() => {
    const searched = searchCommandActions(actions, query, { contextIds, recentIds });
    const resolved = resolveAction?.(query) ?? null;
    return resolved
      ? [resolved, ...searched.filter((action) => action.id !== resolved.id)]
      : searched;
  }, [actions, contextIds, query, recentIds, resolveAction]);

  useModalFocus(panelRef, inputRef);
  useEffect(() => setActive(0), [visible]);
  useEffect(() => {
    optionRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, visible]);

  const move = (direction: number) => {
    if (visible.length === 0) return;
    setActive((current) => (current + direction + visible.length) % visible.length);
  };

  return <div className="command-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={panelRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Search" tabIndex={-1}>
      <label className="command-search"><Icon name="search" /><input
        ref={inputRef}
        value={query}
        placeholder="Search atoms, settings, and commands"
        aria-label="Search atoms, settings, and commands"
        role="combobox"
        aria-autocomplete="list"
        aria-controls="command-results"
        aria-expanded="true"
        aria-activedescendant={visible[active] ? `command-${visible[active].id}` : undefined}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
          else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
          else if (event.key === "Enter") {
            event.preventDefault();
            if (!visible[active]?.disabled) visible[active]?.run();
          }
        }}
      /><kbd>esc</kbd></label>
      <div className="command-results" id="command-results" role="listbox">
        {visible.map((action, index) => <button
          ref={(element) => { optionRefs.current[index] = element; }}
          key={action.id}
          id={`command-${action.id}`}
          type="button"
          role="option"
          aria-selected={index === active}
          aria-disabled={action.disabled || undefined}
          className={index === active ? "is-active" : ""}
          onPointerMove={() => setActive(index)}
          onClick={() => {
            if (!action.disabled) action.run();
          }}
        >
          <span className="command-result-copy">
            <span>{action.label}</span>
            {action.breadcrumb && <small>{action.breadcrumb}</small>}
          </span>
          {action.detail && <span className="command-result-detail">{
            action.disabled
              ? <small>{action.detail}</small>
              : <kbd>{action.detail}</kbd>
          }</span>}
        </button>)}
        {visible.length === 0 && <p>No matching atoms, settings, or commands</p>}
      </div>
    </section>
  </div>;
}

function ShortcutSheet({
  shortcutLabels,
  vimMode,
  onVimMode,
  onClose,
}: {
  shortcutLabels: ViewerShortcutLabels;
  vimMode: boolean;
  onVimMode: (enabled: boolean) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useModalFocus(panelRef);
  const groups: Array<{ title: string; items: Array<[string, string]> }> = [
    {
      title: "Trajectory",
      items: [
        ["← / →", "Previous / next frame"],
        ["Shift ← / →", "Move ten frames"],
        ["Home / End", "First / last frame"],
        ["Space", "Play / pause"],
        ["M", "Bookmark frame"],
      ],
    },
    {
      title: "View",
      items: [
        ["R", "Fit structure"],
        ["1 / 2 / 3 / 4", "3D / XY / XZ / YZ"],
        ["↑ / ↓", "Browse atoms"],
        ["Enter", "Toggle atom"],
        ["E / V", "Edit / View tools"],
        ["D", "Light / dark appearance"],
        ["B", "Bonds / lines"],
        ["C / F / W", "Cell / forces / water"],
      ],
    },
    {
      title: "Workspace",
      items: [
        [shortcutLabels.commands, "Search atoms, settings, commands"],
        [shortcutLabels.open, "Open files"],
        [shortcutLabels.export, "Export figure"],
        ["? / Esc", "Shortcuts / close"],
      ],
    },
  ];
  const vimItems: Array<[string, string]> = [
    ["l / h", "Next / previous frame"],
    ["L / H", "Forward / back ten"],
    ["gg / G", "First / last frame"],
    [":", "Search atoms, settings, commands"],
    ["Ctrl [", "Close surface"],
  ];

  return <div className="command-backdrop shortcut-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={panelRef} className="shortcut-panel" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1}>
      <div className="shortcut-heading">
        <div><strong>Keyboard shortcuts</strong><span>Everything remains available with the mouse.</span></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close keyboard shortcuts"><Icon name="close" /></button>
      </div>
      <div className="shortcut-groups">
        {groups.map((group) => <section key={group.title}>
          <h3>{group.title}</h3>
          {group.items.map(([keys, label]) => <div className="shortcut-row" key={`${keys}:${label}`}><kbd>{keys}</kbd><span>{label}</span></div>)}
        </section>)}
      </div>
      <section className={vimMode ? "vim-shortcuts is-active" : "vim-shortcuts"}>
        <div className="vim-heading">
          <div><strong>Vim navigation</strong><span>Optional; standard shortcuts stay active.</span></div>
          <button type="button" role="switch" aria-label="Vim navigation" aria-checked={vimMode} onClick={() => onVimMode(!vimMode)}><i /></button>
        </div>
        {vimMode && <div className="vim-shortcut-grid">
          {vimItems.map(([keys, label]) => <div className="shortcut-row" key={`${keys}:${label}`}><kbd>{keys}</kbd><span>{label}</span></div>)}
        </div>}
      </section>
    </section>
  </div>;
}

function StructurePanel({
  manifest,
  frame,
  frameIndex,
  pbc,
  editedFrame,
  topologyEdited,
  revealCellMode,
  onCellEdit,
  onDownload,
  onReset,
}: {
  manifest: Manifest;
  frame: FrameData | null;
  frameIndex: number;
  pbc: [boolean, boolean, boolean];
  editedFrame: boolean;
  topologyEdited: boolean;
  revealCellMode?: "parameters" | "vectors";
  onCellEdit: (
    values: readonly number[],
    pbc: readonly boolean[],
    scaleAtoms: boolean,
  ) => void;
  onDownload: () => void;
  onReset: () => void;
}) {
  const cell = cellMatrix(frame);
  const cellKey = [
    frameIndex,
    ...(cell ?? []),
    ...pbc.map(Number),
  ].join(":");
  const dirty = editedFrame || topologyEdited;
  return <div className="structure-panel">
    <section className="workbench-section structure-overview">
      <div className="structure-fact-grid">
        <div><span>Formula</span><strong>{structureFormula(manifest)}</strong></div>
        <div><span>Atoms</span><strong>{manifest.topology.atom_count.toLocaleString()}</strong></div>
        <div><span>Frames</span><strong>{manifest.frame_count.toLocaleString()}</strong></div>
        <div><span>Boundary</span><strong>{cell ? periodicAxesLabel(pbc) : "Nonperiodic"}</strong></div>
      </div>
      <p className="scientific-note">
        Coordinates are Cartesian in Å. The displayed PQ cell remains centered at −L/2 to +L/2.
      </p>
    </section>
    <CellEditor
      key={`${cellKey}:${revealCellMode ?? ""}`}
      frame={frame}
      pbc={pbc}
      initialMode={revealCellMode}
      onApply={onCellEdit}
    />
    <section className="workbench-section structure-actions">
      <button type="button" className="primary-panel-action" onClick={onDownload}>
        Download current frame
        <small>EXTXYZ</small>
      </button>
      <button type="button" onClick={onReset} disabled={!dirty}>Reset local edits</button>
      <p>Edits stay local until downloaded. Figures and exports use the edited structure.</p>
    </section>
  </div>;
}

function CellEditor({
  frame,
  pbc,
  initialMode = "parameters",
  onApply,
}: {
  frame: FrameData | null;
  pbc: [boolean, boolean, boolean];
  initialMode?: "parameters" | "vectors";
  onApply: (
    values: readonly number[],
    pbc: readonly boolean[],
    scaleAtoms: boolean,
  ) => void;
}) {
  const sourceCell = cellMatrix(frame);
  const baseline = sourceCell ?? suggestedCell(frame);
  const baselineParameters = cellParameters(baseline);
  const [mode, setMode] = useState<"parameters" | "vectors">(initialMode);
  const [parameterDraft, setParameterDraft] = useState(
    () => cellParameterValues(baselineParameters),
  );
  const [vectorDraft, setVectorDraft] = useState(
    () => baseline.map(cellInputValue),
  );
  const [axes, setAxes] = useState<[boolean, boolean, boolean]>([...pbc]);
  const [scaleAtoms, setScaleAtoms] = useState(false);
  const [error, setError] = useState("");

  const currentCell = () => mode === "parameters"
    ? cellFromParameters(cellParametersFromValues(parameterDraft))
    : validateCell(vectorDraft.map(numericCellInput));
  const changeMode = (nextMode: "parameters" | "vectors") => {
    if (nextMode === mode) return;
    try {
      const cell = currentCell();
      setVectorDraft(cell.map(cellInputValue));
      setParameterDraft(cellParameterValues(cellParameters(cell)));
      setError("");
      setMode(nextMode);
    } catch (reason) {
      setError(message(reason));
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      onApply(currentCell(), axes, scaleAtoms);
      setError("");
    } catch (reason) {
      setError(message(reason));
    }
  };

  return <form className="workbench-section cell-editor" data-setting-id="edit-cell" onSubmit={submit}>
    <div className="workbench-section-heading">
      <h3>Cell</h3>
      <span>{sourceCell ? "3 × 3 lattice" : "Not in source · creates cell"}</span>
    </div>
    <div className="segmented-options cell-editor-mode" role="group" aria-label="Cell editing mode">
      <button
        type="button"
        className={mode === "parameters" ? "is-active" : ""}
        aria-pressed={mode === "parameters"}
        onClick={() => changeMode("parameters")}
      >Lengths + angles</button>
      <button
        type="button"
        data-setting-id="edit-cell-vectors"
        className={mode === "vectors" ? "is-active" : ""}
        aria-pressed={mode === "vectors"}
        onClick={() => changeMode("vectors")}
      >Vectors</button>
    </div>
    {mode === "parameters" ? (
      <div className="cell-parameter-grid">
        {([
          ["a", "Å"],
          ["b", "Å"],
          ["c", "Å"],
          ["α", "°"],
          ["β", "°"],
          ["γ", "°"],
        ] as const).map(([label, unit], index) => <label key={label}>
          <span>{label}</span>
          <input
            type="number"
            step="any"
            inputMode="decimal"
            aria-label={index < 3 ? `Cell length ${label}` : `Cell angle ${["alpha", "beta", "gamma"][index - 3]}`}
            value={parameterDraft[index]}
            onChange={(event) => setParameterDraft((current) => replaceStringValue(
              current,
              index,
              event.target.value,
            ))}
          />
          <small>{unit}</small>
        </label>)}
      </div>
    ) : (
      <div className="cell-vector-grid" aria-label="Lattice vectors">
        <span />
        {(["x", "y", "z"] as const).map((axis) => <span key={axis}>{axis}</span>)}
        {(["a", "b", "c"] as const).flatMap((vector, row) => [
          <strong key={`${vector}-label`}>{vector}</strong>,
          ...([0, 1, 2] as const).map((column) => {
            const index = row * 3 + column;
            return <input
              key={`${vector}-${column}`}
              type="number"
              step="any"
              inputMode="decimal"
              aria-label={`Cell vector ${vector} ${["x", "y", "z"][column]}`}
              value={vectorDraft[index]}
              onChange={(event) => setVectorDraft((current) => replaceStringValue(
                current,
                index,
                event.target.value,
              ))}
            />;
          }),
        ])}
      </div>
    )}
    <div className="cell-axis-row">
      <span>Periodic axes</span>
      <div role="group" aria-label="Periodic axes">
        {(["a", "b", "c"] as const).map((axis, index) => <button
          key={axis}
          type="button"
          className={axes[index] ? "is-active" : ""}
          aria-label={`Periodic ${axis}`}
          aria-pressed={axes[index]}
          onClick={() => setAxes((current) => current.map(
            (value, currentIndex) => currentIndex === index ? !value : value,
          ) as [boolean, boolean, boolean])}
        >{axis}</button>)}
      </div>
    </div>
    <label className="cell-scale-choice">
      <input
        type="checkbox"
        checked={scaleAtoms}
        disabled={!sourceCell}
        onChange={(event) => setScaleAtoms(event.target.checked)}
      />
      <span>
        Keep fractional positions
        <small>{scaleAtoms ? "Atoms scale with the cell" : "Cartesian atom positions stay fixed"}</small>
      </span>
    </label>
    {error && <p className="editor-error" role="alert">{error}</p>}
    <button type="submit" className="primary-panel-action">Apply cell</button>
  </form>;
}

function ScenePanel({
  presentation,
  capabilities,
  appearance,
  cellAvailable,
  forceAvailable,
  velocityAvailable,
  pbc,
  atomCount,
  structureCellOrigin,
  selectionCellOrigin,
  forceScale,
  velocityScale,
  onPresentation,
  onAppearance,
  onForceScale,
  onVelocityScale,
}: {
  presentation: ScenePresentation;
  capabilities: SceneCapabilities;
  appearance: Appearance;
  cellAvailable: boolean;
  forceAvailable: boolean;
  velocityAvailable: boolean;
  pbc: [boolean, boolean, boolean];
  atomCount: number;
  structureCellOrigin: CellOffset | null;
  selectionCellOrigin: CellOffset | null;
  forceScale: number;
  velocityScale: number;
  onPresentation: (change: Partial<ScenePresentation>) => void;
  onAppearance: (appearance: Appearance) => void;
  onForceScale: (scale: number) => void;
  onVelocityScale: (scale: number) => void;
}) {
  const repeatCounts = repeatCountsFromImages(presentation.images, pbc);
  const imageBudget = Math.min(
    MAX_PERIODIC_IMAGES,
    Math.max(1, Math.floor(MAX_ATOM_INSTANCES / Math.max(1, atomCount))),
  );
  const pqCentered = sameCellOrigin(presentation.cellOrigin, [0, 0, 0]);
  const selectionCentered = !pqCentered
    && Boolean(selectionCellOrigin && sameCellOrigin(presentation.cellOrigin, selectionCellOrigin));
  const structureCentered = !pqCentered
    && !selectionCentered
    && Boolean(structureCellOrigin && sameCellOrigin(presentation.cellOrigin, structureCellOrigin));
  const bondCapable = !(
    presentation.mode === "spacefill"
    || presentation.mode === "ribbon"
    || presentation.mode === "polyhedra"
  );
  const periodicSummary = [
    presentation.wrap === "atom"
      ? "Atoms"
      : presentation.wrap === "molecule"
        ? "Molecules"
        : "Unwrapped",
    pqCentered
      ? "PQ-centered"
      : selectionCentered
        ? "Selection-centered"
        : structureCentered
          ? "Structure-centered"
          : "Custom center",
    repeatCounts.reduce((total, value) => total * value, 1) > 1
      ? `${repeatCounts.reduce((total, value) => total * value, 1)} cells`
      : "",
  ].filter(Boolean).join(" · ");
  const setRepeatCount = (axis: number, count: number) => {
    const next = [...repeatCounts] as CellOffset;
    next[axis] = Math.max(1, Math.min(5, Math.round(count)));
    if (!canUseRepeatCounts(next, pbc, atomCount)) return;
    onPresentation({ images: repeatImages(next, pbc) });
  };

  return (
    <div className="scene-panel">
      <section className="workbench-section appearance-settings" data-setting-id="view-appearance">
        <div className="workbench-section-heading">
          <h3>Appearance</h3>
          <span>D</span>
        </div>
        <div className="segmented-options appearance-options" role="group" aria-label="Viewer appearance">
          {(["light", "dark"] as const).map((option) => <button
            key={option}
            type="button"
            className={appearance === option ? "is-active" : ""}
            aria-pressed={appearance === option}
            onClick={() => onAppearance(option)}
          >{option === "light" ? "Light" : "Dark"}</button>)}
        </div>
      </section>

      <section className="workbench-section representation-settings" data-setting-id="view-representation">
        <div className="workbench-section-heading">
          <h3>Representation</h3>
          <span>3Dmol</span>
        </div>
        <div className="representation-grid">
          {([
            ["ball-stick", "Ball + stick", true, ""],
            ["spacefill", "Spacefill", true, ""],
            ["licorice", "Licorice", true, ""],
            ["lines", "Lines", true, ""],
            ["ribbon", "Ribbon", capabilities.ribbon, capabilities.ribbonReason],
            ["polyhedra", "Polyhedra", capabilities.polyhedra, capabilities.polyhedraReason],
            ["surface", "Surface", true, ""],
          ] as const).map(([mode, label, available, reason]) => <button
            key={mode}
            type="button"
            className={presentation.mode === mode ? "is-active" : ""}
            aria-pressed={presentation.mode === mode}
            disabled={!available}
            title={!available ? reason : undefined}
            onClick={() => onPresentation({ mode })}
          >{label}</button>)}
        </div>
      </section>

      <section className="workbench-section atom-display-settings" data-setting-id="view-atoms">
        <span className="section-label">Atoms</span>
        <Toggle label="Hydrogens" checked={presentation.hydrogens} onChange={(hydrogens) => onPresentation({ hydrogens })} />
        <label className="panel-select-row">
          <span>Color</span>
          <select
            value={presentation.color}
            onChange={(event) => onPresentation({
              color: event.target.value as ScenePresentation["color"],
            })}
          >
            <option value="element">Element</option>
            <option value="residue">Residue</option>
            <option value="chain">Chain</option>
          </select>
        </label>
        <VectorScale label="Atom size" value={presentation.atomScale} min={0.4} max={1.8} onChange={(atomScale) => onPresentation({ atomScale })} />
        <VectorScale label="Bond size" value={presentation.bondScale} min={0.25} max={1.8} onChange={(bondScale) => onPresentation({ bondScale })} />
        <label className="panel-select-row">
          <span>Quality</span>
          <select
            value={presentation.quality}
            onChange={(event) => onPresentation({
              quality: event.target.value as ScenePresentation["quality"],
            })}
          >
            <option value="auto">Interactive</option>
            <option value="high">High</option>
          </select>
        </label>
      </section>

      <section className="workbench-section display-toggles" data-setting-id="view-layers">
        <span className="section-label">Layers</span>
        <Toggle
          label="Bonds"
          checked={presentation.bonds}
          disabled={!bondCapable}
          settingId="view-bonds"
          title={bondCapable ? undefined : "Not used by the current representation"}
          onChange={(bonds) => onPresentation({ bonds })}
        />
        {capabilities.water && <Toggle label="Water" checked={presentation.water !== "hide"} onChange={(shown) => onPresentation({ water: shown ? "show" : "hide" })} />}
        {cellAvailable && <Toggle label="Cell" checked={presentation.cell} onChange={(cell) => onPresentation({ cell })} />}
        {forceAvailable && <Toggle label="Forces" checked={presentation.forces} onChange={(forces) => onPresentation({ forces })} />}
        {forceAvailable && presentation.forces && <VectorScale label="Force scale" value={forceScale} onChange={onForceScale} />}
        {velocityAvailable && <Toggle label="Velocities" checked={presentation.velocities} onChange={(velocities) => onPresentation({ velocities })} />}
        {velocityAvailable && presentation.velocities && <VectorScale label="Velocity scale" value={velocityScale} onChange={onVelocityScale} />}
      </section>

      {cellAvailable && <details className="workbench-section periodic-settings" data-setting-id="view-periodic">
        <summary>
          <span>Periodic cell</span>
          <small>{periodicSummary}</small>
        </summary>
        <div className="periodic-settings-body">
          <span className="periodic-control-label">Coordinates</span>
          <div className="segmented-options periodic-coordinate-options">
          {([
            ["atom", "Atoms"],
            ["molecule", "Molecules"],
            ["unwrapped", "Unwrapped"],
          ] as const).map(([wrap, label]) => <button
            key={wrap}
            type="button"
            className={presentation.wrap === wrap ? "is-active" : ""}
            aria-pressed={presentation.wrap === wrap}
            onClick={() => onPresentation({ wrap })}
          >{label}</button>)}
          </div>

          <span className="periodic-control-label">Center cell</span>
          <div className="segmented-options periodic-center-options">
          <button
            type="button"
            className={pqCentered ? "is-active" : ""}
            aria-pressed={pqCentered}
            onClick={() => onPresentation({ cellOrigin: [0, 0, 0] })}
          >PQ</button>
          <button
            type="button"
            className={structureCentered ? "is-active" : ""}
            aria-pressed={structureCentered}
            disabled={!structureCellOrigin}
            onClick={() => {
              if (structureCellOrigin) onPresentation({ cellOrigin: structureCellOrigin });
            }}
          >Structure</button>
          <button
            type="button"
            className={selectionCentered ? "is-active" : ""}
            aria-pressed={selectionCentered}
            disabled={!selectionCellOrigin}
            title={selectionCellOrigin ? "Center on the selected atoms" : "Select atoms first"}
            onClick={() => {
              if (selectionCellOrigin) onPresentation({ cellOrigin: selectionCellOrigin });
            }}
          >Selection</button>
          </div>

          <div className="periodic-inline-control">
          <span className="periodic-control-label">Mirror</span>
          <div className="periodic-axis-options" aria-label="Mirror cell axes">
            {(["a", "b", "c"] as const).map((axis, index) => <button
              key={axis}
              type="button"
              className={presentation.mirror[index] ? "is-active" : ""}
              aria-label={`Mirror ${axis}`}
              aria-pressed={presentation.mirror[index]}
              onClick={() => onPresentation({
                mirror: presentation.mirror.map((value, current) => (
                  current === index ? !value : value
                )) as [boolean, boolean, boolean],
              })}
            >{axis}</button>)}
          </div>
          </div>

          <div className="periodic-repeat-heading">
          <span className="periodic-control-label">Repeat</span>
          <span>{repeatCounts.reduce((total, value) => total * value, 1)} / {imageBudget} cells</span>
          </div>
          <div className="periodic-repeat-grid">
          {(["a", "b", "c"] as const).map((axis, index) => {
            const count = repeatCounts[index];
            const next = [...repeatCounts] as CellOffset;
            next[index] = count + 1;
            const axisAvailable = pbc[index];
            const nextAllowed = canUseRepeatCounts(next, pbc, atomCount);
            const nextImageCount = next.reduce((total, value) => total * value, 1);
            const increaseTitle = !axisAvailable
              ? `${axis} is not periodic`
              : count >= 5
                ? "Maximum 5 repeats"
                : nextAllowed
                  ? `Repeat ${axis}`
                  : atomCount * nextImageCount > MAX_ATOM_INSTANCES
                    ? `${MAX_ATOM_INSTANCES.toLocaleString()} atom display limit`
                    : `${MAX_PERIODIC_IMAGES} cell display limit`;
            return <div className={!axisAvailable ? "periodic-repeat-row is-disabled" : "periodic-repeat-row"} key={axis}>
              <span>{axis}</span>
              <button
                type="button"
                aria-label={`Decrease ${axis} repeats`}
                disabled={!axisAvailable || count <= 1}
                onClick={() => setRepeatCount(index, count - 1)}
              >−</button>
              <output aria-label={`${axis} repeats`}>{count}×</output>
              <button
                type="button"
                aria-label={`Increase ${axis} repeats`}
                disabled={!axisAvailable || count >= 5 || !nextAllowed}
                title={increaseTitle}
                onClick={() => setRepeatCount(index, count + 1)}
              >+</button>
            </div>;
          })}
          </div>
        </div>
      </details>}
    </div>
  );
}

function VectorScale({
  label,
  value,
  min = 0.1,
  max = 3,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return <label className="vector-scale-row">
    <span>{label}</span>
    <input type="range" min={min} max={max} step={0.05} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    <output>{value.toFixed(1)}×</output>
  </label>;
}

function Toggle({
  label,
  checked,
  disabled = false,
  settingId,
  title,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  settingId?: string;
  title?: string;
  onChange: (checked: boolean) => void;
}) {
  return <div
    className={disabled ? "toggle-row is-disabled" : "toggle-row"}
    data-setting-id={settingId}
    title={title}
  >
    <span>{label}</span>
    <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><i /></button>
  </div>;
}

function CanvasControls({
  busy,
  viewPreset,
  onFit,
  onView,
}: {
  busy: boolean;
  viewPreset: ViewPreset;
  onFit: () => void;
  onView: (view: ViewPreset) => void;
}) {
  return <div className="canvas-controls" role="toolbar" aria-label="Camera controls">
    <button type="button" disabled={busy} onClick={onFit}>Fit</button>
    {([
      ["perspective", "3D"],
      ["xy", "XY"],
      ["xz", "XZ"],
      ["yz", "YZ"],
    ] as const).map(([view, label]) => <button
      key={view}
      type="button"
      disabled={busy}
      className={viewPreset === view ? "is-active" : ""}
      aria-pressed={viewPreset === view}
      onClick={() => onView(view)}
    >{label}</button>)}
  </div>;
}


function DropOverlay({ replacing }: { replacing: boolean }) {
  return <div className="drop-overlay" role="status"><div><Icon name="folder" /><strong>{replacing ? "Replace data" : "Open files"}</strong><span>Structures, trajectories, and PQ run bundles</span></div></div>;
}

function SelectionBar({
  manifest,
  selectedAtoms,
  displayedPositions,
  cell,
  pbc,
  selectionFormula,
  namedSelections,
  selectionAnchor,
  connectivityAvailable,
  minimumImage,
  measurementEnabled,
  canPlot,
  plotOpen,
  trackingAvailable,
  trackingMode,
  analysisAvailable,
  onMinimumImage,
  onPlot,
  onClear,
  onScope,
  onWithin,
  onSave,
  onRecall,
  onRemoveSaved,
  onPin,
  onTracking,
  onAnalyze,
  onDetails,
  onSummary,
}: {
  manifest: Manifest;
  selectedAtoms: AtomSelection[];
  displayedPositions: Float64Array | null;
  cell: ArrayLike<number> | null;
  pbc: readonly [boolean, boolean, boolean];
  selectionFormula: string;
  namedSelections: NamedSelection[];
  selectionAnchor: AtomSelection | null;
  connectivityAvailable: boolean;
  minimumImage: boolean;
  measurementEnabled: boolean;
  canPlot: boolean;
  plotOpen: boolean;
  trackingAvailable: boolean;
  trackingMode: TrackingMode;
  analysisAvailable: boolean;
  onMinimumImage: () => void;
  onPlot: () => void;
  onClear: () => void;
  onScope: (scope: ScientificSelectionScope) => void;
  onWithin: (distance: number) => void;
  onSave: (name: string) => boolean;
  onRecall: (selection: NamedSelection) => void;
  onRemoveSaved: (name: string) => void;
  onPin: () => void;
  onTracking: (mode: TrackingMode) => void;
  onAnalyze: () => void;
  onDetails: () => void;
  onSummary: () => void;
}) {
  const [name, setName] = useState("");
  const [distance, setDistance] = useState("3.0");
  const toolsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const tools = toolsRef.current;
      if (tools?.open && !tools.contains(event.target as Node)) tools.open = false;
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);
  const validSelections = selectedAtoms.filter(
    ({ atom }) => atom >= 0 && atom < manifest.topology.atom_count,
  );
  const validAtoms = validSelections.map(({ atom }) => atom);
  const periodicMeasurement = Boolean(
    measurementEnabled
    &&
    cell
    && pbc.some(Boolean)
    && validSelections.length >= 2
    && validSelections.length <= 4,
  );
  const measurementPositions = displayedPositions
    && displayedPositions.length === validSelections.length * 3
    && validSelections.length === selectedAtoms.length
    ? displayedPositions
    : null;
  const measurement = measurementPositions
    && measurementEnabled
    && validSelections.length >= 2
    && validSelections.length <= 4
      ? measureDisplayedPositions(
        measurementPositions,
        periodicMeasurement && minimumImage,
        cell,
        pbc,
      )
    : null;
  const atomLabels = validSelections.map((selection) => atomSelectionLabel(manifest, selection));
  let title = validAtoms.length === 1
    ? atomLabels[0]
    : selectionFormula
      ? `${selectionFormula} · ${validAtoms.length.toLocaleString()} atoms`
      : `${validAtoms.length.toLocaleString()} atoms`;
  let value = "";

  if (measurement?.ok) {
    title = `${measurement.kind[0].toUpperCase()}${measurement.kind.slice(1)} · ${atomLabels.join("–")}`;
    value = `${formatNumber(measurement.value)} ${measurement.unit === "angstrom" ? "Å" : "°"}`;
  } else if (validAtoms.length === 1 && measurementPositions) {
    value = [measurementPositions[0], measurementPositions[1], measurementPositions[2]]
      .map((coordinate) => formatNumber(coordinate))
      .join("  ");
  } else if (
    measurementEnabled
    && validAtoms.length > 1
    && validAtoms.length <= 4
  ) {
    value = atomLabels.slice(0, 4).join(" · ");
  }
  const anchorResidue = selectionAnchor
    ? manifest.topology.atom_residue_index?.[selectionAnchor.atom] ?? -1
    : -1;
  const closeTools = () => {
    if (toolsRef.current) toolsRef.current.open = false;
  };
  const applyDistance = () => {
    const parsed = Number(distance);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    onWithin(parsed);
    closeTools();
  };
  const save = () => {
    if (!onSave(name)) return;
    setName("");
    closeTools();
  };

  return <section className="selection-bar" aria-label="Atom selection">
    <div className="selection-readout">
      <strong title={title}>{title}</strong>
      {value && <output>{value}</output>}
    </div>
    {periodicMeasurement ? (
      <button
        className="measurement-mode"
        type="button"
        aria-pressed={minimumImage}
        aria-label={minimumImage ? "Minimum image" : "Displayed images"}
        title="Choose minimum-image or displayed-image geometry"
        onClick={onMinimumImage}
      >
        <span className="measurement-mode-full">{minimumImage ? "Minimum image" : "Displayed images"}</span>
        <span className="measurement-mode-compact" aria-hidden="true">{minimumImage ? "Min. image" : "Images"}</span>
      </button>
    ) : validSelections.length === 1 ? (
      <span className="selection-hint">Shift-click or Shift-drag</span>
    ) : null}
    <details
      ref={toolsRef}
      className="selection-tools"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
      }}
    >
      <summary>Select</summary>
      <div className="selection-tools-popover">
        <section>
          <span>From anchor</span>
          <div className="selection-scope-grid">
            {([
              ["atom", "Atom"],
              ["element", "Element"],
              ["molecule", "Molecule"],
              ["residue", "Residue"],
              ["component", "Component"],
            ] as const).map(([scope, label]) => {
              const disabled = (
                (scope === "residue" && anchorResidue < 0)
                || (scope === "component" && !connectivityAvailable)
                || (scope === "molecule" && anchorResidue < 0 && !connectivityAvailable)
              );
              return <button
                key={scope}
                type="button"
                disabled={disabled}
                onClick={() => {
                  onScope(scope);
                  closeTools();
                }}
              >{label}</button>;
            })}
          </div>
        </section>
        <section>
          <label htmlFor="selection-distance">Within selection</label>
          <div className="selection-input-row">
            <input
              id="selection-distance"
              inputMode="decimal"
              value={distance}
              aria-label="Distance in angstrom"
              onChange={(event) => setDistance(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && applyDistance()}
            />
            <span>Å</span>
            <button type="button" onClick={applyDistance}>Apply</button>
          </div>
        </section>
        <section>
          <label htmlFor="selection-name">Save selection</label>
          <div className="selection-input-row is-name">
            <input
              id="selection-name"
              value={name}
              maxLength={80}
              placeholder="e.g. active site"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && save()}
            />
            <button type="button" disabled={!name.trim()} onClick={save}>Save</button>
          </div>
        </section>
        {namedSelections.length > 0 && <section className="saved-selections">
          <span>Saved</span>
          {namedSelections.map((named) => <div key={named.name}>
            <button type="button" onClick={() => {
              onRecall(named);
              closeTools();
            }}>
              <span>{named.name}</span>
              <small>{named.selections.length.toLocaleString()}</small>
            </button>
            <button type="button" aria-label={`Delete ${named.name}`} onClick={() => onRemoveSaved(named.name)}><Icon name="close" /></button>
          </div>)}
        </section>}
      </div>
    </details>
    {canPlot && (
      <button
        className="selection-plot-button"
        type="button"
        aria-pressed={plotOpen}
        onClick={onPlot}
      >
        {plotOpen ? "Hide plot" : "Plot"}
      </button>
    )}
    {measurementEnabled
      && validSelections.length >= 2
      && validSelections.length <= 4 && (
      <button className="selection-pin-button" type="button" onClick={onPin}>Pin</button>
    )}
    {trackingAvailable && (
      <button
        className="selection-track-button"
        type="button"
        aria-pressed={trackingMode !== "off"}
        title={trackingMode === "displacement"
          ? "Showing displacement from the reference frame"
          : "Show the previous 50 frames"}
        onClick={() => onTracking(trackingMode === "off" ? "trail" : "off")}
      >
        {trackingMode === "off" ? "Track" : "Stop"}
      </button>
    )}
    {analysisAvailable
      && (!measurementEnabled || validSelections.length > 4)
      && (
      <button className="selection-analyze-button" type="button" onClick={onAnalyze}>
        Analyze
      </button>
    )}
    {validSelections.length === 1 && (
      <button type="button" onClick={onDetails}>Details</button>
    )}
    {validSelections.length > 4 && (
      <button className="selection-summary-button" type="button" onClick={onSummary}>Summary</button>
    )}
    <button className="icon-button" type="button" onClick={onClear} aria-label="Clear selection"><Icon name="close" /></button>
  </section>;
}

function PinnedMeasurements({
  manifest,
  pins,
  index,
  cell,
  pbc,
  activeId,
  onRestore,
  onRemove,
  canCompare,
  onCompare,
}: {
  manifest: Manifest;
  pins: PinnedMeasurement[];
  index: SelectionIndex;
  cell: ArrayLike<number> | null;
  pbc: readonly [boolean, boolean, boolean];
  activeId: number | null;
  onRestore: (pin: PinnedMeasurement) => void;
  onRemove: (id: number) => void;
  canCompare: boolean;
  onCompare: () => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (detailsRef.current?.open && !detailsRef.current.contains(event.target as Node)) {
        detailsRef.current.open = false;
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <details ref={detailsRef} className="pinned-measurements">
    <summary>Measurements · {pins.length}</summary>
    <section aria-label="Pinned measurements">
      <header>
        <strong>Measurements</strong>
        {canCompare && <button type="button" onClick={() => {
          if (detailsRef.current) detailsRef.current.open = false;
          onCompare();
        }}>Compare</button>}
      </header>
      <div className="pinned-measurements__list">
        {pins.map((pin) => {
          const readout = measurementReadout(manifest, index, pin, cell, pbc);
          return <div key={pin.id}>
            <button
              className="selection-chip"
              type="button"
              aria-pressed={activeId === pin.id}
              onClick={() => {
                onRestore(pin);
                if (detailsRef.current) detailsRef.current.open = false;
              }}
            >
              <span>{readout.title}</span>
              <strong>{readout.value}</strong>
            </button>
            <button
              className="pinned-measurement-remove"
              type="button"
              aria-label={`Remove pinned ${readout.title.toLowerCase()} · ${
                pin.minimumImage ? "minimum image" : "displayed images"
              } · ${readout.value}`}
              onClick={() => onRemove(pin.id)}
            ><Icon name="close" /></button>
          </div>;
        })}
      </div>
    </section>
  </details>;
}

function SelectionSummaryPanel({
  summary,
  uniqueAtoms,
}: {
  summary: SelectionSummary | null;
  uniqueAtoms: number;
}) {
  if (!summary) return <p className="quiet-copy">Selection geometry is unavailable.</p>;
  return <div className="inspector-content selection-summary-panel">
    <section className="readout-section">
      <Readout label="Formula" value={summary.formula || "—"} />
      <Readout label="Occurrences" value={summary.count.toLocaleString()} />
      {uniqueAtoms !== summary.count && (
        <Readout label="Unique atoms" value={uniqueAtoms.toLocaleString()} />
      )}
      <VectorReadout label="Cartesian centroid" values={summary.centroid} offset={0} unit="Å" />
      <VectorReadout label="Extent" values={summary.extent} offset={0} unit="Å" />
    </section>
  </div>;
}

function AnalyzePanel({
  selectedCount,
  selectionFormula,
  summary,
  uniqueAtoms,
  canPlot,
  plotOpen,
  canPin,
  analysisAvailable,
  staticDemo,
  onPlot,
  onPin,
  onRdf,
  onCoordination,
  onClear,
}: {
  selectedCount: number;
  selectionFormula: string;
  summary: SelectionSummary | null;
  uniqueAtoms: number;
  canPlot: boolean;
  plotOpen: boolean;
  canPin: boolean;
  analysisAvailable: boolean;
  staticDemo: boolean;
  onPlot: () => void;
  onPin: () => void;
  onRdf: () => void;
  onCoordination: () => void;
  onClear: () => void;
}) {
  const measurementName = selectedCount === 2
    ? "Distance"
    : selectedCount === 3
      ? "Angle"
      : selectedCount === 4
        ? "Dihedral"
        : null;
  return <div className="analysis-panel">
    <section className="workbench-section analysis-selection" data-setting-id="analyze-measurement">
      <div className="workbench-section-heading">
        <h3>{selectedCount === 0 ? "Selection" : measurementName ?? "Selection summary"}</h3>
        <span>{selectedCount === 0 ? "Canvas" : `${selectedCount.toLocaleString()} atoms`}</span>
      </div>
      {selectedCount === 0 ? (
        <div className="analysis-empty">
          <strong>Start on the structure</strong>
          <p>Click an atom to inspect it. Shift-click two to four atoms for a distance, angle, or dihedral.</p>
          <div>
            <span><kbd>Click</kbd> inspect</span>
            <span><kbd>Shift</kbd> add atoms</span>
            <span><kbd>Esc</kbd> clear</span>
          </div>
        </div>
      ) : selectedCount > 4 ? (
        <SelectionSummaryPanel summary={summary} uniqueAtoms={uniqueAtoms} />
      ) : (
        <>
          <div className="analysis-measurement-copy">
            <strong>{measurementName}</strong>
            <span>{selectionFormula || `${selectedCount} selected atoms`}</span>
            <p>The live value is shown below the structure. Periodic systems use minimum-image geometry by default.</p>
          </div>
          <div className="analysis-actions">
            <button type="button" onClick={onPlot} disabled={!canPlot}>
              {plotOpen ? "Hide trajectory plot" : "Plot over trajectory"}
            </button>
            <button type="button" onClick={onPin} disabled={!canPin}>Pin measurement</button>
            <button type="button" onClick={onClear}>Clear selection</button>
          </div>
        </>
      )}
    </section>
    <section className="workbench-section analysis-methods">
      <div className="workbench-section-heading">
        <h3>Periodic analysis</h3>
        <span>{analysisAvailable ? "PQAnalysis" : staticDemo ? "Local viewer" : "Trajectory + full cell"}</span>
      </div>
      <div className="analysis-method-grid">
        <button
          type="button"
          disabled={!analysisAvailable}
          title={analysisAvailable ? undefined : staticDemo ? "Available in the installed Python viewer" : "Requires a periodic trajectory"}
          onClick={onRdf}
        >Pair distribution</button>
        <button
          type="button"
          disabled={!analysisAvailable}
          title={analysisAvailable ? undefined : staticDemo ? "Available in the installed Python viewer" : "Requires a periodic trajectory"}
          onClick={onCoordination}
        >Coordination</button>
      </div>
    </section>
  </div>;
}

function Inspector({
  manifest,
  frame,
  selectedAtom,
  selectedPosition,
  cellAvailable,
  editedFrame,
  topologyEdited,
  editable,
  onEdit,
  onRequestEdit,
}: {
  manifest: Manifest;
  frame: FrameData | null;
  selectedAtom: number | null;
  selectedPosition: Float64Array | null;
  cellAvailable: boolean;
  editedFrame: boolean;
  topologyEdited: boolean;
  editable: boolean;
  onEdit: (atom: number, element: string, position: readonly number[]) => void;
  onRequestEdit?: () => void;
}) {
  const positions = frameArray(frame, ["positions", "position", "coordinates", "coords"]);
  const forces = frameArray(frame, ["forces", "force"]);
  const velocities = frameArray(frame, ["velocities", "velocity", "vel"]);
  const charges = frameArray(frame, ["charges", "charge"]);
  const atom = selectedAtom !== null && selectedAtom < manifest.topology.atom_count ? selectedAtom : null;
  const symbol = atom !== null ? atomSymbol(manifest, atom) : null;
  const forceUnit = arrayUnit(frame, manifest, "forces");
  const velocityUnit = arrayUnit(frame, manifest, "velocities");
  const chargeUnit = arrayUnit(frame, manifest, "charges");
  const residueIndex = atom === null ? -1 : manifest.topology.atom_residue_index?.[atom] ?? -1;
  const residue = manifest.topology.residues?.find((entry) => entry.index === residueIndex);
  const residueId = meaningfulResidueId(manifest.topology.residue_ids, atom);
  return <div className="inspector-content">
    {atom === null ? <p className="quiet-copy">Click an atom to inspect and edit it.</p> : <>
      {editable ? (
        <AtomEditor
          key={`${atom}:${editedFrame}:${topologyEdited}:${positions?.[atom * 3] ?? ""}:${positions?.[atom * 3 + 1] ?? ""}:${positions?.[atom * 3 + 2] ?? ""}`}
          atom={atom}
          symbol={symbol ?? "X"}
          positions={positions}
          onEdit={onEdit}
        />
      ) : (
        <section className="selected-atom-overview">
          <div>
            <span>Atom {atom + 1}</span>
            <strong>{symbol ?? "X"}</strong>
          </div>
          {onRequestEdit && <button type="button" onClick={onRequestEdit}>Edit atom</button>}
        </section>
      )}
      <section className="readout-section atom-section">
      {manifest.topology.atom_names?.[atom] && <Readout label="Name" value={manifest.topology.atom_names[atom]} />}
      {residue && <Readout label="Residue" value={`${residue.name ?? `Type ${residue.type_id ?? "—"}`} · ${residue.index + 1}`} />}
      {!residue && residueId !== null && <Readout label="Residue ID" value={residueId} />}
      {selectedPosition && (
        <VectorReadout
          label={cellAvailable ? "Displayed cell position" : "Displayed position"}
          values={selectedPosition}
          offset={0}
          unit="Å"
        />
      )}
      {forces && <VectorReadout label="Force" values={forces} offset={atom * 3} unit={forceUnit} />}
      {velocities && <VectorReadout label="Velocity" values={velocities} offset={atom * 3} unit={velocityUnit} />}
      {charges && charges[atom] !== undefined && <Readout label="Charge" value={withUnit(formatNumber(charges[atom]), chargeUnit)} />}
      </section>
    </>}
  </div>;
}

function AtomEditor({
  atom,
  symbol,
  positions,
  onEdit,
}: {
  atom: number;
  symbol: string;
  positions: Float32Array | Int32Array | null;
  onEdit: (atom: number, element: string, position: readonly number[]) => void;
}) {
  const offset = atom * 3;
  const [element, setElement] = useState(symbol);
  const [coordinates, setCoordinates] = useState(() => [0, 1, 2].map(
    (axis) => cellInputValue(positions?.[offset + axis] ?? 0),
  ));
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const next = coordinates.map(numericCellInput);
      onEdit(atom, element, next);
      setError("");
    } catch (reason) {
      setError(message(reason));
    }
  };
  return <form className="atom-editor" onSubmit={submit}>
    <div className="atom-editor-heading">
      <div>
        <span>Atom {atom + 1}</span>
        <strong>{symbol}</strong>
      </div>
      <small>Editable source data</small>
    </div>
    <label className="atom-element-field">
      <span>Element</span>
      <input
        value={element}
        list="pqviewer-elements"
        spellCheck={false}
        autoComplete="off"
        aria-label="Atom element"
        onChange={(event) => setElement(event.target.value)}
      />
    </label>
    <datalist id="pqviewer-elements">
      {ELEMENT_SYMBOLS.slice(1).map((value, index) => (
        <option key={value} value={value}>{ELEMENT_NAMES[index + 1]}</option>
      ))}
    </datalist>
    <fieldset className="atom-coordinate-fields">
      <legend>Cartesian coordinates</legend>
      {(["x", "y", "z"] as const).map((axis, index) => <label key={axis}>
        <span>{axis}</span>
        <input
          type="number"
          step="any"
          inputMode="decimal"
          aria-label={`Atom ${axis} coordinate`}
          value={coordinates[index]}
          onChange={(event) => setCoordinates((current) => replaceStringValue(
            current,
            index,
            event.target.value,
          ))}
        />
        <small>Å</small>
      </label>)}
    </fieldset>
    <p>Element identity applies to every frame. Coordinates apply to the current frame.</p>
    {error && <p className="editor-error" role="alert">{error}</p>}
    <button type="submit" className="primary-panel-action">Apply atom</button>
  </form>;
}

function Timeline({
  busy,
  frameCount,
  frameIndex,
  displayedFrameIndex,
  playing,
  canPlay,
  frameError,
  frame,
  fps,
  stride,
  mode,
  optionsOpen,
  bookmarks,
  reference,
  currentBookmarked,
  propertySeries,
  analysisAvailable,
  trackingAvailable,
  trackingMode,
  onFrame,
  onPlay,
  onFps,
  onStride,
  onOptionsOpen,
  onToggleBookmark,
  onSetReference,
  onClearReference,
  onGoToReference,
  onProperty,
  onAnalyze,
  onTracking,
  onMode,
}: {
  busy: boolean;
  frameCount: number;
  frameIndex: number;
  displayedFrameIndex: number;
  playing: boolean;
  canPlay: boolean;
  frameError: string;
  frame: FrameData | null;
  fps: number;
  stride: number;
  mode: PlaybackMode;
  optionsOpen: boolean;
  bookmarks: readonly FrameMark[];
  reference: FrameMark | null;
  currentBookmarked: boolean;
  propertySeries: readonly DisplaySeries[];
  analysisAvailable: boolean;
  trackingAvailable: boolean;
  trackingMode: TrackingMode;
  onFrame: (index: number) => void;
  onPlay: () => void;
  onFps: (fps: number) => void;
  onStride: (stride: number) => void;
  onOptionsOpen: (open: boolean) => void;
  onToggleBookmark: () => void;
  onSetReference: () => void;
  onClearReference: () => void;
  onGoToReference: () => void;
  onProperty: (series: DisplaySeries) => void;
  onAnalyze: (view: "rdf" | "coordination") => void;
  onTracking: (mode: TrackingMode) => void;
  onMode: (mode: PlaybackMode) => void;
}) {
  const displayedFrame = String(displayedFrameIndex + 1).padStart(String(frameCount).length, "0");
  const requestedFrame = String(frameIndex + 1).padStart(String(frameCount).length, "0");
  const frameLabel = displayedFrameIndex === frameIndex
    ? `${displayedFrame} / ${frameCount}`
    : `${displayedFrame} → ${requestedFrame}`;
  const compactFrameLabel = displayedFrameIndex === frameIndex
    ? `${compactFrameNumber(displayedFrameIndex + 1)} / ${compactFrameNumber(frameCount)}`
    : `${compactFrameNumber(displayedFrameIndex + 1)} → ${compactFrameNumber(frameIndex + 1)}`;
  const metadata = frameMetadata(frame);

  return (
    <section className={`timeline is-compact${busy ? " is-busy" : ""}`} aria-label="Trajectory controls">
      <div className="transport-row">
        <div className="transport-buttons">
          <button type="button" className="transport-button" onClick={() => onFrame(0)} disabled={busy || frameIndex === 0} aria-label="First frame">
            <Icon name="first" />
          </button>
          <button type="button" className="transport-button" onClick={() => onFrame(frameIndex - 1)} disabled={busy || frameIndex === 0} aria-label="Previous frame">
            <Icon name="back" />
          </button>
          <button type="button" className="play-button" onClick={onPlay} disabled={busy || !canPlay} aria-label={playing ? "Pause" : "Play"}>
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <button type="button" className="transport-button" onClick={() => onFrame(frameIndex + 1)} disabled={busy || frameIndex === frameCount - 1} aria-label="Next frame">
            <Icon name="next" />
          </button>
          <button type="button" className="transport-button" onClick={() => onFrame(frameCount - 1)} disabled={busy || frameIndex === frameCount - 1} aria-label="Last frame">
            <Icon name="last" />
          </button>
        </div>
        <div className="scrubber-shell">
          <label className="scrubber">
            <span className="sr-only">Frame</span>
            <input
              type="range"
              min={0}
              max={Math.max(frameCount - 1, 0)}
              value={frameIndex}
              disabled={busy}
              onChange={(event) => onFrame(Number(event.target.value))}
            />
          </label>
          {(bookmarks.length > 0 || reference) && (
            <div className="trajectory-marker-rail">
              {bookmarks.map((mark) => <button
                key={`${mark.key.source_id}:${mark.key.segment_index}:${mark.key.source_index}`}
                type="button"
                className="trajectory-marker is-bookmark"
                style={{ left: `${frameMarkPercent(mark.index, frameCount)}%` }}
                aria-label={`Go to ${frameMarkLabel(mark)}`}
                title={frameMarkLabel(mark)}
                onClick={() => onFrame(mark.index)}
              />)}
              {reference && <button
                type="button"
                className="trajectory-marker is-reference"
                style={{ left: `${frameMarkPercent(reference.index, frameCount)}%` }}
                aria-label={`Go to reference · ${frameMarkLabel(reference)}`}
                title={`Reference · ${frameMarkLabel(reference)}`}
                onClick={onGoToReference}
              />}
            </div>
          )}
        </div>
        {!frameError && <output
            className="frame-counter"
            aria-label={displayedFrameIndex === frameIndex
              ? `Frame ${displayedFrameIndex + 1} of ${frameCount}`
              : `Showing frame ${displayedFrameIndex + 1}; loading frame ${frameIndex + 1}`}
          >
            <span className="frame-counter-full">{frameLabel}</span>
            <span className="frame-counter-compact" aria-hidden="true">{compactFrameLabel}</span>
          </output>}
        {metadata && <span className="frame-metadata">{metadata}</span>}
        {frameError && <span className="frame-error" title={frameError} aria-label="Frame unavailable">
          <span className="frame-error-full">Frame error</span>
          <span className="frame-error-compact" aria-hidden="true">Error</span>
        </span>}
        <details
          className="timeline-options"
          open={optionsOpen}
          onToggle={(event) => onOptionsOpen(event.currentTarget.open)}
        >
          <summary aria-label="Playback options"><Icon name="more" /></summary>
          <div>
            <span className="section-label">Frame</span>
            <div className="timeline-action-list">
              <button type="button" onClick={onToggleBookmark}>
                {currentBookmarked ? "Remove bookmark" : "Bookmark frame"}
              </button>
              <button type="button" onClick={onSetReference}>Set as reference</button>
              {reference && <>
                <button type="button" onClick={onGoToReference}>Go to reference</button>
                <button type="button" onClick={onClearReference}>Clear reference</button>
                <button
                  type="button"
                  disabled={!trackingAvailable}
                  onClick={() => onTracking("displacement")}
                >
                  {trackingMode === "displacement" ? "Hide displacement" : "Show displacement"}
                </button>
              </>}
            </div>
            {bookmarks.length > 0 && <>
              <span className="section-label">Bookmarks</span>
              <div className="timeline-action-list">
                {bookmarks.map((mark) => <button
                  key={`bookmark-action:${mark.key.source_id}:${mark.key.segment_index}:${mark.key.source_index}`}
                  type="button"
                  onClick={() => onFrame(mark.index)}
                >{frameMarkLabel(mark)}</button>)}
              </div>
            </>}
            {propertySeries.length > 0 && <>
              <span className="section-label">Plot</span>
              <div className="timeline-action-list">
                {propertySeries.map((series) => <button
                  key={series.name}
                  type="button"
                  onClick={() => onProperty(series)}
                >{series.label}</button>)}
              </div>
            </>}
            {analysisAvailable && <>
              <span className="section-label">Pair analysis</span>
              <div className="timeline-action-list">
                <button type="button" onClick={() => onAnalyze("rdf")}>Pair distribution</button>
                <button type="button" onClick={() => onAnalyze("coordination")}>Coordination</button>
              </div>
            </>}
            <span className="section-label">Playback</span>
            <label><span>Speed</span><select value={fps} onChange={(event) => onFps(Number(event.target.value))}>
              {[1, 5, 10, 12, 15, 24, 30, 60].map((value) => <option key={value} value={value}>{value} fps</option>)}
            </select></label>
            <label><span>Stride</span><select value={stride} onChange={(event) => onStride(Number(event.target.value))}>
              {[1, 2, 5, 10].map((value) => <option key={value} value={value}>{value} frame{value === 1 ? "" : "s"}</option>)}
            </select></label>
            <div className="segmented-options">
              {([
                ["once", "Once"],
                ["loop", "Loop"],
                ["rock", "Rock"],
              ] as const).map(([value, label]) => <button
                key={value}
                type="button"
                className={mode === value ? "is-active" : ""}
                aria-pressed={mode === value}
                onClick={() => onMode(value)}
              >{label}</button>)}
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}

export function frameMetadata(frame: FrameData | null): string {
  const stepValue = numericFrameMetadata(frame, "step");
  const timeValue = numericFrameMetadata(frame, "time");
  const step = stepValue === null ? "" : `step ${formatNumber(stepValue)}`;
  const time = timeValue === null ? "" : `t ${formatNumber(timeValue)}`;
  return [step, time].filter(Boolean).join(" · ");
}

export function compactFrameNumber(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  if (rounded < 10_000) return String(rounded);
  const [scale, suffix] = rounded >= 1_000_000_000
    ? [1_000_000_000, "B"] as const
    : rounded >= 1_000_000
      ? [1_000_000, "M"] as const
      : [1_000, "k"] as const;
  const scaled = rounded / scale;
  return `${Number(scaled.toFixed(scaled >= 10 ? 0 : 1))}${suffix}`;
}

export function frameCountLabel(value: number): string {
  const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${count.toLocaleString()} ${count === 1 ? "frame" : "frames"}`;
}

function atomCountLabel(value: number): string {
  return `${value.toLocaleString()} ${value === 1 ? "atom" : "atoms"}`;
}

export function noticeDurationMs(value: string): number {
  return Math.min(10_000, Math.max(4_200, value.length * 70));
}

export function meaningfulResidueId(
  residueIds: readonly (number | string)[] | undefined,
  atom: number | null,
): string | null {
  if (
    atom === null
    || !Number.isInteger(atom)
    || atom < 0
    || !residueIds
    || atom >= residueIds.length
  ) {
    return null;
  }
  const meaningful = residueIds.some((value) => {
    const normalized = String(value).trim();
    return normalized !== "" && normalized !== "0";
  });
  const current = String(residueIds[atom]).trim();
  return meaningful && current !== "" ? current : null;
}

export function measurementPbc(frame: FrameData | null): [boolean, boolean, boolean] {
  const values = frame?.header.pbc;
  if (Array.isArray(values) && values.length === 3) {
    return [Boolean(values[0]), Boolean(values[1]), Boolean(values[2])];
  }
  return framePbc(frame);
}

export function cellOriginForFrame(
  frame: FrameData | null,
  selections?: readonly AtomSelection[],
): CellOffset | null {
  const positions = frameArray(frame, ["positions", "position", "coordinates", "coords"]);
  if (!positions) return null;
  return fractionalStructureCenter(
    frame,
    Math.floor(positions.length / 3),
    selections ?? null,
  );
}

export function sameCellOrigin(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return left.length >= 3
    && right.length >= 3
    && [0, 1, 2].every((axis) => Math.abs(left[axis] - right[axis]) <= 1e-6);
}

export function repeatCountsFromImages(
  images: ScenePresentation["images"],
  pbc: readonly [boolean, boolean, boolean],
): CellOffset {
  return images.min.map((minimum, axis) => (
    pbc[axis]
      ? Math.max(1, Math.min(5, Math.round(Math.abs(images.max[axis] - minimum) + 1)))
      : 1
  )) as CellOffset;
}

export function repeatImages(
  counts: readonly [number, number, number],
  pbc: readonly [boolean, boolean, boolean],
): ScenePresentation["images"] {
  const normalized = counts.map((count, axis) => (
    pbc[axis] ? Math.max(1, Math.min(5, Math.round(count))) : 1
  )) as CellOffset;
  return {
    min: normalized.map((count) => {
      const half = Math.floor((count - 1) / 2);
      return half === 0 ? 0 : -half;
    }) as CellOffset,
    max: normalized.map((count) => Math.ceil((count - 1) / 2)) as CellOffset,
  };
}

export function canUseRepeatCounts(
  counts: readonly [number, number, number],
  pbc: readonly [boolean, boolean, boolean],
  atomCount: number,
): boolean {
  if (counts.some((count) => !Number.isInteger(count) || count < 1 || count > 5)) return false;
  if (counts.some((count, axis) => !pbc[axis] && count !== 1)) return false;
  const imageCount = counts.reduce((total, count) => total * count, 1);
  const imageBudget = Math.min(
    MAX_PERIODIC_IMAGES,
    Math.max(1, Math.floor(MAX_ATOM_INSTANCES / Math.max(1, atomCount))),
  );
  return imageCount <= imageBudget;
}

export function usesPeriodicFigureContext(
  presentation: ScenePresentation,
  pbc: readonly boolean[],
): boolean {
  return pbc.some(Boolean)
    && (presentation.wrap === "atom" || presentation.wrap === "unwrapped")
    && presentation.mode !== "spacefill"
    && presentation.mode !== "ribbon";
}

function defaultPeriodicPresentation(): Pick<
  ScenePresentation,
  "wrap" | "images" | "cellOrigin" | "mirror"
> {
  return {
    wrap: "atom",
    images: { min: [0, 0, 0], max: [0, 0, 0] },
    cellOrigin: [0, 0, 0],
    mirror: [false, false, false],
  };
}

function scopeLabel(scope: ScientificSelectionScope): string {
  return {
    atom: "Atom",
    element: "Element",
    molecule: "Molecule",
    residue: "Residue",
    component: "Connected component",
  }[scope];
}

function sameAtomSelectionValue(left: AtomSelection, right: AtomSelection): boolean {
  return left.atom === right.atom
    && left.image[0] === right.image[0]
    && left.image[1] === right.image[1]
    && left.image[2] === right.image[2];
}

function sameSelectionList(
  left: readonly AtomSelection[],
  right: readonly AtomSelection[],
): boolean {
  return left.length === right.length
    && left.every((selection, index) => sameAtomSelectionValue(selection, right[index]));
}

function positionsForSelections(
  index: SelectionIndex,
  selections: readonly AtomSelection[],
): Float64Array | null {
  const positions = new Float64Array(selections.length * 3);
  for (let selectionIndex = 0; selectionIndex < selections.length; selectionIndex += 1) {
    const position = index.displayedPosition(selections[selectionIndex]);
    if (!position) return null;
    positions.set(position, selectionIndex * 3);
  }
  return positions;
}

function formulaForSelections(
  context: SceneSelectionContext,
  selections: readonly AtomSelection[],
): string {
  const atoms = new Set<number>();
  const atomicNumbers: number[] = [];
  for (const selection of selections) {
    if (
      selection.atom < 0
      || selection.atom >= context.count
      || atoms.has(selection.atom)
    ) continue;
    atoms.add(selection.atom);
    atomicNumbers.push(context.atomicNumbers[selection.atom]);
  }
  return hillFormula(atomicNumbers);
}


export function measureDisplayedPositions(
  positions: ArrayLike<number>,
  minimumImage: boolean,
  cell: ArrayLike<number> | null,
  pbc: readonly [boolean, boolean, boolean],
) {
  const count = Math.floor(positions.length / 3);
  return measureAtomSelection(
    positions,
    Array.from({ length: count }, (_, index) => index),
    minimumImage && cell && pbc.some(Boolean)
      ? { mode: "minimum-image", cell, pbc }
      : { mode: "direct" },
  );
}


function measurementReadout(
  manifest: Manifest,
  index: SelectionIndex,
  pin: PinnedMeasurement,
  cell: ArrayLike<number> | null,
  pbc: readonly [boolean, boolean, boolean],
): { title: string; value: string } {
  const labels = pin.selections.map((selection) => atomSelectionLabel(manifest, selection));
  const positions = positionsForSelections(index, pin.selections);
  const measurement = positions
    ? measureDisplayedPositions(
        positions,
        pin.minimumImage,
        cell,
        pbc,
      )
    : null;
  if (!measurement?.ok) {
    return { title: labels.join("–") || "Measurement", value: "—" };
  }
  return {
    title: `${measurement.kind[0].toUpperCase()}${measurement.kind.slice(1)} · ${labels.join("–")}`,
    value: `${formatNumber(measurement.value)} ${measurement.unit === "angstrom" ? "Å" : "°"}`,
  };
}

function selectedPosition(positions: Float64Array | null, index: number): Float64Array | null {
  if (!positions || index < 0 || positions.length < (index + 1) * 3) return null;
  return positions.slice(index * 3, index * 3 + 3);
}

function numericFrameMetadata(frame: FrameData | null, key: "step" | "time"): number | null {
  const primary = frame?.header[key];
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  const scalar = frame?.header.scalars?.[key];
  return typeof scalar === "number" && Number.isFinite(scalar) ? scalar : null;
}


function Readout({ label, value }: { label: string; value: string }) {
  return <div className="readout"><span>{label}</span><strong>{value}</strong></div>;
}

function VectorReadout({ label, values, offset, unit }: { label: string; values: ArrayLike<number>; offset: number; unit?: string }) {
  return (
    <div className="vector-readout">
      <span>{label}</span>
      <code>
        <i>x</i>{formatNumber(values[offset])}
        <i>y</i>{formatNumber(values[offset + 1])}
        <i>z</i>{formatNumber(values[offset + 2])}
        {unit && <b>{unit}</b>}
      </code>
    </div>
  );
}

function CenteredState({
  title,
  detail,
  busy = false,
  alert = false,
  action,
  onAction,
}: {
  title: string;
  detail?: string;
  busy?: boolean;
  alert?: boolean;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="centered-state" role={alert ? "alert" : "status"}>
      <div className={busy ? "state-orbit is-busy" : "state-orbit"} aria-hidden="true"><i /><i /><b /></div>
      <h1>{title}</h1>
      {detail && <p>{detail}</p>}
      {action && onAction && <button type="button" onClick={onAction}><Icon name={action === "Open" ? "folder" : "retry"} />{action}</button>}
    </div>
  );
}

function arrayUnit(frame: FrameData | null, manifest: Manifest, name: string): string | undefined {
  const normalized = normalizeName(name);
  const descriptor = frame?.header.arrays.find((entry) => normalizeName(entry.name) === normalized);
  const property = Object.entries(manifest.properties ?? {}).find(([key]) => normalizeName(key) === normalized)?.[1];
  return displayUnit(descriptor?.unit ?? property?.unit);
}

function displayUnit(unit: string | null | undefined): string | undefined {
  if (!unit) return undefined;
  return unit.replace(/angstrom/gi, "Å").replace(/Angstrom/g, "Å");
}

function withUnit(value: string, unit: string | undefined): string {
  return unit ? `${value} ${unit}` : value;
}

function atomSymbol(manifest: Manifest, index: number): string {
  return manifest.topology.symbols?.[index] ?? ELEMENT_SYMBOLS[manifest.topology.atomic_numbers?.[index] ?? 0] ?? "X";
}

function atomSelectionLabel(manifest: Manifest, selection: AtomSelection): string {
  const atom = `${atomSymbol(manifest, selection.atom)}${selection.atom + 1}`;
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

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 10000 || absolute < 0.001)) return value.toExponential(3);
  return new Intl.NumberFormat("en", { maximumFractionDigits: 4 }).format(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

function representationLabel(mode: RepresentationMode): string {
  return ({
    "ball-stick": "Ball + stick",
    spacefill: "Spacefill",
    licorice: "Licorice",
    lines: "Lines",
    ribbon: "Ribbon",
    polyhedra: "Polyhedra",
    surface: "Surface",
  } as const)[mode];
}

interface SceneProfileOption {
  profile: Exclude<SceneProfile, "auto" | "custom">;
  label: string;
  available: boolean;
  reason?: string;
}

function sceneProfileOptions(
  capabilities: SceneCapabilities,
  cellAvailable: boolean,
  trajectoryAvailable: boolean,
): SceneProfileOption[] {
  return [
    { profile: "molecule", label: "Molecule", available: true },
    {
      profile: "protein",
      label: "Protein",
      available: capabilities.ribbon,
      reason: capabilities.ribbonReason,
    },
    {
      profile: "liquid",
      label: "Liquid",
      available: cellAvailable && capabilities.water,
      reason: capabilities.water ? "Periodic cell required" : "Solvent required",
    },
    {
      profile: "crystal",
      label: "Crystal",
      available: cellAvailable,
      reason: "Periodic cell required",
    },
    {
      profile: "mof",
      label: "MOF",
      available: cellAvailable,
      reason: "Periodic cell required",
    },
    {
      profile: "trajectory",
      label: "Trajectory",
      available: trajectoryAvailable,
      reason: "Multiple frames required",
    },
  ];
}

function sceneProfileLabel(
  profile: Exclude<SceneProfile, "custom">,
): string {
  if (profile === "mof") return "MOF";
  return profile.charAt(0).toUpperCase() + profile.slice(1);
}

export function autoProfile(
  capabilities: SceneCapabilities,
  _forceAvailable: boolean,
  _hasSeries: boolean,
): Exclude<SceneProfile, "auto" | "custom"> {
  if (capabilities.ribbon) return "protein";
  if (capabilities.suggestedProfile === "crystal") return "crystal";
  return "molecule";
}

export function selectedProfilePresentation(
  selectedProfile: Exclude<SceneProfile, "custom">,
  current: ScenePresentation,
  cellAvailable: boolean,
  forceAvailable: boolean,
  hasSeries: boolean,
  capabilities: SceneCapabilities,
): ScenePresentation {
  const resolved = selectedProfile === "auto"
    ? cellAvailable && capabilities.water
      ? "liquid"
      : autoProfile(capabilities, forceAvailable, hasSeries)
    : selectedProfile;
  return profilePresentation(resolved, current, cellAvailable, forceAvailable, capabilities);
}

export function profilePresentation(
  profile: Exclude<SceneProfile, "auto" | "custom">,
  current: ScenePresentation,
  cellAvailable: boolean,
  forceAvailable: boolean,
  capabilities: SceneCapabilities,
): ScenePresentation {
  const unit = { min: [0, 0, 0] as CellOffset, max: [0, 0, 0] as CellOffset };
  if (profile === "protein") return {
    ...current,
    mode: capabilities.ribbon ? "ribbon" : "licorice",
    water: capabilities.water ? "hide" : "show",
    hydrogens: false,
    wrap: "molecule",
    images: unit,
    cell: false,
    bonds: true,
    forces: false,
    velocities: false,
    color: capabilities.ribbon ? "residue" : "element",
  };
  if (profile === "crystal") return {
    ...current,
    mode: capabilities.polyhedra ? "polyhedra" : "ball-stick",
    water: "show",
    hydrogens: true,
    wrap: "atom",
    images: unit,
    cell: cellAvailable,
    bonds: false,
    forces: false,
    velocities: false,
    atomScale: 0.9,
    bondScale: 0.5,
    color: "element",
  };
  if (profile === "liquid") return {
    ...current,
    mode: "ball-stick",
    water: "show",
    hydrogens: true,
    wrap: "molecule",
    images: unit,
    cell: cellAvailable,
    bonds: true,
    forces: false,
    velocities: false,
    color: "element",
  };
  if (profile === "mof") return {
    ...current,
    mode: "lines",
    water: "hide",
    hydrogens: false,
    wrap: cellAvailable ? "atom" : "molecule",
    images: unit,
    cell: cellAvailable,
    bonds: true,
    forces: false,
    velocities: false,
    atomScale: 0.72,
    bondScale: 0.52,
    color: "element",
  };
  if (profile === "trajectory") return {
    ...current,
    mode: "ball-stick",
    water: "show",
    hydrogens: true,
    wrap: cellAvailable ? "atom" : "none",
    images: unit,
    cell: cellAvailable,
    bonds: true,
    forces: forceAvailable,
    velocities: false,
    color: "element",
  };
  return {
    ...current,
    mode: "ball-stick",
    water: "show",
    hydrogens: true,
    wrap: "molecule",
    images: unit,
    cell: false,
    bonds: true,
    forces: false,
    velocities: false,
    color: "element",
  };
}

function figureFileName(
  name: string | undefined,
  width: number,
  height: number,
  format: "png" | "tiff",
): string {
  return `${safeFileBase(name, "molecule")}-${width}x${height}.${format}`;
}

function figureRecipeFileName(name: string | undefined): string {
  return `${safeFileBase(name, "molecule")}.pqfigure.json`;
}

function safeFileBase(name: string | undefined, fallback: string): string {
  return (name ?? fallback)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function cloneFigureOutput(output: FigureOutput): FigureOutput {
  return {
    ...output,
    background: output.background.kind === "transparent"
      ? { kind: "transparent" }
      : { kind: "solid", color: output.background.color },
  };
}

function cloneFigureAnnotations(
  annotations: readonly FigureAnnotation[],
): FigureAnnotation[] {
  return annotations.map((annotation) => {
    if (annotation.kind === "atom-label") {
      return {
        ...annotation,
        atom: {
          atom: annotation.atom.atom,
          image: [...annotation.atom.image] as CellOffset,
        },
        ...(annotation.offset
          ? { offset: [...annotation.offset] as [number, number] }
          : {}),
      };
    }
    return { ...annotation };
  });
}

function atomSelectionKey(selection: AtomSelection): string {
  return `${selection.atom}:${selection.image.join(",")}`;
}

function isHeadlessFigureMode(): boolean {
  return new URLSearchParams(window.location.search).get("headless") === "1";
}

function measurementSelectionTitle(manifest: Manifest, selections: readonly AtomSelection[]): string {
  const kind = selections.length === 2
    ? "Distance"
    : selections.length === 3
      ? "Angle"
      : "Dihedral";
  return `${kind} · ${selections.map((selection) => atomSelectionLabel(manifest, selection)).join("–")}`;
}

function measurementUnitLabel(unit: "angstrom" | "degree"): string {
  return unit === "angstrom" ? "Å" : "°";
}

function measurementFileName(
  name: string | undefined,
  kind: "distance" | "angle" | "dihedral",
  extension: "csv" | "svg" | "pdf",
): string {
  return `${safeFileBase(name, "trajectory")}-${kind}.${extension}`;
}

function plotFileName(
  name: string | undefined,
  plot: PlotShelfData,
  extension: "csv" | "svg" | "pdf",
): string {
  const kind = plot.kind === "comparison"
    ? "measurements"
    : plot.kind === "rdf"
      ? "pair-analysis"
      : safeFileBase(plot.lines[0]?.label, plot.kind);
  return `${safeFileBase(name, "trajectory")}-${kind}.${extension}`;
}

export function uniqueAtomIndices(
  values: readonly number[],
  atomCount: number,
): number[] {
  return [...new Set(values.filter((value) => (
    Number.isSafeInteger(value) && value >= 0 && value < atomCount
  )))].sort((left, right) => left - right);
}

export function compatibleManifestGrowth(
  previous: Manifest | null,
  next: Manifest,
): boolean {
  if (
    !previous
    || next.frame_count < previous.frame_count
    || next.topology.atom_count !== previous.topology.atom_count
    || previous.source?.kind !== next.source?.kind
    || previous.source?.path !== next.source?.path
    || JSON.stringify(previous.source?.slice ?? null) !== JSON.stringify(next.source?.slice ?? null)
  ) {
    return false;
  }
  const previousElements = previous.topology.atomic_numbers
    ?? previous.topology.symbols
    ?? [];
  const nextElements = next.topology.atomic_numbers
    ?? next.topology.symbols
    ?? [];
  if (
    previousElements.length !== nextElements.length
    || previousElements.some((value, index) => value !== nextElements[index])
  ) {
    return false;
  }
  const sourceIdentity = (manifest: Manifest) => (
    manifest.source?.segments?.map((segment) => ({
      source_id: segment.source_id,
      kind: segment.kind,
      path: segment.path ?? null,
      input: segment.input ?? null,
      files: segment.files ?? null,
    })) ?? []
  );
  return JSON.stringify(sourceIdentity(previous)) === JSON.stringify(sourceIdentity(next));
}

function largestCompatibleMeasurementGroup(
  pins: readonly PinnedMeasurement[],
): PinnedMeasurement[] {
  const distance = pins.filter(({ selections }) => selections.length === 2);
  const angular = pins.filter(({ selections }) => (
    selections.length === 3 || selections.length === 4
  ));
  return angular.length > distance.length ? angular : distance;
}

function comparisonPlaceholder(
  definitions: readonly MeasurementComparisonDefinition[],
  frameCount: number,
  requestId: number,
): PlotShelfData {
  const xValues = Array.from({ length: frameCount }, (_, index) => index + 1);
  return {
    requestId,
    kind: "comparison",
    title: "Measurement comparison",
    xLabel: "Frame",
    yLabel: definitions[0]?.selections.length === 2 ? "Distance" : "Angle",
    yUnit: definitions[0]?.selections.length === 2 ? "Å" : "°",
    xValues,
    frameIndices: xValues.map((_, index) => index),
    lines: definitions.map((definition) => ({
      id: definition.id,
      label: definition.label ?? definition.id,
      values: xValues.map(() => null),
      selection: definition.selections,
      minimumImage: definition.minimumImage,
    })),
    loadedCount: 0,
    totalCount: frameCount,
    complete: false,
  };
}

function propertyPlotData(
  series: DisplaySeries,
  frameCount: number,
  requestId: number,
): PlotShelfData {
  return {
    requestId,
    kind: "property",
    title: series.label,
    xLabel: "Frame",
    yLabel: series.label,
    yUnit: displayUnit(series.unit),
    xValues: Array.from({ length: frameCount }, (_, index) => index + 1),
    frameIndices: Array.from({ length: frameCount }, (_, index) => index),
    lines: [{
      id: series.name,
      label: series.label,
      values: series.values,
    }],
    loadedCount: frameCount,
    totalCount: frameCount,
    complete: true,
  };
}

function rdfPlaceholder(
  view: "rdf" | "coordination",
  context: RdfPlotContext,
): PlotShelfData {
  const coordination = view === "coordination";
  return {
    requestId: context.requestId,
    kind: "rdf",
    title: `${coordination ? "Coordination" : "Pair distribution"} · ${pairSelectionPlotLabel(context.referenceLabel)} → ${pairSelectionPlotLabel(context.targetLabel)}`,
    xLabel: "Radius",
    xUnit: "Å",
    yLabel: coordination ? "N(r)" : "g(r)",
    yFloor: 0,
    xValues: [],
    lines: [{
      id: coordination ? "coordination" : "rdf",
      label: coordination ? "N(r)" : "g(r)",
      values: [],
    }],
    loadedCount: 0,
    totalCount: 0,
    complete: false,
  };
}

function rdfPlotData(
  result: RdfAnalysisResult,
  view: "rdf" | "coordination",
  context: RdfPlotContext,
): PlotShelfData {
  const coordination = view === "coordination";
  const xValues = coordination
    ? result.coordinationRadius
    : result.radiusCenters;
  const values = coordination ? result.coordination : result.gR;
  return {
    requestId: context.requestId,
    kind: "rdf",
    title: `${coordination ? "Coordination" : "Pair distribution"} · ${pairSelectionPlotLabel(context.referenceLabel)} → ${pairSelectionPlotLabel(context.targetLabel)}`,
    xLabel: "Radius",
    xUnit: displayUnit(result.radiusUnit),
    yLabel: coordination ? "N(r)" : "g(r)",
    yFloor: 0,
    yUnit: displayAnalysisUnit(
      coordination ? result.coordinationUnit : result.rdfUnit,
    ),
    context: rdfSamplingContext(result),
    xValues,
    lines: [{
      id: coordination ? "coordination" : "rdf",
      label: coordination ? "N(r)" : "g(r)",
      values,
    }],
    loadedCount: values.length,
    totalCount: values.length,
    complete: true,
  };
}

function rdfSamplingContext(result: RdfAnalysisResult): string {
  const radiusUnit = displayUnit(result.radiusUnit) ?? result.radiusUnit;
  return [
    `${result.frameRange.count.toLocaleString()} frames`,
    `${result.referenceIndices.length.toLocaleString()}×${result.targetIndices.length.toLocaleString()} atoms`,
    `Δr ${formatNumber(result.deltaR)} ${radiusUnit}`,
    `r max ${formatNumber(result.rMax)} ${radiusUnit}`,
  ].join(" · ");
}

function displayAnalysisUnit(unit: string | undefined): string | undefined {
  const normalized = unit?.trim().toLowerCase();
  return normalized && !["1", "dimensionless", "unitless"].includes(normalized)
    ? displayUnit(unit)
    : undefined;
}

function pairSelectionPlotLabel(label: string): string {
  const match = /^All (.+) atoms$/.exec(label);
  return match?.[1] ?? label;
}

export function frameMarkPercent(index: number, frameCount: number): number {
  if (frameCount <= 1) return 0;
  return Math.max(0, Math.min(100, index / (frameCount - 1) * 100));
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isTextEditingTarget(target: HTMLElement | null): boolean {
  return Boolean(target?.isContentEditable || target?.closest('input, select, textarea, [role="textbox"]'));
}

function isActivationTarget(target: HTMLElement | null): boolean {
  return Boolean(target?.closest('button, a[href], [role="button"], [role="menuitem"]'));
}

function initialVimMode(): boolean {
  try {
    return parseVimPreference(window.localStorage.getItem("pqviewer-vim-navigation"));
  } catch {
    return false;
  }
}

function initialAppearance(): Appearance {
  try {
    const stored = window.localStorage.getItem("pqviewer-appearance");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function frameDraftKey(
  coordinateMode: "source" | "unwrapped",
  frameIndex: number,
): string {
  return `${coordinateMode}:${frameIndex}`;
}

function structureFormula(manifest: Manifest): string {
  const atomicNumbers = manifest.topology.atomic_numbers
    ?? manifest.topology.symbols?.map((symbol) => (
      ELEMENT_SYMBOLS.findIndex((candidate) => candidate.toLowerCase() === symbol.toLowerCase())
    ))
    ?? [];
  return hillFormula(atomicNumbers) || "—";
}

function periodicAxesLabel(pbc: readonly boolean[]): string {
  const axes = pbc.slice(0, 3).map((value, index) => value ? "abc"[index] : "").join("");
  return `PBC ${axes || "off"}`;
}

function cellParameterValues(parameters: CellParameters): string[] {
  return [
    parameters.a,
    parameters.b,
    parameters.c,
    parameters.alpha,
    parameters.beta,
    parameters.gamma,
  ].map(cellInputValue);
}

function cellParametersFromValues(values: readonly string[]): CellParameters {
  if (values.length < 6) throw new Error("Cell parameters are incomplete");
  return {
    a: numericCellInput(values[0]),
    b: numericCellInput(values[1]),
    c: numericCellInput(values[2]),
    alpha: numericCellInput(values[3]),
    beta: numericCellInput(values[4]),
    gamma: numericCellInput(values[5]),
  };
}

function cellInputValue(value: number): string {
  return Number(value.toPrecision(10)).toString();
}

function numericCellInput(value: string): number {
  if (value.trim() === "") throw new Error("Every numeric field is required");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Values must be finite numbers");
  return parsed;
}

function replaceStringValue(
  values: readonly string[],
  index: number,
  value: string,
): string[] {
  return values.map((current, currentIndex) => currentIndex === index ? value : current);
}

function structureFileName(name: string, frameIndex: number): string {
  const suffix = frameIndex > 0 ? `.frame-${frameIndex + 1}` : "";
  return `${safeFileBase(name, "structure")}${suffix}.extxyz`;
}

function browserPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const navigatorWithHints = navigator as Navigator & { userAgentData?: { platform?: string } };
  return navigatorWithHints.userAgentData?.platform || navigator.platform || navigator.userAgent;
}

function initialPresentation(): ScenePresentation {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("pqviewer-presentation") ?? "null") as Partial<ScenePresentation> | null;
    if (!parsed || typeof parsed !== "object") return defaultPresentation;
    const modes: RepresentationMode[] = [
      "ball-stick",
      "spacefill",
      "licorice",
      "lines",
      "ribbon",
      "polyhedra",
      "surface",
    ];
    return {
      mode: modes.includes(parsed.mode as RepresentationMode) ? parsed.mode as RepresentationMode : defaultPresentation.mode,
      water: parsed.water === "hide" ? "hide" : "show",
      hydrogens: defaultPresentation.hydrogens,
      wrap: defaultPresentation.wrap,
      images: defaultPresentation.images,
      cellOrigin: [0, 0, 0],
      mirror: [false, false, false],
      cell: typeof parsed.cell === "boolean" ? parsed.cell : defaultPresentation.cell,
      bonds: typeof parsed.bonds === "boolean" ? parsed.bonds : defaultPresentation.bonds,
      forces: typeof parsed.forces === "boolean" ? parsed.forces : defaultPresentation.forces,
      velocities: typeof parsed.velocities === "boolean" ? parsed.velocities : defaultPresentation.velocities,
      atomScale: defaultPresentation.atomScale,
      bondScale: defaultPresentation.bondScale,
      color: defaultPresentation.color,
      quality: defaultPresentation.quality,
    };
  } catch {
    return defaultPresentation;
  }
}
