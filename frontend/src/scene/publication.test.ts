import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { cameraSpaceBounds, publicationCamera, publicationContextUsesPoints } from "./publication";

function sceneWithBox(): { root: THREE.Group; corners: THREE.Vector3[] } {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 1), new THREE.MeshBasicMaterial());
  mesh.position.set(1.4, -0.7, 0.3);
  mesh.rotation.set(0.2, -0.35, 0.15);
  root.add(mesh);
  root.updateMatrixWorld(true);
  const corners: THREE.Vector3[] = [];
  for (const x of [-2, 2]) {
    for (const y of [-1, 1]) {
      for (const z of [-0.5, 0.5]) corners.push(new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld));
    }
  }
  return { root, corners };
}

function sourceCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 5000);
  camera.position.set(7, 5, 9);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

describe("publication camera", () => {
  it("measures renderables directly in camera space", () => {
    const { root, corners } = sceneWithBox();
    const camera = sourceCamera();
    const bounds = cameraSpaceBounds(root, camera.quaternion)!;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    expect(bounds.minRight).toBeCloseTo(Math.min(...corners.map((point) => point.dot(right))), 6);
    expect(bounds.maxRight).toBeCloseTo(Math.max(...corners.map((point) => point.dot(right))), 6);
    expect(bounds.minUp).toBeCloseTo(Math.min(...corners.map((point) => point.dot(up))), 6);
    expect(bounds.maxUp).toBeCloseTo(Math.max(...corners.map((point) => point.dot(up))), 6);
  });

  it("centers fitted orthographic geometry with balanced margins", () => {
    const { root, corners } = sceneWithBox();
    const camera = publicationCamera(
      root,
      sourceCamera(),
      new THREE.Vector3(),
      2400,
      1800,
      "orthographic",
      true,
      0.08,
    );
    expect(camera).toBeInstanceOf(THREE.OrthographicCamera);
    const projected = corners.map((corner) => corner.clone().project(camera));
    const minX = Math.min(...projected.map((point) => point.x));
    const maxX = Math.max(...projected.map((point) => point.x));
    const minY = Math.min(...projected.map((point) => point.y));
    const maxY = Math.max(...projected.map((point) => point.y));
    expect((minX + maxX) * 0.5).toBeCloseTo(0, 6);
    expect((minY + maxY) * 0.5).toBeCloseTo(0, 6);
    expect(Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY))).toBeLessThanOrEqual(0.841);
    expect(Math.max(maxX - minX, maxY - minY)).toBeGreaterThan(1.2);
  });

  it("fits perspective output without clipping", () => {
    const { root, corners } = sceneWithBox();
    const camera = publicationCamera(
      root,
      sourceCamera(),
      new THREE.Vector3(),
      1800,
      2400,
      "perspective",
      true,
      0.08,
    );
    const projected = corners.map((corner) => corner.clone().project(camera));
    projected.forEach((point) => {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(0.841);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(0.841);
      expect(point.z).toBeGreaterThanOrEqual(-1);
      expect(point.z).toBeLessThanOrEqual(1);
    });
  });

  it("keeps depth-translated geometry inside a current orthographic export", () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    mesh.position.z = -200;
    root.add(mesh);
    const source = new THREE.PerspectiveCamera(34, 1, 0.02, 5000);
    source.position.set(0, 0, 10);
    source.lookAt(0, 0, 0);
    source.updateMatrixWorld(true);
    const camera = publicationCamera(
      root,
      source,
      new THREE.Vector3(),
      1200,
      900,
      "orthographic",
      false,
      0.08,
    );
    const projected = mesh.position.clone().project(camera);
    expect(projected.z).toBeGreaterThanOrEqual(-1);
    expect(projected.z).toBeLessThanOrEqual(1);
  });
});

describe("publication context detail", () => {
  it("matches point primaries and protects the sphere budget", () => {
    expect(publicationContextUsesPoints(true, 10, 80_000)).toBe(true);
    expect(publicationContextUsesPoints(false, 80_000, 80_000)).toBe(false);
    expect(publicationContextUsesPoints(false, 80_001, 80_000)).toBe(true);
  });
});
