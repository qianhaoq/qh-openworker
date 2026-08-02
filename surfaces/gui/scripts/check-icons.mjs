import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const icons = readFileSync(resolve(root, "src/app/components/Icon.tsx"), "utf8");
const css = readFileSync(resolve(root, "src/app/design.css"), "utf8");
const appMaster = readFileSync(resolve(root, "src-tauri/icons/app-icon-master.svg"), "utf8");
const trayMaster = readFileSync(resolve(root, "src-tauri/icons/tray-master.svg"), "utf8");

const errors = [];
const pngSize = (path) => {
  const bytes = readFileSync(path);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};
if (!icons.includes('viewBox="0 0 24 24"')) {
  errors.push("product icons must use viewBox 0 0 24 24");
}
if (!trayMaster.includes('viewBox="0 0 24 24"')) errors.push("tray master must use a 24x24 viewBox");
if (!appMaster.includes('viewBox="0 0 1024 1024"')) errors.push("app brand master must use a 1024x1024 viewBox");
// In-product UI stays flat: glass blur is banned outright, and gradients are
// allowed only through the approved brand tokens (--accent-grad, defined in
// design.css) — arbitrary ad-hoc gradients remain an error. The app brand master
// is FINAL 「伴星」 artwork and may use gradients; the tray master is a macOS
// template icon and must stay monochrome (black + alpha only).
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
const cssAdhocGradients = cssNoComments
  .split("\n")
  .filter((line) => !/^\s*--accent-grad(-soft)?:/.test(line))
  .join("\n");
if (/backdrop-filter/i.test(cssNoComments) || /gradient/i.test(cssAdhocGradients))
  errors.push("gradients (outside the --accent-grad brand tokens) and glass blur are not allowed in the QH assistant visual system");
if (/gradient/i.test(trayMaster)) errors.push("tray master must be monochrome (no gradients)");
if (!appMaster.includes("M512 246") || !trayMaster.includes("M12 3.2"))
  errors.push("brand masters must contain the approved empty-helmet geometry");
if (/(?:fill|stroke)=["'](?:#(?:ff[cd][0-9a-f]{3}|ff0)|yellow)/i.test(appMaster + trayMaster))
  errors.push("brand masters must not use the forbidden yellow-black reference palette");
for (const [name, width, height] of [
  ["32x32.png", 32, 32],
  ["128x128.png", 128, 128],
  ["128x128@2x.png", 256, 256],
  ["tray.png", 44, 44],
]) {
  const path = resolve(root, "src-tauri/icons", name);
  if (!existsSync(path)) errors.push(`missing platform icon: ${name}`);
  else if (pngSize(path).join("x") !== `${width}x${height}`) errors.push(`invalid ${name} dimensions`);
}
for (const name of ["icon.icns", "icon.ico"]) {
  const path = resolve(root, "src-tauri/icons", name);
  if (!existsSync(path) || statSync(path).size === 0) errors.push(`missing platform icon: ${name}`);
}
const trayRaw = resolve(root, "src-tauri/icons/tray.rgba");
if (!existsSync(trayRaw) || statSync(trayRaw).size !== 44 * 44 * 4) errors.push("tray.rgba must be exactly 44x44 RGBA");

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("QH assistant icon contract: OK");
