import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const periodicFixture = path.join(repositoryRoot, "examples/periodic-boundary.extxyz");
const pqInputFixture = path.join(repositoryRoot, "examples/periodic-boundary.in");
const crossingFixture = path.join(repositoryRoot, "examples/periodic-crossing.extxyz");
const acofFixture = path.join(repositoryRoot, "examples/acof-triclinic.xyz");
const waterFixture = path.join(repositoryRoot, "examples/water.xyz");
const naclFixture = path.join(
  repositoryRoot,
  "docs/assets/sources/nacl.extxyz",
);
const polyhedraRequirement =
  "Requires a supported center with 3+ bonded ligands";

test.afterEach(async ({ request }) => {
  const response = await request.post("/api/open", {
    multipart: {
      files: {
        name: path.basename(periodicFixture),
        mimeType: "chemical/x-xyz",
        buffer: await readFile(periodicFixture),
      },
    },
  });
  expect(response.ok()).toBe(true);
});

async function openPeriodicFixture(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("periodic-boundary.extxyz · PQViewer");
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  await expect(page.locator(".frame-counter")).toHaveAttribute(
    "aria-label",
    "Frame 1 of 2",
  );
  await expect.poll(
    async () => changedPixelCount(await canvas.screenshot()),
  ).toBeGreaterThan(500);
}

async function openFixture(page: Page, fixture: string, title: string): Promise<void> {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const chooser = await chooserPromise;
  const openPromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/open")
      && response.request().method() === "POST",
  );
  await chooser.setFiles(fixture);
  expect((await openPromise).ok()).toBe(true);
  await expect(page).toHaveTitle(`${title} · PQViewer`);
  await expect(page.locator("canvas")).toBeVisible();
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

function changedPixelCount(bytes: Buffer): number {
  const image = PNG.sync.read(bytes);
  const [red, green, blue, alpha] = image.data;
  let changed = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const difference = Math.abs(image.data[index] - red)
      + Math.abs(image.data[index + 1] - green)
      + Math.abs(image.data[index + 2] - blue)
      + Math.abs(image.data[index + 3] - alpha);
    if (difference > 24) changed += 1;
  }
  return changed;
}

function differentPixelCount(leftBytes: Buffer, rightBytes: Buffer): number {
  const left = PNG.sync.read(leftBytes);
  const right = PNG.sync.read(rightBytes);
  expect([right.width, right.height]).toEqual([left.width, left.height]);
  let changed = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    const difference = Math.abs(left.data[index] - right.data[index])
      + Math.abs(left.data[index + 1] - right.data[index + 1])
      + Math.abs(left.data[index + 2] - right.data[index + 2])
      + Math.abs(left.data[index + 3] - right.data[index + 3]);
    if (difference > 24) changed += 1;
  }
  return changed;
}

function littleEndianTiffTag(bytes: Buffer, tag: number): {
  type: number;
  count: number;
  value: number;
} | null {
  expect(bytes.subarray(0, 4).toString("hex")).toBe("49492a00");
  const ifdOffset = bytes.readUInt32LE(4);
  const count = bytes.readUInt16LE(ifdOffset);
  for (let index = 0; index < count; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    if (bytes.readUInt16LE(offset) !== tag) continue;
    return {
      type: bytes.readUInt16LE(offset + 2),
      count: bytes.readUInt32LE(offset + 4),
      value: bytes.readUInt32LE(offset + 8),
    };
  }
  return null;
}

