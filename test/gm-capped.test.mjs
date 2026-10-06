import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { normalizePublicGmSupplement } from "../scripts/export-public-gm-data.mjs";
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex"),
  g = "a".repeat(64);
async function fixture(change = () => {}) {
  let d = await fs.mkdtemp(path.join(tmpdir(), "capped-review-"));
  let t = {
      status: "verified",
      traversalComplete: true,
      snapshotVerified: false,
      count: 24,
      pageCount: 2,
      startedAt: "2026-10-01T00:00:00.000Z",
      endedAt: "2026-10-01T00:01:00.000Z",
    },
    candidate = {
      schemaVersion: 1,
      baseGmGeneration: g,
      username: "GMFixture",
      generatedAt: t.endedAt,
      savedTraversal: t,
      friendList: {
        status: "partial",
        complete: false,
        enumeratedCount: 24,
        observedAt: t.endedAt,
        sourceUrl:
          "https://www.chess.com/member/gmfixture/friends?sortby=alphabetical",
        displayedTotal: { value: 20, display: "20+", precision: "lower_bound" },
        friends: Array.from({ length: 24 }, (_, i) => ({
          username: "friend" + String(i).padStart(3, "0"),
          title: null,
          profileUrl:
            "https://www.chess.com/member/friend" + String(i).padStart(3, "0"),
        })),
      },
    };
  change(candidate);
  let cb = Buffer.from(JSON.stringify(candidate)),
    cp = path.join(d, "candidate.json");
  await fs.writeFile(cp, cb);
  let cert = {
    schemaVersion: 1,
    kind: "public_new_capped_traversal_review",
    status: "verified",
    baseGmGeneration: g,
    username: "GMFixture",
    profileTitle: "GM",
    candidate: { bytes: cb.length, sha256: hash(cb) },
    input: { bytes: 100, sha256: "b".repeat(64) },
    savedTraversal: candidate.savedTraversal,
    friendListStatus: candidate.friendList.status,
    friendListComplete: candidate.friendList.complete,
    displayedTotal: candidate.friendList.displayedTotal,
    observedAt: candidate.friendList.observedAt,
    sourceUrl: candidate.friendList.sourceUrl,
    reviewedAt: "2026-10-02T00:00:00.000Z",
  };
  let certBytes = Buffer.from(JSON.stringify(cert)),
    certPath = path.join(d, "review.json");
  await fs.writeFile(certPath, certBytes);
  let mb = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        baseGmGeneration: g,
        candidates: [
          {
            username: "GMFixture",
            path: "candidate.json",
            bytes: cb.length,
            sha256: hash(cb),
          },
        ],
      }),
    ),
    mp = path.join(d, "manifest.json");
  await fs.writeFile(mp, mb);
  return {
    d,
    options: { manifestPath: mp, expectedSha256: hash(mb) },
    reviews: [
      {
        username: "GMFixture",
        certificatePath: certPath,
        bytes: certBytes.length,
        sha256: hash(certBytes),
      },
    ],
  };
}
test("caller pinned new capped traversal accepted; bare manifest rejected", async () => {
  let f = await fixture();
  try {
    let n = await normalizePublicGmSupplement(f.options, g, f.reviews);
    assert.equal(n.candidates[0].savedTraversal.count, 24);
    assert.equal(n.candidates[0].friendList.complete, false);
    await assert.rejects(normalizePublicGmSupplement(f.options, g));
    await assert.rejects(
      normalizePublicGmSupplement(f.options, g, [...f.reviews, ...f.reviews]),
    );
  } finally {
    await fs.rm(f.d, { recursive: true, force: true });
  }
});
for (const [name, change] of [
  ["count mismatch", (c) => (c.savedTraversal.count = 25)],
  [
    "exact display",
    (c) =>
      (c.friendList.displayedTotal = {
        value: 24,
        display: "24",
        precision: "exact",
      }),
  ],
  [
    "complete upgrade",
    (c) => {
      c.friendList.status = "complete";
      c.friendList.complete = true;
    },
  ],
  ["atomic claim", (c) => (c.savedTraversal.snapshotVerified = true)],
  [
    "date drift",
    (c) => (c.savedTraversal.endedAt = "2026-10-01T00:02:00.000Z"),
  ],
  ["private field", (c) => (c.savedTraversal.isYourFriend = true)],
])
  test(name, async () => {
    let f = await fixture(change);
    try {
      await assert.rejects(
        normalizePublicGmSupplement(f.options, g, f.reviews),
      );
    } finally {
      await fs.rm(f.d, { recursive: true, force: true });
    }
  });
test("wrong review owner or actual certificate bytes rejected", async () => {
  let f = await fixture();
  try {
    await assert.rejects(
      normalizePublicGmSupplement(f.options, g, [
        { ...f.reviews[0], username: "OtherGM" },
      ]),
    );
    await fs.appendFile(f.reviews[0].certificatePath, " ");
    await assert.rejects(normalizePublicGmSupplement(f.options, g, f.reviews));
  } finally {
    await fs.rm(f.d, { recursive: true, force: true });
  }
});
