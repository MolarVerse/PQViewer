import * as THREE from "three";

export type PublicationProjection = "orthographic" | "perspective";

export interface CameraSpaceBounds {
  minRight: number;
  maxRight: number;
  minUp: number;
  maxUp: number;
  minBack: number;
  maxBack: number;
}

export function publicationContextUsesPoints(
  primaryUsesPoints: boolean,
  totalAtomCount: number,
  sphereLimit: number,
): boolean {
  return primaryUsesPoints || totalAtomCount > sphereLimit;
}

interface CameraAxes {
  right: THREE.Vector3;
  up: THREE.Vector3;
  back: THREE.Vector3;
}

export function publicationCamera(
  root: THREE.Object3D,
  source: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  width: number,
  height: number,
  projection: PublicationProjection,
  fit: boolean,
  padding: number,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  const aspect = width / height;
  const axes = cameraAxes(source.quaternion);
  const bounds = cameraSpaceBounds(root, source.quaternion);
  if (!bounds) throw new Error("The molecular scene has no visible geometry");

  if (projection === "perspective") {
    const camera = source.clone();
    camera.aspect = aspect;
    if (fit) fitPerspectiveCamera(camera, root, bounds, axes, padding);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return camera;
  }

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10_000);
  camera.quaternion.copy(source.quaternion);
  const currentDistance = Math.max(source.position.distanceTo(target), 0.01);
  const currentHeight = 2 * currentDistance * Math.tan(THREE.MathUtils.degToRad(source.getEffectiveFOV() * 0.5));
  const center = fit ? boundsCenter(bounds, axes) : target.clone();
  const contentWidth = Math.max(bounds.maxRight - bounds.minRight, 0.01);
  const contentHeight = Math.max(bounds.maxUp - bounds.minUp, 0.01);
  const fill = Math.max(0.2, 1 - padding * 2);
  const viewHeight = fit
    ? Math.max(contentHeight / fill, contentWidth / (aspect * fill), 0.1)
    : Math.max(currentHeight, 0.1);
  const viewWidth = viewHeight * aspect;
  camera.left = -viewWidth * 0.5;
  camera.right = viewWidth * 0.5;
  camera.top = viewHeight * 0.5;
  camera.bottom = -viewHeight * 0.5;

  const depth = Math.max(bounds.maxBack - bounds.minBack, 0.01);
  const span = Math.max(contentWidth, contentHeight, depth, 1);
  const centerBack = center.dot(axes.back);
  const distance = fit
    ? depth * 0.5 + span * 1.5
    : Math.max(currentDistance, bounds.maxBack - centerBack + span);
  camera.position.copy(center).addScaledVector(axes.back, distance);
  const cameraBack = camera.position.dot(axes.back);
  camera.near = Math.max(cameraBack - bounds.maxBack - span * 0.25, 0.01);
  camera.far = Math.max(cameraBack - bounds.minBack + span * 0.25, camera.near + 10);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

export function cameraSpaceBounds(
  root: THREE.Object3D,
  quaternion: THREE.Quaternion,
): CameraSpaceBounds | null {
  root.updateMatrixWorld(true);
  const axes = cameraAxes(quaternion);
  const bounds: CameraSpaceBounds = {
    minRight: Infinity,
    maxRight: -Infinity,
    minUp: Infinity,
    maxUp: -Infinity,
    minBack: Infinity,
    maxBack: -Infinity,
  };
  let found = false;
  forEachRenderablePoint(root, (point) => {
    const right = point.dot(axes.right);
    const up = point.dot(axes.up);
    const back = point.dot(axes.back);
    bounds.minRight = Math.min(bounds.minRight, right);
    bounds.maxRight = Math.max(bounds.maxRight, right);
    bounds.minUp = Math.min(bounds.minUp, up);
    bounds.maxUp = Math.max(bounds.maxUp, up);
    bounds.minBack = Math.min(bounds.minBack, back);
    bounds.maxBack = Math.max(bounds.maxBack, back);
    found = true;
  });
  return found ? bounds : null;
}

