import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  rename,
  symlink,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { exportPublicGmData } from "../scripts/export-public-gm-data.mjs";

const scaleFriends = () =>
  Array.from({ length: 17000 }, (_, i) => {
    const username = `ScaleFriend_${String(i).padStart(5, "0")}`;
    return {
      username,
      title: null,
      profileUrl: `https://www.chess.com/member/${username.toLowerCase()}`,
    };
  });

async function repinSelected(options, name, descriptor) {
  const manifestPath = join(options.publishedDir, "publication-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.files[name] = descriptor;
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, bytes);
  const pointerPath = join(options.sourceDir, "gm-publication.json");
  const pointer = JSON.parse(await readFile(pointerPath));
  pointer.manifestSha256 = sha(bytes);
  await writeFile(pointerPath, JSON.stringify(pointer));
}

test("scale: selected full list exceeds 1 MiB in UTF-8 and passes final physical recheck", async (t) => {
  const options = await fixture(t, ({ index, shards }) => {
    const friends = scaleFriends();
    const friendList = {
      status: "complete",
      complete: true,
      enumeratedCount: friends.length,
      observedAt: "2026-09-30T00:00:00Z",
    };
    index.accounts[1].friendList = friendList;
    shards[1].friendList = {
      ...friendList,
      friends,
      sourceUrl: url("Partial") + "/friends",
      displayedTotal: {
        value: friends.length,
        display: String(friends.length),
        precision: "exact",
      },
      publicSourceNote: "é".repeat(25000),
    };
  });
  const bytes = await readFile(
    join(options.publishedDir, "gm-friends/partial.json"),
  );
  assert(bytes.length > 1024 * 1024);
  assert(bytes.length > bytes.toString().length);
  let reachedRecheck = false;
  const receipt = await exportPublicGmData({
    ...options,
    beforeInstall: () => {
      reachedRecheck = true;
    },
  });
  assert(reachedRecheck);
  const detail = JSON.parse(
    await readFile(
      join(options.outputDir, receipt.generation, "friends/partial.json"),
    ),
  );
  assert.equal(detail.friendList.friends.length, 17000);
  assert.equal(
    new Set(detail.friendList.friends.map((f) => f.username.toLowerCase()))
      .size,
    17000,
  );
  assert.equal(detail.friendList.complete, true);
  assert(!JSON.stringify(detail).includes("publicSourceNote"));
});

test("scale: pinned supplemental complete list exceeds 1 MiB with 17000 unique rows", async (t) => {
  const options = await fixture(t);
  const supplemental = await supplement(options, (c) => {
    c.friendList.friends = scaleFriends();
    c.friendList.enumeratedCount = 17000;
    c.friendList.displayedTotal = {
      value: 17000,
      display: "17000",
      precision: "exact",
    };
  });
  const bytes = await readFile(
    join(options.sourceDir, "reviewed/partial.json"),
  );
  assert(bytes.length > 1024 * 1024);
  const receipt = await exportPublicGmData({ ...options, supplemental });
  const detail = JSON.parse(
    await readFile(
      join(options.outputDir, receipt.generation, "friends/partial.json"),
    ),
  );
  assert.equal(detail.friendList.friends.length, 17000);
  assert.equal(detail.friendList.displayedTotal.value, 17000);
});

for (const kind of ["selected", "supplemental"])
  test(`scale: ${kind} file above 25 MiB rejected before JSON read`, async (t) => {
    const options = await fixture(t);
    let supplemental;
    const path =
      kind === "selected"
        ? join(options.publishedDir, "gm-friends/partial.json")
        : join(options.sourceDir, "reviewed/partial.json");
    if (kind === "supplemental") supplemental = await supplement(options);
    const size = 25 * 1024 * 1024 + 1;
    const handle = await open(path, "w");
    await handle.truncate(size);
    await handle.close();
    const descriptor = { bytes: size, sha256: "0".repeat(64) };
    if (kind === "selected")
      await repinSelected(options, "gm-friends/partial.json", descriptor);
    else {
      const manifest = JSON.parse(await readFile(supplemental.manifestPath));
      Object.assign(manifest.candidates[0], descriptor);
      const bytes = Buffer.from(JSON.stringify(manifest));
      await writeFile(supplemental.manifestPath, bytes);
      supplemental.expectedSha256 = sha(bytes);
    }
    await assert.rejects(
      exportPublicGmData({ ...options, supplemental }),
      /Input exceeds bound/,
    );
    await assert.rejects(access(join(options.outputDir, "current.json")));
  });

