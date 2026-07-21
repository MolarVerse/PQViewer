export type BondInput = [number, number] | { a?: number; b?: number; source?: number; target?: number };

export interface Topology {
  atom_count: number;
  atomic_numbers?: number[];
  symbols?: string[];
  atom_names?: string[];
  residue_ids?: Array<number | string>;
  bonds?: BondInput[] | number[];
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

export interface LayerState {
  atoms: boolean;
  bonds: boolean;
  cell: boolean;
  forces: boolean;
}

export type Appearance = "light" | "dark";

export type CellOffset = [number, number, number];
