"""Optional ASE sources for the unified viewer dataset."""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Iterator
from pathlib import Path
from threading import RLock
from typing import Any

import numpy as np

from PQAnalysis.core import Cell

from .data import FrameData, SCHEMA_VERSION
from .periodic import centered_image_shifts


class ASEFrameSource:
    """Lazy indexed access to ASE atoms, sequences, and supported files."""

    GENERIC_CACHE_SIZE = 8
    GENERIC_CACHE_BYTES = 32 * 1024**2
    SERIES_EAGER_LIMIT = 256

    def __init__(self, source: Any, *, name: str | None = None) -> None:
        ase = _require_ase()
        self._atoms_type = ase.Atoms
        self._path: Path | None = None
        self._sequence: Any | None = None
        self._single: Any | None = None
        self._trajectory: Any | None = None
        self._format: str | None = None
        self._fingerprint: tuple[int, int, int] | None = None
        self._series: list[dict[str, Any]] | None = None
        self._series_deferred = False
        self._generic_stream: Iterator[Any] | None = None
        self._generic_stream_index = 0
        self._generic_cache: OrderedDict[int, Any] = OrderedDict()
        self._generic_cache_bytes = 0
        self._generic_lock = RLock()

        if isinstance(source, self._atoms_type):
            self._single = source
            self.name = name or "ASE Atoms"
            self.source_id = f"ase:{self.name}"
            self._frame_count = 1
        elif isinstance(source, (str, Path)):
            self._path = Path(source).expanduser().resolve()
            if not self._path.is_file():
                raise FileNotFoundError(self._path)
            self.name = name or self._path.name
            self.source_id = str(self._path)
            self._open_path()
        elif _is_indexed_source(source):
            frame_count = len(source)
            if frame_count == 0:
                raise ValueError("ASE trajectory is empty")
            if not isinstance(source[0], self._atoms_type):
                raise TypeError("ASE trajectory items must be Atoms")
            self._sequence = source
            self.name = name or "ASE trajectory"
            self.source_id = f"ase:{self.name}"
            self._frame_count = frame_count
            self._series_deferred = frame_count > self.SERIES_EAGER_LIMIT
        else:
            raise TypeError(
                "source must be a path, ASE Atoms, or an indexed ASE trajectory"
            )

        first = self._read_atoms(0)
        self._atomic_numbers = tuple(
            int(value) for value in np.asarray(first.numbers)
        )
        self._topology = _topology_manifest(first)
        if self._path is not None and self._format == "proteindatabank":
            pdb_topology = _pdb_residue_topology(self._path, len(first))
            if pdb_topology is not None:
                self._topology.update(pdb_topology)
        self._properties = _property_manifest(first)

    @property
    def frame_count(self) -> int:
        return self._frame_count

    def manifest(self) -> dict[str, Any]:
        series = self._series_manifest()
        properties = dict(self._properties)
        for entry in series:
            properties.setdefault(
                entry["name"],
                _property("frame", [], entry.get("unit")),
            )
        return {
            "schema_version": SCHEMA_VERSION,
            "name": self.name,
            "frame_count": self.frame_count,
            "coordinate_modes": ["source"],
            "topology": self._topology,
            "properties": properties,
            "series": series,
            "series_deferred": self._series_deferred,
            "companion_files": {},
            "ase_format": self._format,
        }

    def get_frame(self, index: int) -> FrameData:
        if index < 0 or index >= self.frame_count:
            raise IndexError(
                f"frame index {index} is outside 0..{self.frame_count - 1}"
            )
        atoms = self._read_atoms(index)
        numbers = tuple(int(value) for value in np.asarray(atoms.numbers))
        if numbers != self._atomic_numbers:
            raise ValueError("ASE trajectory topology changed")

        positions = np.asarray(atoms.positions, dtype=np.float64).copy()
        cell = np.asarray(atoms.cell.array, dtype=np.float64).copy()
        pbc = tuple(bool(value) for value in np.asarray(atoms.pbc))
        periodic_cell = _completed_cell(atoms, cell, pbc)
        pq_cell = _pq_cell(periodic_cell if periodic_cell is not None else cell)
        shifts = (
            centered_image_shifts(pq_cell, positions, pbc)
            if any(pbc) and not pq_cell.is_vacuum
            else np.zeros(positions.shape, dtype=np.int32)
        )
        arrays = atoms.arrays
        results = _calculator_results(atoms)
        forces = _vector_result(results.get("forces"), len(atoms))
        velocities = _velocities(atoms)
        charges = _charges(arrays, results, len(atoms))
        scalars = _numeric_scalars(atoms.info)
        for key in ("energy", "free_energy"):
            value = _finite_scalar(results.get(key))
            if value is not None:
                scalars[key] = value

        units: dict[str, str | None] = {
            "positions": "angstrom",
            "cell": "angstrom",
            "forces": "eV/angstrom" if forces is not None else None,
            "velocities": "angstrom/fs" if velocities is not None else None,
            "charges": "e" if charges is not None else None,
            "energy": "eV",
            "free_energy": "eV",
        }
        time_unit = _declared_unit(atoms.info, "time")
        if time_unit is not None:
            units["time"] = time_unit
        return FrameData(
            index=index,
            positions=positions,
            cell=cell,
            pbc=pbc,  # type: ignore[arg-type]
            periodic_cell=periodic_cell,
            forces=forces,
            velocities=velocities,
            charges=charges,
            scalars=scalars,
            units=units,
            centered_image_shifts=shifts,
        )

    def refresh(self) -> int:
        if self._path is None:
            return 0
        fingerprint = _path_fingerprint(self._path)
        if fingerprint == self._fingerprint:
            return 0
        previous_count = self.frame_count
        self._close_trajectory()
        self._open_path()
        return max(0, self.frame_count - previous_count)

    def _open_path(self) -> None:
        if self._path is None:
            return
        from ase.io import iread
        from ase.io.formats import filetype

        self._reset_generic_reader()
        self._series = None
        self._series_deferred = False
        lowered = self._path.name.casefold()
        if (
            lowered in {"poscar", "contcar"}
            or self._path.suffix.casefold() in {".poscar", ".contcar"}
        ):
            self._format = "vasp"
        else:
            self._format = filetype(str(self._path), read=True)
        if self._format == "traj":
            from ase.io.trajectory import Trajectory

            self._trajectory = Trajectory(str(self._path), mode="r")
            self._frame_count = len(self._trajectory)
            self._series_deferred = (
                self._frame_count > self.SERIES_EAGER_LIMIT
            )
        else:
            self._trajectory = None
            rows = [
                _series_row(atoms)
                for atoms in iread(
                    str(self._path),
                    index=":",
                    format=self._format,
                )
            ]
            self._frame_count = len(rows)
            self._series = _series_from_rows(rows)
        if self._frame_count == 0:
            raise ValueError(f"ASE source is empty: {self._path}")
        self._fingerprint = _path_fingerprint(self._path)

    def _read_atoms(self, index: int) -> Any:
        if self._single is not None:
            return self._single
        if self._sequence is not None:
            return self._sequence[index]
        if self._trajectory is not None:
            return self._trajectory[index]
        if self._path is None:
            raise RuntimeError("ASE source is not initialized")
        return self._read_generic(index)

    def _read_generic(self, index: int) -> Any:
        with self._generic_lock:
            cached = self._generic_cache.pop(index, None)
            if cached is not None:
                self._generic_cache[index] = cached
                return cached

            if (
                self._generic_stream is None
                or index < self._generic_stream_index
            ):
                self._restart_generic_stream()

            current = None
            while self._generic_stream_index <= index:
                if self._generic_stream is None:
                    raise RuntimeError("ASE reader is not initialized")
                try:
                    current = next(self._generic_stream)
                except StopIteration as error:
                    raise IndexError(index) from error
                current_index = self._generic_stream_index
                self._generic_stream_index += 1
                self._cache_generic(current_index, current)
            return self._generic_cache.get(index, current)

    def _restart_generic_stream(self) -> None:
        if self._path is None:
            raise RuntimeError("ASE source is not initialized")
        self._close_generic_stream()
        from ase.io import iread

        self._generic_stream = iter(
            iread(
                str(self._path),
                index=":",
                format=self._format,
            )
        )
        self._generic_stream_index = 0

    def _cache_generic(self, index: int, atoms: Any) -> None:
        size = _atoms_bytes(atoms)
        if size > self.GENERIC_CACHE_BYTES:
            return
        replaced = self._generic_cache.pop(index, None)
        if replaced is not None:
            self._generic_cache_bytes -= _atoms_bytes(replaced)
        self._generic_cache[index] = atoms
        self._generic_cache_bytes += size
        while (
            len(self._generic_cache) > self.GENERIC_CACHE_SIZE
            or self._generic_cache_bytes > self.GENERIC_CACHE_BYTES
        ):
            _, removed = self._generic_cache.popitem(last=False)
            self._generic_cache_bytes -= _atoms_bytes(removed)

    def _series_manifest(self) -> list[dict[str, Any]]:
        if self._series is None:
            if self._series_deferred:
                return []
            rows = [
                _series_row(self._read_atoms(index))
                for index in range(self.frame_count)
            ]
            self._series = _series_from_rows(rows)
        return [
            {**entry, "values": list(entry["values"])}
            for entry in self._series
        ]

    def _close_generic_stream(self) -> None:
        stream = self._generic_stream
        if stream is not None:
            close = getattr(stream, "close", None)
            if callable(close):
                close()
        self._generic_stream = None
        self._generic_stream_index = 0

    def _reset_generic_reader(self) -> None:
        with self._generic_lock:
            self._close_generic_stream()
            self._generic_cache.clear()
            self._generic_cache_bytes = 0

    def _close_trajectory(self) -> None:
        if self._trajectory is not None:
            close = getattr(self._trajectory, "close", None)
            if callable(close):
                close()
        self._trajectory = None
        self._reset_generic_reader()

    def __del__(self) -> None:
        self._close_trajectory()


