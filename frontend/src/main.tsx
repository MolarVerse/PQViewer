import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-ext-500.css";
import "@fontsource/inter/latin-ext-600.css";
import "@fontsource/inter/latin-ext-700.css";
import "@fontsource/inter/greek-400.css";
import "@fontsource/inter/greek-500.css";
import "@fontsource/inter/greek-600.css";
import "@fontsource/inter/greek-700.css";
import App from "./App";
import "@molarverse/pq-design/styles.css";
import "./styles.css";
import "./pq-flatmono-preview.css";

// Draft flat-mono preview: the language is Gray-10 light-only, so the
// preview locks the viewer to its light appearance before first render.
// Otherwise a dark scene + light chrome mix (the "ugly" state). Revert by
// deleting this block together with the preview css import above.
try {
  window.localStorage.setItem("pqviewer-appearance", "light");
  document.documentElement.dataset.appearance = "light";
  document.documentElement.style.colorScheme = "light";
} catch {
  /* private mode: App falls back to media query, preview css still applies */
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
