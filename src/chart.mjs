import {
  ratingValue,
  normalizeCount,
  TITLE_COLORS,
  RATING_LABELS,
  fitRatingRange,
} from "./model.mjs";
const W = 1100,
  H = 500,
  P = { left: 76, right: 28, top: 28, bottom: 66 },
  NS = "http://www.w3.org/2000/svg";
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export function makeTransform(view, scale = "linear", width = W, height = H) {
  const y = (v) => (scale === "log" ? Math.log1p(Math.max(0, v)) : v),
    inv = (v) => (scale === "log" ? Math.expm1(v) : v);
  const a = y(view.minFriends),
    b = y(view.maxFriends),
    dx = view.maxRating - view.minRating || 1,
    dy = b - a || 1;
  return {
    point: (rating, friends) => ({
      x: P.left + ((rating - view.minRating) / dx) * (width - P.left - P.right),
      y:
        height -
        P.bottom -
        ((y(friends) - a) / dy) * (height - P.top - P.bottom),
    }),
    value: (x, yy) => ({
      rating: view.minRating + ((x - P.left) / (width - P.left - P.right)) * dx,
      friends: inv(
        a + ((height - P.bottom - yy) / (height - P.top - P.bottom)) * dy,
      ),
    }),
    y,
    inv,
  };
}
export function nearestPoint(points, x, y, radius = 14) {
  let best = null,
    d = radius * radius;
  for (const p of points) {
    const next = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (next <= d) {
      d = next;
      best = p;
    }
  }
  return best;
}
export function fitView(points) {
  const [minRating, maxRating] = fitRatingRange(points.map((p) => p.rating));
  const max = Math.max(1, ...points.map((p) => p.count));
  return { minRating, maxRating, minFriends: 0, maxFriends: max * 1.08 };
}
export function sanitizeView(view, fallback) {
  const v = { ...fallback, ...view };
  for (const k of Object.keys(fallback))
    if (!Number.isFinite(v[k])) v[k] = fallback[k];
  // Clamp the viewport domain while preserving its span when panning reaches the floor.
  if (v.minRating < 100) { v.maxRating += 100 - v.minRating; v.minRating = 100; }
  v.minFriends = Math.max(0, v.minFriends);
  v.maxFriends = Math.max(v.minFriends + 1, v.maxFriends);
  v.maxRating = Math.max(v.minRating + 1, v.maxRating);
  return v;
}
export function zoomView(view, anchor, factor, scale = "linear") {
  const t = makeTransform(view, scale),
    a = t.y(view.minFriends),
    b = t.y(view.maxFriends),
    cy = t.y(anchor.friends);
  let lo = cy + (a - cy) * factor,
    hi = cy + (b - cy) * factor;
  if (lo < 0) {
    hi -= lo;
    lo = 0;
  }
  return sanitizeView(
    {
      minRating: anchor.rating + (view.minRating - anchor.rating) * factor,
      maxRating: anchor.rating + (view.maxRating - anchor.rating) * factor,
      minFriends: t.inv(lo),
      maxFriends: t.inv(hi),
    },
    view,
  );
}
function precise(n, decimals = 0) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: decimals,
  }).format(n);
}
function format(n) {
  return Math.abs(n) >= 1000
    ? new Intl.NumberFormat("en", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(n)
    : new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(n);
}
export function mountChart({
  canvas,
  overlay,
  tooltip,
  onSelect = () => {},
  onViewChange = () => {},
}) {
  const ctx = canvas.getContext("2d");
  let players = [],
    options = { axis: "overall", scale: "linear" },
    eligible = [],
    points = [],
    view = null,
    fit = null,
    drag = null,
    dead = false,
    frame = 0;
  const listeners = [];
  function listen(target, name, fn, opts) {
    target.addEventListener(name, fn, opts);
    listeners.push(() => target.removeEventListener(name, fn, opts));
  }
  overlay.style.pointerEvents = "none";
  canvas.style.touchAction = "pan-y pinch-zoom";
  canvas.setAttribute(
    "aria-label",
    "Rating and saved friend counts scatter plot. Select a player from the table for keyboard access.",
  );
  function color(p) {
    return (
      options.colors?.[p.account.title] ||
      TITLE_COLORS[p.account.title] ||
      "#85c74e"
    );
  }
  function text(x, y, value, anchor = "middle", size = 12) {
    const node = document.createElementNS(NS, "text");
    for (const [k, v] of Object.entries({
      x,
      y,
      "text-anchor": anchor,
      "font-size": size,
      fill: "currentColor",
      "font-family": "Inter, system-ui, sans-serif",
    }))
      node.setAttribute(k, v);
    node.textContent = value;
    overlay.append(node);
  }
  function line(x1, y1, x2, y2) {
    const n = document.createElementNS(NS, "line");
    for (const [k, v] of Object.entries({
      x1,
      y1,
      x2,
      y2,
      stroke: "currentColor",
      "stroke-opacity": 0.13,
    }))
      n.setAttribute(k, v);
    overlay.append(n);
  }
  function draw() {
    if (dead) return;
    const rect = canvas.getBoundingClientRect(),
      dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    ctx.clearRect(0, 0, W, H);
    overlay.setAttribute("viewBox", `0 0 ${W} ${H}`);
    overlay.replaceChildren();
    fit = fitView(eligible);
    const v = sanitizeView(view, fit),
      t = makeTransform(v, options.scale);
    points = [];
    for (let i = 0; i <= 5; i++) {
      const x = P.left + (i / 5) * (W - P.left - P.right),
        y = H - P.bottom - (i / 5) * (H - P.top - P.bottom);
      line(x, P.top, x, H - P.bottom);
      line(P.left, y, W - P.right, y);
      text(
        x,
        H - P.bottom + 25,
        precise(
          v.minRating + (i / 5) * (v.maxRating - v.minRating),
          v.maxRating - v.minRating < 10
            ? Math.min(
                6,
                Math.max(
                  1,
                  Math.ceil(-Math.log10((v.maxRating - v.minRating) / 5)) + 1,
                ),
              )
            : 0,
        ),
      );
      text(
        P.left - 12,
        y + 4,
        format(
          t.inv(
            t.y(v.minFriends) +
              (i / 5) * (t.y(v.maxFriends) - t.y(v.minFriends)),
          ),
        ),
        "end",
      );
    }
    text(
      (P.left + W - P.right) / 2,
      H - 15,
      `${RATING_LABELS[options.axis] || options.axis} rating`,
      "middle",
      14,
    );
    text(
      P.left,
      P.top - 12,
      `Saved friends${options.scale === "log" ? " · logarithmic scale" : ""}`,
      "start",
      12,
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(P.left, P.top, W - P.left - P.right, H - P.top - P.bottom);
    ctx.clip();
    for (const p of eligible) {
      if (
        p.rating < v.minRating ||
        p.rating > v.maxRating ||
        p.count < v.minFriends ||
        p.count > v.maxFriends
      )
        continue;
      const xy = t.point(p.rating, p.count);
      points.push({ ...p, ...xy });
      ctx.fillStyle = color(p);
      ctx.globalAlpha = 0.74;
      ctx.beginPath();
      if (p.lower) {
        ctx.moveTo(xy.x, xy.y - 5);
        ctx.lineTo(xy.x + 4.5, xy.y + 3.5);
        ctx.lineTo(xy.x - 4.5, xy.y + 3.5);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = color(p);
        ctx.beginPath();
        ctx.moveTo(xy.x, xy.y - 7);
        ctx.lineTo(xy.x, xy.y - 12);
        ctx.moveTo(xy.x - 2.5, xy.y - 9.5);
        ctx.lineTo(xy.x, xy.y - 12);
        ctx.lineTo(xy.x + 2.5, xy.y - 9.5);
        ctx.stroke();
      } else {
        ctx.arc(xy.x, xy.y, 3.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H,
      rect: r,
    };
  }
  function hit(e) {
    const p = pos(e),
      sx = p.rect.width / W,
      sy = p.rect.height / H;
    return nearestPoint(
      points.map((q) => ({ ...q, x: q.x * sx, y: q.y * sy })),
      p.x * sx,
      p.y * sy,
      14,
    );
  }
  function hide() {
    tooltip.hidden = true;
    canvas.style.cursor = "grab";
  }
  function notify() {
    onViewChange(view ? { ...view } : null);
  }
  listen(canvas, "pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = pos(e);
    drag = {
      id: e.pointerId,
      x: p.x,
      y: p.y,
      startX: p.x,
      startY: p.y,
      view: sanitizeView(view, fit),
      moved: false,
      touch: e.pointerType === "touch",
    };
    if (!drag.touch) canvas.setPointerCapture?.(e.pointerId);
    hide();
  });
  listen(canvas, "pointermove", (e) => {
    if (drag && drag.id === e.pointerId) {
      const p = pos(e);
      if (Math.hypot(p.x - drag.startX, p.y - drag.startY) > 5)
        drag.moved = true; // Touch tracks tap slop only; native scrolling and pinch zoom remain available.
      if (drag.touch) return;
      if (drag.moved) {
        const t = makeTransform(drag.view, options.scale),
          start = t.value(drag.startX, drag.startY),
          now = t.value(p.x, p.y),
          dy = t.y(start.friends) - t.y(now.friends),
          lo = t.y(drag.view.minFriends) + dy,
          hi = t.y(drag.view.maxFriends) + dy;
        view = sanitizeView(
          {
            minRating: drag.view.minRating + start.rating - now.rating,
            maxRating: drag.view.maxRating + start.rating - now.rating,
            minFriends: t.inv(Math.max(0, lo)),
            maxFriends: t.inv(hi - Math.min(0, lo)),
          },
          fit,
        );
        draw();
      }
      return;
    }
    const p = hit(e);
    if (!p) {
      hide();
      return;
    }
    canvas.style.cursor = "pointer";
    tooltip.textContent = `${p.account.username} · ${p.account.title || "Untitled"} · ${precise(p.rating, Number.isInteger(p.rating) ? 0 : 2)} rating · ${precise(p.count)}${p.lower ? "+ (lower bound)" : ""} friends`;
    tooltip.hidden = false;
    const r = canvas.getBoundingClientRect();
    tooltip.style.left = `${clamp(e.clientX - r.left + 12, 8, Math.max(8, r.width - 240))}px`;
    tooltip.style.top = `${clamp(e.clientY - r.top - 50, 8, Math.max(8, r.height - 60))}px`;
  });
  listen(canvas, "pointerup", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const moved = drag.moved,
      touch = drag.touch;
    drag = null;
    if (!touch) canvas.releasePointerCapture?.(e.pointerId);
    if (moved) {
      if (!touch) notify();
    } else {
      const p = hit(e);
      if (p) onSelect(p.account);
    }
  });
  listen(canvas, "pointercancel", () => {
    drag = null;
    hide();
  });
  listen(canvas, "pointerleave", () => {
    if (!drag) hide();
  });
  listen(
    canvas,
    "wheel",
    (e) => {
      const p = pos(e);
      if (
        p.x < P.left ||
        p.x > W - P.right ||
        p.y < P.top ||
        p.y > H - P.bottom
      )
        return;
      e.preventDefault();
      const current = sanitizeView(view, fit),
        anchor = makeTransform(current, options.scale).value(p.x, p.y);
      view = zoomView(
        current,
        anchor,
        Math.exp(clamp(e.deltaY, -200, 200) * 0.002),
        options.scale,
      );
      hide();
      draw();
      notify();
    },
    { passive: false },
  );
  const resize =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(draw);
        })
      : null;
  resize?.observe(canvas);
  if (!resize) listen(window, "resize", draw);
  return {
    render(next, opts = {}) {
      players = next;
      options = { ...options, ...opts };
      eligible = players.flatMap((account) => {
        const rating = ratingValue(account, options.axis),
          count = normalizeCount(account.friendCount);
        return Number.isFinite(rating) &&
          Number.isFinite(count.value) &&
          count.precision !== "unknown"
          ? [
              {
                account,
                rating,
                count: count.value,
                lower: count.precision === "lower_bound",
              },
            ]
          : [];
      });
      if (Object.hasOwn(opts, "view")) view = opts.view;
      hide();
      draw();
    },
    resetView() {
      view = null;
      hide();
      draw();
      notify();
    },
    zoom(factor) {
      if (!Number.isFinite(factor) || factor <= 0) return;
      const current = sanitizeView(view, fit),
        anchor = makeTransform(current, options.scale).value(
          (P.left + W - P.right) / 2,
          (P.top + H - P.bottom) / 2,
        );
      view = zoomView(current, anchor, clamp(factor, 0.1, 10), options.scale);
      hide();
      draw();
      notify();
    },
    async exportPng() {
      const out = document.createElement("canvas");
      out.width = 2200;
      out.height = 1000;
      const c = out.getContext("2d");
      const theme =
        getComputedStyle(canvas)
          .getPropertyValue("--chart-background")
          .trim() || getComputedStyle(document.body).backgroundColor;
      c.fillStyle = theme;
      c.fillRect(0, 0, out.width, out.height);
      c.drawImage(canvas, 0, 0, out.width, out.height);
      const svg = overlay.cloneNode(true);
      svg.setAttribute("xmlns", NS);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      svg.style.color = getComputedStyle(overlay).color;
      const url = URL.createObjectURL(
        new Blob([new XMLSerializer().serializeToString(svg)], {
          type: "image/svg+xml",
        }),
      );
      try {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = url;
        });
        c.drawImage(img, 0, 0, out.width, out.height);
        return await new Promise((resolve) => out.toBlob(resolve, "image/png"));
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    destroy() {
      dead = true;
      resize?.disconnect();
      cancelAnimationFrame(frame);
      listeners.forEach((fn) => fn());
      hide();
    },
  };
}
