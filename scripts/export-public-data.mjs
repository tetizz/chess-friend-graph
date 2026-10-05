import assert from "node:assert/strict";
import {
  readFile,
  stat,
  realpath,
  mkdir,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, dirname, join, relative, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const MAX_EXPORT = 25 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
const safeFile = (name) =>
  typeof name === "string" &&
  /^(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+$/.test(name) &&
  !name.split("/").some((x) => x === "." || x === "..");
async function bounded(path, limit) {
  if ((await stat(path)).size > limit)
    throw Error("Input exceeds its size limit.");
  const bytes = await readFile(path);
  if (bytes.length > limit) throw Error("Input grew beyond its size limit.");
  return bytes;
}
async function contained(root, path) {
  const actual = await realpath(path),
    delta = relative(root, actual);
  if (
    !delta ||
    isAbsolute(delta) ||
    delta === ".." ||
    delta.startsWith(".." + (process.platform === "win32" ? "\\" : "/"))
  )
    throw Error("Publication file escapes source.");
  return actual;
}
function publicMeasurement(input, { display = false, source = false } = {}) {
  const result = { value: input.value, precision: input.precision };
  if (
    display &&
    typeof input.display === "string" &&
    input.display.length <= 80
  )
    result.display = input.display;
  if (date(input.observedAt)) result.observedAt = input.observedAt;
  if (date(input.lastRatedGameAt))
    result.lastRatedGameAt = input.lastRatedGameAt;
  if (
    source &&
    [
      "chess_com_mobile_api",
      "chess_com_native_app_ui",
      "chess_com_public_profile_ui",
      "chess_com_website_ui",
    ].includes(input.sourceType)
  )
    result.sourceType = input.sourceType;
  return result;
}

// Canonical helpers validate measurements; an explicit new object limits public fields.
function directoryDate(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?Z$/.exec(
    value,
  );
  if (!match || !Number.isFinite(Date.parse(value))) return null;
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  return new Date(value).toISOString() === canonical ? value : null;
}

function publicDirectory(c) {
  let pagesCaptured = integer(c.pagesCaptured),
    pagesExpected = integer(c.expectedPages),
    observedEntries = integer(c.observedEntries),
    uniqueAccounts = integer(c.uniqueAccounts);
  if (
    pagesCaptured !== null &&
    pagesExpected !== null &&
    pagesCaptured > pagesExpected
  )
    pagesCaptured = pagesExpected = null;
  const inconsistentEntries =
    observedEntries !== null &&
    uniqueAccounts !== null &&
    uniqueAccounts > observedEntries;
  if (inconsistentEntries) observedEntries = uniqueAccounts = null;
  const derivedDuplicates =
    observedEntries !== null && uniqueAccounts !== null
      ? observedEntries - uniqueAccounts
      : null;
  let duplicateEntries = Object.hasOwn(c, "duplicateEntries")
    ? integer(c.duplicateEntries)
    : derivedDuplicates;
  if (inconsistentEntries) duplicateEntries = null;
  if (
    duplicateEntries !== null &&
    derivedDuplicates !== null &&
    duplicateEntries !== derivedDuplicates
  )
    duplicateEntries = null;
  let captureStartedAt = directoryDate(c.captureStartedAt),
    captureEndedAt = directoryDate(c.captureEndedAt);
  if (
    captureStartedAt &&
    captureEndedAt &&
    Date.parse(captureStartedAt) > Date.parse(captureEndedAt)
  )
    captureStartedAt = captureEndedAt = null;
  return {
    pagesCaptured,
    pagesExpected,
    complete: c.directoryComplete === true,
    observedEntries,
    uniqueAccounts,
    duplicateEntries,
    pageCoverageComplete:
      pagesExpected !== null &&
      pagesExpected > 0 &&
      pagesCaptured === pagesExpected &&
      Array.isArray(c.missingPages) &&
      c.missingPages.length === 0 &&
      Array.isArray(c.wrongSizedPages) &&
      c.wrongSizedPages.length === 0,
    captureStartedAt,
    captureEndedAt,
    snapshotVerified: false,
  };
}

export function projectPublicIndex(index, publication, helpers) {
  if (!Array.isArray(index.accounts) || !date(index.generatedAt))
    throw Error("Invalid published compact index.");
  const seen = new Set();
  const accounts = index.accounts.map((account) => {
    if (
      !account ||
      typeof account.username !== "string" ||
      !/^[a-z0-9_-]+$/i.test(account.username) ||
      account.username.length > 100
    )
      throw Error("Invalid public username.");
    const username = account.username,
      key = username.toLowerCase();
    if (seen.has(key)) throw Error("Duplicate public identity.");
    seen.add(key);
    if (
      ![
        "GM",
        "IM",
        "FM",
        "CM",
        "NM",
        "WGM",
        "WIM",
        "WFM",
        "WCM",
        "WNM",
        "M",
      ].includes(account.title)
    )
      throw Error("Invalid public title.");
    const row = {
      username,
      title: account.title,
      profileUrl: `https://www.chess.com/member/${encodeURIComponent(username)}`,
      friendsUrl: `https://www.chess.com/member/${encodeURIComponent(username)}/friends`,
      friendCount: publicMeasurement(
        helpers.normalizeFriendCount(account.friendCount),
        { display: true, source: true },
      ),
      ratings: Object.fromEntries(
        ["bullet", "blitz", "rapid", "overall"].map((axis) => [
          axis,
          publicMeasurement(helpers.ratingFor(account, axis)),
        ]),
      ),
    };
    if (typeof account.name === "string" && account.name.length <= 300)
      row.name = account.name;
    const list = helpers.publicListEnumeration(account);
    if (list)
      row.listCount = {
        value: list.value,
        precision: "exact",
        startedAt: list.startedAt,
        observedAt: list.observedAt,
        snapshotVerified: false,
      };
    return row;
  });
  const counts = { exact: 0, lower_bound: 0, unknown: 0 },
    ratings = { bullet: 0, blitz: 0, rapid: 0, overall: 0 };
  for (const account of accounts) {
    counts[account.friendCount.precision]++;
    for (const axis of Object.keys(ratings))
      if (account.ratings[axis].precision === "exact") ratings[axis]++;
  }
  const c = index.coverage ?? {},
    roster = index.publishedRosterCoverage ?? {};
  return {
    schemaVersion: 1,
    generatedAt: index.generatedAt,
    publication,
    coverage: {
      accounts: accounts.length,
      counts,
      ratings,
      directory: publicDirectory(c),
      roster: {
        snapshotCoverageComplete: roster.snapshotCoverageComplete === true,
        publishedUnionAccounts: integer(roster.summary?.publishedUnionAccounts),
        preservedSeedOnlyAccounts: integer(
          roster.summary?.preservedSeedOnlyAccounts,
        ),
      },
    },
    accounts,
  };
}

export async function exportPublicData({ source, output }) {
  const root = await realpath(resolve(source)),
    pointerPath = await contained(root, join(root, "main-publication.json"));
  const pointerBytes = await bounded(pointerPath, 64 * 1024),
    pointer = JSON.parse(pointerBytes);
  if (
    pointer.schemaVersion !== 1 ||
    pointer.target !== "main" ||
    !hash(pointer.generation) ||
    !hash(pointer.manifestSha256)
  )
    throw Error("Invalid selected publication pointer.");
  const manifestName = `main-publications/${pointer.generation}/publication-manifest.json`;
  if (pointer.manifest !== manifestName)
    throw Error("Invalid publication manifest path.");
  const manifestPath = await contained(root, join(root, manifestName)),
    manifestBytes = await bounded(manifestPath, 2 * 1024 * 1024);
  if (digest(manifestBytes) !== pointer.manifestSha256)
    throw Error("Publication manifest digest mismatch.");
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.target !== "main" ||
    manifest.generation !== pointer.generation ||
    manifest.validation?.passed !== true ||
    manifest.validation.fullScope !== true ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    throw Error("Publication lacks full validation.");
  for (const [name, descriptor] of Object.entries(manifest.files))
    if (
      !safeFile(name) ||
      !hash(descriptor?.sha256) ||
      integer(descriptor.bytes) === null
    )
      throw Error("Invalid manifest file descriptor.");
  const descriptor = manifest.files["main-index.json"];
  if (!descriptor) throw Error("Published compact index missing.");
  const indexPath = await contained(
      root,
      join(dirname(manifestPath), "main-index.json"),
    ),
    indexBytes = await bounded(indexPath, 128 * 1024 * 1024);
  if (
    indexBytes.length !== descriptor.bytes ||
    digest(indexBytes) !== descriptor.sha256
  )
    throw Error("Compact index digest mismatch.");
  const helperPaths = await Promise.all(
    ["model.mjs", "rating-model.mjs"].map((name) =>
      contained(root, join(root, name)),
    ),
  );
  const helperBytes = await Promise.all(
    helperPaths.map((path) => bounded(path, 2 * 1024 * 1024)),
  );
  const [model, rating] = await Promise.all(
    helperPaths.map((path) => import(pathToFileURL(path).href)),
  );
  const publication = {
    mainGeneration: pointer.generation,
    mainManifestSha256: pointer.manifestSha256,
  };
  const data = projectPublicIndex(JSON.parse(indexBytes), publication, {
    ...model,
    ...rating,
  });
  if (
    Number.isSafeInteger(manifest.validation.accounts) &&
    manifest.validation.accounts !== data.accounts.length
  )
    throw Error("Published population mismatch.");
  const bytes = Buffer.from(JSON.stringify(data) + "\n");
  if (bytes.length > MAX_EXPORT) throw Error("Public export exceeds 25 MiB.");
  for (let i = 0; i < helperPaths.length; i++)
    if (
      !(await bounded(helperPaths[i], 2 * 1024 * 1024)).equals(helperBytes[i])
    )
      throw Error("Canonical helper changed during export.");
  if (!(await bounded(pointerPath, 64 * 1024)).equals(pointerBytes))
    throw Error("Publication pointer changed during export.");
  const destination = resolve(output);
  const delta = relative(root, destination);
  if (
    delta === "" ||
    (!isAbsolute(delta) &&
      delta !== ".." &&
      !delta.startsWith(".." + (process.platform === "win32" ? "\\" : "/")))
  )
    throw Error("Export must not write inside the source project.");
  await mkdir(dirname(destination), { recursive: true });
  const physicalParent = await realpath(dirname(destination)),
    parentDelta = relative(root, physicalParent);
  if (
    parentDelta === "" ||
    (!isAbsolute(parentDelta) &&
      parentDelta !== ".." &&
      !parentDelta.startsWith(
        ".." + (process.platform === "win32" ? "\\" : "/"),
      ))
  )
    throw Error("Physical output parent is inside source project.");
  const temporary = join(dirname(destination), `.${randomUUID()}.dataset.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    if (!(await bounded(pointerPath, 64 * 1024)).equals(pointerBytes))
      throw Error("Publication pointer changed before install.");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  const descriptorOf = (input) => ({
    bytes: input.length,
    sha256: digest(input),
  });
  return {
    output: destination,
    bytes: bytes.length,
    sha256: digest(bytes),
    accounts: data.accounts.length,
    publication,
    sourceDescriptors: {
      pointer: descriptorOf(pointerBytes),
      manifest: descriptorOf(manifestBytes),
      compactIndex: descriptorOf(indexBytes),
      model: descriptorOf(helperBytes[0]),
      ratingModel: descriptorOf(helperBytes[1]),
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  assert(
    args.length === 4 && args[0] === "--source" && args[2] === "--output",
    "Usage: node scripts/export-public-data.mjs --source PROJECT --output RELEASE/public/data/dataset.json",
  );
  console.log(
    JSON.stringify(
      await exportPublicData({ source: args[1], output: args[3] }),
    ),
  );
}
