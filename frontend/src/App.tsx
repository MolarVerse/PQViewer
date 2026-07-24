import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DatasetChangedError,
  frameArray,
  FrameCache,
  getFrame,
  getManifest,
  openFiles,
} from "./api";
import { searchCommandActions } from "./commandSearch";
import { MeasurementPlot } from "./MeasurementPlot";
import {
  calculateMeasurementSeries,
  measurementSeriesCsv,
  measurementSeriesSvg,
} from "./measurementSeries";
import type { MeasurementSeriesProgress } from "./measurementSeries";
import { framePbc, hasFrameCell, MoleculeScene } from "./MoleculeScene";
import type { MoleculeSceneHandle, PngExportOptions, RenderedSceneInfo, ViewPreset } from "./MoleculeScene";
import {
  advanceFrameIndex,
  parseVimPreference,
  resolveVimNavigation,
  shortcutLabelsForPlatform,
} from "./keyboard";
import type { ViewerShortcutLabels, VimNavigationAction, VimPrefix } from "./keyboard";
import {
  measureAtomSelection,
  updateSceneSelection,
} from "./selection";
import {
  advancePlaybackFrame,
  DEFAULT_PLAYBACK_FPS,
  schedulePlaybackFrame,
} from "./trajectory";
import type { PlaybackDirection, PlaybackMode } from "./trajectory";
import type {
  AtomSelection,
  CellOffset,
  FrameData,
  Manifest,
  RepresentationMode,
  SceneCapabilities,
  ScenePresentation,
} from "./types";

type LoadState = "loading" | "ready" | "error";
type SceneProfile = "auto" | "molecule" | "protein" | "crystal" | "trajectory" | "custom";
type WorkbenchTab = "view" | "inspect";
type IconName = "back" | "close" | "first" | "folder" | "image" | "last" | "more" | "next" | "pause" | "play" | "retry" | "search" | "sliders";

const DATASET_CHANNEL = "pqviewer-dataset";

const defaultPresentation: ScenePresentation = {
  mode: "ball-stick",
  water: "show",
  hydrogens: true,
  wrap: "molecule",
  images: { min: [0, 0, 0], max: [0, 0, 0] },
  cell: true,
  forces: true,
  velocities: false,
  atomScale: 1,
  bondScale: 1,
  color: "element",
  quality: "auto",
};

