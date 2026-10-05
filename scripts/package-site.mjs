import assert from "node:assert/strict";
import { lstat, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { zipSync, unzipSync } from "fflate";

export const SITE_ASSETS = Object.freeze([
  "index.html",
  "style.css",
  "app.mjs",
  "model.mjs",
  "chart.mjs",
  "favicon.svg",
  "404.html",
  "_headers",
  "robots.txt",
  "release.json",
  "data/dataset.json",
]);
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Package only deploy assets, preserving their bytes and fixed ZIP metadata. */
export async function createSiteZip(directory) {
  directory = resolve(directory);
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw Error("Invalid deploy directory.");
  const allowed = new Set(SITE_ASSETS),
    found = new Set();
  async function inspect(folder, prefix = "") {
    for (const entry of await readdir(folder)) {
      const name = prefix + entry,
        info = await lstat(join(folder, entry));
      if (info.isSymbolicLink()) throw Error(`Symlink deploy asset: ${name}`);
      if (info.isDirectory()) {
        if (name !== "data")
          throw Error(`Unexpected deploy directory: ${name}`);
        await inspect(join(folder, entry), name + "/");
      } else {
        if (!info.isFile() || !allowed.has(name))
          throw Error(`Unexpected deploy asset: ${name}`);
        if (info.size > MAX_ASSET_BYTES)
          throw Error(`Oversized deploy asset: ${name}`);
        found.add(name);
      }
    }
  }
  await inspect(directory);
  for (const name of SITE_ASSETS)
    if (!found.has(name)) throw Error(`Missing deploy asset: ${name}`);
  const files = {},
    originals = new Map();
  for (const name of SITE_ASSETS) {
    const path = join(directory, name),
      info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ASSET_BYTES)
      throw Error(`Invalid deploy asset: ${name}`);
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.length !== info.size || bytes.length > MAX_ASSET_BYTES)
      throw Error(`Deploy asset changed: ${name}`);
    originals.set(name, bytes);
    files[name] = [bytes, { mtime: new Date(1980, 0, 1), level: 6 }];
  }
  const archive = zipSync(files),
    unpacked = unzipSync(archive);
  assert.deepEqual(Object.keys(unpacked).sort(), [...SITE_ASSETS].sort());
  for (const [name, bytes] of originals)
    assert.deepEqual(unpacked[name], bytes);
  return archive;
}

export async function packageSite({
  sourceDirectory = join(root, "dist"),
  outputDirectory = join(root, "verification"),
} = {}) {
  const archive = await createSiteZip(sourceDirectory);
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error("Invalid package output directory.");
  const suffix = `${Date.now()}-${randomUUID()}`;
  const output = join(directory, `cloudflare-site-${suffix}.zip`);
  const receipt = join(directory, `cloudflare-site-${suffix}.json`);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const sha256 = digest(archive);
  const files = unzipSync(archive);
  await writeFile(output, archive, { flag: "wx" });
  assert.deepEqual(new Uint8Array(await readFile(output)), archive);
  await writeFile(
    receipt,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        output,
        bytes: archive.length,
        sha256,
        files: SITE_ASSETS.map((path) => ({
          path,
          bytes: files[path].length,
          sha256: digest(files[path]),
        })),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  return {
    output,
    bytes: archive.length,
    assets: SITE_ASSETS.length,
    sha256,
    receipt,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 2)
    throw Error("Usage: node scripts/package-site.mjs");
  console.log(JSON.stringify(await packageSite()));
}
