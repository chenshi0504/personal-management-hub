/* 体育兴趣：兴趣视图为月历面板，与运动同一套计划 / 记录思路 */
(function () {
  "use strict";

  const q = (id) => document.getElementById(id);
  const WEEK_CN = ["一", "二", "三", "四", "五", "六", "日"];

  const todayISO = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  const st = {
    active: false,
    month: todayISO.slice(0, 7),
    data: null,
    selected: null,
    form: null,
    cats: {},
    plansByDay: new Map(),
    recordsByDay: new Map(),
  };

  /* ---------- 工具 ---------- */

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

  function weekdayOf(iso) {
    const index = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
    return `周${WEEK_CN[index]}`;
  }

  function dayLabel(iso) {
    const [, month, day] = iso.split("-").map(Number);
    return `${month}月${day}日 ${weekdayOf(iso)}`;
  }

  function minutesText(minutes) {
    if (!minutes) return "0";
    if (minutes < 60) return `${minutes}′`;
    const hours = minutes / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }

  function hoursText(minutes) {
    if (!minutes) return "0";
    const hours = minutes / 60;
    return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  }

  function notify(message) {
    if (typeof window.toast === "function") window.toast(message);
  }

  async function request(url, options) {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
    return payload;
  }

  /* ---------- 读取 ---------- */

  async function loadHobby(month) {
    st.month = month || st.month;
    const input = q("hobbyMonth");
    if (input) input.value = st.month;
    try {
      st.data = await request(`/api/hobby/month?month=${st.month}`);
      st.cats = Object.fromEntries(st.data.categories.map((item) => [item.id, item]));
      st.plansByDay.clear();
      st.recordsByDay.clear();
      for (const plan of st.data.plans) {
        if (!st.plansByDay.has(plan.date)) st.plansByDay.set(plan.date, []);
        st.plansByDay.get(plan.date).push({ ...plan, kind: "plan" });
      }
      for (const record of st.data.records) {
        if (!st.recordsByDay.has(record.date)) st.recordsByDay.set(record.date, []);
        st.recordsByDay.get(record.date).push({ ...record, kind: "record" });
      }
      renderAll();
    } catch (error) {
      q("hobbyGrid").replaceChildren(node("p", "hb-empty", `读取失败：${error.message}`));
    }
  }

  /* ---------- 渲染 ---------- */

  function renderAll() {
    renderMetrics();
    renderCalendar();
    renderDetail();
  }

  function renderMetrics() {
    const totals = st.data.totals;
    q("hobbyCount").textContent = totals.records;
    q("hobbyHours").textContent = hoursText(totals.minutes);
    q("hobbyPlans").textContent = totals.plans;
    const foot = q("hobbyWeek");
    foot.replaceChildren();
    foot.append(node("span", "week-count-label", "本月"));
    foot.append(node("span", "week-count", `${totals.records} 条 · ${hoursText(totals.minutes)} h`));
    for (const category of st.data.categories) {
      const stat = totals.by_category[category.id] || { count: 0 };
      if (!stat.count) continue;
      const chip = node("span", "week-count", `${category.short} ${stat.count}`);
      chip.style.color = category.color;
      foot.append(chip);
    }
  }

  function renderCalendar() {
    const [year, month] = st.month.split("-").map(Number);
    const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
    const grid = q("hobbyGrid");
    grid.replaceChildren();

    for (let index = 0; index < lead; index += 1) {
      grid.append(node("div", "cal-day is-empty"));
    }

    for (let day = 1; day <= total; day += 1) {
      const date = `${st.month}-${pad(day)}`;
      const plans = st.plansByDay.get(date) || [];
      const records = st.recordsByDay.get(date) || [];
      const state = records.length ? "is-recorded" : (plans.length ? "is-planned" : "is-blank");
      const leadEntry = records[0] || plans[0];
      const cell = node("div", `cal-day ${state}`);
      cell.dataset.date = date;
      cell.setAttribute("role", "button");
      cell.tabIndex = 0;
      if (date === todayISO) cell.classList.add("is-today");
      if (date === st.selected) cell.classList.add("is-selected");
      if (leadEntry) cell.style.setProperty("--hb", st.cats[leadEntry.category].color);
      cell.append(node("span", "cal-date", String(day)));

      const entries = [...records, ...plans];
      for (const entry of entries.slice(0, 2)) {
        const category = st.cats[entry.category];
        const line = node("span", "hb-line" + (entry.kind === "plan" ? " is-plan" : ""));
        line.style.setProperty("--hb", category.color);
        line.append(node("i"));
        const suffix = entry.kind === "plan"
          ? ""
          : (entry.counted === false ? " · 打卡" : (entry.minutes ? ` · ${minutesText(entry.minutes)}` : ""));
        line.append(node("span", "", entry.item + suffix));
        cell.append(line);
      }
      if (entries.length > 2) {
        cell.append(node("span", "hb-line is-more", `+${entries.length - 2}`));
      }

      const recordBtn = node("button", "rec-entry");
      recordBtn.type = "button";
      recordBtn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 12.8h2.4l6.6-6.6-2.4-2.4-6.6 6.6v2.4Z"/><path d="M9.6 4l2.4 2.4"/></svg>';
      recordBtn.setAttribute("aria-label", `给 ${day} 号添加记录`);
      recordBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openSheet("record", date, null);
      });
      cell.append(recordBtn);

      const select = () => {
        st.selected = date;
        renderCalendar();
        renderDetail();
        scrollToDetail();
      };
      cell.addEventListener("click", select);
      cell.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        select();
      });
      grid.append(cell);
    }
  }

  function renderDetail() {
    const date = st.selected;
    q("hobbyHint").hidden = Boolean(date);
    if (!date) {
      q("hobbyBody").hidden = true;
      return;
    }
    const plans = st.plansByDay.get(date) || [];
    const records = st.recordsByDay.get(date) || [];
    q("hobbyBody").hidden = false;
    q("hobbyEyebrow").textContent = date === todayISO ? "今天" : "当天";
    q("hobbyDayTitle").textContent = dayLabel(date);

    const badge = q("hobbyState");
    badge.dataset.state = records.length ? "recorded" : (plans.length ? "planned" : "blank");
    badge.textContent = records.length ? "已记录" : (plans.length ? "已计划" : "未安排");

    const list = q("hobbyList");
    list.replaceChildren();
    if (!plans.length && !records.length) {
      list.append(node("p", "hb-empty", "这一天还没有安排，点下面添加计划或记录。"));
      return;
    }
    for (const record of records) list.append(entryRow("record", record));
    const ordered = plans.slice().sort((a, b) => Number(a.done) - Number(b.done));
    for (const plan of ordered) list.append(entryRow("plan", plan));
  }

  function entryRow(kind, entry) {
    const category = st.cats[entry.category];
    const row = node("div", "hb-entry" + (kind === "plan" ? " is-plan" : ""));
    row.style.setProperty("--hb", category.color);
    row.append(node("i", "hb-entry-dot"));

    const main = node("div", "hb-entry-main");
    const title = node("button", "hb-entry-title", entry.item);
    title.type = "button";
    title.addEventListener("click", () => openSheet(kind, entry.date, entry));
    main.append(title);

    let meta;
    if (kind === "plan") {
      meta = `${category.name} · 计划${entry.done ? " · 已完成" : ""}${entry.note ? ` · ${entry.note}` : ""}`;
    } else if (entry.counted === false) {
      meta = `${category.name} · 已打卡（未计时）${entry.note ? ` · ${entry.note}` : ""}`;
    } else {
      meta = `${category.name} · ${minutesText(entry.minutes)}${entry.note ? ` · ${entry.note}` : ""}`;
    }
    main.append(node("span", "hb-entry-meta", meta));
    row.append(main);

    const actions = node("div", "hb-entry-actions");
    if (kind === "plan") {
      const check = node("button", "is-check", entry.done ? "↺" : "✓");
      check.type = "button";
      check.title = entry.done ? "标记未完成" : "标记完成";
      check.addEventListener("click", async () => {
        try {
          await request(`/api/hobby/plans/${entry.id}`, {
            method: "PATCH",
            body: JSON.stringify({ done: !entry.done }),
          });
          await loadHobby();
          notify(entry.done ? "已改回未完成" : "计划已完成");
        } catch (error) {
          notify(`没保存：${error.message}`);
        }
      });
      actions.append(check);
    }
    const remove = node("button", "is-del", "×");
    remove.type = "button";
    remove.title = kind === "plan" ? "删除这条计划" : "删除这条记录";
    remove.addEventListener("click", async () => {
      const label = kind === "plan" ? "计划" : "记录";
      if (!window.confirm(`删除 ${dayLabel(entry.date)} 的「${entry.item}」${label}？`)) return;
      try {
        await request(`/api/hobby/${kind === "plan" ? "plans" : "records"}/${entry.id}`, { method: "DELETE" });
        await loadHobby();
        notify(`${label}已删除`);
      } catch (error) {
        notify(`删除失败：${error.message}`);
      }
    });
    actions.append(remove);
    row.append(actions);
    return row;
  }

  function scrollToDetail() {
    const detail = q("hobbyDetail");
    const top = detail.getBoundingClientRect().top + window.scrollY - 70;
    window.scrollTo({ top, behavior: "smooth" });
  }

  /* ---------- 弹层 ---------- */

  function openSheet(mode, date, entry) {
    if (!st.data) return;
    const prefer = entry ? entry.category : (st.form ? st.form.category : "travel");
    const cat = st.cats[prefer] || st.data.categories[0];
    st.form = {
      kind: entry ? entry.kind : mode,
      mode: entry ? entry.kind : mode,
      entryId: entry ? entry.id : null,
      category: cat.id,
      item: entry ? entry.item : cat.items[0],
      date: entry ? entry.date : date,
      minutes: entry && entry.minutes ? entry.minutes : st.data.default_minutes,
      counted: entry ? entry.counted !== false : true,
      note: entry ? entry.note : "",
    };
    // 编辑器现在长在详情框里，得先把当天详情打开
    st.selected = st.form.date;
    renderCalendar();
    renderDetail();
    renderSheet();
    q("hobbySheet").hidden = false;
    const backdrop = q("hobbyBackdrop");
    if (backdrop) backdrop.hidden = false;
    scrollToDetail();
  }

  function closeSheet() {
    q("hobbySheet").hidden = true;
    const backdrop = q("hobbyBackdrop");
    if (backdrop) backdrop.hidden = true;
    st.form = null;
  }

  function renderSheet() {
    const form = st.form;
    if (!form) return;
    const cat = st.cats[form.category];
    const sheet = q("hobbySheet");
    sheet.style.setProperty("--hb", cat.color);
    q("hobbySheetEyebrow").textContent = form.kind === "plan" ? "计划" : "记录";
    q("hobbySheetTitle").textContent = `${cat.name} · ${form.item}`;
    q("hobbyDelete").hidden = !form.entryId;

    const modeField = q("hobbyMode").closest(".hs-field");
    modeField.hidden = Boolean(form.entryId);
    for (const button of q("hobbyMode").querySelectorAll("button")) {
      button.classList.toggle("is-active", button.dataset.mode === form.mode);
    }

    const cats = q("hobbyCats");
    cats.replaceChildren();
    for (const category of st.data.categories) {
      const button = node("button", "", category.short);
      button.type = "button";
      button.classList.toggle("is-active", category.id === form.category);
      button.addEventListener("click", () => {
        form.category = category.id;
        form.item = category.items[0];
        renderSheet();
      });
      cats.append(button);
    }

    const items = q("hobbyItems");
    items.replaceChildren();
    for (const item of cat.items) {
      const button = node("button", "", item);
      button.type = "button";
      button.classList.toggle("is-active", item === form.item);
      button.addEventListener("click", () => {
        form.item = item;
        renderSheet();
      });
      items.append(button);
    }

    q("hobbyDate").value = form.date;
    q("hobbyCounted").checked = form.counted;
    q("hobbyMinutes").value = form.minutes;
    q("hobbyMinutes").disabled = !form.counted;
    q("hobbyNote").value = form.note;
    q("hobbyMinutesField").hidden = form.mode === "plan";
  }

  async function saveForm() {
    const form = st.form;
    if (!form) return;
    const date = q("hobbyDate").value;
    if (!date) {
      notify("先选日期");
      return;
    }
    const body = {
      date,
      category: form.category,
      item: form.item,
      note: q("hobbyNote").value.trim(),
    };
    if (form.kind === "record") {
      body.counted = q("hobbyCounted").checked;
      body.minutes = body.counted ? Number(q("hobbyMinutes").value || 0) : 0;
      if (body.counted && (!body.minutes || body.minutes < 5)) {
        notify("时长至少 5 分钟，或取消勾选「记录时长」");
        return;
      }
    }
    const save = q("hobbySave");
    save.disabled = true;
    try {
      if (form.kind === "plan") {
        if (form.entryId) {
          await request(`/api/hobby/plans/${form.entryId}`, { method: "PATCH", body: JSON.stringify(body) });
        } else {
          await request("/api/hobby/plans", { method: "POST", body: JSON.stringify(body) });
        }
      } else if (form.entryId) {
        await request(`/api/hobby/records/${form.entryId}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await request("/api/hobby/records", { method: "POST", body: JSON.stringify(body) });
      }
      st.selected = date;
      closeSheet();
      await loadHobby();
      notify(form.kind === "plan" ? "计划已保存" : "记录已保存");
    } catch (error) {
      notify(`没保存：${error.message}`);
    } finally {
      save.disabled = false;
    }
  }

  async function deleteEntry() {
    const form = st.form;
    if (!form || !form.entryId) return;
    const label = form.kind === "plan" ? "计划" : "记录";
    if (!window.confirm(`删除这条「${form.item}」${label}？`)) return;
    try {
      await request(`/api/hobby/${form.kind === "plan" ? "plans" : "records"}/${form.entryId}`, { method: "DELETE" });
      closeSheet();
      await loadHobby();
      notify(`${label}已删除`);
    } catch (error) {
      notify(`删除失败：${error.message}`);
    }
  }

  /* ---------- 视图切换 ---------- */

  function setView(target) {
    st.active = target === "hobby";
    document.body.classList.toggle("is-hobby", st.active);
    q("sportView").hidden = st.active;
    q("hobbyView").hidden = !st.active;
    q("tabSport").classList.toggle("is-active", !st.active);
    q("tabHobby").classList.toggle("is-active", st.active);
    q("tabSport").setAttribute("aria-selected", String(!st.active));
    q("tabHobby").setAttribute("aria-selected", String(st.active));
    if (st.active) {
      loadHobby(st.month);
      history.replaceState(null, "", "#hobby");
    } else {
      history.replaceState(null, "", "#sport");
    }
  }

  /* ---------- 绑定 ---------- */

  q("tabSport").addEventListener("click", () => setView("sport"));
  q("tabHobby").addEventListener("click", () => setView("hobby"));

  q("hobbyPrev").addEventListener("click", () => {
    st.selected = null;
    loadHobby(shiftMonth(st.month, -1));
  });
  q("hobbyNext").addEventListener("click", () => {
    st.selected = null;
    loadHobby(shiftMonth(st.month, 1));
  });
  q("hobbyMonth").addEventListener("change", (event) => {
    if (!event.target.value) return;
    st.selected = null;
    loadHobby(event.target.value);
  });

  q("hobbyAdd").addEventListener("click", () => {
    openSheet("plan", st.selected || todayISO, null);
  });
  q("hobbyClose").addEventListener("click", () => {
    st.selected = null;
    renderCalendar();
    renderDetail();
  });

  for (const button of q("hobbyMode").querySelectorAll("button")) {
    button.addEventListener("click", () => {
      if (!st.form || st.form.entryId) return;
      st.form.mode = button.dataset.mode;
      st.form.kind = button.dataset.mode;
      renderSheet();
    });
  }
  q("hobbyCounted").addEventListener("change", (event) => {
    if (!st.form) return;
    st.form.counted = event.target.checked;
    renderSheet();
  });
  for (const button of q("hobbyQuick").querySelectorAll("button")) {
    button.addEventListener("click", () => {
      if (!st.form) return;
      st.form.minutes = Number(button.dataset.min);
      q("hobbyMinutes").value = st.form.minutes;
    });
  }
  q("hobbySave").addEventListener("click", saveForm);
  q("hobbyCancel").addEventListener("click", closeSheet);
  q("hobbySheetClose").addEventListener("click", closeSheet);
  q("hobbyDelete").addEventListener("click", deleteEntry);
  const backdropEl = q("hobbyBackdrop");
  if (backdropEl) backdropEl.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && st.form) closeSheet();
  });

  if (location.hash === "#hobby") setView("hobby");
})();
