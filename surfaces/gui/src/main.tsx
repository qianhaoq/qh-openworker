import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { initTheme } from "./theme";
import { isTauri, platformOS } from "./tauri";
import "./tailwind.css";
import "./app/design.css";

initTheme();
// Platform hook for CSS (html[data-platform="windows"] scrollbar styling etc.).
document.documentElement.dataset.platform = platformOS();
// macOS desktop shell uses an overlay title bar: traffic lights float over the top-left
// of the UI. The class lets CSS clear them (sidebar) and marks drag regions as active.
if (isTauri() && platformOS() === "macos") {
  document.documentElement.classList.add("tauri-overlay");
}

// A file dropped OUTSIDE a drop target (the composer) must never navigate the webview to the
// file itself — the browser/WKWebView default. Drop targets stopPropagation-free preventDefault
// in their own handlers; these guards only catch the misses. (The desktop shell disables Tauri's
// native drag-drop interception so HTML5 drag events reach the DOM at all — see lib.rs.)
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
