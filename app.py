# -*- coding: utf-8 -*-
"""Industrial Engineering-style monthly study time tracker."""
import calendar
import json
import os
import sqlite3
from datetime import date, datetime, timedelta
from flask import Flask, jsonify, redirect, render_template, request, g, url_for

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("STUDY_DB") or os.path.join(BASE_DIR, "study-time.db")
PORT = int(os.environ.get("PORT", "8012"))
app = Flask(__name__)
# 模板 / 静态文件即时生效：否则进程一旦启动就会一直返回启动时缓存的旧 index.html，
# 页面结构与最新的 app.js 不匹配（缺少节点）会让前端脚本整体报错。
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

# 统计口径切换日：此前按「早上 / 下午 / 晚上 + 运动」，此后按四类时长记录。
# 这是作者自用的口径分界，换一个使用者时直接改这两个日期即可（字段名保持兼容）。
NEW_SCHEME_START = date(2026, 10, 25)
# 同一天起睡眠改为 0–100 的评分，>90 视为达标
NEW_SLEEP_SCORE_START = date(2026, 11, 7)
LEGACY_FIELDS = ("morning", "afternoon", "evening", "sport")
NEW_FIELDS = ("llm_or", "research_other", "admin_work", "sport")
TIME_FIELDS = ("morning", "afternoon", "evening", "sport", "llm_or", "research_other", "admin_work")


def is_new_scheme(study_date):
    return date.fromisoformat(study_date) >= NEW_SCHEME_START


# 运动训练：三大类 + 休息。每周节奏固定：一/三 有氧，二/四 力量，五/六 对抗，日 休息。
# 不再按日期自动排计划，也不限制起止日期：所有日期都可以自行计划或记录。
TRAINING_CATEGORIES = [
    {"id": "aerobic", "name": "有氧运动", "short": "有氧",
     "activities": ["游泳", "慢走", "慢跑", "骑行", "跳绳", "爬楼"]},
    {"id": "strength", "name": "核心与力量训练", "short": "力量",
     "activities": ["健身（器械）", "自重训练", "核心训练", "拉伸放松"]},
    {"id": "combat", "name": "综合对抗训练", "short": "对抗",
     "activities": ["足球", "羽毛球", "篮球", "乒乓球", "网球"]},
    {"id": "rest", "name": "休息", "short": "休息",
     "activities": ["完全休息", "散步", "拉伸"]},
]
TRAINING_CATEGORY_MAP = {item["id"]: item for item in TRAINING_CATEGORIES}
WEEK_PLAN = ["aerobic", "strength", "aerobic", "strength", "combat", "combat", "rest"]
WEEKDAY_CN = ["一", "二", "三", "四", "五", "六", "日"]

# 日程安排：任务分类与配色（iOS 日历左侧列表）
SCHEDULE_CATEGORIES = [
    {"id": "research", "name": "核心科研", "color": "#fa2d55"},
    {"id": "dev", "name": "项目开发", "color": "#f59e0b"},
    {"id": "admin", "name": "其它事务", "color": "#f2c744"},
    {"id": "sport", "name": "运动娱乐", "color": "#4a9fe0"},
    {"id": "family", "name": "陪伴亲友", "color": "#34c759"},
    {"id": "other", "name": "其他事项", "color": "#8e8e93"},
]
SCHEDULE_CATEGORY_MAP = {item["id"]: item for item in SCHEDULE_CATEGORIES}

# 规划与事项：四列看板
PLAN_CATEGORIES = [
    {"id": "research", "name": "核心科研", "color": "#3fae6d", "deep": "#1f7a46"},
    {"id": "dev", "name": "项目开发", "color": "#8fd694", "deep": "#4f9e5c"},
    {"id": "admin", "name": "其它事务", "color": "#f2c744", "deep": "#b58a12"},
    {"id": "memo", "name": "备忘录", "color": "#8e8e93", "deep": "#5c5c61"},
]
PLAN_CATEGORY_MAP = {item["id"]: item for item in PLAN_CATEGORIES}

# 体育兴趣：兴趣的五类与具体项。记录只记时长（默认 120 分钟，也可以不计时）
HOBBY_CATEGORIES = [
    {"id": "travel", "name": "旅行类", "short": "旅行", "color": "#5aa9e6", "deep": "#2b6ea8",
     "items": ["徒步", "郊游", "人文旅行", "自然旅行", "摄影纪实"]},
    {"id": "music", "name": "音乐类", "short": "音乐", "color": "#b48ede", "deep": "#6d4b9b",
     "items": ["专辑赏析", "音乐史", "Livehouse"]},
    {"id": "reading", "name": "阅读类", "short": "阅读", "color": "#8fd694", "deep": "#4f9e5c",
     "items": ["阅读", "写作"]},
    {"id": "film", "name": "影视类", "short": "影视", "color": "#f2b544", "deep": "#a57513",
     "items": ["电影", "纪录片", "视频剪辑"]},
    {"id": "food", "name": "美食类", "short": "美食", "color": "#f08a7a", "deep": "#a94a3c",
     "items": ["美食寻觅", "自主烹饪"]},
]
HOBBY_CATEGORY_MAP = {item["id"]: item for item in HOBBY_CATEGORIES}
HOBBY_DEFAULT_MINUTES = 120


def week_start_for(value):
    day = date.fromisoformat(value) if isinstance(value, str) else value
    return day - timedelta(days=day.weekday())


def current_week_start():
    return week_start_for(date.today())


def is_sleep_score(study_date):
    return date.fromisoformat(study_date) >= NEW_SLEEP_SCORE_START


