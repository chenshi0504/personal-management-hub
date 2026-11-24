"use strict";

const $ = (id) => document.getElementById(id);
const WEEK_CN = ["一", "二", "三", "四", "五", "六", "日"];
const CATEGORY_ORDER = ["aerobic", "strength", "combat", "rest"];
const WEEK_TARGET = { aerobic: 2, strength: 2, combat: 2 };

const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());

const state = {
  month: today.slice(0, 7),
  days: new Map(),
  categories: {},
  selected: null,
  mode: null,          // "plan" | "record"
  view: false,         // 记录只读查看
  planForm: null,
  recordForm: null,
  dirty: false,
  saving: false,
};

/* ---------- 小工具 ---------- */

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
}

function pad(value) { return String(value).padStart(2, "0"); }

function shiftMonth(month, delta) {
  const [year, mon] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

function weekdayIndex(dateString) {
  return (new Date(`${dateString}T00:00:00Z`).getUTCDay() + 6) % 7;
}

function minutesOf(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if ([sh, sm, eh, em].some((value) => !Number.isFinite(value))) return 0;
  let diff = eh * 60 + em - (sh * 60 + sm);
  if (diff === 0) return 0;
  if (diff < 0) diff += 1440;
  return diff;
}

const DEFAULT_START = "18:30";
const DEFAULT_END = "20:00";

function defaultSegment() {
  return { start: DEFAULT_START, end: DEFAULT_END };
}

function parseClock(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):?(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function clockText(totalMinutes) {
  const value = ((totalMinutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

function shiftClock(value, delta) {
  const base = parseClock(value);
  return clockText((base === null ? parseClock(DEFAULT_START) : base) + delta);
}

function durationText(minutes) {
  if (!minutes) return "0 分钟";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} 分钟`;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function hoursText(minutes) {
  if (!minutes) return "0";
  return (minutes / 60).toFixed(1).replace(/\.0$/, "");
}

function dateLabel(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return `${year} 年 ${month} 月 ${day} 日 · 周${WEEK_CN[weekdayIndex(dateString)]}`;
}

function isPreset(category, activity) {
  const item = state.categories[category];
  return Boolean(item && item.activities.includes(activity));
}

function cloneSegments(segments) {
  return segments.map((segment) => ({ start: segment.start, end: segment.end }));
}

function stateText(value) {
  return { blank: "未计划", planned: "已计划", recorded: "已记录" }[value] || "未计划";
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

function markDirty() {
  state.dirty = true;
}

function guardDirty(message) {
  if (!state.dirty) return true;
  return window.confirm(message || "当前修改还没保存，继续会丢掉。确定继续？");
}

/* ---------- 读取 ---------- */

function defaultDay(month) {
  return today.startsWith(month) ? today : `${month}-01`;
}

async function load(month) {
  state.month = month;
  $("monthPicker").value = month;
  try {
    const months = [shiftMonth(month, -1), month, shiftMonth(month, 1)];
    const payloads = await Promise.all(months.map((item) => api(`/api/training/month?month=${item}`)));
    const current = payloads[1];
    state.categories = Object.fromEntries(current.categories.map((item) => [item.id, item]));
    state.days.clear();
    for (const payload of payloads) {
      for (const record of payload.records) state.days.set(record.date, record);
    }
    if (!state.selected || !state.selected.startsWith(month)) {
      state.selected = defaultDay(month);
      state.mode = null;
      state.view = false;
    }
    state.dirty = false;
    renderAll();
  } catch (error) {
    $("calGrid").replaceChildren(node("div", "loading", `读取失败：${error.message}`));
    toast(`读取失败：${error.message}`);
  }
}

/* ---------- 渲染 ---------- */

function renderAll() {
  renderMetrics();
  renderCalendar();
  renderWeekCounts();
  renderDetail();
}

function renderMetrics() {
  const items = [...state.days.values()]
    .filter((item) => item.date.startsWith(state.month) && item.record)
    .map((item) => item.record);
  const total = items.reduce((sum, item) => sum + item.minutes, 0);
  const rated = items.filter((item) => item.intensity > 0);
  $("metricDays").textContent = items.length;
  $("metricHours").textContent = hoursText(total);
  $("metricIntensity").textContent = rated.length
    ? (rated.reduce((sum, item) => sum + item.intensity, 0) / rated.length).toFixed(1)
    : "—";
  $("metricPerformance").textContent = rated.length
    ? (rated.reduce((sum, item) => sum + item.performance, 0) / rated.length).toFixed(1)
    : "—";
}

function renderCalendar() {
  const [year, month] = state.month.split("-").map(Number);
  const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offset = weekdayIndex(`${state.month}-01`);
  const grid = $("calGrid");
  grid.replaceChildren();

  for (let index = 0; index < offset; index += 1) {
    grid.append(node("div", "cal-day is-empty"));
  }
  for (let dayNumber = 1; dayNumber <= total; dayNumber += 1) {
    const date = `${state.month}-${pad(dayNumber)}`;
    const day = state.days.get(date) || { date, state: "blank", plan: null, record: null };
    const cell = node("div", "cal-day");
    cell.dataset.date = date;
    cell.append(node("span", "cal-date", String(dayNumber)));

    cell.classList.add(`is-${day.state}`);
    const kind = day.record ? day.record.category : (day.plan ? day.plan.category : "");
    if (kind) cell.dataset.kind = kind;
    cell.tabIndex = 0;
    cell.setAttribute("role", "button");
    if (date === today) cell.classList.add("is-today");
    if (date === state.selected && state.mode) cell.classList.add("is-active");

    const headline = day.record || day.plan;
    if (headline) {
      const line = node("span", "cal-type-line");
      line.dataset.kind = headline.category;
      line.append(node("i"));
      line.append(node("b", "plan-short", headline.short));
      line.append(node("span", "plan-activity", ` · ${headline.activity || "未定"}`));
      cell.append(line);
    }

    if (day.record) {
      const record = day.record;
      const line = node("span", "cal-record-line");
      line.dataset.kind = record.category;
      if (record.category === "rest" && !record.minutes) {
        line.textContent = "休息";
      } else {
        const long = node("span", "rec-long");
        long.append(node("b", "", `${record.minutes} 分钟`));
        long.append(node("small", "", `强度 ${record.intensity} · 表现 ${record.performance}`));
        line.append(long);
        line.append(node("span", "rec-short", `${record.minutes}′·${record.intensity}·${record.performance}`));
      }
      cell.append(line);
    }

    const actionLabel = day.record ? "编辑记录" : "记录当天";
    cell.setAttribute("aria-label", `${date} ${stateText(day.state)}${day.plan ? "，" + day.plan.short : ""}，${actionLabel}`);

    const entry = node("button", "rec-entry");
    entry.type = "button";
    entry.title = actionLabel;
    entry.setAttribute("aria-label", actionLabel);
    entry.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4.2L19 9.2a2.1 2.1 0 0 0-3-3L5.2 17V20Z"/><path d="M14.5 6.5l3 3"/></svg>';
    entry.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!guardDirty()) return;
      openRecord(date, true);
    });
    cell.append(entry);

    const openMain = () => {
      if (!guardDirty()) return;
      if (day.record) openRecord(date, false);
      else openPlan(date);
    };
    cell.addEventListener("click", openMain);
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openMain();
      }
    });
    grid.append(cell);
  }
  const cells = offset + total;
  for (let index = cells; index % 7 !== 0; index += 1) {
    grid.append(node("div", "cal-day is-empty"));
  }
}

function renderWeekCounts() {
  const anchor = state.selected || today;
  const start = new Date(`${anchor}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - weekdayIndex(anchor));
  const dates = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
  const counts = { aerobic: 0, strength: 0, combat: 0 };
  let doneDays = 0;
  for (const date of dates) {
    const day = state.days.get(date);
    if (!day || !day.record) continue;
    doneDays += 1;
    if (day.record.category in counts) counts[day.record.category] += 1;
  }
  const wrap = $("weekCounts");
  wrap.replaceChildren(node("span", "week-count-label", "当周记录"));
  for (const category of ["aerobic", "strength", "combat"]) {
    const item = node("span", "week-count");
    item.dataset.kind = category;
    item.append(node("i"));
    item.append(node("span", "plan-name", state.categories[category].short));
    item.append(node("b", "", `${counts[category]}/${WEEK_TARGET[category]}`));
    if (counts[category] >= WEEK_TARGET[category]) item.classList.add("is-full");
    wrap.append(item);
  }
  wrap.append(node("span", "week-done", `已记录 ${doneDays} 天`));
}

/* ---------- 详情区 ---------- */

function renderDetail() {
  const open = Boolean(state.mode && state.selected);
  $("detailHint").hidden = open;
  $("detailBody").hidden = !open;
  if (!open) return;

  const day = state.days.get(state.selected);
  $("detailTitle").textContent = dateLabel(state.selected);
  $("journalLink").href = `/journal?date=${state.selected}`;

  const badge = $("detailState");
  badge.textContent = stateText(day.state);
  badge.dataset.kind = day.record ? day.record.category : (day.plan ? day.plan.category : "");

  const planMode = state.mode === "plan";
  const recordMode = state.mode === "record";
  const showView = recordMode && state.view;
  $("planMode").hidden = !planMode;
  $("recordView").hidden = !showView;
  $("recordEdit").hidden = !(recordMode && !state.view);

  if (planMode) {
    $("detailEyebrow").textContent = "当天计划";
    renderPlanForm();
  } else if (showView) {
    $("detailEyebrow").textContent = "当天记录 · 查看";
    renderRecordView(day);
  } else {
    $("detailEyebrow").textContent = day.record ? "当天记录 · 编辑" : "新增记录";
    renderRecordForm();
  }
}

function openPlan(date) {
  const day = state.days.get(date);
  if (!day) return;
  if (day.record) {
    openRecord(date, false);
    return;
  }
  if (!guardDirty()) return;
  state.selected = date;
  state.mode = "plan";
  state.view = false;
  const plan = day.plan;
  state.planForm = {
    category: plan ? plan.category : null,
    activity: plan ? (plan.activity || "") : "",
    custom: plan && plan.activity && !isPreset(plan.category, plan.activity) ? plan.activity : "",
  };
  state.dirty = false;
  renderAll();
  scrollToDetail();
}

function openRecord(date, edit) {
  const day = state.days.get(date);
  if (!day) return;
  const record = day.record;
  state.selected = date;
  state.mode = "record";
  state.view = Boolean(record) && !edit;

  if (!state.view) {
    const source = record || day.plan;
    const category = source ? source.category : null;
    const activity = source ? (source.activity || "") : "";
    const preset = category ? isPreset(category, activity) : false;
    state.recordForm = {
      category,
      activity: activity || (category ? state.categories[category].activities[0] : ""),
      custom: preset ? "" : activity,
      segments: record ? cloneSegments(record.segments) : [defaultSegment()],
      intensity: record ? record.intensity : 6,
      performance: record ? record.performance : 6,
      note: record ? record.note : "",
    };
  }
  state.dirty = false;
  renderAll();
  scrollToDetail();
}

function scrollToDetail() {
  const detail = $("detail");
  const rect = detail.getBoundingClientRect();
  if (rect.top < window.innerHeight && rect.bottom > 0) return;
  detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------- 计划表单 ---------- */

function renderPlanForm() {
  const form = state.planForm;
  const wrap = $("planCats");
  wrap.replaceChildren();
  for (const categoryId of CATEGORY_ORDER) {
    const category = state.categories[categoryId];
    const button = node("button", "seg-btn" + (form.category === categoryId ? " active" : ""), category.short);
    button.type = "button";
    button.dataset.kind = categoryId;
    button.addEventListener("click", () => {
      form.category = categoryId;
      form.activity = category.activities[0];
      form.custom = "";
      state.dirty = true;
      renderPlanForm();
    });
    wrap.append(button);
  }
  renderChips($("planActs"), form, () => renderPlanForm(), true);
  $("planCustom").value = form.custom;

  const day = state.days.get(state.selected);
  $("deletePlan").hidden = !day.plan;
  $("planState").textContent = day.plan ? "已有计划，可修改" : "还没有计划";
}

function renderChips(container, form, rerender, planMode) {
  container.replaceChildren();
  container.dataset.kind = form.category || "";
  if (!form.category) {
    container.append(node("span", "chips-hint", "先选运动类型"));
    return;
  }
  const category = state.categories[form.category];
  for (const name of category.activities) {
    const active = !form.custom.trim() && form.activity === name;
    const chip = node("button", "chip" + (active ? " active" : ""), name);
    chip.type = "button";
    chip.addEventListener("click", () => {
      form.activity = name;
      form.custom = "";
      state.dirty = true;
      rerender();
      const input = planMode ? $("planCustom") : $("recCustom");
      if (input) input.value = "";
    });
    container.append(chip);
  }
}

/* ---------- 记录表单 ---------- */

function renderRecordForm() {
  const form = state.recordForm;
  const cats = $("recCats");
  cats.replaceChildren();
  for (const categoryId of CATEGORY_ORDER) {
    const category = state.categories[categoryId];
    const button = node("button", "seg-btn" + (form.category === categoryId ? " active" : ""), category.short);
    button.type = "button";
    button.dataset.kind = categoryId;
    button.addEventListener("click", () => {
      form.category = categoryId;
      form.activity = category.activities[0];
      form.custom = "";
      if (categoryId === "rest") {
        form.segments = [];
      } else if (!form.segments.length) {
        form.segments = [defaultSegment()];
      }
      state.dirty = true;
      renderRecordForm();
    });
    cats.append(button);
  }
  renderChips($("recActs"), form, () => renderRecordForm(), false);
  $("recCustom").value = form.custom;
  renderSegments();
  syncScores();
  $("recNote").value = form.note;
  updateRecordTotals();
}

function timeField(value, label, onChange) {
  const wrap = node("div", "time-field");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "time-input";
  input.value = value;
  input.inputMode = "numeric";
  input.maxLength = 5;
  input.setAttribute("aria-label", label);

  const steps = node("div", "time-steps");
  const up = node("button", "time-step", "▲");
  const down = node("button", "time-step", "▼");
  for (const [button, delta, text] of [[up, 10, "加 10 分钟"], [down, -10, "减 10 分钟"]]) {
    button.type = "button";
    button.setAttribute("aria-label", `${label}${text}`);
    button.addEventListener("click", () => {
      const next = shiftClock(input.value, delta);
      input.value = next;
      onChange(next);
    });
    steps.append(button);
  }

  input.addEventListener("input", () => {
    const parsed = parseClock(input.value);
    if (parsed !== null) onChange(clockText(parsed));
  });
  input.addEventListener("change", () => {
    const parsed = parseClock(input.value);
    const next = parsed === null ? value : clockText(parsed);
    input.value = next;
    onChange(next);
  });

  wrap.append(input, steps);
  return wrap;
}

function renderSegments() {
  const wrap = $("recSegments");
  wrap.replaceChildren();
  const form = state.recordForm;
  form.segments.forEach((segment, index) => {
    const row = node("div", "segment-row");
    const duration = node("span", "seg-dur", durationText(minutesOf(segment.start, segment.end)));
    const update = () => {
      duration.textContent = durationText(minutesOf(segment.start, segment.end));
      state.dirty = true;
      updateRecordTotals();
    };
    const start = timeField(segment.start, `第 ${index + 1} 个时段开始`, (value) => {
      segment.start = value;
      update();
    });
    const end = timeField(segment.end, `第 ${index + 1} 个时段结束`, (value) => {
      segment.end = value;
      update();
    });
    const dash = node("span", "seg-dash", "—");
    const remove = node("button", "seg-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `删除第 ${index + 1} 个时段`);
    remove.addEventListener("click", () => {
      form.segments.splice(index, 1);
      state.dirty = true;
      renderSegments();
      updateRecordTotals();
    });
    row.append(start, dash, end, duration, remove);
    wrap.append(row);
  });
  if (!form.segments.length) {
    wrap.append(node("p", "seg-empty", "休息日可以不加时段；其它类型至少要有一个完整时段。"));
  }
}

function syncScores() {
  const form = state.recordForm;
  $("recIntensityRange").value = String(form.intensity);
  $("recIntensityNum").value = String(form.intensity);
  $("recPerformanceRange").value = String(form.performance);
  $("recPerformanceNum").value = String(form.performance);
}

function updateRecordTotals() {
  const form = state.recordForm;
  const minutes = form.segments.reduce((sum, segment) => sum + minutesOf(segment.start, segment.end), 0);
  $("recordTotal").textContent = durationText(minutes);
  $("recordAvg").textContent = `强度 ${form.intensity} · 表现 ${form.performance}`;
}

function renderRecordView(day) {
  const record = day.record;
  $("recordPlan").textContent = day.plan
    ? `当天计划：${day.plan.short} · ${day.plan.activity || "未定"}`
    : "当天没有计划，这条是直接记录。";
  const list = $("recordList");
  list.replaceChildren();
  const rows = [
    ["运动", `${record.short} · ${record.activity || "未填"}`],
    ["时段", record.segments.length ? record.segments.map((s) => `${s.start}–${s.end}`).join("、") : "未填"],
    ["合计", durationText(record.minutes)],
    ["强度", `${record.intensity} / 10`],
    ["表现", `${record.performance} / 10`],
    ["其它", record.note || "—"],
  ];
  for (const [label, value] of rows) {
    list.append(node("dt", "", label));
    list.append(node("dd", "", value));
  }
}

/* ---------- 事件 ---------- */

$("planCustom").addEventListener("input", (event) => {
  const form = state.planForm;
  form.custom = event.target.value;
  form.activity = event.target.value.trim()
    || (form.category ? state.categories[form.category].activities[0] : "");
  state.dirty = true;
  document.querySelectorAll("#planActs .chip").forEach((chip) => chip.classList.remove("active"));
});

$("recCustom").addEventListener("input", (event) => {
  const form = state.recordForm;
  form.custom = event.target.value;
  form.activity = event.target.value.trim()
    || (form.category ? state.categories[form.category].activities[0] : "");
  state.dirty = true;
  document.querySelectorAll("#recActs .chip").forEach((chip) => chip.classList.remove("active"));
});

$("recNote").addEventListener("input", (event) => {
  state.recordForm.note = event.target.value;
  state.dirty = true;
});

$("addRecSeg").addEventListener("click", () => {
  const segments = state.recordForm.segments;
  const last = segments[segments.length - 1];
  const start = last && last.end ? last.end : DEFAULT_START;
  segments.push({ start, end: shiftClock(start, 90) });
  state.dirty = true;
  renderSegments();
  updateRecordTotals();
});

for (const key of ["intensity", "performance"]) {
  const range = $(`rec${key[0].toUpperCase()}${key.slice(1)}Range`);
  const number = $(`rec${key[0].toUpperCase()}${key.slice(1)}Num`);
  range.addEventListener("input", () => {
    state.recordForm[key] = Number(range.value);
    number.value = range.value;
    state.dirty = true;
    updateRecordTotals();
  });
  number.addEventListener("input", () => {
    const value = Number(number.value);
    if (!number.value || !Number.isFinite(value)) return;
    state.recordForm[key] = Math.min(10, Math.max(1, Math.round(value)));
    range.value = String(state.recordForm[key]);
    state.dirty = true;
    updateRecordTotals();
  });
  number.addEventListener("change", () => {
    const value = Number(number.value);
    state.recordForm[key] = Math.min(10, Math.max(1, Math.round(Number.isFinite(value) ? value : 6)));
    number.value = String(state.recordForm[key]);
    range.value = String(state.recordForm[key]);
    state.dirty = true;
    updateRecordTotals();
  });
}

$("savePlan").addEventListener("click", async () => {
  const plan = state.planForm;
  if (!plan.category) {
    toast("先选运动类型");
    return;
  }
  const date = state.selected;
  $("savePlan").disabled = true;
  try {
    const payload = await api(`/api/training/plan/${date}`, {
      method: "PUT",
      body: JSON.stringify({
        category: plan.category,
        activity: plan.custom.trim() || plan.activity,
      }),
    });
    state.days.set(date, payload);
    state.dirty = false;
    renderAll();
    $("planState").textContent = "计划已保存";
    toast("计划已保存");
  } catch (error) {
    toast(`计划没保存：${error.message}`);
  } finally {
    $("savePlan").disabled = false;
  }
});

$("deletePlan").addEventListener("click", async () => {
  const date = state.selected;
  const day = state.days.get(date);
  if (!day || !day.plan) return;
  if (!window.confirm(`删除 ${dateLabel(date)} 的计划？`)) return;
  try {
    const payload = await api(`/api/training/plan/${date}`, { method: "DELETE" });
    state.days.set(date, payload);
    state.mode = null;
    state.dirty = false;
    renderAll();
    toast("计划已删除");
  } catch (error) {
    toast(`删除失败：${error.message}`);
  }
});

$("saveRecord").addEventListener("click", async () => {
  const form = state.recordForm;
  if (!form.category) {
    toast("先选运动类型");
    return;
  }
  const segments = form.segments.filter((segment) => segment.start && segment.end);
  if (form.category !== "rest" && !segments.length) {
    toast("先填运动时段");
    return;
  }
  const date = state.selected;
  $("saveRecord").disabled = true;
  try {
    const payload = await api(`/api/training/record/${date}`, {
      method: "PUT",
      body: JSON.stringify({
        category: form.category,
        activity: form.custom.trim() || form.activity,
        segments,
        intensity: form.intensity,
        performance: form.performance,
        note: form.note,
      }),
    });
    state.days.set(date, payload);
    state.view = true;
    state.dirty = false;
    renderAll();
    toast(`已记录 ${durationText(payload.record.minutes)}`);
  } catch (error) {
    toast(`记录没保存：${error.message}`);
  } finally {
    $("saveRecord").disabled = false;
  }
});

$("editRecord").addEventListener("click", () => {
  openRecord(state.selected, true);
});

$("deleteRecord").addEventListener("click", async () => {
  const date = state.selected;
  const day = state.days.get(date);
  if (!day || !day.record) return;
  if (!window.confirm(`删除 ${dateLabel(date)} 的记录？计划会保留。`)) return;
  try {
    const payload = await api(`/api/training/record/${date}`, { method: "DELETE" });
    state.days.set(date, payload);
    state.mode = null;
    state.view = false;
    state.dirty = false;
    renderAll();
    toast("记录已删除，计划仍在");
  } catch (error) {
    toast(`删除失败：${error.message}`);
  }
});

$("cancelRecord").addEventListener("click", () => {
  const day = state.days.get(state.selected);
  state.dirty = false;
  if (day && day.record) {
    openRecord(state.selected, false);
  } else {
    state.mode = null;
    renderAll();
  }
});

$("detailClose").addEventListener("click", () => {
  if (!guardDirty("当前修改还没保存，关闭会丢掉。确定关闭？")) return;
  state.mode = null;
  state.view = false;
  state.dirty = false;
  renderAll();
});

$("prevMonth").addEventListener("click", () => {
  if (!guardDirty("当前修改还没保存，换月份会丢掉。继续？")) return;
  load(shiftMonth(state.month, -1));
});
$("nextMonth").addEventListener("click", () => {
  if (!guardDirty("当前修改还没保存，换月份会丢掉。继续？")) return;
  load(shiftMonth(state.month, 1));
});
$("monthPicker").addEventListener("change", (event) => {
  const value = event.target.value;
  if (!value) return;
  if (!guardDirty("当前修改还没保存，换月份会丢掉。继续？")) {
    event.target.value = state.month;
    return;
  }
  load(value);
});

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

load(state.month);
