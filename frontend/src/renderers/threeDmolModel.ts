import * as THREE from "three";
import type { SceneSelectionContext } from "../scientificSelection";
import { ELEMENT_SYMBOLS } from "../scientificSelection";
import {
  cellImageCorners,
  covalentRadius,
  imageTranslation,
  minimumImageBondShift,
  sceneBondSegments,
  unwrapPointNear,
} from "../scene/model";
import type {
  PreparedScene,
  Segment,
} from "../scene/model";
import {
  inferProteinSecondaryStructure,
  type ProteinCartoonResidue,
  type ProteinSecondaryStructure,
} from "../scene/ribbon";
import type {
  AtomSelection,
  CellOffset,
  Manifest,
  ScenePresentation,
} from "../types";

export interface DmolAtomRecord {
  x: number;
  y: number;
  z: number;
  elem: string;
  atom: string;
  serial: number;
  bonds: number[];
  bondOrder: number[];
  color: string;
  chain?: string;
  resi?: number;
  resn?: string;
  icode?: string;
  hetflag?: boolean;
  ss?: "c" | "h" | "s";
  ssbegin?: boolean;
  ssend?: boolean;
  properties: {
    pqAtom: number;
    pqImageA: number;
    pqImageB: number;
    pqImageC: number;
  };
}

export interface DmolScenePlan {
  atoms: DmolAtomRecord[];
  selections: AtomSelection[];
  bondSegments: Segment[];
  shapeBondSegments: Segment[];
  boundaryBondCount: number;
  cellSegments: Segment[];
  collisionSegments: Segment[];
  layoutKey: string;
}

const CELL_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, 2],
  [0, 4],
  [1, 3],
  [1, 5],
  [2, 3],
  [2, 6],
  [3, 7],
  [4, 5],
  [4, 6],
  [5, 7],
  [6, 7],
];

const ELEMENT_COLORS: Record<number, string> = {
  1: "#F7F7F4",
  2: "#D8F2F2",
  3: "#B889DF",
  4: "#BED17F",
  5: "#D4956D",
  6: "#4B5560",
  7: "#315FBC",
  8: "#D94A42",
  9: "#55A65C",
  10: "#7BCDD0",
  11: "#9874CE",
  12: "#89A86D",
  13: "#C7B8AE",
  14: "#D5AA82",
  15: "#DE8D31",
  16: "#D7B52F",
  17: "#4C9A59",
  18: "#8BDCE2",
  19: "#AA7BDD",
  20: "#99BA7B",
  22: "#637F9E",
  26: "#A76545",
  29: "#B87333",
  30: "#6D79A8",
  35: "#B65A4C",
  38: "#77986D",
  53: "#8D61B5",
};

export function dmolElementColor(atomicNumber: number): string | undefined {
  return ELEMENT_COLORS[atomicNumber];
}

