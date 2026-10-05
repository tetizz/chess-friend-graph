import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { exportPublicData } from "../scripts/export-public-data.mjs";
const hash = (x) => createHash("sha256").update(x).digest("hex");
const original = resolve(
  fileURLToPath(new URL("../../chess-friend-graph/", import.meta.url)),
);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "chess-public-export-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source"),
    generation = "a".repeat(64),
    published = join(source, "main-publications", generation);
  await mkdir(published, { recursive: true });
  for (const name of ["model.mjs", "rating-model.mjs"])
    await copyFile(join(original, name), join(source, name));
  const at = "2026-10-04T12:00:00.000Z";
  const field = (value) => ({
    value,
    precision: "exact",
    observedAt: at,
    lastRatedGameAt: "2026-10-03T12:00:00.000Z",
    sourceUrl: "https://api.chess.com/pub/player/publicgm/stats",
  });
  const index = {
    generatedAt: at,
    coverage: {
      pagesCaptured: 414,
      expectedPages: 686,
      directoryComplete: false,
    },
    publishedRosterCoverage: {
      snapshotCoverageComplete: true,
      summary: { publishedUnionAccounts: 1, preservedSeedOnlyAccounts: 0 },
    },
    comparison: { secret: "DO_NOT_PUBLISH" },
    accounts: [
      {
        username: "PublicGM",
        title: "GM",
        name: "Public name",
        isYourFriend: true,
        isAkshitFriend: true,
        uuid: "DO_NOT_PUBLISH",
        personalStats: { secret: "DO_NOT_PUBLISH" },
        friendList: ["DO_NOT_PUBLISH"],
        friendCount: {
          value: 999,
          display: "999+",
          precision: "exact",
          observedAt: at,
          uuid: "DO_NOT_PUBLISH",
          evidenceFile: "C:/private",
        },
        ratings: {
          blitz: field(1500),
          rapid: field(1800),
          bullet: field(1200),
          overall: { value: 9999, precision: "exact" },
        },
        publicListEnumeration: {
          status: "verified",
          precision: "exact",
          scope: "saved_terminal_traversal",
          method: "alphabetical_public_pagination",
          snapshotVerified: false,
          value: 42,
          display: "42",
          startedAt: "2026-10-04T11:00:00.000Z",
          observedAt: at,
          private: "DO_NOT_PUBLISH",
        },
      },
    ],
  };
  async function install() {
    const indexBytes = Buffer.from(JSON.stringify(index));
    await writeFile(join(published, "main-index.json"), indexBytes);
    const manifest = {
      schemaVersion: 1,
      target: "main",
      generation,
      validation: {
        passed: true,
        fullScope: true,
        accounts: index.accounts.length,
      },
      files: {
        "main-index.json": {
          bytes: indexBytes.length,
          sha256: hash(indexBytes),
        },
      },
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(join(published, "publication-manifest.json"), bytes);
    await writeFile(
      join(source, "main-publication.json"),
      JSON.stringify({
        schemaVersion: 1,
        target: "main",
        generation,
        manifest: `main-publications/${generation}/publication-manifest.json`,
        manifestSha256: hash(bytes),
      }),
    );
  }
  await install();
  return {
    source,
    output: join(directory, "release/public/data/dataset.json"),
    published,
    index,
    install,
  };
}
test("public allowlist removes secrets and retains canonical precision, dates and strict mean", async (t) => {
  const f = await fixture(t),
    result = await exportPublicData(f),
    text = await readFile(f.output, "utf8"),
    data = JSON.parse(text),
    row = data.accounts[0];
  assert.equal(result.accounts, 1);
  assert(!text.includes("DO_NOT_PUBLISH") && !text.includes("C:/private"));
  assert.equal(row.friendCount.precision, "lower_bound");
  assert.equal(row.friendCount.value, 999);
  assert.equal(row.ratings.overall.value, 1500);
  assert.equal(row.ratings.blitz.lastRatedGameAt, "2026-10-03T12:00:00.000Z");
  assert.equal(row.listCount.value, 42);
  assert.equal(data.coverage.directory.pagesCaptured, 414);
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "friendCount",
      "friendsUrl",
      "listCount",
      "name",
      "profileUrl",
      "ratings",
      "title",
      "username",
    ].sort(),
  );
});
test("manifest and compact digest mismatches fail without installing output", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.published, "main-index.json"), "{}");
  await assert.rejects(exportPublicData(f), /Compact index digest mismatch/);
  await assert.rejects(readFile(f.output), { code: "ENOENT" });
  await f.install();
  await writeFile(join(f.published, "publication-manifest.json"), "{}");
  await assert.rejects(exportPublicData(f), /manifest digest mismatch/);
});
test("bad pointer and duplicate identities fail; incomplete controls keep overall unknown", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.source, "main-publication.json"),
    JSON.stringify({
      schemaVersion: 1,
      target: "main",
      generation: "../escape",
    }),
  );
  await assert.rejects(exportPublicData(f), /Invalid selected publication/);
  await f.install();
  f.index.accounts.push({ ...f.index.accounts[0], username: "publicgm" });
  await f.install();
  await assert.rejects(exportPublicData(f), /Duplicate public identity/);
  f.index.accounts.pop();
  delete f.index.accounts[0].ratings.bullet;
  await f.install();
  await exportPublicData(f);
  const data = JSON.parse(await readFile(f.output));
  assert.equal(data.accounts[0].ratings.overall.value, null);
  assert.equal(data.accounts[0].ratings.overall.precision, "unknown");
});
