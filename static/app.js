"use strict";

const now = new Date();
const todayValue = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const NEW_SCHEME_START = "2026-10-25";
const SLEEP_SCORE_START = "2026-11-07";
// 10/24 及以前只读；10/25 起随时可改，默认打开今天（未到 10/25 时打开 10/25）
const linkedDate = new URLSearchParams(location.search).get("date");
const defaultDateValue = /^\d{4}-\d{2}-\d{2}$/.test(linkedDate)
  && linkedDate >= "2000-01-01" && linkedDate <= "2100-12-31"
  && toDateValue(new Date(`${linkedDate}T12:00:00`)) === linkedDate
  ? linkedDate : (todayValue >= NEW_SCHEME_START ? todayValue : NEW_SCHEME_START);
const defaultMonth = defaultDateValue.slice(0, 7);
const state = { month: defaultMonth, payload: null, selectedDate: defaultDateValue };
const $ = (selector) => document.querySelector(selector);
let pickerMonth = defaultMonth;
// 横坐标上「本月第几个周一」在 records 里的下标，供周时长标注定位
let weekAxisStarts = [];
const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function toDateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `${response.status}`);
  return response.json();
}

function round2(value) { return Math.round((Number(value) || 0) * 100) / 100; }
// 单日 / 月度时长保留 1 位；当月日均保留 2 位
function formatHours(value) { return round2(value).toFixed(2); }
function formatTime(value) { return round2(value).toFixed(1); }
// 输入以 0.5 小时为单位，并限制在 0–24 小时
function snapToHalf(value) { return Math.round((Number(value) || 0) * 2) / 2; }
function normalizeTime(value) { return Math.min(24, Math.max(0, snapToHalf(value))); }

// 与后端 month_payload 的汇总口径保持一致，用于保存后本地实时重算（无需等下次请求）
function computeTotals(payload) {
  const records = payload.records || [];
  const sum = (key) => round2(records.reduce((acc, item) => acc + (Number(item[key]) || 0), 0));
  const totals = {
    morning: sum("morning"),
    afternoon: sum("afternoon"),
    evening: sum("evening"),
    sport: sum("sport"),
    llm_or: sum("llm_or"),
    research_other: sum("research_other"),
    admin_work: sum("admin_work"),
  };
  totals.study_total = round2(totals.morning + totals.afternoon + totals.evening + totals.llm_or + totals.research_other + totals.admin_work);
  totals.total = round2(totals.study_total + totals.sport);
  const active = records.filter((item) => (Number(item.total) || 0) > 0);
  totals.active_days = active.length;
  totals.average = active.length ? round2(totals.total / active.length) : 0;
  totals.max_day = records.reduce((max, item) => Math.max(max, Number(item.total) || 0), 0);
  return totals;
}

