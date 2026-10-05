/** Pure presentation helpers. Values describe saved observations, never live counts. */
export const TITLE_ORDER = Object.freeze([
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
export const TITLE_COLORS = Object.freeze({
  GM: "#85c74e",
  IM: "#d0a45c",
  FM: "#74b7aa",
  CM: "#8eacd3",
  NM: "#a8afa1",
  WGM: "#b4d77a",
  WIM: "#d7b981",
  WFM: "#b6a1cd",
  WCM: "#cd9fba",
  WNM: "#aaa0b7",
  M: "#b7ab90",
});
export const RATING_LABELS = Object.freeze({
  overall: "Overall",
  bullet: "Bullet",
  blitz: "Blitz",
  rapid: "Rapid",
});
const controls = ["bullet", "blitz", "rapid"];
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const validRating = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 100;

export function normalizeCount(count) {
  if (
    !count ||
    !validCount(count.value) ||
    !["exact", "lower_bound"].includes(count.precision)
  ) {
    return { value: null, precision: "unknown" };
  }
  // A displayed plus sign is affirmative lower-bound evidence; it cannot become exact.
  const precision =
    typeof count.display === "string" && count.display.includes("+")
      ? "lower_bound"
      : count.precision;
  return { ...count, value: count.value, precision };
}

export function countText(count) {
  const normalized = normalizeCount(count);
  if (normalized.precision === "unknown") return "Unknown";
  return (
    normalized.value.toLocaleString("en-US") +
    (normalized.precision === "lower_bound" ? "+" : "")
  );
}

export function ratingValue(account, axis = "overall") {
  if (axis === "overall") {
    const values = controls.map((control) => ratingValue(account, control));
    if (values.some((value) => value === null)) return null;
    const sum = values.reduce((total, value) => total + value, 0);
    // Preserve ordinary arithmetic rounding, with an overflow-safe fallback.
    const mean = Number.isFinite(sum)
      ? sum / 3
      : values.reduce((total, value) => total + value / 3, 0);
    return Number.isFinite(mean) ? mean : null;
  }
  if (!controls.includes(axis)) return null;
  const rating = account?.ratings?.[axis];
  return rating?.precision === "exact" && validRating(rating.value)
    ? rating.value
    : null;
}

const bound = (value) => {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim())
  )
    return null;
  if (!["number", "string"].includes(typeof value)) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
function inRange(value, minimum, maximum) {
  if (minimum === null && maximum === null) return true;
  return (
    value !== null &&
    (minimum === null || value >= minimum) &&
    (maximum === null || value <= maximum)
  );
}

export function filterPlayers(accounts, state = {}) {
  const search = String(state.search ?? "")
    .trim()
    .toLowerCase();
  const titles = new Set(Array.isArray(state.titles) ? state.titles : []);
  const axis = state.axis ?? "overall";
  const ratingBound = (value) => {
    const parsed = bound(value);
    return parsed === null ? null : Math.max(100, parsed);
  };
  const minRating = ratingBound(state.minRating),
    maxRating = ratingBound(state.maxRating);
  const minFriends = bound(state.minFriends),
    maxFriends = bound(state.maxFriends);
  return accounts.filter((account) => {
    if (
      search &&
      ![account.username, account.name].some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(search),
      )
    )
      return false;
    if (titles.size && !titles.has(account.title)) return false;
    const count = normalizeCount(account.friendCount);
    if (
      state.precision &&
      state.precision !== "all" &&
      count.precision !== state.precision
    )
      return false;
    return (
      inRange(ratingValue(account, axis), minRating, maxRating) &&
      inRange(count.value, minFriends, maxFriends)
    );
  });
}

export function sortPlayers(accounts, key = "friends-desc", axis = "overall") {
  const result = [...accounts];
  const usernameOrder = (a, b) =>
    String(a.username ?? "").localeCompare(String(b.username ?? ""), "en", {
      sensitivity: "base",
    }) ||
    String(a.username ?? "").localeCompare(String(b.username ?? ""), "en");
  if (key === "username") return result.sort(usernameOrder);
  const rating = key.startsWith("rating-");
  const direction = key.endsWith("-asc") ? 1 : -1;
  return result.sort((a, b) => {
    const av = rating
      ? ratingValue(a, axis)
      : normalizeCount(a.friendCount).value;
    const bv = rating
      ? ratingValue(b, axis)
      : normalizeCount(b.friendCount).value;
    if (av === null || bv === null)
      return av === bv ? usernameOrder(a, b) : av === null ? 1 : -1;
    return direction * (av - bv) || usernameOrder(a, b);
  });
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b),
    mid = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[mid]
    : ordered[mid - 1] / 2 + ordered[mid] / 2;
}
export function summarize(accounts, axis = "overall") {
  let exact = 0,
    lowerBound = 0,
    unknown = 0,
    plotted = 0;
  const ratings = [],
    exactFriends = [];
  for (const account of accounts) {
    const count = normalizeCount(account.friendCount),
      rating = ratingValue(account, axis);
    if (count.precision === "exact") {
      exact++;
      exactFriends.push(count.value);
    } else if (count.precision === "lower_bound") lowerBound++;
    else unknown++;
    if (rating !== null) ratings.push(rating);
    if (rating !== null && count.value !== null) plotted++;
  }
  return {
    total: accounts.length,
    plotted,
    exact,
    lowerBound,
    unknown,
    medianRating: median(ratings),
    medianFriends: median(exactFriends),
    maxFriends: exactFriends.length
      ? exactFriends.reduce((maximum, value) => Math.max(maximum, value), 0)
      : null,
  };
}

/** Continuous domain, including fractional overall ratings; no fixed category bins. */
export function fitRatingRange(values) {
  let min = Infinity,
    max = -Infinity;
  for (const value of values)
    if (validRating(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  if (min === Infinity) return [100, 3000];
  const padding = max === min ? Math.max(25, max * 0.025) : (max - min) * 0.04;
  return [Math.max(100, min - padding), max + padding];
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  // Quoting alone does not prevent spreadsheet formula execution.
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text))
    text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function makeCsv(accounts) {
  const rows = [
    [
      "Username",
      "Title",
      "Name",
      "Friends",
      "Friend count precision",
      "Bullet",
      "Blitz",
      "Rapid",
      "Overall",
      "Profile URL",
    ],
  ];
  for (const account of accounts) {
    const count = normalizeCount(account.friendCount);
    rows.push([
      account.username,
      account.title,
      account.name,
      count.value === null
        ? null
        : String(count.value) + (count.precision === "lower_bound" ? "+" : ""),
      count.precision,
      ...controls.map((control) => ratingValue(account, control)),
      ratingValue(account),
      account.profileUrl,
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
