import type { AtomSelection, CellOffset } from "./types";

export type ScientificSelectionScope =
  | "atom"
  | "element"
  | "molecule"
  | "residue"
  | "component";

export type SelectionMergeMode = "add" | "toggle";

export interface SceneSelectionContext {
  count: number;
  atomicNumbers: ArrayLike<number>;
  positions: ArrayLike<number>;
  cell: ArrayLike<number> | null;
  bonds: ReadonlyArray<readonly [number, number]>;
  waterAtoms: ReadonlySet<number>;
  instanceToAtom: Uint32Array;
  instanceImages: Int8Array;
  baseImages: Int32Array;
  atomResidueIndex?: ArrayLike<number> | null;
}

export interface SelectionSummary {
  count: number;
  formula: string;
  centroid: [number, number, number];
  extent: [number, number, number];
}

export interface NamedSelection {
  name: string;
  selections: AtomSelection[];
}

export interface SelectionTopology {
  count: number;
  hasConnectivity: boolean;
  componentRoots: Int32Array;
  residueIndices: Int32Array;
}

export const ELEMENT_SYMBOLS = [
  "X",
  "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
  "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar",
  "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
  "Ga", "Ge", "As", "Se", "Br", "Kr",
  "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
  "In", "Sn", "Sb", "Te", "I", "Xe",
  "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy",
  "Ho", "Er", "Tm", "Yb", "Lu",
  "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
  "Tl", "Pb", "Bi", "Po", "At", "Rn",
  "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf",
  "Es", "Fm", "Md", "No", "Lr",
  "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn",
  "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
] as const;

const ELEMENT_NAME_PART_1 =
  "unknown hydrogen helium lithium beryllium boron carbon nitrogen oxygen fluorine neon "
  + "sodium magnesium aluminium silicon phosphorus sulfur chlorine argon potassium calcium "
  + "scandium titanium vanadium chromium manganese iron cobalt nickel copper zinc gallium "
  + "germanium arsenic selenium bromine krypton rubidium strontium yttrium zirconium niobium "
  + "molybdenum technetium ruthenium rhodium palladium silver cadmium indium tin antimony "
  + "tellurium iodine xenon caesium barium lanthanum cerium praseodymium neodymium promethium ";

const ELEMENT_NAME_PART_2A =
  "samarium europium gadolinium terbium dysprosium holmium erbium thulium ytterbium lutetium "
  + "hafnium tantalum tungsten rhenium osmium iridium platinum gold mercury thallium lead "
  + "bismuth polonium astatine radon francium radium actinium thorium protactinium uranium ";

const ELEMENT_NAME_PART_2B =
  "neptunium plutonium americium curium berkelium californium einsteinium fermium ";

const ELEMENT_NAME_PART_2C =
  "mendelevium nobelium lawrencium rutherfordium dubnium seaborgium bohrium hassium ";

const ELEMENT_NAME_PART_2D =
  "meitnerium darmstadtium roentgenium copernicium nihonium flerovium moscovium "
  + "livermorium tennessine oganesson";

export const ELEMENT_NAMES = (
  ELEMENT_NAME_PART_1
  + ELEMENT_NAME_PART_2A
  + ELEMENT_NAME_PART_2B
  + ELEMENT_NAME_PART_2C
  + ELEMENT_NAME_PART_2D
).split(" ") as readonly string[];

const elementNumbers = new Map<string, number>();
for (let number = 1; number < ELEMENT_SYMBOLS.length; number += 1) {
  elementNumbers.set(ELEMENT_SYMBOLS[number].toLowerCase(), number);
  elementNumbers.set(ELEMENT_NAMES[number], number);
}
elementNumbers.set("aluminum", 13);
elementNumbers.set("sulphur", 16);
elementNumbers.set("cesium", 55);
elementNumbers.set("wolfram", 74);

export function atomicNumberForElement(value: string | number): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value < ELEMENT_SYMBOLS.length
      ? value
      : null;
  }
  return elementNumbers.get(value.trim().toLowerCase()) ?? null;
}

export function cloneSelections(selections: readonly AtomSelection[]): AtomSelection[] {
  return selections.map(cloneSelection);
}

export function replaceSelections(selections: readonly AtomSelection[]): AtomSelection[] {
  const seen = new Set<string>();
  const result: AtomSelection[] = [];
  for (const selection of selections) {
    assertSelection(selection);
    const key = canonicalKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cloneSelection(selection));
  }
  return result;
}

