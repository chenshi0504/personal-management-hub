# -*- coding: utf-8 -*-
"""生成一份演示数据，用于截图和首次体验。

用法：
    set STUDY_DB=demo.db && python demo_seed.py
    set STUDY_DB=demo.db && set PORT=8099 && python app.py

数据全部是虚构示例，不含任何真实记录：项目名、日志内容、时间分布都是编的。
"""
import json
import os
import sqlite3
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get("STUDY_DB") or os.path.join(HERE, "demo.db")
os.environ["STUDY_DB"] = DB

import app as platform  # noqa: E402  导入即建表

TODAY = date.today()
NOW = datetime.now().isoformat(timespec="seconds")
WEEK_CN = ["一", "二", "三", "四", "五", "六", "日"]


def iso(day):
    return day.isoformat()


def clear(db):
    for table in ("study_records", "plan_projects", "plan_tasks", "plan_items",
                  "plan_milestones", "plan_deadlines", "schedule_items",
                  "training_plans", "training_records", "hobby_plans",
                  "hobby_records", "month_notes"):
        try:
            db.execute("DELETE FROM %s" % table)
        except sqlite3.OperationalError:
            pass


def seed_study(db):
    """近 30 天的时间利用：工作日 7–10 小时，周末收着，隔天运动。"""
    for offset in range(29, -1, -1):
        day = TODAY - timedelta(days=offset)
        weekday = day.weekday()
        if weekday == 6:            # 周日休息
            base = 2.5
        elif weekday == 5:          # 周六半天
            base = 5.0
        else:
            base = 8.0 + (offset % 3) * 0.6
        research = round(base * 0.55, 1)
        dev = round(base * 0.28, 1)
        admin = round(base - research - dev, 1)
        sport = 1.5 if weekday in (0, 2, 4, 5) and offset % 2 == 0 else 0
        score = 88 - (offset % 5) * 2 if weekday < 5 else 92 - (offset % 3)
        db.execute(
            """INSERT OR REPLACE INTO study_records
            (study_date, weekday, morning, afternoon, evening, sport,
             llm_or, research_other, admin_work, note, source,
             sleep_time, wake_time, nap_hours, sleep_score, record_time, updated_at)
            VALUES (?, ?, 0, 0, 0, ?, ?, ?, ?, '', 'demo', '', '', 0, ?, ?, ?)""",
            (iso(day), "周" + WEEK_CN[weekday], sport, research, dev, admin,
             score, iso(day) + "T22:30", NOW),
        )