export function buildDmolScenePlan(
  manifest: Manifest,
  model: PreparedScene,
  presentation: ScenePresentation,
): DmolScenePlan {
  const residueByIndex = new Map(
    (manifest.topology.residues ?? []).map((residue) => [residue.index, residue]),
  );
  const secondary = proteinSecondaryStructure(model, manifest);
  const instanceByAtomImage = new Map<string, number>();
  const atoms: DmolAtomRecord[] = [];
  const selections: AtomSelection[] = [];

  for (let instance = 0; instance < model.instanceToAtom.length; instance += 1) {
    const atomIndex = model.instanceToAtom[instance];
    const instanceOffset = instance * 3;
    const atomOffset = atomIndex * 3;
    const relativeImage: CellOffset = [
      model.instanceImages[instanceOffset],
      model.instanceImages[instanceOffset + 1],
      model.instanceImages[instanceOffset + 2],
    ];
    const image: CellOffset = [
      (model.baseImages[atomOffset] ?? 0) + relativeImage[0],
      (model.baseImages[atomOffset + 1] ?? 0) + relativeImage[1],
      (model.baseImages[atomOffset + 2] ?? 0) + relativeImage[2],
    ];
    const translation = imageTranslation(relativeImage, model.basis);
    const residueIndex = manifest.topology.atom_residue_index?.[atomIndex];
    const residue = residueIndex === undefined
      ? undefined
      : residueByIndex.get(residueIndex);
    const annotation = residueIndex === undefined
      ? undefined
      : secondary.get(residueIndex);
    const atomicNumber = model.atomicNumbers[atomIndex] ?? 0;
    const atom: DmolAtomRecord = {
      x: model.positions[atomOffset] + translation.x,
      y: model.positions[atomOffset + 1] + translation.y,
      z: model.positions[atomOffset + 2] + translation.z,
      elem: manifest.topology.symbols?.[atomIndex]
        ?? ELEMENT_SYMBOLS[atomicNumber]
        ?? "X",
      atom: manifest.topology.atom_names?.[atomIndex]
        ?? manifest.topology.symbols?.[atomIndex]
        ?? ELEMENT_SYMBOLS[atomicNumber]
        ?? "X",
      serial: instance + 1,
      bonds: [],
      bondOrder: [],
      color: atomColor(manifest, atomIndex, atomicNumber, presentation.color),
      ...(residue
        ? {
            chain: residue.chain_id ?? "A",
            resi: residue.sequence_number ?? residue.index + 1,
            resn: residue.name ?? "UNK",
            icode: residue.insertion_code ?? "",
            hetflag: residue.category !== "amino-acid",
          }
        : {}),
      ...(annotation
        ? {
            ss: secondaryStructureCode(annotation.structure),
            ssbegin: annotation.begin,
            ssend: annotation.end,
          }
        : {}),
      properties: {
        pqAtom: atomIndex,
        pqImageA: image[0],
        pqImageB: image[1],
        pqImageC: image[2],
      },
    };
    atoms.push(atom);
    selections.push({ atom: atomIndex, image });
    instanceByAtomImage.set(
      atomImageKey(atomIndex, relativeImage),
      instance,
    );
  }

  const shapeBonds = model.bonds.filter(([left, right]) => (
    (presentation.wrap === "atom" || presentation.wrap === "unwrapped")
    && minimumImageBondShift(
      model.positions,
      left,
      right,
      model.basis,
      model.pbc,
    ).some((value) => value !== 0)
  ));
  const shapeBondKeys = new Set(shapeBonds.map(([left, right]) => bondKey(left, right)));
  if (presentation.bonds) {
    for (const image of model.images) {
      for (const [left, right] of model.bonds) {
        if (shapeBondKeys.has(bondKey(left, right))) continue;
        const leftInstance = instanceByAtomImage.get(atomImageKey(left, image));
        const rightInstance = instanceByAtomImage.get(atomImageKey(right, image));
        if (leftInstance === undefined || rightInstance === undefined) continue;
        atoms[leftInstance].bonds.push(rightInstance);
        atoms[leftInstance].bondOrder.push(1);
        atoms[rightInstance].bonds.push(leftInstance);
        atoms[rightInstance].bondOrder.push(1);
      }
    }
  }

  const bondSegments = sceneBondSegments(model, presentation);
  return {
    atoms,
    selections,
    bondSegments,
    shapeBondSegments: shapeBonds.length === 0
      ? []
      : sceneBondSegments({ ...model, bonds: shapeBonds }, presentation),
    boundaryBondCount: shapeBonds.length,
    cellSegments: presentation.cell ? buildCellSegments(model) : [],
    collisionSegments: buildCollisionSegments(model),
    layoutKey: [
      manifest.dataset_generation ?? manifest.name,
      model.count,
      integerArrayHash(model.atomicNumbers),
      model.visibleAtoms.join(","),
      model.images.map((image) => image.join(",")).join(";"),
      integerArrayHash(model.baseImages),
      presentation.water,
      presentation.hydrogens ? 1 : 0,
      presentation.bonds ? 1 : 0,
      presentation.color,
      manifest.topology.residues?.length ?? 0,
    ].join("|"),
  };
}

export function selectionFromDmolAtom(
  atom: Pick<DmolAtomRecord, "properties">,
): AtomSelection | null {
  const properties = atom.properties;
  const values = [
    properties.pqAtom,
    properties.pqImageA,
    properties.pqImageB,
    properties.pqImageC,
  ];
  if (!values.every(Number.isInteger) || properties.pqAtom < 0) return null;
  return {
    atom: properties.pqAtom,
    image: [
      properties.pqImageA,
      properties.pqImageB,
      properties.pqImageC,
    ],
  };
}

export function selectionContextFromDmolModel(
  manifest: Manifest,
  model: PreparedScene,
): SceneSelectionContext {
  return {
    count: model.count,
    atomicNumbers: model.atomicNumbers,
    positions: model.positions,
    baseImages: model.baseImages,
    cell: model.basis
      ? Float64Array.from(model.basis.vectors.flatMap((vector) => [
          vector.x,
          vector.y,
          vector.z,
        ]))
      : null,
    bonds: model.bonds,
    waterAtoms: model.waterAtoms,
    instanceToAtom: model.instanceToAtom,
    instanceImages: model.instanceImages,
    atomResidueIndex: manifest.topology.atom_residue_index,
  };
}

