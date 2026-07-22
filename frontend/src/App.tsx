import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { frameArray, FrameCache, getManifest, normalizeSeries, openFiles } from "./api";
import { centeredFramePositions, framePbc, hasFrameCell, MoleculeScene } from "./MoleculeScene";
import type { MoleculeSceneHandle, PngExportOptions, RenderedSceneInfo, ViewPreset } from "./MoleculeScene";
import { advanceFrameIndex, parseVimPreference, resolveVimNavigation, shortcutLabelsForPlatform } from "./keyboard";
import type { VimNavigationAction, VimPrefix, ViewerShortcutLabels } from "./keyboard";
import { MAX_PNG_EXPORT_PIXELS } from "./scene/pngExport";
import type {
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
type PlaybackMode = "keep-frames" | "drop-frames";
type SceneProfile = "auto" | "molecule" | "protein" | "crystal" | "trajectory" | "custom";
type WorkbenchTab = "view" | "inspect";
type WorkspacePresentationDefaults = Partial<Pick<ScenePresentation, "wrap" | "color">>;
type ForceVectorStats = { rendered: number; total: number };
type IconName = "back" | "chevron" | "close" | "cube" | "folder" | "image" | "more" | "next" | "pause" | "play" | "retry" | "search" | "sliders";

const defaultPresentation: ScenePresentation = {
  mode: "ball-stick",
  water: "show",
  hydrogens: true,
  wrap: "molecule",
  images: { min: [0, 0, 0], max: [0, 0, 0] },
  cell: true,
  forces: true,
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
  const [speed, setSpeed] = useState(1);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>(initialPlaybackMode);
  const [presentation, setPresentation] = useState<ScenePresentation>(initialPresentation);
  const [workspacePresentationDefaults, setWorkspacePresentationDefaults] = useState<WorkspacePresentationDefaults>(initialWorkspacePresentationDefaults);
  const [profile, setProfile] = useState<SceneProfile>("auto");
  const [selectedAtom, setSelectedAtom] = useState<number | null>(null);
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab | null>(null);
  const [workbenchExpanded, setWorkbenchExpanded] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [viewPreset, setViewPreset] = useState<ViewPreset>("perspective");
  const [viewSignal, setViewSignal] = useState(0);
  const [seriesName, setSeriesName] = useState("");
  const [forceScale, setForceScale] = useState(1);
  const [appearance, setAppearance] = useState<Appearance>(initialAppearance);
  const [moreOpen, setMoreOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [renderOpen, setRenderOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderValid, setRenderValid] = useState(true);
  const [vimMode, setVimMode] = useState(initialVimMode);
  const [dropActive, setDropActive] = useState(false);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState("");
  const [sceneInfo, setSceneInfo] = useState<RenderedSceneInfo | null>(null);
  const [renderAspect, setRenderAspect] = useState(4 / 3);
  const cache = useRef(new FrameCache());
  const moleculeSceneRef = useRef<MoleculeSceneHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const panelButtonRef = useRef<HTMLButtonElement>(null);
  const inspectButtonRef = useRef<HTMLButtonElement>(null);
  const renderButtonRef = useRef<HTMLButtonElement>(null);
  const renderSheetRef = useRef<HTMLElement>(null);
  const workbenchRef = useRef<HTMLElement>(null);
  const workbenchTriggerRef = useRef<WorkbenchTab>("view");
  const vimSequenceRef = useRef<{ prefix: VimPrefix; at: number }>({ prefix: null, at: 0 });
  const dragDepth = useRef(0);
  const autoProfileKey = useRef("");
  const latestFrameTarget = useRef(0);
  const dropFrameWorker = useRef<{ cancelled: boolean; manifest: Manifest } | null>(null);
  const openRequest = useRef(0);
  const openController = useRef<AbortController | null>(null);
  const shortcutLabels = useMemo(() => shortcutLabelsForPlatform(browserPlatform()), []);

  const activateManifest = useCallback((value: Manifest) => {
    if (dropFrameWorker.current) dropFrameWorker.current.cancelled = true;
    dropFrameWorker.current = null;
    cache.current.clear();
    setManifest(value);
    setFrameIndex(0);
    setLoadedFrame(null);
    setSelectedAtom(null);
    setForceScale(1);
    setPlaying(false);
    setSceneInfo(null);
    setLoadState("ready");
    setLoadError("");
    setProfile("auto");
    autoProfileKey.current = "";
    document.title = `${value.name || "Trajectory"} · PQViewer`;
  }, []);

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance;
    document.documentElement.style.colorScheme = appearance;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", appearance === "light" ? "#f6f8f8" : "#1e2e33");
    try {
      window.localStorage.setItem("pqviewer-appearance", appearance);
    } catch {}
  }, [appearance]);

  useEffect(() => {
    try {
      window.localStorage.setItem("pqviewer-presentation", JSON.stringify(presentation));
      window.localStorage.setItem("pqviewer-playback", playbackMode);
    } catch {}
  }, [playbackMode, presentation]);

  useEffect(() => {
    try {
      if (Object.keys(workspacePresentationDefaults).length === 0) {
        window.localStorage.removeItem("pqviewer-workspace-presentation");
      } else {
        window.localStorage.setItem("pqviewer-workspace-presentation", JSON.stringify(workspacePresentationDefaults));
      }
    } catch {}
  }, [workspacePresentationDefaults]);

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
    if (rendering) {
      if (dropFrameWorker.current) dropFrameWorker.current.cancelled = true;
      dropFrameWorker.current = null;
      return;
    }
    latestFrameTarget.current = frameIndex;

    if (playbackMode === "drop-frames") {
      const currentWorker = dropFrameWorker.current;
      if (currentWorker?.manifest === manifest && !currentWorker.cancelled) return;
      if (currentWorker) currentWorker.cancelled = true;

      const worker = { cancelled: false, manifest };
      dropFrameWorker.current = worker;
      setFrameLoading(true);
      setFrameError("");

      const loadLatest = async () => {
        try {
          while (!worker.cancelled) {
            const requested = latestFrameTarget.current;
            cache.current.cancelPendingExcept(requested);
            const data = await cache.current.get(requested);
            if (worker.cancelled) return;
            setLoadedFrame({ index: requested, data });
            if (latestFrameTarget.current === requested) break;
          }
          if (!worker.cancelled && dropFrameWorker.current === worker) {
            dropFrameWorker.current = null;
            setFrameLoading(false);
          }
        } catch (error) {
          if (worker.cancelled || dropFrameWorker.current !== worker) return;
          dropFrameWorker.current = null;
          setFrameError(message(error));
          setFrameLoading(false);
          setPlaying(false);
        }
      };
      void loadLatest();
      return;
    }

    if (dropFrameWorker.current) dropFrameWorker.current.cancelled = true;
    dropFrameWorker.current = null;
    let active = true;
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
        setFrameError(message(error));
        setFrameLoading(false);
        setPlaying(false);
      });
    return () => {
      active = false;
    };
  }, [frameIndex, manifest, playbackMode, rendering]);

  const series = useMemo(() => normalizeSeries(manifest?.series), [manifest?.series]);
  useEffect(() => {
    if (!series.some((entry) => entry.name === seriesName)) setSeriesName(series[0]?.name ?? "");
  }, [series, seriesName]);

  const setFrame = useCallback(
    (value: number) => {
      if (!manifest?.frame_count) return;
      setFrameIndex(Math.max(0, Math.min(manifest.frame_count - 1, Math.round(value))));
    },
    [manifest?.frame_count],
  );

  const stepFrame = useCallback(
    (delta: number) => {
      if (!manifest?.frame_count) return;
      setFrameIndex((current) => advanceFrameIndex(current, delta, manifest.frame_count));
    },
    [manifest?.frame_count],
  );

  const selectView = useCallback((preset: ViewPreset) => {
    setViewPreset(preset);
    setViewSignal((value) => value + 1);
  }, []);

  const focusWorkbench = useCallback(() => {
    requestAnimationFrame(() => workbenchRef.current?.focus());
  }, []);

  const openWorkbench = useCallback((tab: WorkbenchTab, focus = false) => {
    workbenchTriggerRef.current = tab;
    setRenderOpen(false);
    setWorkbenchTab(tab);
    if (focus) focusWorkbench();
  }, [focusWorkbench]);

  const closeWorkbench = useCallback((restoreFocus = false) => {
    setWorkbenchTab(null);
    setWorkbenchExpanded(false);
    if (restoreFocus) requestAnimationFrame(() => {
      const trigger = workbenchTriggerRef.current === "inspect" ? inspectButtonRef.current : panelButtonRef.current;
      (trigger?.offsetParent ? trigger : moreButtonRef.current)?.focus();
    });
  }, []);

  const selectAtom = useCallback((index: number | null) => {
    setSelectedAtom(index);
    if (index !== null) {
      workbenchTriggerRef.current = "inspect";
      setRenderOpen(false);
      setWorkbenchTab("inspect");
    }
  }, []);

  const showOpen = useCallback(() => {
    if (rendering) return;
    setMoreOpen(false);
    setCommandOpen(false);
    setPreferencesOpen(false);
    setShortcutsOpen(false);
    setRenderOpen(false);
    fileInputRef.current?.click();
  }, [rendering]);

  const showCommands = useCallback(() => {
    if (rendering) return;
    setMoreOpen(false);
    setPreferencesOpen(false);
    setShortcutsOpen(false);
    setRenderOpen(false);
    setCommandOpen(true);
  }, [rendering]);

  const showPreferences = useCallback(() => {
    if (rendering) return;
    setMoreOpen(false);
    setCommandOpen(false);
    setShortcutsOpen(false);
    setRenderOpen(false);
    setPreferencesOpen(true);
  }, [rendering]);

  const showShortcuts = useCallback(() => {
    if (rendering) return;
    setMoreOpen(false);
    setCommandOpen(false);
    setPreferencesOpen(false);
    setRenderOpen(false);
    setShortcutsOpen(true);
  }, [rendering]);

  const showRender = useCallback(() => {
    if (!moleculeSceneRef.current || !sceneInfo?.capabilities || !loadedFrame?.data || frameLoading || rendering) return;
    setMoreOpen(false);
    setCommandOpen(false);
    setPreferencesOpen(false);
    setShortcutsOpen(false);
    setPlaying(false);
    setRenderOpen(true);
    requestAnimationFrame(() => renderSheetRef.current?.focus());
  }, [frameLoading, loadedFrame?.data, rendering, sceneInfo?.capabilities]);

  const closeRender = useCallback((restoreFocus = false) => {
    if (rendering) return;
    setRenderOpen(false);
    if (restoreFocus) requestAnimationFrame(() => renderButtonRef.current?.focus());
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
  const cellAvailable = hasFrameCell(frame);
  const forces = frameArray(frame, ["forces", "force"]);
  const forceAvailable = Boolean(forces && forces.length >= (manifest?.topology.atom_count ?? 0) * 3);
  const pbc = framePbc(frame);
  const capabilities = sceneInfo?.capabilities ?? null;
  const forceVectorStats = sceneInfo
    ? { rendered: sceneInfo.forceCount, total: sceneInfo.forceTotal }
    : null;
  const activeSeries = series.find((entry) => entry.name === seriesName) ?? null;
  const canPlay = (manifest?.frame_count ?? 0) > 1;
  const canRender = Boolean(frame && capabilities && !frameLoading);
  const workbenchVisible = Boolean(!renderOpen && workbenchTab && manifest && capabilities);

  const updatePresentation = useCallback((change: Partial<ScenePresentation>) => {
    setPresentation((current) => ({ ...current, ...change }));
    setProfile("custom");
  }, []);

  const updateWorkspacePresentation = useCallback((change: Partial<ScenePresentation>) => {
    if (change.wrap !== undefined || change.color !== undefined) {
      setWorkspacePresentationDefaults((current) => ({
        ...current,
        ...(change.wrap !== undefined ? { wrap: change.wrap } : {}),
        ...(change.color !== undefined ? { color: change.color } : {}),
      }));
    }
    updatePresentation(change);
  }, [updatePresentation]);

  const chooseProfile = useCallback((nextProfile: Exclude<SceneProfile, "custom">) => {
    if (!capabilities) return;
    setPresentation((current) => selectedProfilePresentation(
      nextProfile,
      current,
      cellAvailable,
      forceAvailable,
      series.length > 0,
      capabilities,
      workspacePresentationDefaults,
    ));
    setProfile(nextProfile);
    setResetSignal((value) => value + 1);
  }, [capabilities, cellAvailable, forceAvailable, series.length, workspacePresentationDefaults]);

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
      series.length > 0,
      capabilities,
      workspacePresentationDefaults,
    ));
  }, [capabilities, cellAvailable, forceAvailable, frame, manifest, profile, series.length, workspacePresentationDefaults]);

  useEffect(() => {
    if (!moreOpen) return;
    const closeMenus = (event: PointerEvent) => {
      const target = event.target as Node;
      if (moreOpen && !moreMenuRef.current?.contains(target)) setMoreOpen(false);
    };
    window.addEventListener("pointerdown", closeMenus);
    return () => window.removeEventListener("pointerdown", closeMenus);
  }, [moreOpen]);

  useEffect(() => {
    if (!playing || rendering || !manifest || manifest.frame_count < 2) return;
    const interval = 100 / speed;
    if (playbackMode === "keep-frames") {
      if (frameLoading || loadedFrame?.index !== frameIndex) return;
      const timer = window.setTimeout(
        () => setFrameIndex((current) => (current + 1) % manifest.frame_count),
        interval,
      );
      return () => window.clearTimeout(timer);
    }
    let animation = 0;
    let previous = performance.now();
    let elapsed = 0;
    const tick = (now: number) => {
      elapsed += now - previous;
      previous = now;
      if (elapsed >= interval) {
        const steps = Math.floor(elapsed / interval);
        elapsed -= steps * interval;
        setFrameIndex((current) => (current + steps) % manifest.frame_count);
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [frameIndex, frameLoading, loadedFrame?.index, manifest, playbackMode, playing, rendering, speed]);

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

  const dismissActive = useCallback(() => {
    vimSequenceRef.current = { prefix: null, at: 0 };
    if (commandOpen) setCommandOpen(false);
    else if (shortcutsOpen) setShortcutsOpen(false);
    else if (preferencesOpen) setPreferencesOpen(false);
    else if (moreOpen) setMoreOpen(false);
    else if (renderOpen && !rendering) closeRender(true);
    else if (workbenchTab === "inspect" && selectedAtom !== null) setSelectedAtom(null);
    else if (workbenchTab && !rendering) closeWorkbench(true);
    else if (selectedAtom !== null) setSelectedAtom(null);
  }, [closeRender, closeWorkbench, commandOpen, moreOpen, preferencesOpen, renderOpen, rendering, selectedAtom, shortcutsOpen, workbenchTab]);

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
      if (primaryModifier && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        showCommands();
        return;
      }
      if (primaryModifier && !event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        showOpen();
        return;
      }
      if (primaryModifier && !event.shiftKey && (event.key === "," || event.code === "Comma")) {
        event.preventDefault();
        showPreferences();
        return;
      }
      if (rendering) return;
      if (vimMode && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === "[") {
        event.preventDefault();
        dismissActive();
        return;
      }
      if (event.key === "Escape") {
        dismissActive();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextEditingTarget(target)) return;
      if (isActivationTarget(target) && (event.key === "Enter" || event.code === "Space")) return;
      if (event.key === "/") {
        event.preventDefault();
        if (!event.repeat) showCommands();
      } else if (event.key === "?") {
        event.preventDefault();
        if (!event.repeat) showShortcuts();
      } else if (commandOpen || moreOpen || preferencesOpen || shortcutsOpen) {
        return;
      } else if (vimMode) {
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
      if (event.key.toLowerCase() === "i" && capabilities && !event.repeat) {
        if (workbenchVisible && workbenchTab === "inspect") closeWorkbench(true);
        else openWorkbench("inspect", true);
      } else if (event.key.toLowerCase() === "v" && capabilities && !event.repeat) {
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
      } else if ((event.key === "Home" || event.key.toLowerCase() === "r") && !event.repeat) {
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
    preferencesOpen,
    dismissActive,
    forceAvailable,
    manifest?.frame_count,
    moreOpen,
    openWorkbench,
    presentation,
    rendering,
    runVimNavigation,
    selectView,
    selectedAtom,
    setFrame,
    stepFrame,
    shortcutsOpen,
    showCommands,
    showOpen,
    showPreferences,
    showRender,
    showShortcuts,
    updatePresentation,
    vimMode,
    workbenchTab,
    workbenchVisible,
  ]);

  const commands = useMemo<CommandAction[]>(() => {
    const run = (action: () => void) => () => {
      action();
      setCommandOpen(false);
    };
    return [
      { id: "open", label: "Open trajectory", detail: shortcutLabels.open, run: run(showOpen) },
      { id: "fit", label: "Fit structure", detail: "R", run: run(() => setResetSignal((value) => value + 1)) },
      { id: "export", label: "Export PNG", detail: shortcutLabels.render, disabled: !canRender, run: run(showRender) },
      ...(["perspective", "xy", "xz", "yz"] as ViewPreset[]).map((view, index) => ({
        id: `view-${view}`,
        label: view === "perspective" ? "Perspective view" : `${view.toUpperCase()} view`,
        detail: String(index + 1),
        run: run(() => selectView(view)),
      })),
      ...(["ball-stick", "spacefill", "licorice", "lines", "ribbon"] as RepresentationMode[]).map((mode) => ({
        id: `mode-${mode}`,
        label: `Representation · ${representationLabel(mode)}`,
        detail: mode === presentation.mode ? "Current" : "",
        disabled: mode === "ribbon" && !capabilities?.ribbon,
        run: run(() => updatePresentation({ mode })),
      })),
      { id: "water", label: presentation.water === "hide" ? "Show water" : "Hide water", detail: "W", disabled: !capabilities?.water, run: run(() => updatePresentation({ water: presentation.water === "hide" ? "show" : "hide" })) },
      { id: "cell", label: presentation.cell ? "Hide cell" : "Show cell", detail: "C", disabled: !cellAvailable, run: run(() => updatePresentation({ cell: !presentation.cell })) },
      { id: "forces", label: presentation.forces ? "Hide forces" : "Show forces", detail: "F", disabled: !forceAvailable, run: run(() => updatePresentation({ forces: !presentation.forces })) },
      { id: "view", label: workbenchVisible && workbenchTab === "view" ? "Hide view controls" : "Show view controls", detail: "V", disabled: !capabilities, run: run(() => workbenchVisible && workbenchTab === "view" ? closeWorkbench() : openWorkbench("view")) },
      { id: "inspect", label: workbenchVisible && workbenchTab === "inspect" ? "Hide inspector" : "Show inspector", detail: "I", disabled: !capabilities, run: run(() => workbenchVisible && workbenchTab === "inspect" ? closeWorkbench() : openWorkbench("inspect")) },
      { id: "appearance", label: `Use ${appearance === "light" ? "dark" : "light"} appearance`, run: run(() => setAppearance((value) => value === "light" ? "dark" : "light")) },
      { id: "preferences", label: "Preferences", detail: shortcutLabels.preferences, run: run(showPreferences) },
      { id: "shortcuts", label: "Keyboard shortcuts", detail: "?", run: run(showShortcuts) },
    ];
  }, [appearance, canRender, capabilities, cellAvailable, closeWorkbench, forceAvailable, openWorkbench, presentation, selectView, shortcutLabels, showOpen, showPreferences, showRender, showShortcuts, updatePresentation, workbenchTab, workbenchVisible]);
  const workspaceClass = [
    "workspace",
    workbenchVisible ? "workbench-open" : "workbench-closed",
    renderOpen ? "export-open" : "export-closed",
    rendering ? "is-rendering" : "",
    series.length === 0 ? "timeline-compact" : "",
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
            selectedAtom={selectedAtom}
            resetSignal={resetSignal}
            forceScale={forceScale}
            appearance={appearance}
            viewPreset={viewPreset}
            viewSignal={viewSignal}
            onSelect={selectAtom}
            onSceneInfo={setSceneInfo}
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
            <button className="open-button" type="button" disabled={rendering} aria-keyshortcuts="Meta+O Control+O" title={`Open · ${shortcutLabels.open}`} onClick={showOpen}><Icon name="folder" />Open</button>
            <button
              ref={panelButtonRef}
              className="panel-button"
              type="button"
              aria-label={workbenchVisible && workbenchTab === "view" ? "Hide view controls" : "Show view controls"}
              aria-controls="workbench"
              aria-expanded={workbenchVisible && workbenchTab === "view"}
              disabled={rendering || !capabilities}
              onClick={() => workbenchVisible && workbenchTab === "view" ? closeWorkbench(false) : openWorkbench("view", true)}
            ><Icon name="sliders" /><span>View</span></button>
            <button
              ref={inspectButtonRef}
              className="inspect-button"
              type="button"
              aria-label={workbenchVisible && workbenchTab === "inspect" ? "Hide inspector" : "Show inspector"}
              aria-controls="workbench"
              aria-expanded={workbenchVisible && workbenchTab === "inspect"}
              disabled={rendering || !capabilities}
              onClick={() => workbenchVisible && workbenchTab === "inspect" ? closeWorkbench(false) : openWorkbench("inspect", true)}
            ><span>Inspect</span></button>
            <button ref={renderButtonRef} className="render-button" type="button" disabled={!canRender || rendering} aria-controls="export-sheet" aria-expanded={renderOpen} aria-keyshortcuts="Meta+Shift+S Control+Shift+S" onClick={showRender}><Icon name="image" />Export</button>
            <button className="command-button" type="button" disabled={rendering} aria-label="Search commands" aria-keyshortcuts="Meta+K Control+K" title={`Commands · ${shortcutLabels.commands}`} onClick={showCommands}><Icon name="search" /><kbd>{shortcutLabels.commands}</kbd></button>
            <div className="more-control" ref={moreMenuRef}>
              <button ref={moreButtonRef} className="more-button" type="button" disabled={rendering} aria-label="More" aria-haspopup="menu" aria-controls="more-menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)}><Icon name="more" /></button>
              {moreOpen && <MoreMenu
                canInspect={Boolean(capabilities)}
                shortcutLabels={shortcutLabels}
                triggerRef={moreButtonRef}
                onClose={() => setMoreOpen(false)}
                onCommands={showCommands}
                onInspect={() => { setMoreOpen(false); openWorkbench("inspect", true); }}
                onPreferences={showPreferences}
                onShortcuts={showShortcuts}
              />}
            </div>
          </div>
        </header>

        {manifest && manifest.frame_count > 0 && capabilities && (
          <CanvasControls
            busy={rendering}
            onFit={() => setResetSignal((value) => value + 1)}
            onView={selectView}
            viewPreset={viewPreset}
          />
        )}

        {renderOpen && <RenderGuide aspect={renderAspect} />}

        {manifest && capabilities && <aside ref={workbenchRef} className={workbenchExpanded ? "workbench is-expanded" : "workbench"} id="workbench" aria-labelledby="workbench-title" hidden={!workbenchVisible} tabIndex={-1}>
          <div className="workbench-heading">
            <strong id="workbench-title">{workbenchTab === "view" ? "View" : selectedAtom === null ? "Inspect" : `${atomSymbol(manifest, selectedAtom)} · Atom ${selectedAtom + 1}`}</strong>
            <div className="workbench-heading-actions">
              <button className="workbench-expand-button" type="button" disabled={rendering} aria-expanded={workbenchExpanded} onClick={() => setWorkbenchExpanded((value) => !value)} aria-label={workbenchExpanded ? "Use compact panel" : "Expand panel"}><Icon name="chevron" /></button>
              <button className="icon-button" type="button" disabled={rendering} onClick={() => closeWorkbench(true)} aria-label="Close scientific panel"><Icon name="close" /></button>
            </div>
          </div>
          <div className="workbench-body">
            {workbenchTab === "view" && <ScenePanel
              presentation={presentation}
              capabilities={capabilities}
              pbc={pbc}
              cellAvailable={cellAvailable}
              forceAvailable={forceAvailable}
              forceVectorStats={forceVectorStats}
              renderedImageCount={sceneInfo?.imageCount ?? null}
              forceScale={forceScale}
              onPresentation={updateWorkspacePresentation}
              onForceScale={setForceScale}
            />}
            {workbenchTab === "inspect" && <Inspector
              manifest={manifest}
              frame={frame}
              frameIndex={displayedFrameIndex}
              selectedAtom={selectedAtom}
              series={activeSeries}
              cellAvailable={cellAvailable}
            />}
          </div>
        </aside>}

        <aside ref={renderSheetRef} className="export-sheet" id="export-sheet" aria-labelledby="export-title" aria-busy={rendering} hidden={!renderOpen} tabIndex={-1}>
          <div className="export-heading"><div><strong id="export-title">Export PNG</strong><span>Publication image</span></div><button className="icon-button" type="button" disabled={rendering} onClick={() => closeRender(true)} aria-label="Close export"><Icon name="close" /></button></div>
          <div className="export-body"><RenderPanel
            busy={rendering || frameLoading}
            periodicAvailable={pbc.some(Boolean)
              && presentation.wrap === "atom"
              && presentation.mode !== "spacefill"
              && presentation.mode !== "ribbon"}
            onAspectChange={setRenderAspect}
            onValidityChange={setRenderValid}
            onRender={exportPng}
          /></div>
          <footer className="export-footer">
            <button type="button" disabled={rendering} onClick={() => closeRender(true)}>Close</button>
            <button className="primary" type="submit" form="publication-render-form" disabled={rendering || frameLoading || !renderValid}>{rendering ? "Exporting…" : frameLoading ? "Loading frame…" : "Export PNG"}</button>
          </footer>
        </aside>

        {manifest && manifest.frame_count > 0 && (
          <Timeline
            busy={rendering}
            frameCount={manifest.frame_count}
            frameIndex={displayedFrameIndex}
            playing={playing}
            canPlay={canPlay}
            speed={speed}
            series={series}
            activeSeries={activeSeries}
            frameError={frameError}
            onFrame={(index) => {
              setPlaying(false);
              setFrame(index);
            }}
            onPlay={() => canPlay && setPlaying((value) => !value)}
            onSpeed={setSpeed}
            onSeries={setSeriesName}
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
        {notice && <div className={opening || rendering ? "notice is-busy" : "notice"} role="status">{notice}</div>}
        {dropActive && <DropOverlay replacing={Boolean(manifest)} />}
        {commandOpen && <CommandPalette actions={commands} onClose={() => setCommandOpen(false)} />}
        {preferencesOpen && <PreferencesSheet
          appearance={appearance}
          playbackMode={playbackMode}
          presentation={presentation}
          vimMode={vimMode}
          onAppearance={setAppearance}
          onPlaybackMode={setPlaybackMode}
          onPresentation={(change) => setPresentation((current) => ({ ...current, ...change }))}
          onShortcuts={showShortcuts}
          onVimMode={setVimMode}
          onReset={() => {
            setPresentation((current) => ({ ...current, quality: "auto" }));
            setAppearance("light");
            setPlaybackMode("keep-frames");
            setVimMode(false);
          }}
          onClose={() => setPreferencesOpen(false)}
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
  detail?: string;
  disabled?: boolean;
  run: () => void;
}

function RenderGuide({ aspect }: { aspect: number }) {
  const regionRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      setSize(resolveRenderGuideSize(region.clientWidth, region.clientHeight, aspect));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    measure();
    return () => observer.disconnect();
  }, [aspect]);

  return <div ref={regionRef} className="render-guide-region" aria-hidden="true">
    {size.width > 0 && <div className="render-guide" style={size}><span>Output frame</span></div>}
  </div>;
}

function ScenePanel({
  presentation,
  capabilities,
  pbc,
  cellAvailable,
  forceAvailable,
  forceVectorStats,
  renderedImageCount,
  forceScale,
  onPresentation,
  onForceScale,
}: {
  presentation: ScenePresentation;
  capabilities: SceneCapabilities;
  pbc: [boolean, boolean, boolean];
  cellAvailable: boolean;
  forceAvailable: boolean;
  forceVectorStats: ForceVectorStats | null;
  renderedImageCount: number | null;
  forceScale: number;
  onPresentation: (change: Partial<ScenePresentation>) => void;
  onForceScale: (scale: number) => void;
}) {
  const modes: RepresentationMode[] = ["ball-stick", "spacefill", "licorice", "lines", ...(capabilities.ribbon ? ["ribbon" as const] : [])];
  const setImages = (images: ScenePresentation["images"]) => onPresentation({ images });
  const requestedImageCount = periodicImageCount(presentation.images);
  const imageCount = renderedImageCount ?? requestedImageCount;
  const imagesTruncated = imageCount < requestedImageCount;

  return (
    <div className="scene-panel">
      <section className="workbench-section">
        <h3>Representation</h3>
        <label className="panel-select-row"><span>Representation</span><select value={presentation.mode} onChange={(event) => onPresentation({ mode: event.target.value as RepresentationMode })}>
          {modes.map((mode) => <option key={mode} value={mode}>{representationLabel(mode)}</option>)}
        </select></label>
        <label className="panel-select-row"><span>Color by</span><select value={presentation.color} onChange={(event) => onPresentation({ color: event.target.value as ScenePresentation["color"] })}>
          <option value="element">Element</option>
          <option value="residue">Residue</option>
        </select></label>
        <details className="panel-details">
          <summary>Geometry</summary>
          <div className="geometry-settings">
            <label><span>Atoms <output>{formatScale(presentation.atomScale)}</output></span><input type="range" min={0.55} max={1.6} step={0.05} value={presentation.atomScale} onChange={(event) => onPresentation({ atomScale: Number(event.target.value) })} /></label>
            <label><span>Bonds <output>{formatScale(presentation.bondScale)}</output></span><input type="range" min={0.55} max={1.8} step={0.05} value={presentation.bondScale} onChange={(event) => onPresentation({ bondScale: Number(event.target.value) })} /></label>
          </div>
        </details>
      </section>

      <section className="workbench-section">
        <h3>Components</h3>
        <Toggle label="Hydrogens" checked={presentation.hydrogens} onChange={(hydrogens) => onPresentation({ hydrogens })} />
        {capabilities.water && <div className="choice-row">
          <span>Water</span><div className="mini-segmented" aria-label="Water display">
            {(["show", "hide", "only"] as const).map((water) => <button
              key={water}
              type="button"
              className={presentation.water === water ? "is-active" : ""}
              aria-pressed={presentation.water === water}
              onClick={() => onPresentation({ water })}
            >{displayLabel(water)}</button>)}
          </div>
        </div>}
      </section>

      {cellAvailable && <section className="workbench-section periodic-workbench-section">
        <div className="layer-heading"><div><strong>Periodic cell</strong><span>Fractional cell · −½ to +½</span></div><Toggle label="Cell" checked={presentation.cell} onChange={(cell) => onPresentation({ cell })} /></div>
        <>
          <div className="choice-row"><span>Wrap</span><div className="mini-segmented" aria-label="Periodic wrapping">
            {(["molecule", "atom", "none"] as const).map((wrap) => <button key={wrap} type="button" className={presentation.wrap === wrap ? "is-active" : ""} aria-pressed={presentation.wrap === wrap} onClick={() => onPresentation({ wrap })}>{({ molecule: "Molecules", atom: "Atoms", none: "Unwrapped" } as const)[wrap]}</button>)}
          </div></div>
          <div className="workbench-section-heading image-heading"><h3>Replicas</h3><output>{imagesTruncated ? `${imageCount} / ${requestedImageCount}` : imageCount}</output></div>
          <div className="image-presets" aria-label="Cell image presets">
            {([
              [replicaGridLabel(pbc, 1), periodicImages(pbc, 0, 0)],
              [replicaGridLabel(pbc, 2), periodicImages(pbc, -1, 0)],
              [replicaGridLabel(pbc, 3), periodicImages(pbc, -1, 1)],
            ] as Array<[string, ScenePresentation["images"]]>).map(([label, images]) => <button
              key={label}
              type="button"
              className={sameImages(presentation.images, images) ? "is-active" : ""}
              aria-pressed={sameImages(presentation.images, images)}
              onClick={() => setImages(images)}
            >{label}</button>)}
          </div>
          <details className="panel-details">
            <summary>Custom replica range</summary>
            <div className="image-ranges">
              {(["a", "b", "c"] as const).map((axis, index) => <ImageAxisControl
                key={axis}
                axis={axis}
                periodic={pbc[index]}
                min={presentation.images.min[index]}
                max={presentation.images.max[index]}
                onChange={(min, max) => setImages(withImageAxis(presentation.images, index, min, max))}
              />)}
            </div>
          </details>
          {imagesTruncated && <small className="capability-note">Showing the nearest {imageCount} of {requestedImageCount} requested.</small>}
        </>
      </section>}

      {forceAvailable && <section className="workbench-section force-workbench-section">
        <div className="layer-heading"><div><strong>Forces</strong><span>Per-atom vectors</span></div><Toggle label="Forces" checked={presentation.forces} onChange={(forces) => onPresentation({ forces })} /></div>
        {presentation.forces && <>
          {forceVectorStats && <small className="capability-note">{forceVectorStats.total > forceVectorStats.rendered ? `${forceVectorStats.rendered.toLocaleString()} of ${forceVectorStats.total.toLocaleString()} vectors · evenly sampled` : `${forceVectorStats.total.toLocaleString()} vectors`}</small>}
          <label className="panel-slider"><span>Scale <output>{formatNumber(forceScale)}×</output></span><input type="range" min={0.25} max={4} step={0.25} value={forceScale} onChange={(event) => onForceScale(Number(event.target.value))} /></label>
        </>}
      </section>}
    </div>
  );
}

function ImageAxisControl({
  axis,
  periodic,
  min,
  max,
  onChange,
}: {
  axis: "a" | "b" | "c";
  periodic: boolean;
  min: number;
  max: number;
  onChange: (min: number, max: number) => void;
}) {
  const options = [-2, -1, 0, 1, 2];
  return <label className={periodic ? "image-axis" : "image-axis is-disabled"}>
    <span>{axis}</span>
    <select
      aria-label={`${axis} first image`}
      disabled={!periodic}
      value={periodic ? min : 0}
      onChange={(event) => {
        const value = Number(event.target.value);
        onChange(value, Math.max(value, max));
      }}
    >{options.map((value) => <option key={value} value={value}>{signed(value)}</option>)}</select>
    <i>–</i>
    <select
      aria-label={`${axis} last image`}
      disabled={!periodic}
      value={periodic ? max : 0}
      onChange={(event) => {
        const value = Number(event.target.value);
        onChange(Math.min(min, value), value);
      }}
    >{options.map((value) => <option key={value} value={value}>{signed(value)}</option>)}</select>
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
  onView: (preset: ViewPreset) => void;
}) {
  return <div className="canvas-controls" role="toolbar" aria-label="Camera controls">
    <button type="button" disabled={busy} onClick={onFit}>Fit</button>
    <label className="canvas-view-select"><span className="sr-only">View</span><select aria-label="Camera orientation" value={viewPreset} disabled={busy} onChange={(event) => onView(event.target.value as ViewPreset)}>
      <option value="perspective">3D</option>
      <option value="xy">XY</option>
      <option value="xz">XZ</option>
      <option value="yz">YZ</option>
    </select></label>
    <OrientationControl preset={viewPreset} busy={busy} onView={onView} />
  </div>;
}

function OrientationControl({ preset, busy, onView }: { preset: ViewPreset; busy: boolean; onView: (preset: ViewPreset) => void }) {
  const views: Array<{ id: ViewPreset; label: string }> = [
    { id: "perspective", label: "3D" },
    { id: "xy", label: "XY" },
    { id: "xz", label: "XZ" },
    { id: "yz", label: "YZ" },
  ];
  return <nav className="orientation-control" aria-label="Camera orientation">
    {views.map((view) => <button
      key={view.id}
      type="button"
      disabled={busy}
      className={preset === view.id ? "is-active" : ""}
      aria-pressed={preset === view.id}
      aria-label={view.id === "perspective" ? "Perspective view" : `${view.label} view`}
      onClick={() => onView(view.id)}
    >{view.id === "perspective" ? <Icon name="cube" /> : view.label}</button>)}
  </nav>;
}

function MoreMenu({
  canInspect,
  shortcutLabels,
  triggerRef,
  onClose,
  onCommands,
  onInspect,
  onPreferences,
  onShortcuts,
}: {
  canInspect: boolean;
  shortcutLabels: ViewerShortcutLabels;
  triggerRef: Readonly<{ current: HTMLButtonElement | null }>;
  onClose: () => void;
  onCommands: () => void;
  onInspect: () => void;
  onPreferences: () => void;
  onShortcuts: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const items = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])') ?? [])]
    .filter((element) => element.offsetParent !== null);
  useEffect(() => {
    const animation = requestAnimationFrame(() => items()[0]?.focus());
    return () => cancelAnimationFrame(animation);
  }, []);
  const moveFocus = (direction: number) => {
    const enabled = items();
    if (enabled.length === 0) return;
    const index = Math.max(0, enabled.indexOf(document.activeElement as HTMLButtonElement));
    enabled[(index + direction + enabled.length) % enabled.length].focus();
  };

  return <div
    ref={menuRef}
    className="more-menu"
    id="more-menu"
    role="menu"
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose();
    }}
    onKeyDown={(event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(-1); }
      else if (event.key === "Home") { event.preventDefault(); items()[0]?.focus(); }
      else if (event.key === "End") { event.preventDefault(); items().at(-1)?.focus(); }
      else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    }}
  >
    <button type="button" role="menuitem" aria-keyshortcuts="Meta+K Control+K" onClick={onCommands}><span>Commands</span><kbd>{shortcutLabels.commands}</kbd></button>
    <button className="more-inspect-action" type="button" role="menuitem" aria-keyshortcuts="I" disabled={!canInspect} onClick={onInspect}><span>Inspect</span><kbd>I</kbd></button>
    <hr />
    <button type="button" role="menuitem" aria-keyshortcuts="Meta+, Control+," onClick={onPreferences}><span>Preferences…</span><kbd>{shortcutLabels.preferences}</kbd></button>
    <button type="button" role="menuitem" aria-keyshortcuts="?" onClick={onShortcuts}><span>Keyboard shortcuts</span><kbd>?</kbd></button>
  </div>;
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
      if (restoreFocus?.isConnected) restoreFocus.focus();
    };
  }, []);
}