test("scale: final recheck refuses growth above 25 MiB", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    exportPublicGmData({
      ...options,
      beforeInstall: async () => {
        const handle = await open(
          join(options.publishedDir, "gm-friends/partial.json"),
          "r+",
        );
        try {
          await handle.truncate(25 * 1024 * 1024 + 1);
        } finally {
          await handle.close();
        }
      },
    }),
    /Input exceeds bound/,
  );
  await assert.rejects(access(join(options.outputDir, "current.json")));
});

const generation = "a".repeat(64),
  observedAt = "2026-10-01T00:00:00Z";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const url = (name) => `https://www.chess.com/member/${name.toLowerCase()}`;
async function fixture(t, mutate = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "gm-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, "source"),
    outputDir = join(root, "output");
  await mkdir(sourceDir);
  const accounts = ["Zero", "Partial", "Unknown"].map((username, i) => ({
    username,
    title: "GM",
    profileUrl: url(username),
    friendsUrl: url(username) + "/friends",
    isYourFriend: true,
    secret: { password: "NEVER_PUBLIC" },
    friendCount: {
      value: i === 2 ? null : i,
      display: i === 2 ? null : String(i),
      precision: i === 2 ? "unknown" : i === 1 ? "lower_bound" : "exact",
      observedAt,
      sourceType: "chess_com_mobile_api",
      sourceUrl: url(username),
      rawProof: "NEVER_PUBLIC",
    },
    friendList: {
      status: ["complete", "partial", "unknown"][i],
      complete: i === 0,
      enumeratedCount: i === 1 ? 1 : 0,
      observedAt: i === 2 ? null : "2026-09-30T00:00:00Z",
    },
  }));
  const shards = accounts.map((a) => ({
    username: a.username.toLowerCase(),
    generatedAt: observedAt,
    friendList: {
      ...a.friendList,
      sourceUrl: a.friendsUrl,
      displayedTotal: {
        value: a.friendCount.value,
        display: a.friendCount.display,
        precision: a.friendCount.precision,
        proof: "NEVER_PUBLIC",
      },
      friends: a.friendList.enumeratedCount
        ? [
            {
              username: "Friend",
              title: null,
              profileUrl: url("Friend"),
              isAkshitFriend: true,
              credential: "NEVER_PUBLIC",
            },
          ]
        : [],
      history: ["NEVER_PUBLIC"],
    },
  }));
  const index = { schemaVersion: 1, generatedAt: observedAt, accounts };
  mutate({ index, shards });
  const publishedDir = join(sourceDir, "gm-publications", generation);
  const files = {};
  async function save(name, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    const base = name.startsWith("gm-publications/") ? sourceDir : publishedDir;
    await mkdir(join(base, name, ".."), { recursive: true });
    await writeFile(join(base, name), bytes);
    files[name] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  await save("gm-index.json", index);
  for (let i = 0; i < shards.length; i++)
    await save(
      `gm-friends/${accounts[i].username.toLowerCase()}.json`,
      shards[i],
    );
  const manifest = {
    schemaVersion: 1,
    target: "gm",
    generation,
    validation: { passed: true, fullScope: true, accounts: accounts.length },
    files,
  };
  const manifestName = `gm-publications/${generation}/publication-manifest.json`;
  await save(manifestName, manifest);
  await writeFile(
    join(sourceDir, "gm-publication.json"),
    JSON.stringify({
      schemaVersion: 1,
      target: "gm",
      generation,
      manifest: manifestName,
      manifestSha256: files[manifestName].sha256,
    }),
  );
  await writeFile(join(sourceDir, "gm-index.json"), '{"canonicalDecoy":true}');
  return { sourceDir, publishedDir, outputDir, index, shards };
}
test("projects exact public fields, preserves honest dates and zero/partial/unknown counts, deterministic lazy shards", async (t) => {
  const options = await fixture(t);
  const first = await exportPublicGmData(options),
    second = await exportPublicGmData(options);
  assert.deepEqual(first, second);
  assert.deepEqual(first.coverage, {
    completeLists: 1,
    partialLists: 1,
    unknownLists: 1,
  });
  for (const name of Object.keys(first.files)) {
    const bytes = await readFile(
      join(options.outputDir, first.generation, name),
    );
    assert.equal(sha(bytes), first.files[name].sha256);
    assert(!bytes.toString().includes("NEVER_PUBLIC"));
    assert(
      !/isYourFriend|isAkshitFriend|history|rawProof|credential/.test(bytes),
    );
  }
  const index = JSON.parse(
    await readFile(join(options.outputDir, first.generation, "index.json")),
  );
  assert.equal(index.accounts[0].friendCount.value, 0);
  assert.equal(index.accounts[1].friendCount.precision, "lower_bound");
  assert.notEqual(
    index.accounts[1].friendCount.observedAt,
    index.accounts[1].friendList.observedAt,
  );
  assert.equal(index.accounts[2].friendCount.value, null);
  assert.equal(index.accounts[2].friendList.status, "unknown");
  const detail = JSON.parse(
    await readFile(
      join(options.outputDir, first.generation, "friends/partial.json"),
    ),
  );
  assert.deepEqual(Object.keys(detail.friendList.displayedTotal), [
    "value",
    "display",
    "precision",
  ]);
  assert.equal(detail.friendList.complete, false);
});
for (const [name, mutate] of [
  [
    "duplicate account case",
    ({ index }) => (index.accounts[1].username = "zERO"),
  ],
  [
    "duplicate friend case",
    ({ shards, index }) => {
      shards[1].friendList.friends.push({
        ...shards[1].friendList.friends[0],
        username: "fRIEND",
      });
      shards[1].friendList.enumeratedCount =
        index.accounts[1].friendList.enumeratedCount = 2;
    },
  ],
  ["wrong shard identity", ({ shards }) => (shards[0].username = "Other")],
  [
    "inconsistent status",
    ({ shards }) => (shards[0].friendList.complete = false),
  ],
  [
    "unknown numeric count",
    ({ index }) => (index.accounts[2].friendCount.value = 0),
  ],
])
  test(`rejects ${name} before install`, async (t) => {
    const options = await fixture(t, mutate);
    await assert.rejects(exportPublicGmData(options));
    await assert.rejects(access(join(options.outputDir, generation)));
  });
test("pin corruption and pointer changes cannot install", async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.publishedDir, "gm-friends/zero.json"), "{}");
  await assert.rejects(exportPublicGmData(options));
  await assert.rejects(access(join(options.outputDir, generation)));
});
test("pointer race and differing immutable generation fail closed", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    exportPublicGmData({
      ...options,
      beforeInstall: () =>
        writeFile(join(options.sourceDir, "gm-publication.json"), "{}"),
    }),
    /pointer changed/,
  );
  await assert.rejects(access(join(options.outputDir, generation)));
  const fresh = await fixture(t);
  const receipt = await exportPublicGmData(fresh);
  await writeFile(
    join(fresh.outputDir, receipt.generation, "index.json"),
    "{}",
  );
  await assert.rejects(exportPublicGmData(fresh));
});
for (const mode of ["missing-pin", "scope", "oversize", "manifest-hash"])
  test(`rejects malformed ${mode} source before install`, async (t) => {
    const options = await fixture(t);
    const pointerPath = join(options.sourceDir, "gm-publication.json");
    const pointer = JSON.parse(await readFile(pointerPath));
    const manifestPath = join(options.sourceDir, pointer.manifest);
    const manifest = JSON.parse(await readFile(manifestPath));
    if (mode === "missing-pin") delete manifest.files["gm-index.json"];
    if (mode === "scope") manifest.validation.fullScope = false;
    if (mode === "oversize")
      manifest.files["gm-friends/zero.json"].bytes = 2 * 1024 * 1024;
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(manifestPath, bytes);
    pointer.manifestSha256 =
      mode === "manifest-hash" ? "0".repeat(64) : sha(bytes);
    await writeFile(pointerPath, JSON.stringify(pointer));
    await assert.rejects(exportPublicGmData(options));
    await assert.rejects(access(join(options.outputDir, generation)));
  });