export function selectedDmolPositions(
  model: PreparedScene,
  selections: readonly AtomSelection[],
): Float64Array | null {
  const positions = new Float64Array(selections.length * 3);
  for (let index = 0; index < selections.length; index += 1) {
    const selection = selections[index];
    if (selection.atom < 0 || selection.atom >= model.count) return null;
    const atomOffset = selection.atom * 3;
    const relative: CellOffset = [
      selection.image[0] - (model.baseImages[atomOffset] ?? 0),
      selection.image[1] - (model.baseImages[atomOffset + 1] ?? 0),
      selection.image[2] - (model.baseImages[atomOffset + 2] ?? 0),
    ];
    const translation = imageTranslation(relative, model.basis);
    positions[index * 3] = model.positions[atomOffset] + translation.x;
    positions[index * 3 + 1] = model.positions[atomOffset + 1] + translation.y;
    positions[index * 3 + 2] = model.positions[atomOffset + 2] + translation.z;
  }
  return positions;
}

function buildCellSegments(model: PreparedScene): Segment[] {
  if (!model.basis) return [];
  const segments: Segment[] = [];
  for (const image of model.images) {
    const corners = cellImageCorners(model.basis, image, model.cellCenter);
    for (const [left, right] of CELL_EDGES) {
      segments.push({
        from: corners[left],
        to: corners[right],
      });
    }
  }
  return segments;
}

function buildCollisionSegments(model: PreparedScene): Segment[] {
  if (model.visibleAtoms.length > 2_000) return [];
  const bonded = new Set(
    model.bonds.map(([left, right]) => left < right
      ? left * model.count + right
      : right * model.count + left),
  );
  const primary: Segment[] = [];
  const fractional = model.basis
    ? fractionalCoordinates(model)
    : null;
  const reciprocalLengths = model.basis
    ? model.basis.reciprocal.map((vector) => vector.length())
    : null;
  const radii = Float64Array.from(
    model.atomicNumbers,
    (atomicNumber) => covalentRadius(atomicNumber),
  );
  for (let leftIndex = 0; leftIndex < model.visibleAtoms.length - 1; leftIndex += 1) {
    const left = model.visibleAtoms[leftIndex];
    const leftOffset = left * 3;
    for (let rightIndex = leftIndex + 1; rightIndex < model.visibleAtoms.length; rightIndex += 1) {
      const right = model.visibleAtoms[rightIndex];
      if (bonded.has(left < right
        ? left * model.count + right
        : right * model.count + left)) continue;
      const rightOffset = right * 3;
      const cutoff = 0.55 * (radii[left] + radii[right]);
      let dx: number;
      let dy: number;
      let dz: number;
      if (model.basis && fractional) {
        const da = fractional[rightOffset] - fractional[leftOffset];
        const db = fractional[rightOffset + 1] - fractional[leftOffset + 1];
        const dc = fractional[rightOffset + 2] - fractional[leftOffset + 2];
        const nearestA = model.pbc[0] ? da - Math.round(da) : da;
        const nearestB = model.pbc[1] ? db - Math.round(db) : db;
        const nearestC = model.pbc[2] ? dc - Math.round(dc) : dc;
        if (
          Math.abs(nearestA) > cutoff * reciprocalLengths![0] + 1e-10
          || Math.abs(nearestB) > cutoff * reciprocalLengths![1] + 1e-10
          || Math.abs(nearestC) > cutoff * reciprocalLengths![2] + 1e-10
        ) continue;
        const from = new THREE.Vector3(
          model.positions[leftOffset],
          model.positions[leftOffset + 1],
          model.positions[leftOffset + 2],
        );
        const to = unwrapPointNear(
          from,
          new THREE.Vector3(
            model.positions[rightOffset],
            model.positions[rightOffset + 1],
            model.positions[rightOffset + 2],
          ),
          model.basis,
          model.pbc,
        );
        dx = to.x - from.x;
        dy = to.y - from.y;
        dz = to.z - from.z;
      } else {
        dx = model.positions[rightOffset] - model.positions[leftOffset];
        dy = model.positions[rightOffset + 1] - model.positions[leftOffset + 1];
        dz = model.positions[rightOffset + 2] - model.positions[leftOffset + 2];
      }
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared > 0.0025 && distanceSquared < cutoff * cutoff) {
        const from = new THREE.Vector3(
          model.positions[leftOffset],
          model.positions[leftOffset + 1],
          model.positions[leftOffset + 2],
        );
        primary.push({
          from,
          to: new THREE.Vector3(from.x + dx, from.y + dy, from.z + dz),
        });
        if (primary.length >= 256) break;
      }
    }
    if (primary.length >= 256) break;
  }
  if (primary.length === 0) return [];
  return model.images.flatMap((image) => {
    const translation = imageTranslation(image, model.basis);
    return primary.map(({ from, to }) => ({
      from: from.clone().add(translation),
      to: to.clone().add(translation),
    }));
  });
}

