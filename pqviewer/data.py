"""Indexed trajectory access backed by PQAnalysis."""

from __future__ import annotations

from dataclasses import dataclass, field
import math
from pathlib import Path
import re
import shlex
from typing import Any, Mapping

import numpy as np

from PQAnalysis.io import EnergyFileReader
from PQAnalysis.io.traj_file import get_frame_reader
from PQAnalysis.topology import Topology
from PQAnalysis.traj import MDEngineFormat, TrajectoryFormat


SCHEMA_VERSION = 1


@dataclass(frozen=True, slots=True)
class FrameData:
    """Numeric data needed to render one frame."""

    index: int
    positions: np.ndarray
    cell: np.ndarray
    pbc: tuple[bool, bool, bool]
    forces: np.ndarray | None = None
    velocities: np.ndarray | None = None
    charges: np.ndarray | None = None
    scalars: Mapping[str, float | int | bool] = field(default_factory=dict)
    units: Mapping[str, str | None] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class _FrameSpan:
    start: int
    end: int
    metadata: Mapping[str, str]
    cell_source: int | None


class PQTrajectoryDataset:
    """Random-access XYZ and extxyz trajectory dataset."""

    def __init__(
        self,
        trajectory_path: str | Path,
        *,
        energy_path: str | Path | None = None,
        info_path: str | Path | None = None,
        topology: Topology | None = None,
        md_format: MDEngineFormat | str = MDEngineFormat.PQ,
        name: str | None = None,
    ) -> None:
        self.path = Path(trajectory_path).expanduser().resolve()
        if not self.path.is_file():
            raise FileNotFoundError(self.path)

        self.energy_path = (
            Path(energy_path).expanduser().resolve()
            if energy_path is not None
            else None
        )
        self.info_path = (
            Path(info_path).expanduser().resolve()
            if info_path is not None
            else None
        )
        self.name = name or self.path.name
        self.md_format = MDEngineFormat(md_format)
        self.traj_format = self._detect_format()
        self._initial_topology = topology
        self._topology = topology
        self._spans: list[_FrameSpan] = []
        self._scan_offset = 0
        self._file_id: tuple[int, int] | None = None
        self._anchor_start = 0
        self._anchor = b""
        self._last_cell_source: int | None = None
        self._cell_cache: dict[int, Any] = {}
        self._sidecar_series: list[dict[str, Any]] = []

        self._scan_frames()
        self._load_energy_series()

    @property
    def frame_count(self) -> int:
        return len(self._spans)

    def manifest(self) -> dict[str, Any]:
        """Return the versioned dataset description."""
        first = self.get_frame(0) if self.frame_count else None
        topology = self._topology_manifest()
        series = self._series()

        properties: dict[str, dict[str, Any]] = {
            "positions": self._property_spec(
                "atom", [topology["atom_count"], 3], "angstrom"
            ),
            "cell": self._property_spec("frame", [3, 3], "angstrom"),
            "pbc": {
                "scope": "frame",
                "dtype": "bool",
                "shape": [3],
                "unit": None,
            },
        }
        if first is not None:
            for key, shape in self._array_properties(first).items():
                properties[key] = self._property_spec(
                    "atom", shape, self._property_unit(key, first)
                )

        for entry in series:
            properties.setdefault(
                entry["name"],
                self._property_spec("frame", [], entry.get("unit")),
            )

        return {
            "schema_version": SCHEMA_VERSION,
            "name": self.name,
            "frame_count": self.frame_count,
            "topology": topology,
            "properties": properties,
            "series": series,
        }

    def get_frame(self, index: int) -> FrameData:
        """Decode one indexed frame with PQAnalysis."""
        if index < 0 or index >= self.frame_count:
            raise IndexError(
                f"frame index {index} is outside 0..{self.frame_count - 1}"
            )

        span = self._spans[index]
        with self.path.open("rb") as handle:
            handle.seek(span.start)
            frame_text = handle.read(span.end - span.start).decode("utf-8")

        system = self._decode_frame(frame_text)
        if self._topology is None:
            self._topology = system.topology
        elif system.n_atoms != self._topology.n_atoms:
            raise ValueError("trajectory topology changed")

        if system.cell.is_vacuum:
            source = span.cell_source
            if source is not None and source != index:
                system.cell = self._cell_for_source(source)

        metadata = span.metadata
        pbc = self._pbc(system, metadata)
        cell = (
            np.zeros((3, 3), dtype=np.float64)
            if system.cell.is_vacuum
            else np.asarray(system.cell.box_matrix.T, dtype=np.float64).copy()
        )
        scalars = self._frame_scalars(index, metadata)
        if system.has_energy:
            scalars["energy"] = float(system.energy)

        units = self._frame_units(metadata)
        return FrameData(
            index=index,
            positions=np.asarray(system.pos, dtype=np.float64).copy(),
            cell=cell,
            pbc=pbc,
            forces=self._optional_array(system.forces, system.has_forces),
            velocities=self._optional_array(system.vel, system.has_vel),
            charges=self._optional_array(system.charges, system.has_charges),
            scalars=scalars,
            units=units,
        )

    def refresh(self) -> int:
        """Index newly completed frames and return their count."""
        previous_count = self.frame_count
        stat = self.path.stat()
        file_id = (stat.st_dev, stat.st_ino)
        if (
            self._file_id is not None
            and (
                file_id != self._file_id
                or stat.st_size < self._scan_offset
                or not self._anchor_matches()
            )
        ):
            self._spans.clear()
            self._scan_offset = 0
            self._topology = self._initial_topology
            self._last_cell_source = None
            self._cell_cache.clear()

        if not self._spans:
            self.traj_format = self._detect_format()

        self._scan_frames()
        self._load_energy_series()
        return max(0, self.frame_count - previous_count)

    def _detect_format(self) -> TrajectoryFormat:
        suffix = self.path.name.lower()
        if suffix.endswith((".extxyz", ".extended.xyz")):
            return TrajectoryFormat.EXTXYZ
        if not suffix.endswith(".xyz"):
            raise ValueError("trajectory must be an XYZ or extxyz file")

        with self.path.open("rb") as handle:
            handle.readline()
            comment = handle.readline().lower()
        if b"properties" in comment:
            return TrajectoryFormat.EXTXYZ
        return TrajectoryFormat.XYZ

    def _scan_frames(self) -> None:
        stat = self.path.stat()
        self._file_id = (stat.st_dev, stat.st_ino)

        with self.path.open("rb") as handle:
            handle.seek(self._scan_offset)
            while True:
                start, header = self._next_header(handle)
                if header is None:
                    self._scan_offset = handle.tell()
                    break

                try:
                    atom_count = int(header.split(maxsplit=1)[0])
                except (ValueError, IndexError) as exc:
                    raise ValueError(
                        f"invalid XYZ header at byte {start}"
                    ) from exc
                if atom_count < 0:
                    raise ValueError(f"negative atom count at byte {start}")

                comment = handle.readline()
                if not comment:
                    self._scan_offset = start
                    break

                metadata = self._parse_metadata(
                    comment.decode("utf-8", errors="replace").strip()
                )
                expected_fields = self._expected_atom_fields(metadata)

                complete = True
                for _ in range(atom_count):
                    atom_line = handle.readline()
                    if not atom_line or len(atom_line.split()) < expected_fields:
                        complete = False
                        break
                if not complete:
                    self._scan_offset = start
                    break

                end = handle.tell()
                frame_index = len(self._spans)
                if self._declares_cell(header, metadata):
                    self._last_cell_source = frame_index
                self._spans.append(
                    _FrameSpan(
                        start,
                        end,
                        metadata,
                        self._last_cell_source,
                    )
                )
                self._scan_offset = end

        self._update_anchor()

    def _anchor_matches(self) -> bool:
        if not self._anchor:
            return True
        with self.path.open("rb") as handle:
            handle.seek(self._anchor_start)
            return handle.read(len(self._anchor)) == self._anchor

    def _update_anchor(self) -> None:
        self._anchor_start = max(0, self._scan_offset - 512)
        with self.path.open("rb") as handle:
            handle.seek(self._anchor_start)
            self._anchor = handle.read(self._scan_offset - self._anchor_start)

    @staticmethod
    def _next_header(handle: Any) -> tuple[int, bytes | None]:
        while True:
            start = handle.tell()
            line = handle.readline()
            if not line:
                return start, None
            if line.strip():
                return start, line

    def _expected_atom_fields(self, metadata: Mapping[str, str]) -> int:
        if self.traj_format == TrajectoryFormat.XYZ:
            return 4
        values = metadata.get("properties", "").split(":")
        if len(values) < 3 or len(values) % 3:
            return 4
        try:
            return sum(int(values[index]) for index in range(2, len(values), 3))
        except ValueError:
            return 4

    def _decode_frame(self, frame_text: str) -> Any:
        reader = get_frame_reader(self.traj_format, md_format=self.md_format)
        return reader.read(
            frame_text,
            topology=self._topology,
            traj_format=self.traj_format,
        )

    def _cell_for_source(self, index: int) -> Any:
        if index not in self._cell_cache:
            span = self._spans[index]
            with self.path.open("rb") as handle:
                handle.seek(span.start)
                text = handle.read(span.end - span.start).decode("utf-8")
            cell = self._decode_frame(text).cell
            if cell.is_vacuum:
                raise ValueError("indexed cell source has no cell")
            self._cell_cache[index] = cell
        return self._cell_cache[index]

    def _declares_cell(
        self,
        header: bytes,
        metadata: Mapping[str, str],
    ) -> bool:
        if self.traj_format == TrajectoryFormat.EXTXYZ:
            return "lattice" in metadata
        return len(header.split()) in {4, 7}

    def _topology_manifest(self) -> dict[str, Any]:
        if self._topology is None and self.frame_count:
            self.get_frame(0)
        topology = self._topology
        if topology is None:
            return {
                "atom_count": 0,
                "atomic_numbers": [],
                "symbols": [],
                "atom_names": [],
                "residue_ids": [],
                "bonds": [],
            }

        atoms = topology.atoms
        bonds: list[list[int]] = []
        bonded = topology.bonded_topology
        if bonded is not None:
            bonds = [
                [int(bond.index1) - 1, int(bond.index2) - 1]
                for bond in bonded.bonds
            ]

        return {
            "atom_count": topology.n_atoms,
            "atomic_numbers": [self._atomic_number(atom) for atom in atoms],
            "symbols": [self._symbol(self._atom_symbol(atom)) for atom in atoms],
            "atom_names": [atom.name for atom in atoms],
            "residue_ids": [int(value) for value in topology.residue_ids],
            "bonds": bonds,
        }

    def _load_energy_series(self) -> None:
        self._sidecar_series = []
        if self.energy_path is None:
            return
        if not self._energy_has_data():
            return

        reader = EnergyFileReader(
            str(self.energy_path),
            info_filename=str(self.info_path) if self.info_path else None,
        )
        energy = reader.read()
        if energy.info_given:
            columns = sorted(energy.info.items(), key=lambda item: item[1])
        else:
            columns = [(f"column_{index}", index) for index in range(len(energy.data))]

        for label, column in columns:
            unit = energy.units[label] if energy.units_given else None
            self._sidecar_series.append(
                self._series_entry(
                    self._series_name(str(label)),
                    str(label),
                    np.asarray(energy.data[column]).reshape(-1),
                    unit,
                )
            )

    def _energy_has_data(self) -> bool:
        with self.energy_path.open("r", encoding="utf-8") as handle:
            return any(
                line.strip() and not line.lstrip().startswith("#")
                for line in handle
            )

    def _array_properties(self, first: FrameData) -> dict[str, list[int]]:
        atom_count = len(first.positions)
        found: dict[str, list[int]] = {}
        optional = (
            ("forces", first.forces),
            ("velocities", first.velocities),
            ("charges", first.charges),
        )
        for key, values in optional:
            if values is not None:
                found[key] = list(values.shape)

        aliases = {
            "force": "forces",
            "forces": "forces",
            "vel": "velocities",
            "velocity": "velocities",
            "velocities": "velocities",
            "charge": "charges",
            "charges": "charges",
        }
        for span in self._spans:
            values = span.metadata.get("properties", "").split(":")
            for index in range(0, len(values) - 2, 3):
                key = aliases.get(values[index].lower())
                if key is None:
                    continue
                try:
                    width = int(values[index + 2])
                except ValueError:
                    continue
                found[key] = [atom_count] if width == 1 else [atom_count, width]
        return found

    def _property_unit(self, key: str, first: FrameData) -> str | None:
        if first.units.get(key):
            return first.units[key]
        aliases = {
            "forces": ("forces", "force"),
            "velocities": ("velocities", "velocity", "vel"),
            "charges": ("charges", "charge"),
        }
        for span in self._spans:
            for alias in aliases.get(key, (key,)):
                unit = self._metadata_unit(span.metadata, alias)
                if unit:
                    return unit
        return None

    def _series(self) -> list[dict[str, Any]]:
        entries = list(self._sidecar_series)
        names = {entry["name"] for entry in entries}
        scalar_keys = sorted(
            {
                key
                for span in self._spans
                for key, value in span.metadata.items()
                if self._metadata_number(key, value) is not None
            }
        )
        for key in scalar_keys:
            name = self._series_name(key)
            if name in names:
                continue
            values = [
                self._metadata_number(key, span.metadata.get(key))
                for span in self._spans
            ]
            unit = next(
                (
                    self._metadata_unit(span.metadata, key)
                    for span in self._spans
                    if self._metadata_unit(span.metadata, key)
                ),
                None,
            )
            entries.append(self._series_entry(name, key, values, unit))
            names.add(name)
        return entries

    def _frame_scalars(
        self, index: int, metadata: Mapping[str, str]
    ) -> dict[str, float | int | bool]:
        scalars: dict[str, float | int | bool] = {}
        for key, value in metadata.items():
            number = self._metadata_number(key, value)
            if number is not None:
                scalars[self._series_name(key)] = number

        for entry in self._sidecar_series:
            values = entry["values"]
            if index < len(values) and values[index] is not None:
                scalars[entry["name"]] = values[index]
        return scalars

    @staticmethod
    def _parse_metadata(comment: str) -> dict[str, str]:
        metadata: dict[str, str] = {}
        tokens = shlex.split(comment)
        index = 0
        while index < len(tokens):
            token = tokens[index]
            if index + 2 < len(tokens) and tokens[index + 1] == "=":
                metadata[token.lower()] = tokens[index + 2]
                index += 3
            elif "=" in token and token != "=":
                key, value = token.split("=", 1)
                if not value and index + 1 < len(tokens):
                    index += 1
                    value = tokens[index]
                metadata[key.lower()] = value
                index += 1
            else:
                index += 1
        return metadata

    @staticmethod
    def _metadata_number(key: str, value: str | None) -> float | int | None:
        ignored = {
            "lattice",
            "pbc",
            "properties",
            "stress",
            "virial",
        }
        if value is None or key in ignored or key.endswith(("_unit", "_units")):
            return None
        try:
            number = float(value)
        except ValueError:
            return None
        if not math.isfinite(number):
            return None
        return int(number) if number.is_integer() else number

    def _frame_units(self, metadata: Mapping[str, str]) -> dict[str, str | None]:
        units: dict[str, str | None] = {
            "positions": self._metadata_unit(metadata, "positions") or "angstrom",
            "cell": self._metadata_unit(metadata, "cell") or "angstrom",
            "forces": self._metadata_unit(metadata, "forces")
            or self._metadata_unit(metadata, "force"),
            "velocities": self._metadata_unit(metadata, "velocities")
            or self._metadata_unit(metadata, "velocity"),
            "charges": self._metadata_unit(metadata, "charges")
            or self._metadata_unit(metadata, "charge"),
        }
        for key in metadata:
            if key.endswith("_unit"):
                units[self._series_name(key[:-5])] = metadata[key]
            elif key.endswith("_units"):
                units[self._series_name(key[:-6])] = metadata[key]
        for entry in self._sidecar_series:
            units[entry["name"]] = entry.get("unit")
        return units

    @staticmethod
    def _metadata_unit(metadata: Mapping[str, str], key: str) -> str | None:
        return metadata.get(f"{key}_unit") or metadata.get(f"{key}_units")

    @staticmethod
    def _pbc(system: Any, metadata: Mapping[str, str]) -> tuple[bool, bool, bool]:
        raw = metadata.get("pbc")
        if raw:
            values = raw.replace(",", " ").split()
            flags = [value.lower() in {"t", "true", "1", "yes"} for value in values]
            if len(flags) == 1:
                flags *= 3
            if len(flags) == 3:
                return tuple(flags)  # type: ignore[return-value]
        periodic = not system.cell.is_vacuum
        return (periodic, periodic, periodic)

    @staticmethod
    def _optional_array(values: np.ndarray, available: bool) -> np.ndarray | None:
        if not available:
            return None
        return np.asarray(values, dtype=np.float64).copy()

    @staticmethod
    def _property_spec(scope: str, shape: list[int], unit: str | None) -> dict[str, Any]:
        return {
            "scope": scope,
            "dtype": "float32",
            "shape": shape,
            "unit": unit,
        }

    @staticmethod
    def _series_entry(
        name: str,
        label: str,
        values: Any,
        unit: str | None,
    ) -> dict[str, Any]:
        cleaned = []
        for value in values:
            if value is None:
                cleaned.append(None)
                continue
            number = float(value)
            cleaned.append(number if math.isfinite(number) else None)
        return {
            "name": name,
            "label": label,
            "unit": unit,
            "values": cleaned,
        }

    @staticmethod
    def _series_name(label: str) -> str:
        name = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
        return name or "value"

    @staticmethod
    def _symbol(symbol: str | None) -> str:
        if not symbol:
            return "X"
        return symbol[0].upper() + symbol[1:].lower()

    @staticmethod
    def _atomic_number(atom: Any) -> int:
        number = getattr(atom, "atomic_number", None)
        if number is None and getattr(atom, "element", None) is not None:
            number = atom.element.atomic_number
        return int(number or 0)

    @staticmethod
    def _atom_symbol(atom: Any) -> str | None:
        symbol = getattr(atom, "symbol", None)
        if symbol is None and getattr(atom, "element", None) is not None:
            symbol = atom.element.symbol
        return symbol
