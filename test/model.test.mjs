import test from "node:test";
import assert from "node:assert/strict";
import {
  TITLE_ORDER,
  TITLE_COLORS,
  normalizeCount,
  countText,
  ratingValue,
  filterPlayers,
  sortPlayers,
  summarize,
  fitRatingRange,
  makeCsv,
} from "../src/model.mjs";
const exact = (value) => ({ value, precision: "exact" });
const player = (username, count, ratings = [1000, 1100, 1200], extra = {}) => ({
  username,
  title: "GM",
  friendCount: count,
  ratings: Object.fromEntries(
    ["bullet", "blitz", "rapid"].map((control, index) => [
      control,
      exact(ratings[index]),
    ]),
  ),
  ...extra,
});
test("title series are unique with complete valid colors and immutable constants", () => {
  assert.deepEqual(TITLE_ORDER, [
    "GM",
    "IM",
    "FM",
    "CM",
    "NM",
    "WGM",
    "WIM",
    "WFM",
    "WCM",
    "WNM",
    "M",
  ]);
  assert.equal(new Set(TITLE_ORDER).size, TITLE_ORDER.length);
  assert(
    TITLE_ORDER.every((title) => /^#[a-f0-9]{6}$/i.test(TITLE_COLORS[title])),
  );
  assert(Object.isFrozen(TITLE_ORDER));
  assert(Object.isFrozen(TITLE_COLORS));
  const titled = [
    player("woman-national", exact(1), undefined, { title: "WNM" }),
    player("master", exact(2), undefined, { title: "M" }),
  ];
  assert.deepEqual(
    filterPlayers(titled, { titles: ["WNM", "M"] }).map((p) => p.title),
    ["WNM", "M"],
  );
});
test("exact zero, lower bounds and unknown remain distinct", () => {
  assert.equal(countText(exact(0)), "0");
  assert.equal(countText({ value: 999, precision: "lower_bound" }), "999+");
  assert.equal(countText({ value: null, precision: "unknown" }), "Unknown");
  assert.equal(countText(exact(8812)), "8,812");
});
test("literal plus cannot be promoted to exact; no display-only count inference", () => {
  assert.equal(
    normalizeCount({ ...exact(999), display: "999+" }).precision,
    "lower_bound",
  );
  assert.deepEqual(normalizeCount({ display: "999+" }), {
    value: null,
    precision: "unknown",
  });
});
test("malformed counts fail closed without coercion or mutation", () => {
  for (const value of [
    -1,
    0.5,
    Infinity,
    NaN,
    "0",
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(normalizeCount(exact(value)).precision, "unknown");
  assert.equal(normalizeCount({ value: 7, precision: "unknown" }).value, null);
  const raw = Object.freeze({ ...exact(8), display: "8+" });
  assert.equal(normalizeCount(raw).precision, "lower_bound");
  assert.equal(raw.precision, "exact");
});
test("overall requires all three exact controls and ignores stored overall", () => {
  const p = player("a", exact(0), [1000, 1001, 1003]);
  p.ratings.overall = exact(9999);
  assert(Math.abs(ratingValue(p) - 1001.3333333333334) < 1e-9);
  p.ratings.rapid = { value: 1003, precision: "unknown" };
  assert.equal(ratingValue(p), null);
  assert.equal(ratingValue(p, "bullet"), 1000);
});
test("rating minimum is 100; below-floor observations stay unknown", () => {
  assert.equal(ratingValue(player("floor", exact(0), [100, 100, 100])), 100);
  for (const value of [
    null,
    undefined,
    -1,
    0,
    99,
    99.999,
    Infinity,
    NaN,
    "2000",
  ]) {
    const p = player("a", exact(0), [value, 200, 300]);
    assert.equal(ratingValue(p, "bullet"), null);
    assert.equal(ratingValue(p), null);
    assert.equal(p.ratings.bullet.value, value);
    assert.equal(normalizeCount(p.friendCount).value, 0);
  }
  const p = player("a", exact(1));
  p.ratings.bullet.precision = "lower_bound";
  assert.equal(ratingValue(p), null);
  assert.equal(ratingValue(p, "unsupported"), null);
});
const sample = [
  player("Alpha", exact(0), [100, 100, 100], { name: "First Player" }),
  player("Beta", { value: 100, precision: "lower_bound" }, [1500, 1500, 1500], {
    title: "IM",
  }),
  player("Unknown", null, [null, null, null]),
];
test("no ranges preserves unknowns; username/name search and empty title filter", () => {
  assert.equal(filterPlayers(sample).length, 3);
  assert.deepEqual(
    filterPlayers(sample, { search: " FIRST ", titles: [] }).map(
      (p) => p.username,
    ),
    ["Alpha"],
  );
  assert.deepEqual(
    filterPlayers(sample, { titles: ["IM"] }).map((p) => p.username),
    ["Beta"],
  );
});
test("numeric ranges inclusive, zero bounds impose filtering, corresponding unknown excluded", () => {
  assert.deepEqual(
    filterPlayers(sample, { minFriends: 0, maxFriends: 0 }).map(
      (p) => p.username,
    ),
    ["Alpha"],
  );
  assert.deepEqual(
    filterPlayers(sample, { minRating: "1500", maxRating: 1500 }).map(
      (p) => p.username,
    ),
    ["Beta"],
  );
  assert.deepEqual(filterPlayers(sample, { minRating: 150, maxRating: 0 }), []);
  assert.equal(
    filterPlayers(sample, { minFriends: "", maxRating: null }).length,
    3,
  );
  assert.equal(
    filterPlayers(sample, { minFriends: "  ", maxRating: false }).length,
    3,
  );
});
test("rating bounds clamp to 100; below-floor players remain unknown", () => {
  const below = player("below", exact(0), [99, 200, 300]);
  assert.equal(filterPlayers([below]).length, 1);
  assert.equal(filterPlayers([below], { minRating: 0 }).length, 0);
  assert.deepEqual(
    filterPlayers(sample, { minRating: -5, maxRating: 99 }).map(
      (p) => p.username,
    ),
    ["Alpha"],
  );
  assert.equal(
    filterPlayers(sample, { minRating: 100, maxRating: 5000 }).length,
    2,
  );
});
test("a range on one axis leaves unknown on the other axis visible", () => {
  const p = player("a", null, [2000, 2000, 2000]);
  assert.equal(filterPlayers([p], { minRating: 2000 }).length, 1);
  assert.equal(filterPlayers([p], { minFriends: 0 }).length, 0);
});
test("precision filters use normalized literal plus and intersect ranges", () => {
  const p = player("a", { ...exact(999), display: "999+" });
  assert.equal(filterPlayers([p], { precision: "exact" }).length, 0);
  assert.equal(
    filterPlayers([p], { precision: "lower_bound", minFriends: 999 }).length,
    1,
  );
  assert.equal(filterPlayers(sample, { precision: "unknown" }).length, 1);
});
test("sort missing last both directions without altering input", () => {
  for (const key of [
    "friends-desc",
    "friends-asc",
    "rating-desc",
    "rating-asc",
  ])
    assert.equal(sortPlayers(sample, key).at(-1).username, "Unknown");
  assert.equal(sortPlayers(sample, "friends-asc")[0].username, "Alpha");
  assert.equal(sortPlayers(sample, "friends-desc")[0].username, "Beta");
  assert.equal(sample[0].username, "Alpha");
  assert.deepEqual(
    sortPlayers([...sample].reverse(), "username").map((p) => p.username),
    ["Alpha", "Beta", "Unknown"],
  );
});
test("summary plots known rating/count; friend median/max exact only", () => {
  const result = summarize([
    ...sample,
    player("Other", exact(10), [3000, 3000, 3000]),
  ]);
  assert.deepEqual(result, {
    total: 4,
    plotted: 3,
    exact: 2,
    lowerBound: 1,
    unknown: 1,
    medianRating: 1500,
    medianFriends: 5,
    maxFriends: 10,
  });
  assert.equal(summarize([sample[1]]).medianFriends, null);
  assert.equal(summarize([sample[1]]).maxFriends, null);
  assert.deepEqual(summarize([]), {
    total: 0,
    plotted: 0,
    exact: 0,
    lowerBound: 0,
    unknown: 0,
    medianRating: null,
    medianFriends: null,
    maxFriends: null,
  });
});
test("continuous fit covers fractional extrema and respects minimum 100", () => {
  const [low, high] = fitRatingRange([1000.5, 2600.25, null, NaN, -1]);
  assert(low < 1000.5);
  assert(high > 2600.25);
  assert.deepEqual(fitRatingRange([]), [100, 3000]);
  assert.deepEqual(fitRatingRange([0, 99, -1, NaN]), [100, 3000]);
  assert.deepEqual(fitRatingRange([100]), [100, 125]);
  const floor = fitRatingRange([99, 100, 101]);
  assert.equal(floor[0], 100);
  assert(floor[1] > floor[0]);
  const single = fitRatingRange([1500]);
  assert(single[0] < 1500 && single[1] > 1500);
});
test("CSV preserves zero/unknown/lower-bound and recomputed strict overall", () => {
  const csv = makeCsv(sample);
  assert(
    csv.includes(
      '"Alpha","GM","First Player","0","exact","100","100","100","100"',
    ),
  );
  assert(csv.includes('"Beta","IM","","100+","lower_bound"'));
  assert(csv.includes('"Unknown","GM","","","unknown","","","",""'));
  assert(csv.endsWith("\r\n"));
});
test("CSV escapes quotes, commas, newlines and spreadsheet formulas", () => {
  const csv = makeCsv([
    player('=HYPERLINK("x")', exact(0), [0, 0, 0], {
      name: ' @SUM(1,2)\n"quoted"',
      title: "+GM",
      profileUrl: "\t=evil",
    }),
  ]);
  assert(csv.includes('"\'=HYPERLINK(""x"")"'));
  assert(csv.includes('"\'+GM"'));
  assert(csv.includes('"\' @SUM(1,2)\n""quoted"""'));
  assert(csv.includes('"\'\t=evil"'));
});
