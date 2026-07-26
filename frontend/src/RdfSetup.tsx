import { useEffect, useMemo, useRef, useState } from "react";

export const MAX_RDF_FRAMES = 10_000;

export interface AnalysisSelectionOption {
  id: string;
  label: string;
  atomIndices: readonly number[];
}

export interface RdfSetupValue {
  reference: AnalysisSelectionOption;
  target: AnalysisSelectionOption;
  frameStart: number;
  frameStop: number;
  frameStep: number;
  bins: number;
  rMax?: number;
  initialView: "rdf" | "coordination";
}

interface RdfSetupProps {
  open: boolean;
  frameCount: number;
  options: readonly AnalysisSelectionOption[];
  defaultReferenceId?: string;
  initialView: "rdf" | "coordination";
  onRun: (value: RdfSetupValue) => void;
  onClose: () => void;
}

export function RdfSetup({
  open,
  frameCount,
  options,
  defaultReferenceId,
  initialView,
  onRun,
  onClose,
}: RdfSetupProps) {
  const defaultReference = optionById(options, defaultReferenceId) ?? options[0];
  const defaultTarget = options.find((option) => option.id !== defaultReference?.id)
    ?? defaultReference;
  const [referenceId, setReferenceId] = useState(defaultReference?.id ?? "");
  const [targetId, setTargetId] = useState(defaultTarget?.id ?? "");
  const [frames, setFrames] = useState("all");
  const [bins, setBins] = useState("200");
  const [rMax, setRMax] = useState("");
  const referenceSelect = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (!open) return;
    const reference = optionById(options, defaultReferenceId) ?? options[0];
    const target = options.find((option) => option.id !== reference?.id) ?? reference;
    setReferenceId(reference?.id ?? "");
    setTargetId(target?.id ?? "");
    setFrames("all");
    setBins("200");
    setRMax("");
  }, [defaultReferenceId, open, options]);

  useEffect(() => {
    if (!open) return;
    const animation = requestAnimationFrame(() => referenceSelect.current?.focus());
    return () => cancelAnimationFrame(animation);
  }, [open]);

  const allFrameStep = Math.max(1, Math.ceil(frameCount / MAX_RDF_FRAMES));
  const sampledFrameCount = Math.ceil(frameCount / allFrameStep);
  const frameChoices = useMemo(() => [
    {
      value: "all",
      label: allFrameStep === 1
        ? `All · ${frameCount.toLocaleString()}`
        : `All · ${sampledFrameCount.toLocaleString()} sampled`,
    },
    ...(frameCount > 100 ? [{ value: "last-100", label: "Last 100" }] : []),
    ...(frameCount > 1_000 ? [{ value: "last-1000", label: "Last 1,000" }] : []),
  ], [allFrameStep, frameCount, sampledFrameCount]);
  if (!open) return null;
  const reference = optionById(options, referenceId);
  const target = optionById(options, targetId);
  const parsedBins = Number(bins);
  const parsedRMax = rMax.trim() ? Number(rMax) : undefined;
  const valid = Boolean(
    reference
    && target
    && Number.isSafeInteger(parsedBins)
    && parsedBins >= 20
    && parsedBins <= 2_000
    && (parsedRMax === undefined || (Number.isFinite(parsedRMax) && parsedRMax > 0)),
  );
  const submit = () => {
    if (!valid || !reference || !target) return;
    onRun(buildRdfSetupValue({
      reference,
      target,
      frames,
      frameCount,
      bins: parsedBins,
      rMax: parsedRMax,
      initialView,
    }));
  };

  return <section
    className="rdf-sheet"
    role="dialog"
    aria-labelledby="rdf-sheet-title"
    onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }}
  >
    <header>
      <strong id="rdf-sheet-title">Pair analysis</strong>
      <button type="button" onClick={onClose} aria-label="Close">×</button>
    </header>
    <div className="rdf-sheet__body">
      <label>
        <span>From</span>
        <select
          ref={referenceSelect}
          value={referenceId}
          onChange={(event) => setReferenceId(event.target.value)}
        >
          {options.map((option) => <option key={option.id} value={option.id}>
            {option.label} · {option.atomIndices.length.toLocaleString()}
          </option>)}
        </select>
      </label>
      <label>
        <span>To</span>
        <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          {options.map((option) => <option key={option.id} value={option.id}>
            {option.label} · {option.atomIndices.length.toLocaleString()}
          </option>)}
        </select>
      </label>
      <label>
        <span>Frames</span>
        <select value={frames} onChange={(event) => setFrames(event.target.value)}>
          {frameChoices.map((choice) => <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>)}
        </select>
      </label>
      <details>
        <summary>Advanced</summary>
        <div>
          <label>
            <span>Bins</span>
            <input
              inputMode="numeric"
              value={bins}
              onChange={(event) => setBins(event.target.value)}
            />
          </label>
          <label>
            <span>r max · Å</span>
            <input
              inputMode="decimal"
              value={rMax}
              placeholder="Automatic"
              onChange={(event) => setRMax(event.target.value)}
            />
          </label>
        </div>
      </details>
    </div>
    <footer>
      <span>PQAnalysis · full periodic cells</span>
      <button type="button" disabled={!valid} onClick={submit}>Run</button>
    </footer>
  </section>;
}

export function buildRdfSetupValue({
  reference,
  target,
  frames,
  frameCount,
  bins,
  rMax,
  initialView,
}: {
  reference: AnalysisSelectionOption;
  target: AnalysisSelectionOption;
  frames: string;
  frameCount: number;
  bins: number;
  rMax?: number;
  initialView: "rdf" | "coordination";
}): RdfSetupValue {
  const requested = frames === "last-100"
    ? 100
    : frames === "last-1000" ? 1_000 : frameCount;
  const frameStep = frames === "all"
    ? Math.max(1, Math.ceil(frameCount / MAX_RDF_FRAMES))
    : 1;
  return {
    reference,
    target,
    frameStart: Math.max(0, frameCount - requested),
    frameStop: frameCount,
    frameStep,
    bins,
    rMax,
    initialView,
  };
}

function optionById(
  options: readonly AnalysisSelectionOption[],
  id: string | undefined,
): AnalysisSelectionOption | undefined {
  return id ? options.find((option) => option.id === id) : undefined;
}