function fractionalCoordinates(model: PreparedScene): Float64Array {
  const result = new Float64Array(model.count * 3);
  const reciprocal = model.basis!.reciprocal;
  for (let atom = 0; atom < model.count; atom += 1) {
    const offset = atom * 3;
    const x = model.positions[offset];
    const y = model.positions[offset + 1];
    const z = model.positions[offset + 2];
    result[offset] = x * reciprocal[0].x + y * reciprocal[0].y + z * reciprocal[0].z;
    result[offset + 1] = x * reciprocal[1].x + y * reciprocal[1].y + z * reciprocal[1].z;
    result[offset + 2] = x * reciprocal[2].x + y * reciprocal[2].y + z * reciprocal[2].z;
  }
  return result;
}

function proteinSecondaryStructure(
  model: PreparedScene,
  manifest: Manifest,
): Map<number, {
  structure: ProteinSecondaryStructure;
  begin: boolean;
  end: boolean;
}> {
  const result = new Map<number, {
    structure: ProteinSecondaryStructure;
    begin: boolean;
    end: boolean;
  }>();
  const annotations = new Map(
    (manifest.topology.residues ?? [])
      .filter((residue) => residue.secondary_structure)
      .map((residue) => [residue.index, residue.secondary_structure!]),
  );
  const runs = new Map<number, typeof model.backbone>();
  for (const residue of model.backbone) {
    const key = residue.runIndex ?? 0;
    const run = runs.get(key) ?? [];
    run.push(residue);
    runs.set(key, run);
  }
  for (const run of runs.values()) {
    if (run.length < 3) continue;
    const residues: ProteinCartoonResidue[] = [];
    for (const residue of run) {
      const rawCa = new THREE.Vector3().fromArray(model.positions, residue.ca * 3);
      const ca = residues.length === 0
        ? rawCa
        : unwrapPointNear(residues.at(-1)!.ca, rawCa, model.basis, model.pbc);
      residues.push({
        atomIndex: residue.ca,
        residueIndex: residue.residueIndex,
        n: unwrapPointNear(
          ca,
          new THREE.Vector3().fromArray(model.positions, residue.n * 3),
          model.basis,
          model.pbc,
        ),
        ca,
        c: unwrapPointNear(
          ca,
          new THREE.Vector3().fromArray(model.positions, residue.c * 3),
          model.basis,
          model.pbc,
        ),
        o: new THREE.Vector3(),
      });
      residues.at(-1)!.o = unwrapPointNear(
        residues.at(-1)!.c,
        new THREE.Vector3().fromArray(model.positions, residue.o * 3),
        model.basis,
        model.pbc,
      );
    }
    const inferred = inferProteinSecondaryStructure(residues);
    const structures = residues.map((residue, index) => (
      annotations.get(residue.residueIndex) ?? inferred[index]
    ));
    residues.forEach((residue, index) => {
      result.set(residue.residueIndex, {
        structure: structures[index],
        begin: index === 0 || structures[index - 1] !== structures[index],
        end: index === structures.length - 1 || structures[index + 1] !== structures[index],
      });
    });
  }
  return result;
}

function secondaryStructureCode(
  structure: ProteinSecondaryStructure,
): "c" | "h" | "s" {
  if (structure === "helix") return "h";
  if (structure === "sheet") return "s";
  return "c";
}

function atomColor(
  manifest: Manifest,
  atom: number,
  atomicNumber: number,
  mode: ScenePresentation["color"],
): string {
  if (mode === "element") return dmolElementColor(atomicNumber) ?? "#65757A";
  if (mode === "chain") {
    const residueIndex = manifest.topology.atom_residue_index?.[atom];
    const residue = manifest.topology.residues?.find(
      (entry) => entry.index === residueIndex,
    );
    return categoricalColor(hashString(residue?.chain_id ?? "A"));
  }
  return categoricalColor(
    manifest.topology.atom_residue_index?.[atom] ?? atom,
  );
}

function categoricalColor(value: number): string {
  const hue = ((value * 0.173) % 1 + 1) % 1;
  return `#${new THREE.Color().setHSL(hue, 0.42, 0.43).getHexString()}`;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function integerArrayHash(values: ArrayLike<number>): string {
  let hash = 2166136261;
  for (let index = 0; index < values.length; index += 1) {
    hash ^= values[index] & 0xff;
    hash = Math.imul(hash, 16777619);
    hash ^= (values[index] >> 8) & 0xff;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function atomImageKey(atom: number, image: CellOffset): string {
  return `${atom}:${image[0]}:${image[1]}:${image[2]}`;
}

function bondKey(left: number, right: number): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}
