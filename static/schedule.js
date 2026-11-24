"use strict";

const $ = (id) => document.getElementById(id);
const HOUR_PX = 44;
const AXIS_START = 7 * 60;      // 07:00
const AXIS_END = 25 * 60;       // 次日 01:00
const PX_PER_MIN = HOUR_PX / 60;
const HOURS = 18;

const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());
const nowClock = () => new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date());

const state = {
  weekStart: null,
  data: null,
  disabled: new Set(),
  selectedDate: today,
  kind: "block",
  category: "research",
  nowTimer: null,
};

/* ---------- 工具 ---------- */

function pad(value) { return String(value).padStart(2, "0"); }

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function weekStartOf(iso) {
  const index = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
  return shiftDate(iso, -index);
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseClock(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function clockText(minutes) {
  const value = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

function addClock(value, delta) {
  const base = parseClock(value);
  return clockText((base === null ? 0 : base) + delta);
}

function axisRange(item) {
  let start = parseClock(item.start);
  let end = item.kind === "reminder" ? start + 20 : parseClock(item.end);
  if (start === null) return null;
  if (start < 60) {
    start += 1440;
    if (end !== null) end += 1440;
  } else if (start < AXIS_START) {
    return null;
  }
  if (end === null) end = start + 20;
  if (end <= start) end += 1440;
  return { start, end };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

let toastTimer = null;
function toast(message) {
  const box = $("toast");
  box.querySelector("span").textContent = message;
  box.hidden = false;
  void box.offsetWidth;
  box.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.classList.remove("show");
    toastTimer = setTimeout(() => { box.hidden = true; }, 300);
  }, 2600);
}

/* ---------- 读取 ---------- */

async function loadWeek(start) {
  try {
    const query = start ? `?start=${start}` : "";
    const data = await api(`/api/schedule/week${query}`);
    state.data = data;
    state.weekStart = data.week_start;
    if (!data.days.some((day) => day.date === state.selectedDate)) {
      state.selectedDate = data.days.some((day) => day.today) ? today : data.week_start;
    }
    renderAll();
    const isPast = data.week_start < data.current_week_start;
    $("addBtn").disabled = isPast;
    $("clearWeek").disabled = isPast;
    const empty = $("schedEmpty");
    empty.textContent = isPast
      ? "过去周的任务已自动清除，不能再查看或新建。"
      : "这一周还没有任务，点右上角「＋ 新建」。";
    empty.hidden = data.items.length > 0 && !isPast;
    if (data.pruned > 0) toast(`已自动清除上一周 ${data.pruned} 项任务`);
  } catch (error) {
    toast(`读取失败：${error.message}`);
  }
}

function renderAll() {
  renderSidebar();
  renderHead();
  renderGrid();
  renderNowLine();
}

function renderSidebar() {
  const data = state.data;
  const list = $("catList");
  list.replaceChildren();
  for (const category of data.categories) {
    const count = data.counts[category.id] || 0;
    const item = document.createElement("li");
    const button = node("button", "cat-item" + (state.disabled.has(category.id) ? " is-off" : ""));
    button.type = "button";
    button.style.setProperty("--cat", category.color);
    button.append(node("i", "cat-dot"));
    button.append(node("span", "cat-name", category.name));
    button.append(node("span", "cat-count", count ? String(count) : ""));
    button.addEventListener("click", () => {
      if (state.disabled.has(category.id)) state.disabled.delete(category.id);
      else state.disabled.add(category.id);
      renderSidebar();
      renderGrid();
    });
    item.append(button);
    list.append(item);
  }
  const done = data.done || 0;
  $("sideStats").textContent = `本周 ${data.items.length} 项 · 完成 ${done}`;
}

function renderHead() {
  const data = state.data;
  const days = data.days;
  const first = days[0];
  const last = days[6];
  const monthOf = (date) => Number(date.slice(5, 7));
  const year = days[3].date.slice(0, 4);
  const title = monthOf(first.date) === monthOf(last.date)
    ? `${year} 年 ${monthOf(first.date)} 月`
    : `${year} 年 ${monthOf(first.date)} 月 – ${monthOf(last.date)} 月`;
  $("monthTitle").textContent = title;
  $("weekLabel").textContent = `${monthOf(first.date)}月${Number(first.date.slice(8))}日 – ${monthOf(last.date)}月${Number(last.date.slice(8))}日`;

  const head = $("headDays");
  head.replaceChildren();
  for (const day of days) {
    const cell = node("div", "head-day");
    if (day.today) cell.classList.add("is-today");
    if (day.date === state.selectedDate) cell.classList.add("is-selected");
    if (day.date < today) cell.classList.add("is-past");
    cell.append(node("strong", "", String(day.day)));
    cell.append(node("span", "", day.weekday));
    cell.addEventListener("click", () => {
      state.selectedDate = day.date;
      renderHead();
    });
    head.append(cell);
  }
}

function renderGrid() {
  const data = state.data;
  const gutter = $("timeGutter");
  gutter.replaceChildren();
  for (let index = 0; index < HOURS; index += 1) {
    const hour = (7 + index) % 24;
    const label = node("div", "time-label");
    if (hour === 0) label.append(node("em", "", "次日"));
    label.append(node("span", "", `${pad(hour)}:00`));
    gutter.append(label);
  }

  const grid = $("weekGrid");
  grid.replaceChildren();
  for (const day of data.days) {
    const col = node("div", "day-col");
    col.dataset.date = day.date;
    if (day.today) col.classList.add("is-today");
    if (day.date < today) col.classList.add("is-past");

    const items = data.items
      .filter((item) => item.date === day.date && !state.disabled.has(item.category))
      .map((item) => ({ item, range: axisRange(item) }))
      .filter((entry) => entry.range && entry.range.start < AXIS_END && entry.range.end > AXIS_START);

    layoutLanes(items);
    for (const entry of items) {
      col.append(eventBlock(entry));
    }
    grid.append(col);
  }
}

function layoutLanes(items) {
  const sorted = items.slice().sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const laneEnds = [];
    for (const entry of cluster) {
      let lane = laneEnds.findIndex((end) => end <= entry.range.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(entry.range.end);
      } else {
        laneEnds[lane] = entry.range.end;
      }
      entry.lane = lane;
    }
    for (const entry of cluster) entry.lanes = laneEnds.length || 1;
    cluster = [];
  };
  for (const entry of sorted) {
    if (cluster.length && entry.range.start >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    cluster.push(entry);
    clusterEnd = Math.max(clusterEnd, entry.range.end);
  }
  flush();
  return sorted;
}

function eventBlock(entry) {
  const { item, range, lane, lanes } = entry;
  const top = (range.start - AXIS_START) * PX_PER_MIN;
  const clippedEnd = Math.min(range.end, AXIS_END);
  const height = Math.max(24, (clippedEnd - range.start) * PX_PER_MIN - 2);
  const block = document.createElement("article");
  block.className = "event" + (item.kind === "reminder" ? " is-reminder" : "") + (item.done ? " is-done" : "") + (lanes > 1 ? " is-narrow" : "");
  block.style.setProperty("--cat", item.color);
  block.style.top = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left = `calc(${(lane * 100) / lanes}% + 2px)`;
  block.style.width = `calc(${100 / lanes}% - 5px)`;
  block.title = `${item.title} ${item.kind === "reminder" ? item.start : `${item.start}–${item.end}`}`;

  const check = node("button", "ev-check");
  check.type = "button";
  check.setAttribute("aria-label", item.done ? "标记未完成" : "标记完成");
  check.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.4 5.8 10 11 4.6"/></svg>';
  check.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleDone(item);
  });

  const text = node("div", "ev-text");
  if (item.kind === "reminder") {
    const bell = node("span", "ev-bell");
    bell.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.3a3.4 3.4 0 0 0-3.4 3.4v2.1L3.3 10h9.4L11.4 7.8V5.7A3.4 3.4 0 0 0 8 2.3Z"/><path d="M6.6 11.4a1.5 1.5 0 0 0 2.8 0"/></svg>';
    text.append(bell);
  }
  text.append(node("span", "ev-title", item.title));
  text.append(node("span", "ev-time", item.kind === "reminder" ? item.start : `${item.start}–${item.end}`));

  const del = node("button", "ev-del", "×");
  del.type = "button";
  del.setAttribute("aria-label", `删除 ${item.title}`);
  del.addEventListener("click", (event) => {
    event.stopPropagation();
    removeItem(item);
  });

  block.append(check, text, del);
  return block;
}

