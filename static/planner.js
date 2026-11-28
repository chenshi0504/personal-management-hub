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
  milestones: [],     // 阶段性目标：{title, date}
  task: null,         // 正在编辑的任务；null = 新建
  taskProject: null,
  repeatWeekday: -1,
  openTasks: new Set(),   // 展开了事项的任务
  item: null,             // 正在编辑的事项
  itemTask: null,
  itemImportant: false,
  dragId: null,
  dragCategory: "",
  dragEndAt: 0,
  urgentOnly: false,
  openBackup: null,
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
    renderUrgentButton();
    renderDueStrip();
    return true;
  } catch (error) {
    $("board").replaceChildren(node("div", "plan-loading", `读取失败：${error.message}`));
    return false;
  }
}

async function refresh() {
  return load();
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
    // 备忘录只放任务，不建项目
    const standalone = categoryId === "memo" ? (state.data.standalone_tasks || []) : [];
    const count = categoryId === "memo" ? standalone.length + projects.length : projects.length;
    const col = node("section", "plan-col");
    col.dataset.cat = categoryId;

    const head = node("header", "col-head");
    head.append(node("i", "col-dot"));
    head.append(node("h2", "", category.name));
    head.append(node("span", "col-count", String(count)));
    const add = node("button", "col-add", "＋");
    add.type = "button";
    add.title = categoryId === "memo" ? "在备忘录新建任务" : `在${category.name}下新建项目`;
    add.addEventListener("click", () => {
      if (categoryId === "memo") openTask(null, null);
      else openProject(null, categoryId);
    });
    head.append(add);
    col.append(head);

    const body = node("div", "col-body");
    body.dataset.cat = categoryId;
    body.addEventListener("dragover", (event) => onColumnDragOver(event, body, categoryId));
    body.addEventListener("dragleave", (event) => {
      if (!body.contains(event.relatedTarget)) clearDropMarks(body);
    });
    body.addEventListener("drop", (event) => onColumnDrop(event, body, categoryId));
    if (categoryId === "memo") {
      body.append(memoList(standalone));
      for (const project of projects) body.append(projectCard(project, category));
    } else {
      if (!projects.length) body.append(node("p", "col-empty", "还没有项目"));
      for (const project of projects) body.append(projectCard(project, category));
    }
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
  card.draggable = true;
  card.addEventListener("dragstart", (event) => {
    if (state.batch) {
      event.preventDefault();
      return;
    }
    state.dragId = project.id;
    state.dragCategory = project.category;
    card.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(project.id));
  });
  card.addEventListener("dragend", () => {
    state.dragId = null;
    state.dragEndAt = Date.now();
    card.classList.remove("is-dragging");
    clearDropMarks(document);
  });

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
  title.addEventListener("click", () => {
    if (Date.now() - state.dragEndAt < 220) return;
    openProject(project);
  });
  main.append(title);

  const meta = node("div", "proj-meta");
  meta.append(node(
    "span",
    "",
    project.start_date ? `${fmtDate(project.start_date)}起` : `${fmtDate(project.created_date)}创建`,
  ));
  meta.append(node(
    "span",
    project.end_date ? "is-due" : "",
    project.end_date ? `止 ${fmtDate(project.end_date)}` : "无结束日期",
  ));
  meta.append(node("span", "", `${project.done_count}/${project.task_count} 完成`));
  main.append(meta);

  // 进度：每个任务一票，任务内按事项完成比例
  const progress = project.progress || 0;
  const progressRow = node("div", "proj-progress");
  const track = node("div", "progress-track");
  const fill = node("i", progress >= 100 ? "is-full" : "");
  fill.style.width = `${progress}%`;
  track.append(fill);
  progressRow.append(track, node("span", "progress-num", `${progress}%`));
  progressRow.title = `按任务与其事项的完成比例计算：${progress}%`;
  main.append(progressRow);

  const dueRow = node("div", "proj-due");
  const milestones = project.milestones || [];
  if (milestones.length) {
    for (const milestone of milestones) {
      const chip = node("span", "due-chip");
      chip.title = `${fmtDate(milestone.date)} ${milestone.title || "未写内容"}`;
      chip.append(node("i", "due-mark", "!"));
      chip.append(node("span", "due-date", fmtDate(milestone.date)));
      chip.append(node(
        "span",
        "due-text" + (milestone.title ? "" : " is-empty"),
        milestone.title || "未写内容",
      ));
      dueRow.append(chip);
    }
  } else {
    dueRow.append(node("span", "due-empty", "还没有阶段性目标"));
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
  // 收起时只留点着灯泡的任务，这些不允许被收起来
  const visibleTasks = open ? project.tasks : project.tasks.filter((task) => task.active);
  list.hidden = !visibleTasks.length;
  if (!open && visibleTasks.length) list.classList.add("is-pinned-list");
  if (visibleTasks.length) {
    if (open && !project.tasks.length) list.append(node("p", "task-empty", "还没有任务"));
    for (const task of visibleTasks) list.append(taskRow(project, task));
    if (open) {
      const addTask = node("button", "task-add", "＋ 添加任务");
      addTask.type = "button";
      addTask.addEventListener("click", () => openTask(project, null));
      list.append(addTask);
    }
  }
  card.append(list);
  return card;
}