async function supplement(options, mutate = () => {}) {
  const directory = join(options.sourceDir, "reviewed");
  await mkdir(directory);
  const candidate = {
    schemaVersion: 1,
    baseGmGeneration: generation,
    username: "pARTIAL",
    generatedAt: "2026-10-02T00:00:00Z",
    friendList: {
      status: "complete",
      complete: true,
      enumeratedCount: 0,
      observedAt: "2026-10-02T00:00:00Z",
      sourceUrl: url("Partial") + "/friends",
      displayedTotal: { value: 0, display: "0", precision: "exact" },
      friends: [],
    },
  };
  const manifest = {
    schemaVersion: 1,
    baseGmGeneration: generation,
    candidates: [],
  };
  mutate(candidate, manifest);
  const bytes = Buffer.from(JSON.stringify(candidate));
  await writeFile(join(directory, "partial.json"), bytes);
  const descriptor = {
    username: candidate.username,
    path: "partial.json",
    bytes: bytes.length,
    sha256: sha(bytes),
  };
  manifest.candidates.unshift(descriptor);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, manifestBytes);
  return { manifestPath, expectedSha256: sha(manifestBytes) };
}
test("supplement derives new generation, updates only target list, preserves count and all other content", async (t) => {
  const options = await fixture(t);
  const baseline = await exportPublicGmData(options);
  assert.notEqual(baseline.generation, generation);
  const supplemental = await supplement(options);
  const patched = await exportPublicGmData({ ...options, supplemental });
  assert.notEqual(patched.generation, baseline.generation);
  assert.equal(patched.baseGmGeneration, generation);
  assert.deepEqual(
    patched,
    await exportPublicGmData({ ...options, supplemental }),
  );
  const get = async (receipt, name) =>
    JSON.parse(
      await readFile(join(options.outputDir, receipt.generation, name)),
    );
  const before = await get(baseline, "index.json"),
    after = await get(patched, "index.json");
  assert.deepEqual(after.accounts[0], before.accounts[0]);
  assert.deepEqual(after.accounts[2], before.accounts[2]);
  assert.deepEqual(
    after.accounts[1].friendCount,
    before.accounts[1].friendCount,
  );
  assert.equal(after.accounts[1].friendList.status, "complete");
  assert.equal(after.generatedAt, "2026-10-02T00:00:00Z");
  for (const name of ["friends/zero.json", "friends/unknown.json"]) {
    const a = await get(baseline, name),
      b = await get(patched, name);
    assert.equal(b.generation, patched.generation);
    delete a.generation;
    delete b.generation;
    assert.deepEqual(a, b);
  }
  assert.deepEqual(
    JSON.parse(await readFile(join(options.outputDir, "current.json"))),
    {
      schemaVersion: 1,
      generation: patched.generation,
      baseGmGeneration: generation,
    },
  );
  await assert.rejects(access(join(options.outputDir, generation)));
});
for (const [name, mutate] of [
  ["wrong base", (c, m) => (m.baseGmGeneration = "b".repeat(64))],
  ["candidate generation", (c) => (c.baseGmGeneration = "b".repeat(64))],
  ["unknown target", (c) => (c.username = "Absent")],
  ["unauthorized field", (c) => (c.friendList.history = ["private"])],
  [
    "duplicate target",
    (c, m) =>
      m.candidates.push({
        username: "PARTIAL",
        path: "partial.json",
        bytes: 1,
        sha256: "a".repeat(64),
      }),
  ],
])
  test(`supplement rejects ${name} before install`, async (t) => {
    const options = await fixture(t);
    const supplemental = await supplement(options, mutate);
    await assert.rejects(exportPublicGmData({ ...options, supplemental }));
    await assert.rejects(access(join(options.outputDir, "current.json")));
  });