function CommandPalette({ actions, onClose }: { actions: CommandAction[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length === 0 ? actions : actions.filter((action) => words.every((word) => `${action.label} ${action.detail ?? ""}`.toLowerCase().includes(word)));
  }, [actions, query]);

  useModalFocus(panelRef, inputRef);
  useEffect(() => setActive(Math.max(0, visible.findIndex((action) => !action.disabled))), [visible]);

  const move = (direction: number) => {
    const enabled = visible.map((action, index) => action.disabled ? -1 : index).filter((index) => index >= 0);
    if (enabled.length === 0) return;
    const position = enabled.indexOf(active);
    setActive(enabled[(Math.max(0, position) + direction + enabled.length) % enabled.length]);
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
          else if (event.key === "Enter") { event.preventDefault(); if (!visible[active]?.disabled) visible[active]?.run(); }
        }}
      /><kbd>esc</kbd></label>
      <div className="command-results" id="command-results" role="listbox">
        {visible.map((action, index) => <button
          key={action.id}
          id={`command-${action.id}`}
          type="button"
          role="option"
          aria-selected={index === active}
          className={index === active ? "is-active" : ""}
          disabled={action.disabled}
          onPointerMove={() => !action.disabled && setActive(index)}
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
        ["Space", "Play / pause"],
      ],
    },
    {
      title: "View",
      items: [
        ["R", "Fit structure"],
        ["1–4", "3D, XY, XZ, YZ"],
        ["V / I", "View / inspect"],
        ["B / C", "Lines style / cell"],
        ["F / W", "Forces / water"],
      ],
    },
    {
      title: "Workspace",
      items: [
        [shortcutLabels.commands, "Commands"],
        [shortcutLabels.preferences, "Preferences"],
        [shortcutLabels.open, "Open trajectory"],
        [shortcutLabels.render, "Export image"],
        ["? / Esc", "Shortcuts / close"],
      ],
    },
  ];
  const vimItems: Array<[string, string]> = [
    ["j / k", "Next / previous frame"],
    ["J / K", "Forward / back ten"],
    ["gg / G", "First / last frame"],
    [":", "Commands"],
    ["Ctrl [", "Back / clear selection"],
  ];

  return <div className="command-backdrop shortcut-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={panelRef} className="shortcut-panel" id="shortcut-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1}>
      <div className="shortcut-heading">
        <div><strong>Keyboard shortcuts</strong><span>Viewer and trajectory controls.</span></div>
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
          <div><strong>Vim navigation</strong><span>Optional trajectory keys; standard shortcuts stay active.</span></div>
          <button type="button" role="switch" aria-label="Vim navigation" aria-checked={vimMode} onClick={() => onVimMode(!vimMode)}><i /></button>
        </div>
        <div className="vim-shortcut-grid">
          {vimItems.map(([keys, label]) => <div className="shortcut-row" key={`${keys}:${label}`}><kbd>{keys}</kbd><span>{label}</span></div>)}
        </div>
      </section>
    </section>
  </div>;
}