/* 备忘录：只有任务，直接平铺，不包在项目里 */
function memoList(tasks) {
  const list = node("div", "memo-list");
  if (!tasks.length) list.append(node("p", "col-empty", "备忘录还没有任务，点右上角「＋」"));
  for (const task of tasks) {
    const card = node("div", "memo-card");
    card.append(taskRow(null, task));
    list.append(card);
  }
  const add = node("button", "task-add memo-add", "＋ 添加任务");
  add.type = "button";
  add.addEventListener("click", () => openTask(null, null));
  list.append(add);
  return list;
}

// 当前点亮了几个任务（项目内 + 备忘录，合计最多 5 个）
function activeTaskCount() {
  const projects = state.data?.projects || [];
  const standalone = state.data?.standalone_tasks || [];
  let count = 0;
  for (const project of projects) {
    count += project.tasks.filter((item) => item.active).length;
  }
  return count + standalone.filter((item) => item.active).length;
}

function taskRow(project, task) {
  const openItems = state.openTasks.has(task.id);
  const block = node("div", "task-block");
  const row = node("div", "task" + (task.done ? " is-done" : "") + (task.active ? " is-active" : ""));

  const caret = node("button", "task-caret" + (openItems ? " is-open" : ""));
  caret.type = "button";
  caret.setAttribute("aria-label", openItems ? "收起事项" : "展开事项");
  caret.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 8 6l-4 3.5"/></svg>';
  caret.addEventListener("click", (event) => {
    event.stopPropagation();
    if (openItems) state.openTasks.delete(task.id);
    else state.openTasks.add(task.id);
    renderBoard();
  });
  row.append(caret);

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
  const dueLine = node("span", "task-due");
  if (task.repeat_label) {
    const repeat = node("span", "task-repeat");
    const icon = node("i", "task-repeat-icon");
    icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6.6A5 5 0 0 1 12.4 5"/><path d="M12.6 2.4v3h-3"/><path d="M13 9.4A5 5 0 0 1 3.6 11"/><path d="M3.4 13.6v-3h3"/></svg>';
    repeat.append(icon, node("span", "", `每${task.repeat_label}`));
    repeat.title = `每${task.repeat_label}重复`;
    dueLine.append(repeat);
  }
  if (task.due_date) {
    dueLine.append(node("span", "is-due", `结束 ${fmtDate(task.due_date)}`));
  } else if (!task.repeat_label) {
    dueLine.append(node("span", "", "无结束日期"));
  }
  if (task.item_count) {
    dueLine.append(node("span", "", ` · 事项 ${task.item_done}/${task.item_count}`));
  }
  main.append(dueLine);

  const actions = node("div", "task-actions");
  const lamp = node("button", "icon-btn is-lamp" + (task.active ? " is-on" : ""));
  lamp.type = "button";
  lamp.title = task.active ? "正在做，取消后可以收起" : "标记为正在做";
  lamp.setAttribute("aria-label", lamp.title);
  lamp.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.3a4.1 4.1 0 0 0-2.4 7.5c.4.3.6.7.6 1.1v.5h3.6v-.5c0-.4.2-.8.6-1.1A4.1 4.1 0 0 0 8 2.3Z"/><path d="M6.6 13.3h2.8"/></svg>';
  lamp.addEventListener("click", (event) => {
    event.stopPropagation();
    // 同一时间最多点亮 5 个，超出就不让点
    if (!task.active && activeTaskCount() >= 5) {
      toast("最多同时点亮 5 个任务，先取消一个");
      return;
    }
    patchTask(task.id, { active: !task.active });
  });
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
  actions.append(lamp, pin, del);

  row.append(circle, main, actions);
  block.append(row);
  if (openItems) block.append(itemList(task));
  return block;
}

