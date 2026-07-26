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
  await expect(page.locator("canvas")).toHaveScreenshot("molecule-scene.png");

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

test("opens display controls and exports a publication PNG", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openPeriodicFixture(page);

  await page.getByRole("button", { name: "Show display controls" }).click();
  const workbench = page.locator("#workbench");
  await expect(workbench).toBeVisible();
  await expect(workbench.getByText("Representation", { exact: true })).toBeVisible();
  await expect(workbench).toHaveScreenshot("view-controls.png");

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
  expect(errors).toEqual([]);
});
