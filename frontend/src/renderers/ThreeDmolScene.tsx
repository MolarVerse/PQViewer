import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { frameArray } from "../api";
import {
  MAX_DISPLACEMENT_ATOMS,
  MAX_TRAIL_ATOMS,
  alignedTrailSegments,
  isAdditivePick,
  nextKeyboardAtomCursor,
  sceneCapabilities,
  selectedDisplayedPosition,
  type MoleculeSceneHandle,
  type MoleculeSceneProps,
  type RenderedSceneInfo,
  type SceneCameraState,
  type TrajectoryOverlays,
  type ViewPreset,
} from "../MoleculeScene";
import {
  buildCoordinationPolyhedraGeometry,
  preferredCoordinationCenterAtomicNumbers,
  prepareCoordinationPolyhedraTopology,
} from "../scene/polyhedra";
import {
  imageTranslation,
  prepareFrameGeometry,
  prepareScene,
  transformDisplayVector,
  type PreparedScene,
  type Segment,
} from "../scene/model";
import type { AtomSelection, CellOffset, ScenePresentation } from "../types";
import {
  buildDmolScenePlan,
  dmolElementColor,
  selectedDmolPositions,
  selectionContextFromDmolModel,
  selectionFromDmolAtom,
  type DmolAtomRecord,
  type DmolScenePlan,
} from "./threeDmolModel";
import type {
  AtomSpec,
  GLModel,
  GLShape,
  GLViewer,
} from "3dmol";

interface ThreeDmolSceneProps extends MoleculeSceneProps {
  onEngineError?: (error: Error) => void;
}

interface DmolRuntime {
  viewer: GLViewer;
  model: GLModel | null;
  scene: PreparedScene | null;
  plan: DmolScenePlan | null;
  layoutKey: string;
  styleKey: string;
  fitMode: ScenePresentation["mode"];
  manifestName: string;
  fittedKey: string;
  lastResetSignal: number;
  lastViewSignal: number;
  selectionShape: GLShape | null;
  keyboardShape: GLShape | null;
  surfaceVersion: number;
  pickSerial: number;
  pointer: Pick<PointerEvent, "pointerType" | "shiftKey" | "metaKey" | "ctrlKey">;
}

interface SelectionRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface VectorArrow {
  tail: THREE.Vector3;
  tip: THREE.Vector3;
  head: number;
}

const EMPTY_OVERLAYS: TrajectoryOverlays = Object.freeze({
  trails: Object.freeze([]),
  displacements: Object.freeze([]),
});

const LIGHT_PALETTE = {
  background: "#F3F5F2",
  bond: "#849190",
  cell: "#8DA0A0",
  selection: "#177D93",
  keyboard: "#E07A3F",
  force: "#B8522D",
  velocity: "#6B62A8",
  trail: "#177D93",
  collision: "#C64236",
  polyhedron: "#6F98A7",
  polyhedronEdge: "#4E7380",
};

const DARK_PALETTE = {
  background: "#1E2E33",
  bond: "#B8C4C5",
  cell: "#6BAAB7",
  selection: "#72D4DF",
  keyboard: "#F2A66F",
  force: "#F0A75A",
  velocity: "#9E98D7",
  trail: "#72D4DF",
  collision: "#F07167",
  polyhedron: "#72AFC0",
  polyhedronEdge: "#9BD2DD",
};

const MAX_SELECTION_MARKERS = 512;
const MAX_SURFACE_ATOMS = 20_000;

