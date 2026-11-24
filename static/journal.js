"use strict";
const el = (id) => document.getElementById(id);
const calendar = el("day");
const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date(Date.now() - 2 * 60 * 60 * 1000));
const dateLabel = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "UTC", year: "numeric", month: "long", day: "numeric", weekday: "long"
});

function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < calendar.min || day > calendar.max) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(day);
}

async function readJson(url, optional = false) {
  const response = await fetch(url, { cache: "no-store" });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

function metric(label, value, detail = "") {
  const group = document.createElement("div");
  const title = document.createElement("dt");
  title.textContent = label;
  const number = document.createElement("dd");
  number.textContent = value;
  if (detail) {
    const note = document.createElement("small");
    note.textContent = detail;
    number.append(note);
  }
  group.append(title, number);
  return group;
}

function renderStudy(result, day) {
  const record = result.value?.records.find((item) => item.study_date === day);
  if (!record?.updated_at) {
    const status = result.status === "rejected" ? "读取失败" : "未记录";
    el("metrics").replaceChildren(...["学习", "运动", "睡眠"].map(label => metric(label, status)));
    return `当天学习、运动和睡眠${status}。`;
  }
  const detail = record.scheme === "new"
    ? `核心科研 ${record.llm_or} · 项目开发 ${record.research_other} · 其它事务 ${record.admin_work}`
    : `早 ${record.morning} · 午 ${record.afternoon} · 晚 ${record.evening}`;
  const byScore = record.sleep_method === "score";
  const sleep = byScore
    ? (record.sleep_score > 0 ? `${record.sleep_score} 分` : "未记录")
    : (record.sleep_time && record.wake_time ? `${record.sleep_total} 小时` : "未记录");
  const sleepLabel = byScore ? "睡眠评分" : "睡眠时长";
  el("metrics").replaceChildren(
    metric("学习合计", `${record.study_total} 小时`, detail),
    metric("运动兴趣", `${record.sport} 小时`),
    metric(sleepLabel, sleep, byScore ? "iWatch" : "")
  );
  return `学习${record.study_total}小时，运动${record.sport}小时，${sleepLabel}${sleep.replace(" ", "")}。`;
}

function highlightTerms(element, text, highlights = {}) {
  const kinds = new Map();
  for (const kind of ["科研", "项目开发"]) {
    for (const term of highlights[kind] || []) {
      if (typeof term === "string" && term.trim()) kinds.set(term, kind);
    }
  }
  element.textContent = text;
  if (!kinds.size) return;

  const alternatives = [...kinds.keys()].sort((a, b) => b.length - a.length).map(term => {
    const literal = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const left = /^[a-z0-9]/i.test(term) ? "(?<![a-zA-Z0-9_])" : "";
    const right = /[a-z0-9]$/i.test(term) ? "(?![a-zA-Z0-9_])" : "";
    return left + literal + right;
  });
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const match of text.matchAll(new RegExp(alternatives.join("|"), "g"))) {
    fragment.append(text.slice(cursor, match.index));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    mark.dataset.kind = kinds.get(match[0]);
    fragment.append(mark);
    cursor = match.index + match[0].length;
  }
  fragment.append(text.slice(cursor));
  element.replaceChildren(fragment);
}

function card(project) {
  const fragment = el("projectCard").content.cloneNode(true);
  fragment.querySelector("article").dataset.kind = project.category;
  fragment.querySelector(".category").textContent = project.category;
  fragment.querySelector(".source").textContent = project.sources.join(" · ");
  fragment.querySelector("h3").textContent = project.name;
  fragment.querySelector(".folder").textContent = project.folder;
  const list = fragment.querySelector("ul");
  for (const [title, body] of project.tasks) {
    const li = document.createElement("li");
    const label = document.createElement("strong");
    const text = document.createElement("p");
    highlightTerms(label, title, project.highlights);
    highlightTerms(text, body, project.highlights);
    li.append(label, text);
    list.append(li);
  }
  return fragment;
}

function summary(work, study) {
  const available = 100 - Array.from(study).length;
  const chars = Array.from(work);
  return (chars.length <= available ? work : chars.slice(0, available - 1).join("") + "…") + study;
}

let renderId = 0;
async function render() {
  const id = ++renderId;
  const param = new URLSearchParams(location.search).get("date");
  const day = validDay(param) ? param : today;
  calendar.value = day;
  el("dateLabel").textContent = dateLabel.format(new Date(`${day}T00:00:00Z`));
  el("dateLabel").dateTime = day;
  el("previous").disabled = day === calendar.min;
  el("next").disabled = day === calendar.max;
  const back = el("back");
  if (back) back.href = `/journal?date=${day}`;
  el("summary").textContent = "正在读取日志…";
  for (const name of ["cutoff", "metrics", "projectCount", "projects", "coverage"]) el(name).replaceChildren();
  const [journal, month] = await Promise.allSettled([
    readJson(`/static/journals/${day}.json`, true),
    readJson(`/api/month?month=${day.slice(0, 7)}`)
  ]);
  if (id !== renderId) return;
  const study = renderStudy(month, day);
  const entry = journal.value;
  if (!entry) {
    const status = journal.status === "rejected" ? "日志读取失败，请刷新重试。" : "当天尚未整理工作日志。";
    el("summary").textContent = status + study;
    el("projects").textContent = journal.status === "rejected" ? "无法读取项目进展" : "尚无项目卡片";
    return;
  }
  highlightTerms(el("summary"), summary(entry.workSummary, study), entry.summaryHighlights);
  const endDay = entry.until <= "02:00" ? "次日 " : "";
  el("cutoff").textContent = `02:00 至 ${endDay}${entry.until} · 上海时间`;
  el("projectCount").textContent = `${entry.projects.length} 个项目`;
  el("projects").replaceChildren(...entry.projects.map(card));
  el("coverage").textContent = entry.coverage;
}

function navigate(day) {
  if (!validDay(day)) { render(); return; }
  history.pushState(null, "", `?date=${day}`);
  render();
}
function shift(offset) {
  const date = new Date(`${calendar.value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  navigate(date.toISOString().slice(0, 10));
}
calendar.addEventListener("change", () => navigate(calendar.value));
el("previous").addEventListener("click", () => shift(-1));
el("next").addEventListener("click", () => shift(1));
window.addEventListener("popstate", render);
render();
