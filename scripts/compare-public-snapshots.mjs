import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const axes = ["bullet", "blitz", "rapid", "overall"];
const precisions = ["exact", "lower_bound", "unknown"];
const fail = (message) => {
  throw new Error(message);
};
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const hex = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const dated = (v) => {
  if (typeof v !== "string") return false;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?Z$/.exec(v);
  if (!match) return false;
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  const time = Date.parse(canonical);
  return Number.isFinite(time) && new Date(time).toISOString() === canonical;
};
function object(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Invalid public object.");
  if (
    Object.keys(value).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    fail("Public field allowlist violation.");
}
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ak = Object.keys(a).sort(),
    bk = Object.keys(b).sort();
  return (
    ak.length === bk.length &&
    ak.every((k, i) => k === bk[i] && same(a[k], b[k]))
  );
}
function measurement(m, kind) {
  const allowed =
    kind === "count"
      ? [
          "value",
          "precision",
          "display",
          "observedAt",
          "lastRatedGameAt",
          "sourceType",
        ]
      : ["value", "precision", "observedAt", "lastRatedGameAt"];
  object(m, allowed, ["value", "precision"]);
  if (
    !(kind === "count" ? precisions : ["exact", "unknown"]).includes(
      m.precision,
    )
  )
    fail("Invalid public measurement precision.");
  if (
    m.precision === "unknown"
      ? m.value !== null
      : kind === "count"
        ? !integer(m.value)
        : !(
            typeof m.value === "number" &&
            Number.isFinite(m.value) &&
            m.value >= 100
          )
  )
    fail("Invalid public measurement value.");
  for (const key of ["observedAt", "lastRatedGameAt"])
    if (Object.hasOwn(m, key) && !dated(m[key]))
      fail("Invalid public measurement date.");
  if (
    Object.hasOwn(m, "display") &&
    (typeof m.display !== "string" || m.display.length > 80)
  )
    fail("Invalid public count display.");
  if (m.precision === "exact" && m.display?.includes("+"))
    fail("Lower bound cannot be exact.");
  if (
    Object.hasOwn(m, "sourceType") &&
    ![
      "chess_com_mobile_api",
      "chess_com_native_app_ui",
      "chess_com_public_profile_ui",
      "chess_com_website_ui",
    ].includes(m.sourceType)
  )
    fail("Invalid public count source.");
}
function validate(data) {
  object(data, [
    "schemaVersion",
    "generatedAt",
    "publication",
    "coverage",
    "accounts",
  ]);
  if (
    data.schemaVersion !== 1 ||
    !dated(data.generatedAt) ||
    !Array.isArray(data.accounts)
  )
    fail("Invalid public snapshot schema.");
  object(
    data.publication,
    ["mainGeneration", "mainManifestSha256", "gmGeneration"],
    ["mainGeneration", "mainManifestSha256"],
  );
  if (
    !hex(data.publication.mainGeneration) ||
    !hex(data.publication.mainManifestSha256) ||
    (Object.hasOwn(data.publication, "gmGeneration") &&
      !hex(data.publication.gmGeneration))
  )
    fail("Invalid public publication pins.");
  object(data.coverage, [
    "accounts",
    "counts",
    "ratings",
    "directory",
    "roster",
  ]);
  object(data.coverage.counts, precisions);
  object(data.coverage.ratings, axes);
  object(
    data.coverage.directory,
    [
      "pagesCaptured",
      "pagesExpected",
      "complete",
      "observedEntries",
      "uniqueAccounts",
      "duplicateEntries",
      "pageCoverageComplete",
      "captureStartedAt",
      "captureEndedAt",
      "snapshotVerified",
    ],
    ["pagesCaptured", "pagesExpected", "complete"],
  );
  const dir = data.coverage.directory;
  for (const k of [
    "pagesCaptured",
    "pagesExpected",
    "observedEntries",
    "uniqueAccounts",
    "duplicateEntries",
  ])
    if (Object.hasOwn(dir, k) && dir[k] !== null && !integer(dir[k]))
      fail("Invalid directory measurement.");
  for (const k of ["complete", "pageCoverageComplete", "snapshotVerified"])
    if (Object.hasOwn(dir, k) && typeof dir[k] !== "boolean")
      fail("Invalid directory status.");
  if (dir.snapshotVerified === true)
    fail("Public directory is not an atomic snapshot.");
  for (const k of ["captureStartedAt", "captureEndedAt"])
    if (Object.hasOwn(dir, k) && dir[k] !== null && !dated(dir[k]))
      fail("Invalid directory date.");
  if (
    dir.pagesCaptured !== null &&
    dir.pagesExpected !== null &&
    dir.pagesCaptured > dir.pagesExpected
  )
    fail("Invalid directory page totals.");
  if (
    dir.pageCoverageComplete === true &&
    !(dir.pagesExpected > 0 && dir.pagesCaptured === dir.pagesExpected)
  )
    fail("Invalid complete page coverage.");
  if (
    dir.captureStartedAt &&
    dir.captureEndedAt &&
    Date.parse(dir.captureStartedAt) > Date.parse(dir.captureEndedAt)
  )
    fail("Invalid directory date order.");
  if (
    integer(dir.observedEntries) &&
    integer(dir.uniqueAccounts) &&
    (dir.uniqueAccounts > dir.observedEntries ||
      (integer(dir.duplicateEntries) &&
        dir.duplicateEntries !== dir.observedEntries - dir.uniqueAccounts))
  )
    fail("Invalid directory entry totals.");
  object(data.coverage.roster, [
    "snapshotCoverageComplete",
    "publishedUnionAccounts",
    "preservedSeedOnlyAccounts",
  ]);
  if (typeof data.coverage.roster.snapshotCoverageComplete !== "boolean")
    fail("Invalid roster status.");
  for (const k of ["publishedUnionAccounts", "preservedSeedOnlyAccounts"])
    if (data.coverage.roster[k] !== null && !integer(data.coverage.roster[k]))
      fail("Invalid roster totals.");
  const counts = { exact: 0, lower_bound: 0, unknown: 0 },
    ratings = Object.fromEntries(axes.map((k) => [k, 0])),
    identities = new Map();
  for (const row of data.accounts) {
    object(
      row,
      [
        "username",
        "title",
        "name",
        "profileUrl",
        "friendsUrl",
        "friendCount",
        "ratings",
        "listCount",
      ],
      [
        "username",
        "title",
        "profileUrl",
        "friendsUrl",
        "friendCount",
        "ratings",
      ],
    );
    if (
      typeof row.username !== "string" ||
      !/^[a-z0-9_-]{1,100}$/i.test(row.username) ||
      ![
        "GM",
        "WGM",
        "IM",
        "WIM",
        "FM",
        "WFM",
        "CM",
        "WCM",
        "NM",
        "WNM",
        "M",
      ].includes(row.title)
    )
      fail("Invalid public identity.");
    const key = row.username.toLowerCase();
    if (identities.has(key)) fail("Duplicate public identity.");
    identities.set(key, row);
    if (
      row.profileUrl !==
        `https://www.chess.com/member/${encodeURIComponent(row.username)}` ||
      row.friendsUrl !== row.profileUrl + "/friends"
    )
      fail("Invalid public profile URL.");
    if (
      Object.hasOwn(row, "name") &&
      (typeof row.name !== "string" || row.name.length > 300)
    )
      fail("Invalid public name.");
    measurement(row.friendCount, "count");
    counts[row.friendCount.precision]++;
    object(row.ratings, axes);
    for (const axis of axes) {
      measurement(row.ratings[axis], "rating");
      if (row.ratings[axis].precision === "exact") ratings[axis]++;
    }
    const controls = axes.slice(0, 3).map((k) => row.ratings[k]);
    const complete = controls.every((m) => m.precision === "exact"),
      overall = row.ratings.overall;
    if (complete) {
      const mean = controls.reduce((sum, m) => sum + m.value, 0) / 3;
      if (
        overall.precision !== "exact" ||
        Math.abs(overall.value - mean) > Math.max(1, Math.abs(mean)) * 1e-12
      )
        fail("Invalid overall rating.");
    } else if (overall.precision !== "unknown")
      fail("Incomplete controls must leave overall unknown.");
    if (Object.hasOwn(row, "listCount")) {
      const list = row.listCount;
      object(list, [
        "value",
        "precision",
        "startedAt",
        "observedAt",
        "snapshotVerified",
      ]);
      if (
        !integer(list.value) ||
        list.precision !== "exact" ||
        !dated(list.startedAt) ||
        !dated(list.observedAt) ||
        Date.parse(list.startedAt) > Date.parse(list.observedAt) ||
        list.snapshotVerified !== false
      )
        fail("Invalid public traversal measurement.");
    }
  }
  if (
    data.coverage.accounts !== data.accounts.length ||
    !same(counts, data.coverage.counts) ||
    !same(ratings, data.coverage.ratings)
  )
    fail("Public coverage does not match account measurements.");
  return { identities, counts };
}

