import {
  normalizeAccountRatings,
  mergeAccountRatings,
} from "./rating-model.mjs";
export const TITLE_ORDER = [
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
];

// Parse only a displayed count, never a page's other numbers or an empty label.
export function parseFriendCount(display) {
  if (typeof display !== "string")
    return { value: null, display: null, precision: "unknown" };
  const label = display.trim();
  const match = /^(\d+|\d{1,3}(?:,\d{3})+)\s*(\+)?$/.exec(label);
  const value = match ? Number(match[1].replaceAll(",", "")) : null;
  if (!Number.isSafeInteger(value))
    return { value: null, display: label, precision: "unknown" };
  return {
    value,
    display: label,
    precision: match[2] ? "lower_bound" : "exact",
  };
}

export function normalizeFriendCount(input = {}) {
  const f = input && typeof input === "object" ? input : {};
  const valid =
    ["exact", "lower_bound"].includes(f.precision) &&
    Number.isSafeInteger(f.value) &&
    f.value >= 0;
  if (!valid) return { ...f, value: null, precision: "unknown" };
  // A literal plus is direct evidence of a lower bound, even if ingestion mislabeled it.
  const displayed = parseFriendCount(f.display);
  if (displayed.precision === "lower_bound") {
    return { ...f, value: displayed.value, precision: "lower_bound" };
  }
  if (displayed.precision === "exact" && displayed.value !== f.value) {
    return {
      ...f,
      value: null,
      precision: "unknown",
      reason: "Stored count conflicts with its displayed observation.",
    };
  }
  return { ...f };
}

export function normalizeAccounts(accounts) {
  const seen = new Map(),
    ratingCandidates = new Map();
  for (const a of Array.isArray(accounts) ? accounts : []) {
    if (
      !a ||
      typeof a.username !== "string" ||
      !a.username.trim() ||
      typeof a.title !== "string" ||
      !a.title.trim()
    )
      continue;
    const key = a.username.trim().toLowerCase();
    const row = {
      ...a,
      username: a.username.trim(),
      title: a.title.trim(),
      friendCount: normalizeFriendCount(a.friendCount),
      ratings: normalizeAccountRatings(a.ratings, a.username),
    };
    if (!ratingCandidates.has(key)) ratingCandidates.set(key, []);
    if (a.ratings) ratingCandidates.get(key).push(a.ratings);
    if (!seen.has(key)) {
      seen.set(key, row);
      continue;
    }
    const previous = seen.get(key);
    previous.isYourFriend = Boolean(previous.isYourFriend || row.isYourFriend);
    previous.isAkshitFriend = Boolean(
      previous.isAkshitFriend || row.isAkshitFriend,
    );
    if (
      publicListEnumeration(row) &&
      (!publicListEnumeration(previous) ||
        Date.parse(row.publicListEnumeration.observedAt) >
          Date.parse(previous.publicListEnumeration.observedAt))
    )
      previous.publicListEnumeration = row.publicListEnumeration;
    if (previous.title !== row.title)
      previous.titleConflict = [
        ...new Set([
          ...(previous.titleConflict || [previous.title]),
          row.title,
        ]),
      ];
    const before = previous.friendCount,
      after = row.friendCount;
    const beforeTime = Date.parse(before.observedAt),
      afterTime = Date.parse(after.observedAt);
    if (
      after.precision !== "unknown" &&
      (before.precision === "unknown" ||
        (Number.isFinite(afterTime) &&
          (!Number.isFinite(beforeTime) || afterTime > beforeTime)))
    )
      previous.friendCount = after;
    else if (
      before.precision !== "unknown" &&
      after.precision !== "unknown" &&
      (before.value !== after.value || before.precision !== after.precision) &&
      (!Number.isFinite(beforeTime) ||
        !Number.isFinite(afterTime) ||
        beforeTime === afterTime)
    )
      previous.friendCount = {
        value: null,
        precision: "unknown",
        reason:
          "Conflicting duplicate observations lack an unambiguous observation order.",
      };
  }
  return [...seen.entries()].map(([key, row]) => ({
    ...row,
    ratings:
      ratingCandidates.get(key).length > 1
        ? mergeAccountRatings(ratingCandidates.get(key), row.username)
        : normalizeAccountRatings(ratingCandidates.get(key)[0], row.username),
  }));
}
export function connection(a) {
  return a.isYourFriend && a.isAkshitFriend
    ? "both"
    : a.isYourFriend
      ? "you"
      : a.isAkshitFriend
        ? "akshit"
        : "directory";
}
export function filterAccounts(
  accounts,
  { search = "", titles = new Set(), membership = "all" } = {},
) {
  const q = search.trim().toLowerCase();
  return accounts.filter(
    (a) =>
      (!q || `${a.username} ${a.name || ""}`.toLowerCase().includes(q)) &&
      (!titles.size || titles.has(a.title)) &&
      (membership === "all" ||
        (membership === "both" && connection(a) === "both") ||
        (membership === "you" && a.isYourFriend) ||
        (membership === "akshit" && a.isAkshitFriend)),
  );
}
export function countPrecisions(accounts) {
  return accounts.reduce(
    (s, a) => {
      s[normalizeFriendCount(a.friendCount).precision]++;
      return s;
    },
    { exact: 0, lower_bound: 0, unknown: 0 },
  );
}
export function countLabel(input) {
  const f = normalizeFriendCount(input);
  return f.precision === "unknown"
    ? "Unknown"
    : f.precision === "lower_bound"
      ? `At least ${f.value.toLocaleString()}; exact count unknown (displayed ${f.display || f.value + "+"})`
      : f.value.toLocaleString();
}
// This field is admitted by the dataset bridge only after terminal traversal validation.
export function publicListEnumeration(account) {
  const f = account?.publicListEnumeration;
  if (
    !f ||
    f.status !== "verified" ||
    f.precision !== "exact" ||
    f.scope !== "saved_terminal_traversal" ||
    f.method !== "alphabetical_public_pagination" ||
    f.snapshotVerified !== false ||
    !Number.isSafeInteger(f.value) ||
    f.value < 1 ||
    f.display !== String(f.value) ||
    !Number.isFinite(Date.parse(f.startedAt)) ||
    !Number.isFinite(Date.parse(f.observedAt)) ||
    Date.parse(f.startedAt) > Date.parse(f.observedAt)
  )
    return null;
  return f;
}
export function plotCount(account, basis = "site") {
  const counted = basis === "counted" && publicListEnumeration(account);
  return counted
    ? { ...counted, counted: true }
    : normalizeFriendCount(account.friendCount);
}
export function plotCountLabel(account, basis = "site") {
  const f = plotCount(account, basis);
  return f.counted
    ? `${f.value.toLocaleString()} unique public friends counted during ${f.startedAt}–${f.observedAt}`
    : countLabel(f);
}
export function chartDomain(accounts, basis = "site") {
  const counts = accounts.map((a) => plotCount(a, basis));
  const observedMaximum = counts.reduce(
    (maximum, f) =>
      f.precision === "unknown" ? maximum : Math.max(maximum, f.value),
    10,
  );
  return {
    observedMaximum,
    displayMaximum: Math.ceil(observedMaximum * 1.25),
    upperBoundUnknown: counts.some((f) => f.precision === "lower_bound"),
  };
}