export const ThreeDmolScene = forwardRef<MoleculeSceneHandle, ThreeDmolSceneProps>(
  function ThreeDmolScene({
    manifest,
    frame,
    preparedTopology,
    presentation,
    selectedAtoms,
    trajectoryOverlays = EMPTY_OVERLAYS,
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
    onEngineError,
  }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const runtimeRef = useRef<DmolRuntime | null>(null);
    const selectedRef = useRef(selectedAtoms);
    const selectRef = useRef(onSelect);
    const selectManyRef = useRef(onSelectMany);
    const errorRef = useRef(onEngineError);
    const keyboardSelectionRef = useRef<AtomSelection | null>(null);
    const keyboardInstanceRef = useRef<number | null>(null);
    const pendingCameraRef = useRef<SceneCameraState | null>(null);
    const [runtimeVersion, setRuntimeVersion] = useState(0);
    const [boxSelection, setBoxSelection] = useState<SelectionRectangle | null>(null);
    const [keyboardSelection, setKeyboardSelection] = useState<AtomSelection | null>(null);

    selectedRef.current = selectedAtoms;
    selectRef.current = onSelect;
    selectManyRef.current = onSelectMany;
    errorRef.current = onEngineError;

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      let disposed = false;
      let observer: ResizeObserver | null = null;

      void import("3dmol")
        .then((dmol) => {
          if (disposed) return;
          const viewer = dmol.createViewer(host, {
            backgroundColor: LIGHT_PALETTE.background,
            backgroundAlpha: 1,
            antialias: true,
            upscale: true,
            cartoonQuality: 12,
            disableFog: true,
            minimumZoomToDistance: 2.4,
          });
          viewer.setDefaultCartoonQuality(12);
          viewer.setProjection("perspective");
          runtimeRef.current = {
            viewer,
            model: null,
            scene: null,
            plan: null,
            layoutKey: "",
            styleKey: "",
            fitMode: "ball-stick",
            manifestName: "",
            fittedKey: "",
            lastResetSignal: -1,
            lastViewSignal: -1,
            selectionShape: null,
            keyboardShape: null,
            surfaceVersion: 0,
            pickSerial: 0,
            pointer: {
              pointerType: "mouse",
              shiftKey: false,
              metaKey: false,
              ctrlKey: false,
            },
          };
          let previousAspect = host.clientWidth / Math.max(1, host.clientHeight);
          observer = new ResizeObserver(() => {
            const aspect = host.clientWidth / Math.max(1, host.clientHeight);
            viewer.resize();
            const runtime = runtimeRef.current;
            if (
              runtime?.plan
              && Number.isFinite(previousAspect)
              && Math.abs(aspect - previousAspect) > 0.04
            ) {
              viewer.zoomTo();
              viewer.zoom(fitZoomFactor(
                runtime.plan.cellSegments.length > 0,
                runtime.fitMode,
                aspect,
              ));
            }
            previousAspect = aspect;
            viewer.render();
          });
          observer.observe(host);
          setRuntimeVersion((value) => value + 1);
        })
        .catch((reason: unknown) => {
          if (disposed) return;
          errorRef.current?.(
            reason instanceof Error ? reason : new Error("3Dmol could not be loaded"),
          );
        });

      return () => {
        disposed = true;
        observer?.disconnect();
        const runtime = runtimeRef.current;
        runtimeRef.current = null;
        runtime?.viewer.clear();
        host.replaceChildren();
      };
    }, []);

    useEffect(() => {
      const runtime = runtimeRef.current;
      const host = hostRef.current;
      if (!runtime || !host) return;
      const started = performance.now();
      const scene = prepareScene(manifest, frame, presentation, preparedTopology);
      if (!scene) {
        runtime.viewer.clear();
        runtime.model = null;
        runtime.scene = null;
        runtime.plan = null;
        runtime.styleKey = "";
        delete host.dataset.renderedManifest;
        delete host.dataset.sourceFrameIndex;
        host.dataset.atomCount = "0";
        host.dataset.renderMs = "0";
        onSceneInfo?.(null);
        onSelectionContext?.(null);
        return;
      }

      const planStarted = performance.now();
      const plan = buildDmolScenePlan(manifest, scene, presentation);
      const planMs = performance.now() - planStarted;
      const canUpdateCoordinates = runtime.model !== null
        && runtime.layoutKey === plan.layoutKey
        && runtime.plan?.atoms.length === plan.atoms.length;
      const styleKey = [
        presentation.mode,
        presentation.atomScale,
        presentation.bondScale,
        presentation.quality,
      ].join("|");
      if (canUpdateCoordinates) {
        const coordinates = plan.atoms.map(({ x, y, z }) => [x, y, z]);
        runtime.model!.setCoordinates([coordinates] as unknown as string, "array");
        void runtime.model!.setFrame(0);
      } else {
        runtime.viewer.removeAllModels();
        runtime.model = runtime.viewer.addModel();
        runtime.model.addAtoms(plan.atoms as AtomSpec[]);
      }
      const activeModel = runtime.model;
      if (!activeModel) throw new Error("3Dmol model creation failed");

      runtime.viewer.removeAllShapes();
      runtime.viewer.removeAllSurfaces();
      runtime.selectionShape = null;
      runtime.keyboardShape = null;
      if (!canUpdateCoordinates || runtime.styleKey !== styleKey) {
        applyModelStyle(activeModel, presentation, plan.atoms.length);
        runtime.styleKey = styleKey;
      }
      if (!canUpdateCoordinates) {
        activeModel.setClickable({}, true, (
          atom: AtomSpec,
          _viewer: GLViewer,
          event?: PointerEvent,
        ) => {
          runtime.pickSerial += 1;
          const selection = selectionFromDmolAtom(atom as DmolAtomRecord);
          if (!selection) return;
          const pointer = event ?? runtime.pointer;
          selectRef.current(selection, isAdditivePick(pointer));
        });
      }

      const palette = appearance === "light" ? LIGHT_PALETTE : DARK_PALETTE;
      const forces = frameArray(frame, ["forces", "force"]);
      const velocities = frameArray(frame, ["velocities", "velocity", "vel"]);
      const geometry = prepareFrameGeometry(
        scene,
        presentation,
        forces,
        velocities,
      );
      runtime.viewer.setBackgroundColor(palette.background, 1);
      addBondShape(runtime.viewer, plan.shapeBondSegments, presentation, palette.bond);
      addCellShape(runtime.viewer, plan.cellSegments, palette.cell);
      addCollisionShape(runtime.viewer, plan.collisionSegments, palette.collision);
      addVectorShapes(
        runtime.viewer,
        scene,
        forces,
        forceScale,
        geometry.forceInstances,
        palette.force,
      );
      addVectorShapes(
        runtime.viewer,
        scene,
        velocities,
        velocityScale,
        geometry.velocityInstances,
        palette.velocity,
      );
      addTrajectoryShapes(runtime.viewer, scene, trajectoryOverlays, palette);
      const polyhedronCount = presentation.mode === "polyhedra"
        ? addPolyhedraShape(runtime.viewer, scene, palette, presentation.cell)
        : 0;
      if (presentation.mode === "surface" && plan.atoms.length <= MAX_SURFACE_ATOMS) {
        const version = ++runtime.surfaceVersion;
        const surface = runtime.viewer.addSurface(
          "VDW",
          { color: "#BCD4D8", opacity: 0.26 },
          {},
          {},
        );
        Promise.resolve(surface)
          .then(() => {
            if (runtimeRef.current !== runtime || runtime.surfaceVersion !== version) return;
            runtime.viewer.render();
          })
          .catch((reason: unknown) => {
            if (runtimeRef.current !== runtime || runtime.surfaceVersion !== version) return;
            errorRef.current?.(
              reason instanceof Error ? reason : new Error("Surface generation failed"),
            );
          });
      } else {
        runtime.surfaceVersion += 1;
      }

      runtime.scene = scene;
      runtime.plan = plan;
      runtime.layoutKey = plan.layoutKey;
      runtime.fitMode = presentation.mode;
      runtime.manifestName = manifest.name;
      onSelectionContext?.(selectionContextFromDmolModel(manifest, scene));
      const info: RenderedSceneInfo = {
        imageCount: scene.images.length,
        forceCount: geometry.forceInstances.length,
        forceTotal: geometry.forceTotal,
        velocityCount: geometry.velocityInstances.length,
        velocityTotal: geometry.velocityTotal,
        capabilities: sceneCapabilities(manifest, frame, presentation, preparedTopology),
      };
      onSceneInfo?.(info);

      const fitKey = [
        manifest.name,
        manifest.topology.atom_count,
        plan.layoutKey,
        presentation.mode === "ribbon" ? "ribbon" : "structure",
        plan.cellSegments.length,
      ].join("|");
      if (
        runtime.fittedKey !== fitKey
        || runtime.lastResetSignal !== resetSignal
        || runtime.lastViewSignal !== viewSignal
      ) {
        applyViewPreset(
          runtime.viewer,
          viewPreset,
          plan.cellSegments.length > 0,
          presentation.mode,
          host.clientWidth / Math.max(1, host.clientHeight),
        );
        runtime.fittedKey = fitKey;
        runtime.lastResetSignal = resetSignal;
        runtime.lastViewSignal = viewSignal;
      }
      runtime.viewer.render();
      const pendingCamera = pendingCameraRef.current;
      if (pendingCamera) {
        restoreDmolCamera(runtime.viewer, pendingCamera);
        pendingCameraRef.current = null;
      }
      host.dataset.renderedManifest = manifest.name;
      host.dataset.sourceFrameIndex = String(
        frame?.header.frame_key?.source_index ?? "",
      );
      host.dataset.atomCount = String(plan.atoms.length);
      host.dataset.bondCount = String(plan.bondSegments.length);
      host.dataset.boundaryBondCount = String(plan.boundaryBondCount);
      host.dataset.renderedBoundaryBondCount = String(plan.shapeBondSegments.length);
      host.dataset.polyhedronCount = String(polyhedronCount);
      host.dataset.cellSegmentCount = String(plan.cellSegments.length);
      host.dataset.collisionCount = String(plan.collisionSegments.length);
      host.dataset.forceCount = String(geometry.forceInstances.length);
      host.dataset.velocityCount = String(geometry.velocityInstances.length);
      host.dataset.planMs = planMs.toFixed(1);
      host.dataset.viewerMs = (performance.now() - planStarted - planMs).toFixed(1);
      host.dataset.renderMs = (performance.now() - started).toFixed(1);
    }, [
      appearance,
      forceScale,
      frame,
      manifest,
      onSceneInfo,
      onSelectionContext,
      preparedTopology,
      presentation,
      resetSignal,
      runtimeVersion,
      trajectoryOverlays,
      velocityScale,
      viewPreset,
      viewSignal,
    ]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime?.scene) {
        onSelectionPositions?.(null);
        return;
      }
      updateSelectionShape(runtime, selectedAtoms, appearance);
      updateKeyboardShape(runtime, keyboardSelection, appearance);
      runtime.viewer.render();
      onSelectionPositions?.(
        selectedDmolPositions(runtime.scene, selectedAtoms),
      );
    }, [
      appearance,
      frame,
      keyboardSelection,
      onSelectionPositions,
      presentation,
      selectedAtoms,
      runtimeVersion,
    ]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      let start: { x: number; y: number; pointerId: number } | null = null;
      let moved = false;
      let selecting = false;

      const rectangle = (event: PointerEvent): SelectionRectangle => {
        const bounds = host.getBoundingClientRect();
        const x = Math.max(bounds.left, Math.min(bounds.right, event.clientX));
        const y = Math.max(bounds.top, Math.min(bounds.bottom, event.clientY));
        const left = Math.min(start!.x, x);
        const top = Math.min(start!.y, y);
        return {
          left,
          top,
          width: Math.abs(x - start!.x),
          height: Math.abs(y - start!.y),
        };
      };
      const reset = () => {
        start = null;
        moved = false;
        selecting = false;
        setBoxSelection(null);
      };
      const pointerDown = (event: PointerEvent) => {
        const runtime = runtimeRef.current;
        if (!runtime) return;
        runtime.pointer = event;
        if (!event.shiftKey || event.button !== 0) return;
        start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
        selecting = true;
        host.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const pointerMove = (event: PointerEvent) => {
        if (!selecting || !start || event.pointerId !== start.pointerId) return;
        const next = rectangle(event);
        moved ||= next.width > 4 || next.height > 4;
        setBoxSelection(next);
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const pointerUp = (event: PointerEvent) => {
        const runtime = runtimeRef.current;
        if (selecting && start && event.pointerId === start.pointerId) {
          if (moved && runtime?.plan) {
            const rect = rectangle(event);
            const points = runtime.viewer.modelToScreen(runtime.plan.atoms);
            const matches: AtomSelection[] = [];
            const seen = new Set<string>();
            points.forEach((point, index) => {
              if (
                point.x < rect.left
                || point.x > rect.left + rect.width
                || point.y < rect.top
                || point.y > rect.top + rect.height
              ) return;
              const selection = runtime.plan!.selections[index];
              const key = `${selection.atom}:${selection.image.join(":")}`;
              if (seen.has(key)) return;
              seen.add(key);
              matches.push(selection);
            });
            selectManyRef.current?.(matches, true);
          }
          if (host.hasPointerCapture(event.pointerId)) {
            host.releasePointerCapture(event.pointerId);
          }
          reset();
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (!runtime || event.button !== 0) return;
        const pickSerial = runtime.pickSerial;
        window.setTimeout(() => {
          if (
            runtimeRef.current === runtime
            && runtime.pickSerial === pickSerial
            && !isAdditivePick(event)
          ) {
            selectRef.current(null, false);
          }
        }, 0);
      };
      const pointerCancel = () => reset();
      const focus = () => {
        const runtime = runtimeRef.current;
        if (!runtime?.scene) return;
        const cursor = nextKeyboardAtomCursor(
          runtime.scene.instanceToAtom,
          runtime.scene.instanceImages,
          selectedRef.current.at(-1) ?? null,
          null,
          0,
          runtime.scene.baseImages,
        );
        keyboardSelectionRef.current = cursor?.selection ?? null;
        keyboardInstanceRef.current = cursor?.instance ?? null;
        setKeyboardSelection(cursor?.selection ?? null);
      };
      const blur = () => {
        keyboardSelectionRef.current = null;
        keyboardInstanceRef.current = null;
        setKeyboardSelection(null);
      };
      const keyDown = (event: KeyboardEvent) => {
        const runtime = runtimeRef.current;
        if (!runtime?.scene || event.metaKey || event.ctrlKey || event.altKey) return;
        const direction = event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowUp" ? -1 : 0;
        if (direction !== 0) {
          const cursor = nextKeyboardAtomCursor(
            runtime.scene.instanceToAtom,
            runtime.scene.instanceImages,
            keyboardSelectionRef.current,
            keyboardInstanceRef.current,
            direction,
            runtime.scene.baseImages,
          );
          keyboardSelectionRef.current = cursor?.selection ?? null;
          keyboardInstanceRef.current = cursor?.instance ?? null;
          setKeyboardSelection(cursor?.selection ?? null);
          event.preventDefault();
          return;
        }
        if (event.key !== "Enter" || event.repeat) return;
        const cursor = nextKeyboardAtomCursor(
          runtime.scene.instanceToAtom,
          runtime.scene.instanceImages,
          keyboardSelectionRef.current ?? selectedRef.current.at(-1) ?? null,
          keyboardInstanceRef.current,
          0,
          runtime.scene.baseImages,
        );
        if (!cursor) return;
        keyboardSelectionRef.current = cursor.selection;
        keyboardInstanceRef.current = cursor.instance;
        setKeyboardSelection(cursor.selection);
        selectRef.current(cursor.selection, true);
        event.preventDefault();
      };
      const escape = (event: KeyboardEvent) => {
        if (event.key !== "Escape" || !selecting) return;
        reset();
        event.preventDefault();
      };
      const wheel = (event: WheelEvent) => {
        const runtime = runtimeRef.current;
        if (!runtime) return;
        const factor = Math.max(0.5, Math.min(2, Math.exp(-event.deltaY * 0.001)));
        runtime.viewer.zoom(factor);
        runtime.viewer.render();
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      host.addEventListener("pointerdown", pointerDown, true);
      host.addEventListener("pointermove", pointerMove, true);
      host.addEventListener("pointerup", pointerUp, true);
      host.addEventListener("pointercancel", pointerCancel, true);
      host.addEventListener("focus", focus);
      host.addEventListener("blur", blur);
      host.addEventListener("keydown", keyDown);
      host.addEventListener("wheel", wheel, { capture: true, passive: false });
      window.addEventListener("keydown", escape);
      return () => {
        host.removeEventListener("pointerdown", pointerDown, true);
        host.removeEventListener("pointermove", pointerMove, true);
        host.removeEventListener("pointerup", pointerUp, true);
        host.removeEventListener("pointercancel", pointerCancel, true);
        host.removeEventListener("focus", focus);
        host.removeEventListener("blur", blur);
        host.removeEventListener("keydown", keyDown);
        host.removeEventListener("wheel", wheel, true);
        window.removeEventListener("keydown", escape);
      };
    }, [runtimeVersion]);

    useImperativeHandle(ref, () => ({
      exportPng: async () => {
        throw new Error("Publication export is provided by the renderer facade");
      },
      exportFigure: async () => {
        throw new Error("Publication export is provided by the renderer facade");
      },
      captureCamera: () => captureDmolCamera(runtimeRef.current?.viewer),
      restoreCamera: (camera) => {
        const runtime = runtimeRef.current;
        if (!runtime?.plan) {
          pendingCameraRef.current = camera;
          return;
        }
        restoreDmolCamera(runtime.viewer, camera);
      },
    }), [runtimeVersion]);

    const keyboardLabel = keyboardSelection
      ? `${manifest.topology.symbols?.[keyboardSelection.atom] ?? "Atom"} ${keyboardSelection.atom + 1}`
      : "";

    return <>
      <div
        ref={hostRef}
        className={boxSelection
          ? "molecule-canvas molecule-stage-3dmol is-box-selecting"
          : "molecule-canvas molecule-stage-3dmol"}
        data-renderer="3dmol"
        data-representation={presentation.mode}
        data-wrap={presentation.wrap}
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
  },
);

