import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { frameArray, FrameCache, getManifest, normalizeSeries } from "./api";
import { MoleculeScene } from "./MoleculeScene";
import type { DisplaySeries, FrameData, LayerState, Manifest } from "./types";

type LoadState = "loading" | "ready" | "error";
type IconName = "atoms" | "bonds" | "cell" | "forces" | "home" | "info" | "play" | "pause" | "back" | "next" | "close" | "retry";

const initialLayers: LayerState = { atoms: true, bonds: true, cell: false, forces: false };

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
  const [showInspector, setShowInspector] = useState(() => window.innerWidth > 760);
  const [resetSignal, setResetSignal] = useState(0);
  const [seriesName, setSeriesName] = useState("");
  const cache = useRef(new FrameCache());

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
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [frameIndex, manifest?.frame_count, setFrame]);

  const frame = loadedFrame?.data ?? null;
  const activeSeries = series.find((entry) => entry.name === seriesName) ?? null;
  const canPlay = (manifest?.frame_count ?? 0) > 1;

  return (
    <main className="app-shell">
      <div className={showInspector ? "workspace" : "workspace inspector-hidden"} aria-busy={loadState === "loading" || frameLoading}>
        {manifest && manifest.frame_count > 0 ? (
          <MoleculeScene
            manifest={manifest}
            frame={frame}
            layers={layers}
            selectedAtom={selectedAtom}
            resetSignal={resetSignal}
            onSelect={setSelectedAtom}
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
          {manifest && (
            <div className="scene-status">
              <span className={frameLoading ? "status-dot is-busy" : "status-dot"} />
              {manifest.topology.atom_count.toLocaleString()} atoms
              <span aria-hidden="true">·</span>
              Å
            </div>
          )}
        </header>

        <LayerRail
          layers={layers}
          showInspector={showInspector}
          onLayer={(name) => setLayers((current) => ({ ...current, [name]: !current[name] }))}
          onReset={() => setResetSignal((value) => value + 1)}
          onInspector={() => setShowInspector((value) => !value)}
        />

        {manifest && (
          <Inspector
            open={showInspector}
            manifest={manifest}
            frame={frame}
            frameIndex={frameIndex}
            selectedAtom={selectedAtom}
            series={activeSeries}
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

function LayerRail({
  layers,
  showInspector,
  onLayer,
  onReset,
  onInspector,
}: {
  layers: LayerState;
  showInspector: boolean;
  onLayer: (name: keyof LayerState) => void;
  onReset: () => void;
  onInspector: () => void;
}) {
  const items: Array<[keyof LayerState, string, IconName]> = [
    ["atoms", "Atoms", "atoms"],
    ["bonds", "Bonds", "bonds"],
    ["cell", "Cell", "cell"],
    ["forces", "Forces", "forces"],
  ];
  return (
    <nav className="layer-rail" aria-label="Scene layers">
      {items.map(([name, label, icon]) => (
        <button
          key={name}
          className={layers[name] ? "rail-button is-active" : "rail-button"}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={layers[name]}
          onClick={() => onLayer(name)}
        >
          <Icon name={icon} />
          <span>{label}</span>
        </button>
      ))}
      <div className="rail-spacer" />
      <button className="rail-button" type="button" title="Reset view" aria-label="Reset view" onClick={onReset}>
        <Icon name="home" />
        <span>View</span>
      </button>
      <button
        className={showInspector ? "rail-button is-active" : "rail-button"}
        type="button"
        title="Inspector"
        aria-label="Inspector"
        aria-pressed={showInspector}
        onClick={onInspector}
      >
        <Icon name="info" />
        <span>Info</span>
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
  onClose,
}: {
  open: boolean;
  manifest: Manifest;
  frame: FrameData | null;
  frameIndex: number;
  selectedAtom: number | null;
  series: DisplaySeries | null;
  onClose: () => void;
}) {
  const positions = frameArray(frame, ["positions", "position", "pos", "coordinates", "coords"]);
  const forces = frameArray(frame, ["forces", "force"]);
  const charges = frameArray(frame, ["charges", "charge"]);
  const atom = selectedAtom !== null && selectedAtom < manifest.topology.atom_count ? selectedAtom : null;
  const symbol = atom !== null ? atomSymbol(manifest, atom) : null;
  const frameProperties = scalarProperties(frame, series?.name);
  const seriesValue = series?.values[frameIndex] ?? null;
  const step = scalarValue(frame, "step");
  const time = scalarValue(frame, "time");

  return (
    <aside className={open ? "inspector is-open" : "inspector"} aria-label="Inspector">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Inspector</span>
          <h2>{atom === null ? "Frame" : `${symbol} · Atom ${atom + 1}`}</h2>
        </div>
        <button className="icon-button close-inspector" type="button" onClick={onClose} aria-label="Close inspector">
          <Icon name="close" />
        </button>
      </div>

      <section className="readout-section">
        <h3>Frame</h3>
        <Readout label="Index" value={`${frameIndex + 1} / ${manifest.frame_count}`} />
        {step !== null && <Readout label="Step" value={formatNumber(step)} />}
        {time !== null && <Readout label="Time" value={formatNumber(time)} />}
        {series && seriesValue !== null && (
          <Readout label={series.label} value={`${formatNumber(seriesValue)}${series.unit ? ` ${series.unit}` : ""}`} accent />
        )}
        {frameProperties.slice(0, 5).map(([label, value]) => (
          <Readout key={label} label={label} value={value} />
        ))}
      </section>

      <section className="readout-section atom-section">
        <h3>Selection</h3>
        {atom === null ? (
          <p className="quiet-copy">Select an atom in the scene.</p>
        ) : (
          <>
            <Readout label="Element" value={symbol ?? "—"} />
            {manifest.topology.atom_names?.[atom] && <Readout label="Name" value={manifest.topology.atom_names[atom]} />}
            {manifest.topology.residue_ids?.[atom] !== undefined && (
              <Readout label="Residue" value={String(manifest.topology.residue_ids[atom])} />
            )}
            {positions && <VectorReadout label="Position" values={positions} offset={atom * 3} unit="Å" />}
            {forces && <VectorReadout label="Force" values={forces} offset={atom * 3} />}
            {charges && charges[atom] !== undefined && <Readout label="Charge" value={formatNumber(charges[atom])} />}
          </>
        )}
      </section>

      <div className="inspector-hint">Drag to rotate · Scroll to zoom</div>
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
    <section className="timeline" aria-label="Trajectory controls">
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

      <div className="plot-row">
        <div className="plot-label">
          {series.length > 0 ? (
            <select value={activeSeries?.name ?? ""} onChange={(event) => onSeries(event.target.value)} aria-label="Timeline property">
              {series.map((entry) => <option key={entry.name} value={entry.name}>{entry.label}</option>)}
            </select>
          ) : (
            <span>Trajectory</span>
          )}
          <small>{activeSeries?.unit ?? "frames"}</small>
        </div>
        <SeriesPlot series={activeSeries} frameCount={frameCount} frameIndex={frameIndex} onFrame={onFrame} />
        {frameError && <div className="frame-error" title={frameError}>Frame unavailable</div>}
      </div>
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
    </svg>
  );
}

function scalarProperties(frame: FrameData | null, excludedName?: string): Array<[string, string]> {
  if (!frame) return [];
  const seen = new Set(["step", "time", "frame_index", "index", "arrays", "scalars", "properties"]);
  const excluded = normalizeName(excludedName ?? "");
  const values: Array<[string, string]> = [];
  const add = (name: string, value: unknown) => {
    const normalized = normalizeName(name);
    if (seen.has(normalized) || normalized === excluded || typeof value !== "number" || !Number.isFinite(value)) return;
    seen.add(normalized);
    values.push([displayLabel(name), formatNumber(value)]);
  };
  Object.entries(frame.header.scalars ?? {}).forEach(([name, value]) => add(name, value));
  Object.entries(frame.header.properties ?? {}).forEach(([name, value]) => add(name, value));
  add("energy", frame.header.energy);
  return values;
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

const elementSymbols = [
  "X", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar",
  "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr",
];
