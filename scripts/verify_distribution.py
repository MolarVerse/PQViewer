from __future__ import annotations

import argparse
import json
import re
import tarfile
from email.parser import BytesParser
from pathlib import Path
from zipfile import ZipFile


def verify_wheel(path: Path) -> None:
    with ZipFile(path) as archive:
        names = set(archive.namelist())
        metadata_path = next(
            (name for name in names if name.endswith(".dist-info/METADATA")),
            None,
        )
        if metadata_path is None:
            raise SystemExit("wheel has no package metadata")

        metadata = BytesParser().parsebytes(archive.read(metadata_path))
        if metadata["Name"] != "molarverse-pqviewer":
            raise SystemExit(f"unexpected distribution name: {metadata['Name']}")

        required = (
            "pqviewer/static/index.html",
            "pqviewer/static/fonts/Inter-LICENSE.txt",
        )
        for bundled_file in required:
            if bundled_file not in names:
                raise SystemExit(f"wheel is missing {bundled_file}")

        notice_paths: dict[str, str] = {}
        for notice in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            notice_path = next(
                (
                    name
                    for name in names
                    if name.endswith(f".dist-info/licenses/{notice}")
                ),
                None,
            )
            if notice_path is None:
                raise SystemExit(f"wheel is missing {notice}")
            notice_paths[notice] = notice_path

        lockfile_path = Path("frontend/package-lock.json")
        if lockfile_path.is_file():
            lockfile = json.loads(lockfile_path.read_text())
            runtime_packages = {
                name.rsplit("node_modules/", 1)[-1]
                for name, package in lockfile["packages"].items()
                if name and not package.get("dev", False)
            }
            notices = archive.read(notice_paths["THIRD_PARTY_NOTICES.md"]).decode()
            undocumented = {
                package for package in runtime_packages if f"`{package}`" not in notices
            }
            if undocumented:
                missing = ", ".join(sorted(undocumented))
                raise SystemExit(f"third-party notices are missing: {missing}")

        html = archive.read("pqviewer/static/index.html").decode()
        for asset in re.findall(r'(?:src|href)="(/assets/[^"?]+)', html):
            bundled = f"pqviewer/static{asset}"
            if bundled not in names:
                raise SystemExit(f"wheel is missing {bundled}")
            if asset.endswith(".css"):
                css = archive.read(bundled).decode()
                for nested in re.findall(r"url\((/assets/[^)]+)\)", css):
                    nested_path = f"pqviewer/static{nested}"
                    if nested_path not in names:
                        raise SystemExit(f"wheel is missing {nested_path}")


def verify_sdist(path: Path) -> None:
    with tarfile.open(path, "r:gz") as archive:
        names = archive.getnames()
    for required in (
        "README.md",
        "THIRD_PARTY_NOTICES.md",
        "docs/conf.py",
    ):
        if not any(name.endswith(f"/{required}") for name in names):
            raise SystemExit(f"source archive is missing {required}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("wheel", type=Path)
    parser.add_argument("sdist", type=Path)
    arguments = parser.parse_args()
    verify_wheel(arguments.wheel)
    verify_sdist(arguments.sdist)


if __name__ == "__main__":
    main()
