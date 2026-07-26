import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  buildProteinCartoonGeometry,
  cartoonCrossSection,
  classifyBackboneAngles,
  inferProteinSecondaryStructure,
  proteinCartoonCameraTrace,
  proteinCartoonResidueCenters,
  type ProteinCartoonResidue,
  type ProteinSecondaryStructure,
} from "./ribbon";

function backbone(count: number): ProteinCartoonResidue[] {
  return Array.from({ length: count }, (_, index) => {
    const ca = new THREE.Vector3(index * 3.8, Math.sin(index * 0.7) * 0.35, 0);
    return {
      atomIndex: index * 4 + 1,
      residueIndex: index,
      n: ca.clone().add(new THREE.Vector3(-1.2, 0.2, 0.15)),
      ca,
      c: ca.clone().add(new THREE.Vector3(1.35, 0.1, -0.1)),
      o: ca.clone().add(new THREE.Vector3(1.45, 0.95, 0.2)),
    };
  });
}

function alphaHelix(count: number): ProteinCartoonResidue[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = THREE.MathUtils.degToRad(index * 100);
    const ca = new THREE.Vector3(
      Math.cos(angle) * 2.25,
      Math.sin(angle) * 2.25,
      index * 1.5,
    );
    const radial = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
    return {
      atomIndex: index * 4 + 1,
      residueIndex: index,
      n: ca.clone().addScaledVector(radial, -0.7).add(new THREE.Vector3(0, 0, -0.9)),
      ca,
      c: ca.clone().addScaledVector(radial, 0.6).add(new THREE.Vector3(0, 0, 0.9)),
      o: ca.clone().addScaledVector(radial, 1.3).add(new THREE.Vector3(0, 0, 1)),
    };
  });
}

function crambinBackbone(): ProteinCartoonResidue[] {
  type BackboneAtom = "n" | "ca" | "c" | "o";
  interface ParsedResidue {
    residueIndex: number;
    atomIndices: Partial<Record<BackboneAtom, number>>;
    atoms: Partial<Record<BackboneAtom, THREE.Vector3>>;
  }
  const atomKeys: Partial<Record<string, BackboneAtom>> = {
    N: "n",
    CA: "ca",
    C: "c",
    O: "o",
  };
  const residues = new Map<string, ParsedResidue>();
  const pdb = readFileSync(
    new URL("../../../docs/assets/sources/1CRN.pdb", import.meta.url),
    "utf8",
  );
  let atomIndex = 0;
  for (const line of pdb.split(/\r?\n/)) {
    if (!line.startsWith("ATOM  ")) continue;
    const alternate = line.slice(16, 17);
    if (alternate !== " " && alternate !== "A") continue;
    const atom = atomKeys[line.slice(12, 16).trim()];
    if (!atom) {
      atomIndex += 1;
      continue;
    }
    const key = `${line.slice(21, 22)}:${line.slice(22, 27).trim()}`;
    let residue = residues.get(key);
    if (!residue) {
      residue = {
        residueIndex: residues.size,
        atomIndices: {},
        atoms: {},
      };
      residues.set(key, residue);
    }
    if (!residue.atoms[atom]) {
      residue.atoms[atom] = new THREE.Vector3(
        Number(line.slice(30, 38)),
        Number(line.slice(38, 46)),
        Number(line.slice(46, 54)),
      );
      residue.atomIndices[atom] = atomIndex;
    }
    atomIndex += 1;
  }
  return [...residues.values()].flatMap((residue) => {
    const { n, ca, c, o } = residue.atoms;
    if (!n || !ca || !c || !o) return [];
    return [{
      atomIndex: residue.atomIndices.ca!,
      residueIndex: residue.residueIndex,
      n,
      ca,
      c,
      o,
    }];
  });
}