test("restores a figure recipe, rejects unsupported polyhedra, and exports an exact TIFF", async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  await page.getByRole("button", { name: "Last frame" }).click();
  const unwrappedResponse = page.waitForResponse(
    (response) => response.url().includes("/api/frames/1")
      && response.url().includes("coordinates=unwrapped"),
  );
  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill(
    "unwrapped coordinates",
  );
  await page.keyboard.press("Enter");
  expect((await unwrappedResponse).ok()).toBe(true);
  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("select oxygen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toContainText("O");

  const figureOptionsButton = page.getByRole("button", {
    name: "Figure options",
    exact: true,
  });
  await figureOptionsButton.click();
  const sheet = page.getByRole("dialog", { name: "Figure options" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "TIFF" }).click();
  await sheet.getByRole("button", { name: "Transparent" }).click();
  await sheet.getByRole("spinbutton", { name: "Width" }).fill("1200");
  await sheet.getByRole("spinbutton", { name: "Height" }).fill("900");
  await sheet.getByRole("spinbutton", { name: "DPI" }).fill("600");
  await sheet.getByRole("checkbox", { name: /Selected atom labels/ }).check();
  await sheet.getByRole("checkbox", { name: /Element legend/ }).check();
  await sheet.getByRole("checkbox", { name: /Scale bar/ }).check();

  const firstRecipeDownload = page.waitForEvent("download");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  const firstRecipePath = await (await firstRecipeDownload).path();
  expect(firstRecipePath).not.toBeNull();
  const firstRecipe = JSON.parse((await readFile(firstRecipePath!)).toString("utf8"));
  expect(firstRecipe.schema).toBe("pqviewer.figure");
  expect(firstRecipe.schema_version).toBe(1);
  expect(firstRecipe.frame.index).toBe(1);
  expect(firstRecipe.frame.fingerprint).toMatch(/^frame-v1:[0-9a-f]{16}$/);
  expect(firstRecipe.scene.presentation.wrap).toBe("unwrapped");
  expect(firstRecipe.output).toMatchObject({
    format: "tiff",
    width: 1200,
    height: 900,
    dpi: 600,
    background: { kind: "transparent" },
  });
  expect(firstRecipe.annotations.map((item: { kind: string }) => item.kind)).toEqual([
    "atom-label",
    "legend",
    "scale-bar",
  ]);

  await sheet.getByRole("button", { name: "Close figure options" }).click();
  await page.getByRole("button", { name: "First frame" }).click();
  await page.getByRole("button", { name: "Clear selection" }).click();

  const recipeChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("open figure recipe");
  await page.keyboard.press("Enter");
  await (await recipeChooser).setFiles(firstRecipePath!);
  await expect(page.locator(".notice")).toContainText("Figure recipe restored");
  await expect(page.locator(".frame-counter")).toHaveAttribute("aria-label", "Frame 2 of 2");
  await expect(page.locator(".selection-readout strong")).toContainText("O");

  await figureOptionsButton.click();
  await expect(sheet.getByRole("button", { name: "TIFF", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByRole("spinbutton", { name: "Width" })).toHaveValue("1200");
  const secondRecipeDownload = page.waitForEvent("download");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  const secondRecipePath = await (await secondRecipeDownload).path();
  expect(secondRecipePath).not.toBeNull();
  const secondRecipe = JSON.parse((await readFile(secondRecipePath!)).toString("utf8"));
  expect(secondRecipe.frame).toEqual(firstRecipe.frame);
  expect(secondRecipe.scene).toEqual(firstRecipe.scene);
  expect(secondRecipe.camera).toEqual(firstRecipe.camera);
  expect(secondRecipe.output).toEqual(firstRecipe.output);
  expect(secondRecipe.annotations).toEqual(firstRecipe.annotations);

  const tiffDownload = page.waitForEvent("download");
  await sheet.getByRole("button", { name: "Export TIFF" }).click();
  const tiffPath = await (await tiffDownload).path();
  expect(tiffPath).not.toBeNull();
  const tiff = await readFile(tiffPath!);
  expect(tiff.length).toBeGreaterThan(10_000);
  expect(littleEndianTiffTag(tiff, 256)?.value).toBe(1200);
  expect(littleEndianTiffTag(tiff, 257)?.value).toBe(900);
  expect(littleEndianTiffTag(tiff, 296)?.value & 0xffff).toBe(2);
  expect(littleEndianTiffTag(tiff, 338)?.value & 0xffff).toBe(2);
  expect(littleEndianTiffTag(tiff, 34675)?.count).toBeGreaterThan(500);
  const resolution = littleEndianTiffTag(tiff, 282);
  expect(resolution).not.toBeNull();
  expect(tiff.readUInt32LE(resolution!.value) / tiff.readUInt32LE(resolution!.value + 4)).toBe(600);

  const rejectedRecipe = structuredClone(firstRecipe);
  rejectedRecipe.frame.fingerprint = "frame-v1:0000000000000000";
  rejectedRecipe.scene.presentation.mode = "spacefill";
  rejectedRecipe.scene.selection.atoms = [];
  const rejectedChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill(
    "open figure recipe",
  );
  await page.keyboard.press("Enter");
  await (await rejectedChooser).setFiles({
    name: "changed.pqfigure.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(rejectedRecipe)),
  });
  await expect(page.locator(".notice")).toContainText(
    "saved frame content changed",
  );
  await expect(page.locator(".frame-counter")).toHaveAttribute(
    "aria-label",
    "Frame 2 of 2",
  );
  await expect(page.locator(".selection-readout strong")).toContainText("O");
  await page.getByRole("button", { name: "Show display controls" }).click();
  await expect(page.getByRole("button", { name: "Ball + stick" }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close", exact: true }).click();

  const unsupportedPolyhedraRecipe = structuredClone(firstRecipe);
  unsupportedPolyhedraRecipe.scene.presentation.mode = "polyhedra";
  await page.getByRole("button", { name: "Show display controls" }).click();
  await page.getByRole("button", { name: "Lines", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const unsupportedPolyhedraChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill(
    "open figure recipe",
  );
  await page.keyboard.press("Enter");
  await (await unsupportedPolyhedraChooser).setFiles({
    name: "unsupported-polyhedra.pqfigure.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(unsupportedPolyhedraRecipe)),
  });
  await expect(page.locator(".notice")).toContainText(
    `Polyhedra unavailable · ${polyhedraRequirement}`,
  );
  await page.getByRole("button", { name: "Show display controls" }).click();
  await expect(page.getByRole("button", { name: "Lines", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", {
    name: "Polyhedra",
    exact: true,
  })).toBeDisabled();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  const invalidLabelRecipe = structuredClone(firstRecipe);
  invalidLabelRecipe.annotations[0].atom.atom = 99;
  const invalidLabelChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill(
    "open figure recipe",
  );
  await page.keyboard.press("Enter");
  await (await invalidLabelChooser).setFiles({
    name: "invalid-label.pqfigure.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(invalidLabelRecipe)),
  });
  await expect(page.locator(".notice")).toContainText(
    "saved atom labels are outside this structure",
  );
  await expect(page.locator(".selection-readout strong")).toContainText("O");
  expect(errors).toEqual([]);
});

test("opens a trajectory in the packaged viewer", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  const manifestResponse = await page.request.get("/api/manifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.topology.atom_count).toBe(4);
  expect(manifest.frame_count).toBe(2);
  expect(manifest.properties.pbc).toBeDefined();
  await expect(page.locator(".topbar")).toHaveScreenshot("desktop-topbar.png");
  await expect(page.locator(".timeline")).toHaveScreenshot("desktop-timeline.png");
  if (process.platform === "darwin") {
    await expect(page.locator("canvas")).toHaveScreenshot("molecule-scene.png");
  }

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const chooser = await chooserPromise;
  const openPromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/open")
      && response.request().method() === "POST",
  );
  await chooser.setFiles(periodicFixture);
  expect((await openPromise).ok()).toBe(true);
  await expect(page.locator(".frame-counter")).toHaveAttribute(
    "aria-label",
    "Frame 1 of 2",
  );

  expect(errors).toEqual([]);
});

test("opens a PQ input bundle through the same viewer flow", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const chooser = await chooserPromise;
  const openPromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/open")
      && response.request().method() === "POST",
  );
  await chooser.setFiles([pqInputFixture, periodicFixture]);

  expect((await openPromise).ok()).toBe(true);
  await expect(page).toHaveTitle("periodic-boundary.extxyz · PQViewer");
  await expect(page.locator(".frame-counter")).toHaveAttribute(
    "aria-label",
    "Frame 1 of 2",
  );
  const manifestResponse = await page.request.get("/api/manifest");
  const manifest = await manifestResponse.json();
  expect(manifest.source.kind).toBe("pq-run-input");
  expect(manifest.source.segments[0].source_id).toContain(
    "periodic-boundary.extxyz",
  );
  const frameResponse = await page.request.get("/api/frames/0");
  const packet = await frameResponse.body();
  const headerSize = packet.readUInt32LE(0);
  const frameHeader = JSON.parse(
    packet.subarray(4, 4 + headerSize).toString("utf8"),
  );
  expect(frameHeader.frame_key.source_index).toBe(0);
  expect(frameHeader.frame_key.segment_index).toBe(0);
  await expect(page.locator("canvas")).toBeVisible();
  expect(errors).toEqual([]);
});

test("supports pointer and keyboard measurement with linked playback", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  const canvas = page.locator("canvas");
  await canvas.click({ position: { x: 532, y: 310 } });
  await page.keyboard.down("Shift");
  await canvas.click({ position: { x: 765, y: 392 } });
  await page.keyboard.up("Shift");
  await expect(page.locator(".selection-readout strong")).toContainText("Distance");
  await expect(page.locator(".selection-readout output")).toContainText("Å");

  await page.getByRole("button", { name: "Clear selection" }).click();
  await canvas.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page.locator(".selection-readout strong")).toContainText("Distance");
  await expect(page.locator(".selection-readout output")).toContainText("Å");

  await page.getByRole("button", { name: "Plot", exact: true }).click();
  const plot = page.getByRole("region", { name: /trajectory plot/ });
  await expect(plot.getByRole("button", { name: "PDF" })).toBeEnabled();
  const pdfDownload = page.waitForEvent("download");
  await plot.getByRole("button", { name: "PDF" }).click();
  const pdfPath = await (await pdfDownload).path();
  expect(pdfPath).not.toBeNull();
  const pdf = await readFile(pdfPath!);
  expect(pdf.subarray(0, 8).toString()).toBe("%PDF-1.4");
  expect(pdf.subarray(-8).toString()).toContain("%%EOF");
  expect(pdf.toString("latin1")).toContain("xref");
  await page.getByRole("button", { name: "Hide plot" }).click();

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.keyboard.down("Shift");
  await page.mouse.move(bounds!.x + 20, bounds!.y + 20);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 80, bounds!.y + 70, { steps: 2 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator(".selection-readout strong")).toContainText("Distance");
  await expect(page.getByRole("button", { name: "Pin", exact: true })).toBeVisible();

  const options = page.locator('summary[aria-label="Playback options"]');
  await options.click();
  await page.getByRole("button", { name: "Once", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();

  await expect(page.locator(".frame-counter")).toHaveAttribute(
    "aria-label",
    "Frame 2 of 2",
  );
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("links frame marks, atom tracking, and PQAnalysis pair plots", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  await page.keyboard.press("m");
  await expect(page.locator(".trajectory-marker.is-bookmark")).toHaveCount(1);

  const options = page.locator('summary[aria-label="Playback options"]');
  await options.click();
  await page.getByRole("button", { name: "Set as reference" }).click();
  await expect(page.locator(".trajectory-marker.is-reference")).toHaveCount(1);

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("select oxygen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("O2");

  const firstPositions = page.waitForResponse(
    (response) => response.url().endsWith("/api/positions")
      && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Track", exact: true }).click();
  expect((await firstPositions).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Stop", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  const trailPositions = page.waitForResponse(
    (response) => response.url().endsWith("/api/positions")
      && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Next frame" }).click();
  expect((await trailPositions).ok()).toBe(true);

  const displacementPositions = page.waitForResponse(
    (response) => response.url().endsWith("/api/positions")
      && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill(
    "displacement from reference",
  );
  await page.keyboard.press("Enter");
  expect((await displacementPositions).ok()).toBe(true);

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill(
    "pair distribution",
  );
  await page.keyboard.press("Enter");
  const setup = page.getByRole("dialog", { name: "Pair analysis" });
  await expect(setup).toBeVisible();
  await expect(setup.locator("select").first()).toBeFocused();
  await expect(setup.getByText("PQAnalysis · full periodic cells")).toBeVisible();

  const analysisResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/analysis/rdf")
      && response.request().method() === "POST",
  );
  await setup.getByRole("button", { name: "Run", exact: true }).click();
  const response = await analysisResponse;
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload.radius_centers.length).toBe(payload.g_r.length);
  expect(payload.coordination_radius.length).toBe(payload.coordination.length);

  const rdfPlot = page.getByRole("region", {
    name: /Pair distribution .* trajectory plot/,
  });
  await expect(rdfPlot).toBeVisible();
  await expect(rdfPlot.locator(".measurement-plot__meta span")).toContainText("2 frames");
  await expect(rdfPlot.locator(".measurement-plot__meta span")).toContainText("Δr");
  await expect(rdfPlot.getByRole("img", { name: /Pair distribution/ })).toBeVisible();
  await rdfPlot.getByRole("button", { name: "N(r)", exact: true }).click();
  const coordinationPlot = page.getByRole("region", {
    name: /Coordination .* trajectory plot/,
  });
  await expect(coordinationPlot).toBeVisible();

  const csvDownload = page.waitForEvent("download");
  await coordinationPlot.getByRole("button", { name: "CSV" }).click();
  const csvPath = await (await csvDownload).path();
  expect(csvPath).not.toBeNull();
  expect((await readFile(csvPath!, "utf8")).split("\n")[0]).toContain("Radius");
  expect(errors).toEqual([]);
});

test("plots supplied frame properties on demand", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const chooser = await chooserPromise;
  const openPromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/open")
      && response.request().method() === "POST",
  );
  await chooser.setFiles([
    {
      name: "study.xyz",
      mimeType: "chemical/x-xyz",
      buffer: await readFile(periodicFixture),
    },
    {
      name: "study.en",
      mimeType: "text/plain",
      buffer: Buffer.from("0 -1.5\n1 -1.0\n"),
    },
    {
      name: "study.info",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "--------------------------------\n"
        + "| PQ info file |\n"
        + "--------------------------------\n"
        + "| SIMULATION-TIME 0.0 ps E(TOT) -1.5 kcal/mol |\n"
        + "--------------------------------\n\n",
      ),
    },
  ]);
  expect((await openPromise).ok()).toBe(true);
  await expect(page).toHaveTitle("study.xyz · PQViewer");

  await page.locator('summary[aria-label="Playback options"]').click();
  await page.getByRole("button", { name: "E(TOT)", exact: true }).click();
  const plot = page.getByRole("region", { name: "E(TOT) trajectory plot" });
  await expect(plot).toBeVisible();
  const chart = plot.getByRole("slider", { name: "E(TOT) frame" });
  await chart.press("End");
  await expect(page.locator(".frame-counter")).toHaveAttribute(
    "aria-label",
    "Frame 2 of 2",
  );

  const csvDownload = page.waitForEvent("download");
  await plot.getByRole("button", { name: "CSV" }).click();
  const csvPath = await (await csvDownload).path();
  expect(csvPath).not.toBeNull();
  const csv = await readFile(csvPath!, "utf8");
  expect(csv).toContain("E(TOT) [kcal/mol]");
  expect(csv).toContain("-1.5");
  expect(csv).toContain("-1");

  const canvas = page.locator("canvas");
  await canvas.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Plot", exact: true }).click();
  await expect(plot).toBeHidden();
  await expect(page.getByRole("region", { name: /Distance .* trajectory plot/ }))
    .toBeVisible();
  expect(errors).toEqual([]);
});

test("supports scientific selection, saved sets, and pinned measurements", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("select oxygen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("O2");

  await page.locator(".selection-tools > summary").click();
  await page.getByRole("button", { name: "Component", exact: true }).click();
  await expect(page.locator(".selection-readout strong")).toHaveText("CO · 2 atoms");

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("select oxygen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("O2");

  await page.locator(".selection-tools > summary").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".selection-tools")).not.toHaveAttribute("open", "");
  await expect(page.locator(".selection-readout strong")).toHaveText("O2");
  await page.locator(".selection-tools > summary").click();
  await page.getByPlaceholder("e.g. active site").fill("boundary oxygen");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Clear selection" }).click();

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("boundary oxygen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("O2");

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill(
    "select within 5 A of selection",
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("H2O · 3 atoms");

  await page.getByRole("button", { name: "Clear selection" }).click();
  const canvas = page.locator("canvas");
  await canvas.click({ position: { x: 532, y: 310 } });
  await page.keyboard.down("Shift");
  await canvas.click({ position: { x: 765, y: 392 } });
  await page.keyboard.up("Shift");
  await expect(page.locator(".selection-readout strong")).toContainText("Distance");
  await expect(page.locator(".selection-readout output")).toContainText("0.4 Å");

  await page.getByRole("button", { name: "Pin", exact: true }).click();
  const pinSummary = page.locator(".pinned-measurements > summary");
  await expect(pinSummary).toHaveText("Measurements · 1");
  await pinSummary.click();
  const pin = page.locator(".pinned-measurements .selection-chip");
  await expect(pin).toContainText("0.4 Å");
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Minimum image", exact: true }).click();
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Displayed images", exact: true }).click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Next frame" }).click();
  await expect(pin).toContainText("0.6083 Å");

  await page.getByRole("button", { name: "Clear selection" }).click();
  await pinSummary.click();
  await expect(pin).toBeVisible();
  await pin.click();
  await expect(page.locator(".selection-readout strong")).toContainText("Distance");
  expect(errors).toEqual([]);
});

test("supports box selection and large-selection summaries", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  const canvas = page.locator("canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.keyboard.down("Shift");
  await page.mouse.move(bounds!.x + 350, bounds!.y + 110);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 900, bounds!.y + 510, { steps: 4 });
  await expect(page.getByTestId("selection-marquee")).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator(".selection-readout strong")).toHaveText("CH2O · 4 atoms");

  await page.keyboard.down("Shift");
  await page.mouse.move(bounds!.x + 20, bounds!.y + 20);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 80, bounds!.y + 70, { steps: 2 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator(".selection-readout strong")).toHaveText("CH2O · 4 atoms");

  await page.getByRole("button", { name: "Clear selection" }).click();
  await page.keyboard.down("Shift");
  await page.mouse.move(bounds!.x + 900, bounds!.y + 510);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 350, bounds!.y + 110, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator(".selection-readout strong")).toHaveText("CH2O · 4 atoms");

  await page.getByRole("button", { name: "Clear selection" }).click();
  await page.getByRole("button", { name: "Show display controls" }).click();
  for (const axis of ["a", "b", "c"]) {
    await page.getByRole("button", { name: `Increase ${axis} repeats` }).click();
    await page.getByRole("button", { name: `Increase ${axis} repeats` }).click();
  }
  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("select hydrogen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toContainText("H2 · 54 atoms");
  for (const axis of ["a", "b", "c"]) {
    await page.getByRole("button", { name: `Decrease ${axis} repeats` }).click();
    await page.getByRole("button", { name: `Decrease ${axis} repeats` }).click();
  }
  await expect(page.locator(".selection-readout strong")).toContainText("H2 · 54 atoms");
  await page.getByRole("button", { name: "Summary", exact: true }).click();
  await expect(page.locator("#workbench")).toContainText("Cartesian centroid");
  await expect(page.locator("#workbench")).toContainText("Extent");
  expect(errors).toEqual([]);
});