def _require_ase() -> Any:
    try:
        import ase
    except ImportError as error:
        raise RuntimeError(
            "ASE support is optional; install pqanalysis-viewer[ase]"
        ) from error
    return ase


def _is_indexed_source(source: Any) -> bool:
    if isinstance(source, (str, bytes, bytearray, Path)):
        return False
    return callable(getattr(source, "__len__", None)) and callable(
        getattr(source, "__getitem__", None)
    )


def _completed_cell(
    atoms: Any,
    cell: np.ndarray,
    pbc: tuple[bool, bool, bool],
) -> np.ndarray | None:
    if cell.shape != (3, 3) or not np.all(np.isfinite(cell)):
        raise ValueError("ASE cell must be a finite 3x3 matrix")
    present = np.linalg.norm(cell, axis=1) > 1e-12
    if any(enabled and not present[axis] for axis, enabled in enumerate(pbc)):
        raise ValueError("periodic ASE cell vector is missing")
    rank = int(np.linalg.matrix_rank(cell, tol=1e-12))
    if rank == 0:
        return None
    completed = np.asarray(atoms.cell.complete().array, dtype=np.float64)
    if completed.shape != (3, 3) or not np.all(np.isfinite(completed)):
        raise ValueError("ASE cell could not be completed")
    if abs(float(np.linalg.det(completed))) < 1e-12:
        raise ValueError("ASE cell vectors are linearly dependent")
    return completed.copy()


