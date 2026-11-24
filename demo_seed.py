# -*- coding: utf-8 -*-
"""生成一份演示数据，用于截图和首次体验。

用法：
    set STUDY_DB=demo.db && python demo_seed.py
    set STUDY_DB=demo.db && set PORT=8099 && python app.py

数据全部是虚构示例，不含任何真实记录。
"""
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
    for table in ("study_records", "plan_projects", "plan_tasks", "plan_deadlines",
                  "schedule_items", "training_plans", "training_records",
                  "hobby_plans", "hobby_records", "month_notes"):
        db.execute("DELETE FROM %s" % table)


def seed_study(db):
    plan = [3.0, 4.5, 2.5, 5.0, 4.0, 3.5, 1.0]  # 一周的节奏，周日起休息
    for offset in range(27, -1, -1):
        day = TODAY - timedelta(days=offset)
        if offset > 20:
            continue
        base = plan[day.weekday()]
        research = round(base * 0.5, 1)
        dev = round(base * 0.3, 1)
        admin = round(base - research - dev, 1)
        sport = 1.5 if day.weekday() in (0, 2, 4, 5) else 0
        db.execute(
            """INSERT OR REPLACE INTO study_records
            (study_date, weekday, morning, afternoon, evening, sport,
             llm_or, research_other, admin_work, note, source,
             sleep_time, wake_time, nap_hours, sleep_score, record_time, updated_at)
            VALUES (?, ?, 0, 0, 0, ?, ?, ?, ?, '', 'demo', '', '', 0, ?, ?, ?)""",
            (iso(day), "周" + WEEK_CN[day.weekday()], sport, research, dev, admin,
             86 if day.weekday() < 5 else 92, NOW, NOW),
        )


def seed_plans(db):
    projects = [
        ("research", "论文第 6 稿", 45, -12, ["数据补充", "图表重绘", "回复审稿意见"]),
        ("dev", "个人管理平台", 60, -20, ["日程视图", "兴趣模块", "桌面壳"]),
        ("admin", "报销与合同", 30, -5, ["差旅报销", "设备采购"]),
        ("memo", "年度复盘", 0, -3, ["整理实验记录"]),
    ]
    for index, (category, title, period, start_offset, tasks) in enumerate(projects):
        start = TODAY + timedelta(days=start_offset)
        cursor = db.execute(
            """INSERT INTO plan_projects
            (category, title, period_days, deadline, start_date, pinned, archived, created_at, updated_at, archived_at)
            VALUES (?, ?, ?, '', ?, ?, 0, ?, ?, '')""",
            (category, title, period, iso(start), 1 if index == 0 else 0,
             (start - timedelta(days=1)).isoformat() + "T09:00:00", NOW),
        )
        project_id = cursor.lastrowid
        for offset, task_title in enumerate(tasks):
            due = start + timedelta(days=7 * (offset + 1))
            db.execute(
                """INSERT INTO plan_tasks (project_id, title, due_date, pinned, done, created_at, updated_at)
                VALUES (?, ?, ?, 0, ?, ?, ?)""",
                (project_id, task_title, iso(due) if period else "",
                 1 if offset == 0 and index == 1 else 0, NOW, NOW),
            )
        if index == 0:
            for due_offset in (30, 45):
                db.execute(
                    "INSERT INTO plan_deadlines (project_id, due_date, created_at) VALUES (?, ?, ?)",
                    (project_id, iso(start + timedelta(days=due_offset)), NOW),
                )


def seed_schedule(db):
    monday = TODAY - timedelta(days=TODAY.weekday())
    items = [
        (0, "09:00", "11:00", "论文方法章节", "research", "block", 1),
        (0, "14:00", "15:30", "平台联调", "dev", "block", 0),
        (1, "10:00", "11:00", "组会", "research", "block", 0),
        (2, "19:30", "20:30", "跑步与拉伸", "sport", "block", 0),
        (3, "09:30", "10:00", "周报提醒", "admin", "reminder", 0),
        (4, "20:00", "21:30", "看一部纪录片", "sport", "block", 0),
    ]
    for weekday, start, end, title, category, kind, done in items:
        day = monday + timedelta(days=weekday)
        if day > TODAY + timedelta(days=6):
            continue
        db.execute(
            """INSERT INTO schedule_items
            (item_date, start_time, end_time, title, category, kind, done, week_start, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (iso(day), start, end, title, category, kind, done,
             iso(monday), NOW, NOW),
        )


def seed_training(db):
    records = [
        (-1, "combat", "羽毛球", [("19:00", "20:30")], 7, 7, "双打，状态一般"),
        (-3, "strength", "健身（器械）", [("18:30", "19:40")], 8, 8, "腿举加了两片"),
        (-5, "aerobic", "慢跑", [("07:00", "07:50")], 6, 7, "配速 6′20″"),
        (-8, "rest", "完全休息", [], 3, 5, "刻意歇一天"),
    ]
    for offset, category, activity, segments, intensity, performance, note in records:
        day = TODAY + timedelta(days=offset)
        db.execute(
            """INSERT INTO training_records
            (train_date, category, activity, segments, intensity, performance, note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (iso(day), category, activity,
             str([{"start": start, "end": end} for start, end in segments]).replace("'", '"'),
             intensity, performance, note, NOW),
        )
    for offset, category, activity in ((2, "combat", "足球"), (4, "aerobic", "游泳")):
        day = TODAY + timedelta(days=offset)
        db.execute(
            "INSERT OR REPLACE INTO training_plans (train_date, category, activity, updated_at) VALUES (?, ?, ?, ?)",
            (iso(day), category, activity, NOW),
        )


def seed_hobby(db):
    records = [
        (-2, "travel", "徒步", 150, 1, "城郊 12 公里"),
        (-4, "music", "专辑赏析", 60, 1, "老唱片重听"),
        (-6, "reading", "阅读", 90, 1, "读完后半本"),
        (-9, "film", "电影", 120, 1, ""),
        (-11, "food", "自主烹饪", 0, 0, "只打卡，没计时"),
    ]
    for offset, category, item, minutes, counted, note in records:
        day = TODAY + timedelta(days=offset)
        db.execute(
            """INSERT INTO hobby_records (record_date, category, item, minutes, counted, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (iso(day), category, item, minutes, counted, note, NOW),
        )
    for offset, category, item, note in ((3, "travel", "郊游", "看天气"), (6, "reading", "写作", "整理笔记")):
        day = TODAY + timedelta(days=offset)
        db.execute(
            "INSERT INTO hobby_plans (plan_date, category, item, note, done, created_at) VALUES (?, ?, ?, ?, 0, ?)",
            (iso(day), category, item, note, NOW),
        )


def seed_month_note(db):
    month = TODAY.strftime("%Y-%m")
    db.execute(
        "INSERT OR REPLACE INTO month_notes (month, note, updated_at) VALUES (?, ?, ?)",
        (month, "演示数据：用于展示四个子页面的样子，可以直接删库重来。", NOW),
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
    seed_month_note(db)
    db.commit()
    counts = {table: db.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]
              for table in ("study_records", "plan_projects", "plan_tasks", "plan_deadlines",
                            "schedule_items", "training_records", "hobby_records")}
    db.close()
    print("演示库：%s" % DB)
    print(counts)


if __name__ == "__main__":
    main()