/* ---------- 事项 ---------- */

function itemList(task) {
  const list = node("div", "item-list");
  if (!task.items.length) list.append(node("p", "item-empty", "还没有事项"));
  for (const item of task.items) list.append(itemRow(task, item));
  const add = node("button", "item-add", "＋ 添加事项");
  add.type = "button";
  add.addEventListener("click", () => openItem(task, null));
  list.append(add);
  return list;
}

function itemRow(task, item) {
  const row = node("div", "item" + (item.important ? " is-important" : "") + (item.done ? " is-done" : ""));

  const check = node("button", "item-check");
  check.type = "button";
  check.setAttribute("aria-label", item.done ? "标记未完成" : "标记完成");
  check.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.4 5.8 10 11 4.6"/></svg>';
  check.addEventListener("click", (event) => {
    event.stopPropagation();
    patchItem(item.id, { done: !item.done });
  });

  const heart = node("button", "item-heart" + (item.important ? " is-on" : ""));
  heart.type = "button";
  heart.setAttribute("aria-label", item.important ? "取消重要" : "标记重要");
  heart.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13.4 3.1 8.6a2.9 2.9 0 0 1 4.1-4.1L8 5.3l.8-.8a2.9 2.9 0 1 1 4.1 4.1Z"/></svg>';
  heart.addEventListener("click", (event) => {
    event.stopPropagation();
    patchItem(item.id, { important: !item.important });
  });

  const main = node("div", "item-main");
  const title = node("button", "item-title", item.title);
  title.type = "button";
  title.addEventListener("click", () => openItem(task, item));
  main.append(title);
  const meta = node("span", "item-meta");
  if (item.due_date) {
    meta.append(node("span", "is-due", `结束 ${fmtDate(item.due_date)}`));
  } else {
    meta.append(node("span", "", `创建 ${fmtDate(item.created_date)}`));
  }
  main.append(meta);

  const actions = node("div", "item-actions");
  const archive = node("button", "icon-btn");
  archive.type = "button";
  archive.title = "归档到回收站";
  archive.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5h11v8.2h-11z"/><path d="M1.8 3h12.4v2.5H1.8z"/><path d="M6 8.6h4"/></svg>';
  archive.addEventListener("click", (event) => {
    event.stopPropagation();
    archiveItem(item);
  });
  const del = node("button", "icon-btn", "×");
  del.type = "button";
  del.title = "删除事项";
  del.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteItem(item);
  });
  actions.append(archive, del);

  row.append(check, main, heart, actions);
  return row;
}

/* ---------- 拖动换位 ---------- */

function clearDropMarks(scope) {
  scope.querySelectorAll(".drop-before").forEach((el) => el.classList.remove("drop-before"));
}

