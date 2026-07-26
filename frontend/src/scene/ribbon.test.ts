import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  buildProteinCartoonGeometry,
  cartoonCrossSection,
  classifyBackboneAngles,
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

describe("protein cartoon geometry", () => {
  it("classifies canonical helix and sheet backbone angles", () => {
    expect(classifyBackboneAngles(-62, -43)).toBe("helix");
    expect(classifyBackboneAngles(-125, 135)).toBe("sheet");
    expect(classifyBackboneAngles(75, 15)).toBe("coil");
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
    expect(positions.count).toBeGreaterThan(residues.length * 40);
    expect(atoms.count).toBe(positions.count);
    expect(progress.count).toBe(positions.count);
    expect(structuresAttribute.count).toBe(positions.count);
    expect(geometry!.index?.count).toBeGreaterThan(positions.count * 3);
    expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
    expect(progress.getX(0)).toBe(0);
    expect(progress.getX(progress.count - 1)).toBe(1);
    expect(geometry!.boundingSphere?.radius).toBeGreaterThan(15);
  });
});
