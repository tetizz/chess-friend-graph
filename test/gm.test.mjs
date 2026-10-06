import test from "node:test";
import assert from "node:assert/strict";
import {
  validateIndex,
  validateFriends,
  filterRoster,
  countText,
  fetchJson,
  publicListDownload,
  sourceName,
  validateTraversal,
  traversalText,
  listDescription,
  displayedScanCount,
} from "../src/gm-app.mjs";
const gen = "a".repeat(64),
  other = "b".repeat(64),
  summary = (status, count = 0) => ({
    status,
    complete: status === "complete",
    enumeratedCount: count,
  }),
  account = (username, status, count = 0) => ({
    username,
    title: "GM",
    friendList: summary(status, count),
  });
test("all roster retained by default; status composes with search", () => {
  const rows = [
    account("FirstGM", "complete"),
    account("SecondGM", "partial"),
    account("ThirdGM", "unknown"),
  ];
  assert.equal(filterRoster(rows).length, 3);
  assert.deepEqual(
    filterRoster(rows, "GM", "unknown").map((x) => x.username),
    ["ThirdGM"],
  );
  assert.equal(filterRoster(rows, "First", "partial").length, 0);
});
test("index pins generation and refuses identity/status inconsistencies", () => {
  const data = {
    schemaVersion: 1,
    generation: gen,
    accounts: [account("ZeroGM", "complete")],
  };
  assert.equal(validateIndex(data, gen), data);
  assert.throws(() => validateIndex(data, other));
  assert.throws(() =>
    validateIndex(
      {
        ...data,
        accounts: [account("gm", "unknown"), account("GM", "unknown")],
      },
      gen,
    ),
  );
  assert.throws(() =>
    validateIndex(
      {
        ...data,
        accounts: [
          {
            ...account("gm", "complete"),
            friendList: { ...summary("complete"), complete: false },
          },
        ],
      },
      gen,
    ),
  );
  assert.throws(() =>
    validateIndex({ ...data, accounts: [account("gm", "invented")] }, gen),
  );
});
test("complete empty is explicit; unknown empty does not acquire completion", () => {
  for (const status of ["complete", "unknown"]) {
    const a = account("ZeroGM", status),
      data = {
        schemaVersion: 1,
        generation: gen,
        username: "zerogm",
        friendList: { ...summary(status), friends: [] },
      };
    assert.equal(
      validateFriends(data, a, gen).friendList.complete,
      status === "complete",
    );
  }
  assert.equal(countText({ value: null, precision: "unknown" }), "Unknown");
  assert.equal(countText({ value: 0, precision: "exact" }), "0");
  assert.equal(countText({ value: 999, precision: "lower_bound" }), "999+");
});
test("lazy rows reject mixed generations, wrong owner, duplicates and false totals", () => {
  const a = account("OneGM", "partial", 1),
    d = {
      schemaVersion: 1,
      generation: gen,
      username: "OneGM",
      friendList: {
        ...summary("partial", 1),
        friends: [{ username: "Friend", title: null }],
      },
    };
  assert.equal(validateFriends(d, a, gen), d);
  assert.throws(() => validateFriends({ ...d, generation: other }, a, gen));
  assert.throws(() => validateFriends({ ...d, username: "Wrong" }, a, gen));
  assert.throws(() =>
    validateFriends(
      { ...d, friendList: { ...d.friendList, enumeratedCount: 2 } },
      a,
      gen,
    ),
  );
  assert.throws(() =>
    validateFriends(
      {
        ...d,
        friendList: {
          ...summary("partial", 2),
          friends: [{ username: "Friend" }, { username: "friend" }],
        },
      },
      account("OneGM", "partial", 2),
      gen,
    ),
  );
});
test("fetch avoids stale cache and fails unavailable data visibly", async () => {
  let options;
  assert.deepEqual(
    await fetchJson("pinned", async (url, o) => {
      options = o;
      return { ok: true, json: async () => ({ saved: true }) };
    }),
    { saved: true },
  );
  assert.equal(options.cache, "no-store");
  await assert.rejects(
    fetchJson("missing", async () => ({ ok: false, status: 404 })),
    /unavailable/,
  );
});

test("invented precision cannot look exact and downloads project public rows only", () => {
  assert.equal(countText({ value: 77, precision: "invented" }), "Unknown");
  const projected = publicListDownload({
    schemaVersion: 1,
    generation: gen,
    username: "GM",
    generatedAt: "saved",
    secret: "private",
    friendList: {
      ...summary("unknown"),
      observedAt: null,
      proof: "raw",
      friends: [],
    },
  });
  assert.equal(projected.friendList.observedAt, null);
  assert.equal(projected.secret, undefined);
  assert.equal(projected.friendList.proof, undefined);
  assert.equal(projected.friendList.complete, false);
});