export function comparePublicSnapshots(
  previous,
  candidate,
  { expectedExactIncrease, expectedGeneration, expectedManifestSha256 } = {},
) {
  if (!integer(expectedExactIncrease))
    fail("Expected exact increase must be a nonnegative integer.");
  const before = validate(previous),
    after = validate(candidate);
  if (previous.publication.gmGeneration !== candidate.publication.gmGeneration)
    fail("Preserved GM publication changed.");
  if (
    expectedGeneration !== undefined &&
    (!hex(expectedGeneration) ||
      candidate.publication.mainGeneration !== expectedGeneration)
  )
    fail("Candidate generation does not match selected pin.");
  if (
    expectedManifestSha256 !== undefined &&
    (!hex(expectedManifestSha256) ||
      candidate.publication.mainManifestSha256 !== expectedManifestSha256)
  )
    fail("Candidate manifest does not match selected pin.");
  if (Date.parse(candidate.generatedAt) < Date.parse(previous.generatedAt))
    fail("Candidate snapshot date regressed.");
  if (before.identities.size !== after.identities.size)
    fail("Public roster changed.");
  for (const field of ["directory", "roster", "ratings"])
    if (!same(previous.coverage[field], candidate.coverage[field]))
      fail("Preserved public coverage changed.");
  const transitions = Object.fromEntries(
    precisions.flatMap((a) => precisions.map((b) => [`${a}_to_${b}`, 0])),
  );
  const knownValueChanges = { total: 0, increased: 0, decreased: 0 };
  for (const [identity, row] of before.identities) {
    const next = after.identities.get(identity);
    if (!next) fail("Public roster changed.");
    for (const field of [
      "title",
      "name",
      "profileUrl",
      "friendsUrl",
      "ratings",
      "listCount",
    ])
      if (!same(row[field], next[field]))
        fail("Preserved public account fields changed.");
    const a = row.friendCount,
      b = next.friendCount;
    if (
      a.precision !== "unknown" &&
      (b.precision === "unknown" ||
        (a.precision === "exact" && b.precision !== "exact"))
    )
      fail("Known count precision or availability lost.");
    if (
      a.precision !== "unknown" &&
      (a.value !== b.value ||
        (a.precision === "lower_bound" && b.precision === "exact"))
    ) {
      if (
        !dated(a.observedAt) ||
        !dated(b.observedAt) ||
        Date.parse(b.observedAt) <= Date.parse(a.observedAt)
      )
        fail("Changed known count requires a strictly newer observation.");
      if (a.value !== b.value) {
        knownValueChanges.total++;
        knownValueChanges[b.value > a.value ? "increased" : "decreased"]++;
      }
    }
    transitions[`${a.precision}_to_${b.precision}`]++;
  }
  const exactIncrease = after.counts.exact - before.counts.exact;
  if (exactIncrease !== expectedExactIncrease)
    fail("Exact count increase does not match expectation.");
  return {
    valid: true,
    previousCounts: before.counts,
    candidateCounts: after.counts,
    exactIncrease,
    transitions,
    knownValueChanges,
    invariants: {
      publicSchema: true,
      rosterPreserved: true,
      ratingsPreserved: true,
      directoryPreserved: true,
      rosterCoveragePreserved: true,
      ratingCoveragePreserved: true,
      coverageRecalculated: true,
      knownCountsPreserved: true,
      knownValueChangesDated: true,
      expectedIncrease: true,
      selectedPinsMatched: true,
    },
    publication: { ...candidate.publication },
  };
}