test("keeps water selection and periodic image identity scientifically explicit", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  await openFixture(page, waterFixture, "water.xyz");

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("select water");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("H2O · 3 atoms");
  await expect(page.locator(".selection-readout")).not.toContainText("Angle");
  await expect(page.getByRole("button", { name: "Pin", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("select oxygen");
  await page.keyboard.press("Enter");
  const oxygenIdentity = await page.locator(".selection-readout strong").textContent();
  expect(oxygenIdentity).toContain("O1");

  await page.getByRole("button", { name: "Show display controls" }).click();
  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("source coordinates");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText(oxygenIdentity!);
  await page.getByRole("button", { name: "Atoms", exact: true }).click();
  await expect(page.locator(".selection-readout strong")).toHaveText(oxygenIdentity!);
  expect(errors).toEqual([]);
});

test("opens display controls and exports a publication PNG", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  await page.getByRole("button", { name: "Show display controls" }).click();
  const workbench = page.locator("#workbench");
  await expect(workbench).toBeVisible();
  await expect(workbench.getByText("Representation", { exact: true })).toBeVisible();
  await expect(workbench.getByText("Coordinates", { exact: true })).toBeVisible();
  await expect(workbench.getByText("Center cell", { exact: true })).toBeVisible();
  if (process.platform === "darwin") {
    await expect(workbench).toHaveScreenshot("view-controls.png");
  }

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Figure", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("periodic-boundary-2400x1800.png");

  const file = await download.path();
  expect(file).not.toBeNull();
  const png = await readFile(file!);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(2400);
  expect(png.readUInt32BE(20)).toBe(1800);
  expect(changedPixelCount(png)).toBeGreaterThan(10_000);
  expect(errors).toEqual([]);
});

test("disables unsupported polyhedra with an explicit reason", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  await page.getByRole("button", { name: "Show display controls" }).click();
  const polyhedra = page.getByRole("button", {
    name: "Polyhedra",
    exact: true,
  });
  await expect(polyhedra).toBeDisabled();
  await expect(polyhedra).toHaveAttribute(
    "aria-describedby",
    "polyhedra-requirement",
  );
  await expect(page.locator("#polyhedra-requirement")).toHaveText(
    `Polyhedra · ${polyhedraRequirement}`,
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill(
    "polyhedra",
  );
  const command = page.getByRole("option", {
    name: /Representation · Polyhedra/,
  });
  await expect(command).toBeVisible();
  await expect(command).toHaveAttribute("aria-disabled", "true");
  await expect(command).toContainText(polyhedraRequirement);
  expect(errors).toEqual([]);
});

test("renders and exports supported NaCl polyhedra", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  await openFixture(page, naclFixture, "nacl.extxyz");

  const canvas = page.locator("canvas");
  await page.getByRole("button", { name: "Show display controls" }).click();
  const polyhedra = page.getByRole("button", {
    name: "Polyhedra",
    exact: true,
  });
  await expect(polyhedra).toBeEnabled();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const ballStick = await canvas.screenshot();
  await page.getByRole("button", { name: "Show display controls" }).click();
  await polyhedra.click();
  await expect(polyhedra).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(
    async () => differentPixelCount(ballStick, await canvas.screenshot()),
  ).toBeGreaterThan(2_000);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Figure", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("nacl-2400x1800.png");
  const file = await download.path();
  expect(file).not.toBeNull();
  const png = await readFile(file!);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(2400);
  expect(png.readUInt32BE(20)).toBe(1800);
  expect(changedPixelCount(png)).toBeGreaterThan(10_000);
  expect(errors).toEqual([]);
});

