import assert from "node:assert/strict";
import {
  open,
  stat,
  lstat,
  realpath,
  mkdir,
  writeFile,
  rename,
  rm,
  readdir,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  resolve,
  relative,
  isAbsolute,
  join,
  dirname,
  basename,
} from "node:path";
import { pathToFileURL } from "node:url";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_GM_SHARD_BYTES = 25 * 1024 * 1024;
const hash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const username = (value) =>
  typeof value === "string" && /^[a-z0-9_-]{1,100}$/i.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const nullableText = (value) =>
  value === null || (typeof value === "string" && value.length <= 2048);
const utcStamp = (value) =>
  value.replace(
    /(?:\.(\d{1,9}))?Z$/,
    (_, fraction = "") => `.${fraction.padEnd(9, "0")}Z`,
  );
function date(value) {
  value ??= null;
  if (value === null) return null;
  assert(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value),
    "Invalid UTC observation date",
  );
  const normalized = value.replace(
    /\.(\d{1,9})Z$/,
    (_, fraction) => `.${fraction.padEnd(3, "0").slice(0, 3)}Z`,
  );
  const parsed = new Date(normalized);
  assert(
    Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().replace(/\.000Z$/, "Z") ===
        normalized.replace(/\.000Z$/, "Z"),
    "Invalid calendar date",
  );
  return value;
}
function url(value, identity, friends = false, allowQuery = false) {
  value ??= null;
  if (value === null) {
    assert(!identity, "Missing identity URL");
    return null;
  }
  assert(typeof value === "string");
  const parsed = new URL(value);
  assert(
    parsed.protocol === "https:" &&
      ["www.chess.com", "api.chess.com"].includes(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash,
    "Invalid public source URL",
  );
  for (const key of parsed.searchParams.keys())
    assert(
      ["page", "order", "sort", "filter", "sortby"].includes(key.toLowerCase()),
      "Unauthorized public query",
    );
  if (identity)
    assert(
      parsed.hostname === "www.chess.com" &&
        parsed.pathname.toLowerCase() ===
          `/member/${identity.toLowerCase()}${friends ? "/friends" : ""}` &&
        (allowQuery || !parsed.search),
      "URL identity mismatch",
    );
  return value;
}
function measurement(input, full = false) {
  assert(
    input && ["exact", "lower_bound", "unknown"].includes(input.precision),
    "Invalid count precision",
  );
  assert(input.value === null || integer(input.value), "Invalid count");
  assert(
    input.precision !== "unknown" || input.value === null,
    "Unknown count must be null",
  );
  assert(
    input.precision === "unknown" || integer(input.value),
    "Known count must be numeric",
  );
  const display = input.display ?? null;
  assert(nullableText(display), "Invalid count display");
  const result = { value: input.value, display, precision: input.precision };
  if (full) {
    result.observedAt = date(input.observedAt);
    const sourceType = input.sourceType ?? null;
    assert(
      sourceType === null ||
        [
          "chess_com_mobile_api",
          "chess_com_native_app_ui",
          "chess_com_public_profile_ui",
          "chess_com_website_ui",
        ].includes(sourceType),
    );
    result.sourceType = sourceType;
    result.sourceUrl = url(input.sourceUrl);
  }
  return result;
}
function list(input) {
  assert(
    input && ["complete", "partial", "unknown"].includes(input.status),
    "Invalid friend list status",
  );
  assert(
    input.complete === (input.status === "complete"),
    "Inconsistent list completeness",
  );
  assert(integer(input.enumeratedCount), "Invalid enumerated count");
  return {
    status: input.status,
    complete: input.complete,
    enumeratedCount: input.enumeratedCount,
    observedAt: date(input.observedAt),
  };
}
async function noAliases(path, label) {
  let part = resolve(path);
  while (true) {
    try {
      assert(
        !(await lstat(part)).isSymbolicLink(),
        `${label} symlink alias forbidden`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(part);
    if (parent === part) break;
    part = parent;
  }
}
async function bounded(root, name, limit, pin) {
  assert(
    typeof name === "string" &&
      !isAbsolute(name) &&
      !name.split(/[\\/]/).includes(".."),
    "Invalid source path",
  );
  let part = root;
  for (const segment of name.split(/[\\/]/)) {
    part = join(part, segment);
    assert(
      !(await lstat(part)).isSymbolicLink(),
      "Source symlink alias forbidden",
    );
  }
  const path = await realpath(join(root, name));
  const delta = relative(root, path);
  assert(
    delta &&
      !isAbsolute(delta) &&
      delta !== ".." &&
      !delta.startsWith("..\\") &&
      !delta.startsWith("../"),
    "Source path escapes root",
  );
  const info = await stat(path);
  assert(info.isFile() && info.size <= limit, "Input exceeds bound");
  if (pin)
    assert(
      integer(pin.bytes) &&
        pin.bytes <= limit &&
        hash(pin.sha256) &&
        info.size === pin.bytes,
      "Invalid descriptor size",
    );
  const handle = await open(path, "r");
  let bytes;
  try {
    const opened = await handle.stat();
    assert(
      opened.isFile() &&
        opened.size === info.size &&
        opened.size <= limit &&
        opened.dev === info.dev &&
        opened.ino === info.ino,
      "Input changed before bounded read",
    );
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      assert(read.bytesRead > 0, "Input shrank during read");
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    assert(
      (await handle.read(extra, 0, 1, bytes.length)).bytesRead === 0 &&
        (await handle.stat()).size === bytes.length,
      "Input grew beyond bound",
    );
  } finally {
    await handle.close();
  }
  if (pin)
    assert(
      bytes.length === pin.bytes && sha(bytes) === pin.sha256,
      "Source pin mismatch",
    );
  return bytes;
}
const encode = (object) => Buffer.from(JSON.stringify(object) + "\n");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
function only(object, keys) {
  assert(object && typeof object === "object" && !Array.isArray(object));
  assert(
    Object.keys(object).every((key) => keys.includes(key)),
    "Unauthorized supplemental field",
  );
}
function publicDetails(input) {
  const details = list(input);
  assert(Array.isArray(input.friends));
  const seen = new Set();
  const friends = input.friends.map((friend) => {
    assert(username(friend.username), "Invalid friend identity");
    const key = friend.username.toLowerCase();
    assert(!seen.has(key), "Duplicate friend identity");
    seen.add(key);
    assert(
      friend.title === null ||
        (typeof friend.title === "string" && /^[A-Z]{1,5}$/.test(friend.title)),
    );
    return {
      username: friend.username,
      title: friend.title,
      profileUrl: url(friend.profileUrl, friend.username),
    };
  });
  assert(friends.length === details.enumeratedCount, "Enumeration mismatch");
  assert(
    details.status !== "unknown" || friends.length === 0,
    "Unknown list contains friends",
  );
  const displayedTotal =
    input.displayedTotal === null ? null : measurement(input.displayedTotal);
  if (details.complete && displayedTotal?.precision === "exact")
    assert(
      displayedTotal.value === friends.length,
      "Complete list total mismatch",
    );
  return {
    ...details,
    sourceUrl: url(input.sourceUrl),
    displayedTotal,
    friends,
  };
}

// Explicit descriptors only: this adapter never searches for capture or proof files.
export async function normalizePublicGmSupplement(
  { manifestPath, expectedSha256 },
  baseGmGeneration,
  reviewAssociations = [],
) {
  assert(
    hash(expectedSha256),
    "Supplement requires caller-expected manifest SHA",
  );
  await noAliases(dirname(resolve(manifestPath)), "Supplement root");
  const root = await realpath(dirname(resolve(manifestPath)));
  const bytes = await bounded(root, basename(manifestPath), 1024 * 1024);
  assert(sha(bytes) === expectedSha256, "Supplement manifest pin mismatch");
  const manifest = JSON.parse(bytes);
  assert(Array.isArray(reviewAssociations));
  const reviews = new Map();
  for (const r of reviewAssociations) {
    only(r, ["username", "certificatePath", "bytes", "sha256"]);
    assert(
      username(r.username) &&
        integer(r.bytes) &&
        r.bytes <= 65536 &&
        hash(r.sha256) &&
        !reviews.has(r.username.toLowerCase()),
    );
    reviews.set(r.username.toLowerCase(), r);
  }
  const usedReviews = new Set(),
    reviewPins = [];
  only(manifest, ["schemaVersion", "baseGmGeneration", "candidates"]);
  assert(
    manifest.schemaVersion === 1 &&
      manifest.baseGmGeneration === baseGmGeneration,
    "Supplement base generation mismatch",
  );
  assert(
    Array.isArray(manifest.candidates) && manifest.candidates.length <= 1744,
  );
  const targets = new Set(),
    candidates = [];
  for (const descriptor of manifest.candidates) {
    only(descriptor, ["username", "path", "bytes", "sha256"]);
    assert(
      username(descriptor.username) &&
        hash(descriptor.sha256) &&
        integer(descriptor.bytes),
    );
    const key = descriptor.username.toLowerCase();
    assert(!targets.has(key), "Duplicate supplemental target");
    targets.add(key);
    assert(typeof descriptor.path === "string");
    const candidatePath = isAbsolute(descriptor.path)
      ? relative(root, descriptor.path)
      : descriptor.path;
    const candidate = JSON.parse(
      await bounded(root, candidatePath, MAX_GM_SHARD_BYTES, descriptor),
    );
    only(candidate, [
      "schemaVersion",
      "baseGmGeneration",
      "username",
      "generatedAt",
      "friendList",
      "savedTraversal",
    ]);
    assert(
      candidate.schemaVersion === 1 &&
        candidate.baseGmGeneration === baseGmGeneration,
      "Candidate base generation mismatch",
    );
    assert(
      username(candidate.username) && candidate.username.toLowerCase() === key,
      "Candidate identity mismatch",
    );
    date(candidate.generatedAt);
    assert(candidate.generatedAt !== null);
    only(candidate.friendList, [
      "status",
      "complete",
      "enumeratedCount",
      "observedAt",
      "sourceUrl",
      "displayedTotal",
      "friends",
    ]);
    if (candidate.friendList.displayedTotal !== null)
      only(candidate.friendList.displayedTotal, [
        "value",
        "display",
        "precision",
      ]);
    assert(Array.isArray(candidate.friendList.friends));
    for (const friend of candidate.friendList.friends)
      only(friend, ["username", "title", "profileUrl"]);
    const friendList = publicDetails(candidate.friendList);
    const timestamp = (value) =>
      value.replace(
        /(?:\.(\d{1,9}))?Z$/,
        (_, fraction = "") => `.${fraction.padEnd(9, "0")}Z`,
      );
    assert(
      friendList.observedAt === null ||
        timestamp(friendList.observedAt) <= timestamp(candidate.generatedAt),
      "Supplement observation is later than generation",
    );
    url(friendList.sourceUrl, candidate.username, true, true);
    if (friendList.complete) {
      assert(friendList.observedAt !== null, "Complete supplement lacks date");
      assert(
        friendList.displayedTotal?.precision === "exact" &&
          integer(friendList.displayedTotal.value) &&
          friendList.displayedTotal.value === friendList.friends.length,
        "Complete supplement requires exact matching displayed total",
      );
    }
    let reviewedTraversal;
    if (candidate.savedTraversal !== undefined) {
      const association = reviews.get(key);
      assert(association, "Missing caller-pinned traversal review");
      usedReviews.add(key);
      const reviewRoot = await realpath(
        dirname(resolve(association.certificatePath)),
      );
      await noAliases(reviewRoot, "Traversal review");
      const certBytes = await bounded(
        reviewRoot,
        basename(association.certificatePath),
        65536,
        association,
      );
      reviewPins.push({
        username: candidate.username,
        bytes: certBytes.length,
        sha256: sha(certBytes),
      });
      const cert = JSON.parse(certBytes);
      only(cert, [
        "schemaVersion",
        "kind",
        "status",
        "baseGmGeneration",
        "username",
        "profileTitle",
        "candidate",
        "input",
        "savedTraversal",
        "friendListStatus",
        "friendListComplete",
        "displayedTotal",
        "observedAt",
        "sourceUrl",
        "reviewedAt",
      ]);
      assert(
        cert.schemaVersion === 1 &&
          cert.kind === "public_new_capped_traversal_review" &&
          cert.status === "verified" &&
          cert.baseGmGeneration === baseGmGeneration &&
          cert.username.toLowerCase() === key &&
          cert.profileTitle === "GM",
      );
      only(cert.candidate, ["bytes", "sha256"]);
      assert(
        cert.candidate.bytes === descriptor.bytes &&
          cert.candidate.sha256 === descriptor.sha256,
      );
      only(cert.input, ["bytes", "sha256"]);
      assert(integer(cert.input.bytes) && hash(cert.input.sha256));
      const t = candidate.savedTraversal;
      only(t, [
        "status",
        "traversalComplete",
        "snapshotVerified",
        "count",
        "pageCount",
        "startedAt",
        "endedAt",
      ]);
      assert(
        t.status === "verified" &&
          t.traversalComplete === true &&
          t.snapshotVerified === false &&
          integer(t.count) &&
          t.count > 0 &&
          integer(t.pageCount) &&
          t.pageCount > 0,
      );
      assert(
        t.count === friendList.friends.length &&
          t.count === friendList.enumeratedCount &&
          t.pageCount === Math.ceil(t.count / 20),
      );
      assert(
        friendList.status === "partial" &&
          friendList.complete === false &&
          friendList.displayedTotal?.precision === "lower_bound" &&
          friendList.displayedTotal.value > 0 &&
          t.count >= friendList.displayedTotal.value,
      );
      for (const v of [t.startedAt, t.endedAt, cert.reviewedAt])
        assert(date(v) !== null);
      assert(
        timestamp(t.startedAt) <= timestamp(t.endedAt) &&
          t.endedAt === friendList.observedAt &&
          timestamp(t.endedAt) <= timestamp(candidate.generatedAt) &&
          timestamp(candidate.generatedAt) <= timestamp(cert.reviewedAt) &&
          Date.parse(cert.reviewedAt) <= Date.now(),
      );
      assert.deepEqual(cert.savedTraversal, t);
      assert.deepEqual(cert.displayedTotal, friendList.displayedTotal);
      assert(
        cert.friendListStatus === "partial" &&
          cert.friendListComplete === false &&
          cert.observedAt === t.endedAt &&
          cert.sourceUrl === friendList.sourceUrl,
      );
      reviewedTraversal = t;
    } else assert(!reviews.has(key), "Unassociated review");
    candidates.push({
      ...(reviewedTraversal ? { savedTraversal: reviewedTraversal } : {}),
      username: candidate.username,
      generatedAt: candidate.generatedAt,
      friendList,
    });
  }
  assert(usedReviews.size === reviews.size, "Unused traversal review");
  return {
    pin: { bytes: bytes.length, sha256: sha(bytes) },
    candidates,
    ...(reviewPins.length ? { reviewPins } : {}),
  };
}
async function treeNames(root, prefix = "") {
  const names = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const name = prefix + entry.name;
    assert(!entry.isSymbolicLink(), "Immutable output contains symlink");
    if (entry.isDirectory()) names.push(...(await treeNames(root, name + "/")));
    else {
      assert(entry.isFile());
      names.push(name);
    }
  }
  return names.sort();
}

export async function exportPublicGmData({
  sourceDir,
  outputDir,
  supplemental,
  savedTraversalReview,
  supplementalTraversalReviews = [],
  beforeInstall,
} = {}) {
  const initialTraversalReviews = structuredClone(supplementalTraversalReviews);
  await noAliases(sourceDir, "Source root");
  const root = await realpath(resolve(sourceDir));
  const output = resolve(outputDir);
  await noAliases(output, "Output");
  const pointerBytes = await bounded(root, "gm-publication.json", 16384);
  const pointer = JSON.parse(pointerBytes);
  assert(
    pointer.schemaVersion === 1 &&
      pointer.target === "gm" &&
      hash(pointer.generation) &&
      hash(pointer.manifestSha256),
    "Invalid GM pointer",
  );
  assert(
    pointer.manifest ===
      `gm-publications/${pointer.generation}/publication-manifest.json`,
    "Invalid manifest location",
  );
  const manifestBytes = await bounded(root, pointer.manifest, 4 * 1024 * 1024);
  assert(
    sha(manifestBytes) === pointer.manifestSha256,
    "Manifest pin mismatch",
  );
  const manifest = JSON.parse(manifestBytes);
  assert(
    manifest.schemaVersion === 1 &&
      manifest.target === "gm" &&
      manifest.generation === pointer.generation &&
      manifest.validation?.passed === true &&
      manifest.validation?.fullScope === true,
    "Unvalidated GM publication",
  );
  const publishedRoot = dirname(await realpath(join(root, pointer.manifest)));
  let traversalCertificate, traversalPin, traversalRoot;
  if (savedTraversalReview) {
    const { certificatePath, expectedSha256, expectedBytes } =
      savedTraversalReview;
    assert(
      hash(expectedSha256) &&
        (expectedBytes === undefined || integer(expectedBytes)),
      "Saved traversal review requires explicit pins",
    );
    await noAliases(dirname(resolve(certificatePath)), "Review root");
    traversalRoot = await realpath(dirname(resolve(certificatePath)));
    traversalPin = {
      bytes: expectedBytes ?? (await stat(resolve(certificatePath))).size,
      sha256: expectedSha256,
    };
    traversalCertificate = JSON.parse(
      await bounded(
        traversalRoot,
        basename(certificatePath),
        65536,
        traversalPin,
      ),
    );
    only(traversalCertificate, [
      "schemaVersion",
      "kind",
      "status",
      "baseGmGeneration",
      "username",
      "sourceUrl",
      "observedAt",
      "friendListStatus",
      "friendListComplete",
      "displayedTotal",
      "exactCurrentCountCertified",
      "atomicSnapshotCertified",
      "account",
      "detail",
      "consumerSha256",
      "input",
      "sourceShard",
      "terminalEnumerationSha256",
      "qualification",
    ]);
    assert(
      hash(traversalCertificate.consumerSha256) &&
        hash(traversalCertificate.terminalEnumerationSha256),
      "Invalid review hash declarations",
    );
    for (const descriptor of [
      traversalCertificate.input,
      traversalCertificate.sourceShard,
    ]) {
      only(descriptor, ["bytes", "sha256"]);
      assert(
        integer(descriptor.bytes) && hash(descriptor.sha256),
        "Invalid review public descriptor",
      );
    }
    assert(
      nullableText(traversalCertificate.qualification),
      "Invalid review qualification",
    );
    only(traversalCertificate.displayedTotal, [
      "value",
      "display",
      "precision",
    ]);
    assert(
      traversalCertificate.schemaVersion === 1 &&
        traversalCertificate.kind === "public_saved_traversal_review" &&
        traversalCertificate.status === "verified" &&
        traversalCertificate.baseGmGeneration === pointer.generation &&
        username(traversalCertificate.username),
      "Invalid saved traversal review",
    );
    assert(
      traversalCertificate.exactCurrentCountCertified === false &&
        traversalCertificate.atomicSnapshotCertified === false,
      "Review cannot certify current count or atomic snapshot",
    );
  }
  assert(manifest.files?.["gm-index.json"], "Missing index descriptor");
  const index = JSON.parse(
    await bounded(
      publishedRoot,
      "gm-index.json",
      8 * 1024 * 1024,
      manifest.files["gm-index.json"],
    ),
  );
  assert(
    index.schemaVersion === 1 && Array.isArray(index.accounts),
    "Invalid GM index",
  );
  date(index.generatedAt);
  assert(index.generatedAt !== null);
  assert(
    manifest.validation.accounts === index.accounts.length,
    "Account scope mismatch",
  );
  const coverage = { completeLists: 0, partialLists: 0, unknownLists: 0 };
  const seen = new Set();
  const files = new Map();
  const accounts = [];
  for (const account of index.accounts) {
    assert(
      username(account.username) && account.title === "GM",
      "Invalid GM identity",
    );
    const key = account.username.toLowerCase();
    assert(!seen.has(key), "Duplicate GM identity");
    seen.add(key);
    const summary = list(account.friendList);
    coverage[`${summary.status}Lists`]++;
    const sourceName = `gm-friends/${key}.json`;
    assert(manifest.files?.[sourceName], "Missing shard descriptor");
    const shard = JSON.parse(
      await bounded(
        publishedRoot,
        sourceName,
        MAX_GM_SHARD_BYTES,
        manifest.files[sourceName],
      ),
    );
    assert(
      username(shard.username) && shard.username.toLowerCase() === key,
      "Shard identity mismatch",
    );
    date(shard.generatedAt);
    assert(shard.generatedAt !== null);
    const details = list(shard.friendList);
    assert.deepEqual(details, summary, "Shard status mismatch");
    assert(Array.isArray(shard.friendList.friends), "Missing friends");
    const friendSeen = new Set();
    const friends = shard.friendList.friends.map((friend) => {
      assert(username(friend.username), "Invalid friend identity");
      const friendKey = friend.username.toLowerCase();
      assert(!friendSeen.has(friendKey), "Duplicate friend identity");
      friendSeen.add(friendKey);
      assert(
        friend.title === null ||
          (typeof friend.title === "string" &&
            /^[A-Z]{1,5}$/.test(friend.title)),
        "Invalid title",
      );
      return {
        username: friend.username,
        title: friend.title,
        profileUrl: url(friend.profileUrl, friend.username),
      };
    });
    assert(friends.length === details.enumeratedCount, "Enumeration mismatch");
    assert(
      details.status !== "unknown" || friends.length === 0,
      "Unknown list contains friends",
    );
    const displayedTotal =
      shard.friendList.displayedTotal === null
        ? null
        : measurement(shard.friendList.displayedTotal);
    if (details.complete && displayedTotal?.precision === "exact")
      assert(
        displayedTotal.value === friends.length,
        "Complete list total mismatch",
      );
    files.set(
      `friends/${key}.json`,
      encode({
        schemaVersion: 1,
        generation: pointer.generation,
        username: account.username,
        generatedAt: shard.generatedAt,
        friendList: {
          ...details,
          sourceUrl: url(shard.friendList.sourceUrl),
          displayedTotal,
          friends,
        },
      }),
    );
    accounts.push({
      username: account.username,
      title: "GM",
      profileUrl: url(account.profileUrl, account.username),
      friendsUrl: url(account.friendsUrl, account.username, true),
      friendCount: measurement(account.friendCount, true),
      friendList: summary,
    });
    if (traversalCertificate?.username.toLowerCase() === key) {
      assert.deepEqual(
        traversalCertificate.sourceShard,
        manifest.files[sourceName],
        "Review source pin mismatch",
      );
      const terminal = shard.friendList.terminalEnumeration;
      assert(
        sha(Buffer.from(JSON.stringify(terminal))) ===
          traversalCertificate.terminalEnumerationSha256,
        "Review terminal enumeration hash mismatch",
      );
      assert(
        terminal &&
          terminal.status === "verified" &&
          terminal.scope === "saved_terminal_traversal" &&
          terminal.method === "alphabetical_public_pagination" &&
          terminal.traversalComplete === true &&
          terminal.snapshotVerified === false &&
          Array.isArray(terminal.issues) &&
          terminal.issues.length === 0,
        "Unverified saved traversal",
      );
      assert(
        integer(terminal.count) &&
          terminal.count === friends.length &&
          terminal.rawRows === friends.length &&
          integer(terminal.pages) &&
          terminal.pages > 0,
        "Invalid saved traversal count/pages",
      );
      const startedAt = date(terminal.startedAt),
        endedAt = date(terminal.endedAt);
      assert(
        startedAt !== null &&
          endedAt !== null &&
          utcStamp(startedAt) <= utcStamp(endedAt) &&
          endedAt === details.observedAt &&
          utcStamp(endedAt) <= utcStamp(shard.generatedAt),
        "Invalid saved traversal dates",
      );
      assert(
        details.status === "partial" &&
          details.complete === false &&
          displayedTotal?.precision === "lower_bound" &&
          displayedTotal.value <= terminal.count,
        "Saved traversal cannot imply complete snapshot",
      );
      const savedTraversal = {
        status: "verified",
        traversalComplete: true,
        snapshotVerified: false,
        count: terminal.count,
        pageCount: terminal.pages,
        startedAt,
        endedAt,
      };
      only(traversalCertificate.account, ["savedTraversal"]);
      only(traversalCertificate.detail, ["savedTraversal"]);
      for (const object of [
        traversalCertificate.account.savedTraversal,
        traversalCertificate.detail.savedTraversal,
      ]) {
        only(object, Object.keys(savedTraversal));
        assert.deepEqual(
          object,
          savedTraversal,
          "Review traversal metadata mismatch",
        );
      }
      assert(
        traversalCertificate.friendListStatus === details.status &&
          traversalCertificate.friendListComplete === details.complete &&
          traversalCertificate.observedAt === details.observedAt,
        "Review list metadata mismatch",
      );
      assert.deepEqual(
        traversalCertificate.displayedTotal,
        displayedTotal,
        "Review displayed total mismatch",
      );
      url(traversalCertificate.sourceUrl, account.username, true, true);
      assert(
        traversalCertificate.sourceUrl === shard.friendList.sourceUrl,
        "Review source URL mismatch",
      );
      accounts.at(-1).savedTraversal = savedTraversal;
      const detail = JSON.parse(files.get(`friends/${key}.json`));
      detail.savedTraversal = savedTraversal;
      files.set(`friends/${key}.json`, encode(detail));
    }
  }
  if (traversalCertificate)
    assert(
      accounts.some((account) => account.savedTraversal),
      "Unknown saved traversal review target",
    );
  assert(
    supplemental || supplementalTraversalReviews.length === 0,
    "Reviews require supplemental manifest",
  );
  const supplementalReviewPins = [];
  const supplements = [];
  let generatedAt = index.generatedAt;
  if (supplemental) {
    const normalized = await normalizePublicGmSupplement(
      supplemental,
      pointer.generation,
      initialTraversalReviews,
    );
    supplements.push(normalized.pin);
    if (normalized.reviewPins)
      supplementalReviewPins.push(...normalized.reviewPins);
    for (const candidate of normalized.candidates) {
      const key = candidate.username.toLowerCase();
      const account = accounts.find(
        (row) => row.username.toLowerCase() === key,
      );
      assert(account, "Unknown supplemental target");
      assert(
        !account.savedTraversal,
        "Supplement conflicts with saved traversal review",
      );
      account.friendList = list(candidate.friendList);
      if (candidate.savedTraversal)
        account.savedTraversal = candidate.savedTraversal;
      files.set(
        `friends/${key}.json`,
        encode({
          schemaVersion: 1,
          generation: pointer.generation,
          username: account.username,
          generatedAt: candidate.generatedAt,
          friendList: candidate.friendList,
          ...(candidate.savedTraversal
            ? { savedTraversal: candidate.savedTraversal }
            : {}),
        }),
      );
      if (Date.parse(candidate.generatedAt) > Date.parse(generatedAt))
        generatedAt = candidate.generatedAt;
    }
  }
  for (const key of Object.keys(coverage)) coverage[key] = 0;
  for (const account of accounts)
    coverage[`${account.friendList.status}Lists`]++;
  const snapshot = index.roster?.publishedApiSnapshot;
  const roster = {
    sourceUrl: url(snapshot?.sourceUrl),
    observedAt: date(snapshot?.observedAt),
    lastModified: snapshot?.lastModified ?? null,
    scope: snapshot?.scope ?? null,
    accounts: snapshot?.accounts ?? null,
  };
  assert(
    nullableText(roster.lastModified) &&
      nullableText(roster.scope) &&
      (roster.accounts === null || integer(roster.accounts)),
    "Invalid roster metadata",
  );
  files.set(
    "index.json",
    encode({
      schemaVersion: 1,
      generation: pointer.generation,
      generatedAt,
      roster,
      accounts,
      coverage,
    }),
  );
  const sourcePins = {
    pointerSha256: sha(pointerBytes),
    manifest: { bytes: manifestBytes.length, sha256: sha(manifestBytes) },
    index: {
      bytes: manifest.files["gm-index.json"].bytes,
      sha256: manifest.files["gm-index.json"].sha256,
    },
  };
  const content = Object.fromEntries(
    [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bytes]) => {
        const object = JSON.parse(bytes);
        delete object.generation;
        return [name, object];
      }),
  );
  const publicGeneration = sha(
    encode(
      canonical({
        schemaVersion: 1,
        baseGmGeneration: pointer.generation,
        source: sourcePins,
        supplements,
        ...(supplementalReviewPins.length
          ? { supplementalTraversalReviews: supplementalReviewPins }
          : {}),
        ...(traversalPin ? { savedTraversalReview: traversalPin } : {}),
        content,
      }),
    ),
  );
  for (const [name, bytes] of files) {
    const object = JSON.parse(bytes);
    object.generation = publicGeneration;
    files.set(name, encode(object));
  }
  const pins = Object.fromEntries(
    [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bytes]) => [
        name,
        { bytes: bytes.length, sha256: sha(bytes) },
      ]),
  );
  await mkdir(output, { recursive: true });
  const stage = join(output, `.stage-${randomUUID()}`);
  const destination = join(output, publicGeneration);
  try {
    await mkdir(join(stage, "friends"), { recursive: true });
    for (const [name, bytes] of files)
      await writeFile(join(stage, name), bytes, { flag: "wx" });
    if (beforeInstall) await beforeInstall();
    assert(
      (await bounded(root, "gm-publication.json", 16384)).equals(pointerBytes),
      "Selected pointer changed",
    );
    assert(
      (await bounded(root, pointer.manifest, 4 * 1024 * 1024)).equals(
        manifestBytes,
      ),
      "Selected manifest changed",
    );
    await bounded(
      publishedRoot,
      "gm-index.json",
      8 * 1024 * 1024,
      manifest.files["gm-index.json"],
    );
    for (const account of accounts) {
      const name = `gm-friends/${account.username.toLowerCase()}.json`;
      await bounded(
        publishedRoot,
        name,
        MAX_GM_SHARD_BYTES,
        manifest.files[name],
      );
    }
    if (supplemental) {
      const check = await normalizePublicGmSupplement(
        supplemental,
        pointer.generation,
        initialTraversalReviews,
      );
      assert.deepEqual(check.pin, supplements[0], "Supplement changed");
      assert.deepEqual(
        supplementalTraversalReviews,
        initialTraversalReviews,
        "Traversal associations changed",
      );
      assert.deepEqual(
        check.reviewPins ?? [],
        supplementalReviewPins,
        "Traversal review pins changed",
      );
    }
    if (savedTraversalReview)
      await bounded(
        traversalRoot,
        basename(savedTraversalReview.certificatePath),
        65536,
        traversalPin,
      );
    let exists = false;
    try {
      await stat(destination);
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (exists) {
      assert.deepEqual(
        await treeNames(destination),
        Object.keys(pins).sort(),
        "Immutable generation file set differs",
      );
      for (const [name, bytes] of files)
        assert(
          (
            await bounded(
              await realpath(destination),
              name,
              bytes.length,
              pins[name],
            )
          ).equals(bytes),
          "Immutable generation differs",
        );
    } else await rename(stage, destination);
    const selection = join(output, `.current-${randomUUID()}.json`);
    await writeFile(
      selection,
      encode({
        schemaVersion: 1,
        generation: publicGeneration,
        baseGmGeneration: pointer.generation,
      }),
      { flag: "wx" },
    );
    await rename(selection, join(output, "current.json"));
    return {
      generation: publicGeneration,
      baseGmGeneration: pointer.generation,
      source: sourcePins,
      supplements,
      ...(supplementalReviewPins.length
        ? { supplementalTraversalReviews: supplementalReviewPins }
        : {}),
      ...(traversalPin ? { savedTraversalReview: traversalPin } : {}),
      files: pins,
      aggregateSha256: sha(encode(pins)),
      bytes: Object.values(pins).reduce((sum, pin) => sum + pin.bytes, 0),
      accounts: accounts.length,
      coverage,
    };
  } finally {
    const stageDelta = relative(output, resolve(stage));
    assert(
      stageDelta &&
        !isAbsolute(stageDelta) &&
        !stageDelta.startsWith("..") &&
        stageDelta.startsWith(".stage-"),
      "Unsafe stage cleanup path",
    );
    await rm(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    assert(at >= 0 && args[at + 1], `Missing ${name}`);
    return args[at + 1];
  };
  const receipt = await exportPublicGmData({
    sourceDir: option("--source"),
    outputDir: option("--output"),
    ...(args.includes("--supplement")
      ? {
          supplemental: {
            manifestPath: option("--supplement"),
            expectedSha256: option("--supplement-sha256"),
          },
        }
      : {}),
    ...(args.includes("--saved-traversal-review")
      ? {
          savedTraversalReview: {
            certificatePath: option("--saved-traversal-review"),
            expectedSha256: option("--saved-traversal-review-sha256"),
          },
        }
      : {}),
  });
  const { files, ...summary } = receipt;
  console.log(
    JSON.stringify(
      { ...summary, fileCount: Object.keys(files).length },
      null,
      2,
    ),
  );
}