def is_editable(study_date):
    # 10/24 及以前只读；10/25 起随时可修改
    return date.fromisoformat(study_date) >= NEW_SCHEME_START


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_error=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute(
        """CREATE TABLE IF NOT EXISTS study_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            study_date TEXT NOT NULL UNIQUE,
            weekday TEXT NOT NULL,
            morning REAL NOT NULL DEFAULT 0,
            afternoon REAL NOT NULL DEFAULT 0,
            evening REAL NOT NULL DEFAULT 0,
            sport REAL NOT NULL DEFAULT 0,
            llm_or REAL NOT NULL DEFAULT 0,
            research_other REAL NOT NULL DEFAULT 0,
            admin_work REAL NOT NULL DEFAULT 0,
            sleep_time TEXT NOT NULL DEFAULT '',
            wake_time TEXT NOT NULL DEFAULT '',
            nap_hours REAL NOT NULL DEFAULT 0,
            sleep_score INTEGER NOT NULL DEFAULT 0,
            record_time TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '手动记录',
            updated_at TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS month_notes (
            month TEXT PRIMARY KEY,
            note TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        )"""
    )
    # 运动训练：计划与记录分开存，一个日期最多各一条
    db.execute(
        """CREATE TABLE IF NOT EXISTS training_plans (
            train_date TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            activity TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS training_records (
            train_date TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            activity TEXT NOT NULL DEFAULT '',
            segments TEXT NOT NULL DEFAULT '[]',
            intensity INTEGER NOT NULL DEFAULT 0,
            performance INTEGER NOT NULL DEFAULT 0,
            note TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        )"""
    )
    # 日程安排：按周存，week_start 用于每周自动清理
    db.execute(
        """CREATE TABLE IF NOT EXISTS schedule_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'block',
            done INTEGER NOT NULL DEFAULT 0,
            week_start TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_schedule_week ON schedule_items(week_start)")
    # 规划与事项：项目 + 任务，归档进回收站
    db.execute(
        """CREATE TABLE IF NOT EXISTS plan_projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            title TEXT NOT NULL,
            period_days INTEGER NOT NULL DEFAULT 30,
            deadline TEXT NOT NULL DEFAULT '',
            pinned INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT NOT NULL DEFAULT ''
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS plan_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            due_date TEXT NOT NULL DEFAULT '',
            pinned INTEGER NOT NULL DEFAULT 0,
            done INTEGER NOT NULL DEFAULT 0,
            repeat_weekday INTEGER NOT NULL DEFAULT -1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_plan_tasks_project ON plan_tasks(project_id)")
    task_columns = {row[1] for row in db.execute("PRAGMA table_info(plan_tasks)").fetchall()}
    if "repeat_weekday" not in task_columns:
        # -1 = 不重复；0–6 = 每周一…每周日
        db.execute("ALTER TABLE plan_tasks ADD COLUMN repeat_weekday INTEGER NOT NULL DEFAULT -1")
    if "active" not in task_columns:
        # 点亮灯泡 = 正在做；项目收起时这类任务仍然露出来
        db.execute("ALTER TABLE plan_tasks ADD COLUMN active INTEGER NOT NULL DEFAULT 0")
    if "archived" not in task_columns:
        # 备忘录的独立任务勾完自动归档，进回收站可恢复
        db.execute("ALTER TABLE plan_tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        db.execute("ALTER TABLE plan_tasks ADD COLUMN archived_at TEXT NOT NULL DEFAULT ''")
    # 历史遗留：备忘录里早已勾完、但还没归档的独立任务，补进归档（幂等）
    db.execute(
        """UPDATE plan_tasks
        SET archived=1,
            archived_at=CASE WHEN COALESCE(archived_at,'')=''
                THEN COALESCE(NULLIF(updated_at,''), ?) ELSE archived_at END
        WHERE project_id=0 AND done=1 AND archived=0""",
        (datetime.now().isoformat(timespec="seconds"),),
    )
    # 事项：挂在任务下面，一条一条，默认没有结束日期
    db.execute(
        """CREATE TABLE IF NOT EXISTS plan_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            due_date TEXT NOT NULL DEFAULT '',
            important INTEGER NOT NULL DEFAULT 0,
            done INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            archived_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_plan_items_task ON plan_items(task_id)")
    item_columns = {row[1] for row in db.execute("PRAGMA table_info(plan_items)").fetchall()}
    if "done" not in item_columns:
        db.execute("ALTER TABLE plan_items ADD COLUMN done INTEGER NOT NULL DEFAULT 0")
    # 阶段性目标：一个项目可以有多个，每条是「日期 + 内容」，与任务相互独立
    db.execute(
        """CREATE TABLE IF NOT EXISTS plan_milestones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            due_date TEXT NOT NULL,
            created_at TEXT NOT NULL
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_plan_milestones_project ON plan_milestones(project_id)")
    plan_columns = {row[1] for row in db.execute("PRAGMA table_info(plan_projects)").fetchall()}
    if "start_date" not in plan_columns:
        db.execute("ALTER TABLE plan_projects ADD COLUMN start_date TEXT NOT NULL DEFAULT ''")
        db.execute("UPDATE plan_projects SET start_date = substr(created_at, 1, 10)")
    # 拖动换位用：同分类里的先后序号
    if "sort_order" not in plan_columns:
        db.execute("ALTER TABLE plan_projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        for category in ("research", "dev", "admin", "memo"):
            rows = db.execute(
                "SELECT id FROM plan_projects WHERE category=? ORDER BY created_at, id",
                (category,),
            ).fetchall()
            for index, row in enumerate(rows):
                db.execute("UPDATE plan_projects SET sort_order=? WHERE id=?", (index, row["id"]))
    # 旧版只有「周期天数」，没有结束日期：按开始日期 + 周期把 end_date 补出来
    if "end_date" not in plan_columns:
        db.execute("ALTER TABLE plan_projects ADD COLUMN end_date TEXT NOT NULL DEFAULT ''")
        for legacy in db.execute(
            "SELECT id, start_date, period_days, created_at FROM plan_projects"
        ).fetchall():
            base = legacy["start_date"] or legacy["created_at"][:10]
            try:
                days = int(legacy["period_days"] or 0)
            except (TypeError, ValueError):
                days = 0
            if days <= 0:
                continue
            try:
                end = (date.fromisoformat(base) + timedelta(days=days)).isoformat()
            except ValueError:
                continue
            db.execute("UPDATE plan_projects SET end_date=? WHERE id=?", (end, legacy["id"]))
    # 旧版「截止日期」表只有日期没有内容：整体搬到阶段性目标，表改名留档
    legacy_deadlines = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='plan_deadlines'"
    ).fetchone()
    if legacy_deadlines:
        for legacy in db.execute("SELECT * FROM plan_deadlines").fetchall():
            db.execute(
                "INSERT INTO plan_milestones (project_id, title, due_date, created_at) VALUES (?, '', ?, ?)",
                (legacy["project_id"], legacy["due_date"], legacy["created_at"]),
            )
        db.execute("ALTER TABLE plan_deadlines RENAME TO plan_deadlines_legacy")
    # 更早的单值 deadline 列
    for legacy_row in db.execute(
        "SELECT id, deadline FROM plan_projects WHERE deadline != ''"
    ).fetchall():
        exists = db.execute(
            "SELECT 1 FROM plan_milestones WHERE project_id=? AND due_date=?",
            (legacy_row["id"], legacy_row["deadline"]),
        ).fetchone()
        if not exists:
            db.execute(
                "INSERT INTO plan_milestones (project_id, title, due_date, created_at) VALUES (?, '', ?, ?)",
                (legacy_row["id"], legacy_row["deadline"],
                 datetime.now().isoformat(timespec="seconds")),
            )
    # 备忘录只放任务：历史上建在「备忘录」分类下的项目，转成独立任务（project_id=0），
    # 子任务与阶段性目标转成它的事项
    for legacy in db.execute(
        "SELECT * FROM plan_projects WHERE category='memo' AND archived=0"
    ).fetchall():
        stamp = datetime.now().isoformat(timespec="seconds")
        cursor = db.execute(
            """INSERT INTO plan_tasks
            (project_id, title, due_date, pinned, done, created_at, updated_at)
            VALUES (0, ?, ?, ?, 0, ?, ?)""",
            (legacy["title"], legacy["end_date"] or "", legacy["pinned"],
             legacy["created_at"], stamp),
        )
        new_task_id = cursor.lastrowid
        for child in db.execute(
            "SELECT * FROM plan_tasks WHERE project_id=?", (legacy["id"],)
        ).fetchall():
            db.execute(
                """INSERT INTO plan_items
                (task_id, title, due_date, important, archived, archived_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, 0, '', ?, ?)""",
                (new_task_id, child["title"], child["due_date"], child["pinned"],
                 child["created_at"], stamp),
            )
        for milestone in db.execute(
            "SELECT * FROM plan_milestones WHERE project_id=?", (legacy["id"],)
        ).fetchall():
            db.execute(
                """INSERT INTO plan_items
                (task_id, title, due_date, important, archived, archived_at, created_at, updated_at)
                VALUES (?, ?, ?, 0, 0, '', ?, ?)""",
                (new_task_id, milestone["title"] or "阶段性目标", milestone["due_date"],
                 milestone["created_at"], stamp),
            )
        db.execute("DELETE FROM plan_tasks WHERE project_id=?", (legacy["id"],))
        db.execute("DELETE FROM plan_milestones WHERE project_id=?", (legacy["id"],))
        db.execute("DELETE FROM plan_projects WHERE id=?", (legacy["id"],))
    # 体育兴趣：计划与记录分开，只记时长，不记时段
    db.execute(
        """CREATE TABLE IF NOT EXISTS hobby_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_date TEXT NOT NULL,
            category TEXT NOT NULL,
            item TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            done INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS hobby_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            record_date TEXT NOT NULL,
            category TEXT NOT NULL,
            item TEXT NOT NULL,
            minutes INTEGER NOT NULL DEFAULT 0,
            counted INTEGER NOT NULL DEFAULT 1,
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_hobby_plan_date ON hobby_plans(plan_date)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_hobby_record_date ON hobby_records(record_date)")
    # 旧版「一天一条，计划和打卡合在一起」的表：拆成计划 + 记录后改名留档
    legacy = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='training_days'"
    ).fetchone()
    if legacy:
        for row in db.execute("SELECT * FROM training_days").fetchall():
            if row["category"]:
                db.execute(
                    """INSERT OR IGNORE INTO training_plans
                    (train_date, category, activity, updated_at) VALUES (?, ?, ?, ?)""",
                    (row["train_date"], row["category"], row["activity"], row["updated_at"]),
                )
            if row["done"]:
                db.execute(
                    """INSERT OR IGNORE INTO training_records
                    (train_date, category, activity, segments, intensity, performance, note, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (row["train_date"], row["category"], row["activity"], row["segments"],
                     row["intensity"], row["performance"], row["note"], row["updated_at"]),
                )
        db.execute("ALTER TABLE training_days RENAME TO training_days_legacy")
    # 兼容旧数据库：补上新统计方式与睡眠字段
    columns = {row[1] for row in db.execute("PRAGMA table_info(study_records)").fetchall()}
    for column in ("llm_or", "research_other", "admin_work"):
        if column not in columns:
            db.execute(f"ALTER TABLE study_records ADD COLUMN {column} REAL NOT NULL DEFAULT 0")
    for column, definition in (
        ("sleep_time", "TEXT NOT NULL DEFAULT ''"),
        ("wake_time", "TEXT NOT NULL DEFAULT ''"),
        ("nap_hours", "REAL NOT NULL DEFAULT 0"),
        ("sleep_score", "INTEGER NOT NULL DEFAULT 0"),
        ("record_time", "TEXT NOT NULL DEFAULT ''"),
    ):
        if column not in columns:
            db.execute(f"ALTER TABLE study_records ADD COLUMN {column} {definition}")
    db.commit()
    db.close()


def parse_clock(value):
    try:
        parsed = datetime.strptime(str(value or ""), "%H:%M")
        return parsed.hour * 60 + parsed.minute
    except (TypeError, ValueError):
        return None


def normalize_clock(value):
    """统一睡眠时间粒度：四舍五入到 10 分钟。"""
    try:
        parsed = datetime.strptime(str(value or ""), "%H:%M")
    except (TypeError, ValueError):
        return ""
    total_minutes = (parsed.hour * 60 + parsed.minute + 5) // 10 * 10
    total_minutes %= 1440
    return f"{total_minutes // 60:02d}:{total_minutes % 60:02d}"


def normalize_half_hour(value):
    """记录时间只保留半小时粒度。"""
    try:
        parsed = datetime.strptime(str(value or ""), "%H:%M")
    except (TypeError, ValueError):
        return ""
    total_minutes = (parsed.hour * 60 + parsed.minute + 15) // 30 * 30
    total_minutes %= 1440
    return f"{total_minutes // 60:02d}:{total_minutes % 60:02d}"


def sleep_payload(item):
    if is_sleep_score(item["study_date"]):
        score = int(round(float(item.get("sleep_score") or 0)))
        return {
            "sleep_score": score,
            "sleep_method": "score",
            "sleep_total": 0,
            "bedtime_ok": False,
            "sleep_ok": score > 90,
        }
    bedtime = normalize_clock(item.get("sleep_time"))
    wake = normalize_clock(item.get("wake_time"))
    item["sleep_time"] = bedtime
    item["wake_time"] = wake
    nap = float(item.get("nap_hours") or 0)
    bed_minutes = parse_clock(bedtime)
    wake_minutes = parse_clock(wake)
    if bed_minutes is None or wake_minutes is None:
        return {"sleep_total": 0, "bedtime_ok": False, "sleep_ok": False, "sleep_score": 0, "sleep_method": "time"}
    # 入睡时间需在 00:30 及以前（含前一日 18:00 之后的正常夜间入睡）
    bedtime_ok = bed_minutes <= 30 or bed_minutes >= 18 * 60
    night_minutes = (wake_minutes - bed_minutes) % 1440
    sleep_total = round(night_minutes / 60 + nap, 2)
    return {
        "sleep_total": sleep_total,
        "bedtime_ok": bedtime_ok,
        "sleep_ok": bedtime_ok and sleep_total >= 8,
        "sleep_score": 0,
        "sleep_method": "time",
    }


def row_payload(row):
    item = dict(row)
    scheme = "new" if is_new_scheme(item["study_date"]) else "legacy"
    if scheme == "new":
        item["study_total"] = round(item["llm_or"] + item["research_other"] + item["admin_work"], 2)
    else:
        item["study_total"] = round(item["morning"] + item["afternoon"] + item["evening"], 2)
    item["total"] = round(item["study_total"] + item["sport"], 2)
    item["scheme"] = scheme
    item["editable"] = is_editable(item["study_date"])
    item["record_time"] = normalize_half_hour(item.get("record_time"))
    item.update(sleep_payload(item))
    return item


def month_days(month_value):
    year, month = (int(part) for part in month_value.split("-"))
    if year < 2000 or year > 2100 or month < 1 or month > 12:
        raise ValueError("月份格式无效")
    first = date(year, month, 1)
    return year, month, [first + timedelta(days=i) for i in range(calendar.monthrange(year, month)[1])]


def month_payload(month_value):
    year, month, days = month_days(month_value)
    db = get_db()
    rows = {
        row["study_date"]: row_payload(row)
        for row in db.execute(
            "SELECT * FROM study_records WHERE study_date LIKE ? ORDER BY study_date",
            (f"{month_value}-%",),
        ).fetchall()
    }
    records = []
    for day in days:
        key = day.isoformat()
        scheme = "new" if is_new_scheme(key) else "legacy"
        record = rows.get(key, {
            "study_date": key,
            "weekday": f"周{['一', '二', '三', '四', '五', '六', '日'][day.weekday()]}",
            "morning": 0,
            "afternoon": 0,
            "evening": 0,
            "sport": 0,
            "llm_or": 0,
            "research_other": 0,
            "admin_work": 0,
            "sleep_time": "",
            "wake_time": "",
            "nap_hours": 0,
            "sleep_score": 0,
            "record_time": "",
            "note": "",
            "source": "未记录",
            "updated_at": "",
            "scheme": scheme,
            "editable": is_editable(key),
            "study_total": 0,
            "total": 0,
            "sleep_total": 0,
            "bedtime_ok": False,
            "sleep_ok": False,
            "sleep_method": "score" if is_sleep_score(key) else "time",
        })
        records.append(record)
    totals = {key: round(sum(item[key] for item in records), 2) for key in TIME_FIELDS}
    totals["study_total"] = round(sum(totals[k] for k in ("morning", "afternoon", "evening", "llm_or", "research_other", "admin_work")), 2)
    totals["total"] = round(totals["study_total"] + totals["sport"], 2)
    active = [item for item in records if item["total"] > 0]
    totals["active_days"] = len(active)
    totals["average"] = round(totals["total"] / len(active), 2) if active else 0
    totals["max_day"] = max((item["total"] for item in records), default=0)
    month_note = db.execute("SELECT note FROM month_notes WHERE month=?", (month_value,)).fetchone()
    return {
        "month": month_value,
        "year": year,
        "month_number": month,
        "records": records,
        "totals": totals,
        "month_note": month_note["note"] if month_note else "",
        "new_scheme_start": NEW_SCHEME_START.isoformat(),
        "sleep_score_start": NEW_SLEEP_SCORE_START.isoformat(),
        "editable_from": NEW_SCHEME_START.isoformat(),
    }


@app.route("/")
def index():
    # 四个子页面里默认打开日程安排
    return redirect(url_for("schedule"))


@app.route("/time")
def time_stats():
    return render_template("index.html")


@app.route("/study")
def study():
    # 旧地址，统一跳到时间统计
    return redirect(url_for("time_stats"))


@app.route("/sport")
def sport():
    return render_template("sport.html")


@app.route("/training")
def training():
    return redirect(url_for("sport"))


@app.route("/schedule")
def schedule():
    return render_template("schedule.html")

@app.route("/planner")
def planner():
    return render_template("planner.html")


@app.route("/journal")
def journal():
    return render_template("journal.html")


@app.route("/api/month")
def api_month():
    month_value = request.args.get("month") or date.today().strftime("%Y-%m")
    try:
        return jsonify(month_payload(month_value))
    except (ValueError, TypeError):
        return jsonify({"error": "月份格式应为 YYYY-MM"}), 400


@app.route("/api/month-note", methods=["PATCH"])
def api_month_note():
    body = request.get_json(silent=True) or {}
    month_value = str(body.get("month") or "").strip()
    try:
        month_days(month_value)
    except (ValueError, TypeError):
        return jsonify({"error": "月份格式应为 YYYY-MM"}), 400
    note = str(body.get("note") or "")[:300]
    now = datetime.now().isoformat(timespec="seconds")
    db = get_db()
    db.execute("INSERT INTO month_notes(month, note, updated_at) VALUES (?, ?, ?) ON CONFLICT(month) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at", (month_value, note, now))
    db.commit()
    return jsonify({"month": month_value, "note": note, "updated_at": now})


@app.route("/api/records/<study_date>", methods=["PATCH"])
def api_record_update(study_date):
    try:
        parsed = date.fromisoformat(study_date)
    except ValueError:
        return jsonify({"error": "日期格式无效"}), 400
    if not is_editable(study_date):
        return jsonify({"error": "10/24 及以前的历史数据已锁定，10/25 起可随时修改"}), 403
    scheme = "new" if is_new_scheme(study_date) else "legacy"
    uses_sleep_score = is_sleep_score(study_date)
    numeric_fields = list(NEW_FIELDS if scheme == "new" else LEGACY_FIELDS)
    numeric_fields.append("sleep_score" if uses_sleep_score else "nap_hours")
    body = request.get_json(silent=True) or {}
    fields = {}
    for field in numeric_fields:
        if field in body:
            try:
                value = float(body[field])
            except (TypeError, ValueError):
                return jsonify({"error": f"{field} 必须是数字"}), 400
            if field == "sleep_score":
                if value < 0 or value > 100:
                    return jsonify({"error": "iWatch 睡眠评分应在 0 到 100 之间"}), 400
                fields[field] = int(round(value))
                continue
            if value < 0 or value > 24:
                return jsonify({"error": "单个时段应在 0 到 24 小时之间"}), 400
            # 统一按 0.5 小时记录（四舍五入）
            fields[field] = round(int(value * 2 + 0.5) / 2, 1)
    if not uses_sleep_score:
        for field in ("sleep_time", "wake_time"):
            if field in body:
                raw = str(body[field] or "").strip()
                if raw:
                    try:
                        datetime.strptime(raw, "%H:%M")
                    except ValueError:
                        return jsonify({"error": f"{field} 应为 HH:MM 格式"}), 400
                    fields[field] = normalize_clock(raw)
                else:
                    fields[field] = ""
    if scheme == "new":
        if "record_time" in body:
            raw = str(body["record_time"] or "").strip()
            if raw:
                try:
                    datetime.strptime(raw, "%H:%M")
                except ValueError:
                    return jsonify({"error": "record_time 应为 HH:MM 格式"}), 400
                fields["record_time"] = normalize_half_hour(raw)
            else:
                fields["record_time"] = ""
    if "note" in body:
        fields["note"] = str(body["note"] or "")[:500]
    if not fields:
        return jsonify({"error": "没有可更新的字段"}), 400
    fields["updated_at"] = datetime.now().isoformat(timespec="seconds")
    weekday = f"周{['一', '二', '三', '四', '五', '六', '日'][parsed.weekday()]}"
    db = get_db()
    existing = db.execute("SELECT id FROM study_records WHERE study_date=?", (study_date,)).fetchone()
    if existing:
        assignments = ", ".join(f"{field}=?" for field in fields)
        db.execute(f"UPDATE study_records SET {assignments}, source='手动修改' WHERE study_date=?", tuple(fields.values()) + (study_date,))
    else:
        values = {
            "morning": 0,
            "afternoon": 0,
            "evening": 0,
            "sport": 0,
            "llm_or": 0,
            "research_other": 0,
            "admin_work": 0,
            "sleep_time": "",
            "wake_time": "",
            "nap_hours": 0,
            "sleep_score": 0,
            "record_time": "",
            "note": "",
            **fields,
        }
        db.execute(
            """INSERT INTO study_records
            (study_date, weekday, morning, afternoon, evening, sport,
             llm_or, research_other, admin_work,
             sleep_time, wake_time, nap_hours, sleep_score, record_time, note, source, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '手动记录', ?)""",
            (
                study_date,
                weekday,
                values["morning"],
                values["afternoon"],
                values["evening"],
                values["sport"],
                values["llm_or"],
                values["research_other"],
                values["admin_work"],
                values["sleep_time"],
                values["wake_time"],
                values["nap_hours"],
                values["sleep_score"],
                values["record_time"],
                values["note"],
                values["updated_at"],
            ),
        )
    db.commit()
    row = db.execute("SELECT * FROM study_records WHERE study_date=?", (study_date,)).fetchone()
    return jsonify(row_payload(row))


@app.route("/api/records/<study_date>", methods=["DELETE"])
def api_delete_record(study_date):
    try:
        date.fromisoformat(study_date)
    except ValueError:
        return jsonify({"error": "日期格式无效"}), 400
    if not is_editable(study_date):
        return jsonify({"error": "10/24 及以前的历史数据已锁定，不能删除"}), 403
    db = get_db()
    db.execute("DELETE FROM study_records WHERE study_date=?", (study_date,))
    db.commit()
    return jsonify({"ok": True, "study_date": study_date})


def clock_minutes(value):
    try:
        parsed = datetime.strptime(str(value or "").strip(), "%H:%M")
    except (TypeError, ValueError):
        return None
    return parsed.hour * 60 + parsed.minute


def training_segment_payload(raw):
    if not isinstance(raw, dict):
        raise ValueError("时段格式无效")
    start = clock_minutes(raw.get("start"))
    end = clock_minutes(raw.get("end"))
    if start is None or end is None:
        raise ValueError("每个时段都要填开始与结束时间")
    minutes = end - start
    if minutes <= 0:
        minutes += 1440
    if minutes > 720:
        raise ValueError("单个时段不能超过 12 小时")
    return {"start": f"{start // 60:02d}:{start % 60:02d}",
            "end": f"{end // 60:02d}:{end % 60:02d}",
            "minutes": minutes}


def training_segments(raw_value):
    try:
        raw_segments = json.loads(raw_value or "[]")
    except (TypeError, ValueError):
        raw_segments = []
    segments = []
    for raw in raw_segments if isinstance(raw_segments, list) else []:
        start = clock_minutes(raw.get("start")) if isinstance(raw, dict) else None
        end = clock_minutes(raw.get("end")) if isinstance(raw, dict) else None
        if start is None or end is None:
            continue
        minutes = end - start
        if minutes <= 0:
            minutes += 1440
        segments.append({"start": f"{start // 60:02d}:{start % 60:02d}",
                         "end": f"{end // 60:02d}:{end % 60:02d}",
                         "minutes": minutes})
    return segments


def training_plan_payload(row):
    if not row or row["category"] not in TRAINING_CATEGORY_MAP:
        return None
    category = row["category"]
    return {
        "category": category,
        "short": TRAINING_CATEGORY_MAP[category]["short"],
        "name": TRAINING_CATEGORY_MAP[category]["name"],
        "activity": row["activity"] or "",
    }


def training_record_payload(row):
    if not row or row["category"] not in TRAINING_CATEGORY_MAP:
        return None
    category = row["category"]
    segments = training_segments(row["segments"])
    minutes = sum(item["minutes"] for item in segments)
    return {
        "category": category,
        "short": TRAINING_CATEGORY_MAP[category]["short"],
        "name": TRAINING_CATEGORY_MAP[category]["name"],
        "activity": row["activity"] or "",
        "segments": segments,
        "minutes": minutes,
        "hours": round(minutes / 60, 1),
        "intensity": int(row["intensity"]),
        "performance": int(row["performance"]),
        "note": row["note"],
    }


def training_day_payload(train_date, plan_row, record_row):
    day = date.fromisoformat(train_date)
    plan = training_plan_payload(plan_row)
    record = training_record_payload(record_row)
    return {
        "date": train_date,
        "weekday": f"周{WEEKDAY_CN[day.weekday()]}",
        "plan": plan,
        "record": record,
        "state": "recorded" if record else ("planned" if plan else "blank"),
    }


def training_month_payload(month_value):
    year, month, days = month_days(month_value)
    db = get_db()
    plans = {
        row["train_date"]: row
        for row in db.execute(
            "SELECT * FROM training_plans WHERE train_date LIKE ?", (f"{month_value}-%",)
        ).fetchall()
    }
    records = {
        row["train_date"]: row
        for row in db.execute(
            "SELECT * FROM training_records WHERE train_date LIKE ?", (f"{month_value}-%",)
        ).fetchall()
    }
    out = [
        training_day_payload(day.isoformat(), plans.get(day.isoformat()), records.get(day.isoformat()))
        for day in days
    ]
    recorded = [item["record"] for item in out if item["record"]]
    total_minutes = sum(item["minutes"] for item in recorded)
    rated = [item for item in recorded if item["intensity"] > 0]
    by_category = {category_id: 0 for category_id in TRAINING_CATEGORY_MAP}
    for item in recorded:
        by_category[item["category"]] = by_category.get(item["category"], 0) + 1
    return {
        "month": month_value,
        "year": year,
        "month_number": month,
        "plan": WEEK_PLAN,
        "categories": TRAINING_CATEGORIES,
        "records": out,
        "totals": {
            "days": len(recorded),
            "minutes": total_minutes,
            "hours": round(total_minutes / 60, 1),
            "intensity": round(sum(item["intensity"] for item in rated) / len(rated), 1) if rated else 0,
            "performance": round(sum(item["performance"] for item in rated) / len(rated), 1) if rated else 0,
            "by_category": by_category,
        },
    }


def sync_study_sport(db, train_date, hours):
    """训练总时长回写到学习月度页的「运动兴趣」，两处口径保持一致。"""
    day = date.fromisoformat(train_date)
    if day < NEW_SCHEME_START:
        return
    row = db.execute("SELECT id FROM study_records WHERE study_date=?", (train_date,)).fetchone()
    if row:
        db.execute("UPDATE study_records SET sport=? WHERE study_date=?", (hours, train_date))
    elif hours > 0:
        now = datetime.now().isoformat(timespec="seconds")
        db.execute(
            """INSERT INTO study_records (study_date, weekday, sport, source, updated_at)
            VALUES (?, ?, ?, '运动训练', ?)""",
            (train_date, f"周{WEEKDAY_CN[day.weekday()]}", hours, now),
        )


def parse_training_plan(body):
    category = str(body.get("category") or "").strip()
    if category not in TRAINING_CATEGORY_MAP:
        raise ValueError("请选择运动类型")
    activity = str(body.get("activity") or "").strip()[:24]
    if not activity:
        activity = TRAINING_CATEGORY_MAP[category]["activities"][0]
    return category, activity


def parse_training_record(body):
    category, activity = parse_training_plan(body)
    raw_segments = body.get("segments") or []
    if not isinstance(raw_segments, list):
        raise ValueError("时段格式无效")
    if len(raw_segments) > 12:
        raise ValueError("一天最多 12 个时段")
    segments = [training_segment_payload(raw) for raw in raw_segments]
    total = sum(item["minutes"] for item in segments)
    if total > 720:
        raise ValueError("单日训练总时长不能超过 12 小时")
    if category != "rest" and not segments:
        raise ValueError("先填运动时段，再保存打卡")
    try:
        intensity = min(10, max(1, int(round(float(body.get("intensity", 5))))))
        performance = min(10, max(1, int(round(float(body.get("performance", 5))))))
    except (TypeError, ValueError):
        raise ValueError("强度或表现评分无效")
    return {
        "category": category,
        "activity": activity,
        "segments": [{"start": item["start"], "end": item["end"]} for item in segments],
        "minutes": total,
        "intensity": intensity,
        "performance": performance,
        "note": str(body.get("note") or "")[:500],
    }


@app.route("/api/training/month")
def api_training_month():
    month_value = request.args.get("month") or date.today().strftime("%Y-%m")
    try:
        return jsonify(training_month_payload(month_value))
    except (ValueError, TypeError):
        return jsonify({"error": "月份格式应为 YYYY-MM"}), 400


@app.route("/api/training/plan/<train_date>", methods=["PUT"])
def api_training_plan_save(train_date):
    try:
        date.fromisoformat(train_date)
    except ValueError:
        return jsonify({"error": "日期格式无效"}), 400
    body = request.get_json(silent=True) or {}
    try:
        category, activity = parse_training_plan(body)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    now = datetime.now().isoformat(timespec="seconds")
    db = get_db()
    if db.execute("SELECT 1 FROM training_records WHERE train_date=?", (train_date,)).fetchone():
        return jsonify({"error": "这一天已经有记录，先删除记录再改计划"}), 409
    db.execute(
        """INSERT INTO training_plans (train_date, category, activity, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(train_date) DO UPDATE SET
            category=excluded.category, activity=excluded.activity, updated_at=excluded.updated_at""",
        (train_date, category, activity, now),
    )
    db.commit()
    plan = db.execute("SELECT * FROM training_plans WHERE train_date=?", (train_date,)).fetchone()
    record = db.execute("SELECT * FROM training_records WHERE train_date=?", (train_date,)).fetchone()
    payload = training_day_payload(train_date, plan, record)
    payload["saved_at"] = now
    return jsonify(payload)


@app.route("/api/training/plan/<train_date>", methods=["DELETE"])
def api_training_plan_delete(train_date):
    try:
        date.fromisoformat(train_date)
    except ValueError:
        return jsonify({"error": "日期格式无效"}), 400
    db = get_db()
    if db.execute("SELECT 1 FROM training_records WHERE train_date=?", (train_date,)).fetchone():
        return jsonify({"error": "这一天已经有记录，先删除记录再改计划"}), 409
    db.execute("DELETE FROM training_plans WHERE train_date=?", (train_date,))
    db.commit()
    return jsonify(training_day_payload(train_date, None, None))


@app.route("/api/training/record/<train_date>", methods=["PUT"])
def api_training_record_save(train_date):
    try:
        date.fromisoformat(train_date)
    except ValueError:
        return jsonify({"error": "日期格式无效"}), 400
    body = request.get_json(silent=True) or {}
    try:
        record = parse_training_record(body)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    now = datetime.now().isoformat(timespec="seconds")
    db = get_db()
    db.execute(
        """INSERT INTO training_records
        (train_date, category, activity, segments, intensity, performance, note, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(train_date) DO UPDATE SET
            category=excluded.category, activity=excluded.activity, segments=excluded.segments,
            intensity=excluded.intensity, performance=excluded.performance,
            note=excluded.note, updated_at=excluded.updated_at""",
        (train_date, record["category"], record["activity"],
         json.dumps(record["segments"], ensure_ascii=False),
         record["intensity"], record["performance"], record["note"], now),
    )
    sync_study_sport(db, train_date, round(record["minutes"] / 60, 1))
    db.commit()
    plan = db.execute("SELECT * FROM training_plans WHERE train_date=?", (train_date,)).fetchone()
    row = db.execute("SELECT * FROM training_records WHERE train_date=?", (train_date,)).fetchone()
    payload = training_day_payload(train_date, plan, row)
    payload["saved_at"] = now
    return jsonify(payload)


@app.route("/api/training/record/<train_date>", methods=["DELETE"])
def api_training_record_delete(train_date):
    try:
        date.fromisoformat(train_date)
    except ValueError:
        return jsonify({"error": "日期格式无效"}), 400
    db = get_db()
    db.execute("DELETE FROM training_records WHERE train_date=?", (train_date,))
    sync_study_sport(db, train_date, 0)
    db.commit()
    plan = db.execute("SELECT * FROM training_plans WHERE train_date=?", (train_date,)).fetchone()
    return jsonify(training_day_payload(train_date, plan, None))


# ---------- 体育兴趣：计划 + 记录（只记时长） ----------

def hobby_plan_payload(row):
    return {
        "id": row["id"],
        "date": row["plan_date"],
        "category": row["category"],
        "item": row["item"],
        "note": row["note"],
        "done": bool(row["done"]),
    }


def hobby_record_payload(row):
    return {
        "id": row["id"],
        "date": row["record_date"],
        "category": row["category"],
        "item": row["item"],
        "minutes": int(row["minutes"]),
        "counted": bool(row["counted"]),
        "note": row["note"],
    }


def hobby_month_payload(month_value):
    year, month, days = month_days(month_value)
    prefix = f"{month_value}-%"
    db = get_db()
    plans = [hobby_plan_payload(row) for row in db.execute(
        "SELECT * FROM hobby_plans WHERE plan_date LIKE ? ORDER BY plan_date, id", (prefix,)
    ).fetchall()]
    records = [hobby_record_payload(row) for row in db.execute(
        "SELECT * FROM hobby_records WHERE record_date LIKE ? ORDER BY record_date, id", (prefix,)
    ).fetchall()]
    by_category = {item["id"]: {"count": 0, "minutes": 0} for item in HOBBY_CATEGORIES}
    for record in records:
        bucket = by_category.get(record["category"])
        if bucket is None:
            continue
        bucket["count"] += 1
        if record["counted"]:
            bucket["minutes"] += record["minutes"]
    total_minutes = sum(record["minutes"] for record in records if record["counted"])
    return {
        "month": month_value,
        "year": year,
        "month_number": month,
        "today": date.today().isoformat(),
        "categories": HOBBY_CATEGORIES,
        "default_minutes": HOBBY_DEFAULT_MINUTES,
        "plans": plans,
        "records": records,
        "totals": {
            "records": len(records),
            "timed": len([record for record in records if record["counted"]]),
            "minutes": total_minutes,
            "hours": round(total_minutes / 60, 1),
            "plans": len([plan for plan in plans if not plan["done"]]),
            "by_category": by_category,
        },
    }


def parse_hobby_target(body):
    category = str(body.get("category") or "").strip()
    if category not in HOBBY_CATEGORY_MAP:
        raise ValueError("兴趣类别无效")
    item = str(body.get("item") or "").strip()
    if item not in HOBBY_CATEGORY_MAP[category]["items"]:
        raise ValueError("具体项目无效")
    return category, item


def parse_hobby_date(value, label):
    try:
        return date.fromisoformat(str(value or "")).isoformat()
    except ValueError:
        raise ValueError(f"{label}格式无效")


def parse_hobby_minutes(body):
    counted = 1 if body.get("counted", True) else 0
    if not counted:
        return 0, 0
    try:
        minutes = int(round(float(body.get("minutes", HOBBY_DEFAULT_MINUTES))))
    except (TypeError, ValueError):
        raise ValueError("时长无效")
    if minutes < 5 or minutes > 1440:
        raise ValueError("时长应在 5 到 1440 分钟之间")
    return minutes, 1


@app.route("/api/hobby/month")
def api_hobby_month():
    month_value = request.args.get("month") or date.today().strftime("%Y-%m")
    try:
        return jsonify(hobby_month_payload(month_value))
    except (ValueError, TypeError):
        return jsonify({"error": "月份格式应为 YYYY-MM"}), 400


@app.route("/api/hobby/plans", methods=["POST"])
def api_hobby_plan_create():
    body = request.get_json(silent=True) or {}
    try:
        category, item = parse_hobby_target(body)
        plan_date = parse_hobby_date(body.get("date"), "日期")
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    now = datetime.now().isoformat(timespec="seconds")
    db = get_db()
    cursor = db.execute(
        "INSERT INTO hobby_plans (plan_date, category, item, note, done, created_at) VALUES (?, ?, ?, ?, 0, ?)",
        (plan_date, category, item, str(body.get("note") or "")[:200], now),
    )
    db.commit()
    row = db.execute("SELECT * FROM hobby_plans WHERE id=?", (cursor.lastrowid,)).fetchone()
    return jsonify(hobby_plan_payload(row))


@app.route("/api/hobby/plans/<int:plan_id>", methods=["PATCH"])
def api_hobby_plan_update(plan_id):
    body = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM hobby_plans WHERE id=?", (plan_id,)).fetchone()
    if not row:
        return jsonify({"error": "计划不存在"}), 404
    fields = {}
    if "date" in body:
        try:
            fields["plan_date"] = parse_hobby_date(body.get("date"), "日期")
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
    if "category" in body or "item" in body:
        try:
            category, item = parse_hobby_target({
                "category": body.get("category") or row["category"],
                "item": body.get("item") or row["item"],
            })
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        fields["category"] = category
        fields["item"] = item
    if "note" in body:
        fields["note"] = str(body.get("note") or "")[:200]
    if "done" in body:
        fields["done"] = 1 if body.get("done") else 0
    if fields:
        assignments = ", ".join(f"{key}=?" for key in fields)
        db.execute(f"UPDATE hobby_plans SET {assignments} WHERE id=?", tuple(fields.values()) + (plan_id,))
        db.commit()
    row = db.execute("SELECT * FROM hobby_plans WHERE id=?", (plan_id,)).fetchone()
    return jsonify(hobby_plan_payload(row))


@app.route("/api/hobby/plans/<int:plan_id>", methods=["DELETE"])
def api_hobby_plan_delete(plan_id):
    db = get_db()
    db.execute("DELETE FROM hobby_plans WHERE id=?", (plan_id,))
    db.commit()
    return jsonify({"ok": True, "id": plan_id})


@app.route("/api/hobby/records", methods=["POST"])
def api_hobby_record_create():
    body = request.get_json(silent=True) or {}
    try:
        category, item = parse_hobby_target(body)
        record_date = parse_hobby_date(body.get("date"), "日期")
        minutes, counted = parse_hobby_minutes(body)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    now = datetime.now().isoformat(timespec="seconds")
    db = get_db()
    cursor = db.execute(
        """INSERT INTO hobby_records (record_date, category, item, minutes, counted, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (record_date, category, item, minutes, counted, str(body.get("note") or "")[:200], now),
    )
    db.commit()
    row = db.execute("SELECT * FROM hobby_records WHERE id=?", (cursor.lastrowid,)).fetchone()
    return jsonify(hobby_record_payload(row))


@app.route("/api/hobby/records/<int:record_id>", methods=["PATCH"])
def api_hobby_record_update(record_id):
    body = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM hobby_records WHERE id=?", (record_id,)).fetchone()
    if not row:
        return jsonify({"error": "记录不存在"}), 404
    fields = {}
    if "date" in body:
        try:
            fields["record_date"] = parse_hobby_date(body.get("date"), "日期")
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
    if "category" in body or "item" in body:
        try:
            category, item = parse_hobby_target({
                "category": body.get("category") or row["category"],
                "item": body.get("item") or row["item"],
            })
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        fields["category"] = category
        fields["item"] = item
    if "minutes" in body or "counted" in body:
        try:
            minutes, counted = parse_hobby_minutes(body)
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        fields["minutes"] = minutes
        fields["counted"] = counted
    if "note" in body:
        fields["note"] = str(body.get("note") or "")[:200]
    if not fields:
        return jsonify({"error": "没有可修改的字段"}), 400
    assignments = ", ".join(f"{key}=?" for key in fields)
    db.execute(f"UPDATE hobby_records SET {assignments} WHERE id=?", tuple(fields.values()) + (record_id,))
    db.commit()
    row = db.execute("SELECT * FROM hobby_records WHERE id=?", (record_id,)).fetchone()
    return jsonify(hobby_record_payload(row))


@app.route("/api/hobby/records/<int:record_id>", methods=["DELETE"])
def api_hobby_record_delete(record_id):
    db = get_db()
    db.execute("DELETE FROM hobby_records WHERE id=?", (record_id,))
    db.commit()
    return jsonify({"ok": True, "id": record_id})


def schedule_item_payload(row):
    category = SCHEDULE_CATEGORY_MAP.get(row["category"], SCHEDULE_CATEGORIES[-1])
    return {
        "id": row["id"],
        "date": row["item_date"],
        "start": row["start_time"],
        "end": row["end_time"],
        "title": row["title"],
        "category": category["id"],
        "category_name": category["name"],
        "color": category["color"],
        "kind": row["kind"],
        "done": bool(row["done"]),
    }


def parse_schedule_times(start_value, end_value, kind):
    start = clock_minutes(start_value)
    if start is None:
        raise ValueError("开始时间格式应为 HH:MM")
    if 60 <= start < 7 * 60:
        raise ValueError("只支持 07:00 到次日 01:00")
    if kind == "reminder":
        return f"{start // 60:02d}:{start % 60:02d}", ""
    end = clock_minutes(end_value)
    if end is None:
        raise ValueError("结束时间格式应为 HH:MM")
    if start < 60:
        start_axis, end_axis = 1440 + start, 1440 + end
        if end <= start:
            raise ValueError("结束时间要晚于开始时间")
    else:
        start_axis = start
        end_axis = end if end > start else end + 1440
    if end_axis <= start_axis:
        raise ValueError("结束时间要晚于开始时间")
    if end_axis > 1500:
        raise ValueError("最晚到次日 01:00")
    return f"{start // 60:02d}:{start % 60:02d}", f"{end // 60:02d}:{end % 60:02d}"


@app.route("/api/schedule/week")
def api_schedule_week():
    raw = request.args.get("start") or date.today().isoformat()
    try:
        anchor = date.fromisoformat(raw)
    except ValueError:
        return jsonify({"error": "日期格式无效"}), 400
    start = week_start_for(anchor)
    current = current_week_start()
    db = get_db()
    # 不再自动清理历史周：日程只增不删，过去周保持只读
    rows = db.execute(
        "SELECT * FROM schedule_items WHERE week_start=? ORDER BY item_date, start_time, id",
        (start.isoformat(),),
    ).fetchall()
    items = [schedule_item_payload(row) for row in rows]
    counts = {item["id"]: 0 for item in SCHEDULE_CATEGORIES}
    for item in items:
        counts[item["category"]] = counts.get(item["category"], 0) + 1
    days = []
    for offset in range(7):
        day = start + timedelta(days=offset)
        days.append({
            "date": day.isoformat(),
            "weekday": f"周{WEEKDAY_CN[day.weekday()]}",
            "day": day.day,
            "month": day.month,
            "today": day == date.today(),
        })
    return jsonify({
        "week_start": start.isoformat(),
        "current_week_start": current.isoformat(),
        "today": date.today().isoformat(),
        "now": datetime.now().strftime("%H:%M"),
        "categories": SCHEDULE_CATEGORIES,
        "days": days,
        "items": items,
        "counts": counts,
        "done": len([item for item in items if item["done"]]),
    })


@app.route("/api/schedule/items", methods=["POST"])
def api_schedule_create():
    body = request.get_json(silent=True) or {}
    title = str(body.get("title") or "").strip()[:40]
    if not title:
        return jsonify({"error": "事项名不能为空"}), 400
    category = str(body.get("category") or "").strip()
    if category not in SCHEDULE_CATEGORY_MAP:
        return jsonify({"error": "请选择任务类型"}), 400
    kind = str(body.get("kind") or "block").strip()
    if kind not in ("block", "reminder"):
        return jsonify({"error": "事项类型无效"}), 400
    try:
        item_date = date.fromisoformat(str(body.get("date") or ""))
    except ValueError:
        return jsonify({"error": "日期格式无效"}), 400
    try:
        start_time, end_time = parse_schedule_times(body.get("start"), body.get("end"), kind)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    week_start = week_start_for(item_date)
    if week_start < current_week_start():
        return jsonify({"error": "过去周会自动清除，不能新建"}), 403
    now = datetime.now().isoformat(timespec="seconds")
    db = get_db()
    cursor = db.execute(
        """INSERT INTO schedule_items
        (item_date, start_time, end_time, title, category, kind, done, week_start, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)""",
        (item_date.isoformat(), start_time, end_time, title, category, kind,
         week_start.isoformat(), now, now),
    )
    db.commit()
    row = db.execute("SELECT * FROM schedule_items WHERE id=?", (cursor.lastrowid,)).fetchone()
    return jsonify(schedule_item_payload(row))


@app.route("/api/schedule/items/<int:item_id>", methods=["PATCH"])
def api_schedule_update(item_id):
    body = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM schedule_items WHERE id=?", (item_id,)).fetchone()
    if not row:
        return jsonify({"error": "事项不存在"}), 404

    # 只切完成状态：圆框点击
    if set(body) <= {"done"}:
        if "done" not in body:
            return jsonify({"error": "没有要修改的内容"}), 400
        db.execute(
            "UPDATE schedule_items SET done=?, updated_at=? WHERE id=?",
            (1 if body.get("done") else 0, datetime.now().isoformat(timespec="seconds"), item_id),
        )
        db.commit()
        row = db.execute("SELECT * FROM schedule_items WHERE id=?", (item_id,)).fetchone()
        return jsonify(schedule_item_payload(row))

    # 点击事项后整体编辑
    title = str(body.get("title", row["title"]) or "").strip()[:40]
    if not title:
        return jsonify({"error": "事项名不能为空"}), 400
    category = str(body.get("category") or row["category"]).strip()
    if category not in SCHEDULE_CATEGORY_MAP:
        return jsonify({"error": "请选择任务类型"}), 400
    kind = str(body.get("kind") or row["kind"]).strip()
    if kind not in ("block", "reminder"):
        return jsonify({"error": "事项类型无效"}), 400
    try:
        item_date = date.fromisoformat(str(body.get("date") or row["item_date"]))
    except ValueError:
        return jsonify({"error": "日期格式无效"}), 400
    start_value = body.get("start") or row["start_time"]
    base = clock_minutes(start_value) or 0
    fallback_end = f"{(base + 60) // 60 % 24:02d}:{(base + 60) % 60:02d}"
    end_value = body.get("end") or row["end_time"] or fallback_end
    try:
        start_time, end_time = parse_schedule_times(start_value, end_value, kind)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    week_start = week_start_for(item_date)
    if week_start < current_week_start():
        return jsonify({"error": "过去周会自动清除，不能改到过去"}), 403
    done = 1 if body.get("done", row["done"]) else 0
    db.execute(
        """UPDATE schedule_items
        SET item_date=?, start_time=?, end_time=?, title=?, category=?, kind=?, done=?,
            week_start=?, updated_at=?
        WHERE id=?""",
        (item_date.isoformat(), start_time, end_time, title, category, kind, done,
         week_start.isoformat(), datetime.now().isoformat(timespec="seconds"), item_id),
    )
    db.commit()
    row = db.execute("SELECT * FROM schedule_items WHERE id=?", (item_id,)).fetchone()
    return jsonify(schedule_item_payload(row))


@app.route("/api/schedule/items/<int:item_id>", methods=["DELETE"])
def api_schedule_delete(item_id):
    db = get_db()
    db.execute("DELETE FROM schedule_items WHERE id=?", (item_id,))
    db.commit()
    return jsonify({"ok": True, "id": item_id})


def plan_due_date(start_value, days):
    """时限：从项目开始日期往后推天数，与截止日期不是同一个概念。"""
    if not days or days <= 0:
        return ""
    try:
        base = date.fromisoformat(str(start_value)[:10])
    except (TypeError, ValueError):
        return ""
    return (base + timedelta(days=int(days))).isoformat()


def parse_plan_date(value, label):
    try:
        return date.fromisoformat(str(value or "")[:10]).isoformat()
    except ValueError:
        raise ValueError(f"{label}格式无效")


def parse_plan_date_optional(value, label):
    """结束日期可以直接不填。"""
    text = str(value or "").strip()
    if not text:
        return ""
    return parse_plan_date(text, label)


def parse_repeat_weekday(value):
    """每周重复：-1 不重复，0–6 是周一到周日。"""
    if value is None or value == "":
        return -1
    try:
        day = int(value)
    except (TypeError, ValueError):
        raise ValueError("每周重复的星期无效")
    if day < -1 or day > 6:
        raise ValueError("每周重复的星期无效")
    return day


def clean_plan_milestones(raw):
    """阶段性目标：每条是「日期 + 内容」。日期必填、内容可空，最多 12 条。"""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("阶段性目标格式无效")
    values = []
    for item in raw[:24]:
        if not isinstance(item, dict):
            continue
        due = str(item.get("date") or item.get("due_date") or "").strip()[:10]
        if not due:
            continue
        try:
            due = date.fromisoformat(due).isoformat()
        except ValueError:
            raise ValueError("阶段性目标日期无效")
        values.append({
            "title": str(item.get("title") or "").strip()[:40],
            "date": due,
        })
    values.sort(key=lambda entry: entry["date"])
    return values[:12]


PLAN_PROJECT_ORDER = "pinned DESC, sort_order ASC, created_at, id"
# 任务与事项同一套先后规则：有截止的按截止日期，没截止的按创建时间排在后面
PLAN_DUE_ORDER = "(due_date = '') ASC, due_date ASC, created_at ASC, id"
# 任务多两条：置顶优先，其次是每周重复的（会议这类要一直排在最上面）
PLAN_TASK_ORDER = "done ASC, pinned DESC, (repeat_weekday >= 0) DESC, (due_date = '') ASC, due_date ASC, created_at ASC, id"
WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def plan_item_payload(row):
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "title": row["title"],
        "due_date": row["due_date"],
        "important": bool(row["important"]),
        "done": bool(row["done"]),
        "archived": bool(row["archived"]),
        "archived_at": row["archived_at"],
        "created_at": row["created_at"],
        "created_date": row["created_at"][:10],
    }


def plan_task_ratio(task):
    """任务在项目进度里占的比重：勾了任务就是整份；否则按它的事项完成比例。"""
    if task["done"]:
        return 1.0
    items = task.get("items") or []
    if not items:
        return 0.0
    return len([item for item in items if item["done"]]) / len(items)


def plan_task_payload(row, items=None):
    items = items or []
    repeat = row["repeat_weekday"] if "repeat_weekday" in row.keys() else -1
    task = {
        "id": row["id"],
        "project_id": row["project_id"],
        "title": row["title"],
        "due_date": row["due_date"],
        "pinned": bool(row["pinned"]),
        "done": bool(row["done"]),
        "repeat_weekday": repeat,
        "repeat_label": WEEKDAY_NAMES[repeat] if 0 <= repeat <= 6 else "",
        "created_at": row["created_at"],
        "active": bool(row["active"]) if "active" in row.keys() else False,
        "archived": bool(row["archived"]) if "archived" in row.keys() else False,
        "archived_at": (row["archived_at"] if "archived_at" in row.keys() else "") or "",
        "items": items,
        "item_count": len(items),
        "item_done": len([item for item in items if item["done"]]),
    }
    task["progress"] = round(100 * plan_task_ratio(task))
    return task


def load_project_tasks(db, project_id):
    """项目下的任务按截止先后排，没有截止的按创建时间排在后面；任务下挂未归档的事项。"""
    items = db.execute(
        f"""SELECT * FROM plan_items WHERE archived=0 AND task_id IN
            (SELECT id FROM plan_tasks WHERE project_id=?) ORDER BY {PLAN_DUE_ORDER}""",
        (project_id,),
    ).fetchall()
    item_map = {}
    for row in items:
        item_map.setdefault(row["task_id"], []).append(plan_item_payload(row))
    tasks = db.execute(
        f"SELECT * FROM plan_tasks WHERE project_id=? ORDER BY {PLAN_TASK_ORDER}",
        (project_id,),
    ).fetchall()
    return [plan_task_payload(row, item_map.get(row["id"], [])) for row in tasks]


def plan_project_payload(row, tasks, milestones=None):
    done = len([task for task in tasks if task["done"]])
    progress = round(100 * sum(plan_task_ratio(task) for task in tasks) / len(tasks)) if tasks else 0
    return {
        "id": row["id"],
        "category": row["category"],
        "title": row["title"],
        "start_date": row["start_date"],
        "end_date": row["end_date"] if "end_date" in row.keys() else "",
        "sort_order": row["sort_order"] if "sort_order" in row.keys() else 0,
        "milestones": milestones or [],
        "pinned": bool(row["pinned"]),
        "archived": bool(row["archived"]),
        "created_at": row["created_at"],
        "created_date": row["created_at"][:10],
        "archived_at": row["archived_at"],
        "task_count": len(tasks),
        "done_count": done,
        "progress": progress,
        "tasks": tasks,
    }


def plan_milestone_payload(row):
    return {"id": row["id"], "title": row["title"], "date": row["due_date"]}


def load_plan_milestones(db, project_id):
    return [
        plan_milestone_payload(row)
        for row in db.execute(
            "SELECT * FROM plan_milestones WHERE project_id=? ORDER BY due_date, id",
            (project_id,),
        ).fetchall()
    ]


def replace_plan_milestones(db, project_id, milestones, now):
    db.execute("DELETE FROM plan_milestones WHERE project_id=?", (project_id,))
    for entry in milestones:
        db.execute(
            """INSERT INTO plan_milestones (project_id, title, due_date, created_at)
            VALUES (?, ?, ?, ?)""",
            (project_id, entry["title"], entry["date"], now),
        )


@app.route("/api/plans")
def api_plans():
    db = get_db()
    projects = db.execute(
        f"SELECT * FROM plan_projects WHERE archived=0 ORDER BY {PLAN_PROJECT_ORDER}"
    ).fetchall()
    tasks = db.execute(f"SELECT * FROM plan_tasks WHERE archived=0 ORDER BY {PLAN_TASK_ORDER}").fetchall()
    items = db.execute(
        f"SELECT * FROM plan_items WHERE archived=0 ORDER BY {PLAN_DUE_ORDER}"
    ).fetchall()
    item_map = {}
    for row in items:
        item_map.setdefault(row["task_id"], []).append(plan_item_payload(row))
    grouped = {}
    for row in tasks:
        grouped.setdefault(row["project_id"], []).append(
            plan_task_payload(row, item_map.get(row["id"], []))
        )
    milestone_map = {}
    for row in db.execute("SELECT * FROM plan_milestones ORDER BY due_date, id").fetchall():
        milestone_map.setdefault(row["project_id"], []).append(plan_milestone_payload(row))
    payload = [
        plan_project_payload(row, grouped.get(row["id"], []), milestone_map.get(row["id"], []))
        for row in projects
    ]
    archived_rows = db.execute(
        "SELECT * FROM plan_projects WHERE archived=1 ORDER BY archived_at DESC, id DESC"
    ).fetchall()
    archived = [
        plan_project_payload(row, grouped.get(row["id"], []), milestone_map.get(row["id"], []))
        for row in archived_rows
    ]
    archived_items = []
    for row in db.execute(
        """SELECT i.*, t.title AS task_title, p.title AS project_title
        FROM plan_items i
        LEFT JOIN plan_tasks t ON t.id = i.task_id
        LEFT JOIN plan_projects p ON p.id = t.project_id
        WHERE i.archived=1
        ORDER BY i.archived_at DESC, i.id DESC"""
    ).fetchall():
        entry = plan_item_payload(row)
        entry["task_title"] = row["task_title"] or "（任务已删除）"
        entry["project_title"] = row["project_title"] or "（项目已删除）"
        archived_items.append(entry)
    archived_tasks = [
        plan_task_payload(row, [])
        for row in db.execute(
            "SELECT * FROM plan_tasks WHERE archived=1 AND project_id=0 ORDER BY archived_at DESC, id DESC"
        ).fetchall()
    ]
    return jsonify({
        "categories": PLAN_CATEGORIES,
        "projects": payload,
        "archived": archived,
        "archived_items": archived_items,
        "archived_tasks": archived_tasks,
        "standalone_tasks": grouped.get(0, []),
    })


@app.route("/api/plans/projects", methods=["POST"])
def api_plan_project_create():
    body = request.get_json(silent=True) or {}
    title = str(body.get("title") or "").strip()[:40]
    if not title:
        return jsonify({"error": "项目名不能为空"}), 400
    category = str(body.get("category") or "").strip()
    if category not in PLAN_CATEGORY_MAP:
        return jsonify({"error": "分类无效"}), 400
    if category == "memo":
        return jsonify({"error": "备忘录只放任务，不能建项目"}), 400
    now = datetime.now().isoformat(timespec="seconds")
    try:
        start_date = parse_plan_date_optional(body.get("start_date"), "开始日期")
        end_date = parse_plan_date_optional(body.get("end_date"), "结束日期")
        milestones = clean_plan_milestones(body.get("milestones"))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    if start_date and end_date and end_date < start_date:
        return jsonify({"error": "结束日期不能早于开始日期"}), 400
    db = get_db()
    next_order = db.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM plan_projects WHERE category=?",
        (category,),
    ).fetchone()[0]
    cursor = db.execute(
        """INSERT INTO plan_projects
        (category, title, deadline, start_date, end_date, sort_order, pinned, archived, created_at, updated_at)
        VALUES (?, ?, '', ?, ?, ?, 0, 0, ?, ?)""",
        (category, title, start_date, end_date, next_order, now, now),
    )
    project_id = cursor.lastrowid
    replace_plan_milestones(db, project_id, milestones, now)
    db.commit()
    row = db.execute("SELECT * FROM plan_projects WHERE id=?", (project_id,)).fetchone()
    return jsonify(plan_project_payload(row, [], load_plan_milestones(db, project_id)))


@app.route("/api/plans/projects/<int:project_id>", methods=["PATCH"])
def api_plan_project_update(project_id):
    body = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM plan_projects WHERE id=?", (project_id,)).fetchone()
    if not row:
        return jsonify({"error": "项目不存在"}), 404
    fields = {}
    if "title" in body:
        title = str(body.get("title") or "").strip()[:40]
        if not title:
            return jsonify({"error": "项目名不能为空"}), 400
        fields["title"] = title
    if "category" in body:
        category = str(body.get("category") or "").strip()
        if category not in PLAN_CATEGORY_MAP:
            return jsonify({"error": "分类无效"}), 400
        if category == "memo" and row["category"] != "memo":
            return jsonify({"error": "备忘录只放任务，不能放项目"}), 400
        fields["category"] = category
    if "start_date" in body:
        try:
            fields["start_date"] = parse_plan_date_optional(body.get("start_date"), "开始日期")
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
    if "end_date" in body:
        try:
            fields["end_date"] = parse_plan_date_optional(body.get("end_date"), "结束日期")
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
    milestones = None
    if "milestones" in body:
        try:
            milestones = clean_plan_milestones(body.get("milestones"))
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
    if "pinned" in body:
        want_pin = bool(body.get("pinned"))
        if want_pin:
            pinned_now = db.execute(
                "SELECT COUNT(*) FROM plan_projects WHERE pinned=1 AND archived=0 AND id<>?",
                (project_id,),
            ).fetchone()[0]
            if pinned_now >= 2:
                return jsonify({"error": "最多置顶 2 个重点项目"}), 400
        fields["pinned"] = 1 if want_pin else 0
    if not fields and milestones is None:
        return jsonify({"error": "没有可修改的字段"}), 400
    start_value = fields.get("start_date", row["start_date"])
    end_value = fields.get("end_date", row["end_date"])
    if start_value and end_value and end_value < start_value:
        return jsonify({"error": "结束日期不能早于开始日期"}), 400
    fields["updated_at"] = datetime.now().isoformat(timespec="seconds")
    assignments = ", ".join(f"{key}=?" for key in fields)
    db.execute(f"UPDATE plan_projects SET {assignments} WHERE id=?", tuple(fields.values()) + (project_id,))
    if milestones is not None:
        replace_plan_milestones(db, project_id, milestones, fields["updated_at"])
    db.commit()
    row = db.execute("SELECT * FROM plan_projects WHERE id=?", (project_id,)).fetchone()
    return jsonify(plan_project_payload(row, load_project_tasks(db, project_id),
                                        load_plan_milestones(db, project_id)))


@app.route("/api/plans/projects/<int:project_id>/archive", methods=["POST"])
def api_plan_project_archive(project_id):
    db = get_db()
    row = db.execute("SELECT * FROM plan_projects WHERE id=?", (project_id,)).fetchone()
    if not row:
        return jsonify({"error": "项目不存在"}), 404
    now = datetime.now().isoformat(timespec="seconds")
    db.execute(
        "UPDATE plan_projects SET archived=1, archived_at=?, updated_at=? WHERE id=?",
        (now, now, project_id),
    )
    db.commit()
    return jsonify({"ok": True, "id": project_id})


@app.route("/api/plans/projects/<int:project_id>/restore", methods=["POST"])
def api_plan_project_restore(project_id):
    db = get_db()
    row = db.execute("SELECT * FROM plan_projects WHERE id=?", (project_id,)).fetchone()
    if not row:
        return jsonify({"error": "项目不存在"}), 404
    db.execute(
        "UPDATE plan_projects SET archived=0, archived_at='', updated_at=? WHERE id=?",
        (datetime.now().isoformat(timespec="seconds"), project_id),
    )
    db.commit()
    return jsonify({"ok": True, "id": project_id})


@app.route("/api/plans/projects/<int:project_id>", methods=["DELETE"])
def api_plan_project_delete(project_id):
    db = get_db()
    db.execute(
        "DELETE FROM plan_items WHERE task_id IN (SELECT id FROM plan_tasks WHERE project_id=?)",
        (project_id,),
    )
    db.execute("DELETE FROM plan_tasks WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM plan_milestones WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM plan_projects WHERE id=?", (project_id,))
    db.commit()
    return jsonify({"ok": True, "id": project_id})


@app.route("/api/plans/tasks", methods=["POST"])
def api_plan_task_create():
    body = request.get_json(silent=True) or {}
    try:
        project_id = int(body.get("project_id") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "项目无效"}), 400
    db = get_db()
    # project_id=0：备忘录里的独立任务，不隶属任何项目
    if project_id:
        project = db.execute("SELECT * FROM plan_projects WHERE id=?", (project_id,)).fetchone()
        if not project or project["archived"]:
            return jsonify({"error": "项目不存在或已归档"}), 404
    title = str(body.get("title") or "").strip()[:60]
    if not title:
        return jsonify({"error": "任务名不能为空"}), 400
    try:
        due = parse_plan_date_optional(body.get("due_date"), "结束日期")
        repeat = parse_repeat_weekday(body.get("repeat_weekday"))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    now = datetime.now().isoformat(timespec="seconds")
    cursor = db.execute(
        """INSERT INTO plan_tasks
        (project_id, title, due_date, pinned, done, repeat_weekday, created_at, updated_at)
        VALUES (?, ?, ?, 0, 0, ?, ?, ?)""",
        (project_id, title, due, repeat, now, now),
    )
    db.commit()
    row = db.execute("SELECT * FROM plan_tasks WHERE id=?", (cursor.lastrowid,)).fetchone()
    return jsonify(plan_task_payload(row))


@app.route("/api/plans/tasks/<int:task_id>", methods=["PATCH"])
def api_plan_task_update(task_id):
    body = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM plan_tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        return jsonify({"error": "任务不存在"}), 404
    fields = {}
    if "title" in body:
        title = str(body.get("title") or "").strip()[:60]
        if not title:
            return jsonify({"error": "任务名不能为空"}), 400
        fields["title"] = title
    if "due_date" in body:
        try:
            fields["due_date"] = parse_plan_date_optional(body.get("due_date"), "结束日期")
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
    if "repeat_weekday" in body:
        try:
            fields["repeat_weekday"] = parse_repeat_weekday(body.get("repeat_weekday"))
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
    if "done" in body:
        done_value = 1 if body.get("done") else 0
        fields["done"] = done_value
        # 备忘录里的独立任务（project_id=0）：勾完就归档，进回收站
        if row["project_id"] == 0:
            fields["archived"] = done_value
            fields["archived_at"] = (
                datetime.now().isoformat(timespec="seconds") if done_value else ""
            )
    if "active" in body:
        fields["active"] = 1 if body.get("active") else 0
    if "pinned" in body:
        fields["pinned"] = 1 if body.get("pinned") else 0
    if not fields:
        return jsonify({"error": "没有可修改的字段"}), 400
    fields["updated_at"] = datetime.now().isoformat(timespec="seconds")
    assignments = ", ".join(f"{key}=?" for key in fields)
    db.execute(f"UPDATE plan_tasks SET {assignments} WHERE id=?", tuple(fields.values()) + (task_id,))
    db.commit()
    row = db.execute("SELECT * FROM plan_tasks WHERE id=?", (task_id,)).fetchone()
    items = [
        plan_item_payload(item)
        for item in db.execute(
            f"SELECT * FROM plan_items WHERE task_id=? AND archived=0 ORDER BY {PLAN_DUE_ORDER}",
            (task_id,),
        ).fetchall()
    ]
    return jsonify(plan_task_payload(row, items))


@app.route("/api/plans/tasks/<int:task_id>/restore", methods=["POST"])
def api_plan_task_restore(task_id):
    db = get_db()
    row = db.execute("SELECT * FROM plan_tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        return jsonify({"error": "任务不存在"}), 404
    db.execute(
        "UPDATE plan_tasks SET archived=0, done=0, archived_at='', updated_at=? WHERE id=?",
        (datetime.now().isoformat(timespec="seconds"), task_id),
    )
    db.commit()
    return jsonify({"ok": True, "id": task_id})


@app.route("/api/plans/tasks/<int:task_id>", methods=["DELETE"])
def api_plan_task_delete(task_id):
    db = get_db()
    db.execute("DELETE FROM plan_items WHERE task_id=?", (task_id,))
    db.execute("DELETE FROM plan_tasks WHERE id=?", (task_id,))
    db.commit()
    return jsonify({"ok": True, "id": task_id})


@app.route("/api/plans/tasks/batch-delete", methods=["POST"])
def api_plan_tasks_batch_delete():
    body = request.get_json(silent=True) or {}
    ids = body.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "没有选中任务"}), 400
    cleaned = []
    for value in ids[:200]:
        try:
            cleaned.append(int(value))
        except (TypeError, ValueError):
            continue
    if not cleaned:
        return jsonify({"error": "没有选中任务"}), 400
    placeholders = ", ".join("?" for _ in cleaned)
    db = get_db()
    db.execute(
        f"DELETE FROM plan_items WHERE task_id IN ({placeholders})", tuple(cleaned)
    )
    deleted = db.execute(
        f"DELETE FROM plan_tasks WHERE id IN ({placeholders})", tuple(cleaned)
    ).rowcount
    db.commit()
    return jsonify({"deleted": deleted})


@app.route("/api/plans/projects/reorder", methods=["POST"])
def api_plan_project_reorder():
    """拖动换位：按传入顺序重写同列项目的 sort_order。"""
    body = request.get_json(silent=True) or {}
    ids = body.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "没有可排序的项目"}), 400
    cleaned = []
    for value in ids[:200]:
        try:
            cleaned.append(int(value))
        except (TypeError, ValueError):
            continue
    if not cleaned:
        return jsonify({"error": "没有可排序的项目"}), 400
    db = get_db()
    now = datetime.now().isoformat(timespec="seconds")
    for index, project_id in enumerate(cleaned):
        db.execute(
            "UPDATE plan_projects SET sort_order=?, updated_at=? WHERE id=?",
            (index, now, project_id),
        )
    db.commit()
    return jsonify({"ok": True, "count": len(cleaned)})


@app.route("/api/plans/items", methods=["POST"])
def api_plan_item_create():
    body = request.get_json(silent=True) or {}
    try:
        task_id = int(body.get("task_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "任务无效"}), 400
    db = get_db()
    task = db.execute("SELECT * FROM plan_tasks WHERE id=?", (task_id,)).fetchone()
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    title = str(body.get("title") or "").strip()[:60]
    if not title:
        return jsonify({"error": "事项名不能为空"}), 400
    try:
        due = parse_plan_date_optional(body.get("due_date"), "结束日期")
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    now = datetime.now().isoformat(timespec="seconds")
    cursor = db.execute(
        """INSERT INTO plan_items
        (task_id, title, due_date, important, archived, archived_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, '', ?, ?)""",
        (task_id, title, due, 1 if body.get("important") else 0, now, now),
    )
    db.commit()
    row = db.execute("SELECT * FROM plan_items WHERE id=?", (cursor.lastrowid,)).fetchone()
    return jsonify(plan_item_payload(row))


@app.route("/api/plans/items/<int:item_id>", methods=["PATCH"])
def api_plan_item_update(item_id):
    body = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM plan_items WHERE id=?", (item_id,)).fetchone()
    if not row:
        return jsonify({"error": "事项不存在"}), 404
    fields = {}
    if "title" in body:
        title = str(body.get("title") or "").strip()[:60]
        if not title:
            return jsonify({"error": "事项名不能为空"}), 400
        fields["title"] = title
    if "due_date" in body:
        try:
            fields["due_date"] = parse_plan_date_optional(body.get("due_date"), "结束日期")
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
    if "important" in body:
        fields["important"] = 1 if body.get("important") else 0
    if "done" in body:
        fields["done"] = 1 if body.get("done") else 0
    if not fields:
        return jsonify({"error": "没有可修改的字段"}), 400
    fields["updated_at"] = datetime.now().isoformat(timespec="seconds")
    assignments = ", ".join(f"{key}=?" for key in fields)
    db.execute(f"UPDATE plan_items SET {assignments} WHERE id=?", tuple(fields.values()) + (item_id,))
    db.commit()
    row = db.execute("SELECT * FROM plan_items WHERE id=?", (item_id,)).fetchone()
    return jsonify(plan_item_payload(row))


@app.route("/api/plans/items/<int:item_id>", methods=["DELETE"])
def api_plan_item_delete(item_id):
    db = get_db()
    db.execute("DELETE FROM plan_items WHERE id=?", (item_id,))
    db.commit()
    return jsonify({"ok": True, "id": item_id})


@app.route("/api/plans/items/<int:item_id>/archive", methods=["POST"])
def api_plan_item_archive(item_id):
    db = get_db()
    row = db.execute("SELECT * FROM plan_items WHERE id=?", (item_id,)).fetchone()
    if not row:
        return jsonify({"error": "事项不存在"}), 404
    now = datetime.now().isoformat(timespec="seconds")
    db.execute(
        "UPDATE plan_items SET archived=1, archived_at=?, updated_at=? WHERE id=?",
        (now, now, item_id),
    )
    db.commit()
    return jsonify({"ok": True, "id": item_id})


@app.route("/api/plans/items/<int:item_id>/restore", methods=["POST"])
def api_plan_item_restore(item_id):
    db = get_db()
    row = db.execute("SELECT * FROM plan_items WHERE id=?", (item_id,)).fetchone()
    if not row:
        return jsonify({"error": "事项不存在"}), 404
    db.execute(
        "UPDATE plan_items SET archived=0, archived_at='', updated_at=? WHERE id=?",
        (datetime.now().isoformat(timespec="seconds"), item_id),
    )
    db.commit()
    return jsonify({"ok": True, "id": item_id})


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "platform": "personal-management-hub"})


init_db()

if __name__ == "__main__":
    print(f"Study Time Platform running at http://127.0.0.1:{PORT}")
    app.run(host=os.environ.get("HOST", "0.0.0.0"), port=PORT, debug=False)
