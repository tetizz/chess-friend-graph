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

export async function readPublicJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ASSET_BYTES)
    throw Error(`Invalid public JSON asset: ${path}`);
  const bytes = await readFile(path);
  if (bytes.length !== info.size || bytes.length > MAX_ASSET_BYTES)
    throw Error(`Public JSON asset changed: ${path}`);
  return JSON.parse(bytes.toString("utf8"));
}

export async function gmAssets(directory, generation) {
  if (!/^[a-f0-9]{64}$/.test(generation || ""))
    throw Error("Invalid GM generation.");
  const base = `data/gm/${generation}`;
  for (const name of ["data", "data/gm", base, `${base}/friends`]) {
    const info = await lstat(join(directory, name));
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error(`Invalid GM directory: ${name}`);
  }
  const index = await readPublicJson(join(directory, base, "index.json"));
  const keys = (value, allowed) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))
    )
      throw Error("Unexpected private or invalid GM public fields.");
  };
  const date = (value) => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      return false;
    const normalized = value
      .replace(
        /\.(\d{1,9})Z$/,
        (_, fraction) => `.${fraction.slice(0, 3).padEnd(3, "0")}Z`,
      )
      .replace(/\.000Z$/, "Z");
    return new Date(value).toISOString().replace(/\.000Z$/, "Z") === normalized;
  };
  const url = (value, identity, friends = false) => {
    if (value == null) {
      if (identity) throw Error("Missing GM identity URL.");
      return;
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw Error("Invalid GM public source URL.");
    }
    if (
      typeof value !== "string" ||
      parsed.protocol !== "https:" ||
      !["www.chess.com", "api.chess.com"].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      [...parsed.searchParams.keys()].some(
        (key) =>
          !["page", "order", "sort", "sortby", "filter"].includes(
            key.toLowerCase(),
          ),
      )
    )
      throw Error("Invalid GM public source URL.");
    if (
      identity &&
      (parsed.hostname !== "www.chess.com" ||
        parsed.pathname.toLowerCase() !==
          `/member/${identity.toLowerCase()}${friends ? "/friends" : ""}` ||
        parsed.search)
    )
      throw Error("GM URL identity mismatch.");
  };
  const summary = (list) => {
    if (
      !list ||
      !["complete", "partial", "unknown"].includes(list.status) ||
      list.complete !== (list.status === "complete") ||
      !Number.isSafeInteger(list.enumeratedCount) ||
      list.enumeratedCount < 0 ||
      (list.status === "unknown" && list.enumeratedCount !== 0) ||
      (list.observedAt != null && !date(list.observedAt))
    )
      throw Error("Invalid GM list summary.");
  };
  const count = (value, metadata = false) => {
    keys(value, [
      "value",
      "display",
      "precision",
      ...(metadata ? ["observedAt", "sourceType", "sourceUrl"] : []),
    ]);
    if (
      !["exact", "lower_bound", "unknown"].includes(value.precision) ||
      (value.precision === "unknown"
        ? value.value !== null
        : !Number.isSafeInteger(value.value) || value.value < 0) ||
      (value.display != null && typeof value.display !== "string") ||
      (value.observedAt != null && !date(value.observedAt))
    )
      throw Error("Invalid GM count.");
    url(value.sourceUrl);
    if (
      value.sourceType != null &&
      ![
        "chess_com_mobile_api",
        "chess_com_native_app_ui",
        "chess_com_public_profile_ui",
        "chess_com_website_ui",
      ].includes(value.sourceType)
    )
      throw Error("Invalid GM count source type.");
  };
  keys(index, [
    "schemaVersion",
    "generation",
    "generatedAt",
    "accounts",
    "coverage",
    "roster",
  ]);
  if (!date(index.generatedAt)) throw Error("Invalid GM publication date.");
  if (index.roster !== undefined) {
    keys(index.roster, [
      "sourceUrl",
      "observedAt",
      "lastModified",
      "scope",
      "accounts",
    ]);
    url(index.roster.sourceUrl);
    if (
      (index.roster.observedAt !== null && !date(index.roster.observedAt)) ||
      (index.roster.lastModified !== null &&
        (typeof index.roster.lastModified !== "string" ||
          index.roster.lastModified.length > 2048 ||
          !Number.isFinite(Date.parse(index.roster.lastModified)))) ||
      (index.roster.scope !== null && typeof index.roster.scope !== "string") ||
      (index.roster.accounts !== null &&
        (!Number.isSafeInteger(index.roster.accounts) ||
          index.roster.accounts < 0))
    )
      throw Error("Invalid GM roster provenance.");
  }
  keys(index.coverage, ["completeLists", "partialLists", "unknownLists"]);
  if (
    index.schemaVersion !== 1 ||
    index.generation !== generation ||
    !Array.isArray(index.accounts) ||
    !index.accounts.length
  )
    throw Error("Invalid GM index generation or roster.");
  const names = new Set();
  const coverage = { completeLists: 0, partialLists: 0, unknownLists: 0 };
  for (const account of index.accounts) {
    keys(account, [
      "username",
      "title",
      "profileUrl",
      "friendsUrl",
      "friendCount",
      "friendList",
    ]);
    keys(account.friendList, [
      "status",
      "complete",
      "enumeratedCount",
      "observedAt",
    ]);
    summary(account.friendList);
    count(account.friendCount, true);
    url(account.profileUrl, account.username);
    url(account.friendsUrl, account.username, true);
    coverage[`${account.friendList.status}Lists`]++;
    if (
      typeof account.username !== "string" ||
      !/^[a-z0-9_-]{1,50}$/i.test(account.username) ||
      account.title !== "GM"
    )
      throw Error("Invalid GM roster username.");
    const username = account.username.toLowerCase();
    if (names.has(username)) throw Error("Duplicate GM roster username.");
    names.add(username);
    const detail = await readPublicJson(
      join(directory, base, "friends", `${username}.json`),
    );
    keys(detail, [
      "schemaVersion",
      "generation",
      "username",
      "generatedAt",
      "friendList",
    ]);
    if (
      detail.schemaVersion !== 1 ||
      detail.generation !== generation ||
      detail.username?.toLowerCase() !== username
    )
      throw Error(`GM detail generation or owner mismatch: ${username}`);
    if (
      !date(detail.generatedAt) ||
      Date.parse(detail.generatedAt) > Date.parse(index.generatedAt)
    )
      throw Error("GM detail publication date mismatch.");
    const list = detail.friendList;
    keys(list, [
      "status",
      "complete",
      "enumeratedCount",
      "observedAt",
      "sourceUrl",
      "displayedTotal",
      "friends",
    ]);
    summary(list);
    url(list.sourceUrl);
    if (list.displayedTotal !== null) count(list.displayedTotal);
    if (
      list.complete &&
      (list.displayedTotal?.precision !== "exact" ||
        list.displayedTotal.value !== list.enumeratedCount)
    )
      throw Error("GM complete list total mismatch.");
    if (
      !Array.isArray(list.friends) ||
      list.friends.length !== list.enumeratedCount ||
      ["status", "complete", "enumeratedCount", "observedAt"].some(
        (key) => list[key] !== account.friendList[key],
      )
    )
      throw Error("GM detail summary mismatch.");
    const friends = new Set();
    for (const friend of list.friends) {
      keys(friend, ["username", "title", "profileUrl"]);
      url(friend.profileUrl, friend.username);
      if (
        typeof friend.username !== "string" ||
        !/^[a-z0-9_-]{1,50}$/i.test(friend.username) ||
        (friend.title !== null && typeof friend.title !== "string") ||
        friends.has(friend.username.toLowerCase())
      )
        throw Error("Invalid GM friend row.");
      friends.add(friend.username.toLowerCase());
    }
  }
  if (
    Object.keys(coverage).some((key) => index.coverage[key] !== coverage[key])
  )
    throw Error("GM coverage mismatch.");
  return [
    "gm.html",
    "gm-app.mjs",
    "gm-style.css",
    `${base}/index.json`,
    ...[...names].sort().map((name) => `${base}/friends/${name}.json`),
  ];
}

