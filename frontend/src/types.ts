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
  chain_id?: string | null;
  segment_id?: number | null;
  sequence_number?: number | null;
  insertion_code?: string | null;
  secondary_structure?: "coil" | "helix" | "sheet";
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
  dataset_generation?: string;
  name: string;
  frame_count: number;
  topology: Topology;
  properties?: Record<string, PropertySpec>;
  series?: Record<string, unknown> | SeriesSpec[];
  source?: SourceManifest;
}

export interface SourceManifest {
  kind?: string;
  path?: string;
  slice?: {
    start?: number | null;
    stop?: number | null;
    step?: number | null;
  };
  segments?: SourceSegmentManifest[];
}

export interface SourceSegmentManifest {
  source_id: string;
  kind: string;
  path?: string | null;
  input?: string | null;
  frame_count: number;
  files?: Record<string, string>;
}

export interface FrameKey {
  source_id: string;
  source_index: number;
  segment_index: number;
  step?: number | null;
  time?: number | null;
  time_unit?: string | null;
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
  frame_key?: FrameKey;
  step?: number;
  time?: number;
  energy?: number;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FrameData {
  header: FrameHeader;
  arrays: Map<string, Float32Array | Int32Array>;
}

export interface DisplaySeries {
  name: string;
  label: string;
  unit?: string;
  values: Array<number | null>;
}

export type Appearance = "light" | "dark";

export type CellOffset = [number, number, number];

export interface AtomSelection {
  atom: number;
  image: CellOffset;
}

export type RepresentationMode =
  | "ball-stick"
  | "spacefill"
  | "licorice"
  | "lines"
  | "ribbon"
  | "polyhedra";

export interface ScenePresentation {
  mode: RepresentationMode;
  water: "show" | "hide" | "only";
  hydrogens: boolean;
  wrap: "atom" | "molecule" | "unwrapped" | "none";
  cellOrigin: CellOffset;
  mirror: [boolean, boolean, boolean];
  images: {
    min: CellOffset;
    max: CellOffset;
  };
  cell: boolean;
  forces: boolean;
  velocities: boolean;
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