export function mergeSelections(
  current: readonly AtomSelection[],
  incoming: readonly AtomSelection[],
  mode: SelectionMergeMode = "add",
): AtomSelection[] {
  if (mode !== "add" && mode !== "toggle") {
    throw new TypeError(`Unknown selection merge mode: ${String(mode)}`);
  }
  const result = replaceSelections(current);
  const positions = new Map(result.map((selection, index) => [canonicalKey(selection), index]));
  const additions = replaceSelections(incoming);
  if (mode === "add") {
    for (const selection of additions) {
      const key = canonicalKey(selection);
      if (positions.has(key)) continue;
      positions.set(key, result.length);
      result.push(selection);
    }
    return result;
  }

  const toggled = new Set(additions.map(canonicalKey));
  const kept = result.filter((selection) => !toggled.has(canonicalKey(selection)));
  const existing = new Set(result.map(canonicalKey));
  for (const selection of additions) {
    if (!existing.has(canonicalKey(selection))) kept.push(selection);
  }
  return kept;
}

export function createNamedSelection(
  name: string,
  selections: readonly AtomSelection[],
): NamedSelection {
  return { name: normalizedSelectionName(name), selections: replaceSelections(selections) };
}

export function cloneNamedSelection(selection: NamedSelection): NamedSelection {
  return createNamedSelection(selection.name, selection.selections);
}

