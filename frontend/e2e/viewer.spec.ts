import { expect, test, type Locator, type Page } from "@playwright/test";
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
const collisionFixture = path.join(
  repositoryRoot,
  "examples/collision-indicators.xyz",
);
const collisionTopology = path.join(
  repositoryRoot,
  "examples/collision-indicators.topology",
);
const perovskiteFixture = path.join(
  repositoryRoot,
  "examples/strontium-titanate.extxyz",
);
const proteinFixture = path.join(
  repositoryRoot,
  "docs/assets/sources/1CRN.pdb",
);
const polyhedraRequirement =
  "Requires a supported center with 3+ bonded ligands";

function largePeriodicTrajectory(
  frameCount = 120,
  atomCount = 1_000,
): Buffer {
  const side = Math.ceil(Math.cbrt(atomCount));
  const cellLength = side * 4;
  const halfCell = cellLength / 2;
  const lines: string[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    lines.push(
      String(atomCount),
      `Lattice="${cellLength} 0 0 0 ${cellLength} 0 0 0 ${cellLength}" Properties=species:S:1:pos:R:3 pbc="T T T" step=${frame} time=${(frame * 0.5).toFixed(1)}`,
    );
    const shift = frame * 0.41;
    for (let atom = 0; atom < atomCount; atom += 1) {
      const ix = atom % side;
      const iy = Math.floor(atom / side) % side;
      const iz = Math.floor(atom / (side * side));
      const x = ((ix * 4 - halfCell + 2 + shift + halfCell) % cellLength)
        - halfCell;
      const y = iy * 4 - halfCell + 2;
      const z = iz * 4 - halfCell + 2;
      lines.push(`C ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`);
    }
  }
  return Buffer.from(`${lines.join("\n")}\n`);
}

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
  const canvas = page.locator(".molecule-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.locator(".frame-counter")).toHaveAttribute(
    "aria-label",
    "Frame 1 of 2",
  );
  await expect(canvas).toHaveAttribute("data-renderer", "3dmol");
  await expect(canvas).toHaveAttribute("data-atom-count", "4");
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
  const canvas = page.locator(".molecule-canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("data-rendered-manifest", title, {
    timeout: 30_000,
  });
}

async function openFixtureBundle(
  page: Page,
  fixtures: string[],
  title: string,
): Promise<void> {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const chooser = await chooserPromise;
  const openPromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/open")
      && response.request().method() === "POST",
  );
  await chooser.setFiles(fixtures);
  expect((await openPromise).ok()).toBe(true);
  await expect(page).toHaveTitle(`${title} · PQViewer`);
  const canvas = page.locator(".molecule-canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("data-rendered-manifest", title, {
    timeout: 30_000,
  });
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function sceneScreenshot(page: Page, scene: Locator): Promise<Buffer> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const clip = await scene.boundingBox();
  expect(clip).not.toBeNull();
  const viewport = PNG.sync.read(await page.screenshot());
  const left = Math.max(0, Math.floor(clip!.x));
  const top = Math.max(0, Math.floor(clip!.y));
  const right = Math.min(viewport.width, Math.ceil(clip!.x + clip!.width));
  const bottom = Math.min(viewport.height, Math.ceil(clip!.y + clip!.height));
  const cropped = new PNG({
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  });
  PNG.bitblt(
    viewport,
    cropped,
    left,
    top,
    cropped.width,
    cropped.height,
    0,
    0,
  );
  return PNG.sync.write(cropped);
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