def seed_plans(db):
    """三层结构：项目 → 任务 → 事项；四列各放一两个，备忘录走独立任务。"""
    projects = [
        {
            "category": "research", "title": "论文第 6 稿", "start": -18, "end": 24,
            "pinned": 1, "sort": 0,
            "milestones": [("投稿前内部评审", 10)],
            "tasks": [
                ("数据补充", 3, [("补两组对照实验", -1, 1), ("核对统计口径", 2, 0), ("导出最终数据表", 3, 0)]),
                ("图表重绘", 9, [("图 1 重画", 5, 1), ("图 4 配色统一", 9, 0)]),
                ("回复审稿意见", 16, [("整理意见清单", 12, 0), ("逐条写回复", 16, 0)]),
                ("摘要润色", 2, [], 1),
            ],
        },
        {
            "category": "research", "title": "实验数据复核", "start": -6, "end": 12,
            "pinned": 0, "sort": 1,
            "milestones": [],
            "tasks": [
                ("核对统计口径", 5, [("重算置信区间", 5, 0)]),
                ("补跑两组对照", 11, [("对照组 A", 8, 0), ("对照组 B", 11, 0)]),
            ],
        },
        {
            "category": "dev", "title": "个人管理平台", "start": -30, "end": 30,
            "pinned": 0, "sort": 0,
            "milestones": [("v0.3 可对外演示", 18)],
            "tasks": [
                ("演示数据与文档", 1, [("写演示数据脚本", 1, 1), ("补 README 截图", 1, 0)]),
                ("桌面版打包", 4, [("换图标", 3, 0), ("关窗收服务", 4, 0)]),
                ("手势与快捷键", 7, [], 1),
            ],
        },
        {
            "category": "dev", "title": "数据看板改版", "start": -10, "end": 21,
            "pinned": 0, "sort": 1,
            "milestones": [],
            "tasks": [
                ("指标口径对齐", 8, [("和业务确认字段", 6, 0)]),
                ("图表面板重构", 14, [("拆组件", 10, 0), ("接新接口", 14, 0)]),
            ],
        },
        {
            "category": "admin", "title": "报销与合同", "start": -5, "end": "",
            "pinned": 0, "sort": 0,
            "milestones": [],
            "tasks": [
                ("差旅报销", 6, [("整理发票", 4, 1), ("填单", 6, 0)]),
                ("设备采购", 13, [("比价", 11, 0)]),
            ],
        },
    ]
    for project in projects:
        start = TODAY + timedelta(days=project["start"])
        end = TODAY + timedelta(days=project["end"]) if project["end"] else ""
        cursor = db.execute(
            """INSERT INTO plan_projects
            (category, title, period_days, deadline, start_date, end_date, pinned,
             archived, sort_order, created_at, updated_at, archived_at)
            VALUES (?, ?, 0, '', ?, ?, ?, 0, ?, ?, ?, '')""",
            (project["category"], project["title"], iso(start), iso(end) if end else "",
             project["pinned"], project["sort"],
             (start - timedelta(days=2)).isoformat() + "T09:00:00", NOW),
        )
        project_id = cursor.lastrowid
        for entry in project["tasks"]:
            title, due_offset = entry[0], entry[1]
            items = entry[2] if len(entry) > 2 else []
            done = entry[3] if len(entry) > 3 else 0
            task_due = iso(TODAY + timedelta(days=due_offset))
            task = db.execute(
                """INSERT INTO plan_tasks
                (project_id, title, due_date, pinned, done, repeat_weekday, created_at, updated_at)
                VALUES (?, ?, ?, 0, ?, -1, ?, ?)""",
                (project_id, title, task_due, done, NOW, NOW),
            )
            for item_title, item_offset, item_done in items:
                db.execute(
                    """INSERT INTO plan_items
                    (task_id, title, due_date, important, archived, archived_at,
                     done, created_at, updated_at)
                    VALUES (?, ?, ?, 0, 0, '', ?, ?, ?)""",
                    (task.lastrowid, item_title,
                     iso(TODAY + timedelta(days=item_offset)), item_done, NOW, NOW),
                )
        for title, due_offset in project["milestones"]:
            db.execute(
                "INSERT INTO plan_milestones (project_id, title, due_date, created_at) VALUES (?, ?, ?, ?)",
                (project_id, title, iso(TODAY + timedelta(days=due_offset)), NOW),
            )

    # 备忘录：不建项目，独立任务挂在 project_id=0 上
    memos = [
        ("读完《卡片笔记写作法》", 5, -1),
        ("整理实验记录", 2, -1),
        ("每周复盘", 4, 4),          # 周期任务：每周五
        ("体检预约", 20, -1),
    ]
    for title, due_offset, repeat in memos:
        db.execute(
            """INSERT INTO plan_tasks
            (project_id, title, due_date, pinned, done, repeat_weekday, created_at, updated_at)
            VALUES (0, ?, ?, 0, 0, ?, ?, ?)""",
            (title, iso(TODAY + timedelta(days=due_offset)), repeat, NOW, NOW),
        )


