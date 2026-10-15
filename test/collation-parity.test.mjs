import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sortPlayers, ratingValue, normalizeCount } from "../src/model.mjs";
// Frozen a79dd394 comparator and numeric branches, independent of the new collators.
function originalSort(accounts, key = "friends-desc", axis = "overall") {
  const result = [...accounts];
  const usernameOrder = (a, b) =>
    String(a.username ?? "").localeCompare(String(b.username ?? ""), "en", {
      sensitivity: "base",
    }) ||
    String(a.username ?? "").localeCompare(String(b.username ?? ""), "en");
  if (key === "username") return result.sort(usernameOrder);
  const rating = key.startsWith("rating-"),
    direction = key.endsWith("-asc") ? 1 : -1;
  return result.sort((a, b) => {
    const av = rating
        ? ratingValue(a, axis)
        : normalizeCount(a.friendCount).value,
      bv = rating ? ratingValue(b, axis) : normalizeCount(b.friendCount).value;
    if (av === null || bv === null)
      return av === bv ? usernameOrder(a, b) : av === null ? 1 : -1;
    return direction * (av - bv) || usernameOrder(a, b);
  });
}
const keys = [
    "username",
    "friends-asc",
    "friends-desc",
    "rating-asc",
    "rating-desc",
  ],
  axes = ["overall", "bullet", "blitz", "rapid"];
function shuffled(input) {
  const result = [...input];
  let seed = 20261016;
  for (let i = result.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function verify(accounts) {
  for (const input of [accounts, [...accounts].reverse(), shuffled(accounts)]) {
    const snapshot = JSON.stringify(input),
      refs = [...input];
    for (const key of keys)
      for (const axis of axes) {
        const expected = originalSort(input, key, axis),
          actual = sortPlayers(input, key, axis);
        assert.notEqual(actual, input);
        assert.deepEqual(
          actual,
          expected,
          `${key}/${axis} full ordered objects`,
        );
        for (let i = 0; i < actual.length; i++)
          assert.equal(
            actual[i],
            expected[i],
            `${key}/${axis} stable identity ${i}`,
          );
      }
    assert.equal(JSON.stringify(input), snapshot, "caller objects unchanged");
    for (let i = 0; i < input.length; i++)
      assert.equal(input[i], refs[i], "caller array order unchanged");
  }
}
test("full pinned17133 public roster: five sorts, four axes, three input permutations", async () => {
  const bytes = await readFile(
    new URL("../public/data/dataset.json", import.meta.url),
  );
  assert.equal(bytes.length, 11155465);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "29aaf32d71720c56fd6597a614c7a831bdce270c6632b5e34da82619672426bf",
  );
  const data = JSON.parse(bytes);
  assert.equal(data.accounts.length, 17133);
  verify(data.accounts);
});
test("collation edge cases, unknown numeric values and stable duplicate ties", () => {
  const exact = (value) => ({ value, precision: "exact" }),
    names = [
      "a",
      "A",
      "á",
      "a\u0301",
      "ä",
      "z",
      "Z",
      "10",
      "2",
      "_",
      "-",
      "!",
      "",
      null,
      undefined,
      "棋",
      "♞",
      "ß",
      "ss",
      "İ",
      "i",
      "same",
      "same",
    ];
  const players = names.flatMap((username, i) =>
    [0, 1, 2].map((kind) => ({
      username,
      ownedId: `${i}/${kind}`,
      friendCount:
        kind === 0
          ? exact(0)
          : kind === 1
            ? { value: 999, precision: "lower_bound" }
            : { value: null, precision: "unknown" },
      ratings: {
        bullet: exact(kind === 2 ? null : 1200),
        blitz: exact(1200),
        rapid: exact(kind === 0 ? 1400 : null),
      },
    })),
  );
  verify(players);
  verify([]);
  verify([players[0]]);
});
test("String conversion calls and fallback order match original", () => {
  function run(sort) {
    const calls = [],
      input = ["a", "A", "b", "a"].map((value, id) => ({
        username: {
          toString() {
            calls.push(id);
            return value;
          },
        },
        id,
      }));
    return { ids: sort(input, "username").map((p) => p.id), calls };
  }
  assert.deepEqual(run(sortPlayers), run(originalSort));
});
test("collators initialize only when needed and at most once each per sort", () => {
  const Native = Intl.Collator,
    calls = [];
  Intl.Collator = function (...args) {
    calls.push(args);
    return new Native(...args);
  };
  try {
    sortPlayers([], "username");
    sortPlayers([{ username: "one" }], "username");
    sortPlayers(
      [
        { username: "b", friendCount: { value: 2, precision: "exact" } },
        { username: "a", friendCount: { value: 1, precision: "exact" } },
      ],
      "friends-asc",
    );
    assert.equal(calls.length, 0, "no name comparison needs no collator");
    sortPlayers(
      [{ username: "b" }, { username: "a" }, { username: "c" }],
      "username",
    );
    assert.deepEqual(
      calls,
      [["en", { sensitivity: "base" }]],
      "base comparison reuses one collator",
    );
    calls.length = 0;
    sortPlayers(
      [
        { username: "a" },
        { username: "A" },
        { username: "a" },
        { username: "A" },
      ],
      "username",
    );
    assert.deepEqual(
      calls,
      [["en", { sensitivity: "base" }], ["en"]],
      "tie comparison reuses default en collator",
    );
  } finally {
    Intl.Collator = Native;
  }
});