function onColumnDragOver(event, body, categoryId) {
  if (state.dragId === null || state.dragCategory !== categoryId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  clearDropMarks(body);
  const target = [...body.querySelectorAll(".proj:not(.is-dragging)")].find((card) => {
    const rect = card.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });
  if (target) target.classList.add("drop-before");
}

async function onColumnDrop(event, body, categoryId) {
  if (state.dragId === null || state.dragCategory !== categoryId) return;
  event.preventDefault();
  const draggingId = state.dragId;
  const cards = [...body.querySelectorAll(".proj")];
  const ids = cards.map((el) => Number(el.dataset.id));
  const targetEl = body.querySelector(".drop-before");
  const targetId = targetEl ? Number(targetEl.dataset.id) : null;
  clearDropMarks(body);
  const fromIndex = ids.indexOf(draggingId);
  if (fromIndex < 0) return;
  let insertIndex = targetId === null ? ids.length : ids.indexOf(targetId);
  if (insertIndex < 0) insertIndex = ids.length;
  ids.splice(fromIndex, 1);
  if (fromIndex < insertIndex) insertIndex -= 1;
  ids.splice(insertIndex, 0, draggingId);
  if (ids.every((id, index) => id === Number(cards[index].dataset.id))) return;
  try {
    await api("/api/plans/projects/reorder", { method: "POST", body: JSON.stringify({ ids }) });
    await refresh();
  } catch (error) {
    toast(`换位失败：${error.message}`);
  }
}

/* ---------- 临期任务：3 天内截止 ---------- */

function urgentTasks() {
  const limit = addDays(todayIso(), 3);
  const projectIds = new Set();
  let count = 0;
  for (const project of state.data.projects) {
    let hit = 0;
    for (const task of project.tasks) {
      if (!task.done && task.due_date && task.due_date <= limit) hit += 1;
    }
    if (hit) {
      projectIds.add(project.id);
      count += hit;
    }
  }
  for (const task of state.data.standalone_tasks || []) {
    if (!task.done && task.due_date && task.due_date <= limit) count += 1;
  }
  return { projectIds, count };
}

function renderUrgentButton() {
  if (!state.data) return;
  const { count } = urgentTasks();
  const button = $("urgentBtn");
  button.textContent = "临期";
  if (count) button.append(node("span", "btn-count", String(count)));
  button.classList.toggle("is-active", state.urgentOnly);
  button.title = count
    ? `3 天内有 ${count} 个任务临期，点一下展开相关项目`
    : "3 天内没有到期任务";
}

function toggleUrgent() {
  if (!state.data) return;
  state.urgentOnly = !state.urgentOnly;
  if (state.urgentOnly) {
    state.openBackup = new Set(state.open);
    const { projectIds, count } = urgentTasks();
    state.open = new Set(projectIds);
    renderUrgentButton();
    renderBoard();
    if (!count) toast("3 天内没有临期任务");
    else if (projectIds.size) toast(`3 天内 ${count} 个任务临期，已展开 ${projectIds.size} 个项目`);
    else toast(`3 天内 ${count} 个任务临期，都在备忘录里`);
  } else {
    state.open = new Set(state.openBackup || []);
    state.openBackup = null;
    renderUrgentButton();
    renderBoard();
  }
}

/* ---------- 未来 14 天到期条 ---------- */

function dayGap(fromIso, toIso) {
  const from = new Date(`${fromIso}T00:00:00`);
  const to = new Date(`${toIso}T00:00:00`);
  return Math.round((to - from) / 86400000);
}

// 第 1 段是明天，第 14 段是第 14 天；今天到期的不进条
function dueBuckets() {
  const today = todayIso();
  const buckets = Array.from({ length: 14 }, () => []);
  const push = (task, projectTitle) => {
    if (task.done || !task.due_date) return;
    const gap = dayGap(today, task.due_date);
    if (gap < 1 || gap > 14) return;
    buckets[gap - 1].push({ title: task.title, project: projectTitle, date: task.due_date });
  };
  for (const project of state.data.projects) {
    for (const task of project.tasks) push(task, project.title);
  }
  for (const task of state.data.standalone_tasks || []) push(task, "备忘录");
  return buckets;
}

function renderDueStrip() {
  if (!state.data) return;
  const buckets = dueBuckets();
  const strip = $("dueStrip");
  strip.replaceChildren();
  let total = 0;
  buckets.forEach((items, index) => {
    const slot = node("div", "due-slot" + (items.length ? " has-task" : ""));
    const bar = node("div", "due-bar");
    const height = items.length ? Math.min(22, 5 + items.length * 6) : 2;
    bar.style.height = `${height}px`;
    if (items.length) {
      const alpha = Math.max(0.35, 0.95 - index * 0.045);
      bar.style.background = `rgba(250, 45, 85, ${alpha.toFixed(3)})`;
    }
    slot.append(bar);
    if ([3, 6, 9, 12].includes(index + 1)) slot.append(node("span", "due-tick", String(index + 1)));
    if (items.length) {
      total += items.length;
      slot.append(node("span", "due-count", items.length > 9 ? "9+" : String(items.length)));
      slot.title = `${fmtDate(items[0].date)} · ${items.length} 个任务`;
      slot.addEventListener("click", (event) => {
        event.stopPropagation();
        showDuePanel(slot, items);
      });
    }
    strip.append(slot);
  });
  strip.hidden = total === 0;
}

function showDuePanel(slot, items) {
  const panel = $("duePanel");
  const head = node("div", "due-panel-head");
  head.append(node("strong", "", fmtDate(items[0].date)));
  head.append(node("span", "", `${items.length} 个任务`));
  const list = node("ul");
  for (const item of items) {
    const row = node("li");
    row.append(node("span", "due-task", item.title));
    row.append(node("span", "due-proj", item.project));
    list.append(row);
  }
  panel.replaceChildren(head, list);
  panel.hidden = false;
  const rect = slot.getBoundingClientRect();
  const width = 258;
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${rect.bottom + 8}px`;
}

function hideDuePanel() {
  const panel = $("duePanel");
  if (panel && !panel.hidden) panel.hidden = true;
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

async function patchItem(id, body) {
  try {
    await api(`/api/plans/items/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    await refresh();
  } catch (error) {
    toast(`更新失败：${error.message}`);
  }
}