test("source attribution never guesses website from missing or unsupported type", () => {
  assert.equal(sourceName(null), "Unknown source");
  assert.equal(sourceName("invented"), "Unknown source");
  assert.equal(
    sourceName("chess_com_public_profile_ui"),
    "Chess.com public website",
  );
  assert.equal(sourceName("chess_com_website_ui"), "Chess.com public website");
  assert.equal(sourceName("chess_com_mobile_api"), "Chess.com app service");
  assert.equal(sourceName("chess_com_native_app_ui"), "Chess.com Android app");
});

test("verified dated traversal stays partial, capped and separately downloadable", () => {
  const savedTraversal = {
    status: "verified",
    traversalComplete: true,
    snapshotVerified: false,
    count: 2,
    pageCount: 1,
    startedAt: "2026-10-01T00:00:00Z",
    endedAt: "2026-10-01T00:01:00Z",
  };
  const a = {
    ...account("Algeriano", "partial", 2),
    savedTraversal,
    friendCount: { value: 999, precision: "lower_bound" },
  };
  const d = {
    schemaVersion: 1,
    generation: gen,
    username: "Algeriano",
    savedTraversal: { ...savedTraversal, privateProof: "omit" },
    friendList: {
      ...summary("partial", 2),
      friends: [{ username: "First" }, { username: "Second" }],
    },
  };
  validateFriends(d, a, gen);
  assert.equal(d.friendList.complete, false);
  assert.equal(countText(a.friendCount), "999+");
  assert.match(traversalText(savedTraversal), /Saved traversal finished/);
  assert.match(
    traversalText(savedTraversal),
    /may differ from the current total/,
  );
  assert.deepEqual(publicListDownload(d).savedTraversal, savedTraversal);
  assert.throws(() =>
    validateFriends(
      { ...d, savedTraversal: { ...savedTraversal, count: 1 } },
      a,
      gen,
    ),
  );
  assert.throws(() =>
    validateFriends({ ...d, savedTraversal: undefined }, a, gen),
  );
  for (const bad of [
    { snapshotVerified: true },
    { traversalComplete: false },
    { status: "partial" },
    { pageCount: 0 },
    { endedAt: "2026-09-30T00:00:00Z" },
    { startedAt: null },
  ])
    assert.throws(() => validateTraversal({ ...savedTraversal, ...bad }, 2));
  assert.equal(validateTraversal(undefined, 0), null);
});

test("traversal UTC calendar refuses normalized invalid days and non-UTC shapes", () => {
  const good = {
    status: "verified",
    traversalComplete: true,
    snapshotVerified: false,
    count: 0,
    pageCount: 1,
    startedAt: "2026-02-28T00:00:00.1234567Z",
    endedAt: "2026-03-01T00:00:00Z",
  };
  assert.equal(validateTraversal(good, 0).startedAt, good.startedAt);
  for (const value of [
    "2026-02-30T00:00:00Z",
    "2026-02-28",
    "2026-02-28T00:00:00+00:00",
    "garbageZ",
    "2026-13-01T00:00:00Z",
  ])
    assert.throws(() => validateTraversal({ ...good, startedAt: value }, 0));
});
test("Algeriano exact account count, captured cap and partial traversal remain distinct", () => {
  const traversal = {
    status: "verified",
    traversalComplete: true,
    snapshotVerified: false,
    count: 1340,
    pageCount: 67,
    startedAt: "2026-10-03T21:00:00Z",
    endedAt: "2026-10-03T22:02:26.284Z",
  };
  const a = {
    ...account("Algeriano22", "partial", 1340),
    savedTraversal: traversal,
    friendCount: {
      value: 1340,
      precision: "exact",
      observedAt: "2026-10-04T01:00:00Z",
    },
  };
  const displayedTotal = {
    value: 999,
    precision: "lower_bound",
    display: "999+",
  };
  const d = {
    schemaVersion: 1,
    generation: gen,
    username: "Algeriano22",
    savedTraversal: traversal,
    friendList: {
      ...summary("partial", 1340),
      displayedTotal,
      friends: Array.from({ length: 1340 }, (_, i) => ({
        username: "Friend" + i,
        title: null,
      })),
    },
  };
  validateFriends(d, a, gen);
  assert.equal(countText(a.friendCount), "1,340");
  assert.equal(countText(d.friendList.displayedTotal), "999+");
  assert.equal(d.friendList.status, "partial");
  assert.equal(d.friendList.complete, false);
  assert.equal(d.savedTraversal.snapshotVerified, false);
  assert.equal(
    listDescription(d.friendList, d.savedTraversal),
    "Partial saved list. All public pages were read; the displayed total was capped.",
  );
  assert.equal(
    displayedScanCount(d.friendList),
    "Displayed during the scan: 999+ friends (lower bound).",
  );
  assert.match(
    traversalText(d.savedTraversal),
    /The list could change between pages/,
  );
  assert.doesNotMatch(traversalText(d.savedTraversal), /atomic snapshot/);
  assert.equal(a.friendCount.observedAt, "2026-10-04T01:00:00Z");
});
