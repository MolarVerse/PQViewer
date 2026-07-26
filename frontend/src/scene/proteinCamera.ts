import * as THREE from "three";

export interface ProteinCameraComposition {
  center: THREE.Vector3;
  direction: THREE.Vector3;
  up: THREE.Vector3;
  points: THREE.Vector3[];
  radius: number;
}

interface PrincipalAxes {
  major: THREE.Vector3;
  middle: THREE.Vector3;
  minor: THREE.Vector3;
  linear: boolean;
}

const EPSILON = 1e-10;

export function proteinCameraComposition(
  positions: ArrayLike<number>,
  caIndices: readonly number[],
  scale = 1,
  aspect = 4 / 3,
  faceNormals: readonly (THREE.Vector3 | null)[] = [],
): ProteinCameraComposition | null {
  const points = caIndices
    .filter((index) => Number.isInteger(index) && index >= 0 && index * 3 + 2 < positions.length)
    .map((index) => new THREE.Vector3(
      Number(positions[index * 3]),
      Number(positions[index * 3 + 1]),
      Number(positions[index * 3 + 2]),
    ))
    .filter((point) => [point.x, point.y, point.z].every(Number.isFinite));
  if (points.length < 3) return null;

  const mean = points.reduce((sum, point) => sum.add(point), new THREE.Vector3())
    .multiplyScalar(1 / points.length);
  const axes = principalAxes(points, mean);
  if (!axes) return null;

  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3;
  const {
    direction,
    right: landscapeRight,
    up: landscapeUp,
  } = axes.linear
    ? linearProjection(axes, faceNormals)
    : bestProjection(
        points,
        mean,
        axes,
        Math.max(safeAspect, 1 / safeAspect),
        faceNormals.length === points.length ? faceNormals : [],
      );
  const right = safeAspect >= 1 ? landscapeRight : landscapeUp.clone().negate();
  const up = safeAspect >= 1 ? landscapeUp : landscapeRight;
  const center = projectedCenter(points, right, up, direction);
  const safeScale = Number.isFinite(scale) ? Math.max(0.2, scale) : 1;

  return {
    center,
    direction,
    up,
    points,
    radius: 0.9 * safeScale,
  };
}

function linearProjection(
  axes: PrincipalAxes,
  faceNormals: readonly (THREE.Vector3 | null)[],
): { direction: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 } {
  const normals = faceNormals.flatMap((normal) => {
    if (!normal || !finiteUnitVector(normal)) return [];
    const projected = normal.clone()
      .addScaledVector(axes.major, -normal.dot(axes.major));
    return projected.lengthSq() > EPSILON ? [projected.normalize()] : [];
  });
  let direction = axes.minor.clone();
  if (normals.length > 0) {
    let bestVisibility = -1;
    for (let index = 0; index < 96; index += 1) {
      const angle = index / 96 * Math.PI;
      const candidate = axes.minor.clone().multiplyScalar(Math.cos(angle))
        .addScaledVector(axes.middle, Math.sin(angle))
        .normalize();
      const visibility = normals.reduce(
        (sum, normal) => sum + Math.abs(candidate.dot(normal)),
        0,
      ) / normals.length;
      if (visibility > bestVisibility + 1e-9) {
        direction = candidate;
        bestVisibility = visibility;
      }
    }
  }
  return {
    direction,
    right: axes.major.clone(),
    up: new THREE.Vector3().crossVectors(direction, axes.major).normalize(),
  };
}

