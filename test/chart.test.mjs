import test from "node:test";
import assert from "node:assert/strict";
import {
  makeTransform,
  fitView,
  nearestPoint,
  zoomView,
  sanitizeView,
} from "../src/chart.mjs";
const view = {
  minRating: 1000,
  maxRating: 2500,
  minFriends: 0,
  maxFriends: 10000,
};
for (const scale of ["linear", "log"])
  test(`${scale} coordinate round trip includes zero`, () => {
    const t = makeTransform(view, scale);
    for (const [rating, friends] of [
      [1000, 0],
      [1750, 123],
      [2500, 10000],
    ]) {
      const p = t.point(rating, friends),
        v = t.value(p.x, p.y);
      assert(Math.abs(v.rating - rating) < 1e-8);
      assert(Math.abs(v.friends - friends) < 1e-7);
    }
  });
test("hit testing selects closest within radius and refuses outside", () => {
  const a = { x: 20, y: 20 },
    b = { x: 30, y: 20 };
  assert.equal(nearestPoint([a, b], 28, 20, 5), b);
  assert.equal(nearestPoint([a, b], 100, 100, 14), null);
});
test("zoom preserves anchor relative position in log and linear space", () => {
  for (const scale of ["linear", "log"]) {
    const anchor = { rating: 1600, friends: 250 },
      next = zoomView(view, anchor, 0.5, scale),
      p = makeTransform(view, scale).point(anchor.rating, anchor.friends),
      q = makeTransform(next, scale).point(anchor.rating, anchor.friends);
    assert(Math.abs(p.x - q.x) < 1e-7);
    assert(Math.abs(p.y - q.y) < 1e-7);
  }
});
test("bad view bounds recover and counts cannot become negative", () => {
  const v = sanitizeView(
    { minRating: NaN, maxRating: -1, minFriends: -5, maxFriends: -3 },
    view,
  );
  assert.equal(v.minRating, 1000);
  assert(v.maxRating > v.minRating);
  assert.equal(v.minFriends, 0);
  assert(v.maxFriends > 0);
  const z = zoomView(view, { rating: 1750, friends: 0 }, 3, "log");
  assert(z.minFriends >= 0);
  assert(z.maxFriends > z.minFriends);
});

test("renderer draws all eligible points, permits mobile scrolling, and preserves resized tap geometry", async () => {
  const { mountChart } = await import("../src/chart.mjs");
  const oldWindow = globalThis.window,
    oldDocument = globalThis.document,
    oldCancel = globalThis.cancelAnimationFrame;
  let circles = 0,
    selected = 0,
    changed = 0,
    rectWidth = 1100,
    rectHeight = 500;
  const listeners = new Map(),
    ctx = {
      setTransform() {},
      clearRect() {},
      save() {},
      beginPath() {},
      rect() {},
      clip() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {},
      stroke() {},
      restore() {},
      arc() {
        circles++;
      },
    };
  const canvas = {
    style: {},
    setAttribute() {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({
      width: rectWidth,
      height: rectHeight,
      left: 0,
      top: 0,
    }),
    addEventListener(n, fn) {
      listeners.set(n, fn);
    },
    removeEventListener() {},
  };
  const overlay = {
    style: {},
    setAttribute() {},
    replaceChildren() {},
    append() {},
  };
  const tooltip = { style: {}, hidden: true };
  globalThis.window = {
    devicePixelRatio: 2,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = { createElementNS: () => ({ setAttribute() {} }) };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const chart = mountChart({
      canvas,
      overlay,
      tooltip,
      onSelect: () => selected++,
      onViewChange: () => changed++,
    });
    const rating = { value: 1500, precision: "exact" },
      players = Array.from({ length: 2000 }, (_, i) => ({
        username: `p${i}`,
        title: "GM",
        friendCount: { value: i, precision: "exact" },
        ratings: { blitz: rating },
      }));
    players.push({
      username: "missing",
      friendCount: { value: 1, precision: "unknown" },
      ratings: { blitz: rating },
    });
    chart.render(players, { axis: "blitz" });
    assert.equal(circles, 2000);
    assert.equal(canvas.width, 2200);
    assert.equal(canvas.height, 1000);
    assert.equal(overlay.style.pointerEvents, "none");
    assert.equal(canvas.style.touchAction, "pan-y pinch-zoom");
    const touch = (x, y) => ({
      button: 0,
      pointerType: "touch",
      pointerId: 1,
      clientX: x,
      clientY: y,
    });
    listeners.get("pointerdown")(touch(574, 434));
    listeners.get("pointermove")(touch(574, 464));
    listeners.get("pointerup")(touch(574, 464));
    assert.equal(selected, 0);
    assert.equal(changed, 0, "touch scrolling must not pan or notify chart");
    listeners.get("pointerdown")(touch(574, 434));
    listeners.get("pointerup")(touch(574, 434));
    assert.equal(selected, 1);
    rectWidth = 550;
    rectHeight = 250;
    listeners.get("pointerdown")(touch(287, 217));
    listeners.get("pointerup")(touch(287, 217));
    assert.equal(selected, 2, "CSS resize preserves hit geometry");
    chart.zoom(0.8);
    assert.equal(changed, 1);
    chart.zoom(NaN);
    assert.equal(changed, 1);
    chart.destroy();
  } finally {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});

test("rating domain floor applies to sanitize, empty fit, and zoom without a maximum cap", () => {
  const empty = sanitizeView(fitView([]), view);
  assert.equal(empty.minRating, 100);
  assert(empty.maxRating > 100);
  const panned = sanitizeView({ minRating: -200, maxRating: 1800 }, view);
  assert.equal(panned.minRating, 100);
  assert.equal(panned.maxRating, 2100);
  assert.equal(panned.maxRating - panned.minRating, 2000);
  const invalid = sanitizeView({ minRating: 0, maxRating: 0 }, view);
  assert.equal(invalid.minRating, 100);
  assert(invalid.maxRating > 100);
  const low = {
    minRating: 100,
    maxRating: 1200,
    minFriends: 0,
    maxFriends: 500,
  };
  const zoomed = zoomView(low, { rating: 150, friends: 200 }, 3);
  assert.equal(zoomed.minRating, 100);
  assert.equal(zoomed.maxRating - zoomed.minRating, 3300);
  assert(zoomed.maxRating > 100);
  const away = zoomView(view, { rating: 1750, friends: 300 }, 0.5);
  assert.equal(away.minRating, 1375);
  assert.equal(away.maxRating, 2125);
});
