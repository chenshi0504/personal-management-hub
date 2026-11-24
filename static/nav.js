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