function bestProjection(
  points: readonly THREE.Vector3[],
  center: THREE.Vector3,
  axes: PrincipalAxes,
  targetAspect: number,
  faceNormals: readonly (THREE.Vector3 | null)[],
): { direction: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 } {
  const sampleIndices = sampledTraceIndices(points.length, 128);
  const sample = sampleIndices.map((index) => points[index]);
  const sampledFaceNormals = sampleIndices.flatMap((index) => {
    const normal = faceNormals[index];
    return normal && finiteUnitVector(normal) ? [normal] : [];
  });
  const candidates: THREE.Vector3[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < 96; index += 1) {
    const minorWeight = (index + 0.5) / 96;
    const radialWeight = Math.sqrt(Math.max(0, 1 - minorWeight * minorWeight));
    const angle = index * goldenAngle;
    candidates.push(
      axes.major.clone().multiplyScalar(radialWeight * Math.cos(angle))
        .addScaledVector(axes.middle, radialWeight * Math.sin(angle))
        .addScaledVector(axes.minor, minorWeight)
        .normalize(),
    );
  }
  candidates.push(
    axes.minor.clone(),
    axes.minor.clone().addScaledVector(axes.middle, 0.35).normalize(),
    axes.minor.clone().addScaledVector(axes.major, 0.35).normalize(),
  );

  let best: ReturnType<typeof projectionFrame> | null = null;
  let bestScore = Infinity;
  for (const direction of candidates) {
    const frame = projectionFrame(sample, center, direction);
    const score = projectionScore(
      sample,
      center,
      frame,
      targetAspect,
      sampledFaceNormals,
    );
    if (!best || score < bestScore - 1e-9) {
      best = frame;
      bestScore = score;
    }
  }
  return best ?? projectionFrame(sample, center, axes.minor);
}

