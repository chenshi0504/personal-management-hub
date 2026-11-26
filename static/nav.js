/* 顶栏时钟：日期 + 时间，精确到分钟 */
(function () {
  const dateEl = document.getElementById("clockDate");
  const timeEl = document.getElementById("clockTime");
  const clock = document.getElementById("mgmtClock");
  if (!dateEl || !timeEl) return;

  const dateFmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", weekday: "short",
  });
  const timeFmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
  });

  function render() {
    const now = new Date();
    const parts = {};
    for (const part of dateFmt.formatToParts(now)) parts[part.type] = part.value;
    dateEl.textContent = `${parts.month}月${parts.day}日 ${parts.weekday}`;
    const clockText = timeFmt.format(now);
    timeEl.textContent = clockText;
    if (clock) {
      clock.dateTime = now.toISOString();
      clock.title = dateFmt.format(now) + " " + clockText;
    }
  }

  render();
  setInterval(render, 15000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) render();
  });
})();

/* 深浅主题：自动（7–17 点浅色） / 浅色 / 深色，手动选择记在 localStorage */
(function () {
  const root = document.documentElement;
  const toggle = document.getElementById("themeToggle");
  const ICONS = {
    auto: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 2v12"/><path d="M8 2a6 6 0 0 1 0 12Z" fill="currentColor" stroke="none"/></svg><i class="theme-dot" aria-hidden="true"></i>',
    light: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.3v1.6M8 13.1v1.6M1.3 8h1.6M13.1 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"/></svg><i class="theme-dot" aria-hidden="true"></i>',
    dark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 9.8A5.7 5.7 0 0 1 6.2 2.8a5.7 5.7 0 1 0 7 7Z"/></svg><i class="theme-dot" aria-hidden="true"></i>',
  };
  const NAME = { auto: "自动", light: "浅色", dark: "深色" };

  function shanghaiHour() {
    try {
      return Number(new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false,
      }).format(new Date()));
    } catch (error) {
      return new Date().getHours();
    }
  }

  function resolve(mode) {
    if (mode === "light" || mode === "dark") return mode;
    const hour = shanghaiHour();
    return hour >= 7 && hour < 17 ? "light" : "dark";
  }

  function apply(mode, remember) {
    const theme = resolve(mode);
    root.setAttribute("data-theme-mode", mode);
    root.setAttribute("data-theme", theme);
    if (toggle) {
      toggle.dataset.mode = mode;
      toggle.innerHTML = ICONS[mode] || ICONS.auto;
      toggle.setAttribute("aria-label", `主题：${NAME[mode] || NAME.auto}`);
      toggle.title = mode === "auto"
        ? `自动（现在${theme === "light" ? "浅色" : "深色"}）· 7–17 点浅色，点击切换`
        : `${NAME[mode]} · 点击切换`;
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f4f5f7" : "#000000");
    if (remember) {
      try { localStorage.setItem("mgmt-theme", mode); } catch (error) {}
    }
  }

  apply(root.getAttribute("data-theme-mode") || "auto", false);

  if (toggle) {
    toggle.addEventListener("click", () => {
      const order = ["auto", "light", "dark"];
      const current = root.getAttribute("data-theme-mode") || "auto";
      apply(order[(order.indexOf(current) + 1) % 3], true);
    });
  }

  // 自动模式跨过 7 点 / 17 点要自己换过来
  setInterval(() => {
    if ((root.getAttribute("data-theme-mode") || "auto") === "auto") apply("auto", false);
  }, 60000);
})();

/* 顶栏刷新：页面提供 window.mgmtRefresh 就调它，没有就整页重载 */
(function () {
  const button = document.getElementById("refreshAll");
  if (!button) return;
  button.addEventListener("click", async () => {
    if (button.classList.contains("is-loading")) return;
    button.classList.add("is-loading");
    const hook = window.mgmtRefresh;
    if (typeof hook !== "function") {
      location.reload();
      return;
    }
    button.disabled = true;
    try {
      await hook();
    } catch (error) {
      /* 页面自己会提示失败原因 */
    } finally {
      button.classList.remove("is-loading");
      button.disabled = false;
    }
  });
})();

/* 日期 / 时间 / 月份：点框任意位置就弹出原生选择器，不用去找右边的小图标 */
(function () {
  document.addEventListener("click", (event) => {
    const input = event.target.closest(
      'input[type="date"], input[type="time"], input[type="month"], input[type="datetime-local"]',
    );
    if (!input || input.disabled || input.readOnly) return;
    if (typeof input.showPicker !== "function") return;
    try {
      input.showPicker();
    } catch (error) {
      /* 已经打开或浏览器不允许时忽略 */
    }
  });
})();

/* 触控板横滑切板块：左滑去左边，右滑去右边，首尾循环 */
(function () {
  const ORDER = ["/planner", "/schedule", "/sport", "/time", "/journal"];
  const current = ORDER.indexOf(location.pathname);
  if (current === -1) return;

  function horizontalScroller(target) {
    let node = target;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 2) return true;
      node = node.parentElement;
    }
    return false;
  }

  let accX = 0;
  let lastAt = 0;
  let locked = false;

  function go(direction) {
    if (locked) return;
    locked = true;
    const next = (current + direction + ORDER.length) % ORDER.length;
    document.documentElement.classList.add("is-tab-sliding");
    setTimeout(() => { location.href = ORDER[next]; }, 120);
  }

  window.addEventListener("wheel", (event) => {
    // 有的触控板驱动把横滑映射成 Shift + 纵向滚轮，这里一并认
    const dx = event.shiftKey ? event.deltaY : event.deltaX;
    if (!event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.2) return;
    if (horizontalScroller(event.target)) return;
    if (!dx) return;
    const now = Date.now();
    if (now - lastAt > 480) accX = 0;
    lastAt = now;
    accX += dx;
    // 手指向左滑 → 内容右移（deltaX > 0）→ 去左边那个板块
    if (Math.abs(accX) >= 100) {
      go(accX > 0 ? -1 : 1);
      accX = 0;
    }
  }, { passive: true });

  // 键盘兜底：Alt + ← / →
  window.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
  });

  // 触屏三指横滑（笔记本触摸屏/平板）
  let touchStartX = 0;
  let touchStartY = 0;
  window.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 3) { touchStartX = 0; return; }
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
  }, { passive: true });
  window.addEventListener("touchend", (event) => {
    if (!touchStartX) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    touchStartX = 0;
    if (Math.abs(dx) < 90 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    go(dx > 0 ? -1 : 1);
  }, { passive: true });
})();