function parseClock(value) {
  if (!/^\d{2}:\d{2}$/.test(value || "")) return null;
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function normalizeNap(value) {
  return Math.min(12, Math.max(0, snapToHalf(value)));
}

function hasSleepEntry(record) {
  return record.sleep_method === "score"
    ? Number(record.sleep_score) > 0
    : Boolean(record.sleep_time && record.wake_time);
}

function evaluateSleep(bedtime, wake, nap) {
  const bed = parseClock(bedtime);
  const wakeMinutes = parseClock(wake);
  const napHours = Number(nap) || 0;
  if (bed === null || wakeMinutes === null) {
    return { ready: false, ok: false, total: 0, bedtimeOk: false, nap: napHours };
  }
  const bedtimeOk = bed <= 30 || bed >= 18 * 60;
  const total = round2(((wakeMinutes - bed + 1440) % 1440) / 60 + napHours);
  return { ready: true, ok: bedtimeOk && total >= 8, total, bedtimeOk, nap: napHours };
}

function updateSleepState() {
  const toggle = $("#sleepToggle");
  const summary = $("#sleepToggleSummary");
  const status = $("#sleepStatus");
  const selected = state.payload?.records.find((item) => item.study_date === state.selectedDate);
  const usesScore = selected ? selected.sleep_method === "score" : state.selectedDate >= SLEEP_SCORE_START;
  status.classList.remove("ok", "fail");

  if (usesScore) {
    const score = Math.round(Math.min(100, Math.max(0, Number($("#sleepScore").value) || 0)));
    const ok = score > 90;
    toggle.classList.toggle("ok", ok);
    const label = $("#sleepScoreLabel");
    label.classList.remove("ok", "fail");
    if (!score) {
      summary.textContent = "未填写";
      label.textContent = "睡眠评分";
      status.textContent = "填写 iWatch 睡眠评分后自动判断";
      return;
    }
    summary.textContent = `${score} 分 · ${ok ? "达标" : "未达标"}`;
    label.textContent = `睡眠评分 · ${ok ? "达标" : "未达标"}`;
    label.classList.add(ok ? "ok" : "fail");
    status.textContent = ok
      ? `达标 · iWatch 睡眠评分 ${score}`
      : `未达标 · 评分 ${score}，未超过 90`;
    status.classList.add(ok ? "ok" : "fail");
    return;
  }

  const bedtime = $("#sleepTime").value;
  const wake = $("#wakeTime").value;
  const nap = $("#napHours").value;
  const result = evaluateSleep(bedtime, wake, nap);
  toggle.classList.toggle("ok", result.ok);
  if (!result.ready) {
    const hasAny = bedtime || wake || Number(nap) > 0;
    summary.textContent = hasAny ? "待补全" : "未填写";
    status.textContent = "填写入睡与起床时间后自动判断";
    return;
  }
  summary.textContent = `${formatTime(result.total)}h · ${result.ok ? "达标" : "未达标"}`;
  const napNote = result.nap > 0 ? `（含午休 ${formatTime(result.nap)}h）` : "";
  if (result.ok) {
    status.textContent = `达标 · 总睡眠 ${formatTime(result.total)}h${napNote}`;
    status.classList.add("ok");
    return;
  }
  const reasons = [];
  if (!result.bedtimeOk) reasons.push("入睡晚于 00:30");
  if (result.total < 8) reasons.push(`总睡眠 ${formatTime(result.total)}h，未达 8h`);
  status.textContent = `未达标 · ${reasons.join("；")}`;
  status.classList.add("fail");
}

function formatSavedAt(value) {
  if (!value) return "";
  const [datePart, timePart] = String(value).split("T");
  if (!datePart || !timePart) return "";
  return `已保存 ${datePart} · ${timePart.slice(0, 5)}`;
}

function setQuickSaveState(text, saved = false) {
  const state = $("#quickSaveState");
  state.textContent = text;
  state.classList.toggle("is-saved", saved);
}

function selectQuickRecord(dateValue) {
  const record = state.payload?.records.find((item) => item.study_date === dateValue);
  if (!record) return;
  state.selectedDate = dateValue;
  $("#journalLink").href = `/journal?date=${dateValue}`;
  $("#quickDate").value = dateValue;
  const day = Number(dateValue.slice(-2));
  const isNew = record.scheme === "new";
  const editable = record.editable === true;
  $("#quickDateLabel").textContent = `${day} 日 · ${record.weekday}`;
  $("#dateTriggerText").textContent = `${day} 日 · ${record.weekday}`;
  $("#dateTrigger").setAttribute("aria-label", `选择记录日期，当前 ${day} 日 ${record.weekday}`);

  $("#legacyValues").hidden = isNew;
  $("#newValues").hidden = !isNew;
  // 可编辑时吸附到 0.5h；只读历史数据按原值保留 1 位小数
  const display = (value) => formatTime(editable ? normalizeTime(value) : value);
  if (isNew) {
    $("#quickLlm").value = display(record.llm_or);
    $("#quickResearch").value = display(record.research_other);
    $("#quickWork").value = display(record.admin_work);
    $("#quickNewSport").value = display(record.sport);
  } else {
    $("#quickMorning").value = display(record.morning);
    $("#quickAfternoon").value = display(record.afternoon);
    $("#quickEvening").value = display(record.evening);
    $("#quickSport").value = display(record.sport);
  }

  const activeInputs = isNew
    ? ["#quickLlm", "#quickResearch", "#quickWork", "#quickNewSport"]
    : ["#quickMorning", "#quickAfternoon", "#quickEvening", "#quickSport"];
  activeInputs.forEach((selector) => { $(selector).disabled = !editable; });

  if (isNew) {
    const usesScore = record.sleep_method === "score";
    // 评分口径只有一个数字：直接平铺在面板里，不再用下拉；时间口径仍需折叠区放入睡/起床/午休
    $("#sleepToggleWrap").hidden = usesScore;
    $("#sleepScoreInline").hidden = !usesScore;
    if (usesScore) {
      $("#sleepPanel").hidden = true;
      $("#sleepToggle").setAttribute("aria-expanded", "false");
    }
    $("#sleepTimeField").hidden = usesScore;
    $("#wakeTimeField").hidden = usesScore;
    $("#napField").hidden = usesScore;
    if (usesScore) {
      $("#sleepScore").value = Math.round(Number(record.sleep_score) || 0);
    } else {
      $("#sleepTime").value = record.sleep_time || "";
      $("#wakeTime").value = record.wake_time || "";
      $("#napHours").value = formatTime(editable ? normalizeNap(record.nap_hours) : record.nap_hours);
    }
    ["#sleepTimeTrigger", "#wakeTimeTrigger", "#napHours", "#sleepScore"].forEach((selector) => { $(selector).disabled = !editable; });
    syncTimeTriggers();
    updateSleepState();
  } else {
    $("#sleepPanel").hidden = true;
    $("#sleepToggleWrap").hidden = false;
    $("#sleepScoreInline").hidden = true;
    $("#sleepToggle").setAttribute("aria-expanded", "false");
    $("#sleepToggle").classList.remove("ok");
    $("#sleepToggleSummary").textContent = "未填写";
    $("#sleepStatus").classList.remove("ok", "fail");
    $("#sleepStatus").textContent = "填写后自动判断";
  }

  const saveButton = $("#quickSaveButton");
  saveButton.disabled = !editable;
  saveButton.textContent = editable ? "保存当天" : "历史只读";
  $("#quickModeLabel").textContent = editable
    ? (isNew ? "新统计 · 10/25 起" : "旧统计 · 10/24 及前")
    : "历史记录 · 只读";
  const savedAt = formatSavedAt(record.updated_at);
  setQuickSaveState(savedAt || (editable ? "尚未保存 · 0.5 小时为单位" : "历史数据已锁定，不可修改"), Boolean(savedAt));

  document.querySelectorAll(".stack-column.selected").forEach((item) => {
    item.classList.remove("selected");
    item.setAttribute("aria-pressed", "false");
  });
  const target = document.querySelector(`.stack-column[data-date="${dateValue}"]`);
  if (target) {
    target.classList.add("selected");
    target.setAttribute("aria-pressed", "true");
  }
}

function renderDatePicker() {
  const [year, month] = pickerMonth.split("-").map(Number);
  const monthIndex = month - 1;
  const first = new Date(year, monthIndex, 1);
  const offset = (first.getDay() + 6) % 7; // 周一作为第一列
  const start = new Date(year, monthIndex, 1 - offset);
  const recorded = new Set(
    state.payload && state.payload.month === pickerMonth
      ? state.payload.records.filter((item) => Number(item.total) > 0 || hasSleepEntry(item)).map((item) => item.study_date)
      : []
  );
  $("#datePickerTitle").textContent = `${year} 年 ${month} 月`;
  let cells = "";
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const value = toDateValue(date);
    const isOutside = date.getMonth() !== monthIndex;
    const isToday = value === todayValue;
    const isSelected = value === state.selectedDate;
    const classes = ["date-cell"];
    if (isOutside) classes.push("is-outside");
    if (isToday) classes.push("is-today");
    if (isSelected) classes.push("is-selected");
    const label = `${value.slice(0, 4)} 年 ${Number(value.slice(5, 7))} 月 ${Number(value.slice(8, 10))} 日 ${WEEKDAY_LABELS[date.getDay()]}${isToday ? "，今天" : ""}`;
    const current = isToday ? ' aria-current="date"' : "";
    const pressed = isSelected ? ' aria-pressed="true"' : ' aria-pressed="false"';
    cells += `<button class="${classes.join(" ")}" type="button" data-date="${value}" aria-label="${label}"${current}${pressed}><span class="date-num">${date.getDate()}</span>${recorded.has(value) ? '<i class="date-dot"></i>' : ""}</button>`;
  }
  $("#datePickerGrid").innerHTML = cells;
  const selectedLabel = state.selectedDate
    ? `${Number(state.selectedDate.slice(5, 7))} 月 ${Number(state.selectedDate.slice(8, 10))} 日`
    : "未选择日期";
  $("#datePickerSelectedLabel").textContent = state.selectedDate === todayValue ? `今天 · ${selectedLabel}` : `已选 ${selectedLabel}`;
}

