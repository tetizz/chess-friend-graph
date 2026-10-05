import test from "node:test";
import assert from "node:assert/strict";
import { comparePublicSnapshots } from "../scripts/compare-public-snapshots.mjs";

const measurement = (value, precision = "exact") => ({ value, precision });
const generation = "b".repeat(64);
const manifest = "c".repeat(64);
const options = {
  expectedExactIncrease: 2,
  expectedGeneration: generation,
  expectedManifestSha256: manifest,
};
function fixture() {
  const accounts = ["FixtureGM", "FixtureMaster", "FixtureIM"].map(
    (username, index) => ({
      username,
      title: ["GM", "M", "IM"][index],
      profileUrl: `https://www.chess.com/member/${username}`,
      friendsUrl: `https://www.chess.com/member/${username}/friends`,
      friendCount: index === 0 ? measurement(12) : measurement(null, "unknown"),
      ratings: {
        bullet: measurement(100),
        blitz: measurement(200),
        rapid: measurement(300),
        overall: measurement(200),
      },
    }),
  );
  const previous = {
    schemaVersion: 1,
    generatedAt: "2026-10-05T00:00:00.000Z",
    publication: {
      mainGeneration: "a".repeat(64),
      mainManifestSha256: "d".repeat(64),
    },
    coverage: {
      accounts: 3,
      counts: { exact: 1, lower_bound: 0, unknown: 2 },
      ratings: { bullet: 3, blitz: 3, rapid: 3, overall: 3 },
      directory: {
        pagesCaptured: 2,
        pagesExpected: 2,
        complete: false,
        observedEntries: 4,
        uniqueAccounts: 3,
        duplicateEntries: 1,
        pageCoverageComplete: true,
        snapshotVerified: false,
        captureStartedAt: "2026-10-03T00:00:00.000Z",
        captureEndedAt: "2026-10-04T00:00:00.000Z",
      },
      roster: {
        snapshotCoverageComplete: true,
        publishedUnionAccounts: 3,
        preservedSeedOnlyAccounts: 0,
      },
    },
    accounts,
  };
  const candidate = structuredClone(previous);
  candidate.generatedAt = "2026-10-05T01:00:00.000Z";
  candidate.publication = {
    mainGeneration: generation,
    mainManifestSha256: manifest,
  };
  candidate.accounts[1].friendCount = measurement(0);
  candidate.accounts[2].friendCount = measurement(35);
  candidate.coverage.counts = { exact: 3, lower_bound: 0, unknown: 0 };
  return { previous, candidate };
}
function rejects(change, changedOptions = options) {
  const { previous, candidate } = fixture();
  change(candidate, previous);
  assert.throws(() =>
    comparePublicSnapshots(previous, candidate, changedOptions),
  );
}

test("public unknown-to-exact updates include explicit zero and return aggregates", () => {
  const { previous, candidate } = fixture();
  const result = comparePublicSnapshots(previous, candidate, options);
  assert.equal(result.valid, true);
  assert.equal(result.exactIncrease, 2);
  assert.deepEqual(result.previousCounts, previous.coverage.counts);
  assert.deepEqual(result.candidateCounts, candidate.coverage.counts);
  assert.equal(Object.hasOwn(result, "accounts"), false);
  for (const account of previous.accounts)
    assert.equal(JSON.stringify(result).includes(account.username), false);
});

test("valid observation metadata can change without changing known measurements", () => {
  const { previous, candidate } = fixture();
  previous.accounts[0].friendCount.observedAt = "2026-10-04T00:00:00.000Z";
  previous.accounts[0].friendCount.sourceType = "chess_com_website_ui";
  candidate.accounts[0].friendCount.observedAt = "2026-10-05T00:30:00.000Z";
  candidate.accounts[0].friendCount.sourceType = "chess_com_mobile_api";
  assert.equal(
    comparePublicSnapshots(previous, candidate, options).valid,
    true,
  );
});