export function hillFormula(atomicNumbers: Iterable<number>): string {
  const counts = new Map<string, number>();
  for (const atomicNumber of atomicNumbers) {
    const symbol = ELEMENT_SYMBOLS[atomicNumber] ?? "X";
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  const symbols = [...counts.keys()];
  const ordered = counts.has("C")
    ? [
        "C",
        ...(counts.has("H") ? ["H"] : []),
        ...symbols.filter((symbol) => symbol !== "C" && symbol !== "H").sort(),
      ]
    : symbols.sort();
  return ordered.map((symbol) => {
    const count = counts.get(symbol)!;
    return `${symbol}${count === 1 ? "" : count}`;
  }).join("");
}

export function parseWithinSelectionCommand(query: string): number | null {
  const match = query.match(
    /^\s*select\s+within\s+((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(?:a|å|angstroms?)\s+of\s+selection\s*$/i,
  );
  if (!match) return null;
  const distance = Number(match[1]);
  return Number.isFinite(distance) && distance > 0 ? distance : null;
}

export function createSelectionTopology(
  context: SceneSelectionContext,
): SelectionTopology {
  validateContext(context);
  const residueIndices = normalizedResidueIndices(context);
  const parent = new Int32Array(context.count);
  const rank = new Uint8Array(context.count);
  for (let atom = 0; atom < context.count; atom += 1) parent[atom] = atom;
  let validBonds = 0;
  for (const [left, right] of context.bonds) {
    if (!validBond(left, right, context.count)) continue;
    validBonds += 1;
    union(parent, rank, left, right);
  }
  const componentRoots = new Int32Array(context.count);
  for (let atom = 0; atom < context.count; atom += 1) {
    componentRoots[atom] = findRoot(parent, atom);
  }
  return {
    count: context.count,
    hasConnectivity: validBonds > 0,
    componentRoots,
    residueIndices,
  };
}

export class SelectionIndex {
  readonly context: SceneSelectionContext;
  readonly hasConnectivity: boolean;

  private readonly componentRoots: Int32Array;
  private readonly residueIndices: Int32Array;
  private visibleInstances: Map<string, number> | null = null;

  constructor(
    context: SceneSelectionContext,
    topology: SelectionTopology = createSelectionTopology(context),
  ) {
    validateContext(context);
    if (topology.count !== context.count) {
      throw new RangeError("Selection topology does not match the scene");
    }
    this.context = context;
    this.hasConnectivity = topology.hasConnectivity;
    this.componentRoots = topology.componentRoots;
    this.residueIndices = topology.residueIndices;
  }

  selectionAt(instance: number): AtomSelection | null {
    if (!Number.isInteger(instance) || instance < 0 || instance >= this.context.instanceToAtom.length) {
      return null;
    }
    const atom = this.context.instanceToAtom[instance];
    if (atom >= this.context.count) return null;
    const offset = instance * 3;
    const baseOffset = atom * 3;
    return {
      atom,
      image: [
        this.context.baseImages[baseOffset] + this.context.instanceImages[offset],
        this.context.baseImages[baseOffset + 1] + this.context.instanceImages[offset + 1],
        this.context.baseImages[baseOffset + 2] + this.context.instanceImages[offset + 2],
      ],
    };
  }

  displayedPosition(selection: AtomSelection): [number, number, number] | null {
    if (!validContextSelection(selection, this.context.count)) return null;
    const output = new Float64Array(3);
    if (!writeSelectionPosition(output, this.context, selection)) return null;
    return [output[0], output[1], output[2]];
  }

  isVisible(selection: AtomSelection): boolean {
    return this.instanceFor(selection) !== null;
  }

  selectScope(
    anchor: AtomSelection,
    scope: ScientificSelectionScope,
  ): AtomSelection[] | null {
    if (!validContextSelection(anchor, this.context.count)) return [];
    const displayImage = this.displayImage(anchor);
    if (!displayImage || this.instanceFor(anchor) === null) return [];
    if (scope === "atom") return [cloneSelection(anchor)];

    const atom = anchor.atom;
    let matches: (candidate: number) => boolean;
    if (scope === "element") {
      const atomicNumber = this.context.atomicNumbers[atom];
      matches = (candidate) => this.context.atomicNumbers[candidate] === atomicNumber;
    } else if (scope === "residue") {
      const residue = this.residueIndices[atom];
      if (residue < 0) return null;
      matches = (candidate) => this.residueIndices[candidate] === residue;
    } else if (scope === "component") {
      if (!this.hasConnectivity) return null;
      const component = this.componentRoots[atom];
      matches = (candidate) => this.componentRoots[candidate] === component;
    } else if (scope === "molecule") {
      const residue = this.residueIndices[atom];
      if (this.hasConnectivity) {
        const component = this.componentRoots[atom];
        matches = (candidate) => this.componentRoots[candidate] === component;
      } else {
        if (residue < 0) return null;
        matches = (candidate) => this.residueIndices[candidate] === residue;
      }
    } else {
      throw new TypeError(`Unknown scientific selection scope: ${String(scope)}`);
    }
    return this.collectVisible((candidate, instance) => (
      matches(candidate) && this.instanceHasDisplayImage(instance, displayImage)
    ));
  }

  selectElement(element: string | number): AtomSelection[] {
    const atomicNumber = atomicNumberForElement(element);
    if (atomicNumber === null) return [];
    return this.collectVisible(
      (atom) => this.context.atomicNumbers[atom] === atomicNumber,
    );
  }

  selectWater(): AtomSelection[] {
    return this.collectVisible((atom) => this.context.waterAtoms.has(atom));
  }

  withinDistance(anchor: AtomSelection, distance: number): AtomSelection[] {
    return this.withinDistanceOf([anchor], distance);
  }

  withinDistanceOf(
    anchors: readonly AtomSelection[],
    distance: number,
  ): AtomSelection[] {
    if (!Number.isFinite(distance) || distance <= 0) return [];
    const anchorPosition = new Float64Array(3);
    const anchorBuckets = new Map<string, number[]>();
    const seenAnchors = new Set<string>();
    for (const anchor of anchors) {
      if (!validContextSelection(anchor, this.context.count)) continue;
      const identity = canonicalKey(anchor);
      if (seenAnchors.has(identity)) continue;
      seenAnchors.add(identity);
      if (!writeSelectionPosition(anchorPosition, this.context, anchor)) continue;
      const key = spatialKey(
        Math.floor(anchorPosition[0] / distance),
        Math.floor(anchorPosition[1] / distance),
        Math.floor(anchorPosition[2] / distance),
      );
      const bucket = anchorBuckets.get(key);
      if (bucket) {
        bucket.push(anchorPosition[0], anchorPosition[1], anchorPosition[2]);
      } else {
        anchorBuckets.set(key, [
          anchorPosition[0],
          anchorPosition[1],
          anchorPosition[2],
        ]);
      }
    }
    if (anchorBuckets.size === 0) return [];

    const limit = distance * distance;
    const candidate = new Float64Array(3);
    return this.collectVisible((atom, instance) => {
      const offset = instance * 3;
      if (!writeDisplayedPosition(
        candidate,
        0,
        this.context,
        atom,
        this.context.instanceImages[offset],
        this.context.instanceImages[offset + 1],
        this.context.instanceImages[offset + 2],
      )) return false;
      const gridX = Math.floor(candidate[0] / distance);
      const gridY = Math.floor(candidate[1] / distance);
      const gridZ = Math.floor(candidate[2] / distance);
      for (let x = gridX - 1; x <= gridX + 1; x += 1) {
        for (let y = gridY - 1; y <= gridY + 1; y += 1) {
          for (let z = gridZ - 1; z <= gridZ + 1; z += 1) {
            const bucket = anchorBuckets.get(spatialKey(x, y, z));
            if (!bucket) continue;
            for (let index = 0; index < bucket.length; index += 3) {
              const dx = candidate[0] - bucket[index];
              const dy = candidate[1] - bucket[index + 1];
              const dz = candidate[2] - bucket[index + 2];
              if (dx * dx + dy * dy + dz * dz <= limit) return true;
            }
          }
        }
      }
      return false;
    });
  }

  summarize(selections: readonly AtomSelection[]): SelectionSummary | null {
    const unique = replaceSelections(selections);
    if (unique.length === 0) return null;
    const atomicNumbers: number[] = [];
    const formulaAtoms = new Set<number>();
    const sum = [0, 0, 0];
    const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    const position = new Float64Array(3);
    for (const selection of unique) {
      if (!validContextSelection(selection, this.context.count)) return null;
      if (!writeSelectionPosition(position, this.context, selection)) return null;
      if (!formulaAtoms.has(selection.atom)) {
        formulaAtoms.add(selection.atom);
        atomicNumbers.push(this.context.atomicNumbers[selection.atom]);
      }
      for (let axis = 0; axis < 3; axis += 1) {
        sum[axis] += position[axis];
        minimum[axis] = Math.min(minimum[axis], position[axis]);
        maximum[axis] = Math.max(maximum[axis], position[axis]);
      }
    }
    return {
      count: unique.length,
      formula: hillFormula(atomicNumbers),
      centroid: [
        sum[0] / unique.length,
        sum[1] / unique.length,
        sum[2] / unique.length,
      ],
      extent: [
        maximum[0] - minimum[0],
        maximum[1] - minimum[1],
        maximum[2] - minimum[2],
      ],
    };
  }

  private collectVisible(
    predicate: (atom: number, instance: number) => boolean,
  ): AtomSelection[] {
    const result: AtomSelection[] = [];
    const seen = new Set<string>();
    for (let instance = 0; instance < this.context.instanceToAtom.length; instance += 1) {
      const atom = this.context.instanceToAtom[instance];
      if (atom >= this.context.count || !predicate(atom, instance)) continue;
      const selection = this.selectionAt(instance);
      if (!selection) continue;
      const key = canonicalKey(selection);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(selection);
    }
    return result;
  }

  private displayImage(selection: AtomSelection): CellOffset | null {
    if (!validContextSelection(selection, this.context.count)) return null;
    const offset = selection.atom * 3;
    return [
      selection.image[0] - this.context.baseImages[offset],
      selection.image[1] - this.context.baseImages[offset + 1],
      selection.image[2] - this.context.baseImages[offset + 2],
    ];
  }

  private instanceFor(selection: AtomSelection): number | null {
    const image = this.displayImage(selection);
    if (!image) return null;
    return this.ensureVisibleInstances().get(displayKey(
      selection.atom,
      image[0],
      image[1],
      image[2],
    ))
      ?? null;
  }

  private instanceHasDisplayImage(instance: number, image: CellOffset): boolean {
    const offset = instance * 3;
    return this.context.instanceImages[offset] === image[0]
      && this.context.instanceImages[offset + 1] === image[1]
      && this.context.instanceImages[offset + 2] === image[2];
  }

  private ensureVisibleInstances(): Map<string, number> {
    if (this.visibleInstances) return this.visibleInstances;
    const result = new Map<string, number>();
    for (let instance = 0; instance < this.context.instanceToAtom.length; instance += 1) {
      const atom = this.context.instanceToAtom[instance];
      if (atom >= this.context.count) continue;
      const offset = instance * 3;
      const key = displayKey(
        atom,
        this.context.instanceImages[offset],
        this.context.instanceImages[offset + 1],
        this.context.instanceImages[offset + 2],
      );
      if (!result.has(key)) result.set(key, instance);
    }
    this.visibleInstances = result;
    return result;
  }
}

function validateContext(context: SceneSelectionContext): void {
  if (!Number.isInteger(context.count) || context.count < 0) {
    throw new RangeError("Selection context count must be a non-negative integer");
  }
  if (
    context.atomicNumbers.length < context.count
    || context.positions.length < context.count * 3
    || context.baseImages.length < context.count * 3
  ) {
    throw new RangeError("Selection context atom arrays are incomplete");
  }
  if (context.instanceImages.length !== context.instanceToAtom.length * 3) {
    throw new RangeError("Selection context instance arrays have different lengths");
  }
  if (context.cell !== null) {
    if (context.cell.length !== 9) throw new RangeError("Selection context cell must contain 9 values");
    for (let index = 0; index < 9; index += 1) {
      if (!Number.isFinite(context.cell[index])) {
        throw new RangeError("Selection context cell must be finite");
      }
    }
  }
  if (context.atomResidueIndex && context.atomResidueIndex.length < context.count) {
    throw new RangeError("Selection context residue indices are incomplete");
  }
}

function normalizedResidueIndices(context: SceneSelectionContext): Int32Array {
  const result = new Int32Array(context.count);
  result.fill(-1);
  if (!context.atomResidueIndex) return result;
  for (let atom = 0; atom < context.count; atom += 1) {
    const residue = context.atomResidueIndex[atom];
    if (Number.isInteger(residue) && residue >= 0 && residue <= 0x7fffffff) {
      result[atom] = residue;
    }
  }
  return result;
}

function writeSelectionPosition(
  target: Float64Array,
  context: SceneSelectionContext,
  selection: AtomSelection,
): boolean {
  const offset = selection.atom * 3;
  return writeDisplayedPosition(
    target,
    0,
    context,
    selection.atom,
    selection.image[0] - context.baseImages[offset],
    selection.image[1] - context.baseImages[offset + 1],
    selection.image[2] - context.baseImages[offset + 2],
  );
}

function writeDisplayedPosition(
  target: Float64Array,
  targetOffset: number,
  context: SceneSelectionContext,
  atom: number,
  imageA: number,
  imageB: number,
  imageC: number,
): boolean {
  const atomOffset = atom * 3;
  let x = context.positions[atomOffset];
  let y = context.positions[atomOffset + 1];
  let z = context.positions[atomOffset + 2];
  if (![x, y, z].every(Number.isFinite)) return false;
  if (imageA !== 0 || imageB !== 0 || imageC !== 0) {
    const cell = context.cell;
    if (!cell) return false;
    x += imageA * cell[0] + imageB * cell[3] + imageC * cell[6];
    y += imageA * cell[1] + imageB * cell[4] + imageC * cell[7];
    z += imageA * cell[2] + imageB * cell[5] + imageC * cell[8];
  }
  if (![x, y, z].every(Number.isFinite)) return false;
  target[targetOffset] = x;
  target[targetOffset + 1] = y;
  target[targetOffset + 2] = z;
  return true;
}

function validBond(left: number, right: number, count: number): boolean {
  return Number.isInteger(left)
    && Number.isInteger(right)
    && left >= 0
    && right >= 0
    && left < count
    && right < count
    && left !== right;
}

function findRoot(parent: Int32Array, value: number): number {
  let root = value;
  while (parent[root] !== root) root = parent[root];
  let current = value;
  while (parent[current] !== current) {
    const next = parent[current];
    parent[current] = root;
    current = next;
  }
  return root;
}

function union(parent: Int32Array, rank: Uint8Array, left: number, right: number): void {
  let leftRoot = findRoot(parent, left);
  let rightRoot = findRoot(parent, right);
  if (leftRoot === rightRoot) return;
  if (rank[leftRoot] < rank[rightRoot]) {
    [leftRoot, rightRoot] = [rightRoot, leftRoot];
  }
  parent[rightRoot] = leftRoot;
  if (rank[leftRoot] === rank[rightRoot]) rank[leftRoot] += 1;
}

function displayKey(atom: number, a: number, b: number, c: number): string {
  return `${atom}:${a}:${b}:${c}`;
}

function spatialKey(x: number, y: number, z: number): string {
  return `${x}:${y}:${z}`;
}

function canonicalKey(selection: AtomSelection): string {
  return `${selection.atom}:${selection.image[0]}:${selection.image[1]}:${selection.image[2]}`;
}

function cloneSelection(selection: AtomSelection): AtomSelection {
  return { atom: selection.atom, image: [...selection.image] };
}

function assertSelection(selection: AtomSelection): void {
  if (!validContextSelection(selection, Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Atom selection must contain a non-negative atom and integer image");
  }
}

function validContextSelection(selection: AtomSelection, count: number): boolean {
  return Number.isInteger(selection.atom)
    && selection.atom >= 0
    && selection.atom < count
    && Array.isArray(selection.image)
    && selection.image.length === 3
    && selection.image.every(Number.isSafeInteger);
}

function normalizedSelectionName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) throw new RangeError("Named selection requires a name");
  if (normalized.length > 80) throw new RangeError("Named selection name is too long");
  return normalized;
}