function expectClosedValidMesh(geometry: THREE.BufferGeometry): void {
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const index = geometry.index;
  expect(index).not.toBeNull();
  const extent = new THREE.Box3().setFromBufferAttribute(
    positions as THREE.BufferAttribute,
  ).getSize(new THREE.Vector3()).length();
  const minimumArea = Math.max(extent * extent * 1e-12, 1e-10);
  const edges = new Map<string, number>();
  const first = new THREE.Vector3();
  const second = new THREE.Vector3();
  const third = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (let offset = 0; offset < index!.count; offset += 3) {
    const vertices = [
      index!.getX(offset),
      index!.getX(offset + 1),
      index!.getX(offset + 2),
    ];
    first.fromBufferAttribute(positions, vertices[0]);
    second.fromBufferAttribute(positions, vertices[1]);
    third.fromBufferAttribute(positions, vertices[2]);
    const area = ab.subVectors(second, first)
      .cross(ac.subVectors(third, first))
      .length() * 0.5;
    expect(area).toBeGreaterThan(minimumArea);
    for (const [left, right] of [
      [vertices[0], vertices[1]],
      [vertices[1], vertices[2]],
      [vertices[2], vertices[0]],
    ]) {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  expect([...edges.values()].every((count) => count === 2)).toBe(true);
  for (let vertex = 0; vertex < normals.count; vertex += 1) {
    const length = Math.hypot(
      normals.getX(vertex),
      normals.getY(vertex),
      normals.getZ(vertex),
    );
    expect(Number.isFinite(length)).toBe(true);
    expect(length).toBeGreaterThan(0.99);
    expect(length).toBeLessThan(1.01);
  }
}

describe("protein cartoon geometry", () => {
  it("classifies canonical helix and sheet backbone angles", () => {
    expect(classifyBackboneAngles(-62, -43)).toBe("helix");
    expect(classifyBackboneAngles(-125, 135)).toBe("sheet");
    expect(classifyBackboneAngles(75, 15)).toBe("coil");
  });

  it("keeps coordinate-inferred terminal beta strands", () => {
    expect(inferProteinSecondaryStructure(crambinBackbone()).slice(0, 4))
      .toEqual(["sheet", "sheet", "sheet", "sheet"]);
  });

  it("uses round coils, broad helices, and flatter sheets", () => {
    const coil = cartoonCrossSection("coil");
    const helix = cartoonCrossSection("helix");
    const sheet = cartoonCrossSection("sheet");

    expect(coil.width).toBeCloseTo(coil.depth);
    expect(helix.width).toBeGreaterThan(coil.width * 1.5);
    expect(helix.width).toBeGreaterThan(helix.depth * 1.5);
    expect(sheet.width).toBeGreaterThan(helix.width);
    expect(sheet.depth).toBeLessThan(helix.depth);
    expect(helix.squareness).toBeGreaterThan(coil.squareness);
    expect(sheet.squareness).toBeGreaterThan(helix.squareness);
  });

  it("provides stable face normals for protein-aware framing", () => {
    const residues = alphaHelix(8);
    const trace = proteinCartoonCameraTrace(
      residues,
      Array<ProteinSecondaryStructure>(residues.length).fill("helix"),
    );

    expect(trace).toHaveLength(residues.length);
    trace.forEach((point) => {
      expect(point.faceNormal).not.toBeNull();
      expect(point.faceNormal!.length()).toBeCloseTo(1, 7);
      expect(point.center.toArray().every(Number.isFinite)).toBe(true);
    });
  });

  it("smooths helix centers onto a clean curved axis", () => {
    const residues = alphaHelix(12);
    const centers = proteinCartoonResidueCenters(
      residues,
      residues.map(() => "helix"),
    );
    const sourceRadius = residues
      .slice(2, -2)
      .reduce((sum, residue) => sum + Math.hypot(residue.ca.x, residue.ca.y), 0)
      / (residues.length - 4);
    const centerRadius = centers
      .slice(2, -2)
      .reduce((sum, center) => sum + Math.hypot(center.x, center.y), 0)
      / (centers.length - 4);

    expect(centerRadius).toBeLessThan(sourceRadius * 0.25);
    for (let index = 2; index < centers.length - 2; index += 1) {
      expect(centers[index].z).toBeCloseTo(residues[index].ca.z, 6);
    }
  });

  it("samples a continuous, capped mesh with pick and sequence attributes", () => {
    const residues = backbone(6);
    const structures: ProteinSecondaryStructure[] = [
      "coil",
      "helix",
      "helix",
      "sheet",
      "sheet",
      "coil",
    ];
    const geometry = buildProteinCartoonGeometry(residues, {
      scale: 1,
      quality: "high",
      structures,
      translations: [new THREE.Vector3(), new THREE.Vector3(20, 0, 0)],
    });

    expect(geometry).not.toBeNull();
    const positions = geometry!.getAttribute("position");
    const atoms = geometry!.getAttribute("atomIndex");
    const progress = geometry!.getAttribute("sequenceProgress");
    const structuresAttribute = geometry!.getAttribute("secondaryStructure");
    const structureWeights = geometry!.getAttribute(
      "secondaryStructureWeights",
    );
    expect(positions.count).toBeGreaterThan(residues.length * 40);
    expect(atoms.count).toBe(positions.count);
    expect(progress.count).toBe(positions.count);
    expect(structuresAttribute.count).toBe(positions.count);
    expect(structureWeights.count).toBe(positions.count);
    expect(geometry!.index?.count).toBeGreaterThan(positions.count * 3);
    expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
    expect(progress.getX(0)).toBe(0);
    expect(progress.getX(progress.count - 1)).toBe(1);
    expect(geometry!.boundingSphere?.radius).toBeGreaterThan(15);
    expectClosedValidMesh(geometry!);

    let blendedVertices = 0;
    for (let vertex = 0; vertex < structureWeights.count; vertex += 1) {
      const weights = [
        structureWeights.getX(vertex),
        structureWeights.getY(vertex),
        structureWeights.getZ(vertex),
      ];
      expect(weights.every((weight) => weight >= 0 && weight <= 1)).toBe(true);
      expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 6);
      if (weights.filter((weight) => weight > 0.01).length > 1) {
        blendedVertices += 1;
      }
    }
    expect(blendedVertices).toBeGreaterThan(16);
  });

  it("builds a sealed, non-degenerate cartoon for 1CRN", () => {
    const residues = crambinBackbone();
    expect(residues).toHaveLength(46);
    const geometry = buildProteinCartoonGeometry(residues, {
      scale: 1,
      quality: "high",
      structures: inferProteinSecondaryStructure(residues),
    });

    expect(geometry).not.toBeNull();
    expectClosedValidMesh(geometry!);
    const positions = geometry!.getAttribute("position");
    const radialSegments = 16;
    const ringCount = (positions.count - 2) / radialSegments;
    expect(Number.isInteger(ringCount)).toBe(true);
    const center = new THREE.Vector3();
    const point = new THREE.Vector3();
    let previousCenter: THREE.Vector3 | null = null;
    let previousSide: THREE.Vector3 | null = null;
    for (let ring = 0; ring < ringCount; ring += 1) {
      center.set(0, 0, 0);
      for (let segment = 0; segment < radialSegments; segment += 1) {
        center.add(point.fromBufferAttribute(
          positions,
          ring * radialSegments + segment,
        ));
      }
      center.multiplyScalar(1 / radialSegments);
      const side = point.fromBufferAttribute(
        positions,
        ring * radialSegments,
      ).sub(center).normalize();
      if (previousCenter) {
        expect(center.distanceTo(previousCenter)).toBeGreaterThan(1e-5);
      }
      if (previousSide) {
        expect(side.dot(previousSide)).toBeGreaterThan(0.5);
      }
      previousCenter = center.clone();
      previousSide = side.clone();
    }
  });
});