test("fresh verified known-count increases and decreases return aggregates only", () => {
  for (const [value, direction] of [
    [18, "increased"],
    [8, "decreased"],
  ]) {
    const { previous, candidate } = fixture();
    previous.accounts[0].friendCount.observedAt = "2026-10-04T00:00:00.000Z";
    candidate.accounts[0].friendCount.observedAt = "2026-10-05T00:30:00.000Z";
    candidate.accounts[0].friendCount.value = value;
    const result = comparePublicSnapshots(previous, candidate, options);
    assert.deepEqual(result.knownValueChanges, {
      total: 1,
      increased: direction === "increased" ? 1 : 0,
      decreased: direction === "decreased" ? 1 : 0,
    });
    assert.equal(result.exactIncrease, 2);
  }
});

test("lower-bound availability is retained and a fresh exact upgrade is allowed", () => {
  const { previous, candidate } = fixture();
  previous.accounts[0].friendCount = {
    ...measurement(12, "lower_bound"),
    observedAt: "2026-10-04T00:00:00.000Z",
  };
  previous.coverage.counts = { exact: 0, lower_bound: 1, unknown: 2 };
  candidate.accounts[0].friendCount = {
    ...measurement(10),
    observedAt: "2026-10-05T00:00:00.000Z",
  };
  assert.equal(
    comparePublicSnapshots(previous, candidate, {
      ...options,
      expectedExactIncrease: 3,
    }).valid,
    true,
  );
  candidate.accounts[0].friendCount = measurement(null, "unknown");
  candidate.coverage.counts = { exact: 2, lower_bound: 0, unknown: 1 };
  assert.throws(() => comparePublicSnapshots(previous, candidate, options));
});

test("same-value lower-bound upgrades require a strictly newer observation", () => {
  const { previous, candidate } = fixture();
  previous.accounts[0].friendCount = {
    ...measurement(12, "lower_bound"),
    observedAt: "2026-10-04T00:00:00.000Z",
  };
  previous.coverage.counts = { exact: 0, lower_bound: 1, unknown: 2 };
  candidate.accounts[0].friendCount.observedAt = "2026-10-04T00:00:00.000Z";
  const upgraded = { ...options, expectedExactIncrease: 3 };
  assert.throws(() => comparePublicSnapshots(previous, candidate, upgraded));
  candidate.accounts[0].friendCount.observedAt = "2026-10-05T00:00:00.000Z";
  assert.equal(
    comparePublicSnapshots(previous, candidate, upgraded).valid,
    true,
  );
});

test("unknown may become a lower bound without inflating exact coverage", () => {
  const { previous, candidate } = fixture();
  candidate.accounts[2].friendCount = measurement(35, "lower_bound");
  candidate.coverage.counts = { exact: 2, lower_bound: 1, unknown: 0 };
  const result = comparePublicSnapshots(previous, candidate, {
    ...options,
    expectedExactIncrease: 1,
  });
  assert.equal(result.transitions.unknown_to_lower_bound, 1);
  assert.equal(result.exactIncrease, 1);
});

test("known numeric changes require strictly newer dates on both observations", () => {
  for (const [oldDate, newDate] of [
    [undefined, undefined],
    [undefined, "2026-10-05T00:00:00.000Z"],
    ["2026-10-05T00:00:00.000Z", undefined],
    ["2026-10-05T00:00:00.000Z", "2026-10-05T00:00:00.000Z"],
    ["2026-10-05T00:00:00.000Z", "2026-10-04T00:00:00.000Z"],
  ]) {
    rejects((candidate, previous) => {
      if (oldDate) previous.accounts[0].friendCount.observedAt = oldDate;
      if (newDate) candidate.accounts[0].friendCount.observedAt = newDate;
      candidate.accounts[0].friendCount.value = 18;
    });
  }
});