function contentMetrics(bytes: Buffer): {
  changed: number;
  bounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null;
  width: number;
  height: number;
} {
  const image = PNG.sync.read(bytes);
  const [red, green, blue, alpha] = image.data;
  let changed = 0;
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let index = 0; index < image.data.length; index += 4) {
    const difference = Math.abs(image.data[index] - red)
      + Math.abs(image.data[index + 1] - green)
      + Math.abs(image.data[index + 2] - blue)
      + Math.abs(image.data[index + 3] - alpha);
    if (difference <= 24) continue;
    const pixel = index / 4;
    const x = pixel % image.width;
    const y = Math.floor(pixel / image.width);
    changed += 1;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return {
    changed,
    bounds: changed > 0 ? { left, top, right, bottom } : null,
    width: image.width,
    height: image.height,
  };
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
  test.slow();
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  await page.getByRole("button", { name: "Last frame" }).click();
  const unwrappedResponse = page.waitForResponse(
    (response) => response.url().includes("/api/frames/1")
      && response.url().includes("coordinates=unwrapped"),
  );
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
    "unwrapped coordinates",
  );
  await page.keyboard.press("Enter");
  expect((await unwrappedResponse).ok()).toBe(true);
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("select oxygen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toContainText("O");

  const figureOptionsButton = page.getByRole("button", {
    name: "Export figure",
    exact: true,
  });
  await figureOptionsButton.click({ force: true });
  const sheet = page.getByRole("dialog", { name: "Export figure" });
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

  await sheet.getByRole("button", { name: "Close export" }).click();
  await page.getByRole("button", { name: "First frame" }).click();
  await page.locator(".selection-bar").getByRole("button", { name: "Clear selection" }).click({ force: true });

  const recipeChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("open figure recipe");
  await page.keyboard.press("Enter");
  await (await recipeChooser).setFiles(firstRecipePath!);
  await expect(page.locator(".notice")).toContainText("Figure recipe restored");
  await expect(page.locator(".frame-counter")).toHaveAttribute("aria-label", "Frame 2 of 2");
  await expect(page.locator(".selection-readout strong")).toContainText("O");

  await figureOptionsButton.click({ force: true });
  await expect(sheet.getByRole("button", { name: "TIFF", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByRole("spinbutton", { name: "Width" })).toHaveValue("1200");
  const secondRecipeDownload = page.waitForEvent("download");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  const secondRecipePath = await (await secondRecipeDownload).path();
  expect(secondRecipePath).not.toBeNull();
  const secondRecipe = JSON.parse((await readFile(secondRecipePath!)).toString("utf8"));
  expect(secondRecipe.frame).toEqual(firstRecipe.frame);
  expect(secondRecipe.scene).toEqual(firstRecipe.scene);
  expect({
    ...secondRecipe.camera,
    up: undefined,
  }).toEqual({
    ...firstRecipe.camera,
    up: undefined,
  });
  secondRecipe.camera.up.forEach((value: number, index: number) => {
    expect(value).toBeCloseTo(firstRecipe.camera.up[index], 12);
  });
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
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
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
  await expect(page.locator(".molecule-canvas"))
    .toHaveAttribute("data-representation", "ball-stick");

  const unsupportedPolyhedraRecipe = structuredClone(firstRecipe);
  unsupportedPolyhedraRecipe.scene.presentation.mode = "polyhedra";
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
    "representation lines",
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".molecule-canvas"))
    .toHaveAttribute("data-representation", "lines");
  const unsupportedPolyhedraChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
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
  await expect(page.locator(".molecule-canvas"))
    .toHaveAttribute("data-representation", "lines");

  const invalidLabelRecipe = structuredClone(firstRecipe);
  invalidLabelRecipe.annotations[0].atom.atom = 99;
  const invalidLabelChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
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
  await expect(page.locator(".timeline")).toHaveAttribute(
    "aria-label",
    "Trajectory controls",
  );
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

test("uses one canonical scientific viewer with editable cell and display controls", async ({
  page,
}) => {
  test.slow();
  const errors = collectBrowserErrors(page);
  await page.goto("/?ui=compare", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("periodic-boundary.extxyz · PQViewer");
  const canvas = page.locator(".molecule-canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("data-renderer", "3dmol");
  await expect(page.locator(".direction-card, .calm-canvas")).toHaveCount(0);
  await expect(page.locator(".molecule-canvas")).toHaveCount(1);

  await page.locator(".task-navigation").getByRole("button", {
    name: "Edit",
    exact: true,
  }).click();
  await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("CH2O", { exact: true })).toBeVisible();
  const lengthA = page.getByRole("spinbutton", { name: "Cell length a" });
  await expect(lengthA).toHaveValue("10");
  await lengthA.fill("11.25");
  await page.getByRole("button", { name: "Apply cell" }).click();
  await expect(page.getByText("Local draft · included in export")).toBeVisible();
  await expect(lengthA).toHaveValue("11.25");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download current frame/ }).click();
  const downloadPath = await (await downloadPromise).path();
  expect(downloadPath).not.toBeNull();
  expect(await readFile(downloadPath!, "utf8")).toContain(
    'Lattice="11.25 0 0 0 10 0 0 0 10"',
  );

  await page.getByRole("button", { name: "Reset local edits" }).click();
  await expect(lengthA).toHaveValue("10");
  await page.getByRole("tab", { name: "View" }).click();
  await page.getByRole("button", { name: "Spacefill" }).click();
  await expect(canvas).toHaveAttribute("data-representation", "spacefill");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");

  await page.setViewportSize({ width: 320, height: 568 });
  const workbenchBox = await page.locator("#workbench").boundingBox();
  expect(workbenchBox).not.toBeNull();
  expect(workbenchBox!.x).toBeGreaterThanOrEqual(0);
  expect(workbenchBox!.x + workbenchBox!.width).toBeLessThanOrEqual(320);
  expect(workbenchBox!.y + workbenchBox!.height).toBeLessThanOrEqual(568);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

  expect(errors).toEqual([]);
});