function applyModelStyle(
  model: GLModel,
  presentation: ScenePresentation,
  atomCount: number,
): void {
  const color = (atom: AtomSpec) => String(atom.color ?? "#65757A");
  model.setStyle({}, {});
  if (presentation.mode === "ribbon") {
    const cartoon = {
      style: "edged" as const,
      arrows: true,
      tubes: false,
      thickness: 0.42,
      opacity: 1,
    };
    if (presentation.color === "structure") {
      model.setStyle(
        { hetflag: false },
        {
          cartoon: {
            ...cartoon,
            color: "#438493",
          },
        },
      );
      model.setStyle(
        { hetflag: false, ss: "h" },
        { cartoon: { ...cartoon, color: "#C96A5A" } },
      );
      model.setStyle(
        { hetflag: false, ss: "s" },
        { cartoon: { ...cartoon, color: "#D2A23A" } },
      );
    } else {
      model.setStyle(
        { hetflag: false },
        { cartoon: { ...cartoon, colorfunc: color } },
      );
    }
    model.setStyle(
      { hetflag: true },
      {
        sphere: { scale: 0.24, colorfunc: color },
        stick: { radius: 0.11, color: "#849190" },
      },
      true,
    );
    return;
  }
  if (atomCount > 100_000) {
    model.setStyle({}, {
      cross: {
        scale: Math.max(0.25, presentation.atomScale * 0.45),
        colorfunc: color,
      },
      line: { color: "#849190", opacity: 0.58 },
    });
    return;
  }
  if (presentation.mode === "lines") {
    model.setStyle({}, {
      sphere: {
        radius: Math.max(0.055, presentation.atomScale * 0.095),
        colorfunc: color,
      },
      line: { color: "#879492", opacity: 0.62 },
    });
    return;
  }
  if (presentation.mode === "spacefill") {
    model.setStyle({}, {
      sphere: { scale: presentation.atomScale, colorfunc: color },
    });
    return;
  }
  if (presentation.mode === "polyhedra") {
    model.setStyle({}, {
      sphere: {
        radius: 0.17 * presentation.atomScale,
        colorfunc: color,
      },
    });
    return;
  }
  if (presentation.mode === "licorice") {
    model.setStyle({}, {
      sphere: {
        radius: 0.23 * presentation.atomScale,
        colorfunc: color,
      },
      stick: {
        radius: 0.19 * presentation.bondScale,
        color: "#849190",
      },
    });
    return;
  }
  model.setStyle({}, {
    sphere: {
      scale: Math.max(0.18, presentation.atomScale * 0.26),
      colorfunc: color,
    },
    stick: {
      radius: (presentation.mode === "surface" ? 0.05 : 0.085)
        * presentation.bondScale,
      color: "#849190",
    },
  });
}