test("supplement candidate and caller manifest pins are required", async (t) => {
  const options = await fixture(t);
  const supplemental = await supplement(options);
  await assert.rejects(
    exportPublicGmData({
      ...options,
      supplemental: { ...supplemental, expectedSha256: "0".repeat(64) },
    }),
  );
  await writeFile(join(options.sourceDir, "reviewed/partial.json"), "{}");
  await assert.rejects(exportPublicGmData({ ...options, supplemental }));
  await assert.rejects(access(join(options.outputDir, "current.json")));
});
test("missing legacy nullable count metadata is explicit null and canonical decoys are ignored", async (t) => {
  const options = await fixture(t, ({ index }) => {
    for (const key of ["display", "observedAt", "sourceType", "sourceUrl"])
      delete index.accounts[2].friendCount[key];
  });
  const receipt = await exportPublicGmData(options);
  const index = JSON.parse(
    await readFile(join(options.outputDir, receipt.generation, "index.json")),
  );
  assert.deepEqual(index.accounts[2].friendCount, {
    value: null,
    display: null,
    precision: "unknown",
    observedAt: null,
    sourceType: null,
    sourceUrl: null,
  });
});
for (const invalid of [
  "2026-02-30T00:00:00Z",
  "2026-10-01T00:00:00+00:00",
  "2026-10-01",
])
  test(`rejects noncanonical date ${invalid}`, async (t) => {
    const options = await fixture(
      t,
      ({ index }) => (index.accounts[0].friendCount.observedAt = invalid),
    );
    await assert.rejects(exportPublicGmData(options));
  });
