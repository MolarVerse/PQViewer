export type BondInput = [number, number] | { a?: number; b?: number; source?: number; target?: number };

export interface Topology {
  atom_count: number;
  atomic_numbers?: number[];
  symbols?: string[];
  atom_names?: string[];
  residue_ids?: Array<number | string>;
  atom_residue_index?: number[];
  residues?: ResidueSpec[];
  bond_source?: "topology" | "inferred";
  bonds?: BondInput[] | number[];
}

export interface ResidueSpec {
  index: number;
  type_id: number | null;
  name: string | null;
  category: "water" | "amino-acid" | "nucleotide" | "other";
}

export interface SeriesSpec {
  name?: string;
  key?: string;
  label?: string;
  unit?: string;
  values: Array<number | null>;
}

export interface Manifest {
  schema_version: string | number;
  name: string;
  frame_count: number;
  topology: Topology;
  properties?: Record<string, PropertySpec>;
  series?: Record<string, unknown> | SeriesSpec[];
}

export interface PropertySpec {
  scope?: string;
  dtype?: string;
  shape?: number[];
  unit?: string | null;
}

export interface ArrayDescriptor {
  name: string;
  dtype: string;
  shape: number[];
  byte_offset: number;
  byte_length: number;
  unit?: string | null;
}

export interface FrameHeader {
  arrays: ArrayDescriptor[];
  pbc?: boolean[];
  scalars?: Record<string, number | null>;
  scalar_units?: Record<string, string | null>;
  frame_index?: number;
  index?: number;
  step?: number;
  time?: number;
  energy?: number;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FrameData {
  header: FrameHeader;
  arrays: Map<string, Float32Array>;
}

export interface DisplaySeries {
  name: string;
  label: string;
  unit?: string;
  values: Array<number | null>;
}

export type Appearance = "light" | "dark";

export type CellOffset = [number, number, number];

export type RepresentationMode = "ball-stick" | "spacefill" | "licorice" | "lines" | "ribbon";

export interface ScenePresentation {
  mode: RepresentationMode;
  water: "show" | "hide" | "only";
  hydrogens: boolean;
  wrap: "atom" | "molecule" | "none";
  images: {
    min: CellOffset;
    max: CellOffset;
  };
  cell: boolean;
  forces: boolean;
  atomScale: number;
  bondScale: number;
  color: "element" | "residue" | "chain";
  quality: "auto" | "high";
}

export interface SceneCapabilities {
  water: boolean;
  ribbon: boolean;
  ribbonReason: string;
  suggestedProfile: "molecule" | "protein" | "crystal";
}
