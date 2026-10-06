import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import {
  createSiteZip,
  packageSite,
  SITE_ASSETS,
} from "../scripts/package-site.mjs";
const fixtureBytes = (name) =>
  Buffer.from(
    name === "release.json" ? '{"version":1}\n' : `fixture:${name}\n\0`,
    "utf8",
  );

async function fixture(run) {
  const workspace = await mkdtemp(join(tmpdir(), "chess-site-package-"));
  const directory = join(workspace, "dist");
  try {
    await mkdir(join(directory, "data"), { recursive: true });
    for (const name of SITE_ASSETS)
      await writeFile(join(directory, name), fixtureBytes(name));
    await run(directory, join(workspace, "verification"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("ZIP has exact root-relative filenames and preserves every byte reproducibly", () =>
  fixture(async (directory) => {
    const first = await createSiteZip(directory),
      second = await createSiteZip(directory);
    assert.deepEqual(first, second);
    const files = unzipSync(first);
    assert.deepEqual(Object.keys(files).sort(), [...SITE_ASSETS].sort());
    for (const name of SITE_ASSETS)
      assert.deepEqual(Buffer.from(files[name]), fixtureBytes(name));
    assert.ok(files["index.html"] && files["data/dataset.json"]);
  }));

test("missing assets and unexpected private files/directories are rejected", () =>
  fixture(async (directory) => {
    await rm(join(directory, "index.html"));
    await assert.rejects(createSiteZip(directory), /Missing deploy asset/);
    await writeFile(join(directory, "index.html"), "restored");
    await writeFile(join(directory, "private-evidence.json"), "private");
    await assert.rejects(createSiteZip(directory), /Unexpected deploy asset/);
    await rm(join(directory, "private-evidence.json"));
    await mkdir(join(directory, ".git"));
    await assert.rejects(
      createSiteZip(directory),
      /Unexpected deploy directory/,
    );
  }));

test("assets over 25 MiB are rejected before packaging", () =>
  fixture(async (directory) => {
    await truncate(join(directory, "app.mjs"), 25 * 1024 * 1024 + 1);
    await assert.rejects(createSiteZip(directory), /Oversized deploy asset/);
  }));

test("successive packages preserve older archives and bind receipts to every file", () =>
  fixture(async (sourceDirectory, outputDirectory) => {
    await mkdir(outputDirectory);
    const legacy = join(outputDirectory, "cloudflare-site.zip");
    await writeFile(legacy, "preserved legacy package");
    const first = await packageSite({ sourceDirectory, outputDirectory });
    const firstArchive = await readFile(first.output);
    const firstReceipt = await readFile(first.receipt);
    await writeFile(
      join(sourceDirectory, "data/dataset.json"),
      "next public dataset",
    );
    const second = await packageSite({ sourceDirectory, outputDirectory });
    assert.notEqual(second.output, first.output);
    assert.notEqual(second.receipt, first.receipt);
    assert.equal(await readFile(legacy, "utf8"), "preserved legacy package");
    assert.deepEqual(await readFile(first.output), firstArchive);
    assert.deepEqual(await readFile(first.receipt), firstReceipt);
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    for (const result of [first, second]) {
      const archive = await readFile(result.output);
      const receipt = JSON.parse(await readFile(result.receipt, "utf8"));
      assert.equal(result.assets, SITE_ASSETS.length);
      assert.equal(result.bytes, archive.length);
      assert.equal(result.sha256, hash(archive));
      assert.equal(receipt.sha256, hash(archive));
      assert.equal(receipt.bytes, archive.length);
      assert.equal(receipt.output, result.output);
      const extracted = unzipSync(archive);
      assert.deepEqual(
        receipt.files.map((file) => file.path),
        SITE_ASSETS,
      );
      for (const file of receipt.files) {
        assert.equal(file.bytes, extracted[file.path].length);
        assert.equal(file.sha256, hash(extracted[file.path]));
      }
    }
    assert.notDeepEqual(await readFile(second.output), firstArchive);
  }));

test("unique output paths retain reproducible archive bytes for identical inputs", () =>
  fixture(async (sourceDirectory, outputDirectory) => {
    const first = await packageSite({ sourceDirectory, outputDirectory });
    const second = await packageSite({ sourceDirectory, outputDirectory });
    assert.notEqual(first.output, second.output);
    assert.deepEqual(
      await readFile(first.output),
      await readFile(second.output),
    );
    assert.equal(first.sha256, second.sha256);
  }));

test("an output path occupied by a file is refused without overwriting it", () =>
  fixture(async (sourceDirectory, outputDirectory) => {
    await writeFile(outputDirectory, "preserved output file");
    await assert.rejects(packageSite({ sourceDirectory, outputDirectory }));
    assert.equal(
      await readFile(outputDirectory, "utf8"),
      "preserved output file",
    );
  }));

test("symlink assets are rejected", async (t) =>
  fixture(async (directory) => {
    await rm(join(directory, "app.mjs"));
    try {
      await symlink(join(directory, "model.mjs"), join(directory, "app.mjs"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        t.skip("OS does not permit fixture symlinks");
        return;
      }
      throw error;
    }
    await assert.rejects(createSiteZip(directory), /Symlink deploy asset/);
  }));

const generation = "a".repeat(64);
async function addGm(directory) {
  const base = join(directory, "data", "gm", generation);
  await mkdir(join(base, "friends"), { recursive: true });
  for (const name of ["gm.html", "gm-app.mjs", "gm-style.css"])
    await writeFile(join(directory, name), "public UI\n");
  const generatedAt = "2026-10-05T00:00:00Z";
  const summary = {
    status: "unknown",
    complete: false,
    enumeratedCount: 0,
    observedAt: null,
  };
  const index = {
    schemaVersion: 1,
    generation,
    generatedAt,
    accounts: [
      {
        username: "OneGM",
        title: "GM",
        profileUrl: "https://www.chess.com/member/OneGM",
        friendsUrl: "https://www.chess.com/member/OneGM/friends",
        friendCount: {
          value: null,
          display: null,
          precision: "unknown",
          observedAt: null,
          sourceType: null,
          sourceUrl: null,
        },
        friendList: summary,
      },
    ],
    coverage: { completeLists: 0, partialLists: 0, unknownLists: 1 },
  };
  const detail = {
    schemaVersion: 1,
    generation,
    generatedAt,
    username: "OneGM",
    friendList: {
      ...summary,
      sourceUrl: null,
      displayedTotal: null,
      friends: [],
    },
  };
  await writeFile(
    join(directory, "release.json"),
    JSON.stringify({
      version: 1,
      gmGeneration: generation,
      baseGmGeneration: "b".repeat(64),
    }),
  );
  await writeFile(join(base, "index.json"), JSON.stringify(index));
  await writeFile(join(base, "friends", "onegm.json"), JSON.stringify(detail));
  return { base, index, detail };
}

test("selected GM publication packages only pinned roster assets and preserves bytes", () =>
  fixture(async (directory) => {
    const { base } = await addGm(directory);
    const first = await createSiteZip(directory);
    assert.deepEqual(first, await createSiteZip(directory));
    const files = unzipSync(first);
    assert.equal(Object.keys(files).length, SITE_ASSETS.length + 5);
    assert.deepEqual(
      Buffer.from(files[`data/gm/${generation}/friends/onegm.json`]),
      await readFile(join(base, "friends", "onegm.json")),
    );
    for (const name of SITE_ASSETS.filter((name) => name !== "release.json"))
      assert.deepEqual(Buffer.from(files[name]), fixtureBytes(name));
  }));

for (const problem of [
  "missing",
  "extra",
  "case",
  "traversal",
  "generation",
  "private",
  "stale",
  "privateField",
]) {
  test(`GM packaging refuses ${problem}`, () =>
    fixture(async (directory) => {
      const { base, index, detail } = await addGm(directory);
      const owner = join(base, "friends", "onegm.json");
      if (problem === "missing" || problem === "case") {
        await rm(owner);
        if (problem === "case")
          await writeFile(
            join(base, "friends", "ONEGM.json"),
            JSON.stringify(detail),
          );
      }
      if (problem === "extra")
        await writeFile(join(base, "friends", "extra.json"), "{}");
      if (problem === "traversal") {
        index.accounts[0].username = "../secret";
        await writeFile(join(base, "index.json"), JSON.stringify(index));
      }
      if (problem === "generation") {
        detail.generation = "b".repeat(64);
        await writeFile(owner, JSON.stringify(detail));
      }
      if (problem === "private") await mkdir(join(base, "proof-data"));
      if (problem === "stale")
        await mkdir(join(directory, "data", "gm", "b".repeat(64)));
      if (problem === "privateField") {
        detail.friendList.rawResponse = "secret";
        await writeFile(owner, JSON.stringify(detail));
      }
      await assert.rejects(createSiteZip(directory));
    }));
}

test("GM detail size limit is checked before JSON parsing", () =>
  fixture(async (directory) => {
    const { base } = await addGm(directory);
    await truncate(join(base, "friends", "onegm.json"), 25 * 1024 * 1024 + 1);
    await assert.rejects(createSiteZip(directory), /Invalid public JSON asset/);
  }));

test("GM directory symlinks are rejected", async (t) =>
  fixture(async (directory) => {
    const { base } = await addGm(directory);
    const target = join(directory, "linked-friends");
    await mkdir(target);
    await writeFile(
      join(target, "onegm.json"),
      await readFile(join(base, "friends", "onegm.json")),
    );
    await rm(join(base, "friends"), { recursive: true });
    try {
      await symlink(
        target,
        join(base, "friends"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        t.skip("OS does not permit fixture directory symlinks");
        return;
      }
      throw error;
    }
    await assert.rejects(createSiteZip(directory), /Invalid GM directory/);
  }));

test("composed GM releases retain older per-account capture dates and reject future dates", () =>
  fixture(async (directory) => {
    const { base, detail } = await addGm(directory);
    detail.generatedAt = "2026-10-04T00:00:00Z";
    const path = join(base, "friends", "onegm.json");
    await writeFile(path, JSON.stringify(detail));
    await createSiteZip(directory);
    detail.generatedAt = "2026-10-06T00:00:00Z";
    await writeFile(path, JSON.stringify(detail));
    await assert.rejects(createSiteZip(directory), /publication date mismatch/);
  }));

test("public GM release requires valid base generation metadata", () =>
  fixture(async (directory) => {
    await addGm(directory);
    await writeFile(
      join(directory, "release.json"),
      JSON.stringify({
        version: 1,
        gmGeneration: generation,
        baseGmGeneration: "invalid",
      }),
    );
    await assert.rejects(
      createSiteZip(directory),
      /base GM release generation/,
    );
  }));

for (const issue of [
  "calendar",
  "unknownRows",
  "identityUrl",
  "secretQuery",
  "completeTotal",
]) {
  test(`GM public validation rejects ${issue}`, () =>
    fixture(async (directory) => {
      const { base, index, detail } = await addGm(directory);
      if (issue === "calendar") index.generatedAt = "2026-02-30T00:00:00Z";
      if (issue === "identityUrl")
        index.accounts[0].profileUrl = "https://www.chess.com/member/AnotherGM";
      if (issue === "secretQuery")
        detail.friendList.sourceUrl =
          "https://www.chess.com/member/OneGM/friends?token=secret";
      if (issue === "unknownRows") {
        index.accounts[0].friendList.enumeratedCount = 1;
        detail.friendList.enumeratedCount = 1;
        detail.friendList.friends = [
          {
            username: "Friend",
            title: null,
            profileUrl: "https://www.chess.com/member/Friend",
          },
        ];
      }
      if (issue === "completeTotal") {
        index.accounts[0].friendList.status = detail.friendList.status =
          "complete";
        index.accounts[0].friendList.complete =
          detail.friendList.complete = true;
        index.coverage = { completeLists: 1, partialLists: 0, unknownLists: 0 };
        detail.friendList.displayedTotal = {
          value: 1,
          display: "1",
          precision: "exact",
        };
      }
      await writeFile(join(base, "index.json"), JSON.stringify(index));
      await writeFile(join(base, "friends/onegm.json"), JSON.stringify(detail));
      await assert.rejects(createSiteZip(directory));
    }));
}

test("roster provenance accepts valid UTC fractions and excludes private headers", () =>
  fixture(async (directory) => {
    const { base, index } = await addGm(directory);
    index.roster = {
      sourceUrl: "https://api.chess.com/pub/titled/GM",
      observedAt: "2026-10-04T13:52:00.123456789Z",
      lastModified: null,
      scope: "GM",
      accounts: 1,
    };
    const path = join(base, "index.json");
    await writeFile(path, JSON.stringify(index));
    await createSiteZip(directory);
    index.roster.headers = { cookie: "private" };
    await writeFile(path, JSON.stringify(index));
    await assert.rejects(
      createSiteZip(directory),
      /private or invalid GM public fields/,
    );
  }));

test("roster metadata preserves original HTTP Last-Modified text and nullable snapshot count", () =>
  fixture(async (directory) => {
    const { base, index } = await addGm(directory);
    const lastModified = "Saturday, 03-Oct-2026 12:44:42 GMT+0000";
    index.roster = {
      sourceUrl: "https://api.chess.com/pub/titled/GM",
      observedAt: "2026-10-03T21:56:32.9357677Z",
      lastModified,
      scope: "published_GM_API_snapshot",
      accounts: 1744,
    };
    const path = join(base, "index.json");
    await writeFile(path, JSON.stringify(index));
    let unpacked = unzipSync(await createSiteZip(directory));
    assert.equal(
      JSON.parse(Buffer.from(unpacked[`data/gm/${generation}/index.json`]))
        .roster.lastModified,
      lastModified,
    );
    index.roster.accounts = null;
    await writeFile(path, JSON.stringify(index));
    await createSiteZip(directory);
    index.roster.lastModified = "invalid HTTP date";
    await writeFile(path, JSON.stringify(index));
    await assert.rejects(
      createSiteZip(directory),
      /Invalid GM roster provenance/,
    );
  }));

for (const total of [
  null,
  { value: null, display: null, precision: "unknown" },
  { value: 0, display: "0+", precision: "lower_bound" },
]) {
  test(`complete GM list refuses ${total?.precision ?? "null"} displayed total`, () =>
    fixture(async (directory) => {
      const { base, index, detail } = await addGm(directory);
      index.accounts[0].friendList.status = detail.friendList.status =
        "complete";
      index.accounts[0].friendList.complete = detail.friendList.complete = true;
      index.coverage = { completeLists: 1, partialLists: 0, unknownLists: 0 };
      detail.friendList.displayedTotal = total;
      await writeFile(join(base, "index.json"), JSON.stringify(index));
      await writeFile(
        join(base, "friends", "onegm.json"),
        JSON.stringify(detail),
      );
      await assert.rejects(
        createSiteZip(directory),
        /GM complete list total mismatch/,
      );
    }));
}

async function traversalFixture(directory) {
  const { base, index, detail } = await addGm(directory);
  const summary = {
    status: "partial",
    complete: false,
    enumeratedCount: 1,
    observedAt: "2026-10-03T22:02:26.284Z",
  };
  index.accounts[0].friendList = { ...summary };
  index.accounts[0].friendCount = {
    value: 1340,
    display: "1340",
    precision: "exact",
    observedAt: null,
    sourceType: null,
    sourceUrl: null,
  };
  index.coverage = { completeLists: 0, partialLists: 1, unknownLists: 0 };
  detail.friendList = {
    ...summary,
    sourceUrl: null,
    displayedTotal: { value: 999, display: "999+", precision: "lower_bound" },
    friends: [
      {
        username: "Friend",
        title: null,
        profileUrl: "https://www.chess.com/member/Friend",
      },
    ],
  };
  const traversal = {
    status: "verified",
    traversalComplete: true,
    snapshotVerified: false,
    count: 1,
    pageCount: 67,
    startedAt: "2026-10-03T21:48:54.675Z",
    endedAt: "2026-10-03T22:02:26.284Z",
  };
  index.accounts[0].savedTraversal = { ...traversal };
  detail.savedTraversal = { ...traversal };
  const save = async () => {
    await writeFile(join(base, "index.json"), JSON.stringify(index));
    await writeFile(join(base, "friends/onegm.json"), JSON.stringify(detail));
  };
  return { index, detail, save };
}

test("saved traversal preserves partial list and separate count measurements", () =>
  fixture(async (directory) => {
    const { index, detail, save } = await traversalFixture(directory);
    await save();
    const files = unzipSync(await createSiteZip(directory));
    const shippedIndex = JSON.parse(
      Buffer.from(files[`data/gm/${generation}/index.json`]),
    );
    const shippedDetail = JSON.parse(
      Buffer.from(files[`data/gm/${generation}/friends/onegm.json`]),
    );
    assert.deepEqual(
      shippedIndex.accounts[0].friendCount,
      index.accounts[0].friendCount,
    );
    assert.deepEqual(shippedDetail.friendList, detail.friendList);
    assert.deepEqual(
      shippedIndex.accounts[0].savedTraversal,
      shippedDetail.savedTraversal,
    );
  }));

for (const issue of [
  "missingDetail",
  "unknownField",
  "wrongCount",
  "badPageCount",
  "calendarDate",
  "reversedDates",
  "nanosecondOrder",
  "snapshotUpgrade",
  "placement",
  "mixed",
]) {
  test(`saved traversal rejects ${issue}`, () =>
    fixture(async (directory) => {
      const { index, detail, save } = await traversalFixture(directory);
      const a = index.accounts[0].savedTraversal,
        d = detail.savedTraversal;
      if (issue === "missingDetail") delete detail.savedTraversal;
      if (issue === "unknownField") a.rawEvidence = d.rawEvidence = "private";
      if (issue === "wrongCount") a.count = d.count = 2;
      if (issue === "badPageCount") a.pageCount = d.pageCount = 0;
      if (issue === "calendarDate")
        a.startedAt = d.startedAt = "2026-02-30T00:00:00Z";
      if (issue === "reversedDates")
        a.startedAt = d.startedAt = "2026-10-04T00:00:00Z";
      if (issue === "nanosecondOrder") {
        a.startedAt = d.startedAt = "2026-10-03T22:02:26.284000002Z";
        a.endedAt = d.endedAt = "2026-10-03T22:02:26.284000001Z";
      }
      if (issue === "snapshotUpgrade")
        a.snapshotVerified = d.snapshotVerified = true;
      if (issue === "placement") detail.friendList.savedTraversal = d;
      if (issue === "mixed") d.pageCount = 68;
      await save();
      await assert.rejects(createSiteZip(directory));
    }));
}

for (const issue of [
  "observationMismatch",
  "futureEnd",
  "nanosecondFutureEnd",
]) {
  test(`saved traversal chronology rejects ${issue}`, () =>
    fixture(async (directory) => {
      const { index, detail, save } = await traversalFixture(directory);
      if (issue === "observationMismatch")
        index.accounts[0].friendList.observedAt = detail.friendList.observedAt =
          "2026-10-03T22:02:26.285Z";
      if (issue === "futureEnd")
        detail.generatedAt = "2026-10-03T22:02:26.283Z";
      if (issue === "nanosecondFutureEnd") {
        index.accounts[0].savedTraversal.endedAt =
          detail.savedTraversal.endedAt =
          index.accounts[0].friendList.observedAt =
          detail.friendList.observedAt =
            "2026-10-03T22:02:26.284000002Z";
        detail.generatedAt = "2026-10-03T22:02:26.284000001Z";
      }
      await save();
      await assert.rejects(
        createSiteZip(directory),
        /saved traversal mismatch or invalid chronology/,
      );
    }));
}