function fitPerspectiveCamera(
  camera: THREE.PerspectiveCamera,
  root: THREE.Object3D,
  bounds: CameraSpaceBounds,
  axes: CameraAxes,
  padding: number,
): void {
  const center = boundsCenter(bounds, axes);
  const centerRight = (bounds.minRight + bounds.maxRight) * 0.5;
  const centerUp = (bounds.minUp + bounds.maxUp) * 0.5;
  const centerBack = (bounds.minBack + bounds.maxBack) * 0.5;
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.getEffectiveFOV() * 0.5);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
  const fill = Math.max(0.2, 1 - padding * 2);
  let distance = 0.01;
  forEachRenderablePoint(root, (point) => {
    const depth = point.dot(axes.back) - centerBack;
    distance = Math.max(
      distance,
      depth + Math.abs(point.dot(axes.right) - centerRight) / (Math.tan(horizontalHalfFov) * fill),
      depth + Math.abs(point.dot(axes.up) - centerUp) / (Math.tan(verticalHalfFov) * fill),
    );
  });
  const depth = Math.max(bounds.maxBack - bounds.minBack, 0.01);
  const span = Math.max(
    bounds.maxRight - bounds.minRight,
    bounds.maxUp - bounds.minUp,
    depth,
    1,
  );
  camera.position.copy(center).addScaledVector(axes.back, distance);
  camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(axes.right, axes.up, axes.back));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    camera.near = Math.max(distance - depth * 0.5 - span * 0.25, 0.01);
    camera.far = Math.max(distance + depth * 0.5 + span, camera.near + 10);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const projected = projectedExtent(root, camera);
    if (projected <= fill * 1.001) break;
    distance *= projected / fill * 1.005;
    camera.position.copy(center).addScaledVector(axes.back, distance);
  }
  camera.near = Math.max(distance - depth * 0.5 - span * 0.25, 0.01);
  camera.far = Math.max(distance + depth * 0.5 + span, camera.near + 10);
}

function cameraAxes(quaternion: THREE.Quaternion): CameraAxes {
  return {
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).normalize(),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize(),
    back: new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize(),
  };
}

function boundsCenter(bounds: CameraSpaceBounds, axes: CameraAxes): THREE.Vector3 {
  return new THREE.Vector3()
    .addScaledVector(axes.right, (bounds.minRight + bounds.maxRight) * 0.5)
    .addScaledVector(axes.up, (bounds.minUp + bounds.maxUp) * 0.5)
    .addScaledVector(axes.back, (bounds.minBack + bounds.maxBack) * 0.5);
}

function forEachRenderablePoint(root: THREE.Object3D, visit: (point: THREE.Vector3) => void): void {
  root.updateMatrixWorld(true);
  const instanceMatrix = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  const expandedPoint = new THREE.Vector3();
  root.traverse((object) => {
    if (object.visible === false) return;
    const fitPositions = object.userData.publicationFitPositions as number[] | Float32Array | undefined;
    if (fitPositions) {
      for (let offset = 0; offset + 2 < fitPositions.length; offset += 3) {
        visit(point.fromArray(fitPositions, offset).applyMatrix4(object.matrixWorld));
      }
      return;
    }

    const geometry = (object as THREE.Object3D & { geometry?: THREE.BufferGeometry }).geometry;
    if (!geometry) return;
    if (object instanceof THREE.InstancedMesh) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (!box || box.isEmpty()) return;
      for (let instance = 0; instance < object.count; instance += 1) {
        object.getMatrixAt(instance, instanceMatrix);
        worldMatrix.multiplyMatrices(object.matrixWorld, instanceMatrix);
        visitBoxCorners(box, worldMatrix, point, visit);
      }
      return;
    }

    const positions = geometry.getAttribute("position");
    if (positions) {
      const pointRadius = object instanceof THREE.Points && object.material instanceof THREE.PointsMaterial
        ? object.material.size * 0.55
        : 0;
      const pointOffsets = [-pointRadius, pointRadius];
      for (let vertex = 0; vertex < positions.count; vertex += 1) {
        point.fromBufferAttribute(positions, vertex).applyMatrix4(object.matrixWorld);
        if (pointRadius === 0) {
          visit(point);
          continue;
        }
        for (const x of pointOffsets) {
          for (const y of pointOffsets) {
            for (const z of pointOffsets) {
              visit(expandedPoint.set(point.x + x, point.y + y, point.z + z));
            }
          }
        }
      }
      return;
    }
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (geometry.boundingBox && !geometry.boundingBox.isEmpty()) {
      visitBoxCorners(geometry.boundingBox, object.matrixWorld, point, visit);
    }
  });
}

function visitBoxCorners(
  box: THREE.Box3,
  matrix: THREE.Matrix4,
  point: THREE.Vector3,
  visit: (point: THREE.Vector3) => void,
): void {
  for (let xIndex = 0; xIndex < 2; xIndex += 1) {
    for (let yIndex = 0; yIndex < 2; yIndex += 1) {
      for (let zIndex = 0; zIndex < 2; zIndex += 1) {
        visit(point.set(
          xIndex === 0 ? box.min.x : box.max.x,
          yIndex === 0 ? box.min.y : box.max.y,
          zIndex === 0 ? box.min.z : box.max.z,
        ).applyMatrix4(matrix));
      }
    }
  }
}

function projectedExtent(root: THREE.Object3D, camera: THREE.PerspectiveCamera): number {
  let extent = 0;
  const projected = new THREE.Vector3();
  forEachRenderablePoint(root, (point) => {
    projected.copy(point).project(camera);
    if (Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
      extent = Math.max(extent, Math.abs(projected.x), Math.abs(projected.y));
    }
  });
  return extent;
}
