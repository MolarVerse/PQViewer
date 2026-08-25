# Contributing

PQViewer welcomes focused bug fixes, scientific regression cases, documentation,
and viewer improvements. What to work on next, and what not to add, is in
[PRODUCT_DIRECTION.md](PRODUCT_DIRECTION.md).

## Before changing code

Search the existing issues and open one for work that changes scientific
behavior or the user interface. Keep pull requests small enough to review and
describe the user-visible result.

Do not include confidential trajectories. Add the smallest synthetic or
redistributable fixture that reproduces a problem and document its provenance.

## Development setup

Python 3.12 or newer is required. Frontend work requires Node.js 20.19+ on the
20.x line, or 22.12+.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev,render]'

cd frontend
npm ci
npx playwright install chromium
cd ..
python -m playwright install chromium
```

Run the API and frontend development server in separate terminals:

```bash
pqviewer examples/water.xyz --no-open
```

```bash
cd frontend
npm run dev
```

## Checks

Run the checks relevant to the change:

```bash
python -m pytest

cd frontend
npm test
npm run build
npm run test:e2e
```

`npm run build` writes the packaged frontend to `pqviewer/static`. Commit those
generated assets when frontend source changes. Do not edit packaged assets by
hand.

Scientific changes need an executable regression test. Periodic behavior should
cover centered boundaries and triclinic cells. Unit conversions, frame
alignment, selections, and source identity should be asserted explicitly.

Visual changes need browser coverage at desktop and narrow widths. Update a
reference screenshot only after inspecting the changed image.

## Pull requests

- Explain the scientific or user-facing problem.
- Link the issue when one exists.
- List the checks run.
- Call out compatibility, data-format, or performance effects.
- Keep commit and PR text concise.

By contributing, you agree that your work is licensed under the repository's
MIT License.

## Maintainer release checklist

1. Update the package and frontend versions.
2. Rename **Unreleased** in `CHANGELOG.md` to the version and release date, then
   add a new empty **Unreleased** section.
3. Add `date-released` to `CITATION.cff` and verify its version.
4. Run Python, frontend, browser, render, and package-build checks.
5. Build the wheel and source distribution with `python -m build`.
6. Install the wheel in a clean environment and run both CLI help paths.
7. Verify `CITATION.cff`, documentation links, bundled frontend assets, and
   third-party license notices.
8. Before announcing public access, enable and test private vulnerability
   reporting, security alerts, and dependency alerts.
9. Push the version tag and let the release workflow build and smoke-test the
   wheel and source archive. Use a PEP 440 pre-release version for test releases.
10. Approve the protected `pypi` environment. The workflow publishes to PyPI,
    then creates the GitHub release with checksums.
