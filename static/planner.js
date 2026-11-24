"use strict";

const $ = (id) => document.getElementById(id);
const CATEGORY_ORDER = ["research", "dev", "admin", "memo"];

const state = {
  data: null,
  open: new Set(),
  batch: false,
  selected: new Set(),
  project: null,      // 正在编辑的项目；null = 新建
  projectCategory: "research",
  deadlines: [],
  task: null,         // 正在编辑的任务；null = 新建
  taskProject: null,
  scrollTops: {},
};

/* ---------- 工具 ---------- */

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function pad(value) { return String(value).padStart(2, "0"); }

function todayIso() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso) {
  if (!iso) return "";
  const [, month, day] = iso.split("-").map(Number);
  return `${month}月${day}日`;
}

function diffDays(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
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

function catOf(id) {
  return state.data.categories.find((item) => item.id === id) || state.data.categories[0];
}

/* ---------- 读取与渲染 ---------- */

async function load() {
  try {
    const data = await api("/api/plans");
    state.data = data;
    renderBoard();
    renderTrash();
  } catch (error) {
    $("board").replaceChildren(node("div", "plan-loading", `读取失败：${error.message}`));
  }
}

async function refresh() {
  await load();
}

function renderBoard() {
  const board = $("board");
  for (const col of board.querySelectorAll(".col-body")) {
    state.scrollTops[col.dataset.cat] = col.scrollTop;
  }
  board.replaceChildren();
  for (const categoryId of CATEGORY_ORDER) {
    const category = catOf(categoryId);
    const projects = state.data.projects.filter((project) => project.category === categoryId);
    const col = node("section", "plan-col");
    col.dataset.cat = categoryId;

    const head = node("header", "col-head");
    head.append(node("i", "col-dot"));
    head.append(node("h2", "", category.name));
    head.append(node("span", "col-count", String(projects.length)));
    const add = node("button", "col-add", "＋");
    add.type = "button";
    add.title = `在${category.name}下新建项目`;
    add.addEventListener("click", () => openProject(null, categoryId));
    head.append(add);
    col.append(head);

    const body = node("div", "col-body");
    body.dataset.cat = categoryId;
    if (!projects.length) body.append(node("p", "col-empty", "还没有项目"));
    for (const project of projects) body.append(projectCard(project, category));
    col.append(body);
    board.append(col);
  }
  for (const col of board.querySelectorAll(".col-body")) {
    const top = state.scrollTops[col.dataset.cat];
    if (top) col.scrollTop = top;
  }
}

function projectCard(project, category) {
  const open = state.open.has(project.id);
  const card = node("article", "proj" + (project.pinned ? " is-pinned" : "") + (open ? " is-open" : ""));
  card.dataset.id = project.id;

  const head = node("div", "proj-head");

  const toggle = node("button", "proj-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-label", open ? "收起任务" : "展开任务");
  toggle.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 8 6l-4 3.5"/></svg>';
  toggle.addEventListener("click", () => {
    if (open) state.open.delete(project.id);
    else state.open.add(project.id);
    renderBoard();
  });

  const main = node("div", "proj-main");
  const title = node("button", "proj-title", project.title);
  title.type = "button";
  title.addEventListener("click", () => openProject(project));
  main.append(title);

  const meta = node("div", "proj-meta");
  meta.append(node("span", "", project.period_days ? `周期 ${project.period_days} 天` : "无周期"));
  meta.append(node("span", "", `${fmtDate(project.start_date)}起`));
  meta.append(node("span", "", `${project.done_count}/${project.task_count} 完成`));
  main.append(meta);

  const dueRow = node("div", "proj-due");
  if (project.deadlines && project.deadlines.length) {
    for (const due of project.deadlines) {
      const chip = node("span", "due-chip");
      chip.append(node("i", "due-mark", "!"));
      chip.append(node("span", "", fmtDate(due)));
      dueRow.append(chip);
    }
  } else {
    dueRow.append(node("span", "due-empty", "无截止日期"));
  }
  main.append(dueRow);

  const actions = node("div", "proj-actions");
  const pin = node("button", "icon-btn" + (project.pinned ? " is-on" : ""));
  pin.type = "button";
  pin.title = project.pinned ? "取消置顶" : "置顶";
  pin.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 2.2h4.6l-1 4.4 2.2 2.4v1.6H8v3.2L7 15l-1-1.2v-3.2H3v-1.6L5.2 6.6l-1-4.4Z"/></svg>';
  pin.addEventListener("click", () => patchProject(project.id, { pinned: !project.pinned }));
  const archive = node("button", "icon-btn");
  archive.type = "button";
  archive.title = "归档到回收站";
  archive.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5h11v8.2h-11z"/><path d="M1.8 3h12.4v2.5H1.8z"/><path d="M6 8.6h4"/></svg>';
  archive.addEventListener("click", () => archiveProject(project));
  actions.append(pin, archive);

  head.append(toggle, main, actions);
  card.append(head);

  const list = node("div", "task-list");
  list.hidden = !open;
  if (open) {
    if (!project.tasks.length) list.append(node("p", "task-empty", "还没有任务"));
    for (const task of project.tasks) list.append(taskRow(project, task));
    const addTask = node("button", "task-add", "＋ 添加任务");
    addTask.type = "button";
    addTask.addEventListener("click", () => openTask(project, null));
    list.append(addTask);
  }
  card.append(list);
  return card;
}

function taskRow(project, task) {
  const row = node("div", "task" + (task.done ? " is-done" : ""));

  if (state.batch) {
    const select = node("button", "task-batch" + (state.selected.has(task.id) ? " is-on" : ""));
    select.type = "button";
    select.setAttribute("aria-label", "选择任务");
    select.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSelect(task.id);
    });
    row.append(select);
  }

  const circle = node("button", "task-circle");
  circle.type = "button";
  circle.setAttribute("aria-label", task.done ? "标记未完成" : "标记完成");
  circle.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.4 5.8 10 11 4.6"/></svg>';
  circle.addEventListener("click", (event) => {
    event.stopPropagation();
    patchTask(task.id, { done: !task.done });
  });

  const main = node("div", "task-main");
  const title = node("button", "task-title", task.title);
  title.type = "button";
  title.addEventListener("click", () => {
    if (state.batch) toggleSelect(task.id);
    else openTask(project, task);
  });
  main.append(title);
  main.append(node("span", "task-due", task.due_date ? `时限 ${fmtDate(task.due_date)}` : "无时限"));

  const actions = node("div", "task-actions");
  const pin = node("button", "icon-btn" + (task.pinned ? " is-on" : ""));
  pin.type = "button";
  pin.title = task.pinned ? "取消置顶" : "置顶";
  pin.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 2.2h4.6l-1 4.4 2.2 2.4v1.6H8v3.2L7 15l-1-1.2v-3.2H3v-1.6L5.2 6.6l-1-4.4Z"/></svg>';
  pin.addEventListener("click", (event) => {
    event.stopPropagation();
    patchTask(task.id, { pinned: !task.pinned });
  });
  const del = node("button", "icon-btn", "×");
  del.type = "button";
  del.title = "删除任务";
  del.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteTask(task);
  });
  actions.append(pin, del);

  row.append(circle, main, actions);
  return row;
}