function positionDatePicker() {
  const picker = $("#datePicker");
  if (picker.hidden) return;
  if (window.matchMedia("(max-width: 560px)").matches) {
    picker.style.left = "";
    picker.style.top = "";
    picker.classList.remove("above");
    return;
  }
  const trigger = $("#dateTrigger");
  const rect = trigger.getBoundingClientRect();
  const width = picker.offsetWidth;
  const height = picker.offsetHeight;
  const margin = 12;
  const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, margin), window.innerWidth - width - margin);
  let top = rect.bottom + 8;
  const above = top + height > window.innerHeight - margin;
  if (above) top = rect.top - height - 8;
  picker.classList.toggle("above", above);
  picker.style.left = `${left}px`;
  picker.style.top = `${Math.max(margin, top)}px`;
}

function openDatePicker() {
  closeTimePicker(false);
  pickerMonth = (state.selectedDate || todayValue).slice(0, 7);
  renderDatePicker();
  const picker = $("#datePicker");
  picker.hidden = false;
  $("#datePickerBackdrop").hidden = false;
  document.body.classList.add("picker-open");
  $("#dateTrigger").setAttribute("aria-expanded", "true");
  positionDatePicker();
  requestAnimationFrame(() => {
    const target = picker.querySelector(".is-selected") || picker.querySelector(".is-today") || picker.querySelector(".date-cell:not(.is-outside)");
    target?.focus({ preventScroll: true });
  });
}

function closeDatePicker(restoreFocus = true) {
  const picker = $("#datePicker");
  if (picker.hidden) return;
  picker.hidden = true;
  $("#datePickerBackdrop").hidden = true;
  document.body.classList.remove("picker-open");
  $("#dateTrigger").setAttribute("aria-expanded", "false");
  if (restoreFocus) $("#dateTrigger").focus({ preventScroll: true });
}

function shiftPickerMonth(offset) {
  const [year, month] = pickerMonth.split("-").map(Number);
  const next = new Date(year, month - 1 + offset, 1);
  pickerMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  renderDatePicker();
  positionDatePicker();
}

function pickDate(dateValue) {
  if (!dateValue) return;
  const targetMonth = dateValue.slice(0, 7);
  closeDatePicker();
  if (targetMonth !== state.month) {
    state.month = targetMonth;
    state.selectedDate = dateValue;
    $("#monthPicker").value = targetMonth;
    loadMonth();
    return;
  }
  selectQuickRecord(dateValue);
}

function pickToday() {
  const targetMonth = todayValue.slice(0, 7);
  closeDatePicker();
  if (targetMonth !== state.month) {
    state.month = targetMonth;
    state.selectedDate = todayValue;
    $("#monthPicker").value = targetMonth;
    loadMonth();
    return;
  }
  selectQuickRecord(todayValue);
}

const TIME_MINUTE_OPTIONS = ["00", "10", "20", "30", "40", "50"];
const TIME_DEFAULTS = { sleep: "23:00", wake: "07:00" };
let activeTimeField = null;
let pickerHour = "23";
let pickerMinute = "00";