export default function App() {
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
  const [playbackOptionsOpen, setPlaybackOptionsOpen] = useState(false);
  const [presentation, setPresentation] = useState<ScenePresentation>(initialPresentation);
  const [profile, setProfile] = useState<SceneProfile>("auto");
  const [selectedAtoms, setSelectedAtoms] = useState<AtomSelection[]>([]);
  const [selectionPositions, setSelectionPositions] = useState<Float64Array | null>(null);
  const [minimumImage, setMinimumImage] = useState(true);
  const [measurementPlotOpen, setMeasurementPlotOpen] = useState(false);
  const [measurementSeries, setMeasurementSeries] = useState<MeasurementSeriesProgress | null>(null);
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [vimMode, setVimMode] = useState(initialVimMode);
  const [resetSignal, setResetSignal] = useState(0);
  const [viewPreset, setViewPreset] = useState<ViewPreset>("perspective");
  const [viewSignal, setViewSignal] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [forceScale, setForceScale] = useState(1);
  const [velocityScale, setVelocityScale] = useState(1);
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState("");
  const [sceneInfo, setSceneInfo] = useState<RenderedSceneInfo | null>(null);
  const cache = useRef(new FrameCache());
  const moleculeSceneRef = useRef<MoleculeSceneHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelButtonRef = useRef<HTMLButtonElement>(null);
  const workbenchRef = useRef<HTMLElement>(null);
  const vimSequenceRef = useRef<{ prefix: VimPrefix; at: number }>({ prefix: null, at: 0 });
  const dragDepth = useRef(0);
  const autoProfileKey = useRef("");
  const openRequest = useRef(0);
  const openController = useRef<AbortController | null>(null);
  const measurementRequest = useRef(0);
  const datasetReloadPending = useRef(false);
  const datasetCheckPending = useRef(false);
  const manifestGeneration = useRef("");
  const datasetChannel = useRef<BroadcastChannel | null>(null);
  const playbackClock = useRef<{ key: string; requestTimeMs: number | null }>({
    key: "",
    requestTimeMs: null,
  });
  const shortcutLabels = useMemo(() => shortcutLabelsForPlatform(browserPlatform()), []);

  const activateManifest = useCallback((value: Manifest) => {
    cache.current.clear();
    cache.current = new FrameCache({ datasetGeneration: value.dataset_generation });
    datasetReloadPending.current = false;
    manifestGeneration.current = value.dataset_generation ?? "";
    setManifest(value);
    setFrameIndex(0);
    setLoadedFrame(null);
    setSelectedAtoms([]);
    setSelectionPositions(null);
    setMinimumImage(true);
    setMeasurementPlotOpen(false);
    setMeasurementSeries(null);
    setPlaying(false);
    setPlaybackDirection(1);
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    setCommandOpen(false);
    setShortcutsOpen(false);
    setSceneInfo(null);
    setLoadState("ready");
    setLoadError("");
    setProfile("auto");
    autoProfileKey.current = "";
    document.title = `${value.name || "Trajectory"} · PQViewer`;
  }, []);

  const reloadChangedDataset = useCallback(() => {
    if (datasetReloadPending.current) return;
    datasetReloadPending.current = true;
    manifestGeneration.current = "";
    cache.current.clear();
    setManifest(null);
    setFrameIndex(0);
    setLoadedFrame(null);
    setFrameError("");
    setFrameLoading(false);
    setSelectedAtoms([]);
    setSelectionPositions(null);
    setMeasurementPlotOpen(false);
    setMeasurementSeries(null);
    setPlaying(false);
    setPlaybackDirection(1);
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    setCommandOpen(false);
    setShortcutsOpen(false);
    setSceneInfo(null);
    setLoadState("loading");
    setLoadError("");
    setNotice("Trajectory changed in another tab · reloading");
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
        activateManifest(current);
        setNotice("Trajectory changed · updated");
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
    document.documentElement.dataset.appearance = "light";
    document.documentElement.style.colorScheme = "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#f6f8f8");
    try {
      window.localStorage.setItem("pqviewer-presentation", JSON.stringify(presentation));
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
    getManifest()
      .then((value) => {
        if (!active) return;
        activateManifest(value);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(message(error));
        setLoadState("error");
      });
    return () => {
      active = false;
    };
  }, [activateManifest, requestKey]);

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
        setLoadedFrame({ index: frameIndex, data });
        setFrameLoading(false);
        for (let ahead = 1; ahead <= Math.min(4, manifest.frame_count - 1); ahead += 1) {
          cache.current.prefetch((frameIndex + ahead) % manifest.frame_count, manifest.frame_count);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof DatasetChangedError) {
          reloadChangedDataset();
          return;
        }
        setFrameError(message(error));
        setFrameLoading(false);
        setPlaying(false);
      });
    return () => {
      active = false;
    };
  }, [frameIndex, manifest, reloadChangedDataset, rendering]);

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
    setMeasurementPlotOpen(false);
    setMeasurementSeries(null);
    setWorkbenchTab(tab);
    if (focus) focusWorkbench();
  }, [focusWorkbench]);

  const closeWorkbench = useCallback((restoreFocus = false) => {
    const closingTab = workbenchTab;
    setWorkbenchTab(null);
    if (restoreFocus) requestAnimationFrame(() => {
      if (closingTab === "inspect") document.querySelector<HTMLCanvasElement>(".molecule-canvas")?.focus();
      else panelButtonRef.current?.focus();
    });
  }, [workbenchTab]);

  const selectAtom = useCallback((selection: AtomSelection | null, additive = false) => {
    setPlaybackOptionsOpen(false);
    if (selection === null) {
      setSelectedAtoms([]);
      setSelectionPositions(null);
      setMeasurementPlotOpen(false);
      setMeasurementSeries(null);
      setWorkbenchTab((current) => current === "inspect" ? null : current);
      return;
    }
    setSelectionPositions(null);
    setSelectedAtoms((current) => updateSceneSelection(
      current,
      selection,
      additive ? "toggle" : "replace",
    ));
  }, []);

  useEffect(() => {
    if (selectedAtoms.length === 0) {
      setWorkbenchTab((current) => current === "inspect" ? null : current);
    }
    if (selectedAtoms.length < 2 || selectedAtoms.length > 4) {
      setMeasurementPlotOpen(false);
      setMeasurementSeries(null);
    }
  }, [selectedAtoms.length]);

  const selectView = useCallback((preset: ViewPreset) => {
    setViewPreset(preset);
    setViewSignal((value) => value + 1);
  }, []);

  const showOpen = useCallback(() => {
    if (rendering) return;
    setCommandOpen(false);
    setShortcutsOpen(false);
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    fileInputRef.current?.click();
  }, [rendering]);

  const showCommands = useCallback(() => {
    if (rendering) return;
    setPlaying(false);
    setShortcutsOpen(false);
    setPlaybackOptionsOpen(false);
    setCommandOpen(true);
  }, [rendering]);

  const showShortcuts = useCallback(() => {
    if (rendering) return;
    setCommandOpen(false);
    setPlaybackOptionsOpen(false);
    setShortcutsOpen(true);
  }, [rendering]);

  const exportPng = useCallback(async (options: PngExportOptions) => {
    const scene = moleculeSceneRef.current;
    if (!scene || rendering) return;
    if (frameLoading) {
      setNotice("Wait for the current frame to finish loading.");
      return;
    }
    setPlaying(false);
    setRendering(true);
    setNotice("Exporting PNG…");
    try {
      const blob = await scene.exportPng(options);
      downloadBlob(blob, renderFileName(manifest?.name, options.width, options.height));
      setNotice(`Exported ${options.width.toLocaleString()} × ${options.height.toLocaleString()} px`);
    } catch (error) {
      setNotice(`Export failed · ${message(error)}`);
    } finally {
      setRendering(false);
    }
  }, [frameLoading, manifest?.name, rendering]);

  const frame = loadedFrame?.data ?? null;
  const displayedFrameIndex = loadedFrame?.index ?? frameIndex;
  const selectedAtom = selectedAtoms.at(-1)?.atom ?? null;
  const cellAvailable = hasFrameCell(frame);
  const forces = frameArray(frame, ["forces", "force"]);
  const forceAvailable = Boolean(forces && forces.length >= (manifest?.topology.atom_count ?? 0) * 3);
  const velocities = frameArray(frame, ["velocities", "velocity", "vel"]);
  const velocityAvailable = Boolean(velocities && velocities.length >= (manifest?.topology.atom_count ?? 0) * 3);
  const pbc = measurementPbc(frame);
  const capabilities = sceneInfo?.capabilities ?? null;
  const canPlay = (manifest?.frame_count ?? 0) > 1;
  const canRender = Boolean(frame && capabilities && !frameLoading);
  const canPlotMeasurement = canPlay
    && selectedAtoms.length >= 2
    && selectedAtoms.length <= 4
    && selectedAtoms.every(({ atom }) => atom >= 0 && atom < (manifest?.topology.atom_count ?? 0));
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
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    setMeasurementSeries(null);
    if (!cellAvailable || !pbc.some(Boolean)) setMinimumImage(false);
    setMeasurementPlotOpen(true);
  }, [canPlotMeasurement, cellAvailable, pbc[0], pbc[1], pbc[2]]);

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
        setNotice(`Plot unavailable · ${message(error)}`);
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

  useEffect(() => {
    setSelectedAtoms((current) => {
      const visible = current.filter((selection) => selectionVisibleInImages(
        selection,
        presentation.images.min,
        presentation.images.max,
        pbc,
      ));
      return visible.length === current.length ? current : visible;
    });
  }, [
    pbc[0],
    pbc[1],
    pbc[2],
    presentation.images.max[0],
    presentation.images.max[1],
    presentation.images.max[2],
    presentation.images.min[0],
    presentation.images.min[1],
    presentation.images.min[2],
  ]);
  const showRender = useCallback(() => {
    if (!canRender || rendering) return;
    setCommandOpen(false);
    setShortcutsOpen(false);
    setPlaybackOptionsOpen(false);
    setWorkbenchTab(null);
    void exportPng({
      width: 2400,
      height: 1800,
      periodicContext: pbc.some(Boolean)
        && presentation.wrap === "atom"
        && presentation.mode !== "spacefill"
        && presentation.mode !== "ribbon",
    });
  }, [canRender, exportPng, pbc, presentation.mode, presentation.wrap, rendering]);

  const updatePresentation = useCallback((change: Partial<ScenePresentation>) => {
    setPresentation((current) => ({ ...current, ...change }));
    setProfile("custom");
  }, []);

  useEffect(() => {
    if (!manifest || !frame || !capabilities || profile !== "auto") return;
    const key = `${manifest.name}:${manifest.topology.atom_count}`;
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
    const schedule = schedulePlaybackFrame(
      performance.now(),
      playbackClock.current.requestTimeMs,
      playbackFps,
    );
    playbackClock.current.requestTimeMs = schedule.requestTimeMs;
    const timer = window.setTimeout(() => {
      const next = advancePlaybackFrame(frameIndex, manifest.frame_count, {
        mode: playbackMode,
        direction: playbackDirection,
        stride: playbackStride,
      });
      setFrameIndex(next.frameIndex);
      setPlaybackDirection(next.direction);
      if (!next.continuePlaying) setPlaying(false);
    }, schedule.delayMs);
    return () => window.clearTimeout(timer);
  }, [
    frameIndex,
    frameLoading,
    loadedFrame?.index,
    manifest,
    playbackDirection,
    playbackFps,
    playbackMode,
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
    setNotice("Opening files…");
    try {
      const value = await openFiles(selected, controller.signal);
      if (request !== openRequest.current) return;
      activateManifest(value);
      datasetChannel.current?.postMessage({
        datasetGeneration: value.dataset_generation,
      });
      setNotice(`Opened ${value.name} · ${value.frame_count.toLocaleString()} frames`);
    } catch (error) {
      if (request !== openRequest.current || controller.signal.aborted) return;
      setNotice(message(error));
    } finally {
      if (request === openRequest.current) {
        openController.current = null;
        setOpening(false);
      }
    }
  }, [activateManifest, rendering]);

  useEffect(() => () => openController.current?.abort(), []);

  useEffect(() => {
    if (!notice || opening || rendering) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice, opening, rendering]);

  const dismissActive = useCallback((): boolean => {
    vimSequenceRef.current = { prefix: null, at: 0 };
    if (commandOpen) {
      setCommandOpen(false);
    } else if (shortcutsOpen) {
      setShortcutsOpen(false);
    } else if (playbackOptionsOpen) {
      setPlaybackOptionsOpen(false);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(".timeline-options > summary")?.focus();
      });
    } else if (workbenchTab) {
      closeWorkbench(true);
    } else if (measurementPlotOpen) {
      closeMeasurementPlot(true);
    } else if (selectedAtoms.length > 0) {
      setSelectedAtoms([]);
    } else {
      return false;
    }
    return true;
  }, [
    closeMeasurementPlot,
    closeWorkbench,
    commandOpen,
    measurementPlotOpen,
    playbackOptionsOpen,
    selectedAtoms.length,
    shortcutsOpen,
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
        showOpen();
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
    showCommands,
    showOpen,
    showRender,
    showShortcuts,
    updatePresentation,
    workbenchTab,
    workbenchVisible,
    vimMode,
  ]);

  const commands = useMemo<CommandAction[]>(() => {
    const run = (action: () => void) => () => {
      action();
      setCommandOpen(false);
    };
    const actions: CommandAction[] = [
      { id: "open", label: "Open trajectory", keywords: "file load", detail: shortcutLabels.open, run: run(showOpen) },
      { id: "play", label: playing ? "Pause trajectory" : "Play trajectory", keywords: "movie animation", detail: "Space", disabled: !canPlay, run: run(() => setPlaying((value) => !value)) },
      { id: "previous", label: "Previous frame", keywords: "back step", detail: "←", disabled: !canPlay || frameIndex === 0, run: run(() => { setPlaying(false); stepFrame(-1); }) },
      { id: "next", label: "Next frame", keywords: "forward step", detail: "→", disabled: !canPlay || frameIndex >= (manifest?.frame_count ?? 1) - 1, run: run(() => { setPlaying(false); stepFrame(1); }) },
      { id: "first", label: "First frame", keywords: "start beginning", detail: "Home", disabled: !canPlay || frameIndex === 0, run: run(() => { setPlaying(false); setFrame(0); }) },
      { id: "last", label: "Last frame", keywords: "end final", detail: "End", disabled: !canPlay || frameIndex >= (manifest?.frame_count ?? 1) - 1, run: run(() => { setPlaying(false); setFrame((manifest?.frame_count ?? 1) - 1); }) },
      { id: "fit", label: "Fit structure", keywords: "reset camera center", detail: "R", disabled: !manifest?.frame_count, run: run(() => setResetSignal((value) => value + 1)) },
      ...(["perspective", "xy", "xz", "yz"] as ViewPreset[]).map((view, index) => ({
        id: `view-${view}`,
        label: view === "perspective" ? "Perspective view" : `${view.toUpperCase()} view`,
        keywords: "camera orientation axis",
        detail: view === viewPreset ? "Current" : String(index + 1),
        run: run(() => selectView(view)),
      })),
      { id: "display", label: workbenchVisible && workbenchTab === "view" ? "Hide display controls" : "Show display controls", keywords: "view representation settings", detail: "V", disabled: !capabilities, run: run(() => workbenchVisible && workbenchTab === "view" ? closeWorkbench(false) : openWorkbench("view")) },
      { id: "export", label: "Export figure", keywords: "render image png publication", detail: shortcutLabels.export, disabled: !canRender, run: run(showRender) },
      ...(["ball-stick", "spacefill", "lines"] as RepresentationMode[]).map((mode) => ({
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
      ...(capabilities?.water ? [{ id: "water", label: presentation.water === "hide" ? "Show water" : "Hide water", keywords: "solvent", detail: "W", run: run(() => updatePresentation({ water: presentation.water === "hide" ? "show" : "hide" })) }] : []),
      ...(cellAvailable ? [{ id: "cell", label: presentation.cell ? "Hide cell" : "Show cell", keywords: "box periodic pbc", detail: "C", run: run(() => updatePresentation({ cell: !presentation.cell })) }] : []),
      ...(forceAvailable ? [{ id: "forces", label: presentation.forces ? "Hide forces" : "Show forces", keywords: "vectors arrows", detail: "F", run: run(() => updatePresentation({ forces: !presentation.forces })) }] : []),
      ...(velocityAvailable ? [{ id: "velocities", label: presentation.velocities ? "Hide velocities" : "Show velocities", keywords: "vectors arrows motion speed", run: run(() => updatePresentation({ velocities: !presentation.velocities })) }] : []),
      ...(cellAvailable ? ([
        ["atom", "Wrap atoms"],
        ["molecule", "Keep molecules whole"],
        ["none", "Original coordinates"],
      ] as const).map(([wrap, label]) => ({
        id: `wrap-${wrap}`,
        label,
        keywords: "periodic cell boundary coordinates",
        detail: presentation.wrap === wrap ? "Current" : undefined,
        run: run(() => updatePresentation({ wrap })),
      })) : []),
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
        run: run(() => openWorkbench("inspect")),
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
    canPlay,
    canPlotMeasurement,
    canRender,
    capabilities,
    cellAvailable,
    closeMeasurementPlot,
    closeWorkbench,
    forceAvailable,
    frameIndex,
    manifest?.frame_count,
    measurementPlotOpen,
    openWorkbench,
    playing,
    presentation,
    selectView,
    setFrame,
    shortcutLabels,
    showOpen,
    showMeasurementPlot,
    showRender,
    showShortcuts,
    stepFrame,
    updatePresentation,
    velocityAvailable,
    viewPreset,
    vimMode,
    workbenchTab,
    workbenchVisible,
    selectedAtom,
    selectedAtoms.length,
  ]);
  const commandContextIds = useMemo(() => [
    ...(selectedAtoms.length === 1 && selectedAtom !== null ? ["inspect-selection", "clear-selection"] : []),
    ...(canPlotMeasurement ? ["plot-measurement"] : []),
    ...(canPlay ? ["play", "previous", "next"] : []),
    "fit",
    "display",
    "export",
  ], [canPlay, canPlotMeasurement, selectedAtom, selectedAtoms.length]);
  const workspaceClass = [
    "workspace",
    workbenchVisible ? "workbench-open" : "workbench-closed",
    rendering ? "is-rendering" : "",
    canPlay ? "timeline-present" : "timeline-absent",
    selectedAtoms.length > 0 ? "selection-present" : "",
    measurementPlotOpen ? "measurement-plot-open" : "",
    playbackOptionsOpen ? "playback-options-open" : "",
  ].filter(Boolean).join(" ");

  return (
    <main
      className="app-shell"
      onDragEnter={(event) => {
        event.preventDefault();
        if (rendering) return;
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
        if (rendering) return;
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
        accept=".xyz,.extxyz,.force,.frc,.forces,.vel,.velocs,.velocity,.charge,.chrg,.charges,.en,.info,.top,.topology,.mol,.moldescriptor"
        onChange={(event) => {
          if (rendering) return;
          void openSelectedFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
      <div className={workspaceClass} aria-busy={loadState === "loading" || frameLoading || opening || rendering}>
        {manifest && manifest.frame_count > 0 ? (
          <MoleculeScene
            ref={moleculeSceneRef}
            manifest={manifest}
            frame={frame}
            presentation={presentation}
            selectedAtoms={selectedAtoms}
            resetSignal={resetSignal}
            viewPreset={viewPreset}
            viewSignal={viewSignal}
            forceScale={forceScale}
            velocityScale={velocityScale}
            appearance="light"
            onSelect={selectAtom}
            onSceneInfo={setSceneInfo}
            onSelectionPositions={setSelectionPositions}
          />
        ) : (
          <div className="canvas-field" />
        )}

        <header className="topbar">
          <div className="identity">
            <img className="identity-mark" src="/pq-logo.png" alt="" />
            <div>
              <strong>PQViewer</strong>
              <span>{manifest?.name || "Molecular trajectory"}</span>
            </div>
          </div>
          <div className="topbar-tools">
            {manifest && (
              <div className="scene-status">
                <span><strong>{manifest.topology.atom_count.toLocaleString()}</strong> atoms</span>
                <span><strong>{manifest.frame_count.toLocaleString()}</strong> frames</span>
                {cellAvailable && <span>PBC <strong>{pbc.map((value, index) => value ? "abc"[index] : "").join("") || "off"}</strong></span>}
              </div>
            )}
            <button className="open-button" type="button" disabled={rendering} aria-keyshortcuts="Meta+O Control+O" onClick={showOpen}><Icon name="folder" />Open</button>
            <button
              className="command-button"
              type="button"
              aria-label="Search commands"
              aria-keyshortcuts="Meta+K Control+K"
              aria-haspopup="dialog"
              aria-expanded={commandOpen}
              disabled={rendering}
              title={`Search commands · ${shortcutLabels.commands}`}
              onClick={showCommands}
            ><Icon name="search" /><span>Search</span><kbd>{shortcutLabels.commands}</kbd></button>
            <button
              ref={panelButtonRef}
              className="panel-button"
              type="button"
              aria-label={workbenchVisible && workbenchTab === "view" ? "Hide display controls" : "Show display controls"}
              aria-controls="workbench"
              aria-expanded={workbenchVisible && workbenchTab === "view"}
              disabled={rendering || !capabilities}
              onClick={() => workbenchVisible && workbenchTab === "view" ? closeWorkbench(false) : openWorkbench("view", true)}
            ><Icon name="sliders" /><span>View</span></button>
            <button className="render-button" type="button" disabled={!canRender || rendering} aria-keyshortcuts="Meta+Shift+S Control+Shift+S" onClick={showRender}><Icon name="image" />{rendering ? "Exporting…" : "Figure"}</button>
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

        {manifest && capabilities && <aside ref={workbenchRef} className={workbenchTab === "inspect" ? "workbench atom-card" : "workbench"} id="workbench" aria-labelledby="workbench-title" hidden={!workbenchVisible} tabIndex={-1}>
          <div className="workbench-heading">
            <strong id="workbench-title">{workbenchTab === "view" ? "View" : selectedAtom === null ? "Atom" : `${atomSymbol(manifest, selectedAtom)} · ${selectedAtom + 1}`}</strong>
            <button className="icon-button" type="button" disabled={rendering} onClick={() => {
              closeWorkbench(true);
            }} aria-label="Close"><Icon name="close" /></button>
          </div>
          <div className="workbench-body">
            {workbenchTab === "view" && <ScenePanel
              presentation={presentation}
              capabilities={capabilities}
              cellAvailable={cellAvailable}
              forceAvailable={forceAvailable}
              velocityAvailable={velocityAvailable}
              forceScale={forceScale}
              velocityScale={velocityScale}
              onPresentation={updatePresentation}
              onForceScale={setForceScale}
              onVelocityScale={setVelocityScale}
            />}
            {workbenchTab === "inspect" && <Inspector
              manifest={manifest}
              frame={frame}
              selectedAtom={selectedAtom}
              selectedPosition={selectedPosition(selectionPositions, selectedAtoms.length - 1)}
              cellAvailable={cellAvailable}
            />}
          </div>
        </aside>}

        {manifest && selectedAtoms.length > 0 && (
          <SelectionBar
            manifest={manifest}
            frame={frame}
            selectedAtoms={selectedAtoms}
            displayedPositions={selectionPositions}
            minimumImage={minimumImage}
            canPlot={canPlotMeasurement}
            plotOpen={measurementPlotOpen}
            onMinimumImage={() => setMinimumImage((current) => !current)}
            onPlot={() => measurementPlotOpen
              ? closeMeasurementPlot(false)
              : showMeasurementPlot()}
            onClear={() => {
              setSelectedAtoms([]);
              setSelectionPositions(null);
              closeMeasurementPlot(false);
            }}
            onDetails={() => workbenchVisible && workbenchTab === "inspect"
              ? closeWorkbench(false)
              : openWorkbench("inspect", true)}
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
            onMode={(mode) => {
              setPlaybackMode(mode);
              setPlaybackDirection(1);
            }}
          />
        )}

        {loadState === "loading" && <CenteredState title="Opening trajectory" busy />}
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
            title={manifest.name === "No trajectory" ? "Open a trajectory" : "No frames found"}
            detail="Drop a trajectory or open one from disk."
            action="Open"
            onAction={showOpen}
          />
        )}
        {notice && <div className={opening || rendering ? "notice is-busy" : "notice"} role="status" title={notice}>{notice}</div>}
        {dropActive && <DropOverlay replacing={Boolean(manifest)} />}
        {commandOpen && <CommandPalette
          actions={commands}
          contextIds={commandContextIds}
          recentIds={recentCommandIds}
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
  detail?: string;
  disabled?: boolean;
  run: () => void;
}

export function filterCommandActions<T extends { label: string; keywords?: string; detail?: string; disabled?: boolean }>(
  actions: readonly T[],
  query: string,
): T[] {
  const searchable = actions.map((action, index) => ({
    id: `command-${index}`,
    action,
    label: action.label,
    keywords: action.keywords,
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

function restoreFocusWhenAvailable(element: HTMLElement | null) {
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

function CommandPalette({
  actions,
  contextIds,
  recentIds,
  onClose,
}: {
  actions: CommandAction[];
  contextIds: string[];
  recentIds: string[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visible = useMemo(
    () => searchCommandActions(actions, query, { contextIds, recentIds }),
    [actions, contextIds, query, recentIds],
  );

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
    <section ref={panelRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Commands" tabIndex={-1}>
      <label className="command-search"><Icon name="search" /><input
        ref={inputRef}
        value={query}
        placeholder="Search commands"
        aria-label="Search commands"
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
            visible[active]?.run();
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
          className={index === active ? "is-active" : ""}
          onPointerMove={() => setActive(index)}
          onClick={action.run}
        ><span>{action.label}</span>{action.detail && <kbd>{action.detail}</kbd>}</button>)}
        {visible.length === 0 && <p>No commands found</p>}
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
      ],
    },
    {
      title: "View",
      items: [
        ["R", "Fit structure"],
        ["1 / 2 / 3 / 4", "3D / XY / XZ / YZ"],
        ["V", "View controls"],
        ["B", "Bonds / lines"],
        ["C / F / W", "Cell / forces / water"],
      ],
    },
    {
      title: "Workspace",
      items: [
        [shortcutLabels.commands, "Search commands"],
        [shortcutLabels.open, "Open trajectory"],
        [shortcutLabels.export, "Export figure"],
        ["? / Esc", "Shortcuts / close"],
      ],
    },
  ];
  const vimItems: Array<[string, string]> = [
    ["l / h", "Next / previous frame"],
    ["L / H", "Forward / back ten"],
    ["gg / G", "First / last frame"],
    [":", "Search commands"],
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

function ScenePanel({
  presentation,
  capabilities,
  cellAvailable,
  forceAvailable,
  velocityAvailable,
  forceScale,
  velocityScale,
  onPresentation,
  onForceScale,
  onVelocityScale,
}: {
  presentation: ScenePresentation;
  capabilities: SceneCapabilities;
  cellAvailable: boolean;
  forceAvailable: boolean;
  velocityAvailable: boolean;
  forceScale: number;
  velocityScale: number;
  onPresentation: (change: Partial<ScenePresentation>) => void;
  onForceScale: (scale: number) => void;
  onVelocityScale: (scale: number) => void;
}) {
  const modes: RepresentationMode[] = ["ball-stick", "spacefill", "lines", ...(capabilities.ribbon ? ["ribbon" as const] : [])];
  const imagePreset = presentation.images.min[0] === -1 && presentation.images.max[0] === 1
    ? "centered"
    : presentation.images.max.some((value) => value === 1)
      ? "positive"
      : "primary";

  return (
    <div className="scene-panel">
      <section className="workbench-section">
        <span className="section-label">Representation</span>
        <div className="segmented-options representation-options">
          {modes.map((mode) => <button
            key={mode}
            type="button"
            className={presentation.mode === mode ? "is-active" : ""}
            aria-pressed={presentation.mode === mode}
            onClick={() => onPresentation({ mode })}
          >{representationLabel(mode)}</button>)}
        </div>
      </section>

      {(capabilities.water || cellAvailable || forceAvailable || velocityAvailable) && <section className="workbench-section display-toggles">
        <span className="section-label">Overlays</span>
        {capabilities.water && <Toggle label="Water" checked={presentation.water !== "hide"} onChange={(shown) => onPresentation({ water: shown ? "show" : "hide" })} />}
        {cellAvailable && <Toggle label="Cell" checked={presentation.cell} onChange={(cell) => onPresentation({ cell })} />}
        {forceAvailable && <Toggle label="Forces" checked={presentation.forces} onChange={(forces) => onPresentation({ forces })} />}
        {forceAvailable && presentation.forces && <VectorScale label="Force scale" value={forceScale} onChange={onForceScale} />}
        {velocityAvailable && <Toggle label="Velocities" checked={presentation.velocities} onChange={(velocities) => onPresentation({ velocities })} />}
        {velocityAvailable && presentation.velocities && <VectorScale label="Velocity scale" value={velocityScale} onChange={onVelocityScale} />}
      </section>}

      {cellAvailable && <section className="workbench-section">
        <span className="section-label">Periodic system</span>
        <div className="segmented-options">
          {([
            ["atom", "Wrap atoms"],
            ["molecule", "Whole molecules"],
            ["none", "Original"],
          ] as const).map(([wrap, label]) => <button
            key={wrap}
            type="button"
            className={presentation.wrap === wrap ? "is-active" : ""}
            aria-pressed={presentation.wrap === wrap}
            onClick={() => onPresentation({ wrap })}
          >{label}</button>)}
        </div>
        <span className="section-label section-label-spaced">Images</span>
        <div className="segmented-options">
          <button type="button" className={imagePreset === "primary" ? "is-active" : ""} aria-pressed={imagePreset === "primary"} onClick={() => onPresentation({ images: { min: [0, 0, 0], max: [0, 0, 0] } })}>Primary</button>
          <button type="button" className={imagePreset === "positive" ? "is-active" : ""} aria-pressed={imagePreset === "positive"} onClick={() => onPresentation({ images: { min: [0, 0, 0], max: [1, 1, 1] } })}>+abc</button>
          <button type="button" className={imagePreset === "centered" ? "is-active" : ""} aria-pressed={imagePreset === "centered"} onClick={() => onPresentation({ images: { min: [-1, -1, -1], max: [1, 1, 1] } })}>±abc</button>
        </div>
      </section>}
    </div>
  );
}

function VectorScale({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return <label className="vector-scale-row">
    <span>{label}</span>
    <input type="range" min={0.1} max={3} step={0.1} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    <output>{value.toFixed(1)}×</output>
  </label>;
}

function Toggle({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <div className={disabled ? "toggle-row is-disabled" : "toggle-row"}>
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
  return <div className="drop-overlay" role="status"><div><Icon name="folder" /><strong>{replacing ? "Replace trajectory" : "Open trajectory"}</strong><span>Drop XYZ and PQ companion files</span></div></div>;
}

function SelectionBar({
  manifest,
  frame,
  selectedAtoms,
  displayedPositions,
  minimumImage,
  canPlot,
  plotOpen,
  onMinimumImage,
  onPlot,
  onClear,
  onDetails,
}: {
  manifest: Manifest;
  frame: FrameData | null;
  selectedAtoms: AtomSelection[];
  displayedPositions: Float64Array | null;
  minimumImage: boolean;
  canPlot: boolean;
  plotOpen: boolean;
  onMinimumImage: () => void;
  onPlot: () => void;
  onClear: () => void;
  onDetails: () => void;
}) {
  const validSelections = selectedAtoms.filter(
    ({ atom }) => atom >= 0 && atom < manifest.topology.atom_count,
  );
  const validAtoms = validSelections.map(({ atom }) => atom);
  const cell = frameArray(frame, ["cell", "cell_vectors", "box"]);
  const pbc = measurementPbc(frame);
  const periodicMeasurement = Boolean(
    cell
    && pbc.some(Boolean)
    && validSelections.length >= 2
    && validSelections.length <= 4,
  );
  const supportsDisplayedImages = periodicMeasurement;
  const measurementPositions = displayedPositions
    && displayedPositions.length === validSelections.length * 3
    && validSelections.length === selectedAtoms.length
    ? displayedPositions
    : null;
  const measurement = measurementPositions
    ? measureAtomSelection(
        measurementPositions,
        validSelections.map((_, index) => index),
        periodicMeasurement && (!supportsDisplayedImages || minimumImage) && cell
          ? { mode: "minimum-image", cell, pbc }
          : { mode: "direct" },
      )
    : null;
  const atomLabels = validSelections.map((selection) => atomSelectionLabel(manifest, selection));
  let title = validAtoms.length === 1 ? atomLabels[0] : `${validAtoms.length} atoms`;
  let value = "";

  if (measurement?.ok) {
    title = `${measurement.kind[0].toUpperCase()}${measurement.kind.slice(1)} · ${atomLabels.join("–")}`;
    value = `${formatNumber(measurement.value)} ${measurement.unit === "angstrom" ? "Å" : "°"}`;
  } else if (validAtoms.length === 1 && measurementPositions) {
    value = [measurementPositions[0], measurementPositions[1], measurementPositions[2]]
      .map((coordinate) => formatNumber(coordinate))
      .join("  ");
  } else if (validAtoms.length > 1) {
    value = atomLabels.slice(0, 4).join(" · ");
    if (validAtoms.length > 4) value += ` · +${validAtoms.length - 4}`;
  }

  return <section className="selection-bar" aria-label="Atom selection">
    <div className="selection-readout">
      <strong>{title}</strong>
      {value && <output>{value}</output>}
    </div>
    {supportsDisplayedImages ? (
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
      <span className="selection-hint">Shift-click or tap more</span>
    ) : null}
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
    {validSelections.length === 1 && (
      <button type="button" onClick={onDetails}>Details</button>
    )}
    <button className="icon-button" type="button" onClick={onClear} aria-label="Clear selection"><Icon name="close" /></button>
  </section>;
}

function Inspector({
  manifest,
  frame,
  selectedAtom,
  selectedPosition,
  cellAvailable,
}: {
  manifest: Manifest;
  frame: FrameData | null;
  selectedAtom: number | null;
  selectedPosition: Float64Array | null;
  cellAvailable: boolean;
}) {
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
  return <div className="inspector-content">
    {atom === null ? <p className="quiet-copy">Click an atom to inspect it.</p> : <section className="readout-section atom-section">
      <Readout label="Element" value={symbol ?? "—"} />
      {manifest.topology.atom_names?.[atom] && <Readout label="Name" value={manifest.topology.atom_names[atom]} />}
      {residue && <Readout label="Residue" value={`${residue.name ?? `Type ${residue.type_id ?? "—"}`} · ${residue.index + 1}`} />}
      {!residue && manifest.topology.residue_ids?.[atom] !== undefined && <Readout label="Residue type" value={String(manifest.topology.residue_ids[atom])} />}
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
    </section>}
  </div>;
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
  onFrame,
  onPlay,
  onFps,
  onStride,
  onOptionsOpen,
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
  onFrame: (index: number) => void;
  onPlay: () => void;
  onFps: (fps: number) => void;
  onStride: (stride: number) => void;
  onOptionsOpen: (open: boolean) => void;
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
            <label><span>Speed</span><select value={fps} onChange={(event) => onFps(Number(event.target.value))}>
              {[1, 5, 10, 12, 15, 24, 30, 60].map((value) => <option key={value} value={value}>{value} fps</option>)}
            </select></label>
            <label><span>Stride</span><select value={stride} onChange={(event) => onStride(Number(event.target.value))}>
              {[1, 2, 5, 10].map((value) => <option key={value} value={value}>{value} frame{value === 1 ? "" : "s"}</option>)}
            </select></label>
            <span className="section-label">Playback</span>
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

export function measurementPbc(frame: FrameData | null): [boolean, boolean, boolean] {
  const values = frame?.header.pbc;
  if (Array.isArray(values) && values.length === 3) {
    return [Boolean(values[0]), Boolean(values[1]), Boolean(values[2])];
  }
  return framePbc(frame);
}

export function selectionVisibleInImages(
  selection: AtomSelection,
  minimum: CellOffset,
  maximum: CellOffset,
  pbc: readonly [boolean, boolean, boolean],
): boolean {
  return selection.image.every((value, axis) => {
    if (!pbc[axis]) return value === 0;
    const low = Math.min(minimum[axis], maximum[axis]);
    const high = Math.max(minimum[axis], maximum[axis]);
    return value >= low && value <= high;
  });
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

function Icon({ name }: { name: IconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {name === "folder" && <path d="M4 7.5h6l1.6 2H20v8.5H4V7.5Z" {...common} />}
      {name === "image" && <><rect x="4" y="5" width="16" height="14" rx="2" {...common} /><circle cx="9" cy="10" r="1.5" {...common} /><path d="m6.5 17 4.2-4 2.6 2.4 2.2-2 2 1.8" {...common} /></>}
      {name === "sliders" && <><path d="M5 7h5m4 0h5M5 17h3m4 0h7" {...common} /><circle cx="12" cy="7" r="2" {...common} /><circle cx="10" cy="17" r="2" {...common} /></>}
      {name === "play" && <path d="m9 7 7 5-7 5V7Z" fill="currentColor" />}
      {name === "pause" && <><path d="M9 7v10M15 7v10" {...common} strokeWidth="2" /></>}
      {name === "first" && <><path d="M7.5 7v10" {...common} /><path d="m16 8-5 4 5 4" {...common} /></>}
      {name === "back" && <path d="m14.5 8-5 4 5 4" {...common} />}
      {name === "next" && <path d="m9.5 8 5 4-5 4" {...common} />}
      {name === "last" && <><path d="M16.5 7v10" {...common} /><path d="m8 8 5 4-5 4" {...common} /></>}
      {name === "more" && <><circle cx="7" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="17" cy="12" r="1" fill="currentColor" /></>}
      {name === "search" && <><circle cx="10.5" cy="10.5" r="5.5" {...common} /><path d="m14.6 14.6 4 4" {...common} /></>}
      {name === "close" && <path d="m8 8 8 8m0-8-8 8" {...common} />}
      {name === "retry" && <><path d="M18 9a7 7 0 1 0 .5 5" {...common} /><path d="M18 5v4h-4" {...common} /></>}
    </svg>
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
  return manifest.topology.symbols?.[index] ?? elementSymbols[manifest.topology.atomic_numbers?.[index] ?? 0] ?? "X";
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
  } as const)[mode];
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
    ? autoProfile(capabilities, forceAvailable, hasSeries)
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
    forces: false,
    velocities: false,
    color: capabilities.ribbon ? "residue" : "element",
  };
  if (profile === "crystal") return {
    ...current,
    mode: "ball-stick",
    water: "show",
    hydrogens: true,
    wrap: "atom",
    images: unit,
    cell: cellAvailable,
    forces: false,
    velocities: false,
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
    forces: forceAvailable,
    velocities: false,
    color: "element",
  };
}

function renderFileName(name: string | undefined, width: number, height: number): string {
  const base = (name ?? "molecule")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "molecule";
  return `${base}-${width}x${height}.png`;
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
  extension: "csv" | "svg",
): string {
  const base = (name ?? "trajectory")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "trajectory";
  return `${base}-${kind}.${extension}`;
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

function browserPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const navigatorWithHints = navigator as Navigator & { userAgentData?: { platform?: string } };
  return navigatorWithHints.userAgentData?.platform || navigator.platform || navigator.userAgent;
}

function initialPresentation(): ScenePresentation {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("pqviewer-presentation") ?? "null") as Partial<ScenePresentation> | null;
    if (!parsed || typeof parsed !== "object") return defaultPresentation;
    const modes: RepresentationMode[] = ["ball-stick", "spacefill", "lines", "ribbon"];
    return {
      mode: modes.includes(parsed.mode as RepresentationMode) ? parsed.mode as RepresentationMode : defaultPresentation.mode,
      water: parsed.water === "hide" ? "hide" : "show",
      hydrogens: defaultPresentation.hydrogens,
      wrap: defaultPresentation.wrap,
      images: defaultPresentation.images,
      cell: typeof parsed.cell === "boolean" ? parsed.cell : defaultPresentation.cell,
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

const elementSymbols = [
  "X", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar",
  "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr",
];