function addBondShape(
  viewer: GLViewer,
  segments: readonly Segment[],
  presentation: ScenePresentation,
  color: string,
): void {
  if (
    segments.length === 0
    || presentation.mode === "spacefill"
    || presentation.mode === "ribbon"
    || presentation.mode === "polyhedra"
  ) {
    return;
  }
  const shape = viewer.addShape({ color, opacity: 0.92 });
  if (presentation.mode === "lines" || segments.length > 12_000) {
    for (const segment of segments) {
      shape.addLine({
        start: xyz(segment.from),
        end: xyz(segment.to),
        color,
        opacity: 0.9,
      });
    }
    return;
  }
  const radius = presentation.mode === "licorice"
      ? 0.19 * presentation.bondScale
      : (segments.length > 256 ? 0.045 : 0.085) * presentation.bondScale;
  for (const segment of segments) {
    shape.addCylinder({
      start: xyz(segment.from),
      end: xyz(segment.to),
      radius,
      color,
      fromCap: "round",
      toCap: "round",
    });
  }
}

function addCellShape(
  viewer: GLViewer,
  segments: readonly Segment[],
  color: string,
): void {
  if (segments.length === 0) return;
  const shape = viewer.addShape({ color, opacity: 0.62 });
  for (const segment of segments) {
    shape.addCylinder({
      start: xyz(segment.from),
      end: xyz(segment.to),
      radius: 0.01,
      color,
      opacity: 0.62,
      fromCap: "flat",
      toCap: "flat",
    });
  }
}