function roundTimeToTen(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || "");
  if (!match) return "";
  const total = Math.round((Number(match[1]) * 60 + Number(match[2])) / 10) * 10 % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function syncTimeTriggers() {
  const sleep = $("#sleepTime").value;
  const wake = $("#wakeTime").value;
  $("#sleepTimeText").textContent = sleep || "选择";
  $("#wakeTimeText").textContent = wake || "选择";
  $("#sleepTimeTrigger").classList.toggle("placeholder", !sleep);
  $("#wakeTimeTrigger").classList.toggle("placeholder", !wake);
}

function renderTimePicker() {
  $("#timePickerPreview").textContent = `${pickerHour}:${pickerMinute}`;
  document.querySelectorAll("#timeHourGrid .time-choice").forEach((button) => {
    const selected = button.dataset.hour === pickerHour;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  document.querySelectorAll("#timeMinuteGrid .time-choice").forEach((button) => {
    const selected = button.dataset.minute === pickerMinute;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function openTimePicker(field) {
  closeDatePicker(false);
  activeTimeField = field;
  $("#timePickerTitle").textContent = field === "sleep" ? "睡眠时间" : "起床时间";
  const input = field === "sleep" ? $("#sleepTime") : $("#wakeTime");
  const initial = roundTimeToTen(input.value) || TIME_DEFAULTS[field];
  [pickerHour, pickerMinute] = initial.split(":");
  input.value = initial;
  syncTimeTriggers();
  updateSleepState();
  renderTimePicker();
  $("#timePicker").hidden = false;
  $("#timePickerBackdrop").hidden = false;
  document.body.classList.add("time-picker-open");
  $("#sleepTimeTrigger").setAttribute("aria-expanded", field === "sleep" ? "true" : "false");
  $("#wakeTimeTrigger").setAttribute("aria-expanded", field === "wake" ? "true" : "false");
  requestAnimationFrame(() => {
    document.querySelector(`#timeHourGrid .time-choice[data-hour="${pickerHour}"]`)?.focus({ preventScroll: true });
  });
}

function closeTimePicker(restoreFocus = true) {
  const picker = $("#timePicker");
  if (picker.hidden) return;
  picker.hidden = true;
  $("#timePickerBackdrop").hidden = true;
  document.body.classList.remove("time-picker-open");
  $("#sleepTimeTrigger").setAttribute("aria-expanded", "false");
  $("#wakeTimeTrigger").setAttribute("aria-expanded", "false");
  if (restoreFocus && activeTimeField) {
    $(activeTimeField === "sleep" ? "#sleepTimeTrigger" : "#wakeTimeTrigger").focus({ preventScroll: true });
  }
  activeTimeField = null;
}

function setPickerTime(hour, minute) {
  pickerHour = hour;
  pickerMinute = minute;
  const input = activeTimeField === "sleep" ? $("#sleepTime") : $("#wakeTime");
  if (input) input.value = `${hour}:${minute}`;
  syncTimeTriggers();
  updateSleepState();
  renderTimePicker();
}

let toastTimer = null;

function showToast(message) {
  const toast = $("#toast");
  toast.querySelector("span").textContent = message;
  toast.hidden = false;
  void toast.offsetWidth;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    toastTimer = setTimeout(() => { toast.hidden = true; }, 300);
  }, 1800);
}

function hideChartTooltip() {
  const tip = $("#chartTooltip");
  if (!tip) return;
  tip.hidden = true;
  tip.classList.remove("below");
}

function showChartTooltip(dateValue, column) {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  const record = state.payload?.records.find((item) => item.study_date === dateValue);
  if (!record) return;
  const tip = $("#chartTooltip");
  const main = $(".chart-main");
  const mainRect = main.getBoundingClientRect();
  const columnRect = column.getBoundingClientRect();
  const isNew = record.scheme === "new";
  const definitions = isNew
    ? [["llm", "核心科研", "llm_or"], ["research", "项目开发", "research_other"], ["work", "其它事务", "admin_work"], ["sport-new", "运动兴趣", "sport"]]
    : [["morning", "上午", "morning"], ["afternoon", "下午", "afternoon"], ["evening", "晚上", "evening"], ["sport", "运动", "sport"]];
  const rows = definitions
    .filter(([, , key]) => Number(record[key]) > 0)
    .map(([className, label, key]) => `<div class="chart-tooltip-row"><i class="${className}"></i><span>${label}</span><b>${formatTime(record[key])}h</b></div>`)
    .join("");
  const day = Number(dateValue.slice(-2));
  const score = Math.round(Number(record.sleep_score) || 0);
  const sleepLine = record.sleep_method === "score"
    ? (score > 0
        ? `<div class="chart-tooltip-sleep ${record.sleep_ok ? "ok" : ""}">iWatch 睡眠 ${score} 分 · ${record.sleep_ok ? "达标" : "未达标"}</div>`
        : "")
    : (record.sleep_time && record.wake_time
        ? `<div class="chart-tooltip-sleep ${record.sleep_ok ? "ok" : ""}">睡眠 ${formatTime(record.sleep_total)}h · ${record.sleep_ok ? "达标" : "未达标"}</div>`
        : "");
  tip.innerHTML = `<div class="chart-tooltip-head"><strong>${day} 日 · ${record.weekday}</strong><span>${formatTime(record.total)}h</span></div>${rows || `<div class="chart-tooltip-row"><span>暂无记录</span><b>0.0h</b></div>`}${sleepLine}`;
  tip.hidden = false;
  tip.classList.remove("below");
  const tipWidth = tip.offsetWidth;
  const tipHeight = tip.offsetHeight;
  const center = columnRect.left - mainRect.left + columnRect.width / 2;
  const left = Math.min(Math.max(center, tipWidth / 2 + 2), mainRect.width - tipWidth / 2 - 2);
  tip.style.left = `${left}px`;
  const top = columnRect.top - mainRect.top;
  if (top < tipHeight + 12) {
    tip.classList.add("below");
    tip.style.top = `${top + 9}px`;
  } else {
    tip.style.top = `${top - 9}px`;
  }
}
function shiftMonth(offset) {
  const current = new Date(`${state.month}-01T00:00:00`);
  current.setMonth(current.getMonth() + offset);
  state.month = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}`;
  $("#monthPicker").value = state.month;
  loadMonth();
}

function renderAverageLine(scaleMax, average, activeDays) {
  const line = $("#chartAvgLine");
  const rule = line.querySelector("i");
  const label = line.querySelector("span");
  if (!(average > 0) || !(scaleMax > 0)) {
    line.hidden = true;
    return;
  }
  const ratio = Math.min(1, average / scaleMax);
  line.hidden = false;
  line.classList.toggle("near-top", ratio > .84);
  rule.style.bottom = `${ratio * 100}%`;
  label.textContent = `当月日均 ${formatHours(average)}h`;
  if (ratio > .84) {
    label.style.bottom = "auto";
    label.style.top = `calc(${(1 - ratio) * 100}% + 5px)`;
  } else {
    label.style.top = "auto";
    label.style.bottom = `${ratio * 100}%`;
  }
  line.title = `本月有效记录 ${activeDays} 天，日均（学习 + 运动）${formatHours(average)} 小时`;
}

// 周序号之间显示当周学习总时长：>60 小时绿色，48–60 小时黄色，<48 小时红色
function weekTotalBand(hours) {
  if (hours > 60) return "is-high";
  if (hours >= 48) return "is-mid";
  return "is-low";
}

// 整数不带小数位（45 小时），有小数保留 1 位（45.5 小时）
function weekTotalText(hours) {
  const value = round2(hours);
  return `（${Number.isInteger(value) ? String(value) : value.toFixed(1)}小时）`;
}

function renderWeekTotals() {
  const axis = $("#chartXAxis");
  const payload = state.payload;
  if (!axis) return;
  axis.querySelectorAll(".week-total").forEach((node) => node.remove());
  if (!payload || !weekAxisStarts.length) return;
  const cells = Array.from(axis.querySelectorAll("span[data-day]"));
  if (!cells.length) return;
  const axisRect = axis.getBoundingClientRect();
  const bounds = cells.map((cell) => {
    const rect = cell.getBoundingClientRect();
    return { left: rect.left, right: rect.right, center: rect.left + rect.width / 2 };
  });
  weekAxisStarts.forEach((start, position) => {
    const hasNext = position + 1 < weekAxisStarts.length;
    // 本周 = 本周周一 至 下一个周一前一天；最后一周截到月末
    const end = hasNext ? weekAxisStarts[position + 1] - 1 : payload.records.length - 1;
    const slice = payload.records.slice(start, end + 1);
    if (!slice.length) return;
    const hours = round2(slice.reduce((sum, record) => sum + (Number(record.study_total) || 0), 0));
    // 文字居中放在「本周周一」与「下周一」之间，最后一周放在本周周一到月末之间
    const leftEdge = bounds[start].center;
    const rightEdge = hasNext ? bounds[weekAxisStarts[position + 1]].center : bounds[end].right;
    const gap = rightEdge - leftEdge;
    const node = document.createElement("span");
    node.className = `week-total ${weekTotalBand(hours)}`;
    node.textContent = weekTotalText(hours);
    const [fromMonth, fromDay] = slice[0].study_date.split("-").slice(1).map(Number);
    const [toMonth, toDay] = slice[slice.length - 1].study_date.split("-").slice(1).map(Number);
    node.title = `${fromMonth} 月 ${fromDay} 日–${toMonth} 月 ${toDay} 日 · 学习合计 ${formatTime(hours)} 小时（不含运动）`;
    node.style.left = `${(leftEdge + rightEdge) / 2 - axisRect.left}px`;
    axis.appendChild(node);
    // 间隙太窄就隐藏，避免压住周序号；时长仍可从周序号的 title 读到
    if (node.offsetWidth > gap - 4) {
      node.classList.add("is-tight");
      const mark = cells[start];
      if (mark) {
        if (!mark.dataset.baseTitle) mark.dataset.baseTitle = mark.title;
        mark.title = `${mark.dataset.baseTitle} · 本周学习 ${formatTime(hours)} 小时`;
      }
    }
  });
}

function renderStackChart(payload) {
  hideChartTooltip();
  // 刻度固定 0–12h；绘图区上方预留 2h 余量，让 12h 以上的柱体越过 12 线
  const scaleMax = 14;
  const ticks = [12, 9, 6, 3, 0];
  const average = Number(payload.totals.average || 0);
  const hasLegacy = payload.records.some((record) => record.scheme === "legacy");
  const hasNew = payload.records.some((record) => record.scheme === "new");
  $("#legendLegacy").hidden = !hasLegacy;
  $("#legendNew").hidden = !hasNew;
  $("#monthPicker").value = payload.month;
  $("#chartRange").textContent = `${payload.year}.${String(payload.month_number).padStart(2, "0")} · ${payload.records.length} 天${average > 0 ? ` · 当月日均 ${formatHours(average)}h` : ""}`;
  $("#stackChart").style.setProperty("--days", payload.records.length);
  $("#chartXAxis").style.setProperty("--days", payload.records.length);
  $("#chartYAxis").innerHTML = ticks.map((value) => `<span class="${value === 0 ? "zero" : ""}" style="bottom:${value / scaleMax * 100}%">${value}</span>`).join("");
  $("#chartGridLines").innerHTML = ticks.map((value) => `<i style="bottom:${value / scaleMax * 100}%"></i>`).join("");
  $("#stackChart").innerHTML = payload.records.map((record) => {
    const total = Number(record.total || 0);
    const totalHeight = Math.min(total / scaleMax * 100, 100);
    const part = (value) => total ? `${Number(value || 0) / total * 100}%` : "0%";
    const isNew = record.scheme === "new";
    const definitions = isNew
      ? [["llm", "llm_or"], ["research", "research_other"], ["work", "admin_work"], ["sport-new", "sport"]]
      : [["morning", "morning"], ["afternoon", "afternoon"], ["evening", "evening"], ["sport", "sport"]];
    // 仅渲染非零时段，并给最顶 / 最底段加圆角，形成 iOS 胶囊柱
    const stack = definitions.filter(([, field]) => Number(record[field]) > 0);
    const segments = stack.map(([className, field], position) => {
      const capTop = position === stack.length - 1 ? " cap-top" : "";
      const capBottom = position === 0 ? " cap-bottom" : "";
      return `<i class="stack-segment ${className}${capTop}${capBottom}" style="height:${part(record[field])}"></i>`;
    }).join("");
    const summary = isNew
      ? `核心科研 ${formatTime(record.llm_or)} 小时，项目开发 ${formatTime(record.research_other)} 小时，其它事务 ${formatTime(record.admin_work)} 小时，运动兴趣 ${formatTime(record.sport)} 小时，合计 ${formatTime(total)} 小时`
      : `上午 ${formatTime(record.morning)} 小时，下午 ${formatTime(record.afternoon)} 小时，晚上 ${formatTime(record.evening)} 小时，运动 ${formatTime(record.sport)} 小时，合计 ${formatTime(total)} 小时`;
    const sleepClass = record.sleep_ok ? " sleep-ok" : "";
    return `<button class="stack-column ${total ? "has-hours" : "no-hours"}${sleepClass}" type="button" data-date="${record.study_date}" aria-pressed="false" aria-label="${record.study_date} ${record.weekday}，${summary}${record.sleep_ok ? "，睡眠达标" : ""}" style="height:${Math.max(totalHeight, total ? 1 : 0)}%"><span class="column-total">${total ? formatTime(total) : ""}</span>${segments}</button>`;
  }).join("");
  // 横坐标只在周一打点，标注「本月第几个周一」，方便按周对照
  let weekNo = 0;
  weekAxisStarts = [];
  $("#chartXAxis").innerHTML = payload.records.map((record, index) => {
    const [year, month, day] = record.study_date.split("-").map(Number);
    if (new Date(year, month - 1, day).getDay() !== 1) return `<span data-day="${index}"></span>`;
    weekNo += 1;
    weekAxisStarts.push(index);
    return `<span class="week-mark" data-day="${index}" title="${month} 月 ${day} 日 · 本月第 ${weekNo} 个周一">${weekNo}</span>`;
  }).join("");
  renderWeekTotals();
  renderAverageLine(scaleMax, average, payload.totals.active_days);
  const hasAnyRecord = payload.records.some((record) => Number(record.total) > 0 || hasSleepEntry(record));
  $("#chartEmpty").hidden = hasAnyRecord;
  document.querySelectorAll(".stack-column").forEach((column) => {
    column.addEventListener("click", () => selectQuickRecord(column.dataset.date));
    column.addEventListener("mouseenter", () => showChartTooltip(column.dataset.date, column));
    column.addEventListener("focus", () => showChartTooltip(column.dataset.date, column));
    column.addEventListener("blur", hideChartTooltip);
  });
}

function renderRhythm(payload) {
  const newRecords = payload.records.filter((record) => record.scheme === "new");
  const categories = [
    ["llm_or", "rhythmLlm", "rhythmLlmPct"],
    ["research_other", "rhythmResearch", "rhythmResearchPct"],
    ["admin_work", "rhythmWork", "rhythmWorkPct"],
    ["sport", "rhythmSport", "rhythmSportPct"],
  ];
  const totals = categories.map(([key]) => round2(newRecords.reduce((sum, record) => sum + (Number(record[key]) || 0), 0)));
  const grand = round2(totals.reduce((sum, value) => sum + value, 0));
  const percentages = totals.map((value) => grand > 0 ? Math.round(value / grand * 100) : 0);
  if (grand > 0) {
    const difference = 100 - percentages.reduce((sum, value) => sum + value, 0);
    if (difference !== 0) {
      let largestIndex = 0;
      percentages.forEach((value, index) => { if (value > percentages[largestIndex]) largestIndex = index; });
      percentages[largestIndex] += difference;
    }
  }
  categories.forEach(([, valueId, pctId], index) => {
    $(`#${valueId}`).textContent = `${formatTime(totals[index])}h`;
    $(`#${pctId}`).textContent = `（${percentages[index]}%）`;
  });

  // 四类卡片外框：达阈值绿色，否则红色；边界按“超过/低于”的严格条件判断
  const criteria = [
    percentages[0] > 35,   // 核心科研 超过 35%
    percentages[1] > 25,   // 项目开发 超过 25%
    percentages[2] < 30,   // 其它事务 低于 30%
    percentages[3] > 5,    // 运动兴趣 超过 5%
  ];
  ["llm", "research", "work", "sport-new"].forEach((key, index) => {
    const item = document.querySelector(`.rhythm-item.${key}`);
    if (!item) return;
    const passed = grand > 0 && criteria[index];
    item.classList.toggle("is-good", passed);
    item.classList.toggle("is-bad", grand > 0 && !passed);
  });

  const legacyTotal = round2(payload.records
    .filter((record) => record.scheme === "legacy")
    .reduce((sum, record) => sum + (Number(record.morning) || 0) + (Number(record.afternoon) || 0) + (Number(record.evening) || 0) + (Number(record.sport) || 0), 0));
  $("#rhythmNote").textContent = legacyTotal > 0
    ? `旧统计 ${formatTime(legacyTotal)}h 未计入四类`
    : "10/25 起新统计";

  // 11 月起按 iWatch 评分统计；此前月份仍按睡眠时间规则
  const useScoreStats = payload.month >= "2026-11";
  $("#sleepGradeWrap").title = useScoreStats
    ? "11/7 起按 iWatch 睡眠评分统计（>90 达标）；11/6 及以前的睡眠记录保留，但不计入本月评分。按有记录的天数计算：优 ≥2/3 达标；良 1/3–2/3；中 0–1/3；差 0 天达标"
    : "按睡眠时间规则：入睡不晚于 00:30 且总睡眠 ≥8h 达标。按有记录的天数计算：优 ≥2/3 达标；良 1/3–2/3；中 0–1/3；差 0 天达标";
  const sleepDays = payload.records.filter((record) => useScoreStats
    ? record.sleep_method === "score" && Number(record.sleep_score) > 0
    : record.sleep_method === "time" && record.sleep_time && record.wake_time);
  const okDays = sleepDays.filter((record) => record.sleep_ok === true);
  const ratio = sleepDays.length ? okDays.length / sleepDays.length : 0;
  let grade = "暂无";
  let gradeClass = "none";
  if (sleepDays.length > 0) {
    if (ratio >= 2 / 3 - 1e-9) {
      grade = "优";
      gradeClass = "excellent";
    } else if (ratio >= 1 / 3 - 1e-9) {
      grade = "良";
      gradeClass = "good";
    } else if (ratio > 0) {
      grade = "中";
      gradeClass = "medium";
    } else {
      grade = "差";
      gradeClass = "poor";
    }
  }
  const gradeWrap = $("#sleepGradeWrap");
  gradeWrap.classList.remove("excellent", "good", "medium", "poor", "none");
  gradeWrap.classList.add(gradeClass);
  $("#sleepGrade").textContent = grade;
  $("#sleepGradeDetail").textContent = sleepDays.length
    ? `${okDays.length}/${sleepDays.length} 天达标 · ${Math.round(ratio * 100)}%`
    : "暂无睡眠记录";
}

