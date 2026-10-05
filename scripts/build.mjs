import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  stat,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
if (!dist.startsWith(root + "\\") && !dist.startsWith(root + "/"))
  throw new Error("Invalid build destination.");
await mkdir(resolve(dist, "data"), { recursive: true });
const assets = new Map([
  ["index.html", "index.html"],
  ["src/style.css", "style.css"],
  ["src/app.mjs", "app.mjs"],
  ["src/model.mjs", "model.mjs"],
  ["src/chart.mjs", "chart.mjs"],
  ["public/favicon.svg", "favicon.svg"],
  ["public/data/dataset.json", "data/dataset.json"],
]);
for (const [from, to] of assets) {
  const source = resolve(root, from);
  const info = await stat(source);
  if (!info.isFile() || info.size > 25 * 1024 * 1024)
    throw new Error(`Invalid asset: ${from}`);
  await copyFile(source, resolve(dist, to));
}
const data = JSON.parse(
  await readFile(resolve(dist, "data/dataset.json"), "utf8"),
);
if (
  data.schemaVersion !== 1 ||
  !Array.isArray(data.accounts) ||
  !data.accounts.length ||
  !Number.isFinite(Date.parse(data.generatedAt)) ||
  !/^[a-f0-9]{64}$/.test(data.publication?.mainGeneration || "")
)
  throw new Error("A selected published dataset is required.");
const html = await readFile(resolve(dist, "index.html"), "utf8");
for (const asset of ["style.css", "app.mjs", "favicon.svg"])
  if (!html.includes(asset)) throw new Error(`HTML is missing ${asset}`);
await writeFile(
  resolve(dist, "404.html"),
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found · Chess Friend Graph</title><link rel="stylesheet" href="/style.css"><body><main class="shell"><h1>This square is empty.</h1><p>The page you requested could not be found.</p><a href="/">Back to the graph →</a></main></body></html>',
);
await writeFile(
  resolve(dist, "_headers"),
  "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n/data/*\n  Cache-Control: public, max-age=300\n",
);
await writeFile(resolve(dist, "robots.txt"), "User-agent: *\nAllow: /\n");
await writeFile(
  resolve(dist, "release.json"),
  JSON.stringify(
    {
      version: 1,
      generatedAt: data.generatedAt,
      publication: data.publication,
      accounts: data.accounts.length,
    },
    null,
    2,
  ) + "\n",
);
const allowed = new Set([
  ...assets.values(),
  "404.html",
  "_headers",
  "robots.txt",
  "release.json",
]);
async function checkFiles(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      await checkFiles(resolve(directory, entry.name), relative + "/");
    else if (!entry.isFile() || !allowed.has(relative))
      throw new Error(`Unexpected build output: ${relative}`);
  }
}
await checkFiles(dist);
console.log(
  JSON.stringify({
    built: true,
    accounts: data.accounts.length,
    generation: data.publication.mainGeneration,
    files: allowed.size,
  }),
);