def _pq_cell(cell: np.ndarray) -> Cell:
    if cell.shape != (3, 3) or abs(float(np.linalg.det(cell))) < 1e-12:
        return Cell()
    return Cell.init_from_box_matrix(cell.T)


def _calculator_results(atoms: Any) -> dict[str, Any]:
    calculator = getattr(atoms, "calc", None)
    check_state = getattr(calculator, "check_state", None)
    if (
        callable(check_state)
        and getattr(calculator, "atoms", None) is not None
    ):
        try:
            if check_state(atoms):
                return {}
        except Exception:
            return {}
    results = getattr(calculator, "results", None)
    return dict(results) if isinstance(results, dict) else {}


def _series_row(
    atoms: Any,
) -> tuple[float | int | None, float | int | None, str | None]:
    info = getattr(atoms, "info", {})
    return (
        _series_number(info.get("step")),
        _series_number(info.get("time")),
        _declared_unit(info, "time"),
    )


def _series_from_rows(
    rows: list[tuple[float | int | None, float | int | None, str | None]],
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    steps = [row[0] for row in rows]
    if any(value is not None for value in steps):
        entries.append({
            "name": "step",
            "label": "Step",
            "unit": None,
            "values": steps,
        })
    times = [row[1] for row in rows]
    if any(value is not None for value in times):
        units = {row[2] for row in rows if row[2] is not None}
        entries.append({
            "name": "time",
            "label": "Time",
            "unit": units.pop() if len(units) == 1 else None,
            "values": times,
        })
    return entries


def _series_number(value: Any) -> float | int | None:
    result = _finite_scalar(value)
    return result if not isinstance(result, bool) else None


def _declared_unit(values: Any, key: str) -> str | None:
    if not isinstance(values, dict):
        return None
    for unit_key in (f"{key}_unit", f"{key}_units"):
        value = values.get(unit_key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    units = values.get("units")
    if isinstance(units, dict):
        value = units.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _atoms_bytes(atoms: Any) -> int:
    size = 0
    arrays = getattr(atoms, "arrays", {})
    if isinstance(arrays, dict):
        size += sum(
            int(value.nbytes)
            for value in arrays.values()
            if isinstance(value, np.ndarray)
        )
    calculator = getattr(atoms, "calc", None)
    results = getattr(calculator, "results", {})
    if isinstance(results, dict):
        size += sum(
            int(value.nbytes)
            for value in results.values()
            if isinstance(value, np.ndarray)
        )
    return max(size, 1)


def _vector_result(value: Any, atom_count: int) -> np.ndarray | None:
    if value is None:
        return None
    array = np.asarray(value, dtype=np.float64)
    if array.shape != (atom_count, 3) or not np.all(np.isfinite(array)):
        return None
    return array.copy()


def _velocities(atoms: Any) -> np.ndarray | None:
    momenta = atoms.arrays.get("momenta")
    if momenta is None:
        return None
    values = np.asarray(momenta, dtype=np.float64)
    if values.shape != (len(atoms), 3) or not np.all(np.isfinite(values)):
        return None
    from ase import units

    masses = np.asarray(atoms.get_masses(), dtype=np.float64)
    if masses.shape != (len(atoms),) or np.any(masses <= 0):
        return None
    return values / masses[:, np.newaxis] * float(units.fs)


def _charges(
    arrays: dict[str, Any],
    results: dict[str, Any],
    atom_count: int,
) -> np.ndarray | None:
    value = results.get("charges")
    if value is None:
        value = arrays.get("initial_charges")
    if value is None:
        return None
    charges = np.asarray(value, dtype=np.float64)
    if charges.shape != (atom_count,) or not np.all(np.isfinite(charges)):
        return None
    return charges.copy()


def _numeric_scalars(values: dict[str, Any]) -> dict[str, float | int | bool]:
    result: dict[str, float | int | bool] = {}
    for key, value in values.items():
        scalar = _finite_scalar(value)
        if scalar is not None:
            result[str(key)] = scalar
    return result


def _finite_scalar(value: Any) -> float | int | bool | None:
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if not isinstance(value, (float, np.floating)):
        return None
    number = float(value)
    return number if np.isfinite(number) else None


def _topology_manifest(atoms: Any) -> dict[str, Any]:
    from ase.data import chemical_symbols

    numbers = [int(value) for value in np.asarray(atoms.numbers)]
    symbols = [
        chemical_symbols[number] if 0 <= number < len(chemical_symbols) else "X"
        for number in numbers
    ]
    atom_types = atoms.arrays.get("atomtypes")
    atom_names = (
        [str(value).strip() or symbols[index] for index, value in enumerate(atom_types)]
        if atom_types is not None and len(atom_types) == len(numbers)
        else symbols.copy()
    )
    residue_names = atoms.arrays.get("residuenames")
    residue_numbers = atoms.arrays.get("residuenumbers")
    residues: list[dict[str, Any]] = []
    atom_residue_index = [-1] * len(numbers)
    residue_ids = [0] * len(numbers)
    if (
        residue_names is not None
        and residue_numbers is not None
        and len(residue_names) == len(numbers)
        and len(residue_numbers) == len(numbers)
    ):
        lookup: dict[tuple[int, str], int] = {}
        for atom_index, (raw_id, raw_name) in enumerate(
            zip(residue_numbers, residue_names, strict=True)
        ):
            residue_id = int(raw_id)
            residue_name = str(raw_name).strip()
            key = residue_id, residue_name
            if key not in lookup:
                lookup[key] = len(residues)
                residues.append({
                    "index": len(residues),
                    "type_id": residue_id,
                    "name": residue_name,
                    "category": _residue_category(residue_name),
                })
            residue_ids[atom_index] = residue_id
            atom_residue_index[atom_index] = lookup[key]

    return {
        "atom_count": len(numbers),
        "atomic_numbers": numbers,
        "symbols": symbols,
        "atom_names": atom_names,
        "residue_ids": residue_ids,
        "atom_residue_index": atom_residue_index,
        "residues": residues,
        "bonds": [],
        "bond_source": "inferred",
    }


def _pdb_residue_topology(
    path: Path,
    atom_count: int,
) -> dict[str, Any] | None:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    atom_lines: list[tuple[str, int]] = []
    inside_model = not any(line.startswith("MODEL ") for line in lines)
    segment = 0
    for line in lines:
        if line.startswith("MODEL "):
            if atom_lines:
                break
            inside_model = True
            continue
        if line.startswith("ENDMDL") and inside_model:
            break
        if inside_model and line.startswith("TER"):
            segment += 1
            continue
        if inside_model and line.startswith(("ATOM  ", "HETATM")):
            atom_lines.append((line, segment))
    if len(atom_lines) != atom_count:
        return None

    ranges = [
        (*_pdb_helix_range(line), "helix")
        for line in lines
        if line.startswith("HELIX ")
    ]
    ranges.extend(
        (*_pdb_sheet_range(line), "sheet")
        for line in lines
        if line.startswith("SHEET ")
    )
    ranges = [entry for entry in ranges if entry[0] is not None and entry[1] is not None]

    residues: list[dict[str, Any]] = []
    atom_residue_index: list[int] = []
    residue_ids: list[str] = []
    lookup: dict[tuple[int, str, int, str, str], int] = {}
    for line, segment in atom_lines:
        residue_number = _pdb_integer(line[22:26])
        if residue_number is None:
            return None
        chain = line[21:22].strip()
        insertion = line[26:27].strip()
        name = line[17:20].strip()
        key = segment, chain, residue_number, insertion, name
        if key not in lookup:
            structure = "coil"
            residue_key = chain, residue_number, insertion
            for start, end, candidate in ranges:
                if _pdb_residue_in_range(residue_key, start, end):
                    structure = candidate
                    break
            lookup[key] = len(residues)
            residue = {
                "index": len(residues),
                "type_id": residue_number,
                "name": name,
                "category": _residue_category(name),
                "chain_id": chain or None,
                "segment_id": segment,
                "sequence_number": residue_number,
                "insertion_code": insertion or None,
            }
            if ranges:
                residue["secondary_structure"] = structure
            residues.append(residue)
        atom_residue_index.append(lookup[key])
        prefix = chain or f"_s{segment}"
        residue_ids.append(f"{prefix}:{residue_number}{insertion}")
    return {
        "residue_ids": residue_ids,
        "atom_residue_index": atom_residue_index,
        "residues": residues,
    }


def _pdb_helix_range(
    line: str,
) -> tuple[tuple[str, int, str] | None, tuple[str, int, str] | None]:
    return (
        _pdb_residue_key(line[19:20], line[21:25], line[25:26]),
        _pdb_residue_key(line[31:32], line[33:37], line[37:38]),
    )


def _pdb_sheet_range(
    line: str,
) -> tuple[tuple[str, int, str] | None, tuple[str, int, str] | None]:
    return (
        _pdb_residue_key(line[21:22], line[22:26], line[26:27]),
        _pdb_residue_key(line[32:33], line[33:37], line[37:38]),
    )


def _pdb_residue_key(
    chain: str,
    number: str,
    insertion: str,
) -> tuple[str, int, str] | None:
    parsed = _pdb_integer(number)
    return None if parsed is None else (chain.strip(), parsed, insertion.strip())


def _pdb_integer(value: str) -> int | None:
    try:
        return int(value.strip())
    except ValueError:
        return None


def _pdb_residue_in_range(
    residue: tuple[str, int, str],
    start: tuple[str, int, str] | None,
    end: tuple[str, int, str] | None,
) -> bool:
    if start is None or end is None:
        return False
    chain, number, insertion = residue
    if chain != start[0] or chain != end[0]:
        return False
    position = number, insertion or " "
    return (start[1], start[2] or " ") <= position <= (end[1], end[2] or " ")


def _property_manifest(atoms: Any) -> dict[str, dict[str, Any]]:
    atom_count = len(atoms)
    results = _calculator_results(atoms)
    properties: dict[str, dict[str, Any]] = {
        "positions": _property("atom", [atom_count, 3], "angstrom"),
        "cell": _property("frame", [3, 3], "angstrom"),
        "pbc": _property("frame", [3], None, dtype="bool"),
    }
    if _vector_result(results.get("forces"), atom_count) is not None:
        properties["forces"] = _property(
            "atom",
            [atom_count, 3],
            "eV/angstrom",
        )
    if atoms.arrays.get("momenta") is not None:
        properties["velocities"] = _property(
            "atom",
            [atom_count, 3],
            "angstrom/fs",
        )
    if (
        results.get("charges") is not None
        or atoms.arrays.get("initial_charges") is not None
    ):
        properties["charges"] = _property("atom", [atom_count], "e")
    if _finite_scalar(results.get("energy")) is not None:
        properties["energy"] = _property("frame", [], "eV")
    if _finite_scalar(results.get("free_energy")) is not None:
        properties["free_energy"] = _property("frame", [], "eV")
    return properties


def _property(
    scope: str,
    shape: list[int],
    unit: str | None,
    *,
    dtype: str = "float32",
) -> dict[str, Any]:
    return {
        "scope": scope,
        "dtype": dtype,
        "shape": shape,
        "unit": unit,
    }


def _residue_category(name: str) -> str:
    normalized = name.strip().casefold()
    if normalized in {"h2o", "hoh", "wat", "water"}:
        return "water"
    if normalized in {
        "ala", "arg", "asn", "asp", "cys", "gln", "glu", "gly", "his",
        "ile", "leu", "lys", "met", "phe", "pro", "ser", "thr", "trp",
        "tyr", "val",
    }:
        return "amino-acid"
    return "other"


def _path_fingerprint(path: Path) -> tuple[int, int, int]:
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
