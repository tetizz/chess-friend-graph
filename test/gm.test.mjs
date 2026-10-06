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