test("keeps centered periodic controls direct and reversible", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  await openFixture(page, crossingFixture, "periodic-crossing.extxyz");

  await page.getByRole("button", { name: "Show display controls" }).click();
  await expect(page.getByRole("button", { name: "PQ", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Selection", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Structure", exact: true }).click();
  await expect(page.getByRole("button", { name: "Structure", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Mirror a", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mirror a", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Increase a repeats" }).click();
  await page.getByRole("button", { name: "Increase a repeats" }).click();
  await expect(page.getByRole("status", { name: "a repeats" })).toHaveText("3×");

  const unwrappedResponse = page.waitForResponse(
    (response) => response.url().includes("/api/frames/0")
      && response.url().includes("coordinates=unwrapped"),
  );
  await page.getByRole("button", { name: "Unwrapped", exact: true }).click();
  expect((await unwrappedResponse).ok()).toBe(true);

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("reset periodic");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Atoms", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "PQ", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Mirror a", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("status", { name: "a repeats" })).toHaveText("1×");
  await page.getByRole("button", { name: "Next frame" }).click();
  await expect(page.locator(".frame-counter")).toHaveAttribute("aria-label", "Frame 2 of 4");
  const finalUnwrappedResponse = page.waitForResponse(
    (response) => response.url().includes("/api/frames/1")
      && response.url().includes("coordinates=unwrapped"),
  );
  await page.getByRole("button", { name: "Unwrapped", exact: true }).click();
  expect((await finalUnwrappedResponse).ok()).toBe(true);
  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("select carbon");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("C1 (+a)");
  await expect(page.locator(".selection-readout output")).toHaveText("5.2 0.1 0");
  expect(errors).toEqual([]);
});

test("recovers when unwrapped coordinates cannot be loaded", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  await page.getByRole("button", { name: "Show display controls" }).click();
  await page.route(/\/api\/frames\/\d+\?.*coordinates=unwrapped/, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Unwrapped coordinates unavailable" }),
    });
  });

  await page.getByRole("button", { name: "Unwrapped", exact: true }).click();

  await expect(page.getByRole("button", { name: "Atoms", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Unwrapped coordinates unavailable · showing atoms"))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Hide display controls" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Figure", exact: true })).toBeEnabled();
  await expect(page.locator("canvas")).toBeVisible();
  expect(errors.filter((error) => !error.includes("status of 500"))).toEqual([]);
});

test("keeps a triclinic framework centered under display stress", async ({ page }) => {
  test.slow();
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  await openFixture(page, acofFixture, "acof-triclinic.xyz");

  const canvas = page.locator("canvas");
  await expect(page.locator(".frame-counter")).toHaveAttribute(
    "aria-label",
    "Frame 1 of 4",
  );
  await expect.poll(
    async () => changedPixelCount(await canvas.screenshot()),
  ).toBeGreaterThan(5_000);
  if (process.platform === "darwin") {
    await expect(canvas).toHaveScreenshot("acof-centered.png");
  }

  await page.getByRole("button", { name: "Show display controls" }).click();
  await expect(page.getByRole("button", { name: "Atoms", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "PQ", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Mirror a", exact: true }).click();
  await page.getByRole("button", { name: "Mirror b", exact: true }).click();
  await page.getByRole("button", { name: "Increase a repeats" }).click();
  await page.getByRole("button", { name: "Increase a repeats" }).click();
  await page.getByRole("button", { name: "Increase b repeats" }).click();
  await expect(page.getByRole("status", { name: "a repeats" })).toHaveText("3×");
  await expect(page.getByRole("status", { name: "b repeats" })).toHaveText("2×");

  const unwrappedResponse = page.waitForResponse(
    (response) => response.url().includes("/api/frames/0")
      && response.url().includes("coordinates=unwrapped"),
  );
  await page.getByRole("button", { name: "Unwrapped", exact: true }).click();
  expect((await unwrappedResponse).ok()).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  for (let pass = 0; pass < 4; pass += 1) {
    await page.getByRole("button", { name: "Last frame" }).click();
    await expect(page.locator(".frame-counter")).toHaveAttribute("aria-label", "Frame 4 of 4");
    await page.getByRole("button", { name: "First frame" }).click();
    await expect(page.locator(".frame-counter")).toHaveAttribute("aria-label", "Frame 1 of 4");
  }

  await page.getByRole("button", { name: "Show display controls" }).click();
  await page.getByRole("button", { name: "Mirror c", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Figure", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("acof-triclinic-2400x1800.png");
  const file = await download.path();
  expect(file).not.toBeNull();
  const png = await readFile(file!);
  expect(changedPixelCount(png)).toBeGreaterThan(50_000);
  expect(errors).toEqual([]);
});

test("keeps the compact layout readable at 320 px", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await openPeriodicFixture(page);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.locator(".topbar")).toHaveScreenshot("mobile-topbar.png");
  await expect(page.locator(".timeline")).toHaveScreenshot("mobile-timeline.png");

  const trajectoryOptions = page.locator('summary[aria-label="Playback options"]');
  await trajectoryOptions.click();
  const trajectoryMenu = page.locator(".timeline-options > div");
  await expect(trajectoryMenu.getByRole("button", {
    name: "Pair distribution",
  })).toBeVisible();
  const trajectoryMenuBox = await trajectoryMenu.boundingBox();
  expect(trajectoryMenuBox).not.toBeNull();
  expect(trajectoryMenuBox!.x).toBeGreaterThanOrEqual(0);
  expect(trajectoryMenuBox!.x + trajectoryMenuBox!.width).toBeLessThanOrEqual(320);
  expect(trajectoryMenuBox!.y).toBeGreaterThanOrEqual(0);
  await trajectoryOptions.click();

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill(
    "pair distribution",
  );
  await page.keyboard.press("Enter");
  const rdfSetup = page.getByRole("dialog", { name: "Pair analysis" });
  const rdfSetupBox = await rdfSetup.boundingBox();
  expect(rdfSetupBox).not.toBeNull();
  expect(rdfSetupBox!.x).toBeGreaterThanOrEqual(0);
  expect(rdfSetupBox!.x + rdfSetupBox!.width).toBeLessThanOrEqual(320);
  expect(rdfSetupBox!.y).toBeGreaterThanOrEqual(0);
  expect(rdfSetupBox!.y + rdfSetupBox!.height).toBeLessThanOrEqual(568);
  const runAnalysis = rdfSetup.getByRole("button", { name: "Run", exact: true });
  expect((await runAnalysis.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await rdfSetup.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Show display controls" }).click();
  const workbenchBody = page.locator(".workbench-body");
  await workbenchBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const repeatButton = page.getByRole("button", { name: "Increase c repeats" });
  await expect(repeatButton).toBeVisible();
  const repeatButtonBox = await repeatButton.boundingBox();
  expect(repeatButtonBox?.width).toBeGreaterThanOrEqual(40);
  expect(repeatButtonBox?.height).toBeGreaterThanOrEqual(40);
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Hide display controls" }).click();

  const compactFigureOptionsButton = page.getByRole("button", {
    name: "Figure options",
    exact: true,
  });
  await compactFigureOptionsButton.click();
  const figureSheet = page.getByRole("dialog", { name: "Figure options" });
  await expect(figureSheet).toBeVisible();
  expect(await page.locator(".topbar").evaluate((element) => (
    (element as HTMLElement).inert
  ))).toBe(true);
  await expect(
    figureSheet.getByRole("button", { name: "Landscape" }),
  ).toHaveAttribute("aria-pressed", "true");
  const figureSheetBox = await figureSheet.boundingBox();
  expect(figureSheetBox).not.toBeNull();
  expect(figureSheetBox!.x).toBeGreaterThanOrEqual(0);
  expect(figureSheetBox!.x + figureSheetBox!.width).toBeLessThanOrEqual(320);
  for (const control of [
    figureSheet.getByRole("button", { name: "PNG", exact: true }),
    figureSheet.getByRole("button", { name: "Transparent" }),
    figureSheet.getByRole("button", { name: "Export PNG" }),
  ]) {
    const controlBox = await control.boundingBox();
    expect(controlBox?.height).toBeGreaterThanOrEqual(40);
  }
  const figureOptionsBox = await compactFigureOptionsButton.boundingBox();
  expect(figureOptionsBox?.height).toBeGreaterThanOrEqual(40);
  const figureBodyBox = await figureSheet.locator(".export-body").boundingBox();
  const dpiBox = await figureSheet.getByRole("spinbutton", {
    name: "DPI",
  }).boundingBox();
  expect(figureBodyBox).not.toBeNull();
  expect(dpiBox).not.toBeNull();
  expect(dpiBox!.y + dpiBox!.height).toBeLessThanOrEqual(
    figureBodyBox!.y + figureBodyBox!.height,
  );
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(compactFigureOptionsButton).toBeFocused();

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("select oxygen");
  await page.keyboard.press("Enter");
  await page.locator(".selection-tools > summary").click();
  for (const name of ["boundary", "oxygen shell", "active set"]) {
    await page.getByPlaceholder("e.g. active site").fill(name);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".selection-tools > summary").click();
  }
  const toolsBox = await page.locator(".selection-tools-popover").boundingBox();
  const selectionBox = await page.locator(".selection-bar").boundingBox();
  const topbarBox = await page.locator(".topbar").boundingBox();
  expect(toolsBox).not.toBeNull();
  expect(selectionBox).not.toBeNull();
  expect(topbarBox).not.toBeNull();
  expect(toolsBox!.x).toBeGreaterThanOrEqual(0);
  expect(toolsBox!.x + toolsBox!.width).toBeLessThanOrEqual(320);
  expect(toolsBox!.y).toBeGreaterThanOrEqual(topbarBox!.y + topbarBox!.height);
  expect(toolsBox!.y + toolsBox!.height).toBeLessThanOrEqual(selectionBox!.y);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Clear selection" }).click();
  const canvas = page.locator("canvas");
  await canvas.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toContainText("Distance");
  for (let index = 0; index < 8; index += 1) {
    await page.getByRole("button", { name: "Pin", exact: true }).click();
  }
  const measurementSummary = page.locator(".pinned-measurements > summary");
  await expect(measurementSummary).toHaveText("Measurements · 8");
  await measurementSummary.click();
  await expect(page.locator(".pinned-measurements__list > div")).toHaveCount(8);
  await measurementSummary.click();
  const pinsBox = await page.locator(".pinned-measurements").boundingBox();
  const currentSelectionBox = await page.locator(".selection-bar").boundingBox();
  expect(pinsBox).not.toBeNull();
  expect(currentSelectionBox).not.toBeNull();
  expect(pinsBox!.y + pinsBox!.height).toBeLessThan(currentSelectionBox!.y);
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Plot", exact: true }).click();
  const compactPlot = page.getByRole("region", { name: /Distance .* trajectory plot/ });
  const exportMenu = compactPlot.locator(".measurement-plot__export-menu > summary");
  await expect(exportMenu).toBeVisible();
  await exportMenu.click();
  const svgExport = compactPlot.getByRole("button", { name: "SVG", exact: true });
  await expect(svgExport).toBeVisible();
  expect((await svgExport.boundingBox())?.height).toBeGreaterThanOrEqual(40);
  const compactPlotBox = await compactPlot.boundingBox();
  const exportPanelBox = await compactPlot.locator(
    ".measurement-plot__export-menu > div",
  ).boundingBox();
  expect(compactPlotBox).not.toBeNull();
  expect(exportPanelBox).not.toBeNull();
  expect(exportPanelBox!.y + exportPanelBox!.height).toBeLessThanOrEqual(
    compactPlotBox!.y + compactPlotBox!.height,
  );
  await page.getByRole("button", { name: "Hide plot", exact: true }).click();
  expect(errors).toEqual([]);
});

test("keeps study sheets reachable in short landscape", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 568, height: 320 });
  await openPeriodicFixture(page);

  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill(
    "pair distribution",
  );
  await page.keyboard.press("Enter");
  const setup = page.getByRole("dialog", { name: "Pair analysis" });
  await setup.getByText("Advanced", { exact: true }).click();
  const setupBox = await setup.boundingBox();
  const closeBox = await setup.getByRole("button", { name: "Close" }).boundingBox();
  const setupBody = setup.locator(".rdf-sheet__body");
  expect(await setupBody.evaluate((element) => (
    element.scrollHeight > element.clientHeight
  ))).toBe(true);
  await setupBody.evaluate((element) => { element.scrollTop = 0; });
  const fromBox = await setup.locator("select").first().boundingBox();
  expect(setupBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(fromBox).not.toBeNull();
  expect(setupBox!.y).toBeGreaterThanOrEqual(0);
  expect(setupBox!.y + setupBox!.height).toBeLessThanOrEqual(320);
  expect(closeBox!.y).toBeGreaterThanOrEqual(setupBox!.y);
  expect(fromBox!.y).toBeGreaterThanOrEqual(setupBox!.y);
  await setupBody.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const rMaxBox = await setup.getByLabel("r max · Å").boundingBox();
  expect(rMaxBox).not.toBeNull();
  expect(rMaxBox!.y + rMaxBox!.height).toBeLessThanOrEqual(
    setupBox!.y + setupBox!.height,
  );
  await setup.getByRole("button", { name: "Close" }).click();

  const canvas = page.locator("canvas");
  await canvas.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  for (let index = 0; index < 8; index += 1) {
    await page.getByRole("button", { name: "Pin", exact: true }).click();
  }
  await page.locator(".pinned-measurements > summary").click();
  const pinnedPanel = page.getByRole("region", { name: "Pinned measurements" });
  const lastPin = page.locator(".pinned-measurements__list > div").last();
  await lastPin.scrollIntoViewIfNeeded();
  const panelBox = await pinnedPanel.boundingBox();
  const lastPinBox = await lastPin.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(lastPinBox).not.toBeNull();
  expect(panelBox!.y).toBeGreaterThanOrEqual(0);
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(320);
  expect(lastPinBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
  expect(lastPinBox!.y + lastPinBox!.height).toBeLessThanOrEqual(
    panelBox!.y + panelBox!.height,
  );
  expect(errors).toEqual([]);
});
