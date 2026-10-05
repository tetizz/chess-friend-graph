export const RATING_BASES = ["blitz", "rapid", "bullet", "overall"];
const controls = RATING_BASES.slice(0, 3);
const key = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
const dated = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const canonical = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_, fraction = "") => `.${fraction.padEnd(3, "0")}Z`,
  );
  return new Date(value).toISOString() === canonical;
};
const unknown = (reason, evidence = {}) => ({
  value: null,
  precision: "unknown",
  observedAt: evidence.observedAt ?? null,
  sourceUrl: evidence.sourceUrl ?? null,
  lastRatedGameAt: null,
  reason,
});
function official(url, username) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname === "api.chess.com" &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname.toLowerCase() ===
        `/pub/player/${encodeURIComponent(key(username))}/stats`
    );
  } catch {
    return false;
  }
}
function field(input, username) {
  const f = input && typeof input === "object" ? input : {};
  if (f.precision !== "exact")
    return unknown(f.reason || "No validated rating observation.", f);
  if (
    !Number.isSafeInteger(f.value) ||
    f.value <= 0 ||
    !dated(f.observedAt) ||
    !official(f.sourceUrl, username) ||
    !dated(f.lastRatedGameAt) ||
    Date.parse(f.lastRatedGameAt) > Date.parse(f.observedAt) ||
    (f.ratingDeviation != null &&
      (!Number.isFinite(f.ratingDeviation) || f.ratingDeviation < 0))
  )
    return unknown("Rating evidence failed validation.", f);
  return {
    value: f.value,
    precision: "exact",
    observedAt: f.observedAt,
    sourceUrl: f.sourceUrl,
    lastRatedGameAt: f.lastRatedGameAt,
    ...(f.ratingDeviation != null
      ? { ratingDeviation: f.ratingDeviation }
      : {}),
  };
}
export function normalizeAccountRatings(input, username) {
  const ratings = Object.fromEntries(
    controls.map((c) => [c, field(input?.[c], username)]),
  );
  const fields = controls.map((c) => ratings[c]);
  ratings.overall = fields.every((f) => f.precision === "exact")
    ? {
        value: fields.reduce((sum, f) => sum + f.value / 3, 0),
        precision: "exact",
        derived: true,
        method: "arithmetic_mean_blitz_rapid_bullet",
        observedAt: fields
          .map((f) => f.observedAt)
          .sort()
          .at(-1),
        sourceUrl: fields[0].sourceUrl,
        lastRatedGameAt: null,
      }
    : {
        ...unknown(
          "Overall average requires validated blitz, rapid, and bullet ratings.",
        ),
        derived: true,
        method: "arithmetic_mean_blitz_rapid_bullet",
      };
  return ratings;
}
export function normalizeStatsObservation(record) {
  const r = record && typeof record === "object" ? record : {},
    username = key(r.username),
    issues = [];
  if (!username || r.schemaVersion !== 1)
    issues.push("Invalid Stats record identity or schema.");
  if (!dated(r.observedAt)) issues.push("Invalid UTC observation timestamp.");
  if (
    !official(r.sourceUrl, username) ||
    (r.finalUrl != null && !official(r.finalUrl, username))
  )
    issues.push("Stats source must be the official endpoint for this account.");
  if (
    r.httpStatus !== 200 ||
    r.error ||
    !r.stats ||
    typeof r.stats !== "object" ||
    Array.isArray(r.stats)
  )
    issues.push("Stats request did not yield a successful response.");
  const raw = {};
  for (const c of controls) {
    const last = r.stats?.[`chess_${c}`]?.last;
    let date = null;
    if (
      Number.isSafeInteger(last?.date) &&
      last.date > 0 &&
      last.date <= 8640000000000
    )
      date = new Date(last.date * 1000).toISOString();
    raw[c] = issues.length
      ? unknown(issues.join(" "), r)
      : field(
          {
            value: last?.rating,
            precision: "exact",
            observedAt: r.observedAt,
            sourceUrl: r.sourceUrl,
            lastRatedGameAt: date,
            ratingDeviation: last?.rd,
          },
          username,
        );
    if (!issues.length && raw[c].precision === "unknown")
      raw[c].reason = last
        ? "Invalid current last-rated-game evidence."
        : `No public ${c} rating in this observation.`;
  }
  const ratings = normalizeAccountRatings(raw, username);
  const metadata = {};
  if (official(r.sourceUrl, username)) {
    for (const name of ["etag", "lastModified", "cacheControl"]) {
      const value = r.responseMetadata?.[name];
      if (
        typeof value === "string" &&
        value.length <= 8192 &&
        !/[\u0000-\u001f\u007f]/.test(value)
      )
        metadata[name] = value;
    }
  }
  // Retrieval time is separate from these literal HTTP cache header values.
  return {
    username,
    observedAt: r.observedAt ?? null,
    sourceUrl: r.sourceUrl ?? null,
    ...(official(r.sourceUrl, username) && official(r.finalUrl, username)
      ? { finalUrl: r.finalUrl }
      : {}),
    ...(Object.keys(metadata).length ? { responseMetadata: metadata } : {}),
    ratings,
    valid: issues.length === 0,
    issues,
  };
}
export function selectStatsRatings(records, username) {
  const history = (Array.isArray(records) ? records : [])
    .filter((r) => key(r?.username) === key(username))
    .map(normalizeStatsObservation);
  const undated = history.some((r) => !dated(r.observedAt));
  const sorted = [...history]
    .filter((r) => dated(r.observedAt))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const latest = sorted[0],
    issues = [];
  let ratings;
  if (undated || !latest) {
    issues.push(
      undated
        ? "Observation chronology is unknown."
        : "No saved Stats observation.",
    );
    ratings = normalizeAccountRatings(
      Object.fromEntries(controls.map((c) => [c, unknown(issues[0])])),
      username,
    );
  } else {
    const peers = sorted.filter(
      (r) => Date.parse(r.observedAt) === Date.parse(latest.observedAt),
    );
    const raw = {};
    for (const c of controls) {
      const chosen = latest.ratings[c];
      const conflict = peers.some(
        (r) => JSON.stringify(r.ratings[c]) !== JSON.stringify(chosen),
      );
      raw[c] = conflict
        ? unknown(
            "Conflicting observations share the latest timestamp.",
            latest,
          )
        : chosen;
      if (conflict) issues.push(`Conflicting latest ${c} observations.`);
    }
    issues.push(...latest.issues);
    ratings = normalizeAccountRatings(raw, username);
  }
  return {
    ratings,
    history,
    observedAt: latest?.observedAt ?? null,
    sourceUrl: latest?.sourceUrl ?? null,
    issues,
  };
}
export function ratingFor(account, basis = "overall") {
  return (
    normalizeAccountRatings(account?.ratings, account?.username)[basis] ??
    unknown("Unknown rating basis.")
  );
}
export function mergeAccountRatings(candidates, username) {
  const raw = {};
  for (const c of controls) {
    const fields = candidates.filter(Boolean).map((r) => field(r[c], username));
    if (!fields.length || fields.some((f) => !dated(f.observedAt))) {
      raw[c] = unknown(
        "Duplicate rating observations lack an unambiguous observation order.",
      );
      continue;
    }
    fields.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
    const latest = fields[0],
      peers = fields.filter(
        (f) => Date.parse(f.observedAt) === Date.parse(latest.observedAt),
      );
    raw[c] = peers.some((f) => JSON.stringify(f) !== JSON.stringify(latest))
      ? unknown(
          "Conflicting duplicate rating observations share the latest timestamp.",
          latest,
        )
      : latest;
  }
  return normalizeAccountRatings(raw, username);
}
export function ratingLabel(f) {
  return f?.precision === "exact" && Number.isFinite(f.value) && f.value > 0
    ? f.value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : "Unknown";
}
export function ratingDomain(accounts, basis = "overall") {
  const values = accounts
    .map((a) => ratingFor(a, basis))
    .filter((f) => f.precision === "exact")
    .map((f) => f.value);
  const observedMaximum = values.reduce(
    (max, value) => Math.max(max, value),
    0,
  );
  return {
    observedMaximum,
    displayMaximum: Math.max(1, Math.ceil(observedMaximum * 1.1)),
  };
}