function renderMonth(payload) {
  renderStackChart(payload);
  $("#monthLabel").textContent = `${payload.year}.${String(payload.month_number).padStart(2, "0")}`;
  $("#totalHours").textContent = formatTime(payload.totals.total);
  $("#activeDays").textContent = payload.totals.active_days;
  $("#averageHours").textContent = formatHours(payload.totals.average);
  $("#maxDay").textContent = formatTime(payload.totals.max_day);
  renderRhythm(payload);
  $("#saveState").textContent = `已记录 ${payload.totals.active_days} 天 · 实时同步`;
  const selectedRecord = payload.records.find((item) => item.study_date === state.selectedDate)
    || payload.records.find((item) => item.editable)
    || payload.records[0];
  selectQuickRecord(selectedRecord.study_date);
}

async function saveQuickRecord(event) {
  event.preventDefault();
  const dateValue = $("#quickDate").value;
  if (!dateValue) return;
  const target = state.payload?.records.find((item) => item.study_date === dateValue);
  if (!target || !target.editable) return;
  const isNew = target.scheme === "new";
  const sleepBody = target.sleep_method === "score"
    ? { sleep_score: Math.round(Math.min(100, Math.max(0, Number($("#sleepScore").value) || 0))) }
    : {
        sleep_time: $("#sleepTime").value || "",
        wake_time: $("#wakeTime").value || "",
        nap_hours: normalizeNap($("#napHours").value),
      };
  const body = isNew
    ? {
        llm_or: normalizeTime($("#quickLlm").value),
        research_other: normalizeTime($("#quickResearch").value),
        admin_work: normalizeTime($("#quickWork").value),
        sport: normalizeTime($("#quickNewSport").value),
        ...sleepBody,
      }
    : {
        morning: normalizeTime($("#quickMorning").value),
        afternoon: normalizeTime($("#quickAfternoon").value),
        evening: normalizeTime($("#quickEvening").value),
        sport: normalizeTime($("#quickSport").value),
      };
  setQuickSaveState("正在保存…", false);
  try {
    const record = await api(`/api/records/${dateValue}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    Object.assign(target, record);
    state.selectedDate = dateValue;
    state.payload.totals = computeTotals(state.payload);
    renderMonth(state.payload);
    const savedAt = formatSavedAt(record.updated_at);
    setQuickSaveState(savedAt || `已保存 ${dateValue}`, true);
    showToast(`已保存 ${Number(dateValue.slice(5, 7))} 月 ${Number(dateValue.slice(-2))} 日的记录`);
  } catch (error) { setQuickSaveState(`保存失败：${error.message}`, false); }
}

async function loadMonth() {
  closeDatePicker(false);
  $("#saveState").textContent = `正在读取 ${state.month} 的记录…`;
  try {
    const month = await api(`/api/month?month=${state.month}`);
    state.payload = month;
    renderMonth(month);
  } catch (error) {
    $("#saveState").textContent = `加载失败：${error.message}`;
  }
}

$("#quickEditor").addEventListener("submit", saveQuickRecord);
["#quickMorning", "#quickAfternoon", "#quickEvening", "#quickSport", "#quickLlm", "#quickResearch", "#quickWork", "#quickNewSport"].forEach((selector) => {
  const input = $(selector);
  input.addEventListener("change", () => {
    input.value = formatTime(normalizeTime(input.value));
  });
});
$("#dateTrigger").addEventListener("click", () => {
  if ($("#datePicker").hidden) openDatePicker();
  else closeDatePicker();
});
const legendHelp = $("#legendLegacyHelp");
legendHelp.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = legendHelp.classList.toggle("show-tip");
  legendHelp.setAttribute("aria-expanded", open ? "true" : "false");
});
document.addEventListener("click", () => {
  legendHelp.classList.remove("show-tip");
  legendHelp.setAttribute("aria-expanded", "false");
});
$("#sleepToggle").addEventListener("click", () => {
  const panel = $("#sleepPanel");
  const open = panel.hidden;
  panel.hidden = !open;
  $("#sleepToggle").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) requestAnimationFrame(() => panel.scrollIntoView({ behavior: "smooth", block: "nearest" }));
});
$("#timeHourGrid").innerHTML = Array.from({ length: 24 }, (_, hour) => {
  const value = String(hour).padStart(2, "0");
  return `<button class="time-choice" type="button" data-hour="${value}" aria-pressed="false">${value}</button>`;
}).join("");
$("#timeMinuteGrid").innerHTML = TIME_MINUTE_OPTIONS.map((minute) => `<button class="time-choice" type="button" data-minute="${minute}" aria-pressed="false">${minute}</button>`).join("");
$("#sleepTimeTrigger").addEventListener("click", () => openTimePicker("sleep"));
$("#wakeTimeTrigger").addEventListener("click", () => openTimePicker("wake"));
$("#timePickerClose").addEventListener("click", () => closeTimePicker());
$("#timePickerDone").addEventListener("click", () => closeTimePicker());
$("#timePickerBackdrop").addEventListener("click", () => closeTimePicker());
$("#timeHourGrid").addEventListener("click", (event) => {
  const button = event.target.closest(".time-choice");
  if (button) setPickerTime(button.dataset.hour, pickerMinute);
});
$("#timeMinuteGrid").addEventListener("click", (event) => {
  const button = event.target.closest(".time-choice");
  if (button) setPickerTime(pickerHour, button.dataset.minute);
});
$("#napHours").addEventListener("input", updateSleepState);
$("#napHours").addEventListener("change", () => {
  $("#napHours").value = formatTime(normalizeNap($("#napHours").value));
  updateSleepState();
});
$("#sleepScore").addEventListener("input", updateSleepState);
$("#sleepScore").addEventListener("change", () => {
  const value = Math.min(100, Math.max(0, Math.round(Number($("#sleepScore").value) || 0)));
  $("#sleepScore").value = String(value);
  updateSleepState();
});
$("#datePickerBackdrop").addEventListener("click", () => closeDatePicker());
$("#datePickerPrev").addEventListener("click", () => shiftPickerMonth(-1));
$("#datePickerNext").addEventListener("click", () => shiftPickerMonth(1));
$("#datePickerToday").addEventListener("click", pickToday);
$("#datePickerGrid").addEventListener("click", (event) => {
  const cell = event.target.closest(".date-cell");
  if (cell) pickDate(cell.dataset.date);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#timePicker").hidden) { closeTimePicker(); return; }
  if (!$("#datePicker").hidden) closeDatePicker();
});
window.addEventListener("resize", () => {
  if (!$("#datePicker").hidden) positionDatePicker();
  renderWeekTotals();
});
window.addEventListener("scroll", () => {
  if (!$("#datePicker").hidden) positionDatePicker();
}, { passive: true });
$("#stackChart").addEventListener("mouseleave", hideChartTooltip);
$("#monthPicker").value = state.month;
$("#prevMonth").addEventListener("click", () => shiftMonth(-1));
$("#nextMonth").addEventListener("click", () => shiftMonth(1));
$("#monthPicker").addEventListener("change", (event) => { state.month = event.target.value; loadMonth(); });
loadMonth();
