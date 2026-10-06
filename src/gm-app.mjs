const PAGE_SIZE = 20,
  GEN = /^[a-f0-9]{64}$/,
  USER = /^[a-z0-9_-]{1,50}$/i;
export function statusOf(list) {
  return list?.complete === true && list.status === "complete"
    ? "complete"
    : list?.status === "partial"
      ? "partial"
      : "unknown";
}
export function filterRoster(accounts, search = "", status = "all") {
  const q = search.trim().toLowerCase();
  return accounts.filter(
    (a) =>
      a.username.toLowerCase().includes(q) &&
      (status === "all" || statusOf(a.friendList) === status),
  );
}
export function countText(f) {
  if (
    !f ||
    !["exact", "lower_bound"].includes(f.precision) ||
    !Number.isSafeInteger(f.value) ||
    f.value < 0
  )
    return "Unknown";
  return (
    f.value.toLocaleString("en-US") + (f.precision === "lower_bound" ? "+" : "")
  );
}
function validateSummary(l) {
  if (
    !l ||
    !["complete", "partial", "unknown"].includes(l.status) ||
    typeof l.complete !== "boolean" ||
    !Number.isSafeInteger(l.enumeratedCount) ||
    l.enumeratedCount < 0 ||
    l.complete !== (l.status === "complete")
  )
    throw Error("Invalid saved friend-list status.");
}
function validTraversalUtc(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(
    value,
  );
  if (!match) return false;
  const milliseconds = (match[2] || "").padEnd(3, "0").slice(0, 3);
  const normalized = match[1] + "." + milliseconds + "Z";
  const parsed = Date.parse(normalized);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString() === normalized
  );
}
export function validateTraversal(value, count) {
  if (value == null) return null;
  const keys = [
    "status",
    "traversalComplete",
    "snapshotVerified",
    "count",
    "pageCount",
    "startedAt",
    "endedAt",
  ];
  if (
    typeof value !== "object" ||
    value.status !== "verified" ||
    value.traversalComplete !== true ||
    value.snapshotVerified !== false ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0 ||
    value.count !== count ||
    !Number.isSafeInteger(value.pageCount) ||
    value.pageCount < 1 ||
    ![value.startedAt, value.endedAt].every(validTraversalUtc) ||
    Date.parse(value.endedAt) < Date.parse(value.startedAt)
  )
    throw Error("Invalid saved traversal evidence.");
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
export function traversalText(value) {
  return value
    ? "Saved traversal finished: " +
        value.count.toLocaleString("en-US") +
        " names across " +
        value.pageCount +
        " pages. Observed " +
        date(value.startedAt) +
        " to " +
        date(value.endedAt) +
        ". The list could change between pages; this saved count may differ from the current total."
    : null;
}
export function validateIndex(data, generation) {
  if (
    data?.schemaVersion !== 1 ||
    data.generation !== generation ||
    !GEN.test(generation) ||
    !Array.isArray(data.accounts)
  )
    throw Error("The saved GM roster could not be verified.");
  const seen = new Set();
  for (const a of data.accounts) {
    if (
      !USER.test(a.username) ||
      a.title !== "GM" ||
      seen.has(a.username.toLowerCase())
    )
      throw Error("Invalid saved GM identity.");
    seen.add(a.username.toLowerCase());
    validateSummary(a.friendList);
    validateTraversal(a.savedTraversal, a.friendList.enumeratedCount);
  }
  return data;
}
export function validateFriends(data, account, generation) {
  if (
    data?.schemaVersion !== 1 ||
    data.generation !== generation ||
    data.username?.toLowerCase() !== account.username.toLowerCase() ||
    !Array.isArray(data.friendList?.friends)
  )
    throw Error("The saved list does not match this GM publication.");
  const l = data.friendList,
    seen = new Set();
  validateSummary(l);
  for (const f of l.friends) {
    if (
      !USER.test(f.username) ||
      seen.has(f.username.toLowerCase()) ||
      (f.title != null && typeof f.title !== "string")
    )
      throw Error("Invalid saved friend rows.");
    seen.add(f.username.toLowerCase());
  }
  if (l.enumeratedCount !== l.friends.length)
    throw Error("The saved row count does not match this list.");
  if (
    (l.complete === true && l.status !== "complete") ||
    (l.status === "complete" && l.complete !== true)
  )
    throw Error("Inconsistent list completeness.");
  if (
    statusOf(l) !== statusOf(account.friendList) ||
    l.enumeratedCount !== account.friendList.enumeratedCount
  )
    throw Error("Roster and friend list summaries disagree.");
  const actualTraversal = validateTraversal(
    data.savedTraversal,
    l.enumeratedCount,
  );
  const expectedTraversal = validateTraversal(
    account.savedTraversal,
    account.friendList.enumeratedCount,
  );
  if (JSON.stringify(actualTraversal) !== JSON.stringify(expectedTraversal))
    throw Error("Roster and list traversal evidence disagree.");
  return data;
}
export function publicListDownload(data) {
  const l = data.friendList;
  return {
    schemaVersion: 1,
    generation: data.generation,
    username: data.username,
    generatedAt: data.generatedAt ?? null,
    ...(data.savedTraversal
      ? {
          savedTraversal: validateTraversal(
            data.savedTraversal,
            l.enumeratedCount,
          ),
        }
      : {}),
    friendList: {
      status: l.status,
      complete: l.complete,
      enumeratedCount: l.enumeratedCount,
      observedAt: l.observedAt ?? null,
      sourceUrl: l.sourceUrl ?? null,
      friends: l.friends.map((f) => ({
        username: f.username,
        title: f.title ?? null,
      })),
    },
  };
}
export function listDescription(list, traversal) {
  const status = statusOf(list);
  if (status === "partial" && traversal)
    return "Partial saved list. All public pages were read; the displayed total was capped.";
  if (status === "complete")
    return "Complete saved public list / " + list.friends.length + " friends.";
  if (status === "partial")
    return (
      "Partial saved list / " +
      list.friends.length +
      " captured friends. Additional friends may be missing."
    );
  return (
    "Unknown list completeness / " +
    list.friends.length +
    " saved rows. Missing rows do not mean no friends."
  );
}
export function displayedScanCount(list) {
  if (!list.displayedTotal) return null;
  const count = countText(list.displayedTotal);
  return (
    "Displayed during the scan: " +
    count +
    " friends" +
    (list.displayedTotal.precision === "lower_bound" ? " (lower bound)." : ".")
  );
}
function date(value) {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value)
        .toISOString()
        .replace("T", " ")
        .replace(".000Z", " UTC")
        .replace("Z", " UTC")
    : "Unknown date";
}
export function sourceName(type) {
  if (type === "chess_com_mobile_api") return "Chess.com app service";
  if (type === "chess_com_native_app_ui") return "Chess.com Android app";
  if (["chess_com_public_profile_ui", "chess_com_website_ui"].includes(type))
    return "Chess.com public website";
  return "Unknown source";
}
function safeLink(url, label) {
  const a = document.createElement("a");
  try {
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      !["www.chess.com", "api.chess.com"].includes(u.hostname)
    )
      throw Error();
    a.href = u.href;
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    a.textContent = label;
  } catch {
    a.textContent = label + " unavailable";
  }
  return a;
}
export async function fetchJson(url, fetcher = fetch) {
  const r = await fetcher(url, { cache: "no-store" });
  if (!r.ok) throw Error("Saved data unavailable (HTTP " + r.status + ").");
  return r.json();
}
if (typeof document !== "undefined") start();
function start() {
  const $ = (id) => document.getElementById(id),
    node = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text != null) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    };
  let publication = null,
    accounts = [],
    page = 0,
    selected = null,
    selectionToken = 0,
    loadToken = 0,
    friendPage = 0,
    friendQuery = "",
    payload = null,
    downloadUrl = null;
  function clearDownload() {
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      downloadUrl = null;
    }
  }
  function renderRoster() {
    const rows = filterRoster(accounts, $("search").value, $("status").value);
    page = Math.min(page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
    $("roster-status").textContent =
      rows.length.toLocaleString() + " matching GMs";
    $("roster").replaceChildren();
    for (const a of rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
      const b = node("button", null, "player");
      b.type = "button";
      b.setAttribute("aria-pressed", String(selected?.username === a.username));
      b.append(
        node("strong", a.username),
        node(
          "span",
          countText(a.friendCount) + " friends  /  " + statusOf(a.friendList),
          "fine",
        ),
      );
      b.onclick = () => select(a);
      $("roster").append(b);
    }
    $("previous").disabled = page === 0;
    $("next").disabled = (page + 1) * PAGE_SIZE >= rows.length;
    $("page").textContent = rows.length
      ? `${page * PAGE_SIZE + 1}-${Math.min(rows.length, (page + 1) * PAGE_SIZE)} of ${rows.length}`
      : "No matching GMs";
  }
  function heading(a) {
    $("detail").replaceChildren();
    const h = node("h2", a.username);
    h.id = "detail-title";
    h.tabIndex = -1;
    $("detail").append(h);
    return h;
  }
  async function select(a) {
    const token = ++selectionToken;
    selected = a;
    payload = null;
    friendPage = 0;
    friendQuery = "";
    clearDownload();
    const h = heading(a);
    h.focus();
    $("detail").append(
      node(
        "p",
        countText(a.friendCount) +
          " public friends  /  " +
          sourceName(a.friendCount?.sourceType) +
          "  /  observed " +
          date(a.friendCount?.observedAt),
      ),
    );
    const links = node("p", null, "links");
    links.append(
      safeLink(a.profileUrl, "Profile"),
      safeLink(a.friendsUrl, "Public friends"),
    );
    $("detail").append(
      links,
      node(
        "p",
        "Loading saved friend rows... Known saved list status: " +
          statusOf(a.friendList) +
          ", " +
          (a.friendList?.enumeratedCount ?? "unknown") +
          " captured rows.",
      ),
    );
    renderRoster();
    try {
      const data = validateFriends(
        await fetchJson(
          publication.base +
            "friends/" +
            encodeURIComponent(a.username.toLowerCase()) +
            ".json",
        ),
        a,
        publication.generation,
      );
      if (token !== selectionToken) return;
      payload = data;
      renderDetail();
    } catch (e) {
      if (token !== selectionToken) return;
      heading(a);
      $("detail").append(
        node(
          "p",
          "Saved friend list unavailable. No empty or complete list can be inferred. " +
            e.message,
          "error",
        ),
      );
    }
  }
  function renderDetail() {
    const a = selected,
      l = payload.friendList;
    heading(a);
    $("detail").append(
      node(
        "p",
        countText(a.friendCount) +
          " public friends  /  " +
          sourceName(a.friendCount?.sourceType) +
          "  /  observed " +
          date(a.friendCount?.observedAt),
      ),
    );
    const status = statusOf(l);
    $("detail").append(
      node("p", listDescription(l, payload.savedTraversal)),
      node("p", "List observed " + date(l.observedAt), "fine"),
    );
    if (displayedScanCount(l))
      $("detail").append(node("p", displayedScanCount(l), "fine"));
    if (payload.savedTraversal)
      $("detail").append(
        node("p", traversalText(payload.savedTraversal), "fine"),
      );
    const links = node("p", null, "links");
    links.append(
      safeLink(a.profileUrl, "Profile"),
      safeLink(a.friendsUrl, "Public friends"),
    );
    if (l.sourceUrl) links.append(safeLink(l.sourceUrl, "List source"));
    clearDownload();
    downloadUrl = URL.createObjectURL(
      new Blob([JSON.stringify(publicListDownload(payload), null, 2) + "\n"], {
        type: "application/json",
      }),
    );
    const dl = node("a", "Download this saved public list");
    dl.href = downloadUrl;
    dl.download = a.username + "-friends.json";
    links.append(dl);
    $("detail").append(links);
    const label = node("label", "Search saved friends"),
      input = node("input");
    input.type = "search";
    input.value = friendQuery;
    input.id = "friend-search";
    input.autocomplete = "off";
    label.append(input);
    const result = node("div");
    result.id = "friend-results";
    result.setAttribute("aria-live", "polite");
    $("detail").append(label, result);
    input.oninput = () => {
      friendQuery = input.value;
      friendPage = 0;
      renderFriends();
    };
    renderFriends();
  }
  function renderFriends() {
    const l = payload.friendList,
      rows = l.friends.filter((x) =>
        x.username.toLowerCase().includes(friendQuery.trim().toLowerCase()),
      );
    friendPage = Math.min(
      friendPage,
      Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1),
    );
    const host = $("friend-results");
    host.replaceChildren(
      node("p", rows.length + " matching saved friends", "fine"),
    );
    if (!rows.length)
      host.append(
        node(
          "p",
          friendQuery
            ? "No saved friends match this search."
            : statusOf(l) === "complete"
              ? "The captured public friend list is empty."
              : statusOf(l) === "unknown"
                ? "No friend rows are saved; the list remains unknown."
                : "No friend rows were captured in this partial list.",
        ),
      );
    for (const f of rows.slice(
      friendPage * PAGE_SIZE,
      (friendPage + 1) * PAGE_SIZE,
    )) {
      const row = node("div", null, "friend");
      if (f.title) row.append(node("span", f.title, "badge"));
      row.append(
        safeLink(
          "https://www.chess.com/member/" + encodeURIComponent(f.username),
          f.username,
        ),
      );
      host.append(row);
    }
    const controls = node("div", null, "pagination"),
      prev = node("button", "Previous friends"),
      next = node("button", "Next friends");
    prev.type = next.type = "button";
    prev.disabled = friendPage === 0;
    next.disabled = (friendPage + 1) * PAGE_SIZE >= rows.length;
    prev.onclick = () => {
      friendPage--;
      renderFriends();
    };
    next.onclick = () => {
      friendPage++;
      renderFriends();
    };
    controls.append(
      prev,
      node(
        "span",
        rows.length
          ? `${friendPage * PAGE_SIZE + 1}-${Math.min(rows.length, (friendPage + 1) * PAGE_SIZE)} of ${rows.length}`
          : "0 matching rows",
      ),
      next,
    );
    host.append(controls);
  }
  async function load() {
    const token = ++loadToken;
    ++selectionToken;
    selected = null;
    payload = null;
    clearDownload();
    accounts = [];
    renderRoster();
    $("coverage").textContent = "Loading saved GM roster...";
    $("detail").replaceChildren(node("h2", "Choose a grandmaster"));
    try {
      const release = await fetchJson("./release.json"),
        generation = release.gmGeneration || release.publication?.gmGeneration;
      if (!GEN.test(generation || ""))
        throw Error("This release has no saved GM publication.");
      const base = "./data/gm/" + generation + "/",
        data = validateIndex(await fetchJson(base + "index.json"), generation);
      if (token !== loadToken) return;
      publication = { generation, base };
      accounts = data.accounts;
      const counts = { complete: 0, partial: 0, unknown: 0 };
      accounts.forEach((a) => counts[statusOf(a.friendList)]++);
      $("coverage").textContent =
        `${accounts.length.toLocaleString()} saved GM accounts  /  ${counts.complete} complete lists  /  ${counts.partial} partial  /  ${counts.unknown} unknown`;
      $("saved").textContent =
        "Saved " +
        date(data.generatedAt) +
        ". Lists were checked at different times.";
      const roster = data.roster || {};
      $("roster-source").replaceChildren(
        node(
          "span",
          "GM roster observed " +
            date(roster.observedAt) +
            "  /  source cache modified " +
            date(roster.lastModified) +
            ". ",
        ),
        safeLink(roster.sourceUrl, "Roster source"),
      );
      renderRoster();
    } catch (e) {
      if (token !== loadToken) return;
      $("coverage").textContent = "GM observations unavailable. " + e.message;
      $("saved").textContent =
        "No missing count or list has been treated as zero.";
    }
  }
  $("search").oninput = () => {
    page = 0;
    renderRoster();
  };
  $("status").onchange = () => {
    page = 0;
    renderRoster();
  };
  $("previous").onclick = () => {
    page--;
    renderRoster();
  };
  $("next").onclick = () => {
    page++;
    renderRoster();
  };
  $("refresh").onclick = load;
  load();
}