function addCollisionShape(
  viewer: GLViewer,
  segments: readonly Segment[],
  color: string,
): void {
  if (segments.length === 0) return;
  const shape = viewer.addShape({ color, opacity: 0.9 });
  segments.forEach((segment, index) => {
    shape.addDashedCylinder({
      start: xyz(segment.from),
      end: xyz(segment.to),
      radius: 0.035,
      dashLength: 0.11,
      gapLength: 0.09,
      color,
    });
    if (index < 64) {
      shape.addSphere({
        center: xyz(segment.from),
        radius: 0.58,
        color,
        opacity: 0.72,
        wireframe: true,
      });
      shape.addSphere({
        center: xyz(segment.to),
        radius: 0.58,
        color,
        opacity: 0.72,
        wireframe: true,
      });
    }
  });
}

function addVectorShapes(
  viewer: GLViewer,
  scene: PreparedScene,
  vectors: Float32Array | null,
  scaleFactor: number,
  instances: readonly number[],
  color: string,
): void {
  const arrows = vectorArrows(scene, vectors, scaleFactor, instances);
  if (arrows.length === 0) return;
  const shape = viewer.addShape({ color });
  for (const arrow of arrows) {
    shape.addArrow({
      start: xyz(arrow.tail),
      end: xyz(arrow.tip),
      radius: 0.025,
      radiusRatio: Math.max(2.5, arrow.head / 0.025),
      midpos: -arrow.head,
      color,
    });
  }
}