def seed_schedule(db):
    """本周的日程：色块 + 两条提醒，今天留几条已完成的。"""
    monday = TODAY - timedelta(days=TODAY.weekday())
    items = [
        (0, "09:00", "11:00", "论文方法章节", "research", "block", 1),
        (0, "14:00", "15:30", "平台联调", "dev", "block", 1),
        (0, "16:00", "17:00", "邮件与周报", "admin", "block", 0),
        (0, "19:30", "20:30", "羽毛球", "sport", "block", 0),
        (1, "10:00", "11:00", "组会", "research", "block", 1),
        (1, "13:30", "15:00", "数据补充", "research", "block", 0),
        (1, "20:00", "21:00", "阅读", "other", "block", 0),
        (2, "09:00", "10:30", "图表重绘", "research", "block", 1),
        (2, "11:00", "12:00", "报销单整理", "admin", "block", 1),
        (2, "14:00", "16:00", "平台开发", "dev", "block", 0),
        (2, "18:30", "19:30", "慢跑", "sport", "block", 0),
        (2, "21:00", "", "提交周报", "admin", "reminder", 1),
        (3, "08:30", "09:30", "论文精读", "research", "block", 1),
        (3, "10:00", "11:30", "接口联调", "dev", "block", 1),
        (3, "12:00", "13:00", "午餐 + 电话", "family", "block", 0),
        (3, "14:00", "15:30", "演示数据整理", "dev", "block", 0),
        (3, "16:00", "17:00", "讨论修改方案", "research", "block", 0),
        (3, "19:00", "", "取快递", "admin", "reminder", 0),
        (3, "20:00", "21:00", "游泳", "sport", "block", 0),
        (4, "09:00", "10:00", "组会", "research", "block", 0),
        (4, "13:00", "15:00", "图表定稿", "research", "block", 0),
        (4, "16:00", "17:30", "代码评审", "dev", "block", 0),
        (4, "19:00", "20:30", "看纪录片", "sport", "block", 0),
        (5, "09:30", "11:00", "徒步", "sport", "block", 1),
        (5, "14:00", "15:00", "家庭视频", "family", "block", 0),
        (5, "20:00", "22:00", "自由阅读", "other", "block", 0),
    ]
    for weekday, start, end, title, category, kind, done in items:
        day = monday + timedelta(days=weekday)
        db.execute(
            """INSERT INTO schedule_items
            (item_date, start_time, end_time, title, category, kind, done,
             week_start, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (iso(day), start, end, title, category, kind, done, iso(monday), NOW, NOW),
        )


def seed_training(db):
    records = [
        (-1, "combat", "羽毛球", [("19:00", "20:30")], 7, 7, "双打，状态一般"),
        (-2, "aerobic", "慢跑", [("07:00", "07:50")], 6, 7, "配速 6′20″"),
        (-4, "strength", "健身（器械）", [("18:30", "19:40")], 8, 8, "腿举加了两片"),
        (-6, "aerobic", "游泳", [("20:00", "21:00")], 7, 8, "自由泳 1 公里"),
        (-8, "combat", "足球", [("15:00", "16:30")], 8, 7, "五人制"),
        (-10, "rest", "完全休息", [], 3, 5, "刻意歇一天"),
        (-12, "strength", "核心与拉伸", [("21:00", "21:40")], 5, 7, ""),
        (-14, "aerobic", "骑行", [("09:00", "11:00")], 6, 8, "城郊往返"),
        (-17, "combat", "羽毛球", [("19:00", "20:40")], 8, 8, "混双"),
        (-20, "aerobic", "慢跑", [("07:00", "07:45")], 5, 6, "恢复跑"),
    ]
    for offset, category, activity, segments, intensity, performance, note in records:
        day = TODAY + timedelta(days=offset)
        db.execute(
            """INSERT INTO training_records
            (train_date, category, activity, segments, intensity, performance, note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (iso(day), category, activity,
             json.dumps([{"start": s, "end": e} for s, e in segments], ensure_ascii=False),
             intensity, performance, note, NOW),
        )
    for offset, category, activity in ((2, "combat", "足球"), (3, "aerobic", "游泳"), (5, "strength", "健身（器械）")):
        day = TODAY + timedelta(days=offset)
        db.execute(
            "INSERT OR REPLACE INTO training_plans (train_date, category, activity, updated_at) VALUES (?, ?, ?, ?)",
            (iso(day), category, activity, NOW),
        )


def seed_hobby(db):
    records = [
        (-1, "travel", "徒步", 150, 1, "城郊 12 公里，天气刚好"),
        (-3, "music", "专辑赏析", 60, 1, "老唱片重听"),
        (-5, "reading", "阅读", 90, 1, "读完后半本"),
        (-7, "film", "电影", 120, 1, "重看一部旧片"),
        (-9, "food", "自主烹饪", 75, 1, "试了个新菜"),
        (-11, "travel", "摄影纪实", 100, 1, "扫街"),
        (-14, "reading", "写作", 60, 1, ""),
        (-16, "food", "美食寻觅", 0, 0, "只打卡，没计时"),
    ]
    for offset, category, item, minutes, counted, note in records:
        day = TODAY + timedelta(days=offset)
        db.execute(
            """INSERT INTO hobby_records
            (record_date, category, item, minutes, counted, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (iso(day), category, item, minutes, counted, note, NOW),
        )
    for offset, category, item, note in (
        (2, "travel", "郊游", "看天气"),
        (4, "reading", "阅读", "继续下半本"),
        (7, "music", "Livehouse", "看排期"),
    ):
        day = TODAY + timedelta(days=offset)
        db.execute(
            """INSERT INTO hobby_plans (plan_date, category, item, note, done, created_at)
            VALUES (?, ?, ?, ?, 0, ?)""",
            (iso(day), category, item, note, NOW),
        )


def seed_journals():
    """工作日志页读的是 static/journals/<date>.json，这里造三天的虚构日志。"""
    folder = os.path.join(HERE, "static", "journals")
    os.makedirs(folder, exist_ok=True)
    samples = [
        (0, "把演示数据脚本补完整，五个页面都能看到像样的内容。顺手把 README 的截图流程跑通。",
         ["演示数据", "README 截图"], ["论文第 6 稿"]),
        (-1, "图表重绘推进到图 4，配色统一了一半；平台侧把日程视图的提醒改成时间点小条。",
         ["图表重绘", "日程视图"], ["论文第 6 稿"]),
        (-2, "补跑两组对照实验，统计口径和上周对齐；晚上整理了一版报销单。",
         ["对照实验", "报销单"], ["实验数据复核"]),
    ]
    for offset, summary, dev_points, research_points in samples:
        day = TODAY + timedelta(days=offset)
        payload = {
            "until": "02:00",
            "workSummary": summary,
            "summaryHighlights": {
                "项目开发": dev_points,
                "科研": research_points,
            },
            "coverage": "示例日志：内容为虚构演示，用于展示日志页的排版。",
            "projects": [
                {
                    "category": "项目开发",
                    "name": "个人管理平台",
                    "folder": "~/projects/personal-hub",
                    "sources": ["本地"],
                    "highlights": {"项目开发": dev_points},
                    "tasks": [[dev_points[0], "把这一项拆成可以验收的小步，先跑通再美化。"]],
                },
                {
                    "category": "科研",
                    "name": research_points[0],
                    "folder": "~/papers",
                    "sources": ["本地"],
                    "highlights": {"科研": research_points},
                    "tasks": [[research_points[0], "按审稿意见逐条核对，改动处标注版本号。"]],
                },
            ],
        }
        with open(os.path.join(folder, "%s.json" % iso(day)), "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)


def seed_month_note(db):
    month = TODAY.strftime("%Y-%m")
    db.execute(
        "INSERT OR REPLACE INTO month_notes (month, note, updated_at) VALUES (?, ?, ?)",
        (month, "演示数据：用来看四个页面长什么样，可以删库重来。", NOW),
    )


def main():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    clear(db)
    seed_study(db)
    seed_plans(db)
    seed_schedule(db)
    seed_training(db)
    seed_hobby(db)
    seed_journals()
    seed_month_note(db)
    db.commit()
    counts = {table: db.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]
              for table in ("study_records", "plan_projects", "plan_tasks", "plan_items",
                            "plan_milestones", "schedule_items", "training_records",
                            "hobby_records")}
    db.close()
    print("演示库：%s" % DB)
    print(counts)


if __name__ == "__main__":
    main()