test("edits selected atom identity and current-frame coordinates", async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  const canvas = page.locator(".molecule-canvas");
  await canvas.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Analyze" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "Edit atom" }).click();
  await page.getByRole("combobox", { name: "Atom element" }).fill("N");
  await page.getByRole("spinbutton", { name: "Atom x coordinate" }).fill("4.25");
  await page.getByRole("button", { name: "Apply atom" }).click();
  await expect(page.locator("#workbench-title")).toHaveText("Edit N · 1");
  await expect(
    page.getByRole("spinbutton", { name: "Atom x coordinate" }),
  ).toHaveValue("4.25");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Cell + structure" }).click();
  await page.getByRole("button", { name: /Download current frame/ }).click();
  const downloadPath = await (await downloadPromise).path();
  expect(downloadPath).not.toBeNull();
  expect(await readFile(downloadPath!, "utf8")).toContain("N 4.25 0 0");
  expect(errors).toEqual([]);
});

test("keeps command search central and keyboard accessible", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  const button = page.getByRole("button", { name: "Search atoms, settings, and commands" });
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x + box!.width / 2 - 640)).toBeLessThanOrEqual(1);
  const title = await button.getAttribute("title");
  expect(title).toMatch(/⌘K|Ctrl K/);
  const appleShortcut = title?.includes("⌘") ?? false;

  await page.keyboard.press(
    appleShortcut ? "Meta+K" : "Control+K",
  );
  const search = page.getByRole("combobox", { name: "Search atoms, settings, and commands" });
  await expect(search).toBeFocused();
  await search.fill("fit structure");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);

  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await search.fill("bond across cell");
  await expect(page.getByRole("option", { name: /Bond display/ }))
    .toContainText("View › Layers › Bonds");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "View" }))
    .toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-setting-id="view-bonds"]'))
    .toHaveClass(/is-search-target/);
  await page.locator("#workbench").getByRole("button", {
    name: "Close",
    exact: true,
  }).click();

  await page.keyboard.press("/");
  await search.fill("edit lattice vectors");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Edit" }))
    .toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Vectors" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-setting-id="edit-cell-vectors"]'))
    .toBeFocused();
  await page.locator("#workbench").getByRole("button", {
    name: "Close",
    exact: true,
  }).click();

  await page.keyboard.press("/");
  await search.fill("transparent image");
  await page.keyboard.press("Enter");
  const exportDialog = page.getByRole("dialog", { name: "Export figure" });
  await expect(exportDialog).toBeVisible();
  await expect(exportDialog.locator('[data-setting-id="export-background"]'))
    .toHaveClass(/is-search-target/);
  await exportDialog.getByRole("button", { name: "Close export" }).click();

  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);
  await page.keyboard.press(appleShortcut ? "Meta+K" : "Control+K");
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
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
  await expect(page.locator(".molecule-canvas")).toBeVisible();
  expect(errors).toEqual([]);
});

test("supports pointer and keyboard measurement with linked playback", async ({ page }) => {
  test.slow();
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  const canvas = page.locator(".molecule-canvas");
  await canvas.click({ position: { x: 795, y: 389 }, force: true });
  await expect(page.locator(".selection-readout strong")).toBeVisible();

  await page.locator(".selection-bar").getByRole("button", { name: "Clear selection" }).click({ force: true });
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

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("select oxygen");
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
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
    "displacement from reference",
  );
  await page.keyboard.press("Enter");
  expect((await displacementPositions).ok()).toBe(true);

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
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

  const canvas = page.locator(".molecule-canvas");
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
  test.slow();
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("select oxygen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("O2");

  await page.locator(".selection-tools > summary").click();
  await page.getByRole("button", { name: "Component", exact: true }).click();
  await expect(page.locator(".selection-readout strong")).toHaveText("CO · 2 atoms");

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("select oxygen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("O2");

  await page.locator(".selection-tools > summary").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".selection-tools")).not.toHaveAttribute("open", "");
  await expect(page.locator(".selection-readout strong")).toHaveText("O2");
  await page.locator(".selection-tools > summary").click();
  await page.getByPlaceholder("e.g. active site").fill("boundary oxygen");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".selection-bar").getByRole("button", { name: "Clear selection" }).click();

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("boundary oxygen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("O2");

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
    "select within 5 A of selection",
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("H2O · 3 atoms");

  await page.locator(".selection-bar").getByRole("button", { name: "Clear selection" }).click();
  const canvas = page.locator(".molecule-canvas");
  await canvas.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
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

  await page.locator(".selection-bar").getByRole("button", { name: "Clear selection" }).click();
  await pinSummary.click({ force: true });
  await expect(pin).toBeVisible();
  await pin.click({ force: true });
  await expect(page.locator(".selection-readout strong")).toContainText("Distance");
  expect(errors).toEqual([]);
});