async function archiveItem(item) {
  if (!window.confirm(`归档「${item.title}」？可以在回收站恢复。`)) return;
  try {
    await api(`/api/plans/items/${item.id}/archive`, { method: "POST", body: "{}" });
    await refresh();
    toast("事项已归档");
  } catch (error) {
    toast(`归档失败：${error.message}`);
  }
}

async function deleteItem(item) {
  if (!window.confirm(`删除事项「${item.title}」？删除后不进回收站。`)) return;
  try {
    await api(`/api/plans/items/${item.id}`, { method: "DELETE" });
    await refresh();
    toast("事项已删除");
  } catch (error) {
    toast(`删除失败：${error.message}`);
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
  state.milestones = project
    ? (project.milestones || []).map((item) => ({ title: item.title || "", date: item.date }))
    : [];
  $("projectSheetTitle").textContent = project ? "编辑项目" : "新建项目";
  $("projectName").value = project ? project.title : "";
  $("projectStart").value = project ? project.start_date : todayIso();
  $("projectEnd").value = project ? (project.end_date || "") : "";

  const seg = $("projectCategory");
  seg.replaceChildren();
  for (const category of state.data.categories) {
    // 备忘录只放任务，不能把项目放进备忘录（历史遗留的仍可保持）
    if (category.id === "memo" && state.projectCategory !== "memo") continue;
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

  renderMilestones();
  showSheet("projectSheet");
  $("projectName").focus();
  if (project) $("projectName").select();
}

function renderMilestones() {
  const list = $("milestoneList");
  list.replaceChildren();
  if (!state.milestones.length) {
    list.append(node("p", "deadline-empty", "还没有阶段性目标，需要时再加。"));
    return;
  }
  state.milestones.forEach((milestone, index) => {
    const row = node("div", "deadline-row milestone-row");
    row.append(node("i", "deadline-mark", "!"));

    const due = document.createElement("input");
    due.type = "date";
    due.className = "milestone-date";
    due.value = milestone.date;
    due.setAttribute("aria-label", `第 ${index + 1} 个阶段性目标的日期`);
    due.addEventListener("change", () => { state.milestones[index].date = due.value; });

    const title = document.createElement("input");
    title.type = "text";
    title.className = "milestone-title";
    title.maxLength = 40;
    title.placeholder = "这个节点要达成什么";
    title.value = milestone.title;
    title.setAttribute("aria-label", `第 ${index + 1} 个阶段性目标的内容`);
    title.addEventListener("input", () => { state.milestones[index].title = title.value; });

    const remove = node("button", "deadline-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "删除这个阶段性目标");
    remove.addEventListener("click", () => {
      state.milestones.splice(index, 1);
      renderMilestones();
    });
    row.append(due, title, remove);
    list.append(row);
  });
}

async function saveProject() {
  const title = $("projectName").value.trim();
  if (!title) {
    toast("先写项目名");
    return;
  }
  const start = $("projectStart").value || "";
  const end = $("projectEnd").value || "";
  if (start && end && end < start) {
    toast("结束日期不能早于开始日期");
    return;
  }
  const milestones = state.milestones
    .filter((item) => item.date || (item.title || "").trim())
    .map((item) => ({
      title: (item.title || "").trim(),
      date: item.date || end || start,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const body = {
    title,
    category: state.projectCategory,
    start_date: start,
    end_date: end,
    milestones,
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
  $("taskDue").value = task ? (task.due_date || "") : "";
  // 每周重复只给备忘录里的独立任务
  const standalone = !project;
  $("taskRepeatField").hidden = !standalone;
  setRepeat(standalone ? (task ? task.repeat_weekday : -1) : -1);
  $("taskHint").textContent = standalone
    ? "备忘录里的任务不挂在项目下；设了每周重复会一直排在列首。"
    : "任务挂在项目下面；结束日期只影响这一条任务，留空就是没有期限。";
  showSheet("taskSheet");
  $("taskName").focus();
}

function setRepeat(day) {
  state.repeatWeekday = Number(day);
  document.querySelectorAll("#taskRepeat button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.day) === state.repeatWeekday);
  });
}

async function saveTask() {
  const title = $("taskName").value.trim();
  if (!title) {
    toast("先写任务名");
    return;
  }
  const due = $("taskDue").value || "";
  const repeat = state.taskProject ? -1 : state.repeatWeekday;
  $("taskSave").disabled = true;
  try {
    if (state.task) {
      await api(`/api/plans/tasks/${state.task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title, due_date: due, repeat_weekday: repeat }),
      });
    } else {
      await api("/api/plans/tasks", {
        method: "POST",
        body: JSON.stringify({
          project_id: state.taskProject ? state.taskProject.id : 0,
          title,
          due_date: due,
          repeat_weekday: repeat,
        }),
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

/* ---------- 事项弹层 ---------- */

function openItem(task, item) {
  state.item = item;
  state.itemTask = task;
  $("itemSheetTitle").textContent = item ? "编辑事项" : "新建事项";
  $("itemName").value = item ? item.title : "";
  $("itemDue").value = item ? (item.due_date || "") : "";
  setItemImportant(item ? item.important : false);
  $("itemDelete").hidden = !item;
  showSheet("itemSheet");
  $("itemName").focus();
  $("itemName").select();
}

function setItemImportant(on) {
  state.itemImportant = Boolean(on);
  const button = $("itemImportant");
  button.classList.toggle("is-on", state.itemImportant);
  button.setAttribute("aria-pressed", state.itemImportant ? "true" : "false");
  button.querySelector("span").textContent = state.itemImportant ? "已标记为重要" : "点亮表示重要";
}

async function saveItem() {
  const title = $("itemName").value.trim();
  if (!title) {
    toast("先写事项名");
    return;
  }
  const task = state.itemTask;
  const body = { title, due_date: $("itemDue").value || "", important: state.itemImportant };
  $("itemSave").disabled = true;
  try {
    if (state.item) {
      await api(`/api/plans/items/${state.item.id}`, { method: "PATCH", body: JSON.stringify(body) });
    } else {
      await api("/api/plans/items", {
        method: "POST",
        body: JSON.stringify({ ...body, task_id: task.id }),
      });
    }
    if (task) state.openTasks.add(task.id);
    closeSheets();
    await refresh();
    toast(state.item ? "事项已更新" : "事项已添加");
  } catch (error) {
    toast(`没保存：${error.message}`);
  } finally {
    $("itemSave").disabled = false;
  }
}

/* ---------- 回收站 ---------- */

function renderTrash() {
  const list = $("trashList");
  list.replaceChildren();
  const archived = state.data.archived || [];
  const archivedItems = state.data.archived_items || [];
  const archivedTasks = state.data.archived_tasks || [];
  if (!archived.length && !archivedItems.length && !archivedTasks.length) {
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

  if (archivedTasks.length) {
    list.append(node("div", "trash-label", "已归档任务（备忘录）"));
    for (const task of archivedTasks) {
      const entry = node("div", "trash-item");
      const top = node("div", "trash-item-top");
      const dot = node("i", "trash-dot");
      dot.style.setProperty("--cat", "#8e8e93");
      top.append(dot);
      top.append(node("strong", "", task.title));
      entry.append(top);
      entry.append(node("div", "trash-meta", `${(task.archived_at || "").slice(0, 10)} 勾选完成`));
      const actions = node("div", "trash-actions");
      const restore = node("button", "", "恢复到备忘录");
      restore.type = "button";
      restore.addEventListener("click", async () => {
        try {
          await api(`/api/plans/tasks/${task.id}/restore`, { method: "POST", body: "{}" });
          await refresh();
          toast("已恢复到备忘录");
        } catch (error) {
          toast(`恢复失败：${error.message}`);
        }
      });
      const remove = node("button", "danger", "永久删除");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`永久删除「${task.title}」？不可恢复。`)) return;
        try {
          await api(`/api/plans/tasks/${task.id}`, { method: "DELETE" });
          await refresh();
          toast("已永久删除");
        } catch (error) {
          toast(`删除失败：${error.message}`);
        }
      });
      actions.append(restore, remove);
      entry.append(actions);
      list.append(entry);
    }
  }

  if (archivedItems.length) {
    list.append(node("div", "trash-label", "已归档事项"));
    for (const item of archivedItems) {
      const entry = node("div", "trash-item");
      const top = node("div", "trash-item-top");
      const dot = node("i", "trash-dot");
      dot.style.setProperty("--cat", "#f5c451");
      top.append(dot);
      top.append(node("strong", "", item.title));
      entry.append(top);
      entry.append(node(
        "div",
        "trash-meta",
        `${item.project_title} · ${item.task_title} · ${(item.archived_at || "").slice(0, 10)} 归档`,
      ));
      const actions = node("div", "trash-actions");
      const restore = node("button", "", "恢复");
      restore.type = "button";
      restore.addEventListener("click", async () => {
        try {
          await api(`/api/plans/items/${item.id}/restore`, { method: "POST", body: "{}" });
          await refresh();
          toast("事项已恢复");
        } catch (error) {
          toast(`恢复失败：${error.message}`);
        }
      });
      const remove = node("button", "danger", "永久删除");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`永久删除事项「${item.title}」？不可恢复。`)) return;
        try {
          await api(`/api/plans/items/${item.id}`, { method: "DELETE" });
          await refresh();
          toast("已永久删除");
        } catch (error) {
          toast(`删除失败：${error.message}`);
        }
      });
      actions.append(restore, remove);
      entry.append(actions);
      list.append(entry);
    }
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
  $("itemSheet").hidden = true;
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
$("urgentBtn").addEventListener("click", toggleUrgent);
// 捕获阶段关：卡片自己的 click 会 stopPropagation，冒泡阶段收不到
document.addEventListener("click", (event) => {
  if (event.target.closest("#duePanel, .due-slot")) return;
  hideDuePanel();
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideDuePanel();
});
// 顶栏的刷新按钮通过这个钩子调用本页的重载，保留展开与筛选状态
window.mgmtRefresh = async () => {
  const ok = await refresh();
  toast(ok ? "已刷新" : "读取失败，稍后再试");
  return ok;
};
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
$("taskRepeat").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-day]");
  if (button) setRepeat(button.dataset.day);
});
$("itemClose").addEventListener("click", closeSheets);
$("itemCancel").addEventListener("click", closeSheets);
$("itemSave").addEventListener("click", saveItem);
$("itemImportant").addEventListener("click", () => setItemImportant(!state.itemImportant));
$("itemDelete").addEventListener("click", async () => {
  const item = state.item;
  if (!item) return;
  if (!window.confirm(`删除事项「${item.title}」？删除后不进回收站。`)) return;
  closeSheets();
  try {
    await api(`/api/plans/items/${item.id}`, { method: "DELETE" });
    await refresh();
    toast("事项已删除");
  } catch (error) {
    toast(`删除失败：${error.message}`);
  }
});
$("sheetBackdrop").addEventListener("click", closeSheets);

$("milestoneAdd").addEventListener("click", () => {
  const base = $("projectEnd").value || $("projectStart").value || todayIso();
  const last = state.milestones.length
    ? state.milestones[state.milestones.length - 1].date
    : base;
  state.milestones.push({
    title: "",
    date: addDays(last, state.milestones.length ? 7 : 0),
  });
  renderMilestones();
  const inputs = $("milestoneList").querySelectorAll(".milestone-title");
  if (inputs.length) inputs[inputs.length - 1].focus();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("projectSheet").hidden || !$("taskSheet").hidden || !$("itemSheet").hidden) closeSheets();
  else if (!$("trashDrawer").hidden) closeTrash();
});

load().then(updateBatchBar);