for (const [label, change] of [
  ["roster loss", (c) => c.accounts.pop()],
  [
    "roster addition",
    (c) =>
      c.accounts.push({
        ...structuredClone(c.accounts[0]),
        username: "Another",
      }),
  ],
  [
    "duplicate casefold identity",
    (c) => (c.accounts[1].username = "fixturegm"),
  ],
  ["title change", (c) => (c.accounts[0].title = "IM")],
  ["profile URL change", (c) => (c.accounts[0].profileUrl += "/other")],
  ["friends URL change", (c) => (c.accounts[0].friendsUrl += "?filter=x")],
  ["rating change", (c) => (c.accounts[0].ratings.blitz.value = 201)],
  [
    "known count loss",
    (c) => (c.accounts[0].friendCount = measurement(null, "unknown")),
  ],
  ["known count decrease", (c) => (c.accounts[0].friendCount.value = 11)],
  [
    "known precision downgrade",
    (c) => (c.accounts[0].friendCount.precision = "lower_bound"),
  ],
  ["wrong count aggregate", (c) => (c.coverage.counts.exact = 2)],
  ["wrong account aggregate", (c) => (c.coverage.accounts = 4)],
  ["rating coverage change", (c) => (c.coverage.ratings.blitz = 2)],
  [
    "directory coverage change",
    (c) => (c.coverage.directory.pagesCaptured = 1),
  ],
  [
    "roster coverage change",
    (c) => (c.coverage.roster.preservedSeedOnlyAccounts = 1),
  ],
  ["private root field", (c) => (c.privateMonitor = {})],
  ["private account field", (c) => (c.accounts[0].uuid = "private")],
  [
    "private measurement field",
    (c) => (c.accounts[0].friendCount.responseHex = "00"),
  ],
  ["negative count", (c) => (c.accounts[1].friendCount.value = -1)],
  ["fractional count", (c) => (c.accounts[1].friendCount.value = 0.5)],
  [
    "unsafe count",
    (c) => (c.accounts[1].friendCount.value = Number.MAX_SAFE_INTEGER + 1),
  ],
  [
    "unknown carrying a value",
    (c) => (c.accounts[1].friendCount = measurement(0, "unknown")),
  ],
  ["exact missing value", (c) => delete c.accounts[1].friendCount.value],
  [
    "invalid precision",
    (c) => (c.accounts[1].friendCount.precision = "approximate"),
  ],
  [
    "invalid observation date",
    (c) => (c.accounts[0].friendCount.observedAt = "yesterday"),
  ],
])
  test(`rejects ${label}`, () => rejects(change));

test("rejects incorrect expected increase or publication pins", () => {
  rejects(() => {}, { ...options, expectedExactIncrease: 1 });
  rejects(() => {}, { ...options, expectedGeneration: "e".repeat(64) });
  rejects(() => {}, { ...options, expectedManifestSha256: "f".repeat(64) });
});

test("timestamps require UTC ISO grammar and a valid calendar roundtrip", () => {
  const invalid = [
    "October 5, 2026",
    "2026-10-05T00:30:00+00:00",
    "2026-10-05T00:30:00",
    "2026-10-05",
    "2026-02-30T00:30:00.000Z",
    "2026-10-05T24:00:00.000Z",
    "2026-10-05T00:30:00.12345678Z",
  ];
  const setters = [
    (c, date) => (c.generatedAt = date),
    (c, date) => (c.accounts[0].friendCount.observedAt = date),
    (c, date) => (c.accounts[0].ratings.bullet.lastRatedGameAt = date),
    (c, date) => (c.coverage.directory.captureEndedAt = date),
  ];
  for (const date of invalid)
    for (const set of setters) rejects((candidate) => set(candidate, date));
});

test("valid one-to-seven fractional-digit UTC observation timestamps are accepted", () => {
  for (let digits = 1; digits <= 7; digits++) {
    const { previous, candidate } = fixture();
    const date = `2026-10-05T00:30:00.${"1234567".slice(0, digits)}Z`;
    previous.accounts[0].friendCount.observedAt = "2026-10-04T00:00:00.000Z";
    candidate.accounts[0].friendCount.observedAt = date;
    candidate.accounts[0].friendCount.value = 18;
    assert.equal(
      comparePublicSnapshots(previous, candidate, options).valid,
      true,
    );
  }
});

test("an existing optional GM generation pin must be preserved", () => {
  const { previous, candidate } = fixture();
  previous.publication.gmGeneration = "9".repeat(64);
  candidate.publication.gmGeneration = previous.publication.gmGeneration;
  assert.equal(
    comparePublicSnapshots(previous, candidate, options).valid,
    true,
  );
  candidate.publication.gmGeneration = "8".repeat(64);
  assert.throws(() => comparePublicSnapshots(previous, candidate, options));
  delete candidate.publication.gmGeneration;
  assert.throws(() => comparePublicSnapshots(previous, candidate, options));
});
