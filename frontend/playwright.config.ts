import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PQVIEWER_E2E_PORT ?? 8781);
const baseURL = `http://127.0.0.1:${port}`;
const browserExecutable = process.env.PQVIEWER_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixels: 100,
    },
  },
  outputDir: "../output/playwright/test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  reporter: [
    ["list"],
    ["html", { outputFolder: "../output/playwright/report", open: "never" }],
  ],
  use: {
    baseURL,
    colorScheme: "light",
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        launchOptions: {
          args: ["--enable-webgl", "--use-angle=swiftshader"],
          ...(browserExecutable ? { executablePath: browserExecutable } : {}),
        },
      },
    },
  ],
  webServer: {
    command: `python -m pqviewer.cli examples/periodic-boundary.extxyz --no-open --port ${port}`,
    cwd: "..",
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