test("rechecks selected physical inputs before install", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    exportPublicGmData({
      ...options,
      beforeInstall: () =>
        writeFile(join(options.publishedDir, "gm-friends/zero.json"), "{}"),
    }),
  );
  await assert.rejects(access(join(options.outputDir, "current.json")));
});
test("source public query retained while credential query and wrong identity fail", async (t) => {
  const options = await fixture(
    t,
    ({ shards }) => (shards[1].friendList.sourceUrl += "?page=2&sort=name"),
  );
  const receipt = await exportPublicGmData(options);
  const detail = JSON.parse(
    await readFile(
      join(options.outputDir, receipt.generation, "friends/partial.json"),
    ),
  );
  assert(detail.friendList.sourceUrl.endsWith("?page=2&sort=name"));
  const bad = await fixture(
    t,
    ({ index }) => (index.accounts[0].profileUrl = url("Other")),
  );
  await assert.rejects(exportPublicGmData(bad));
  const credential = await fixture(
    t,
    ({ shards }) => (shards[0].friendList.sourceUrl += "?token=secret"),
  );
  await assert.rejects(exportPublicGmData(credential));
});
test("rejects selected shard directory symlink aliases", async (t) => {
  const options = await fixture(t);
  const original = join(options.publishedDir, "gm-friends"),
    moved = join(options.publishedDir, "actual-friends");
  await rename(original, moved);
  await symlink(
    moved,
    original,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(exportPublicGmData(options), /symlink alias/);
  await assert.rejects(access(join(options.outputDir, "current.json")));
});
test("roster preserves precise UTC date and HTTP lastModified while dropping headers", async (t) => {
  const options = await fixture(
    t,
    ({ index }) =>
      (index.roster = {
        publishedApiSnapshot: {
          sourceUrl: "https://api.chess.com/pub/titled/GM",
          observedAt: "2026-10-03T21:56:32.9357677Z",
          lastModified: "Saturday, 03-Oct-2026 12:44:42 GMT+0000",
          scope: "published_GM_API_snapshot",
          accounts: 3,
          allowedHeaders: { secret: "NEVER_PUBLIC" },
        },
      }),
  );
  const receipt = await exportPublicGmData(options);
  const index = JSON.parse(
    await readFile(join(options.outputDir, receipt.generation, "index.json")),
  );
  assert.equal(index.roster.observedAt, "2026-10-03T21:56:32.9357677Z");
  assert.equal(
    index.roster.lastModified,
    "Saturday, 03-Oct-2026 12:44:42 GMT+0000",
  );
  assert(!JSON.stringify(index).includes("allowedHeaders"));
});
test("supplement permits contained absolute descriptors and rejects absolute escapes", async (t) => {
  const options = await fixture(t);
  const supplemental = await supplement(options);
  const manifest = JSON.parse(await readFile(supplemental.manifestPath));
  manifest.candidates[0].path = join(
    options.sourceDir,
    "reviewed/partial.json",
  );
  let bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(supplemental.manifestPath, bytes);
  supplemental.expectedSha256 = sha(bytes);
  await exportPublicGmData({ ...options, supplemental });
  manifest.candidates[0].path = join(options.publishedDir, "gm-index.json");
  bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(supplemental.manifestPath, bytes);
  supplemental.expectedSha256 = sha(bytes);
  await assert.rejects(
    exportPublicGmData({ ...options, supplemental }),
    /Invalid source path/,
  );
});
test("output directory aliases are refused", async (t) => {
  const options = await fixture(t);
  const actual = join(options.sourceDir, "output-real");
  await mkdir(actual);
  await symlink(
    actual,
    options.outputDir,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(exportPublicGmData(options), /Output symlink/);
});

for (const [name, mutate] of [
  ["null displayed total", (c) => (c.friendList.displayedTotal = null)],
  [
    "unknown displayed total",
    (c) =>
      (c.friendList.displayedTotal = {
        value: null,
        display: null,
        precision: "unknown",
      }),
  ],
  [
    "lower bound displayed total",
    (c) => (c.friendList.displayedTotal.precision = "lower_bound"),
  ],
  ["missing complete date", (c) => (c.friendList.observedAt = null)],
  [
    "future complete date",
    (c) => (c.friendList.observedAt = "2026-10-03T00:00:00Z"),
  ],
  [
    "future partial date",
    (c) => {
      c.friendList.status = "partial";
      c.friendList.complete = false;
      c.friendList.observedAt = "2026-10-03T00:00:00Z";
    },
  ],
  [
    "nanosecond future date",
    (c) => {
      c.generatedAt = "2026-10-02T00:00:00.000000001Z";
      c.friendList.observedAt = "2026-10-02T00:00:00.000000002Z";
    },
  ],
  [
    "different source owner",
    (c) => (c.friendList.sourceUrl = url("Other") + "/friends"),
  ],
  ["different source route", (c) => (c.friendList.sourceUrl = url("Partial"))],
  ["source fragment", (c) => (c.friendList.sourceUrl += "#fragment")],
  [
    "source userinfo",
    (c) =>
      (c.friendList.sourceUrl =
        "https://secret@www.chess.com/member/partial/friends"),
  ],
]) {
  test(`supplement rejects ${name} before install`, async (t) => {
    const options = await fixture(t);
    const supplemental = await supplement(options, mutate);
    await assert.rejects(exportPublicGmData({ ...options, supplemental }));
    await assert.rejects(access(join(options.outputDir, "current.json")));
  });
}

test("supplement owner-bound public pagination queries remain unchanged", async (t) => {
  const options = await fixture(t);
  const supplemental = await supplement(options, (candidate) => {
    candidate.friendList.sourceUrl += "?sortby=alphabetical&page=2";
  });
  const receipt = await exportPublicGmData({ ...options, supplemental });
  const detail = JSON.parse(
    await readFile(
      join(options.outputDir, receipt.generation, "friends/partial.json"),
    ),
  );
  assert.equal(
    detail.friendList.sourceUrl,
    url("Partial") + "/friends?sortby=alphabetical&page=2",
  );
});

async function traversalFixture(t, mutate = () => {}) {
  let terminal;
  const options = await fixture(t, ({ index, shards }) => {
    terminal = {
      status: "verified",
      scope: "saved_terminal_traversal",
      snapshotVerified: false,
      traversalComplete: true,
      count: 1,
      rawRows: 1,
      pages: 1,
      startedAt: "2026-09-29T00:00:00Z",
      endedAt: "2026-09-30T00:00:00Z",
      method: "alphabetical_public_pagination",
      issues: [],
    };
    shards[1].friendList.terminalEnumeration = terminal;
    index.accounts[1].friendCount = {
      ...index.accounts[1].friendCount,
      value: 4,
      display: "4",
      precision: "exact",
    };
    mutate(terminal);
  });
  const manifest = JSON.parse(
    await readFile(join(options.publishedDir, "publication-manifest.json")),
  );
  const savedTraversal = {
    status: "verified",
    traversalComplete: true,
    snapshotVerified: false,
    count: 1,
    pageCount: 1,
    startedAt: "2026-09-29T00:00:00Z",
    endedAt: "2026-09-30T00:00:00Z",
  };
  const certificate = {
    schemaVersion: 1,
    kind: "public_saved_traversal_review",
    status: "verified",
    baseGmGeneration: generation,
    username: "Partial",
    sourceUrl: url("Partial") + "/friends",
    observedAt: "2026-09-30T00:00:00Z",
    friendListStatus: "partial",
    friendListComplete: false,
    displayedTotal: { value: 1, display: "1", precision: "lower_bound" },
    exactCurrentCountCertified: false,
    atomicSnapshotCertified: false,
    account: { savedTraversal },
    detail: { savedTraversal },
    sourceShard: manifest.files["gm-friends/partial.json"],
    consumerSha256: "c".repeat(64),
    input: { bytes: 100, sha256: "d".repeat(64) },
    terminalEnumerationSha256: sha(Buffer.from(JSON.stringify(terminal))),
    qualification: "Complete saved traversal; current snapshot unverified.",
  };
  const bytes = Buffer.from(JSON.stringify(certificate));
  const certificatePath = join(options.sourceDir, "public-review.json");
  await writeFile(certificatePath, bytes);
  return {
    ...options,
    savedTraversalReview: { certificatePath, expectedSha256: sha(bytes) },
    certificate,
  };
}

test("reviewed saved traversal projects strict metadata without changing count/list semantics", async (t) => {
  const options = await traversalFixture(t);
  const baseline = await exportPublicGmData({
    ...options,
    savedTraversalReview: undefined,
  });
  const receipt = await exportPublicGmData(options);
  const before = JSON.parse(
    await readFile(join(options.outputDir, baseline.generation, "index.json")),
  );
  const index = JSON.parse(
    await readFile(join(options.outputDir, receipt.generation, "index.json")),
  );
  const detail = JSON.parse(
    await readFile(
      join(options.outputDir, receipt.generation, "friends/partial.json"),
    ),
  );
  assert.deepEqual(
    index.accounts[1].savedTraversal,
    options.certificate.account.savedTraversal,
  );
  assert.deepEqual(detail.savedTraversal, index.accounts[1].savedTraversal);
  assert.deepEqual(
    index.accounts[1].friendCount,
    before.accounts[1].friendCount,
  );
  assert.equal(index.accounts[1].friendCount.value, 4);
  assert.equal(detail.friendList.status, "partial");
  assert.equal(detail.friendList.complete, false);
  assert.equal(detail.friendList.displayedTotal.precision, "lower_bound");
  assert.equal(detail.friendList.displayedTotal.value, 1);
  assert.equal(before.accounts[1].savedTraversal, undefined);
  assert.deepEqual(Object.keys(detail.savedTraversal), [
    "status",
    "traversalComplete",
    "snapshotVerified",
    "count",
    "pageCount",
    "startedAt",
    "endedAt",
  ]);
  assert.deepEqual(
    await exportPublicGmData({ ...options, savedTraversalReview: undefined }),
    baseline,
  );
});
for (const [name, mutate] of [
  ["count mismatch", (e) => (e.count = 2)],
  ["raw rows mismatch", (e) => (e.rawRows = 2)],
  ["zero pages", (e) => (e.pages = 0)],
  ["fractional pages", (e) => (e.pages = 1.5)],
  ["missing start", (e) => delete e.startedAt],
  ["reversed dates", (e) => (e.startedAt = "2026-10-01T00:00:00Z")],
  ["invalid calendar", (e) => (e.startedAt = "2026-02-30T00:00:00Z")],
  ["snapshot claimed", (e) => (e.snapshotVerified = true)],
  ["traversal unverified", (e) => (e.traversalComplete = false)],
  ["issues present", (e) => (e.issues = ["missing page"])],
])
  test(`saved traversal rejects ${name}`, async (t) => {
    const options = await traversalFixture(t, mutate);
    await assert.rejects(exportPublicGmData(options));
    await assert.rejects(access(join(options.outputDir, "current.json")));
  });
test("saved traversal rejects private certificate metadata and false certification", async (t) => {
  const options = await traversalFixture(t);
  options.certificate.account.savedTraversal.history = ["PRIVATE"];
  let bytes = Buffer.from(JSON.stringify(options.certificate));
  await writeFile(options.savedTraversalReview.certificatePath, bytes);
  options.savedTraversalReview.expectedSha256 = sha(bytes);
  await assert.rejects(exportPublicGmData(options));
  delete options.certificate.account.savedTraversal.history;
  options.certificate.atomicSnapshotCertified = true;
  bytes = Buffer.from(JSON.stringify(options.certificate));
  await writeFile(options.savedTraversalReview.certificatePath, bytes);
  options.savedTraversalReview.expectedSha256 = sha(bytes);
  await assert.rejects(exportPublicGmData(options));
});

for (const [name, mutate] of [
  [
    "contradictory terminal hash",
    (c) => (c.terminalEnumerationSha256 = "0".repeat(64)),
  ],
  [
    "extra private top-level field",
    (c) => (c.privateAccount = { password: "PRIVATE" }),
  ],
  [
    "extra private descriptor field",
    (c) => (c.input.path = "private-proof.json"),
  ],
  ["invalid declared input hash", (c) => (c.input.sha256 = "not-a-hash")],
]) {
  test(`saved traversal rejects ${name}`, async (t) => {
    const options = await traversalFixture(t);
    mutate(options.certificate);
    const bytes = Buffer.from(JSON.stringify(options.certificate));
    await writeFile(options.savedTraversalReview.certificatePath, bytes);
    options.savedTraversalReview.expectedSha256 = sha(bytes);
    await assert.rejects(exportPublicGmData(options));
    await assert.rejects(access(join(options.outputDir, "current.json")));
  });
}

test("FULL export of two independently reviewed new capped traversals preserves historical counts and third account", async (t) => {
  const options = await fixture(t);
  const baseline = await exportPublicGmData({
    ...options,
    outputDir: options.outputDir + "-prior",
  });
  const packet = join(options.sourceDir, "packet");
  await mkdir(packet);
  const candidates = [],
    reviews = [];
  for (const [username, count, bound] of [
    ["Partial", 24, 20],
    ["Unknown", 44, 40],
  ]) {
    const savedTraversal = {
      status: "verified",
      traversalComplete: true,
      snapshotVerified: false,
      count,
      pageCount: Math.ceil(count / 20),
      startedAt: "2026-10-01T00:00:00.000Z",
      endedAt: "2026-10-01T00:01:00.000Z",
    };
    const friendList = {
      status: "partial",
      complete: false,
      enumeratedCount: count,
      observedAt: savedTraversal.endedAt,
      sourceUrl: url(username) + "/friends?sortby=alphabetical",
      displayedTotal: {
        value: bound,
        display: bound + "+",
        precision: "lower_bound",
      },
      friends: Array.from({ length: count }, (_, i) => ({
        username: "friend" + String(i).padStart(3, "0"),
        title: null,
        profileUrl: url("friend" + String(i).padStart(3, "0")),
      })),
    };
    const candidate = {
      schemaVersion: 1,
      baseGmGeneration: generation,
      username,
      generatedAt: savedTraversal.endedAt,
      friendList,
      savedTraversal,
    };
    const bytes = Buffer.from(JSON.stringify(candidate)),
      candidatePath = join(packet, username.toLowerCase() + ".json");
    await writeFile(candidatePath, bytes);
    const pin = {
      username,
      path: candidatePath,
      bytes: bytes.length,
      sha256: sha(bytes),
    };
    candidates.push(pin);
    const cert = {
      schemaVersion: 1,
      kind: "public_new_capped_traversal_review",
      status: "verified",
      baseGmGeneration: generation,
      username,
      profileTitle: "GM",
      candidate: { bytes: bytes.length, sha256: sha(bytes) },
      input: { bytes: 500, sha256: "b".repeat(64) },
      savedTraversal,
      friendListStatus: "partial",
      friendListComplete: false,
      displayedTotal: friendList.displayedTotal,
      observedAt: friendList.observedAt,
      sourceUrl: friendList.sourceUrl,
      reviewedAt: "2026-10-02T00:00:00.000Z",
    };
    const cb = Buffer.from(JSON.stringify(cert)),
      certificatePath = join(packet, username.toLowerCase() + "-review.json");
    await writeFile(certificatePath, cb);
    reviews.push({
      username,
      certificatePath,
      bytes: cb.length,
      sha256: sha(cb),
    });
  }
  const mb = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        baseGmGeneration: generation,
        candidates,
      }),
    ),
    manifestPath = join(packet, "manifest.json");
  await writeFile(manifestPath, mb);
  const result = await exportPublicGmData({
    ...options,
    supplemental: { manifestPath, expectedSha256: sha(mb) },
    supplementalTraversalReviews: reviews,
  });
  assert.equal(result.supplementalTraversalReviews.length, 2);
  const index = JSON.parse(
      await readFile(join(options.outputDir, result.generation, "index.json")),
    ),
    old = JSON.parse(
      await readFile(
        join(options.outputDir + "-prior", baseline.generation, "index.json"),
      ),
    );
  assert.deepEqual(
    index.accounts.map((a) => a.friendCount),
    old.accounts.map((a) => a.friendCount),
  );
  assert.deepEqual(index.accounts[0], old.accounts[0]);
  assert.deepEqual(index.coverage, {
    completeLists: 1,
    partialLists: 2,
    unknownLists: 0,
  });
  for (const [username, count] of [
    ["Partial", 24],
    ["Unknown", 44],
  ]) {
    const a = index.accounts.find((a) => a.username === username),
      detail = JSON.parse(
        await readFile(
          join(
            options.outputDir,
            result.generation,
            "friends",
            username.toLowerCase() + ".json",
          ),
        ),
      );
    assert.equal(a.friendList.complete, false);
    assert.equal(detail.friendList.complete, false);
    assert.equal(detail.friendList.displayedTotal.precision, "lower_bound");
    assert.equal(a.savedTraversal.count, count);
    assert.deepEqual(a.savedTraversal, detail.savedTraversal);
    assert.equal(detail.friendList.friends.length, count);
  }
  const z = JSON.parse(
      await readFile(
        join(options.outputDir, result.generation, "friends/zero.json"),
      ),
    ),
    prior = JSON.parse(
      await readFile(
        join(
          options.outputDir + "-prior",
          baseline.generation,
          "friends/zero.json",
        ),
      ),
    );
  delete z.generation;
  delete prior.generation;
  assert.deepEqual(z, prior);
  const mutatedReviews = structuredClone(reviews),
    mutationOutput = options.outputDir + "-association-mutation";
  await assert.rejects(
    exportPublicGmData({
      ...options,
      outputDir: mutationOutput,
      supplemental: { manifestPath, expectedSha256: sha(mb) },
      supplementalTraversalReviews: mutatedReviews,
      beforeInstall: async () => {
        mutatedReviews[0].sha256 = "0".repeat(64);
      },
    }),
  );
  await assert.rejects(access(join(mutationOutput, "current.json")));
  const swappedReviews = structuredClone(reviews),
    swapOutput = options.outputDir + "-certificate-swap";
  await assert.rejects(
    exportPublicGmData({
      ...options,
      outputDir: swapOutput,
      supplemental: { manifestPath, expectedSha256: sha(mb) },
      supplementalTraversalReviews: swappedReviews,
      beforeInstall: async () => {
        const cert = JSON.parse(
          await readFile(swappedReviews[0].certificatePath),
        );
        cert.reviewedAt = "2026-10-03T00:00:00.000Z";
        const replacement = Buffer.from(JSON.stringify(cert));
        await writeFile(swappedReviews[0].certificatePath, replacement);
        swappedReviews[0].bytes = replacement.length;
        swappedReviews[0].sha256 = sha(replacement);
      },
    }),
  );
  await assert.rejects(access(join(swapOutput, "current.json")));
});