function vectorArrows(
  scene: PreparedScene,
  vectors: Float32Array | null,
  scaleFactor: number,
  instances: readonly number[],
): VectorArrow[] {
  if (!vectors || vectors.length < scene.count * 3) return [];
  const magnitudes = instances
    .map((instance) => {
      const atom = scene.instanceToAtom[instance];
      return Math.hypot(
        vectors[atom * 3],
        vectors[atom * 3 + 1],
        vectors[atom * 3 + 2],
      );
    })
    .filter((value) => Number.isFinite(value) && value > 1e-12)
    .sort((left, right) => left - right);
  if (magnitudes.length === 0) return [];
  const reference = magnitudes[Math.floor((magnitudes.length - 1) * 0.9)];
  const scale = (1.45 / reference) * scaleFactor;
  const arrows: VectorArrow[] = [];
  for (const instance of instances) {
    const atom = scene.instanceToAtom[instance];
    const offset = atom * 3;
    const direction = new THREE.Vector3(
      vectors[offset],
      vectors[offset + 1],
      vectors[offset + 2],
    );
    const magnitude = direction.length();
    if (!Number.isFinite(magnitude) || magnitude <= 1e-12) continue;
    transformDisplayVector(direction.normalize(), scene);
    const position = instancePosition(scene, instance);
    const length = magnitude * scale;
    const head = Math.min(0.24, Math.max(0.075, length * 0.24), length * 0.5);
    const gap = (scene.radii[atom] ?? 0.3) * 1.03;
    arrows.push({
      tail: position.clone().addScaledVector(direction, gap),
      tip: position.clone().addScaledVector(direction, gap + length),
      head,
    });
  }
  return arrows;
}

