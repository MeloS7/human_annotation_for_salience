import { build } from "esbuild";
import { mkdir, readFile, readdir, copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
const assets = ["index.html", "app.css", "source-display.js", "source-layouts.js"];
const allowedOutput = new Set([...assets, "backend.js", "config.js", ".nojekyll"]);

await mkdir(output, { recursive: true });
// Do not publish an accidental bundle/seed/database left in an existing dist.
for (const name of await readdir(output)) {
  if (!allowedOutput.has(name)) throw new Error(`Unexpected deployment file: ${name}`);
}
for (const name of assets) {
  await copyFile(path.join(root, "web", name), path.join(output, name));
}
await copyFile(path.join(root, "config/public-config.js"), path.join(output, "config.js"));
await build({
  entryPoints: [path.join(root, "web/backend.js")],
  outfile: path.join(output, "backend.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
  legalComments: "inline",
  minify: true,
  logLevel: "warning"
});
await writeFile(path.join(output, ".nojekyll"), "");
const html = await readFile(path.join(output, "index.html"), "utf8");
if (/\b(?:src|href)=["']\/(?!\/)/.test(html)) {
  throw new Error("Root-absolute asset paths break project GitHub Pages URLs.");
}
console.log("Built code-only GitHub Pages assets in dist/.");
