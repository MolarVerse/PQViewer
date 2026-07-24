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
  await expect(page.locator(".pinned-measurements > div")).toHaveCount(8);
  const pinsBox = await page.locator(".pinned-measurements").boundingBox();
  const currentSelectionBox = await page.locator(".selection-bar").boundingBox();
  expect(pinsBox).not.toBeNull();
  expect(currentSelectionBox).not.toBeNull();
  expect(pinsBox!.y + pinsBox!.height).toBeLessThan(currentSelectionBox!.y);
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
