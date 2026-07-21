import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { frameArray, FrameCache, getManifest, normalizeSeries } from "./api";
import { centeredFramePositions, framePbc, hasFrameCell, MoleculeScene } from "./MoleculeScene";
import type { ViewPreset } from "./MoleculeScene";
import type { Appearance, CellOffset, DisplaySeries, FrameData, LayerState, Manifest } from "./types";

type LoadState = "loading" | "ready" | "error";
type IconName = "atoms" | "bonds" | "cell" | "forces" | "home" | "info" | "play" | "pause" | "back" | "next" | "close" | "retry" | "sun" | "moon";

const initialLayers: LayerState = { atoms: true, bonds: true, cell: true, forces: true };

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
  const [layers, setLayers] = useState<LayerState>(initialLayers);
  const [selectedAtom, setSelectedAtom] = useState<number | null>(null);
  const [showInspector, setShowInspector] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [viewPreset, setViewPreset] = useState<ViewPreset>("perspective");
  const [viewSignal, setViewSignal] = useState(0);
  const [seriesName, setSeriesName] = useState("");
  const [cellOffset, setCellOffset] = useState<CellOffset>([0, 0, 0]);
  const [forceScale, setForceScale] = useState(1);
  const [appearance, setAppearance] = useState<Appearance>(initialAppearance);
  const [displayOpen, setDisplayOpen] = useState(false);
  const cache = useRef(new FrameCache());
  const displayMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance;
    document.documentElement.style.colorScheme = appearance;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", appearance === "light" ? "#f6f8f8" : "#101719");
    try {
      window.localStorage.setItem("pqviewer-appearance", appearance);
    } catch {}
  }, [appearance]);

  useEffect(() => {
    let active = true;
    setLoadState("loading");
    setLoadError("");
    getManifest()
      .then((value) => {
        if (!active) return;
        cache.current.clear();
        setManifest(value);
        setFrameIndex(0);
        setLoadedFrame(null);
        setSelectedAtom(null);
        setCellOffset([0, 0, 0]);
        setForceScale(1);
        setLoadState("ready");
        document.title = `${value.name || "Trajectory"} · PQViewer`;
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(message(error));
        setLoadState("error");
      });
    return () => {
      active = false;
    };
  }, [requestKey]);

  useEffect(() => {
    if (!manifest || manifest.frame_count === 0) return;
    let active = true;
    setFrameLoading(true);
    setFrameError("");
    cache.current
      .get(frameIndex)
      .then((data) => {
        if (!active) return;
        setLoadedFrame({ index: frameIndex, data });
        setFrameLoading(false);
        cache.current.prefetch((frameIndex + 1) % manifest.frame_count, manifest.frame_count);
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
  }, [frameIndex, manifest]);

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

  const moveCell = useCallback((offset: CellOffset) => {
    setCellOffset(offset);
    setResetSignal((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!displayOpen) return;
    const closeDisplayMenu = (event: PointerEvent) => {
      if (!displayMenuRef.current?.contains(event.target as Node)) setDisplayOpen(false);
    };
    window.addEventListener("pointerdown", closeDisplayMenu);
    return () => window.removeEventListener("pointerdown", closeDisplayMenu);
  }, [displayOpen]);

  useEffect(() => {
    if (!playing || !manifest || manifest.frame_count < 2) return;
    let animation = 0;
    let previous = performance.now();
    let elapsed = 0;
    const interval = 100 / speed;
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
  }, [manifest, playing, speed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape") {
        if (displayOpen) setDisplayOpen(false);
        else if (selectedAtom !== null) setSelectedAtom(null);
        else setShowInspector(false);
        return;
      }
      if (target?.matches("input, select, button, textarea")) return;
      if (event.code === "Space") {
        event.preventDefault();
        if ((manifest?.frame_count ?? 0) > 1) setPlaying((value) => !value);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setPlaying(false);
        setFrame(frameIndex - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        setFrame(frameIndex + 1);
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
  }, [displayOpen, frameIndex, manifest?.frame_count, selectView, selectedAtom, setFrame]);

  const frame = loadedFrame?.data ?? null;
  const cellAvailable = hasFrameCell(frame);
  const forces = frameArray(frame, ["forces", "force"]);
  const forceAvailable = Boolean(forces && forces.length >= (manifest?.topology.atom_count ?? 0) * 3);
  const pbc = framePbc(frame);
  const activeSeries = series.find((entry) => entry.name === seriesName) ?? null;
  const canPlay = (manifest?.frame_count ?? 0) > 1;
  const workspaceClass = [
    "workspace",
    showInspector ? "" : "inspector-hidden",
    series.length === 0 ? "timeline-compact" : "",
  ].filter(Boolean).join(" ");

  return (
    <main className="app-shell">
      <div className={workspaceClass} aria-busy={loadState === "loading" || frameLoading}>
        {manifest && manifest.frame_count > 0 ? (
          <MoleculeScene
            manifest={manifest}
            frame={frame}
            layers={layers}
            selectedAtom={selectedAtom}
            resetSignal={resetSignal}
            cellOffset={cellOffset}
            forceScale={forceScale}
            appearance={appearance}
            viewPreset={viewPreset}
            viewSignal={viewSignal}
            onSelect={selectAtom}
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
            <button
              className="appearance-toggle"
              type="button"
              aria-label={`Use ${appearance === "light" ? "dark" : "light"} appearance`}
              title={`Use ${appearance === "light" ? "dark" : "light"} appearance`}
              onClick={() => setAppearance((value) => value === "light" ? "dark" : "light")}
            >
              <Icon name={appearance === "light" ? "sun" : "moon"} />
              <span>{appearance === "light" ? "Light" : "Dark"}</span>
            </button>
          </div>
        </header>

        {manifest && manifest.frame_count > 0 && (
          <CanvasToolbar
            preset={viewPreset}
            layers={layers}
            cellAvailable={cellAvailable}
            forceAvailable={forceAvailable}
            displayOpen={displayOpen}
            displayMenuRef={displayMenuRef}
            showInspector={showInspector}
            onView={selectView}
            onDisplay={() => setDisplayOpen((value) => !value)}
            onLayer={(name) => setLayers((current) => ({ ...current, [name]: !current[name] }))}
            onFit={() => setResetSignal((value) => value + 1)}
            onInspector={() => setShowInspector((value) => !value)}
          />
        )}

        {manifest && (
          <Inspector
            open={showInspector}
            manifest={manifest}
            frame={frame}
            frameIndex={frameIndex}
            selectedAtom={selectedAtom}
            series={activeSeries}
            cellAvailable={cellAvailable}
            cellOffset={cellOffset}
            pbc={pbc}
            forceAvailable={forceAvailable}
            forceScale={forceScale}
            onCellOffset={moveCell}
            onForceScale={setForceScale}
            onClose={() => setShowInspector(false)}
          />
        )}

        {manifest && manifest.frame_count > 0 && (
          <Timeline
            frameCount={manifest.frame_count}
            frameIndex={frameIndex}
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
            action="Try again"
            onAction={() => setRequestKey((value) => value + 1)}
          />
        )}
        {loadState === "ready" && manifest?.frame_count === 0 && (
          <CenteredState title="No frames yet" detail="The file is valid but contains no complete frames." />
        )}
      </div>
    </main>
  );
}

function CanvasToolbar({
  preset,
  layers,
  cellAvailable,
  forceAvailable,
  displayOpen,
  displayMenuRef,
  showInspector,
  onView,
  onDisplay,
  onLayer,
  onFit,
  onInspector,
}: {
  preset: ViewPreset;
  layers: LayerState;
  cellAvailable: boolean;
  forceAvailable: boolean;
  displayOpen: boolean;
  displayMenuRef: React.RefObject<HTMLDivElement | null>;
  showInspector: boolean;
  onView: (preset: ViewPreset) => void;
  onDisplay: () => void;
  onLayer: (name: keyof LayerState) => void;
  onFit: () => void;
  onInspector: () => void;
}) {
  const views: Array<[ViewPreset, string, string]> = [
    ["perspective", "3D", "Perspective view (1)"],
    ["xy", "XY", "View along z (2)"],
    ["xz", "XZ", "View along y (3)"],
    ["yz", "YZ", "View along x (4)"],
  ];
  const layerItems: Array<[keyof LayerState, string, boolean, string?]> = [
    ["atoms", "Atoms", true],
    ["bonds", "Bonds", true],
    ["cell", "Cell", cellAvailable, "No cell data"],
    ["forces", "Forces", forceAvailable, "No force data"],
  ];

  return (
    <nav className="canvas-toolbar" aria-label="Scene controls">
      <div className="view-options" aria-label="Camera orientation">
        <span className="toolbar-label">View</span>
        {views.map(([value, label, title], index) => (
          <button
            key={value}
            className={preset === value ? "view-option is-active" : "view-option"}
            type="button"
            title={title}
            aria-label={title}
            aria-keyshortcuts={String(index + 1)}
            aria-pressed={preset === value}
            onClick={() => onView(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="display-control" ref={displayMenuRef}>
        <button
          className={displayOpen ? "toolbar-action is-active" : "toolbar-action"}
          type="button"
          aria-expanded={displayOpen}
          aria-haspopup="true"
          aria-controls="display-options"
          onClick={onDisplay}
        >
          Display
        </button>
        {displayOpen && (
          <div className="display-popover" id="display-options" role="group" aria-label="Visible layers">
            {layerItems.map(([name, label, available, reason]) => (
              <button
                key={name}
                className={`${layers[name] && available ? "display-option" : "display-option is-off"}${available ? "" : " is-unavailable"}`}
                type="button"
                title={available ? undefined : reason}
                aria-label={available ? label : `${label}: ${reason}`}
                aria-pressed={available ? layers[name] : false}
                disabled={!available}
                onClick={() => onLayer(name)}
              >
                <span aria-hidden="true">✓</span>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="toolbar-action" type="button" title="Fit structure (R)" aria-keyshortcuts="R" onClick={onFit}>Fit</button>
      <button
        className={showInspector ? "toolbar-action is-active" : "toolbar-action"}
        type="button"
        aria-label="Toggle data inspector"
        aria-pressed={showInspector}
        onClick={onInspector}
      >
        Data
      </button>
    </nav>
  );
}

function Inspector({
  open,
  manifest,
  frame,
  frameIndex,
  selectedAtom,
  series,
  cellAvailable,
  cellOffset,
  pbc,
  forceAvailable,
  forceScale,
  onCellOffset,
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
  cellOffset: CellOffset;
  pbc: [boolean, boolean, boolean];
  forceAvailable: boolean;
  forceScale: number;
  onCellOffset: (offset: CellOffset) => void;
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
  const selectionSection = atom === null ? null : (
    <section className="readout-section atom-section">
      <h3>Selection</h3>
      <Readout label="Element" value={symbol ?? "—"} />
      {manifest.topology.atom_names?.[atom] && <Readout label="Name" value={manifest.topology.atom_names[atom]} />}
      {manifest.topology.residue_ids?.[atom] !== undefined && (
        <Readout label="Residue" value={String(manifest.topology.residue_ids[atom])} />
      )}
      {positions && <VectorReadout label="Wrapped position" values={positions} offset={atom * 3} unit="Å" />}
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
        <Readout label="Bonds" value={manifest.topology.bonds?.length ? "Topology" : "Distance inferred"} />
      </section>

      {metrics && (
        <section className="readout-section cell-metrics-section">
          <h3>Cell</h3>
          <Readout label="a · b · c" value={`${metrics.lengths.map(formatNumber).join(" · ")} Å`} />
          <Readout label="α · β · γ" value={`${metrics.angles.map(formatNumber).join(" · ")}°`} />
        </section>
      )}

      {cellAvailable && (
        <PeriodicControls
          available
          offset={cellOffset}
          pbc={pbc}
          onOffset={onCellOffset}
        />
      )}

      {forceAvailable && <section className="readout-section force-section">
        <div className="section-heading-row">
          <h3>Forces</h3>
          <output title="Normalized independently for each frame">Auto · {formatNumber(forceScale)}×</output>
        </div>
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

function PeriodicControls({
  available,
  offset,
  pbc,
  onOffset,
}: {
  available: boolean;
  offset: CellOffset;
  pbc: [boolean, boolean, boolean];
  onOffset: (offset: CellOffset) => void;
}) {
  const axes = pbc.map((periodic, index) => periodic ? ["a", "b", "c"][index] : "").join("");
  const isOrigin = offset.every((value) => value === 0);
  const move = (axis: number, step: number) => {
    if (!pbc[axis]) return;
    const next = [...offset] as CellOffset;
    next[axis] += step;
    onOffset(next);
  };

  return (
    <section className="readout-section periodic-section">
      <div className="section-heading-row">
        <h3>Periodic</h3>
        {available && <span>{axes ? `Centered wrap · ${axes}` : "PBC off"}</span>}
      </div>
      {!available ? (
        <p className="quiet-copy">No cell data</p>
      ) : (
        <>
          <div className="cell-image-heading">
            <span>Cell image</span>
            <output>[{offset.join(" ")}]</output>
            <button type="button" disabled={isOrigin} onClick={() => onOffset([0, 0, 0])}>Reset</button>
          </div>
          {(["a", "b", "c"] as const).map((axis, index) => (
            <div className="cell-axis-control" key={axis}>
              <button type="button" disabled={!pbc[index]} onClick={() => move(index, -1)} aria-label={`Move cell by minus ${axis}`}>−{axis}</button>
              <output>{offset[index]}</output>
              <button type="button" disabled={!pbc[index]} onClick={() => move(index, 1)} aria-label={`Move cell by plus ${axis}`}>+{axis}</button>
            </div>
          ))}
        </>
      )}
    </section>
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
  action,
  onAction,
}: {
  title: string;
  detail?: string;
  busy?: boolean;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="centered-state" role={busy ? "status" : "alert"}>
      <div className={busy ? "state-orbit is-busy" : "state-orbit"} aria-hidden="true"><i /><i /><b /></div>
      <h1>{title}</h1>
      {detail && <p>{detail}</p>}
      {action && onAction && <button type="button" onClick={onAction}><Icon name="retry" />{action}</button>}
    </div>
  );
}

function Icon({ name }: { name: IconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {name === "atoms" && <><circle cx="8" cy="13" r="3.4" {...common} /><circle cx="16.4" cy="8" r="2.2" {...common} /><path d="m10.7 11.2 3.8-2.1" {...common} /></>}
      {name === "bonds" && <><circle cx="6" cy="16" r="2.2" {...common} /><circle cx="18" cy="8" r="2.2" {...common} /><path d="m8 14.7 8-5.4M9.1 16.4l8-5.3" {...common} /></>}
      {name === "cell" && <><path d="m5 8 8-4 6 4v9l-8 3-6-4V8Z" {...common} /><path d="m5 8 6 4 8-4M11 12v8" {...common} /></>}
      {name === "forces" && <><circle cx="7" cy="16" r="2.5" {...common} /><path d="m9 14 8-8m-4 0h4v4" {...common} /></>}
      {name === "home" && <><path d="M5 9V5h4M19 9V5h-4M5 15v4h4M19 15v4h-4" {...common} /><circle cx="12" cy="12" r="2" {...common} /></>}
      {name === "info" && <><circle cx="12" cy="12" r="8" {...common} /><path d="M12 11v5" {...common} /><path d="M12 8h.01" {...common} /></>}
      {name === "play" && <path d="m9 7 7 5-7 5V7Z" fill="currentColor" />}
      {name === "pause" && <><path d="M9 7v10M15 7v10" {...common} strokeWidth="2" /></>}
      {name === "back" && <><path d="m14.5 8-5 4 5 4" {...common} /><path d="M7 7v10" {...common} /></>}
      {name === "next" && <><path d="m9.5 8 5 4-5 4" {...common} /><path d="M17 7v10" {...common} /></>}
      {name === "close" && <path d="m8 8 8 8m0-8-8 8" {...common} />}
      {name === "retry" && <><path d="M18 9a7 7 0 1 0 .5 5" {...common} /><path d="M18 5v4h-4" {...common} /></>}
      {name === "sun" && <><circle cx="12" cy="12" r="3.3" {...common} /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" {...common} /></>}
      {name === "moon" && <path d="M18.3 15.8A7.4 7.4 0 0 1 8.2 5.7 7.4 7.4 0 1 0 18.3 15.8Z" {...common} />}
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