/* ---------- 数据操作 ---------- */

async function patchProject(id, body) {
  try {
    await api(`/api/plans/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    await refresh();
  } catch (error) {
    toast(`更新失败：${error.message}`);
  }
}

async function patchTask(id, body) {
  try {
    await api(`/api/plans/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    await refresh();
  } catch (error) {
    toast(`更新失败：${error.message}`);
  }
}

async function archiveProject(project) {
  if (!window.confirm(`归档「${project.title}」？${project.task_count} 个任务一起进回收站。`)) return;
  try {
    await api(`/api/plans/projects/${project.id}/archive`, { method: "POST", body: "{}" });
    state.open.delete(project.id);
    await refresh();
    toast("已归档到回收站");
  } catch (error) {
    toast(`归档失败：${error.message}`);
  }
}

async function deleteTask(task) {
  if (!window.confirm(`删除任务「${task.title}」？删除后不会进回收站。`)) return;
  try {
    await api(`/api/plans/tasks/${task.id}`, { method: "DELETE" });
    state.selected.delete(task.id);
    await refresh();
    updateBatchBar();
    toast("任务已删除");
  } catch (error) {
    toast(`删除失败：${error.message}`);
  }
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderBoard();
  updateBatchBar();
}

function updateBatchBar() {
  $("batchBar").hidden = !state.batch;
  $("batchCount").textContent = `已选 ${state.selected.size} 项`;
  $("batchBtn").classList.toggle("is-active", state.batch);
}

/* ---------- 项目弹层 ---------- */

function openProject(project, categoryId) {
  state.project = project;
  state.projectCategory = project ? project.category : (categoryId || state.projectCategory);
  state.deadlines = project ? (project.deadlines || []).slice() : [];
  $("projectSheetTitle").textContent = project ? "编辑项目" : "新建项目";
  $("projectName").value = project ? project.title : "";
  $("projectStart").value = project ? project.start_date : todayIso();

  const seg = $("projectCategory");
  seg.replaceChildren();
  for (const category of state.data.categories) {
    const button = node("button", "", category.name);
    button.type = "button";
    button.style.setProperty("--cat", category.color);
    button.classList.toggle("active", category.id === state.projectCategory);
    button.addEventListener("click", () => {
      state.projectCategory = category.id;
      seg.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    });
    seg.append(button);
  }

  const days = project ? project.period_days : 30;
  setPeriod(days);
  renderDeadlines();
  showSheet("projectSheet");
  $("projectName").focus();
}

function setPeriod(days) {
  const select = $("projectPeriod");
  const known = ["0", "7", "14", "30", "90"];
  if (known.includes(String(days))) {
    select.value = String(days);
    $("projectDaysField").hidden = true;
  } else {
    select.value = "custom";
    $("projectDaysField").hidden = false;
    $("projectDays").value = String(days || 30);
  }
}

function currentPeriodDays() {
  const select = $("projectPeriod");
  if (select.value === "custom") {
    const value = Number($("projectDays").value);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }
  return Number(select.value);
}

function renderDeadlines() {
  const list = $("deadlineList");
  list.replaceChildren();
  if (!state.deadlines.length) {
    list.append(node("p", "deadline-empty", "还没有截止日期，需要时再加。"));
    return;
  }
  state.deadlines.forEach((date, index) => {
    const row = node("div", "deadline-row");
    row.append(node("i", "deadline-mark", "!"));
    const input = document.createElement("input");
    input.type = "date";
    input.value = date;
    input.setAttribute("aria-label", `第 ${index + 1} 个截止日期`);
    input.addEventListener("change", () => {
      state.deadlines[index] = input.value;
    });
    const remove = node("button", "deadline-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "删除这个截止日期");
    remove.addEventListener("click", () => {
      state.deadlines.splice(index, 1);
      renderDeadlines();
    });
    row.append(input, remove);
    list.append(row);
  });
}

async function saveProject() {
  const title = $("projectName").value.trim();
  if (!title) {
    toast("先写项目名");
    return;
  }
  const days = currentPeriodDays();
  const body = {
    title,
    category: state.projectCategory,
    period_days: days,
    start_date: $("projectStart").value || todayIso(),
    deadlines: [...new Set(state.deadlines.filter(Boolean))].sort(),
  };
  $("projectSave").disabled = true;
  try {
    if (state.project) {
      await api(`/api/plans/projects/${state.project.id}`, { method: "PATCH", body: JSON.stringify(body) });
    } else {
      const created = await api("/api/plans/projects", { method: "POST", body: JSON.stringify(body) });
      state.open.add(created.id);
    }
    closeSheets();
    await refresh();
    toast(state.project ? "项目已更新" : "项目已创建");
  } catch (error) {
    toast(`没保存：${error.message}`);
  } finally {
    $("projectSave").disabled = false;
  }
}

/* ---------- 任务弹层 ---------- */

function openTask(project, task) {
  state.task = task;
  state.taskProject = project;
  $("taskSheetTitle").textContent = task ? "编辑任务" : "新建任务";
  $("taskName").value = task ? task.title : "";
  let days = 0;
  const base = project.start_date || project.created_date;
  if (task && task.due_date) days = Math.max(0, diffDays(base, task.due_date));
  setTaskLimit(days);
  updateTaskDue();
  showSheet("taskSheet");
  $("taskName").focus();
}

function setTaskLimit(days) {
  const select = $("taskLimit");
  const known = ["0", "3", "7", "14", "30"];
  if (known.includes(String(days))) {
    select.value = String(days);
    $("taskDaysField").hidden = true;
  } else {
    select.value = "custom";
    $("taskDaysField").hidden = false;
    $("taskDays").value = String(days || 7);
  }
}

function currentLimitDays() {
  const select = $("taskLimit");
  if (select.value === "custom") {
    const value = Number($("taskDays").value);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }
  return Number(select.value);
}

function updateTaskDue() {
  const days = currentLimitDays();
  const base = state.taskProject ? (state.taskProject.start_date || state.taskProject.created_date) : todayIso();
  $("taskDuePreview").textContent = days > 0 ? fmtDate(addDays(base, days)) : "无";
}

async function saveTask() {
  const title = $("taskName").value.trim();
  if (!title) {
    toast("先写任务名");
    return;
  }
  const days = currentLimitDays();
  $("taskSave").disabled = true;
  try {
    if (state.task) {
      await api(`/api/plans/tasks/${state.task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title, limit_days: days }),
      });
    } else {
      await api("/api/plans/tasks", {
        method: "POST",
        body: JSON.stringify({ project_id: state.taskProject.id, title, limit_days: days }),
      });
    }
    closeSheets();
    await refresh();
    toast(state.task ? "任务已更新" : "任务已添加");
  } catch (error) {
    toast(`没保存：${error.message}`);
  } finally {
    $("taskSave").disabled = false;
  }
}

/* ---------- 回收站 ---------- */

function renderTrash() {
  const list = $("trashList");
  list.replaceChildren();
  const archived = state.data.archived || [];
  if (!archived.length) {
    list.append(node("p", "col-empty", "回收站是空的"));
    return;
  }
  for (const project of archived) {
    const category = catOf(project.category);
    const item = node("div", "trash-item");
    const top = node("div", "trash-item-top");
    const dot = node("i", "trash-dot");
    dot.style.setProperty("--cat", category.color);
    top.append(dot);
    top.append(node("strong", "", project.title));
    item.append(top);
    item.append(node("div", "trash-meta", `${category.name} · ${project.task_count} 个任务 · ${(project.archived_at || "").slice(0, 10)} 归档`));
    const actions = node("div", "trash-actions");
    const restore = node("button", "", "恢复");
    restore.type = "button";
    restore.addEventListener("click", async () => {
      try {
        await api(`/api/plans/projects/${project.id}/restore`, { method: "POST", body: "{}" });
        await refresh();
        toast("项目已恢复");
      } catch (error) {
        toast(`恢复失败：${error.message}`);
      }
    });
    const remove = node("button", "danger", "永久删除");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`永久删除「${project.title}」及其 ${project.task_count} 个任务？不可恢复。`)) return;
      try {
        await api(`/api/plans/projects/${project.id}`, { method: "DELETE" });
        await refresh();
        toast("已永久删除");
      } catch (error) {
        toast(`删除失败：${error.message}`);
      }
    });
    actions.append(restore, remove);
    item.append(actions);
    list.append(item);
  }
}

/* ---------- 弹层控制 ---------- */

function showSheet(id) {
  $("sheetBackdrop").hidden = false;
  $(id).hidden = false;
}

function closeSheets() {
  $("sheetBackdrop").hidden = true;
  $("projectSheet").hidden = true;
  $("taskSheet").hidden = true;
}

function openTrash() {
  $("trashDrawer").hidden = false;
  $("drawerBackdrop").hidden = false;
}

function closeTrash() {
  $("trashDrawer").hidden = true;
  $("drawerBackdrop").hidden = true;
}

/* ---------- 事件 ---------- */

$("newProjectBtn").addEventListener("click", () => openProject(null, "research"));
$("batchBtn").addEventListener("click", () => {
  state.batch = !state.batch;
  if (!state.batch) state.selected.clear();
  renderBoard();
  updateBatchBar();
});
$("batchCancel").addEventListener("click", () => {
  state.batch = false;
  state.selected.clear();
  renderBoard();
  updateBatchBar();
});
$("batchDelete").addEventListener("click", async () => {
  const ids = [...state.selected];
  if (!ids.length) {
    toast("先选中任务");
    return;
  }
  if (!window.confirm(`删除选中的 ${ids.length} 个任务？删除后不恢复。`)) return;
  try {
    const result = await api("/api/plans/tasks/batch-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    state.selected.clear();
    await refresh();
    updateBatchBar();
    toast(`已删除 ${result.deleted} 个任务`);
  } catch (error) {
    toast(`删除失败：${error.message}`);
  }
});
$("trashBtn").addEventListener("click", openTrash);
$("trashClose").addEventListener("click", closeTrash);
$("drawerBackdrop").addEventListener("click", closeTrash);

$("projectClose").addEventListener("click", closeSheets);
$("projectCancel").addEventListener("click", closeSheets);
$("projectSave").addEventListener("click", saveProject);
$("taskClose").addEventListener("click", closeSheets);
$("taskCancel").addEventListener("click", closeSheets);
$("taskSave").addEventListener("click", saveTask);
$("sheetBackdrop").addEventListener("click", closeSheets);

$("projectPeriod").addEventListener("change", () => {
  $("projectDaysField").hidden = $("projectPeriod").value !== "custom";
});

$("deadlineAdd").addEventListener("click", () => {
  const base = $("projectStart").value || todayIso();
  const last = state.deadlines.length ? state.deadlines[state.deadlines.length - 1] : base;
  state.deadlines.push(addDays(last, state.deadlines.length ? 7 : 30));
  renderDeadlines();
});

$("taskLimit").addEventListener("change", () => {
  $("taskDaysField").hidden = $("taskLimit").value !== "custom";
  updateTaskDue();
});
$("taskDays").addEventListener("input", updateTaskDue);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("projectSheet").hidden || !$("taskSheet").hidden) closeSheets();
  else if (!$("trashDrawer").hidden) closeTrash();
});

load().then(updateBatchBar);