function addTrajectoryShapes(
  viewer: GLViewer,
  scene: PreparedScene,
  overlays: TrajectoryOverlays,
  palette: typeof LIGHT_PALETTE,
): void {
  for (const overlay of overlays.trails.slice(0, MAX_TRAIL_ATOMS)) {
    const segments = alignedTrailSegments(scene, overlay);
    if (segments.length === 0) continue;
    const shape = viewer.addShape({ color: palette.trail, opacity: 0.76 });
    for (let offset = 0; offset < segments.length; offset += 6) {
      shape.addLine({
        start: { x: segments[offset], y: segments[offset + 1], z: segments[offset + 2] },
        end: { x: segments[offset + 3], y: segments[offset + 4], z: segments[offset + 5] },
        color: palette.trail,
        opacity: 0.76,
      });
    }
  }
  for (const overlay of overlays.displacements.slice(0, MAX_DISPLACEMENT_ATOMS)) {
    const tip = selectedDisplayedPosition(scene, overlay.atom, overlay.image);
    if (!tip || ![...overlay.from, ...overlay.to].every(Number.isFinite)) continue;
    const displacement = new THREE.Vector3(
      overlay.to[0] - overlay.from[0],
      overlay.to[1] - overlay.from[1],
      overlay.to[2] - overlay.from[2],
    ).applyMatrix3(scene.displayTransform);
    if (displacement.lengthSq() <= 1e-20) continue;
    viewer.addArrow({
      start: xyz(tip.clone().sub(displacement)),
      end: xyz(tip),
      color: palette.trail,
      radius: 0.02,
      radiusRatio: 3.5,
      mid: 0.78,
      opacity: 0.84,
    });
  }
}

function addPolyhedraShape(
  viewer: GLViewer,
  scene: PreparedScene,
  palette: typeof LIGHT_PALETTE,
  containedInCell: boolean,
): number {
  const visible = new Set(scene.visibleAtoms);
  const bonds = scene.bonds.filter(([left, right]) => visible.has(left) && visible.has(right));
  const input = {
    positions: scene.positions,
    atomicNumbers: scene.atomicNumbers,
    bonds,
    basis: scene.basis,
    pbc: scene.pbc,
  };
  const maxCenters = scene.visibleAtoms.length > 24 ? 8 : 64;
  const centerAtomicNumbers = preferredCoordinationCenterAtomicNumbers(input);
  const topology = prepareCoordinationPolyhedraTopology(input, {
    maxCenters,
    centerAtomicNumbers,
  });
  const geometry = buildCoordinationPolyhedraGeometry(
    input,
    {
      images: scene.images,
      maxCenters,
      centerAtomicNumbers,
      containedInCell,
      cellCenter: scene.cellCenter,
      colorForCenter: (_atom, atomicNumber) => (
        palette === DARK_PALETTE
          ? palette.polyhedron
          : dmolElementColor(atomicNumber) ?? palette.polyhedron
      ),
    },
    topology,
  );
  if (!geometry) return 0;
  geometry.computeVertexNormals();
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const vertexArr = Array.from({ length: position.count }, (_, index) => ({
    x: position.getX(index),
    y: position.getY(index),
    z: position.getZ(index),
  }));
  const normalArr = normal
    ? Array.from({ length: normal.count }, (_, index) => ({
        x: normal.getX(index),
        y: normal.getY(index),
        z: normal.getZ(index),
      }))
    : undefined;
  const colors = geometry.getAttribute("color");
  const vertexColors = Array.from({ length: colors.count }, (_, index) => (
    `rgb(${Math.round(colors.getX(index) * 255)}, `
    + `${Math.round(colors.getY(index) * 255)}, `
    + `${Math.round(colors.getZ(index) * 255)})`
  ));
  viewer.addCustom({
    vertexArr,
    normalArr,
    faceArr: Array.from({ length: position.count }, (_, index) => index),
    color: vertexColors,
    opacity: 0.38,
  });
  const edges = geometry.userData.edgePositions;
  if (edges instanceof Float32Array) {
    const shape = viewer.addShape({ color: palette.polyhedronEdge, opacity: 0.42 });
    for (let offset = 0; offset < edges.length; offset += 6) {
      shape.addLine({
        start: { x: edges[offset], y: edges[offset + 1], z: edges[offset + 2] },
        end: { x: edges[offset + 3], y: edges[offset + 4], z: edges[offset + 5] },
        color: palette.polyhedronEdge,
      });
    }
  }
  const count = Number(geometry.userData.polyhedronCount) || 0;
  geometry.dispose();
  return count;
}

function updateSelectionShape(
  runtime: DmolRuntime,
  selections: readonly AtomSelection[],
  appearance: "light" | "dark",
): void {
  if (runtime.selectionShape) {
    runtime.viewer.removeShape(runtime.selectionShape);
    runtime.selectionShape = null;
  }
  if (!runtime.scene || !runtime.plan || selections.length === 0) return;
  const selected = new Set(selections.map(selectionKey));
  const shape = runtime.viewer.addShape({
    color: appearance === "light" ? LIGHT_PALETTE.selection : DARK_PALETTE.selection,
    wireframe: true,
    opacity: 0.82,
  });
  let count = 0;
  runtime.plan.atoms.forEach((atom, index) => {
    if (count >= MAX_SELECTION_MARKERS) return;
    const selection = runtime.plan!.selections[index];
    if (!selected.has(selectionKey(selection))) return;
    shape.addSphere({
      center: { x: atom.x, y: atom.y, z: atom.z },
      radius: Math.max(0.3, (runtime.scene!.radii[selection.atom] ?? 0.3) * 1.35),
      color: appearance === "light" ? LIGHT_PALETTE.selection : DARK_PALETTE.selection,
      wireframe: true,
      opacity: 0.82,
      quality: 2,
    });
    count += 1;
  });
  runtime.selectionShape = shape;
}

