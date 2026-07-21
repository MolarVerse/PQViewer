import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { frameArray, FrameCache, getManifest, normalizeSeries, openFiles } from "./api";
import { centeredFramePositions, framePbc, hasFrameCell, MoleculeScene } from "./MoleculeScene";
import type { MoleculeSceneHandle, PngExportOptions, RenderedSceneInfo, ViewPreset } from "./MoleculeScene";
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
type PlaybackMode = "every-frame" | "realtime";
type SceneProfile = "auto" | "molecule" | "protein" | "crystal" | "trajectory" | "custom";
type WorkspacePresentationDefaults = Partial<Pick<ScenePresentation, "wrap" | "color">>;
type ForceVectorStats = { rendered: number; total: number };
type IconName = "back" | "check" | "chevron" | "close" | "command" | "cube" | "folder" | "more" | "next" | "pause" | "play" | "retry" | "search";

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
  const [showInspector, setShowInspector] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [viewPreset, setViewPreset] = useState<ViewPreset>("perspective");
  const [viewSignal, setViewSignal] = useState(0);
  const [seriesName, setSeriesName] = useState("");
  const [forceScale, setForceScale] = useState(1);
  const [appearance, setAppearance] = useState<Appearance>(initialAppearance);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [renderOpen, setRenderOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState("");
  const [sceneInfo, setSceneInfo] = useState<RenderedSceneInfo | null>(null);
  const cache = useRef(new FrameCache());
  const moleculeSceneRef = useRef<MoleculeSceneHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sceneMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const autoProfileKey = useRef("");
  const realtimeTarget = useRef(0);
  const realtimeWorker = useRef<{ cancelled: boolean; manifest: Manifest } | null>(null);
  const openRequest = useRef(0);
  const openController = useRef<AbortController | null>(null);

  const activateManifest = useCallback((value: Manifest) => {
    if (realtimeWorker.current) realtimeWorker.current.cancelled = true;
    realtimeWorker.current = null;
    cache.current.clear();
    setManifest(value);
    setFrameIndex(0);
    setLoadedFrame(null);
    setSelectedAtom(null);
    setShowInspector(false);
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
    realtimeTarget.current = frameIndex;

    if (playbackMode === "realtime") {
      const currentWorker = realtimeWorker.current;
      if (currentWorker?.manifest === manifest && !currentWorker.cancelled) return;
      if (currentWorker) currentWorker.cancelled = true;

      const worker = { cancelled: false, manifest };
      realtimeWorker.current = worker;
      setFrameLoading(true);
      setFrameError("");

      const loadLatest = async () => {
        try {
          while (!worker.cancelled) {
            const requested = realtimeTarget.current;
            cache.current.cancelPendingExcept(requested);
            const data = await cache.current.get(requested);
            if (worker.cancelled) return;
            setLoadedFrame({ index: requested, data });
            if (realtimeTarget.current === requested) break;
          }
          if (!worker.cancelled && realtimeWorker.current === worker) {
            realtimeWorker.current = null;
            setFrameLoading(false);
          }
        } catch (error) {
          if (worker.cancelled || realtimeWorker.current !== worker) return;
          realtimeWorker.current = null;
          setFrameError(message(error));
          setFrameLoading(false);
          setPlaying(false);
        }
      };
      void loadLatest();
      return;
    }

    if (realtimeWorker.current) realtimeWorker.current.cancelled = true;
    realtimeWorker.current = null;
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
  }, [frameIndex, manifest, playbackMode]);

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

  const selectView = useCallback((preset: ViewPreset) => {
    setViewPreset(preset);
    setViewSignal((value) => value + 1);
  }, []);

  const selectAtom = useCallback((index: number | null) => {
    setSelectedAtom(index);
    if (index !== null) setShowInspector(true);
  }, []);

  const showRender = useCallback(() => {
    if (!moleculeSceneRef.current || rendering) return;
    setSceneOpen(false);
    setMoreOpen(false);
    setCommandOpen(false);
    setCustomizeOpen(false);
    setRenderOpen(true);
  }, [rendering]);

  const exportPng = useCallback(async (options: PngExportOptions) => {
    const scene = moleculeSceneRef.current;
    if (!scene) return;
    setRendering(true);
    setNotice("Rendering PNG…");
    try {
      const blob = await scene.exportPng(options);
      downloadBlob(blob, renderFileName(manifest?.name, options.width, options.height));
      setRenderOpen(false);
      setNotice(`Rendered ${options.width.toLocaleString()} × ${options.height.toLocaleString()} px`);
    } catch (error) {
      setNotice(`Render failed · ${message(error)}`);
    } finally {
      setRendering(false);
    }
  }, [manifest?.name]);

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
    if (!sceneOpen && !moreOpen) return;
    const closeMenus = (event: PointerEvent) => {
      const target = event.target as Node;
      if (sceneOpen && !sceneMenuRef.current?.contains(target)) setSceneOpen(false);
      if (moreOpen && !moreMenuRef.current?.contains(target)) setMoreOpen(false);
    };
    window.addEventListener("pointerdown", closeMenus);
    return () => window.removeEventListener("pointerdown", closeMenus);
  }, [moreOpen, sceneOpen]);

  useEffect(() => {
    if (!playing || !manifest || manifest.frame_count < 2) return;
    const interval = 100 / speed;
    if (playbackMode === "every-frame") {
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
  }, [frameIndex, frameLoading, loadedFrame?.index, manifest, playbackMode, playing, speed]);

  const openSelectedFiles = useCallback(async (selected: File[]) => {
    if (selected.length === 0) return;
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
  }, [activateManifest]);

  useEffect(() => () => openController.current?.abort(), []);

  useEffect(() => {
    if (!notice || opening || rendering) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice, opening, rendering]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        showRender();
        return;
      }
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (modifier && event.key.toLowerCase() === "o") {
        event.preventDefault();
        fileInputRef.current?.click();
        return;
      }
      if (event.key === "Escape") {
        if (commandOpen) setCommandOpen(false);
        else if (renderOpen && !rendering) setRenderOpen(false);
        else if (customizeOpen) setCustomizeOpen(false);
        else if (sceneOpen) setSceneOpen(false);
        else if (moreOpen) setMoreOpen(false);
        else if (selectedAtom !== null) setSelectedAtom(null);
        else setShowInspector(false);
        return;
      }
      if (target?.matches("input, select, button, textarea")) return;
      if (event.key === "/") {
        event.preventDefault();
        setCommandOpen(true);
      } else if (event.key === "?") {
        event.preventDefault();
        setCustomizeOpen(true);
      } else if (event.key.toLowerCase() === "i") {
        setShowInspector((value) => !value);
      } else if (event.key.toLowerCase() === "v") {
        setSceneOpen((value) => !value);
      } else if (event.key.toLowerCase() === "w" && capabilities?.water) {
        updatePresentation({ water: presentation.water === "hide" ? "show" : "hide" });
      } else if (event.key.toLowerCase() === "b") {
        updatePresentation({ mode: presentation.mode === "lines" ? "ball-stick" : "lines" });
      } else if (event.key.toLowerCase() === "c" && cellAvailable) {
        updatePresentation({ cell: !presentation.cell });
      } else if (event.key.toLowerCase() === "f" && forceAvailable) {
        updatePresentation({ forces: !presentation.forces });
      } else if (event.code === "Space") {
        event.preventDefault();
        if ((manifest?.frame_count ?? 0) > 1) setPlaying((value) => !value);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setPlaying(false);
        setFrame(displayedFrameIndex - (event.shiftKey ? 10 : 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        setFrame(displayedFrameIndex + (event.shiftKey ? 10 : 1));
      } else if (event.key === "Home" || event.key.toLowerCase() === "r") {
        event.preventDefault();
        setResetSignal((value) => value + 1);
      } else if (["Digit1", "Digit2", "Digit3", "Digit4"].includes(event.code)) {
        event.preventDefault();
        selectView(({ Digit1: "perspective", Digit2: "xy", Digit3: "xz", Digit4: "yz" } as const)[event.code as "Digit1" | "Digit2" | "Digit3" | "Digit4"]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    capabilities?.water,
    cellAvailable,
    commandOpen,
    customizeOpen,
    displayedFrameIndex,
    forceAvailable,
    manifest?.frame_count,
    moreOpen,
    presentation,
    renderOpen,
    rendering,
    sceneOpen,
    selectView,
    selectedAtom,
    setFrame,
    showRender,
    updatePresentation,
  ]);

  const commands = useMemo<CommandAction[]>(() => {
    const run = (action: () => void) => () => {
      action();
      setCommandOpen(false);
    };
    return [
      { id: "open", label: "Open trajectory", detail: "⌘O", run: run(() => fileInputRef.current?.click()) },
      { id: "fit", label: "Fit structure", detail: "R", run: run(() => setResetSignal((value) => value + 1)) },
      { id: "render", label: "Render PNG", detail: "⌘⇧S", disabled: !frame, run: run(showRender) },
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
      { id: "data", label: showInspector ? "Hide data" : "Show data", detail: "I", run: run(() => setShowInspector((value) => !value)) },
      { id: "appearance", label: `Use ${appearance === "light" ? "dark" : "light"} appearance`, run: run(() => setAppearance((value) => value === "light" ? "dark" : "light")) },
      { id: "customize", label: "Customize workspace", detail: "?", run: run(() => setCustomizeOpen(true)) },
    ];
  }, [appearance, capabilities, cellAvailable, forceAvailable, frame, presentation, selectView, showInspector, showRender, updatePresentation]);

  const workspaceClass = [
    "workspace",
    showInspector ? "" : "inspector-hidden",
    series.length === 0 ? "timeline-compact" : "",
  ].filter(Boolean).join(" ");

  return (
    <main
      className="app-shell"
      onDragEnter={(event) => {
        event.preventDefault();
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
        void openSelectedFiles([...event.dataTransfer.files]);
      }}
    >
      <input
        ref={fileInputRef}
        className="sr-only file-input"
        type="file"
        tabIndex={-1}
        multiple
        accept=".xyz,.extxyz,.force,.frc,.forces,.vel,.velocs,.velocity,.charge,.chrg,.charges,.en,.info,.top,.topology,.mol,.moldescriptor"
        onChange={(event) => {
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
                {cellAvailable && <span>PBC <strong>{pbc.map((value, index) => value ? "abc"[index] : "").join("") || "off"}</strong></span>}
              </div>
            )}
            <button className="open-button" type="button" onClick={() => fileInputRef.current?.click()}><Icon name="folder" />Open</button>
            <button className="command-button" type="button" onClick={() => setCommandOpen(true)} aria-label="Search commands"><Icon name="search" /><kbd>⌘K</kbd></button>
            <div className="more-control" ref={moreMenuRef}>
              <button className="more-button" type="button" aria-label="More" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)}><Icon name="more" /></button>
              {moreOpen && <MoreMenu
                appearance={appearance}
                canRender={Boolean(frame)}
                onOpen={() => { setMoreOpen(false); fileInputRef.current?.click(); }}
                onCommands={() => { setMoreOpen(false); setCommandOpen(true); }}
                onRender={showRender}
                onCustomize={() => { setMoreOpen(false); setCustomizeOpen(true); }}
                onAppearance={() => {
                  setMoreOpen(false);
                  setAppearance((value) => value === "light" ? "dark" : "light");
                }}
              />}
            </div>
          </div>
        </header>

        {manifest && manifest.frame_count > 0 && capabilities && (
          <SceneDock
            menuRef={sceneMenuRef}
            open={sceneOpen}
            profile={profile}
            presentation={presentation}
            capabilities={capabilities!}
            pbc={pbc}
            cellAvailable={cellAvailable}
            forceAvailable={forceAvailable}
            renderedImageCount={sceneInfo?.imageCount ?? null}
            forceVectorStats={forceVectorStats}
            showInspector={showInspector}
            onOpen={() => setSceneOpen((value) => !value)}
            onProfile={chooseProfile}
            onPresentation={updatePresentation}
            onFit={() => setResetSignal((value) => value + 1)}
            onInspector={() => setShowInspector((value) => !value)}
            onCustomize={() => { setSceneOpen(false); setCustomizeOpen(true); }}
          />
        )}

        {manifest && manifest.frame_count > 0 && <OrientationControl preset={viewPreset} onView={selectView} />}

        {manifest && (
          <Inspector
            open={showInspector}
            manifest={manifest}
            frame={frame}
            frameIndex={displayedFrameIndex}
            selectedAtom={selectedAtom}
            series={activeSeries}
            cellAvailable={cellAvailable}
            presentation={presentation}
            forceAvailable={forceAvailable}
            forceVectorStats={forceVectorStats}
            forceScale={forceScale}
            onForceScale={setForceScale}
            onClose={() => setShowInspector(false)}
          />
        )}

        {manifest && manifest.frame_count > 0 && (
          <Timeline
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
            onAction={() => fileInputRef.current?.click()}
          />
        )}
        {notice && <div className={opening ? "notice is-busy" : "notice"} role="status">{notice}</div>}
        {dropActive && <DropOverlay replacing={Boolean(manifest)} />}
        {commandOpen && <CommandPalette actions={commands} onClose={() => setCommandOpen(false)} />}
        {customizeOpen && <CustomizeSheet
          appearance={appearance}
          playbackMode={playbackMode}
          presentation={presentation}
          onAppearance={setAppearance}
          onPlaybackMode={setPlaybackMode}
          onPresentation={updateWorkspacePresentation}
          onReset={() => {
            setWorkspacePresentationDefaults({});
            if (capabilities) {
              const resolved = autoProfile(capabilities, forceAvailable, series.length > 0);
              setPresentation(profilePresentation(resolved, defaultPresentation, cellAvailable, forceAvailable, capabilities));
              autoProfileKey.current = manifest ? `${manifest.name}:${manifest.topology.atom_count}` : "";
            } else {
              setPresentation(defaultPresentation);
              autoProfileKey.current = "";
            }
            setPlaybackMode("every-frame");
            setAppearance("light");
            setProfile("auto");
            setResetSignal((value) => value + 1);
          }}
          onClose={() => setCustomizeOpen(false)}
        />}
        {renderOpen && <RenderSheet
          busy={rendering}
          onRender={exportPng}
          onClose={() => !rendering && setRenderOpen(false)}
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

function SceneDock({
  menuRef,
  open,
  profile,
  presentation,
  capabilities,
  pbc,
  cellAvailable,
  forceAvailable,
  forceVectorStats,
  renderedImageCount,
  showInspector,
  onOpen,
  onProfile,
  onPresentation,
  onFit,
  onInspector,
  onCustomize,
}: {
  menuRef: { current: HTMLDivElement | null };
  open: boolean;
  profile: SceneProfile;
  presentation: ScenePresentation;
  capabilities: SceneCapabilities;
  pbc: [boolean, boolean, boolean];
  cellAvailable: boolean;
  forceAvailable: boolean;
  forceVectorStats: ForceVectorStats | null;
  renderedImageCount: number | null;
  showInspector: boolean;
  onOpen: () => void;
  onProfile: (profile: Exclude<SceneProfile, "custom">) => void;
  onPresentation: (change: Partial<ScenePresentation>) => void;
  onFit: () => void;
  onInspector: () => void;
  onCustomize: () => void;
}) {
  const popoverRef = useRef<HTMLElement>(null);
  const profiles: Array<{ id: Exclude<SceneProfile, "custom">; label: string }> = [
    { id: "auto", label: "Auto" },
    { id: "molecule", label: "Molecule" },
    { id: "protein", label: "Protein" },
    { id: "crystal", label: "Crystal" },
    { id: "trajectory", label: "Trajectory" },
  ];
  const modes: RepresentationMode[] = ["ball-stick", "spacefill", "licorice", "lines", "ribbon"];
  const setImages = (images: ScenePresentation["images"]) => onPresentation({ images });
  const requestedImageCount = periodicImageCount(presentation.images);
  const imageCount = renderedImageCount ?? requestedImageCount;
  const imagesTruncated = imageCount < requestedImageCount;

  useEffect(() => {
    if (open) popoverRef.current?.scrollTo({ top: 0 });
  }, [open]);

  return (
    <div className="scene-control" ref={menuRef}>
      <button
        className="scene-trigger"
        type="button"
        onClick={onOpen}
        aria-label={`Scene: ${profileLabel(profile)}, ${representationLabel(presentation.mode)}`}
        aria-expanded={open}
        aria-controls="scene-popover"
      >
        <span>Scene</span>
        <strong>{profileLabel(profile)} · {representationLabel(presentation.mode)}</strong>
        <Icon name="chevron" />
      </button>

      {open && <section ref={popoverRef} className="scene-popover" id="scene-popover" aria-label="Scene controls">
        <div className="popover-heading">
          <div><strong>Scene</strong><span>Choose what the canvas shows.</span></div>
          <button className="icon-button" type="button" onClick={onOpen} aria-label="Close scene controls"><Icon name="close" /></button>
        </div>

        <div className="profile-strip" aria-label="Scene profile">
          {profiles.map((item) => <button
            key={item.id}
            type="button"
            className={profile === item.id ? "is-active" : ""}
            aria-pressed={profile === item.id}
            onClick={() => onProfile(item.id)}
          >{item.label}</button>)}
        </div>

        <div className="scene-group">
          <span className="scene-group-label">Representation</span>
          <div className="representation-grid">
            {modes.map((mode) => {
              const unavailable = mode === "ribbon" && !capabilities.ribbon;
              return <button
                key={mode}
                type="button"
                className={presentation.mode === mode ? "is-active" : ""}
                aria-pressed={presentation.mode === mode}
                disabled={unavailable}
                title={unavailable ? capabilities.ribbonReason : undefined}
                onClick={() => onPresentation({ mode })}
              ><span>{representationLabel(mode)}</span>{presentation.mode === mode && <Icon name="check" />}</button>;
            })}
          </div>
          {!capabilities.ribbon && <small className="capability-note">{capabilities.ribbonReason}</small>}
        </div>

        <div className="scene-group compact-group">
          <span className="scene-group-label">Structure</span>
          <Toggle label="Hydrogens" checked={presentation.hydrogens} onChange={(hydrogens) => onPresentation({ hydrogens })} />
          <div className={capabilities.water ? "choice-row" : "choice-row is-disabled"}>
            <span>Water</span>
            {capabilities.water ? <div className="mini-segmented" aria-label="Water display">
              {(["show", "hide", "only"] as const).map((water) => <button
                key={water}
                type="button"
                className={presentation.water === water ? "is-active" : ""}
                aria-pressed={presentation.water === water}
                onClick={() => onPresentation({ water })}
              >{displayLabel(water)}</button>)}
            </div> : <small>None detected</small>}
          </div>
        </div>

        <div className="scene-group compact-group">
          <span className="scene-group-label">Overlays</span>
          <Toggle label="Cell" checked={presentation.cell && cellAvailable} disabled={!cellAvailable} onChange={(cell) => onPresentation({ cell })} />
          <Toggle label="Forces" checked={presentation.forces && forceAvailable} disabled={!forceAvailable} onChange={(forces) => onPresentation({ forces })} />
          {presentation.forces && forceVectorStats && forceVectorStats.total > forceVectorStats.rendered && (
            <small className="capability-note">Showing {forceVectorStats.rendered.toLocaleString()} of {forceVectorStats.total.toLocaleString()} evenly sampled vectors.</small>
          )}
        </div>

        {cellAvailable && <div className="scene-group image-group">
          <div className="scene-group-heading"><span className="scene-group-label">Cell images</span><output>{imagesTruncated ? `${imageCount} / ${requestedImageCount}` : imageCount}</output></div>
          <div className="image-presets" aria-label="Cell image presets">
            {([
              ["Unit", periodicImages(pbc, 0, 0)],
              ["2×", periodicImages(pbc, -1, 0)],
              ["3×", periodicImages(pbc, -1, 1)],
            ] as Array<[string, ScenePresentation["images"]]>).map(([label, images]) => <button
              key={label}
              type="button"
              className={sameImages(presentation.images, images) ? "is-active" : ""}
              aria-pressed={sameImages(presentation.images, images)}
              onClick={() => setImages(images)}
            >{label}</button>)}
          </div>
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
          {imagesTruncated && <small className="capability-note">Showing the nearest {imageCount} of {requestedImageCount} requested.</small>}
          <small className="cell-origin-note">The PQ cell is centered at the origin.</small>
        </div>}

        <div className="scene-actions">
          <button type="button" onClick={onFit}>Fit</button>
          <button type="button" className={showInspector ? "is-active" : ""} onClick={onInspector}>Data</button>
          <button type="button" onClick={onCustomize}>Customize…</button>
        </div>
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
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><i /></button>
  </div>;
}

function OrientationControl({ preset, onView }: { preset: ViewPreset; onView: (preset: ViewPreset) => void }) {
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
      className={preset === view.id ? "is-active" : ""}
      aria-pressed={preset === view.id}
      aria-label={view.id === "perspective" ? "Perspective view" : `${view.label} view`}
      onClick={() => onView(view.id)}
    >{view.id === "perspective" ? <Icon name="cube" /> : view.label}</button>)}
  </nav>;
}

function MoreMenu({
  appearance,
  canRender,
  onOpen,
  onCommands,
  onRender,
  onCustomize,
  onAppearance,
}: {
  appearance: Appearance;
  canRender: boolean;
  onOpen: () => void;
  onCommands: () => void;
  onRender: () => void;
  onCustomize: () => void;
  onAppearance: () => void;
}) {
  return <div className="more-menu" role="menu">
    <button type="button" role="menuitem" onClick={onOpen}><span>Open…</span><kbd>⌘O</kbd></button>
    <button type="button" role="menuitem" onClick={onCommands}><span>Commands</span><kbd>⌘K</kbd></button>
    <button type="button" role="menuitem" disabled={!canRender} onClick={onRender}><span>Render image…</span><kbd>⌘⇧S</kbd></button>
    <hr />
    <button type="button" role="menuitem" onClick={onCustomize}><span>Customize…</span><kbd>?</kbd></button>
    <button type="button" role="menuitem" onClick={onAppearance}><span>{appearance === "light" ? "Dark" : "Light"} appearance</span></button>
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
  useEffect(() => setActive(Math.max(0, visible.findIndex((action) => !action.disabled))), [query]);

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
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
          else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
          else if (event.key === "Enter") { event.preventDefault(); if (!visible[active]?.disabled) visible[active]?.run(); }
        }}
      /><kbd>esc</kbd></label>
      <div className="command-results" role="listbox">
        {visible.map((action, index) => <button
          key={action.id}
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

function CustomizeSheet({
  appearance,
  playbackMode,
  presentation,
  onAppearance,
  onPlaybackMode,
  onPresentation,
  onReset,
  onClose,
}: {
  appearance: Appearance;
  playbackMode: PlaybackMode;
  presentation: ScenePresentation;
  onAppearance: (appearance: Appearance) => void;
  onPlaybackMode: (mode: PlaybackMode) => void;
  onPresentation: (change: Partial<ScenePresentation>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useModalFocus(panelRef);

  return <div className="customize-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside ref={panelRef} className="customize-sheet" role="dialog" aria-modal="true" aria-label="Customize workspace" tabIndex={-1}>
      <div className="sheet-heading"><div><strong>Customize</strong><span>Workspace defaults</span></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close customize"><Icon name="close" /></button></div>

      <section className="settings-section">
        <h3>Appearance</h3>
        <div className="settings-segmented">
          {(["light", "dark"] as const).map((value) => <button key={value} type="button" className={appearance === value ? "is-active" : ""} aria-pressed={appearance === value} onClick={() => onAppearance(value)}>{displayLabel(value)}</button>)}
        </div>
      </section>

      <section className="settings-section">
        <h3>Playback</h3>
        <button className={playbackMode === "every-frame" ? "settings-choice is-active" : "settings-choice"} type="button" aria-pressed={playbackMode === "every-frame"} onClick={() => onPlaybackMode("every-frame")}>
          <span><strong>Every frame</strong><small>Wait for each frame before advancing.</small></span>{playbackMode === "every-frame" && <Icon name="check" />}
        </button>
        <button className={playbackMode === "realtime" ? "settings-choice is-active" : "settings-choice"} type="button" aria-pressed={playbackMode === "realtime"} onClick={() => onPlaybackMode("realtime")}>
          <span><strong>Realtime</strong><small>Keep time and skip frames when needed.</small></span>{playbackMode === "realtime" && <Icon name="check" />}
        </button>
      </section>

      <section className="settings-section">
        <h3>Periodic wrapping</h3>
        <div className="settings-segmented three-up">
          {(["molecule", "atom", "none"] as const).map((wrap) => <button key={wrap} type="button" className={presentation.wrap === wrap ? "is-active" : ""} aria-pressed={presentation.wrap === wrap} onClick={() => onPresentation({ wrap })}>{displayLabel(wrap)}</button>)}
        </div>
        <small>{presentation.wrap === "molecule"
          ? "Whole molecules stay intact."
          : presentation.wrap === "atom"
            ? "Every atom stays inside the centered cell."
            : "Original coordinates are preserved."}</small>
      </section>

      <section className="settings-section">
        <h3>Color</h3>
        <div className="settings-segmented">
          {(["element", "residue"] as const).map((color) => <button key={color} type="button" className={presentation.color === color ? "is-active" : ""} aria-pressed={presentation.color === color} onClick={() => onPresentation({ color })}>{displayLabel(color)}</button>)}
        </div>
      </section>

      <section className="settings-section slider-settings">
        <h3>Geometry</h3>
        <label><span>Atoms <output>{formatScale(presentation.atomScale)}</output></span><input type="range" min={0.55} max={1.6} step={0.05} value={presentation.atomScale} onChange={(event) => onPresentation({ atomScale: Number(event.target.value) })} /></label>
        <label><span>Bonds <output>{formatScale(presentation.bondScale)}</output></span><input type="range" min={0.55} max={1.8} step={0.05} value={presentation.bondScale} onChange={(event) => onPresentation({ bondScale: Number(event.target.value) })} /></label>
      </section>

      <section className="settings-section">
        <h3>Quality</h3>
        <div className="settings-segmented">
          {(["auto", "high"] as const).map((quality) => <button key={quality} type="button" className={presentation.quality === quality ? "is-active" : ""} aria-pressed={presentation.quality === quality} onClick={() => onPresentation({ quality })}>{displayLabel(quality)}</button>)}
        </div>
      </section>

      <div className="sheet-actions"><button type="button" onClick={onReset}>Reset</button><button className="primary" type="button" onClick={onClose}>Done</button></div>
    </aside>
  </div>;
}

function RenderSheet({
  busy,
  onRender,
  onClose,
}: {
  busy: boolean;
  onRender: (options: PngExportOptions) => Promise<void>;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(2400);
  const [height, setHeight] = useState(1800);
  const [transparent, setTransparent] = useState(false);
  const [fit, setFit] = useState(true);
  const panelRef = useRef<HTMLElement>(null);
  useModalFocus(panelRef);
  const presets = [
    { label: "Figure", detail: "4:3", width: 2400, height: 1800 },
    { label: "Wide", detail: "16:9", width: 3200, height: 1800 },
    { label: "Square", detail: "1:1", width: 2400, height: 2400 },
    { label: "Portrait", detail: "3:4", width: 1800, height: 2400 },
  ];
  const pixels = width * height;
  const validationMessage = renderSizeValidationMessage(width, height);
  const invalid = validationMessage !== null;

  return <div className="customize-backdrop render-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <aside ref={panelRef} className="customize-sheet render-sheet" role="dialog" aria-modal="true" aria-label="Render image" tabIndex={-1}>
      <div className="sheet-heading"><div><strong>Render image</strong><span>Publication-ready PNG</span></div><button className="icon-button" type="button" disabled={busy} onClick={onClose} aria-label="Close render image"><Icon name="close" /></button></div>

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

      <section className="settings-section">
        <h3>Background</h3>
        <div className="settings-segmented">
          <button type="button" className={!transparent ? "is-active" : ""} aria-pressed={!transparent} disabled={busy} onClick={() => setTransparent(false)}>Canvas</button>
          <button type="button" className={transparent ? "is-active" : ""} aria-pressed={transparent} disabled={busy} onClick={() => setTransparent(true)}>Transparent</button>
        </div>
      </section>

      <section className="settings-section">
        <h3>Composition</h3>
        <div className="settings-segmented">
          <button type="button" className={fit ? "is-active" : ""} aria-pressed={fit} disabled={busy} onClick={() => setFit(true)}>Fit</button>
          <button type="button" className={!fit ? "is-active" : ""} aria-pressed={!fit} disabled={busy} onClick={() => setFit(false)}>Current</button>
        </div>
        <small>Fit keeps the current orientation and adds balanced space.</small>
      </section>

      <div className="sheet-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" type="button" disabled={invalid || busy} onClick={() => void onRender({ width, height, transparent, fit, padding: 0.08 })}>{busy ? "Rendering…" : "Render PNG"}</button></div>
    </aside>
  </div>;
}

function DropOverlay({ replacing }: { replacing: boolean }) {
  return <div className="drop-overlay" role="status"><div><Icon name="folder" /><strong>{replacing ? "Replace trajectory" : "Open trajectory"}</strong><span>Drop XYZ and PQ companion files</span></div></div>;
}

function Inspector({
  open,
  manifest,
  frame,
  frameIndex,
  selectedAtom,
  series,
  cellAvailable,
  presentation,
  forceAvailable,
  forceVectorStats,
  forceScale,
  onForceScale,
  onClose,
}: {
  open: boolean;
  manifest: Manifest;
  frame: FrameData | null;
  frameIndex: number;
  selectedAtom: number | null;
  series: DisplaySeries | null;
  cellAvailable: boolean;
  presentation: ScenePresentation;
  forceAvailable: boolean;
  forceVectorStats: ForceVectorStats | null;
  forceScale: number;
  onForceScale: (scale: number) => void;
  onClose: () => void;
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
  const selectionSection = atom === null ? null : (
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
    <aside className={open ? "inspector is-open" : "inspector"} aria-label="Inspector">
      <div className="panel-heading">
        <h2>{atom === null ? "Data" : `${symbol} · Atom ${atom + 1}`}</h2>
        <button className="icon-button close-inspector" type="button" onClick={onClose} aria-label="Close inspector">
          <Icon name="close" />
        </button>
      </div>

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
        <Readout label="Style" value={representationLabel(presentation.mode)} />
        <Readout label="Bonds" value={manifest.topology.bond_source === "topology" ? "Topology" : "Distance inferred"} />
      </section>

      {metrics && (
        <section className="readout-section cell-metrics-section">
          <h3>Cell</h3>
          <Readout label="a · b · c" value={`${metrics.lengths.map(formatNumber).join(" · ")} Å`} />
          <Readout label="α · β · γ" value={`${metrics.angles.map(formatNumber).join(" · ")}°`} />
        </section>
      )}

      {cellAvailable && <section className="readout-section periodic-section">
        <h3>Periodic</h3>
        <Readout label="Images" value={imageRangeLabel(presentation.images)} />
        <Readout label="Wrap" value={displayLabel(presentation.wrap)} />
        <Readout label="Origin" value="Cell center" />
      </section>}

      {forceAvailable && <section className="readout-section force-section">
        <div className="section-heading-row">
          <h3>Forces</h3>
          <output>Scale · {formatNumber(forceScale)}×</output>
        </div>
        {presentation.forces && forceVectorStats && <Readout
          label="Vectors"
          value={forceVectorStats.total > forceVectorStats.rendered
            ? `${forceVectorStats.rendered.toLocaleString()} / ${forceVectorStats.total.toLocaleString()} · evenly sampled`
            : forceVectorStats.total.toLocaleString()}
        />}
        <Readout label="Normalization" value="90th percentile · displayed vectors" />
        <label className="force-scale">
          <span className="sr-only">Force vector scale</span>
          <span>0.25×</span>
          <input
            type="range"
            min={0.25}
            max={4}
            step={0.25}
            value={forceScale}
            onChange={(event) => onForceScale(Number(event.target.value))}
          />
          <span>4×</span>
        </label>
      </section>}

      {atom === null && (
        <section className="readout-section atom-section">
          <h3>Selection</h3>
          <p className="quiet-copy">Select an atom.</p>
        </section>
      )}

    </aside>
  );
}

function Timeline({
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
    <section className={series.length > 0 ? "timeline" : "timeline is-compact"} aria-label="Trajectory controls">
      <div className="transport-row">
        <div className="transport-buttons">
          <button type="button" className="transport-button" onClick={() => onFrame(frameIndex - 1)} disabled={frameIndex === 0} aria-label="Previous frame">
            <Icon name="back" />
          </button>
          <button type="button" className="play-button" onClick={onPlay} disabled={!canPlay} aria-label={playing ? "Pause" : "Play"}>
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <button type="button" className="transport-button" onClick={() => onFrame(frameIndex + 1)} disabled={frameIndex === frameCount - 1} aria-label="Next frame">
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
            onChange={(event) => onFrame(Number(event.target.value))}
          />
        </label>
        <output className="frame-counter">{String(frameIndex + 1).padStart(String(frameCount).length, "0")} / {frameCount}</output>
        <label className="speed-control">
          <span className="sr-only">Playback speed</span>
          <select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>
            <option value={0.25}>0.25×</option>
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
          </select>
        </label>
      </div>

      {series.length > 0 && <div className="plot-row">
        <div className="plot-label">
          <select value={activeSeries?.name ?? ""} onChange={(event) => onSeries(event.target.value)} aria-label="Timeline property">
            {series.map((entry) => <option key={entry.name} value={entry.name}>{entry.label}</option>)}
          </select>
          <small>{activeSeries?.unit ?? ""}</small>
        </div>
        <SeriesPlot series={activeSeries} frameCount={frameCount} frameIndex={frameIndex} onFrame={onFrame} />
        {frameError && <div className="frame-error" title={frameError}>Frame unavailable</div>}
      </div>}
    </section>
  );
}

function SeriesPlot({
  series,
  frameCount,
  frameIndex,
  onFrame,
}: {
  series: DisplaySeries | null;
  frameCount: number;
  frameIndex: number;
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
    if (event.type === "pointermove" && event.buttons !== 1) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    onFrame(((event.clientX - bounds.left) / bounds.width) * (frameCount - 1));
  };

  return (
    <div className="series-plot">
      <svg viewBox="0 0 1000 92" preserveAspectRatio="none" onPointerDown={seek} onPointerMove={seek} aria-label={series ? `${series.label} over time` : "Trajectory timeline"}>
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
      {name === "check" && <path d="m6.5 12 3.4 3.4 7.6-7.6" {...common} strokeWidth="2" />}
      {name === "chevron" && <path d="m8.5 10 3.5 3.5 3.5-3.5" {...common} />}
      {name === "command" && <path d="M9 8.5V6a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v12a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V8.5Z" {...common} />}
      {name === "cube" && <><path d="m5 8 7-4 7 4v8l-7 4-7-4V8Z" {...common} /><path d="m5 8 7 4 7-4M12 12v8" {...common} /></>}
      {name === "folder" && <path d="M4 7.5h6l1.6 2H20v8.5H4V7.5Z" {...common} />}
      {name === "more" && <><circle cx="6.5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="17.5" cy="12" r="1" fill="currentColor" /></>}
      {name === "search" && <><circle cx="10.5" cy="10.5" r="5.5" {...common} /><path d="m14.6 14.6 4 4" {...common} /></>}
      {name === "play" && <path d="m9 7 7 5-7 5V7Z" fill="currentColor" />}
      {name === "pause" && <><path d="M9 7v10M15 7v10" {...common} strokeWidth="2" /></>}
      {name === "back" && <><path d="m14.5 8-5 4 5 4" {...common} /><path d="M7 7v10" {...common} /></>}
      {name === "next" && <><path d="m9.5 8 5 4-5 4" {...common} /><path d="M17 7v10" {...common} /></>}
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

function profileLabel(profile: SceneProfile): string {
  return profile === "auto" ? "Auto" : displayLabel(profile);
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

function imageRangeLabel(images: ScenePresentation["images"]): string {
  const first = `[${images.min.join(" ")}]`;
  const last = `[${images.max.join(" ")}]`;
  return first === last ? first : `${first} – ${last}`;
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
    return window.localStorage.getItem("pqviewer-playback") === "realtime" ? "realtime" : "every-frame";
  } catch {
    return "every-frame";
  }
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