function PreferencesSheet({
  appearance,
  playbackMode,
  presentation,
  vimMode,
  onAppearance,
  onPlaybackMode,
  onPresentation,
  onShortcuts,
  onVimMode,
  onReset,
  onClose,
}: {
  appearance: Appearance;
  playbackMode: PlaybackMode;
  presentation: ScenePresentation;
  vimMode: boolean;
  onAppearance: (appearance: Appearance) => void;
  onPlaybackMode: (mode: PlaybackMode) => void;
  onPresentation: (change: Partial<ScenePresentation>) => void;
  onShortcuts: () => void;
  onVimMode: (enabled: boolean) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useModalFocus(panelRef);

  return <div className="customize-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside ref={panelRef} className="customize-sheet preferences-sheet" id="preferences-sheet" role="dialog" aria-modal="true" aria-label="Preferences" tabIndex={-1}>
      <div className="sheet-heading"><div><strong>Preferences</strong><span>Application behavior</span></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close preferences"><Icon name="close" /></button></div>

      <section className="settings-section">
        <h3>Display</h3>
        <div className="inline-settings">
          <div className="inline-setting"><span>Theme</span><div className="settings-segmented">
            {(["light", "dark"] as const).map((value) => <button key={value} type="button" className={appearance === value ? "is-active" : ""} aria-pressed={appearance === value} onClick={() => onAppearance(value)}>{displayLabel(value)}</button>)}
          </div></div>
          <div className="inline-setting"><span>Viewport quality</span><div className="settings-segmented">
            {(["auto", "high"] as const).map((quality) => <button key={quality} type="button" className={presentation.quality === quality ? "is-active" : ""} aria-pressed={presentation.quality === quality} onClick={() => onPresentation({ quality })}>{displayLabel(quality)}</button>)}
          </div></div>
        </div>
      </section>

      <section className="settings-section">
        <h3>Trajectory</h3>
        <Toggle label="Keep playback speed" checked={playbackMode === "drop-frames"} onChange={(enabled) => onPlaybackMode(enabled ? "drop-frames" : "keep-frames")} />
        <small>May skip frames on screen; trajectory data is unchanged.</small>
      </section>

      <section className="settings-section keyboard-settings">
        <h3>Keyboard</h3>
        <Toggle label="Vim navigation" checked={vimMode} onChange={onVimMode} />
        <button className="settings-link" type="button" onClick={onShortcuts}><span>Keyboard shortcuts</span><kbd>?</kbd></button>
        <small>{vimMode ? "j/k steps frames; J/K moves ten." : "Standard shortcuts stay active."}</small>
      </section>

      <div className="sheet-actions"><button type="button" onClick={onReset}>Reset preferences</button><button className="primary" type="button" onClick={onClose}>Done</button></div>
    </aside>
  </div>;
}

function RenderPanel({
  busy,
  periodicAvailable,
  onAspectChange,
  onValidityChange,
  onRender,
}: {
  busy: boolean;
  periodicAvailable: boolean;
  onAspectChange: (aspect: number) => void;
  onValidityChange: (valid: boolean) => void;
  onRender: (options: PngExportOptions) => Promise<void>;
}) {
  const [width, setWidth] = useState(2400);
  const [height, setHeight] = useState(1800);
  const [transparent, setTransparent] = useState(false);
  const [fit, setFit] = useState(true);
  const [projection, setProjection] = useState<"orthographic" | "perspective">("orthographic");
  const [periodicContext, setPeriodicContext] = useState(true);
  const [dpi, setDpi] = useState(300);
  const presets = [
    { label: "Figure", detail: "4:3", width: 2400, height: 1800 },
    { label: "Wide", detail: "16:9", width: 3200, height: 1800 },
    { label: "Square", detail: "1:1", width: 2400, height: 2400 },
    { label: "Portrait", detail: "3:4", width: 1800, height: 2400 },
  ];
  const pixels = width * height;
  const validationMessage = renderSizeValidationMessage(width, height);
  const invalid = validationMessage !== null;
  const printWidth = width / dpi * 25.4;
  const printHeight = height / dpi * 25.4;

  useEffect(() => {
    if (width > 0 && height > 0) onAspectChange(width / height);
  }, [height, onAspectChange, width]);

  useEffect(() => onValidityChange(!invalid), [invalid, onValidityChange]);

  return <form id="publication-render-form" className="render-panel" onSubmit={(event) => {
    event.preventDefault();
    if (invalid || busy) return;
    void onRender({ width, height, transparent, fit, projection, periodicContext: periodicAvailable && periodicContext, padding: 0.08 });
  }}>
      <section className="settings-section">
        <h3>Format</h3>
        <div className="render-presets">
          {presets.map((preset) => {
            const active = width === preset.width && height === preset.height;
            return <button
              key={preset.label}
              type="button"
              className={active ? "is-active" : ""}
              aria-pressed={active}
              disabled={busy}
              onClick={() => { setWidth(preset.width); setHeight(preset.height); }}
            ><strong>{preset.label}</strong><small>{preset.detail}</small></button>;
          })}
        </div>
      </section>

      <section className="settings-section">
        <h3>Pixels</h3>
        <div className="render-size">
          <label><span>Width</span><input type="number" min={512} max={6000} step={1} value={width} disabled={busy} onChange={(event) => setWidth(Number(event.target.value))} onBlur={() => setWidth(clamp(Math.round(width || 512), 512, 6000))} /></label>
          <i>×</i>
          <label><span>Height</span><input type="number" min={512} max={6000} step={1} value={height} disabled={busy} onChange={(event) => setHeight(Number(event.target.value))} onBlur={() => setHeight(clamp(Math.round(height || 512), 512, 6000))} /></label>
        </div>
        <small>{validationMessage ?? `${(pixels / 1_000_000).toFixed(1)} MP · sRGB PNG`}</small>
      </section>

      <details className="export-options">
        <summary><span>Advanced</span><small>{transparent ? "Transparent" : "White"} · {projection === "orthographic" ? "Orthographic" : "Perspective"}</small></summary>
        <div className="export-options-body">
      <section className="settings-section print-scale-section">
        <h3>Print scale</h3>
        <label className="render-print-row"><span>DPI guide</span><select value={dpi} disabled={busy} onChange={(event) => setDpi(Number(event.target.value))}>
          <option value={150}>150 dpi</option>
          <option value={300}>300 dpi</option>
          <option value={600}>600 dpi</option>
        </select></label>
        <output>{printWidth.toFixed(1)} × {printHeight.toFixed(1)} mm</output>
        <small>Print planning only; pixels stay unchanged.</small>
      </section>

      <div className="render-options-grid">
        <section className="settings-section">
          <h3>Background</h3>
          <div className="settings-segmented">
            <button type="button" className={!transparent ? "is-active" : ""} aria-pressed={!transparent} disabled={busy} onClick={() => setTransparent(false)}>White</button>
            <button type="button" className={transparent ? "is-active" : ""} aria-pressed={transparent} disabled={busy} onClick={() => setTransparent(true)}>Transparent</button>
          </div>
        </section>

        <section className="settings-section">
          <h3>Projection</h3>
          <div className="settings-segmented">
            <button type="button" className={projection === "orthographic" ? "is-active" : ""} aria-pressed={projection === "orthographic"} disabled={busy} onClick={() => setProjection("orthographic")}>Orthographic</button>
            <button type="button" className={projection === "perspective" ? "is-active" : ""} aria-pressed={projection === "perspective"} disabled={busy} onClick={() => setProjection("perspective")}>Perspective</button>
          </div>
          <small>Orthographic preserves scale.</small>
        </section>

        <section className="settings-section">
          <h3>Composition</h3>
          <div className="settings-segmented">
            <button type="button" className={fit ? "is-active" : ""} aria-pressed={fit} disabled={busy} onClick={() => setFit(true)}>Fit</button>
            <button type="button" className={!fit ? "is-active" : ""} aria-pressed={!fit} disabled={busy} onClick={() => setFit(false)}>Keep framing</button>
          </div>
          <small>Fit adds even margins.</small>
        </section>

        {periodicAvailable && <section className="settings-section">
          <h3>Boundary bonds</h3>
          <div className="settings-segmented">
            <button type="button" className={periodicContext ? "is-active" : ""} aria-pressed={periodicContext} disabled={busy} onClick={() => setPeriodicContext(true)}>Complete</button>
            <button type="button" className={!periodicContext ? "is-active" : ""} aria-pressed={!periodicContext} disabled={busy} onClick={() => setPeriodicContext(false)}>Clipped</button>
          </div>
          <small>Complete adds periodic neighbors.</small>
        </section>}
      </div>
        </div>
      </details>

  </form>;
}

function DropOverlay({ replacing }: { replacing: boolean }) {
  return <div className="drop-overlay" role="status"><div><Icon name="folder" /><strong>{replacing ? "Replace trajectory" : "Open trajectory"}</strong><span>Drop XYZ and PQ companion files</span></div></div>;
}

function Inspector({
  manifest,
  frame,
  frameIndex,
  selectedAtom,
  series,
  cellAvailable,
}: {
  manifest: Manifest;
  frame: FrameData | null;
  frameIndex: number;
  selectedAtom: number | null;
  series: DisplaySeries | null;
  cellAvailable: boolean;
}) {
  const positions = centeredFramePositions(frame, manifest.topology.atom_count);
  const forces = frameArray(frame, ["forces", "force"]);
  const velocities = frameArray(frame, ["velocities", "velocity", "vel"]);
  const charges = frameArray(frame, ["charges", "charge"]);
  const atom = selectedAtom !== null && selectedAtom < manifest.topology.atom_count ? selectedAtom : null;
  const symbol = atom !== null ? atomSymbol(manifest, atom) : null;
  const frameProperties = scalarProperties(frame, manifest, series?.name);
  const seriesValue = series?.values[frameIndex] ?? null;
  const step = scalarValue(frame, "step");
  const time = scalarValue(frame, "time");
  const metrics = cellMetrics(frame);
  const forceUnit = arrayUnit(frame, manifest, "forces");
  const velocityUnit = arrayUnit(frame, manifest, "velocities");
  const chargeUnit = arrayUnit(frame, manifest, "charges");
  const residueIndex = atom === null ? -1 : manifest.topology.atom_residue_index?.[atom] ?? -1;
  const residue = manifest.topology.residues?.find((entry) => entry.index === residueIndex);
  const selectionSection = atom === null ? (
    <section className="readout-section atom-section empty-selection">
      <h3>Selection</h3>
      <p className="quiet-copy">Click an atom in the viewport to inspect its coordinates and properties.</p>
    </section>
  ) : (
    <section className="readout-section atom-section">
      <h3>Selection</h3>
      <Readout label="Element" value={symbol ?? "—"} />
      {manifest.topology.atom_names?.[atom] && <Readout label="Name" value={manifest.topology.atom_names[atom]} />}
      {residue && <Readout label="Residue" value={`${residue.name ?? `Type ${residue.type_id ?? "—"}`} · ${residue.index + 1}`} />}
      {!residue && manifest.topology.residue_ids?.[atom] !== undefined && <Readout label="Residue type" value={String(manifest.topology.residue_ids[atom])} />}
      {positions && <VectorReadout label={cellAvailable ? "Base-cell position" : "Position"} values={positions} offset={atom * 3} unit="Å" />}
      {forces && <VectorReadout label="Force" values={forces} offset={atom * 3} unit={forceUnit} />}
      {velocities && <VectorReadout label="Velocity" values={velocities} offset={atom * 3} unit={velocityUnit} />}
      {charges && charges[atom] !== undefined && <Readout label="Charge" value={withUnit(formatNumber(charges[atom]), chargeUnit)} />}
    </section>
  );

  return (
    <div className="inspector-content">
      {selectionSection}

      <section className="readout-section">
        <h3>Frame</h3>
        <Readout label="Index" value={`${frameIndex + 1} / ${manifest.frame_count}`} />
        {step !== null && <Readout label="Step" value={formatNumber(step)} />}
        {time !== null && <Readout label="Time" value={withUnit(formatNumber(time), scalarUnit(frame, manifest, "time"))} />}
        {series && seriesValue !== null && (
          <Readout label={series.label} value={`${formatNumber(seriesValue)}${series.unit ? ` ${series.unit}` : ""}`} accent />
        )}
        {frameProperties.slice(0, 5).map(([label, value]) => (
          <Readout key={label} label={label} value={value} />
        ))}
        <Readout label="Bonds" value={manifest.topology.bond_source === "topology" ? "Topology" : "Distance inferred"} />
      </section>

      {metrics && (
        <section className="readout-section cell-metrics-section">
          <h3>Cell</h3>
          <Readout label="a · b · c" value={`${metrics.lengths.map(formatNumber).join(" · ")} Å`} />
          <Readout label="α · β · γ" value={`${metrics.angles.map(formatNumber).join(" · ")}°`} />
        </section>
      )}
    </div>
  );
}

function Timeline({
  busy,
  frameCount,
  frameIndex,
  playing,
  canPlay,
  speed,
  series,
  activeSeries,
  frameError,
  onFrame,
  onPlay,
  onSpeed,
  onSeries,
}: {
  busy: boolean;
  frameCount: number;
  frameIndex: number;
  playing: boolean;
  canPlay: boolean;
  speed: number;
  series: DisplaySeries[];
  activeSeries: DisplaySeries | null;
  frameError: string;
  onFrame: (index: number) => void;
  onPlay: () => void;
  onSpeed: (speed: number) => void;
  onSeries: (name: string) => void;
}) {
  return (
    <section className={`${series.length > 0 ? "timeline" : "timeline is-compact"}${busy ? " is-busy" : ""}`} aria-label="Trajectory controls">
      <div className="transport-row">
        <div className="transport-buttons">
          <button type="button" className="transport-button" onClick={() => onFrame(frameIndex - 1)} disabled={busy || frameIndex === 0} aria-label="Previous frame">
            <Icon name="back" />
          </button>
          <button type="button" className="play-button" onClick={onPlay} disabled={busy || !canPlay} aria-label={playing ? "Pause" : "Play"}>
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <button type="button" className="transport-button" onClick={() => onFrame(frameIndex + 1)} disabled={busy || frameIndex === frameCount - 1} aria-label="Next frame">
            <Icon name="next" />
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
        <output className="frame-counter">{String(frameIndex + 1).padStart(String(frameCount).length, "0")} / {frameCount}</output>
        <label className="speed-control">
          <span className="sr-only">Playback speed</span>
          <select value={speed} disabled={busy} onChange={(event) => onSpeed(Number(event.target.value))}>
            <option value={0.25}>0.25×</option>
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
          </select>
        </label>
      </div>

      {series.length > 0 && <div className="plot-row">
        <div className="plot-label">
          <select value={activeSeries?.name ?? ""} disabled={busy} onChange={(event) => onSeries(event.target.value)} aria-label="Timeline property">
            {series.map((entry) => <option key={entry.name} value={entry.name}>{entry.label}</option>)}
          </select>
          <small>{activeSeries?.unit ?? ""}</small>
        </div>
        <SeriesPlot series={activeSeries} frameCount={frameCount} frameIndex={frameIndex} disabled={busy} onFrame={onFrame} />
        {frameError && <div className="frame-error" title={frameError}>Frame unavailable</div>}
      </div>}
    </section>
  );
}

function SeriesPlot({
  series,
  frameCount,
  frameIndex,
  disabled,
  onFrame,
}: {
  series: DisplaySeries | null;
  frameCount: number;
  frameIndex: number;
  disabled: boolean;
  onFrame: (index: number) => void;
}) {
  const values = (series?.values ?? []).slice(0, frameCount);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let numericCount = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    numericCount += 1;
  }
  if (numericCount === 0) {
    min = 0;
    max = 1;
  }
  const span = max - min || 1;
  const denominator = Math.max(frameCount - 1, 1);
  let drawing = false;
  const path = values
    .map((value, index) => {
      if (value === null || !Number.isFinite(value)) {
        drawing = false;
        return "";
      }
      const x = (index / denominator) * 1000;
      const y = 78 - ((value - min) / span) * 64;
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const currentX = (frameIndex / denominator) * 1000;

  const seek = (event: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    if (event.type === "pointermove" && event.buttons !== 1) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    onFrame(((event.clientX - bounds.left) / bounds.width) * (frameCount - 1));
  };

  return (
    <div className="series-plot">
      <svg viewBox="0 0 1000 92" preserveAspectRatio="none" onPointerDown={seek} onPointerMove={seek} aria-disabled={disabled} aria-label={series ? `${series.label} over time` : "Trajectory timeline"}>
        <line className="plot-grid" x1="0" x2="1000" y1="14" y2="14" />
        <line className="plot-grid" x1="0" x2="1000" y1="46" y2="46" />
        <line className="plot-grid" x1="0" x2="1000" y1="78" y2="78" />
        {path && <path className="series-line" d={path} />}
        {!path && <line className="empty-series-line" x1="0" x2="1000" y1="46" y2="46" />}
        <line className="frame-marker" x1={currentX} x2={currentX} y1="6" y2="86" />
        <circle className="frame-point" cx={currentX} cy={seriesValueY(values[frameIndex], min, span)} r="4.5" vectorEffect="non-scaling-stroke" />
      </svg>
      {numericCount > 0 && (
        <div className="plot-range" aria-hidden="true"><span>{formatNumber(max)}</span><span>{formatNumber(min)}</span></div>
      )}
    </div>
  );
}

function Readout({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className={accent ? "readout is-accent" : "readout"}><span>{label}</span><strong>{value}</strong></div>;
}

function VectorReadout({ label, values, offset, unit }: { label: string; values: Float32Array; offset: number; unit?: string }) {
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
      {name === "chevron" && <path d="m8.5 10 3.5 3.5 3.5-3.5" {...common} />}
      {name === "cube" && <><path d="m5 8 7-4 7 4v8l-7 4-7-4V8Z" {...common} /><path d="m5 8 7 4 7-4M12 12v8" {...common} /></>}
      {name === "folder" && <path d="M4 7.5h6l1.6 2H20v8.5H4V7.5Z" {...common} />}
      {name === "image" && <><rect x="4" y="5" width="16" height="14" rx="2" {...common} /><circle cx="9" cy="10" r="1.5" {...common} /><path d="m6.5 17 4.2-4 2.6 2.4 2.2-2 2 1.8" {...common} /></>}
      {name === "more" && <><circle cx="6.5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="17.5" cy="12" r="1" fill="currentColor" /></>}
      {name === "search" && <><circle cx="10.5" cy="10.5" r="5.5" {...common} /><path d="m14.6 14.6 4 4" {...common} /></>}
      {name === "sliders" && <><path d="M5 7h5m4 0h5M5 17h3m4 0h7" {...common} /><circle cx="12" cy="7" r="2" {...common} /><circle cx="10" cy="17" r="2" {...common} /></>}
      {name === "play" && <path d="m9 7 7 5-7 5V7Z" fill="currentColor" />}
      {name === "pause" && <><path d="M9 7v10M15 7v10" {...common} strokeWidth="2" /></>}
      {name === "back" && <path d="m14.5 8-5 4 5 4" {...common} />}
      {name === "next" && <path d="m9.5 8 5 4-5 4" {...common} />}
      {name === "close" && <path d="m8 8 8 8m0-8-8 8" {...common} />}
      {name === "retry" && <><path d="M18 9a7 7 0 1 0 .5 5" {...common} /><path d="M18 5v4h-4" {...common} /></>}
    </svg>
  );
}

function scalarProperties(frame: FrameData | null, manifest: Manifest, excludedName?: string): Array<[string, string]> {
  if (!frame) return [];
  const seen = new Set(["step", "time", "frame_index", "index", "arrays", "scalars", "properties"]);
  const excluded = normalizeName(excludedName ?? "");
  const values: Array<[string, string]> = [];
  const add = (name: string, value: unknown) => {
    const normalized = normalizeName(name);
    if (seen.has(normalized) || normalized === excluded || typeof value !== "number" || !Number.isFinite(value)) return;
    seen.add(normalized);
    values.push([displayLabel(name), withUnit(formatNumber(value), scalarUnit(frame, manifest, name))]);
  };
  Object.entries(frame.header.scalars ?? {}).forEach(([name, value]) => add(name, value));
  Object.entries(frame.header.properties ?? {}).forEach(([name, value]) => add(name, value));
  add("energy", frame.header.energy);
  return values;
}

function arrayUnit(frame: FrameData | null, manifest: Manifest, name: string): string | undefined {
  const normalized = normalizeName(name);
  const descriptor = frame?.header.arrays.find((entry) => normalizeName(entry.name) === normalized);
  const property = Object.entries(manifest.properties ?? {}).find(([key]) => normalizeName(key) === normalized)?.[1];
  return displayUnit(descriptor?.unit ?? property?.unit);
}

function scalarUnit(frame: FrameData | null, manifest: Manifest, name: string): string | undefined {
  const normalized = normalizeName(name);
  const headerUnit = Object.entries(frame?.header.scalar_units ?? {}).find(([key]) => normalizeName(key) === normalized)?.[1];
  const propertyUnit = Object.entries(manifest.properties ?? {}).find(([key]) => normalizeName(key) === normalized)?.[1]?.unit;
  return displayUnit(headerUnit ?? propertyUnit);
}

function displayUnit(unit: string | null | undefined): string | undefined {
  if (!unit) return undefined;
  return unit.replace(/angstrom/gi, "Å").replace(/Angstrom/g, "Å");
}

function withUnit(value: string, unit: string | undefined): string {
  return unit ? `${value} ${unit}` : value;
}

function cellMetrics(frame: FrameData | null): { lengths: [number, number, number]; angles: [number, number, number] } | null {
  const cell = frameArray(frame, ["cell", "cell_vectors", "box"]);
  if (!cell || cell.length < 9) return null;
  const vectors = [0, 3, 6].map((offset) => [cell[offset], cell[offset + 1], cell[offset + 2]] as const);
  const length = ([x, y, z]: readonly number[]) => Math.hypot(x, y, z);
  const angle = (left: readonly number[], right: readonly number[]) => {
    const denominator = length(left) * length(right);
    if (!denominator) return 0;
    const cosine = left.reduce((sum, value, index) => sum + value * right[index], 0) / denominator;
    return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
  };
  const lengths = vectors.map(length) as [number, number, number];
  if (!lengths.every((value) => Number.isFinite(value) && value > 0)) return null;
  return {
    lengths,
    angles: [angle(vectors[1], vectors[2]), angle(vectors[0], vectors[2]), angle(vectors[0], vectors[1])],
  };
}

function scalarValue(frame: FrameData | null, name: string): number | null {
  if (!frame) return null;
  const direct = frame.header[name];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const match = Object.entries(frame.header.scalars ?? {}).find(([key]) => normalizeName(key) === normalizeName(name));
  return typeof match?.[1] === "number" && Number.isFinite(match[1]) ? match[1] : null;
}

function atomSymbol(manifest: Manifest, index: number): string {
  return manifest.topology.symbols?.[index] ?? elementSymbols[manifest.topology.atomic_numbers?.[index] ?? 0] ?? "X";
}

function displayLabel(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function seriesValueY(value: number | null | undefined, min: number, span: number): number {
  return typeof value === "number" && Number.isFinite(value) ? 78 - ((value - min) / span) * 64 : 46;
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
  forceAvailable: boolean,
  hasSeries: boolean,
): Exclude<SceneProfile, "auto" | "custom"> {
  if (capabilities.ribbon) return "protein";
  if (capabilities.suggestedProfile === "crystal") return "crystal";
  if (forceAvailable || hasSeries) return "trajectory";
  return "molecule";
}

export function selectedProfilePresentation(
  selectedProfile: Exclude<SceneProfile, "custom">,
  current: ScenePresentation,
  cellAvailable: boolean,
  forceAvailable: boolean,
  hasSeries: boolean,
  capabilities: SceneCapabilities,
  workspaceDefaults: WorkspacePresentationDefaults = {},
): ScenePresentation {
  const resolved = selectedProfile === "auto"
    ? autoProfile(capabilities, forceAvailable, hasSeries)
    : selectedProfile;
  const next = profilePresentation(resolved, current, cellAvailable, forceAvailable, capabilities);
  return selectedProfile === "auto" ? { ...next, ...workspaceDefaults } : next;
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
    color: "element",
  };
  if (profile === "trajectory") return {
    ...current,
    mode: "ball-stick",
    water: "show",
    hydrogens: true,
    wrap: cellAvailable ? "molecule" : "none",
    images: unit,
    cell: cellAvailable,
    forces: forceAvailable,
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
    color: "element",
  };
}

function periodicImages(pbc: [boolean, boolean, boolean], min: number, max: number): ScenePresentation["images"] {
  return {
    min: pbc.map((periodic) => periodic ? min : 0) as CellOffset,
    max: pbc.map((periodic) => periodic ? max : 0) as CellOffset,
  };
}

function replicaGridLabel(pbc: [boolean, boolean, boolean], size: number): string {
  return pbc.map((periodic) => periodic ? size : 1).join("×");
}

function withImageAxis(
  images: ScenePresentation["images"],
  axis: number,
  min: number,
  max: number,
): ScenePresentation["images"] {
  const nextMin = [...images.min] as CellOffset;
  const nextMax = [...images.max] as CellOffset;
  nextMin[axis] = clamp(Math.round(min), -2, 2);
  nextMax[axis] = clamp(Math.round(max), nextMin[axis], 2);
  return { min: nextMin, max: nextMax };
}

function periodicImageCount(images: ScenePresentation["images"]): number {
  return images.min.reduce((count, min, axis) => count * (images.max[axis] - min + 1), 1);
}

function sameImages(left: ScenePresentation["images"], right: ScenePresentation["images"]): boolean {
  return left.min.every((value, axis) => value === right.min[axis])
    && left.max.every((value, axis) => value === right.max[axis]);
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : "0";
}

function formatScale(value: number): string {
  return `${Number(value.toFixed(2))}×`;
}

function renderFileName(name: string | undefined, width: number, height: number): string {
  const base = (name ?? "molecule")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "molecule";
  return `${base}-${width}x${height}.png`;
}

export function renderSizeValidationMessage(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return "Enter a valid width and height.";
  const fractional = dimensionSubject(!Number.isInteger(width), !Number.isInteger(height));
  if (fractional) return fractional === "Width and height"
    ? "Width and height must be whole numbers of pixels."
    : `${fractional} must be a whole number of pixels.`;
  const belowMinimum = dimensionSubject(width < 512, height < 512);
  if (belowMinimum) return `${belowMinimum} must be at least 512 px.`;
  const aboveMaximum = dimensionSubject(width > 6000, height > 6000);
  if (aboveMaximum) return `${aboveMaximum} cannot exceed 6,000 px.`;
  if (width * height > MAX_PNG_EXPORT_PIXELS) return "Maximum output is 24 megapixels.";
  return null;
}

export function resolveRenderGuideSize(regionWidth: number, regionHeight: number, aspect: number): { width: number; height: number } {
  if (![regionWidth, regionHeight, aspect].every((value) => Number.isFinite(value) && value > 0)) return { width: 0, height: 0 };
  const maxWidth = Math.max(0, regionWidth - 48);
  const maxHeight = Math.min(regionHeight * 0.72, 520);
  const width = Math.min(maxWidth, maxHeight * aspect);
  return { width: Math.round(width), height: Math.round(width / aspect) };
}

function dimensionSubject(width: boolean, height: boolean): string {
  if (width && height) return "Width and height";
  if (width) return "Width";
  if (height) return "Height";
  return "";
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function initialPlaybackMode(): PlaybackMode {
  try {
    const saved = window.localStorage.getItem("pqviewer-playback");
    return saved === "drop-frames" || saved === "realtime" ? "drop-frames" : "keep-frames";
  } catch {
    return "keep-frames";
  }
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

function isTextEditingTarget(target: HTMLElement | null): boolean {
  return Boolean(target?.isContentEditable || target?.closest('input, select, textarea, [role="textbox"]'));
}

function isActivationTarget(target: HTMLElement | null): boolean {
  return Boolean(target?.closest('button, a[href], [role="button"], [role="menuitem"]'));
}

function initialPresentation(): ScenePresentation {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("pqviewer-presentation") ?? "null") as Partial<ScenePresentation> | null;
    if (!parsed || typeof parsed !== "object") return defaultPresentation;
    const modes: RepresentationMode[] = ["ball-stick", "spacefill", "licorice", "lines", "ribbon"];
    const waterModes: ScenePresentation["water"][] = ["show", "hide", "only"];
    const wraps: ScenePresentation["wrap"][] = ["atom", "molecule", "none"];
    const colors: ScenePresentation["color"][] = ["element", "residue", "chain"];
    const qualities: ScenePresentation["quality"][] = ["auto", "high"];
    const min = validCellOffset(parsed.images?.min) ? clampCellOffset(parsed.images.min) : defaultPresentation.images.min;
    const maxCandidate = validCellOffset(parsed.images?.max) ? clampCellOffset(parsed.images.max) : defaultPresentation.images.max;
    const max = maxCandidate.map((value, axis) => Math.max(value, min[axis])) as CellOffset;
    return {
      mode: modes.includes(parsed.mode as RepresentationMode) ? parsed.mode as RepresentationMode : defaultPresentation.mode,
      water: waterModes.includes(parsed.water as ScenePresentation["water"]) ? parsed.water as ScenePresentation["water"] : defaultPresentation.water,
      hydrogens: typeof parsed.hydrogens === "boolean" ? parsed.hydrogens : defaultPresentation.hydrogens,
      wrap: wraps.includes(parsed.wrap as ScenePresentation["wrap"]) ? parsed.wrap as ScenePresentation["wrap"] : defaultPresentation.wrap,
      images: { min, max },
      cell: typeof parsed.cell === "boolean" ? parsed.cell : defaultPresentation.cell,
      forces: typeof parsed.forces === "boolean" ? parsed.forces : defaultPresentation.forces,
      atomScale: typeof parsed.atomScale === "number" ? clamp(parsed.atomScale, 0.55, 1.6) : defaultPresentation.atomScale,
      bondScale: typeof parsed.bondScale === "number" ? clamp(parsed.bondScale, 0.55, 1.8) : defaultPresentation.bondScale,
      color: colors.includes(parsed.color as ScenePresentation["color"]) ? parsed.color as ScenePresentation["color"] : defaultPresentation.color,
      quality: qualities.includes(parsed.quality as ScenePresentation["quality"]) ? parsed.quality as ScenePresentation["quality"] : defaultPresentation.quality,
    };
  } catch {
    return defaultPresentation;
  }
}

function initialWorkspacePresentationDefaults(): WorkspacePresentationDefaults {
  try {
    return parseWorkspacePresentationDefaults(window.localStorage.getItem("pqviewer-workspace-presentation"));
  } catch {
    return {};
  }
}

export function parseWorkspacePresentationDefaults(value: string | null): WorkspacePresentationDefaults {
  try {
    const parsed = JSON.parse(value ?? "null") as WorkspacePresentationDefaults | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const wraps: ScenePresentation["wrap"][] = ["atom", "molecule", "none"];
    const colors: ScenePresentation["color"][] = ["element", "residue", "chain"];
    return {
      ...(wraps.includes(parsed.wrap as ScenePresentation["wrap"]) ? { wrap: parsed.wrap } : {}),
      ...(colors.includes(parsed.color as ScenePresentation["color"]) ? { color: parsed.color } : {}),
    };
  } catch {
    return {};
  }
}

function validCellOffset(value: unknown): value is CellOffset {
  return Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function clampCellOffset(value: CellOffset): CellOffset {
  return value.map((entry) => clamp(Math.round(entry), -2, 2)) as CellOffset;
}

function initialAppearance(): Appearance {
  try {
    return window.localStorage.getItem("pqviewer-appearance") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const elementSymbols = [
  "X", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar",
  "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr",
];