function projectionFrame(
  points: readonly THREE.Vector3[],
  center: THREE.Vector3,
  direction: THREE.Vector3,
): { direction: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 } {
  const seed = Math.abs(direction.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const baseRight = new THREE.Vector3().crossVectors(seed, direction).normalize();
  const baseUp = new THREE.Vector3().crossVectors(direction, baseRight).normalize();
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    const relative = point.clone().sub(center);
    const x = relative.dot(baseRight);
    const y = relative.dot(baseUp);
    xx += x * x;
    xy += x * y;
    yy += y * y;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const right = baseRight.clone().multiplyScalar(Math.cos(angle))
    .addScaledVector(baseUp, Math.sin(angle))
    .normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  return { direction, right, up };
}

function projectionScore(
  points: readonly THREE.Vector3[],
  center: THREE.Vector3,
  frame: { direction: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 },
  targetAspect: number,
  faceNormals: readonly THREE.Vector3[],
): number {
  const projected = points.map((point) => {
    const relative = point.clone().sub(center);
    return {
      x: relative.dot(frame.right),
      y: relative.dot(frame.up),
      depth: relative.dot(frame.direction),
    };
  });
  const xs = projected.map(({ x }) => x);
  const ys = projected.map(({ y }) => y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  if (width < EPSILON || height < EPSILON) return Infinity;

  const ratio = Math.max(width, height) / Math.min(width, height);
  const aspectPenalty = Math.abs(Math.log(ratio / targetAspect));
  const diagonal = Math.hypot(width, height);
  let closePairs = 0;
  let pairCount = 0;
  for (let left = 0; left < projected.length; left += 1) {
    for (let right = left + 4; right < projected.length; right += 1) {
      pairCount += 1;
      if (Math.hypot(
        projected[left].x - projected[right].x,
        projected[left].y - projected[right].y,
      ) < diagonal * 0.032) {
        closePairs += 1;
      }
    }
  }

  let projectedStep = 0;
  let spatialStep = 0;
  for (let index = 1; index < projected.length; index += 1) {
    projectedStep += Math.hypot(
      projected[index].x - projected[index - 1].x,
      projected[index].y - projected[index - 1].y,
    );
    spatialStep += points[index].distanceTo(points[index - 1]);
  }
  const stepPenalty = 1 - Math.min(1, projectedStep / Math.max(spatialStep, EPSILON));
  const crossingPenalty = projectedCrossings(projected) / Math.max(1, projected.length - 1);
  const densityPenalty = closePairs / Math.max(1, pairCount);
  const fillPenalty = 1 - convexHullFill(projected, width, height);
  const projectedVariance = projected.reduce(
    (sum, point) => sum + point.x * point.x + point.y * point.y,
    0,
  );
  const spatialVariance = projected.reduce(
    (sum, point) => sum + point.x * point.x + point.y * point.y + point.depth * point.depth,
    0,
  );
  const footprint = THREE.MathUtils.clamp(
    Math.sqrt(projectedVariance / Math.max(spatialVariance, EPSILON)),
    0,
    1,
  );
  const faceVisibility = faceNormals.length === 0
    ? 1
    : faceNormals.reduce(
        (sum, normal) => sum + Math.abs(frame.direction.dot(normal)),
        0,
      ) / faceNormals.length;
  return aspectPenalty * 2.8
    + crossingPenalty * 2.5
    + densityPenalty * 0.6
    + stepPenalty * 0.25
    + fillPenalty * 0.35
    + (1 - footprint) * 4
    + (1 - faceVisibility) * 2;
}

function projectedCrossings(
  points: readonly { x: number; y: number }[],
): number {
  let crossings = 0;
  for (let left = 0; left < points.length - 1; left += 1) {
    for (let right = left + 3; right < points.length - 1; right += 1) {
      if (segmentsCross(points[left], points[left + 1], points[right], points[right + 1])) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

function segmentsCross(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): boolean {
  const abC = signedArea(a, b, c);
  const abD = signedArea(a, b, d);
  const cdA = signedArea(c, d, a);
  const cdB = signedArea(c, d, b);
  return abC * abD < -EPSILON && cdA * cdB < -EPSILON;
}

function signedArea(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function convexHullFill(
  points: readonly { x: number; y: number }[],
  width: number,
  height: number,
): number {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y);
  const half = (entries: typeof sorted): typeof sorted => {
    const result: typeof sorted = [];
    for (const point of entries) {
      while (
        result.length >= 2
        && signedArea(result[result.length - 2], result[result.length - 1], point) <= 0
      ) {
        result.pop();
      }
      result.push(point);
    }
    return result;
  };
  const hull = [
    ...half(sorted).slice(0, -1),
    ...half([...sorted].reverse()).slice(0, -1),
  ];
  let area = 0;
  for (let index = 0; index < hull.length; index += 1) {
    const next = hull[(index + 1) % hull.length];
    area += hull[index].x * next.y - next.x * hull[index].y;
  }
  return Math.min(1, Math.abs(area) * 0.5 / Math.max(width * height, EPSILON));
}

function sampledTraceIndices(
  length: number,
  maximum: number,
): number[] {
  if (length <= maximum) return Array.from({ length }, (_, index) => index);
  return Array.from({ length: maximum }, (_, index) => (
    Math.round(index / (maximum - 1) * (length - 1))
  ));
}

function finiteUnitVector(vector: THREE.Vector3): boolean {
  return [vector.x, vector.y, vector.z].every(Number.isFinite)
    && Math.abs(vector.lengthSq() - 1) < 1e-3;
}

function principalAxes(
  points: readonly THREE.Vector3[],
  center: THREE.Vector3,
): PrincipalAxes | null {
  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const relative = new THREE.Vector3();
  for (const point of points) {
    relative.copy(point).sub(center);
    covariance[0][0] += relative.x * relative.x;
    covariance[0][1] += relative.x * relative.y;
    covariance[0][2] += relative.x * relative.z;
    covariance[1][1] += relative.y * relative.y;
    covariance[1][2] += relative.y * relative.z;
    covariance[2][2] += relative.z * relative.z;
  }
  covariance[1][0] = covariance[0][1];
  covariance[2][0] = covariance[0][2];
  covariance[2][1] = covariance[1][2];

  const pairs = symmetricEigenvectors(covariance)
    .sort((left, right) => right.value - left.value);
  if (pairs[0].value < EPSILON) return null;

  const terminal = points[points.length - 1].clone().sub(points[0]);
  const major = pairs[0].axis.normalize();
  if (terminal.dot(major) < 0) major.negate();

  const linear = pairs[1].value <= Math.max(EPSILON, pairs[0].value * 1e-8);
  const middle = linear
    ? stablePerpendicular(major)
    : pairs[1].axis.addScaledVector(major, -pairs[1].axis.dot(major));
  if (middle.lengthSq() < EPSILON) middle.copy(stablePerpendicular(major));
  else middle.normalize();
  if (!linear) {
    const firstOffset = points[0].clone().sub(center);
    if (Math.abs(firstOffset.dot(middle)) > EPSILON && firstOffset.dot(middle) < 0) {
      middle.negate();
    }
  }

  const minor = new THREE.Vector3().crossVectors(major, middle).normalize();
  if (!linear) {
    const chirality = traceChirality(points, minor);
    if (chirality < -EPSILON) {
      middle.negate();
      minor.negate();
    }
  }
  return { major, middle, minor, linear };
}

function stablePerpendicular(direction: THREE.Vector3): THREE.Vector3 {
  const absolute = [Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)];
  const axis = absolute[0] <= absolute[1] && absolute[0] <= absolute[2]
    ? new THREE.Vector3(1, 0, 0)
    : absolute[1] <= absolute[2]
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
  return axis.addScaledVector(direction, -axis.dot(direction)).normalize();
}

function symmetricEigenvectors(
  source: number[][],
): Array<{ value: number; axis: THREE.Vector3 }> {
  const matrix = source.map((row) => [...row]);
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let iteration = 0; iteration < 24; iteration += 1) {
    let p = 0;
    let q = 1;
    for (const [left, right] of [[0, 2], [1, 2]] as const) {
      if (Math.abs(matrix[left][right]) > Math.abs(matrix[p][q])) {
        p = left;
        q = right;
      }
    }
    if (Math.abs(matrix[p][q]) < EPSILON) break;

    const angle = 0.5 * Math.atan2(
      2 * matrix[p][q],
      matrix[q][q] - matrix[p][p],
    );
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const pp = matrix[p][p];
    const qq = matrix[q][q];
    const pq = matrix[p][q];
    matrix[p][p] = cosine * cosine * pp - 2 * sine * cosine * pq + sine * sine * qq;
    matrix[q][q] = sine * sine * pp + 2 * sine * cosine * pq + cosine * cosine * qq;
    matrix[p][q] = 0;
    matrix[q][p] = 0;

    for (let index = 0; index < 3; index += 1) {
      if (index === p || index === q) continue;
      const ip = matrix[index][p];
      const iq = matrix[index][q];
      matrix[index][p] = cosine * ip - sine * iq;
      matrix[p][index] = matrix[index][p];
      matrix[index][q] = sine * ip + cosine * iq;
      matrix[q][index] = matrix[index][q];
    }
    for (let index = 0; index < 3; index += 1) {
      const ip = vectors[index][p];
      const iq = vectors[index][q];
      vectors[index][p] = cosine * ip - sine * iq;
      vectors[index][q] = sine * ip + cosine * iq;
    }
  }

  return [0, 1, 2].map((index) => ({
    value: Math.max(0, matrix[index][index]),
    axis: new THREE.Vector3(
      vectors[0][index],
      vectors[1][index],
      vectors[2][index],
    ),
  }));
}

function projectedCenter(
  points: readonly THREE.Vector3[],
  right: THREE.Vector3,
  up: THREE.Vector3,
  direction: THREE.Vector3,
): THREE.Vector3 {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    const values = [point.dot(right), point.dot(up), point.dot(direction)];
    values.forEach((value, index) => {
      minimum[index] = Math.min(minimum[index], value);
      maximum[index] = Math.max(maximum[index], value);
    });
  }
  return right.clone().multiplyScalar((minimum[0] + maximum[0]) * 0.5)
    .addScaledVector(up, (minimum[1] + maximum[1]) * 0.5)
    .addScaledVector(direction, (minimum[2] + maximum[2]) * 0.5);
}

function traceChirality(
  points: readonly THREE.Vector3[],
  normal: THREE.Vector3,
): number {
  let result = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const incoming = points[index].clone().sub(points[index - 1]);
    const outgoing = points[index + 1].clone().sub(points[index]);
    result += new THREE.Vector3().crossVectors(incoming, outgoing).dot(normal);
  }
  return result;
}
