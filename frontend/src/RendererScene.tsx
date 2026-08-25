import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  MoleculeScene as ThreeScene,
  type FigureExportOptions,
  type MoleculeSceneHandle,
  type MoleculeSceneProps,
  type SceneCameraState,
} from "./MoleculeScene";
import type { PngExportOptions } from "./scene/pngExport";
import { ThreeDmolScene } from "./renderers/ThreeDmolScene";

export * from "./MoleculeScene";

export type RendererEngineId = "3dmol" | "three";

interface PublicationRequest {
  id: number;
  kind: "png" | "figure";
  options: PngExportOptions | FigureExportOptions;
  camera: SceneCameraState;
  resolve: (blob: Blob) => void;
  reject: (reason: Error) => void;
  started: boolean;
  timeout: number;
}

export function resolveRendererEngine(_search?: string): RendererEngineId {
  return "3dmol";
}

export const MoleculeScene = forwardRef<MoleculeSceneHandle, MoleculeSceneProps>(
  function RendererScene(props, ref) {
    const preferredEngine = resolveRendererEngine();
    const [fallback, setFallback] = useState(false);
    const [publicationRequest, setPublicationRequest] =
      useState<PublicationRequest | null>(null);
    const [publicationReady, setPublicationReady] = useState(0);
    const interactiveRef = useRef<MoleculeSceneHandle>(null);
    const publicationRef = useRef<MoleculeSceneHandle>(null);
    const publicationRequestRef = useRef<PublicationRequest | null>(null);
    const requestIdRef = useRef(0);
    const engine: RendererEngineId = fallback ? "three" : preferredEngine;

    publicationRequestRef.current = publicationRequest;

    const exportWithPublicationRenderer = useCallback((
      kind: PublicationRequest["kind"],
      options: PngExportOptions | FigureExportOptions,
    ): Promise<Blob> => {
      if (engine === "three") {
        const scene = interactiveRef.current;
        if (!scene) return Promise.reject(new Error("The molecular scene is not ready"));
        return kind === "png"
          ? scene.exportPng(options as PngExportOptions)
          : scene.exportFigure(options as FigureExportOptions);
      }
      if (props.presentation.mode === "surface") {
        return Promise.reject(
          new Error("Surface figures are not available in the publication renderer. Choose another preset."),
        );
      }
      if (publicationRequestRef.current) {
        return Promise.reject(new Error("A figure export is already in progress"));
      }
      const scene = interactiveRef.current;
      if (!scene) return Promise.reject(new Error("The molecular scene is not ready"));
      let camera: SceneCameraState;
      try {
        camera = scene.captureCamera();
      } catch (reason) {
        return Promise.reject(
          reason instanceof Error ? reason : new Error("The molecular scene is not ready"),
        );
      }
      return new Promise<Blob>((resolve, reject) => {
        const id = ++requestIdRef.current;
        const timeout = window.setTimeout(() => {
          const active = publicationRequestRef.current;
          if (!active || active.id !== id) return;
          active.reject(new Error("The publication renderer did not become ready"));
          publicationRequestRef.current = null;
          setPublicationRequest(null);
        }, 60_000);
        const request: PublicationRequest = {
          id,
          kind,
          options,
          camera,
          resolve,
          reject,
          started: false,
          timeout,
        };
        publicationRequestRef.current = request;
        setPublicationRequest(request);
      });
    }, [engine, props.presentation.mode]);

    useImperativeHandle(ref, () => ({
      exportPng: (options) => exportWithPublicationRenderer("png", options),
      exportFigure: (options) => exportWithPublicationRenderer("figure", options),
      captureCamera: () => {
        const scene = interactiveRef.current;
        if (!scene) throw new Error("The molecular scene is not ready");
        return scene.captureCamera();
      },
      restoreCamera: (camera) => {
        const scene = interactiveRef.current;
        if (!scene) throw new Error("The molecular scene is not ready");
        scene.restoreCamera(camera);
      },
    }), [exportWithPublicationRenderer]);

    useEffect(() => {
      const request = publicationRequestRef.current;
      const scene = publicationRef.current;
      if (!request || !scene || request.started || publicationReady !== request.id) return;
      request.started = true;
      try {
        scene.restoreCamera(request.camera);
      } catch (reason) {
        window.clearTimeout(request.timeout);
        request.reject(
          reason instanceof Error ? reason : new Error("The publication camera could not be restored"),
        );
        publicationRequestRef.current = null;
        setPublicationRequest(null);
        return;
      }
      const operation = request.kind === "png"
        ? scene.exportPng(request.options as PngExportOptions)
        : scene.exportFigure(request.options as FigureExportOptions);
      void operation
        .then(request.resolve, (reason: unknown) => {
          request.reject(
            reason instanceof Error ? reason : new Error("Figure export failed"),
          );
        })
        .finally(() => {
          window.clearTimeout(request.timeout);
          if (publicationRequestRef.current?.id === request.id) {
            publicationRequestRef.current = null;
            setPublicationRequest(null);
          }
        });
    }, [publicationReady]);

    useEffect(() => () => {
      const request = publicationRequestRef.current;
      if (!request) return;
      window.clearTimeout(request.timeout);
      request.reject(new Error("Figure export was cancelled"));
    }, []);

    return <>
      {engine === "3dmol" ? (
        <ThreeDmolScene
          {...props}
          ref={interactiveRef}
          onEngineError={() => setFallback(true)}
        />
      ) : (
        <ThreeScene {...props} ref={interactiveRef} />
      )}
      {publicationRequest && engine === "3dmol" && (
        <div
          className="publication-renderer-source"
          data-testid="publication-renderer-source"
          aria-hidden="true"
        >
          <ThreeScene
            {...props}
            ref={publicationRef}
            onSelect={() => undefined}
            onSelectMany={() => undefined}
            onSceneInfo={(info) => {
              if (info) setPublicationReady(publicationRequest.id);
            }}
            onSelectionContext={() => undefined}
            onSelectionPositions={() => undefined}
          />
        </div>
      )}
    </>;
  },
);