// Legacy releases without GM metadata retain the original eleven-asset contract.
async function deployAssets(directory) {
  const release = await readPublicJson(join(directory, "release.json"));
  if (!release || typeof release !== "object" || Array.isArray(release))
    throw Error("Invalid release metadata.");
  if (
    release.gmGeneration !== undefined &&
    !/^[a-f0-9]{64}$/.test(release.baseGmGeneration || "")
  )
    throw Error("Invalid base GM release generation.");
  if (
    release.gmGeneration === undefined &&
    release.baseGmGeneration !== undefined
  )
    throw Error("Base GM release requires a public GM generation.");
  if (
    release.publication?.gmGeneration !== undefined &&
    release.publication.gmGeneration !== release.gmGeneration
  )
    throw Error("Conflicting GM release generation.");
  return release.gmGeneration === undefined
    ? [...SITE_ASSETS]
    : [...SITE_ASSETS, ...(await gmAssets(directory, release.gmGeneration))];
}

/** Package only deploy assets, preserving their bytes and fixed ZIP metadata. */
export async function createSiteZip(directory) {
  directory = resolve(directory);
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw Error("Invalid deploy directory.");
  const assets = await deployAssets(directory);
  const allowed = new Set(assets),
    found = new Set();
  const directories = new Set(["data"]);
  for (const name of assets) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++)
      directories.add(parts.slice(0, i).join("/"));
  }
  async function inspect(folder, prefix = "") {
    for (const entry of await readdir(folder)) {
      const name = prefix + entry,
        info = await lstat(join(folder, entry));
      if (info.isSymbolicLink()) throw Error(`Symlink deploy asset: ${name}`);
      if (info.isDirectory()) {
        if (!directories.has(name))
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
  for (const name of assets)
    if (!found.has(name)) throw Error(`Missing deploy asset: ${name}`);
  const files = {},
    originals = new Map();
  for (const name of assets) {
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
  assert.deepEqual(Object.keys(unpacked).sort(), [...assets].sort());
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
        files: Object.keys(files).map((path) => ({
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
    assets: Object.keys(files).length,
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