async function cli() {
  const args = process.argv.slice(2),
    options = {};
  const allowed = [
    "previous",
    "candidate",
    "expected-exact-increase",
    "expected-generation",
    "expected-manifest-sha256",
  ];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    if (
      !args[i]?.startsWith("--") ||
      !allowed.includes(key) ||
      !args[i + 1] ||
      Object.hasOwn(options, key)
    )
      fail("Invalid comparator arguments.");
    options[key] = args[i + 1];
  }
  if (
    !options.previous ||
    !options.candidate ||
    !/^\d+$/.test(options["expected-exact-increase"] ?? "")
  )
    fail("Require previous, candidate and expected exact increase.");
  const previousBytes = await readFile(resolve(options.previous)),
    candidateBytes = await readFile(resolve(options.candidate));
  let previous, candidate;
  try {
    previous = JSON.parse(previousBytes);
    candidate = JSON.parse(candidateBytes);
  } catch {
    fail("Invalid public snapshot JSON.");
  }
  const result = comparePublicSnapshots(previous, candidate, {
    expectedExactIncrease: Number(options["expected-exact-increase"]),
    expectedGeneration: options["expected-generation"],
    expectedManifestSha256: options["expected-manifest-sha256"],
  });
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  process.stdout.write(
    JSON.stringify({
      ...result,
      hashes: {
        previousSha256: hash(previousBytes),
        candidateSha256: hash(candidateBytes),
      },
    }) + "\n",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  cli().catch((error) => {
    process.stderr.write(
      ["ENOENT", "EACCES", "EPERM", "EISDIR"].includes(error.code)
        ? "Public snapshot file unavailable.\n"
        : `${error.message}\n`,
    );
    process.exitCode = 1;
  });
