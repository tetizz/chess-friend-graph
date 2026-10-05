import {
  TITLE_ORDER,
  TITLE_COLORS,
  RATING_LABELS,
  normalizeCount,
  countText,
  ratingValue,
  filterPlayers,
  sortPlayers,
  summarize,
  makeCsv,
} from "./model.mjs";
import { mountChart } from "./chart.mjs";

const $ = (id) => document.getElementById(id);
const defaults = () => ({
  search: "",
  titles: [],
  precision: "all",
  minRating: null,
  maxRating: null,
  minFriends: null,
  maxFriends: null,
  axis: "overall",
  scale: "log",
  sort: "friends-desc",
});
let state = defaults(),
  accounts = [],
  dataset = null,
  page = 0,
  chart = null,
  chartView = null,
  selected = null,
  detailOpener = null,
  filtered = [],
  comparing = new Set();
const PAGE_SIZE = 50;
const number = (value) =>
  value == null
    ? "Unknown"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
        value,
      );
const date = (value) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "Date unavailable";
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
};
const text = (id, value) => {
  if ($(id)) $(id).textContent = String(value);
};
const node = (tag, value, className) => {
  const el = document.createElement(tag);
  if (value != null) el.textContent = String(value);
  if (className) el.className = className;
  return el;
};
const rating = (a, axis) => number(ratingValue(a, axis));
let toastTimer;
const announce = (message) => {
  const el = $("toast");
  if (!el) return;
  clearTimeout(toastTimer);
  el.hidden = false;
  el.textContent = message;
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4000);
};
const badge = (title) => {
  const el = node("span", title || "Untitled", "title-badge");
  el.style.setProperty("--title-color", TITLE_COLORS[title] || "#9da69b");
  return el;
};
function action(label, kind, username) {
  const b = node(
    "button",
    label,
    kind === "compare" ? "compare-button" : "player-button",
  );
  b.type = "button";
  b.dataset.action = kind;
  b.dataset.username = username;
  return b;
}
function find(username) {
  return accounts.find(
    (a) => a.username.toLowerCase() === String(username).toLowerCase(),
  );
}
function fromUrl() {
  const q = new URLSearchParams(location.search),
    s = defaults();
  s.search = q.get("search") || "";
  s.titles = (q.get("titles") || "")
    .split(",")
    .filter((t) => TITLE_ORDER.includes(t));
  for (const [key, allowed] of Object.entries({
    axis: ["overall", "bullet", "blitz", "rapid"],
    scale: ["linear", "log"],
    precision: ["all", "exact", "lower_bound", "unknown"],
    sort: [
      "friends-desc",
      "friends-asc",
      "rating-desc",
      "rating-asc",
      "username",
    ],
  }))
    if (allowed.includes(q.get(key))) s[key] = q.get(key);
  for (const key of ["minRating", "maxRating", "minFriends", "maxFriends"]) {
    const raw = q.get(key);
    if (
      raw !== null &&
      raw.trim() !== "" &&
      Number.isFinite(Number(raw)) &&
      Number(raw) >= 0
    )
      s[key] = Number(raw);
  }
  state = s;
  return q.get("player");
}
function viewUrl() {
  const url = new URL(location.href);
  url.search = "";
  const d = defaults();
  for (const [key, value] of Object.entries(state))
    if (
      Array.isArray(value) ? value.length : value !== null && value !== d[key]
    )
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : value);
  if (selected) url.searchParams.set("player", selected.username);
  return url;
}
function syncUrl() {
  try {
    history.replaceState(null, "", viewUrl());
  } catch {}
}
function syncInputs() {
  for (const key of ["search", "axis", "scale", "precision", "sort"])
    if ($(key)) $(key).value = state[key];
  for (const key of ["minRating", "maxRating", "minFriends", "maxFriends"]) {
    const id = key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
    if ($(id)) $(id).value = state[key] ?? "";
  }
  for (const b of $("title-filters")?.querySelectorAll("button") || []) {
    const active = state.titles.includes(b.dataset.title);
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  }
}
function drawTable() {
  const pages = Math.ceil(filtered.length / PAGE_SIZE);
  page = Math.max(0, Math.min(page, Math.max(0, pages - 1)));
  const fragment = document.createDocumentFragment();
  for (const a of filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    const tr = node("tr");
    const player = node("td");
    player.append(action(a.username, "detail", a.username));
    if (a.name) player.append(node("small", a.name));
    tr.append(player);
    const title = node("td");
    title.append(badge(a.title));
    tr.append(title, node("td", countText(a.friendCount)));
    for (const axis of ["bullet", "blitz", "rapid", "overall"])
      tr.append(node("td", rating(a, axis)));
    const compare = node("td");
    const b = action(
      comparing.has(a.username) ? "Remove" : "Compare",
      "compare",
      a.username,
    );
    b.setAttribute("aria-pressed", String(comparing.has(a.username)));
    b.setAttribute(
      "aria-label",
      `${comparing.has(a.username) ? "Remove" : "Compare"} ${a.username}`,
    );
    compare.append(b);
    tr.append(compare);
    fragment.append(tr);
  }
  if (!filtered.length) {
    const tr = node("tr"),
      td = node(
        "td",
        "No players match these filters. Try clearing a range or resetting filters.",
        "empty-state",
      );
    td.colSpan = 8;
    tr.append(td);
    fragment.append(tr);
  }
  $("player-rows")?.replaceChildren(fragment);
  text("result-count", `${number(filtered.length)} players`);
  text("page-status", pages ? `Page ${page + 1} of ${pages}` : "No results");
  if ($("previous")) $("previous").disabled = page === 0;
  if ($("next")) $("next").disabled = page >= pages - 1;
}
function render() {
  if (!dataset) return;
  filtered = sortPlayers(
    filterPlayers(accounts, state),
    state.sort,
    state.axis,
  );
  const summary = summarize(filtered, state.axis);
  text("metric-matching", number(summary.total));
  text("metric-plotted", number(summary.plotted));
  text("metric-rating", number(summary.medianRating));
  text("metric-friends", number(summary.medianFriends));
  chart?.render(filtered, {
    axis: state.axis,
    scale: state.scale,
    colors: TITLE_COLORS,
    view: chartView,
  });
  if ($("chart-empty")) {
    $("chart-empty").hidden = summary.plotted > 0;
    $("chart-empty").textContent = filtered.length
      ? "No players have both a known rating for this basis and an observed friend count. Unknown values remain in the table."
      : "No players match these filters.";
  }
  text(
    "plot-note",
    `${RATING_LABELS[state.axis] || state.axis} · ${state.scale === "log" ? "Logarithmic" : "Linear"} friend scale. Triangles show lower bounds; unknowns stay in the table. Saved observations, not live counts.`,
  );
  drawTable();
  syncInputs();
  syncUrl();
  announce(
    `${number(summary.total)} matching players; ${number(summary.plotted)} plotted`,
  );
}
function closeDetail({ restoreFocus = true } = {}) {
  selected = null;
  const panel = $("player-detail");
  if (panel) {
    panel.classList.remove("is-open");
    panel.hidden = true;
  }
  if (restoreFocus) {
    const opener = detailOpener?.isConnected ? detailOpener : $("search");
    opener?.focus();
  }
  detailOpener = null;
  syncUrl();
}
function openDetail(a, { focus = false, opener = null } = {}) {
  if (!a || !$("player-detail")) return;
  selected = a;
  if (focus) detailOpener = opener?.isConnected ? opener : $("search");
  const panel = $("player-detail"),
    close = node("button", "Close details");
  close.id = "close-detail";
  close.type = "button";
  close.addEventListener("click", closeDetail);
  const heading = node("h2", a.username);
  heading.tabIndex = -1;
  panel.replaceChildren(close, heading, badge(a.title));
  if (a.name) panel.append(node("p", a.name));
  panel.append(node("p", `Friends: ${countText(a.friendCount)}`));
  const count = normalizeCount(a.friendCount);
  panel.append(
    node(
      "p",
      count.precision === "lower_bound"
        ? "This is a lower bound, not an exact total."
        : count.precision === "unknown"
          ? "No verified count observation is available."
          : "Exact saved count observation.",
    ),
  );
  panel.append(node("p", `Count observed: ${date(a.friendCount?.observedAt)}`));
  for (const axis of ["bullet", "blitz", "rapid", "overall"]) {
    const row = node("p", `${RATING_LABELS[axis] || axis}: ${rating(a, axis)}`);
    if (axis !== "overall")
      row.append(
        node(
          "small",
          `Observed ${date(a.ratings?.[axis]?.observedAt)} · Last rated game ${date(a.ratings?.[axis]?.lastRatedGameAt)}`,
        ),
      );
    panel.append(row);
  }
  panel.append(
    node(
      "p",
      "Overall is the arithmetic mean of bullet, blitz and rapid only when all three ratings are known.",
    ),
  );
  if (a.listCount)
    panel.append(
      node(
        "p",
        `Saved list traversal: ${number(a.listCount.value)} friends · ${date(a.listCount.startedAt)} to ${date(a.listCount.observedAt)}. This is a traversal, not a simultaneous snapshot.`,
      ),
    );
  const link = node("a", "Chess.com profile");
  link.href = `https://www.chess.com/member/${encodeURIComponent(a.username)}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  panel.append(
    link,
    action(
      comparing.has(a.username) ? "Remove comparison" : "Add to comparison",
      "compare",
      a.username,
    ),
  );
  panel.hidden = false;
  panel.classList.add("is-open");
  if (focus) heading.focus({ preventScroll: true });
  syncUrl();
  announce(`Details for ${a.username}`);
}
function renderCompare() {
  if (!$("compare-cards")) return;
  $("compare-cards").replaceChildren();
  for (const username of comparing) {
    const a = find(username);
    if (!a) continue;
    const card = node("article", null, "compare-card");
    card.append(
      node("h3", a.username),
      badge(a.title),
      node("p", `Friends: ${countText(a.friendCount)}`),
    );
    for (const axis of ["bullet", "blitz", "rapid", "overall"])
      card.append(
        node("p", `${RATING_LABELS[axis] || axis}: ${rating(a, axis)}`),
      );
    card.append(action("Remove", "compare", a.username));
    $("compare-cards").append(card);
  }
  if ($("compare-panel")) $("compare-panel").hidden = comparing.size === 0;
}
function toggleCompare(a) {
  if (!a) return;
  if (comparing.has(a.username)) comparing.delete(a.username);
  else {
    if (comparing.size >= 3) {
      announce("Compare up to three players. Remove one first.");
      return;
    }
    comparing.add(a.username);
  }
  renderCompare();
  drawTable();
  if (selected) openDetail(selected);
  announce(`${comparing.size} players selected for comparison`);
}
function download(value, name, type) {
  const url =
    typeof value === "string"
      ? value
      : URL.createObjectURL(
          value instanceof Blob ? value : new Blob([value], { type }),
        );
  const link = node("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  if (url.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function theme(value) {
  document.documentElement.dataset.theme = value;
  if ($("theme-toggle")) {
    $("theme-toggle").setAttribute("aria-pressed", String(value === "light"));
    $("theme-toggle").setAttribute(
      "aria-label",
      `Switch to ${value === "light" ? "dark" : "light"} theme`,
    );
  }
}
function bind() {
  try {
    theme(
      localStorage.getItem("chess-friend-graph-theme") === "light"
        ? "light"
        : "dark",
    );
  } catch {
    theme("dark");
  }
  $("theme-toggle")?.addEventListener("click", () => {
    const next =
      document.documentElement.dataset.theme === "light" ? "dark" : "light";
    theme(next);
    try {
      localStorage.setItem("chess-friend-graph-theme", next);
    } catch {}
    if (dataset) render();
  });
  for (const key of ["search", "axis", "scale", "precision", "sort"])
    $(key)?.addEventListener(key === "search" ? "input" : "change", () => {
      state[key] = $(key).value;
      page = 0;
      chartView = null;
      render();
    });
  for (const key of ["minRating", "maxRating", "minFriends", "maxFriends"]) {
    const id = key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
    $(id)?.addEventListener("input", () => {
      const raw = $(id).value;
      state[key] =
        raw.trim() !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0
          ? Number(raw)
          : null;
      page = 0;
      chartView = null;
      render();
    });
  }
  $("reset-filters")?.addEventListener("click", () => {
    state = defaults();
    page = 0;
    chartView = null;
    chart?.resetView();
    render();
    announce("Filters reset");
  });
  $("reset-view")?.addEventListener("click", () => {
    chart?.resetView();
    announce("Chart view reset");
  });
  $("zoom-in")?.addEventListener("click", () => chart?.zoom(0.75));
  $("zoom-out")?.addEventListener("click", () => chart?.zoom(1.33));
  $("close-detail")?.addEventListener("click", () => closeDetail());
  $("previous")?.addEventListener("click", () => {
    page--;
    drawTable();
  });
  $("next")?.addEventListener("click", () => {
    page++;
    drawTable();
  });
  $("clear-compare")?.addEventListener("click", () => {
    comparing.clear();
    renderCompare();
    drawTable();
    announce("Comparison cleared");
  });
  document.addEventListener("click", (event) => {
    const b = event.target.closest?.("[data-action][data-username]");
    if (!b) return;
    const a = find(b.dataset.username);
    if (b.dataset.action === "detail")
      openDetail(a, { focus: true, opener: b });
    if (b.dataset.action === "compare") toggleCompare(a);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selected) closeDetail();
    if (
      event.key === "/" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.target.closest?.('input,textarea,select,[contenteditable="true"]')
    ) {
      event.preventDefault();
      $("search")?.focus();
    }
  });
  $("share-view")?.addEventListener("click", async () => {
    const url = viewUrl().href;
    syncUrl();
    try {
      await navigator.clipboard.writeText(url);
      announce("View link copied");
    } catch {
      announce("This view is saved in the address bar. Copy its URL to share.");
    }
  });
  $("export-csv")?.addEventListener("click", () => {
    if (!dataset) {
      announce("Data is not loaded yet.");
      return;
    }
    download(
      new Blob([makeCsv(filtered)], { type: "text/csv;charset=utf-8" }),
      "chess-friend-graph.csv",
    );
    announce("Filtered CSV downloaded");
  });
  $("export-png")?.addEventListener("click", async () => {
    try {
      if (!dataset || !chart) throw Error();
      const value = await chart.exportPng();
      if (!value) throw Error();
      download(value, "chess-friend-graph.png", "image/png");
      announce("Chart PNG downloaded");
    } catch {
      announce("Could not export the chart. Try again after data loads.");
    }
  });
  window.addEventListener("popstate", () => {
    const username = fromUrl();
    page = 0;
    render();
    if (username) openDetail(find(username));
    else closeDetail({ restoreFocus: false });
  });
}
async function load() {
  text("coverage-status", "Loading saved observations…");
  $("explore")?.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("./data/dataset.json");
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.schemaVersion !== 1 || !Array.isArray(data.accounts))
      throw Error("Unsupported dataset");
    dataset = data;
    accounts = data.accounts;
    text("roster-total", number(accounts.length));
    text(
      "count-total",
      number(
        (data.coverage?.counts?.exact || 0) +
          (data.coverage?.counts?.lower_bound || 0),
      ),
    );
    text(
      "rating-total",
      number(
        data.coverage?.ratings?.overall ??
          accounts.filter((a) => ratingValue(a, "overall") != null).length,
      ),
    );
    text("data-date", date(data.generatedAt));
    const directory = data.coverage?.directory || {},
      known =
        (data.coverage?.counts?.exact || 0) +
        (data.coverage?.counts?.lower_bound || 0);
    text("coverage-status", "Saved coverage · collection remains partial");
    text(
      "coverage-text",
      `${number(known)} observed friend counts · ${number(data.coverage?.counts?.unknown || 0)} unknown · directory ${number(directory.pagesCaptured)} of ${number(directory.pagesExpected)} pages. Dated roster union, not a live census.`,
    );
    if ($("coverage-bar")) {
      const percent = accounts.length
        ? Math.min(100, (known / accounts.length) * 100)
        : 0;
      $("coverage-bar").style.width = `${percent}%`;
      $("coverage-bar").setAttribute(
        "aria-label",
        `${Math.round(percent)} percent with observed counts`,
      );
    }
    for (const title of TITLE_ORDER) {
      const b = node("button", title, "title-chip");
      b.type = "button";
      b.dataset.title = title;
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => {
        state.titles = state.titles.includes(title)
          ? state.titles.filter((t) => t !== title)
          : [...state.titles, title];
        page = 0;
        chartView = null;
        render();
      });
      $("title-filters")?.append(b);
    }
    if ($("chart-canvas") && $("chart-overlay"))
      chart = mountChart({
        canvas: $("chart-canvas"),
        overlay: $("chart-overlay"),
        tooltip: $("chart-tooltip"),
        onSelect: (a) =>
          openDetail(a, {
            focus: true,
            opener:
              $("chart-canvas").tabIndex >= 0 ? $("chart-canvas") : $("search"),
          }),
        onViewChange: (bounds) => {
          chartView = bounds ? { ...bounds } : null;
        },
      });
    const username = fromUrl();
    render();
    if (username) openDetail(find(username));
    announce(
      `${number(accounts.length)} players loaded from saved observations`,
    );
  } catch (error) {
    text("coverage-status", "Saved data could not be loaded");
    text(
      "coverage-text",
      "Reload to try again. No live counts are substituted.",
    );
    text("result-count", "Data unavailable");
    const tr = node("tr"),
      td = node(
        "td",
        "Saved data could not be loaded. Reload to try again.",
        "empty-state",
      );
    td.colSpan = 8;
    tr.append(td);
    $("player-rows")?.replaceChildren(tr);
    for (const id of ["previous", "next", "export-csv", "export-png"])
      if ($(id)) $(id).disabled = true;
    if ($("chart-empty")) {
      $("chart-empty").hidden = false;
      $("chart-empty").textContent =
        "Could not load saved data. Reload to try again.";
    }
    announce("Data could not be loaded. Reload to retry.");
    console.error("Dataset load failed", error);
  } finally {
    $("explore")?.setAttribute("aria-busy", "false");
    document.body.classList.remove("is-loading");
  }
}
bind();
load();