function renderNowLine() {
  const data = state.data;
  const col = $("weekGrid").querySelector(".day-col.is-today");
  if (!col) return;
  const now = parseClock(nowClock());
  if (now === null) return;
  const axis = now < 60 ? now + 1440 : now;
  if (axis < AXIS_START || axis > AXIS_END) return;
  const line = node("div", "now-line");
  line.style.top = `${(axis - AXIS_START) * PX_PER_MIN}px`;
  col.append(line);
}

/* ---------- 交互 ---------- */

async function toggleDone(item) {
  try {
    const updated = await api(`/api/schedule/items/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ done: !item.done }),
    });
    const target = state.data.items.find((entry) => entry.id === item.id);
    Object.assign(target, updated);
    state.data.done = state.data.items.filter((entry) => entry.done).length;
    renderAll();
    $("schedEmpty").hidden = state.data.items.length > 0;
  } catch (error) {
    toast(`更新失败：${error.message}`);
  }
}

async function removeItem(item) {
  if (!window.confirm(`删除「${item.title}」？`)) return;
  try {
    await api(`/api/schedule/items/${item.id}`, { method: "DELETE" });
    state.data.items = state.data.items.filter((entry) => entry.id !== item.id);
    state.data.counts[item.category] = Math.max(0, (state.data.counts[item.category] || 0) - 1);
    state.data.done = state.data.items.filter((entry) => entry.done).length;
    renderAll();
    $("schedEmpty").hidden = state.data.items.length > 0;
    toast("已删除");
  } catch (error) {
    toast(`删除失败：${error.message}`);
  }
}

/* ---------- 新建 ---------- */

function defaultStart(date) {
  if (date !== today) return "07:00";
  const now = parseClock(nowClock());
  if (now === null) return "07:00";
  if (now < 7 * 60) return "07:00";
  if (now >= 23 * 60 + 30) return "23:30";
  const rounded = Math.ceil(now / 30) * 30;
  return clockText(Math.min(rounded, 23 * 60 + 30));
}

function openSheet() {
  if (state.data.week_start < state.data.current_week_start) {
    toast("过去周会自动清除，不能新建");
    return;
  }
  const date = state.selectedDate || today;
  const start = defaultStart(date);
  $("itemTitle").value = "";
  $("itemDate").value = date;
  $("itemDate").min = state.data.current_week_start;
  $("itemStart").value = start;
  $("itemEnd").value = addClock(start, 60);
  setKind("block");
  setCategory(state.category);
  $("sheetBackdrop").hidden = false;
  $("sheet").hidden = false;
  $("itemTitle").focus();
}

function closeSheet() {
  $("sheetBackdrop").hidden = true;
  $("sheet").hidden = true;
}

function setKind(kind) {
  state.kind = kind;
  document.querySelectorAll("#kindSeg button").forEach((button) => {
    button.classList.toggle("active", button.dataset.kind === kind);
  });
  $("endField").hidden = kind === "reminder";
}

function setCategory(categoryId) {
  state.category = categoryId;
  document.querySelectorAll("#catPick button").forEach((button) => {
    button.classList.toggle("active", button.dataset.category === categoryId);
  });
}

function renderCatPick() {
  const wrap = $("catPick");
  wrap.replaceChildren();
  for (const category of state.data.categories) {
    const button = node("button", "", "");
    button.type = "button";
    button.dataset.category = category.id;
    button.style.setProperty("--cat", category.color);
    button.append(node("i"));
    button.append(node("span", "", category.name));
    button.addEventListener("click", () => setCategory(category.id));
    wrap.append(button);
  }
}

async function saveItem() {
  const title = $("itemTitle").value.trim();
  if (!title) {
    toast("先写事项名");
    return;
  }
  const body = {
    title,
    kind: state.kind,
    date: $("itemDate").value,
    start: $("itemStart").value,
    end: state.kind === "reminder" ? "" : $("itemEnd").value,
    category: state.category,
  };
  $("sheetSave").disabled = true;
  try {
    await api("/api/schedule/items", { method: "POST", body: JSON.stringify(body) });
    closeSheet();
    state.selectedDate = body.date;
    await loadWeek(weekStartOf(body.date));
    toast("已添加");
  } catch (error) {
    toast(`没保存：${error.message}`);
  } finally {
    $("sheetSave").disabled = false;
  }
}

/* ---------- 事件 ---------- */

$("prevWeek").addEventListener("click", () => loadWeek(shiftDate(state.weekStart, -7)));
$("nextWeek").addEventListener("click", () => loadWeek(shiftDate(state.weekStart, 7)));
$("todayBtn").addEventListener("click", () => loadWeek(null));
$("addBtn").addEventListener("click", openSheet);
$("sheetClose").addEventListener("click", closeSheet);
$("sheetCancel").addEventListener("click", closeSheet);
$("sheetBackdrop").addEventListener("click", closeSheet);
$("sheetSave").addEventListener("click", saveItem);

document.querySelectorAll("#kindSeg button").forEach((button) => {
  button.addEventListener("click", () => {
    setKind(button.dataset.kind);
    if (state.kind === "block") {
      $("itemEnd").value = addClock($("itemStart").value || "07:00", 60);
    }
  });
});

$("itemStart").addEventListener("change", () => {
  if (state.kind === "block") $("itemEnd").value = addClock($("itemStart").value || "07:00", 60);
});

$("clearWeek").addEventListener("click", async () => {
  if (!window.confirm("清除本周从周一到现在的任务？之后的保留。")) return;
  try {
    const result = await api("/api/schedule/clear", { method: "POST", body: "{}" });
    await loadWeek(state.weekStart);
    toast(`已清除 ${result.deleted} 项`);
  } catch (error) {
    toast(`清除失败：${error.message}`);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("sheet").hidden) closeSheet();
});

/* ---------- 启动 ---------- */

loadWeek(null).then(() => {
  renderCatPick();
  const scroll = $("gridScroll");
  scroll.scrollTop = 0;
});
state.nowTimer = setInterval(() => {
  if (state.data) renderNowLine();
}, 60000);

// 跨天 / 跨周时自动重载：跨周会触发上一周清理
setInterval(() => {
  const current = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  if (state.data && current !== state.data.today) loadWeek(state.weekStart);
}, 5 * 60 * 1000);