test("supports box selection and large-selection summaries", async ({ page }) => {
  test.slow();
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  const canvas = page.locator(".molecule-canvas");
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

  await page.locator(".selection-bar").getByRole("button", { name: "Clear selection" }).click();
  await page.keyboard.down("Shift");
  await page.mouse.move(bounds!.x + 900, bounds!.y + 510);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 350, bounds!.y + 110, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator(".selection-readout strong")).toHaveText("CH2O · 4 atoms");

  await page.locator(".selection-bar").getByRole("button", { name: "Clear selection" }).click();
  await page.locator(".task-navigation").getByRole("button", {
    name: "View",
    exact: true,
  }).click();
  await page.locator(".periodic-settings > summary").click();
  for (const axis of ["a", "b", "c"]) {
    await page.getByRole("button", { name: `Increase ${axis} repeats` }).click();
    await page.getByRole("button", { name: `Increase ${axis} repeats` }).click();
  }
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("select hydrogen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toContainText("H2 · 54 atoms");
  for (const axis of ["a", "b", "c"]) {
    await page.getByRole("button", { name: `Decrease ${axis} repeats` }).click({ force: true });
    await page.getByRole("button", { name: `Decrease ${axis} repeats` }).click({ force: true });
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

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("select water");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("H2O · 3 atoms");
  await expect(page.locator(".selection-readout")).not.toContainText("Angle");
  await expect(page.getByRole("button", { name: "Pin", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("select oxygen");
  await page.keyboard.press("Enter");
  const oxygenIdentity = await page.locator(".selection-readout strong").textContent();
  expect(oxygenIdentity).toContain("O1");

  await page.locator(".task-navigation").getByRole("button", {
    name: "View",
    exact: true,
  }).click();
  await page.locator(".periodic-settings > summary").click();
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("source coordinates");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText(oxygenIdentity!);
  await page.getByRole("button", { name: "Atoms", exact: true }).click();
  await expect(page.locator(".selection-readout strong")).toHaveText(oxygenIdentity!);
  expect(errors).toEqual([]);
});

test("renders force and collision indicators", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  const scene = page.locator(".molecule-canvas");
  if (await scene.getAttribute("data-force-count") !== "0") {
    await page.keyboard.press("f");
  }
  await expect(scene).toHaveAttribute("data-force-count", "0");
  const withoutForces = await sceneScreenshot(page, scene);
  await page.keyboard.press("f");
  await expect(scene).toHaveAttribute("data-force-count", "4");
  await expect.poll(
    async () => differentPixelCount(
      withoutForces,
      await sceneScreenshot(page, scene),
    ),
  ).toBeGreaterThan(150);

  await openFixtureBundle(
    page,
    [collisionFixture, collisionTopology],
    "collision-indicators.xyz",
  );
  await expect(scene).toHaveAttribute("data-bond-count", "1");
  await expect(scene).toHaveAttribute("data-collision-count", "1");
  expect(changedPixelCount(await sceneScreenshot(page, scene))).toBeGreaterThan(500);
  expect(errors).toEqual([]);
});

test("opens display controls and exports a publication PNG", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  await page.locator(".task-navigation").getByRole("button", { name: "View", exact: true }).click();
  const workbench = page.locator("#workbench");
  await expect(workbench).toBeVisible();
  await expect(workbench.locator(".profile-settings")).toHaveCount(0);
  await expect(workbench.getByText("Representation", { exact: true })).toBeVisible();
  await expect(workbench.getByText("Layers", { exact: true })).toBeVisible();
  await workbench.locator(".periodic-settings > summary").click();
  await expect(workbench.getByText("Coordinates", { exact: true })).toBeVisible();
  await expect(workbench.getByText("Center cell", { exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export figure", exact: true }).click();
  await page.getByRole("dialog", { name: "Export figure" })
    .getByRole("button", { name: "Export PNG" }).click();
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

test("fits and exports a publication Ribbon for 1CRN", async ({ page }) => {
  test.slow();
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  await openFixture(page, proteinFixture, "1CRN.pdb");

  const canvas = page.locator(".molecule-canvas");
  await page.locator(".task-navigation").getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("button", {
    name: "Ribbon",
    exact: true,
  })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await expect(canvas).toHaveAttribute("data-representation", "ribbon", {
    timeout: 30_000,
  });
  await expect.poll(
    async () => {
      const bounds = contentMetrics(await sceneScreenshot(page, canvas)).bounds;
      return bounds
        ? Math.min(bounds.right - bounds.left + 1, bounds.bottom - bounds.top + 1)
        : 0;
    },
    { timeout: 30_000 },
  ).toBeGreaterThan(140);
  await page.getByRole("toolbar", {
    name: "Camera controls",
  }).getByRole("button", {
    name: "Fit",
    exact: true,
  }).click();
  const fitted = contentMetrics(await sceneScreenshot(page, canvas));

  await canvas.hover();
  await page.mouse.wheel(0, 1800);
  await expect.poll(
    async () => contentMetrics(await sceneScreenshot(page, canvas)).changed,
  ).toBeLessThan(fitted.changed * 0.75);
  const zoomedOut = contentMetrics(await sceneScreenshot(page, canvas));
  await page.getByRole("toolbar", {
    name: "Camera controls",
  }).getByRole("button", {
    name: "Fit",
    exact: true,
  }).click();
  await expect.poll(
    async () => contentMetrics(await sceneScreenshot(page, canvas)).changed,
    { timeout: 30_000 },
  ).toBeGreaterThan(fitted.changed * 0.8);

  const restored = contentMetrics(await sceneScreenshot(page, canvas));
  expect(restored.changed).toBeGreaterThan(zoomedOut.changed * 1.1);

  await canvas.focus();
  await page.keyboard.press("Enter");
  const selectionReadout = page.locator(".selection-readout strong");
  await expect(selectionReadout).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(selectionReadout).toContainText("Distance");

  await page.getByRole("button", {
    name: "Export figure",
    exact: true,
  }).click({ force: true });
  const figureSheet = page.locator("#figure-sheet");
  await figureSheet.getByRole("spinbutton", { name: "Width" }).fill("800");
  await figureSheet.getByRole("spinbutton", { name: "Height" }).fill("600");
  await expect(figureSheet).toContainText("800 × 600 px");

  const downloadPromise = page.waitForEvent("download");
  await figureSheet.getByRole("button", {
    name: "Export PNG",
    exact: true,
  }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("1CRN-800x600.png");
  const file = await download.path();
  expect(file).not.toBeNull();
  const png = await readFile(file!);
  const publication = contentMetrics(png);
  expect([publication.width, publication.height]).toEqual([800, 600]);
  expect(publication.bounds).not.toBeNull();
  const margins = [
    publication.bounds!.left,
    publication.bounds!.top,
    publication.width - publication.bounds!.right - 1,
    publication.height - publication.bounds!.bottom - 1,
  ];
  for (const margin of margins) expect(margin).toBeGreaterThanOrEqual(24);
  const contentWidth = publication.bounds!.right - publication.bounds!.left + 1;
  const contentHeight = publication.bounds!.bottom - publication.bounds!.top + 1;
  const occupancy = contentWidth * contentHeight
    / (publication.width * publication.height);
  expect(occupancy).toBeGreaterThan(0.3);
  expect(occupancy).toBeLessThan(0.8);
  expect(publication.changed / (publication.width * publication.height))
    .toBeGreaterThan(0.025);
  expect(errors).toEqual([]);
});

test("disables unsupported polyhedra with an explicit reason", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
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

test("renders complete perovskite polyhedra and clips boundary bonds", async ({
  page,
}) => {
  test.slow();
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  await openFixture(
    page,
    perovskiteFixture,
    "strontium-titanate.extxyz",
  );

  const canvas = page.locator(".molecule-canvas");
  await expect(canvas).toHaveAttribute("data-representation", "polyhedra", {
    timeout: 30_000,
  });
  await expect(canvas).toHaveAttribute("data-polyhedron-count", "8");
  await expect(canvas).toHaveAttribute("data-rendered-boundary-bond-count", "0");
  expect(Number(await canvas.getAttribute("data-boundary-bond-count")))
    .toBeGreaterThan(0);
  const polyhedra = await sceneScreenshot(page, canvas);

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
    "ball + stick",
  );
  await page.getByRole("option", {
    name: /Representation · Ball \+ stick/,
  }).click();
  await expect(canvas).toHaveAttribute("data-representation", "ball-stick");
  await expect(canvas).toHaveAttribute("data-rendered-boundary-bond-count", "0");
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
    "show bonds",
  );
  await page.keyboard.press("Enter");
  await expect.poll(
    async () => Number(await canvas.getAttribute("data-bond-count")),
  ).toBeGreaterThan(0);
  await expect(canvas).toHaveAttribute("data-rendered-boundary-bond-count", "0");
  await expect.poll(
    async () => differentPixelCount(polyhedra, await sceneScreenshot(page, canvas)),
  ).toBeGreaterThan(2_000);

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
    "polyhedra",
  );
  await page.getByRole("option", {
    name: /Representation · Polyhedra/,
  }).click();
  await expect(canvas).toHaveAttribute("data-polyhedron-count", "8");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export figure", exact: true }).click();
  await page.getByRole("dialog", { name: "Export figure" })
    .getByRole("button", { name: "Export PNG" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "strontium-titanate-2400x1800.png",
  );
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
  test.slow();
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  await openFixture(page, crossingFixture, "periodic-crossing.extxyz");

  await page.locator(".task-navigation").getByRole("button", { name: "View", exact: true }).click();
  await page.locator(".periodic-settings > summary").click();
  await expect(page.getByRole("button", { name: "PQ", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Selection", exact: true })).toBeDisabled();

  const periodicSettings = page.locator(".periodic-settings");
  await periodicSettings.getByRole("button", { name: "Structure", exact: true }).click();
  await expect(periodicSettings.getByRole("button", {
    name: "Structure",
    exact: true,
  })).toHaveAttribute("aria-pressed", "true");
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

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("reset periodic");
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
  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("select carbon");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-readout strong")).toHaveText("C1 (+a)");
  await expect(page.locator(".selection-readout output")).toHaveText("5.2 0.1 0");
  expect(errors).toEqual([]);
});

test("recovers when unwrapped coordinates cannot be loaded", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  await page.locator(".task-navigation").getByRole("button", { name: "View", exact: true }).click();
  await page.locator(".periodic-settings > summary").click();
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
  await expect(page.locator(".task-navigation").getByRole("button", { name: "View", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Export figure", exact: true })).toBeEnabled();
  await expect(page.locator(".molecule-canvas")).toBeVisible();
  expect(errors.filter((error) => !error.includes("status of 500"))).toEqual([]);
});

test("keeps a triclinic framework centered under display stress", async ({ page }) => {
  test.slow();
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  await openFixture(page, acofFixture, "acof-triclinic.xyz");

  const canvas = page.locator(".molecule-canvas");
  await expect(page.locator(".frame-counter")).toHaveAttribute(
    "aria-label",
    "Frame 1 of 4",
  );
  await expect(canvas).toHaveAttribute("data-render-ms", /\d/);
  expect(changedPixelCount(await sceneScreenshot(page, canvas)))
    .toBeGreaterThan(5_000);
  await page.locator(".task-navigation").getByRole("button", { name: "View", exact: true }).click();
  await page.locator(".periodic-settings > summary").click();
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

  await page.locator(".task-navigation").getByRole("button", { name: "View", exact: true }).click();
  await page.locator(".periodic-settings > summary").click();
  await page.getByRole("button", { name: "Mirror c", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export figure", exact: true }).click();
  await page.getByRole("dialog", { name: "Export figure" })
    .getByRole("button", { name: "Export PNG" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("acof-triclinic-2400x1800.png");
  const file = await download.path();
  expect(file).not.toBeNull();
  const png = await readFile(file!);
  expect(changedPixelCount(png)).toBeGreaterThan(50_000);
  expect(errors).toEqual([]);
});

test("streams a large periodic trajectory with bounded frame latency", async ({
  page,
}, testInfo) => {
  test.slow();
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);
  const frameCount = 120;
  const atomCount = 1_000;
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const openPromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/open")
      && response.request().method() === "POST",
  );
  await (await chooserPromise).setFiles({
    name: "large-periodic-trajectory.extxyz",
    mimeType: "chemical/x-xyz",
    buffer: largePeriodicTrajectory(frameCount, atomCount),
  });
  expect((await openPromise).ok()).toBe(true);
  await expect(page).toHaveTitle(
    "large-periodic-trajectory.extxyz · PQViewer",
  );

  const canvas = page.locator(".molecule-canvas");
  const counter = page.locator(".frame-counter");
  const slider = page.getByRole("slider", { name: "Frame" });
  await expect(canvas).toHaveAttribute("data-atom-count", String(atomCount), {
    timeout: 30_000,
  });
  await expect(counter).toHaveAttribute(
    "aria-label",
    `Frame 1 of ${frameCount}`,
  );

  const targets = [119, 0, 61, 17, 98, 3, 76, 42, 118, 1, 89, 24];
  const latencies: number[] = [];
  const renderTimes: number[] = [];
  for (const target of targets) {
    const started = performance.now();
    await slider.evaluate((element, value) => {
      const input = element as HTMLInputElement;
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, String(target));
    await expect(counter).toHaveAttribute(
      "aria-label",
      `Frame ${target + 1} of ${frameCount}`,
      { timeout: 30_000 },
    );
    await expect(canvas).toHaveAttribute(
      "data-source-frame-index",
      String(target),
      { timeout: 30_000 },
    );
    latencies.push(performance.now() - started);
    renderTimes.push(Number(await canvas.getAttribute("data-render-ms")));
  }

  const orderedLatencies = [...latencies].sort((left, right) => left - right);
  const p95Latency = orderedLatencies[
    Math.ceil(orderedLatencies.length * 0.95) - 1
  ];
  const maxRenderTime = Math.max(...renderTimes);
  await testInfo.attach("large-trajectory-performance.json", {
    body: Buffer.from(JSON.stringify({
      atomCount,
      frameCount,
      targets,
      frameLatencyMs: latencies,
      p95LatencyMs: p95Latency,
      renderMs: renderTimes,
      maxRenderMs: maxRenderTime,
    }, null, 2)),
    contentType: "application/json",
  });
  console.log(
    `Large trajectory · ${atomCount} atoms × ${frameCount} frames · `
    + `p95 ${p95Latency.toFixed(1)} ms · max render ${maxRenderTime.toFixed(1)} ms`,
  );
  expect(p95Latency).toBeLessThan(2_500);
  expect(maxRenderTime).toBeLessThan(1_000);
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
  const mobileSearch = page.getByRole("button", {
    name: "Search atoms, settings, and commands",
  });
  const mobileSearchBox = await mobileSearch.boundingBox();
  expect(mobileSearchBox).not.toBeNull();
  expect(Math.abs(mobileSearchBox!.x + mobileSearchBox!.width / 2 - 160))
    .toBeLessThanOrEqual(16);
  for (const control of [
    page.getByRole("button", { name: "Open viewer tools" }),
    page.getByRole("button", { name: "Export figure" }),
    page.getByRole("button", { name: "Help and keyboard shortcuts" }),
  ]) {
    await expect(control).toBeVisible();
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  }
  const timeline = page.getByRole("region", { name: "Trajectory controls" });
  const timelineBox = await timeline.boundingBox();
  expect(timelineBox).not.toBeNull();
  expect(timelineBox!.x).toBeGreaterThanOrEqual(0);
  expect(timelineBox!.x + timelineBox!.width).toBeLessThanOrEqual(320);
  await expect(timeline.getByRole("slider", { name: "Frame" })).toBeVisible();
  for (const control of [
    timeline.getByRole("button", { name: "Previous frame" }),
    timeline.getByRole("button", { name: "Play" }),
    timeline.getByRole("button", { name: "Next frame" }),
    timeline.locator('summary[aria-label="Playback options"]'),
  ]) {
    await expect(control).toBeVisible();
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  }

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

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
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

  await page.getByRole("button", { name: "Open viewer tools" }).click();
  await page.getByRole("button", { name: "Expand tools" }).click();
  await page.waitForTimeout(220);
  const expandedWorkbench = await page.locator("#workbench").boundingBox();
  const mobileTimeline = await page.locator(".timeline").boundingBox();
  expect(expandedWorkbench).not.toBeNull();
  expect(mobileTimeline).not.toBeNull();
  expect(expandedWorkbench!.y).toBeGreaterThanOrEqual(48);
  expect(expandedWorkbench!.y).toBeLessThanOrEqual(52);
  expect(expandedWorkbench!.y + expandedWorkbench!.height)
    .toBeLessThanOrEqual(mobileTimeline!.y + 2);
  await page.getByRole("button", { name: "Collapse tools" }).click();
  await page.locator(".periodic-settings > summary").click();
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
  await page.locator("#workbench").getByRole("button", {
    name: "Close",
    exact: true,
  }).click();

  const compactFigureOptionsButton = page.getByRole("button", {
    name: "Export figure",
    exact: true,
  });
  await compactFigureOptionsButton.click();
  const figureSheet = page.getByRole("dialog", { name: "Export figure" });
  await expect(figureSheet).toBeVisible();
  expect(await page.locator(".topbar").evaluate((element) => (
    (element as HTMLElement).inert
  ))).toBe(false);
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

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill("select oxygen");
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

  await page.locator(".selection-bar").getByRole("button", { name: "Clear selection" }).click();
  const canvas = page.locator(".molecule-canvas");
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

test("truncates long filenames at 320 px without losing the full name", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await openPeriodicFixture(page);
  const name = "periodic-production-trajectory-with-a-deliberately-long-scientific-filename.extxyz";
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const openPromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/open")
      && response.request().method() === "POST",
  );
  await (await chooserPromise).setFiles({
    name,
    mimeType: "chemical/x-xyz",
    buffer: await readFile(periodicFixture),
  });
  expect((await openPromise).ok()).toBe(true);
  await expect(page).toHaveTitle(`${name} · PQViewer`);
  const label = page.locator(".identity span");
  await expect(label).toHaveAttribute("title", name);
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
  const labelBox = await label.boundingBox();
  if (labelBox) expect(labelBox.width).toBeLessThan(170);
  else await expect(label).toBeHidden();
  expect(errors).toEqual([]);
});

test("keeps camera controls live in the Export inspector", async ({ page }) => {
  test.slow();
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 720, height: 800 },
    { width: 320, height: 568 },
    { width: 320, height: 480 },
    { width: 568, height: 320 },
  ]) {
    await test.step(`${viewport.width} × ${viewport.height}`, async () => {
      await page.setViewportSize(viewport);
      const figureOptionsButton = page.getByRole("button", {
        name: "Export figure",
        exact: true,
      });
      await figureOptionsButton.click();

      const figureSheet = page.locator("#figure-sheet");
      const cameraControls = page.getByRole("toolbar", {
        name: "Camera controls",
      });
      const timeline = page.getByRole("region", {
        name: "Trajectory controls",
      });
      await expect(figureSheet).toBeVisible();
      await expect(cameraControls).toBeVisible();
      await expect(timeline).toBeVisible();
      await expect(figureSheet).not.toHaveAttribute("aria-modal");
      await expect(page.locator(".figure-sheet-backdrop")).toHaveCount(0);

      for (const name of ["Fit", "3D", "XY", "XZ", "YZ"]) {
        const button = cameraControls.getByRole("button", {
          name,
          exact: true,
        });
        await expect(button).toBeVisible();
        await expect(button).toBeEnabled();
        await expect.poll(async () => {
          const currentBox = await button.boundingBox();
          if (!currentBox) return false;
          return page.evaluate(
            ({ x, y, label }) => {
              const hit = document.elementFromPoint(x, y);
              return hit?.closest("button")?.textContent?.trim() === label
                && hit?.closest('[role="toolbar"]')
                  ?.getAttribute("aria-label") === "Camera controls";
            },
            {
              x: currentBox.x + currentBox.width / 2,
              y: currentBox.y + currentBox.height / 2,
              label: name,
            },
          );
        }, {
          message: `${name} must receive pointer input`,
        }).toBe(true);
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
        await button.click();
        await expect(figureSheet).toBeVisible();
      }

      const controlsBox = await cameraControls.boundingBox();
      const sheetBox = await figureSheet.boundingBox();
      expect(controlsBox).not.toBeNull();
      expect(sheetBox).not.toBeNull();
      const bottomSheet = viewport.width <= 719
        && !(viewport.width >= 480 && viewport.height <= 520);
      if (bottomSheet) {
        expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(
          sheetBox!.y,
        );
      } else {
        expect(controlsBox!.x + controlsBox!.width).toBeLessThanOrEqual(
          sheetBox!.x,
        );
      }

      const xy = cameraControls.getByRole("button", {
        name: "XY",
        exact: true,
      });
      await xy.click();
      await expect(xy).toHaveAttribute("aria-pressed", "true");
      await expect(figureSheet).toBeVisible();

      const playbackOptions = page.locator(".timeline-options > summary");
      await expect(playbackOptions).toBeVisible();
      await expect(playbackOptions).toHaveAttribute(
        "aria-label",
        "Playback options",
      );
      const playbackBox = await playbackOptions.boundingBox();
      expect(playbackBox).not.toBeNull();
      expect(await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)
          ?.closest("summary")
          ?.getAttribute("aria-label"),
        {
          x: playbackBox!.x + playbackBox!.width / 2,
          y: playbackBox!.y + playbackBox!.height / 2,
        },
      )).toBe("Playback options");
      await playbackOptions.click();
      await expect(page.locator(".timeline-options")).toHaveAttribute("open", "");
      await expect(figureSheet).toBeVisible();
      await playbackOptions.click();

      const forward = page.getByRole("button", {
        name: viewport.width > 600 ? "Last frame" : "Next frame",
      });
      const backward = page.getByRole("button", {
        name: viewport.width > 600 ? "First frame" : "Previous frame",
      });
      await forward.click();
      await expect(page.locator(".frame-counter")).toHaveAttribute(
        "aria-label",
        "Frame 2 of 2",
      );
      await backward.click();
      await expect(page.locator(".frame-counter")).toHaveAttribute(
        "aria-label",
        "Frame 1 of 2",
      );
      await expect(figureSheet).toBeVisible();

      await figureSheet.getByRole("button", {
        name: "Close export",
      }).click();
      await expect(figureSheet).toBeHidden();
      await expect(figureOptionsButton).toBeFocused();
    });
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  const figureOptionsButton = page.getByRole("button", {
    name: "Export figure",
    exact: true,
  });
  await figureOptionsButton.click();
  await expect(figureOptionsButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", {
    name: "Help and keyboard shortcuts",
  })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Fit", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const keyboardXy = page.getByRole("button", { name: "XY", exact: true });
  await expect(keyboardXy).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(keyboardXy).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#figure-sheet")).toBeVisible();

  const canvasBox = await page.locator(".molecule-canvas").boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.tagName,
    {
      x: canvasBox!.x + canvasBox!.width / 2,
      y: canvasBox!.y + canvasBox!.height / 2,
    },
  )).toBe("CANVAS");

  await page.locator("#figure-sheet").getByRole("button", {
    name: "Square",
  }).focus();
  await page.keyboard.press("Escape");
  await expect(figureOptionsButton).toBeFocused();

  const commandButton = page.getByRole("button", { name: "Search atoms, settings, and commands" });
  await commandButton.click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
    "export figure",
  );
  await page.keyboard.press("Enter");
  await expect(page.locator("#figure-sheet")).toBeVisible();
  await page.locator("#figure-sheet").getByRole("button", {
    name: "Close export",
  }).click();
  await expect(commandButton).toBeFocused();

  await figureOptionsButton.click();
  await page.locator(".task-navigation").getByRole("button", { name: "View", exact: true }).click();
  await expect(page.locator("#figure-sheet")).toHaveCount(0);
  await expect(page.locator("#workbench")).toBeVisible();
  await expect(page.locator("#workbench")).toBeFocused();

  expect(errors).toEqual([]);
});

test("keeps study sheets reachable in short landscape", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 568, height: 320 });
  await openPeriodicFixture(page);

  await page.getByRole("button", { name: "Search atoms, settings, and commands" }).click();
  await page.getByRole("combobox", { name: "Search atoms, settings, and commands" }).fill(
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

  const canvas = page.locator(".molecule-canvas");
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