function updateKeyboardShape(
  runtime: DmolRuntime,
  selection: AtomSelection | null,
  appearance: "light" | "dark",
): void {
  if (runtime.keyboardShape) {
    runtime.viewer.removeShape(runtime.keyboardShape);
    runtime.keyboardShape = null;
  }
  if (!runtime.scene || !runtime.plan || !selection) return;
  const index = runtime.plan.selections.findIndex(
    (candidate) => selectionKey(candidate) === selectionKey(selection),
  );
  if (index < 0) return;
  const atom = runtime.plan.atoms[index];
  const color = appearance === "light" ? LIGHT_PALETTE.keyboard : DARK_PALETTE.keyboard;
  runtime.keyboardShape = runtime.viewer.addSphere({
    center: { x: atom.x, y: atom.y, z: atom.z },
    radius: Math.max(0.34, (runtime.scene.radii[selection.atom] ?? 0.3) * 1.58),
    color,
    wireframe: true,
    opacity: 0.94,
    quality: 2,
  });
}

function applyViewPreset(
  viewer: GLViewer,
  preset: ViewPreset,
  includeCell: boolean,
  mode: ScenePresentation["mode"],
  aspect: number,
): void {
  const current = viewer.getView();
  viewer.setView([
    current[0],
    current[1],
    current[2],
    current[3],
    0,
    0,
    0,
    1,
  ]);
  viewer.zoomTo();
  if (preset === "perspective") {
    viewer.setProjection("perspective");
    viewer.rotate(24, "x");
    viewer.rotate(-32, "y");
  } else {
    viewer.setProjection("orthographic");
    if (preset === "xz") viewer.rotate(90, "x");
    if (preset === "yz") viewer.rotate(-90, "y");
  }
  viewer.zoom(fitZoomFactor(includeCell, mode, aspect));
}

function fitZoomFactor(
  includeCell: boolean,
  mode: ScenePresentation["mode"],
  aspect: number,
): number {
  const margin = includeCell ? 0.9 : mode === "ribbon" ? 0.98 : 0.76;
  return margin * Math.min(1, Math.max(0.35, aspect));
}

function captureDmolCamera(viewer: GLViewer | undefined): SceneCameraState {
  if (!viewer) throw new Error("The molecular scene is not ready");
  const view = viewer.getView();
  const target = new THREE.Vector3(-view[0], -view[1], -view[2]);
  const modelRotation = new THREE.Quaternion(view[4], view[5], view[6], view[7]).normalize();
  const cameraRotation = modelRotation.clone().invert();
  const distance = viewer.getPerceivedDistance();
  const position = new THREE.Vector3(0, 0, distance)
    .applyQuaternion(cameraRotation)
    .add(target);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cameraRotation).normalize();
  return {
    position: position.toArray(),
    target: target.toArray(),
    up: up.toArray(),
    fov: 20,
    zoom: 1,
    near: 1,
    far: 800,
  };
}

function restoreDmolCamera(
  viewer: GLViewer | undefined,
  camera: SceneCameraState,
): void {
  if (!viewer) throw new Error("The molecular scene is not ready");
  const values = [
    ...camera.position,
    ...camera.target,
    ...camera.up,
    camera.fov,
    camera.zoom,
    camera.near,
    camera.far,
  ];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("The saved camera is invalid");
  }
  const position = new THREE.Vector3().fromArray(camera.position);
  const target = new THREE.Vector3().fromArray(camera.target);
  const up = new THREE.Vector3().fromArray(camera.up).normalize();
  const rotation = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(position, target, up),
  );
  const modelRotation = rotation.invert();
  viewer.setView([
    -target.x,
    -target.y,
    -target.z,
    viewer.getView()[3],
    modelRotation.x,
    modelRotation.y,
    modelRotation.z,
    modelRotation.w,
  ]);
  viewer.setPerceivedDistance(position.distanceTo(target));
  viewer.render();
}

function instancePosition(scene: PreparedScene, instance: number): THREE.Vector3 {
  const atom = scene.instanceToAtom[instance];
  const point = new THREE.Vector3().fromArray(scene.positions, atom * 3);
  if (!scene.basis) return point;
  const offset = instance * 3;
  return point
    .addScaledVector(scene.basis.vectors[0], scene.instanceImages[offset])
    .addScaledVector(scene.basis.vectors[1], scene.instanceImages[offset + 1])
    .addScaledVector(scene.basis.vectors[2], scene.instanceImages[offset + 2]);
}

function selectionKey(selection: AtomSelection): string {
  return `${selection.atom}:${selection.image[0]}:${selection.image[1]}:${selection.image[2]}`;
}

function xyz(vector: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: vector.x, y: vector.y, z: vector.z };
}
