import { mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gmAssets, readPublicJson } from "./package-site.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output"))
  throw Error("Usage: node scripts/build.mjs [--output <directory>]");
const dist = resolve(root, args[1] || "dist");
if (!dist.startsWith(root + "\\") && !dist.startsWith(root + "/"))
  throw new Error("Invalid build destination.");
const assets = new Map([
  ["index.html", "index.html"],
  ["src/style.css", "style.css"],
  ["src/app.mjs", "app.mjs"],
  ["src/model.mjs", "model.mjs"],
  ["src/chart.mjs", "chart.mjs"],
  ["public/favicon.svg", "favicon.svg"],
  ["public/data/dataset.json", "data/dataset.json"],
]);
let gmGeneration;
let baseGmGeneration;
try {
  const pointer = await readPublicJson(
    resolve(root, "public/data/gm/current.json"),
  );
  if (
    pointer.schemaVersion !== 1 ||
    Object.keys(pointer).sort().join() !==
      "baseGmGeneration,generation,schemaVersion" ||
    !/^[a-f0-9]{64}$/.test(pointer.baseGmGeneration || "")
  )
    throw Error("Invalid GM publication pointer.");
  gmGeneration = pointer.generation;
  baseGmGeneration = pointer.baseGmGeneration;
  const selected = await gmAssets(resolve(root, "public"), gmGeneration);
  assets.set("gm.html", "gm.html");
  assets.set("src/gm-app.mjs", "gm-app.mjs");
  assets.set("src/gm-style.css", "gm-style.css");
  for (const name of selected.filter((name) => name.startsWith("data/")))
    assets.set(`public/${name}`, name);
  const expected = new Set(selected.filter((name) => name.startsWith("data/")));
  async function inspectSelected(folder, prefix) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory() && name === `data/gm/${gmGeneration}/friends`)
        await inspectSelected(resolve(folder, entry.name), name + "/");
      else if (!entry.isFile() || !expected.has(name))
        throw Error(`Unexpected GM source asset: ${name}`);
    }
  }
  await inspectSelected(
    resolve(root, `public/data/gm/${gmGeneration}`),
    `data/gm/${gmGeneration}/`,
  );
} catch (error) {
  // No pointer permits the pre-GM transition build; a broken selected publication fails closed.
  if (error.code !== "ENOENT" || gmGeneration !== undefined) throw error;
  const gmRoot = await lstat(resolve(root, "public/data/gm")).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (gmRoot) throw Error("GM data exists without a publication pointer.");
}
const allowed = new Set([
  ...assets.values(),
  "404.html",
  "_headers",
  "robots.txt",
  "release.json",
]);
const allowedDirectories = new Set();
for (const name of allowed) {
  const parts = name.split("/");
  for (let i = 1; i < parts.length; i++)
    allowedDirectories.add(parts.slice(0, i).join("/"));
}
async function checkFiles(directory, prefix = "") {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error("Invalid build directory.");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory() && allowedDirectories.has(relative))
      await checkFiles(resolve(directory, entry.name), relative + "/");
    else if (!entry.isFile() || !allowed.has(relative))
      throw new Error(`Unexpected build output: ${relative}`);
  }
}
try {
  await checkFiles(dist);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const [from, to] of assets) {
  const parts = from.split("/");
  for (let i = 1; i < parts.length; i++) {
    const parent = await lstat(resolve(root, ...parts.slice(0, i)));
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw Error(`Invalid asset directory: ${from}`);
  }
  const source = resolve(root, from);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 25 * 1024 * 1024)
    throw new Error(`Invalid asset: ${from}`);
  await mkdir(dirname(resolve(dist, to)), { recursive: true });
  const bytes = await readFile(source);
  if (bytes.length !== info.size || bytes.length > 25 * 1024 * 1024)
    throw Error(`Build asset changed: ${from}`);
  await writeFile(resolve(dist, to), bytes);
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
  "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n/data/*\n  Cache-Control: no-store\n/release.json\n  Cache-Control: no-store\n",
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
      ...(gmGeneration ? { gmGeneration, baseGmGeneration } : {}),
    },
    null,
    2,
  ) + "\n",
);
await checkFiles(dist);
console.log(
  JSON.stringify({
    built: true,
    accounts: data.accounts.length,
    generation: data.publication.mainGeneration,
    files: allowed.size,
  }),
);
