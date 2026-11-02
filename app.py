# -*- coding: utf-8 -*-
# ============================================================
#  生活费账本 · app.py
#  【四件套角色】厨房：接收前端（门面）的请求 → 处理 → 去仓库读写 → 端回结果
#
#  运行：python app.py   →  http://127.0.0.1:5001
# ============================================================

import calendar
import random
import sqlite3
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# 【仓库的门牌号】SQLite 不需要安装，数据库就是项目目录下这一个文件
DB_PATH = Path(__file__).parent / "data.db"

# 分类清单：前端从这里取名字，自己配上 emoji 和颜色
CATEGORIES = {
    "expense": ["餐饮", "奶茶", "交通", "购物", "娱乐", "学习", "日用", "医疗", "话费", "其他"],
    "income": ["生活费", "兼职", "奖学金", "红包", "其他"],
}

DEFAULT_BUDGET = 1500.0   # 默认月预算，学生党先按 1500 算，可在页面上改


# ------------------------------------------------------------
#  仓库：连数据库 / 建表 / 读写设置
# ------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """建表。IF NOT EXISTS = 表已存在就跳过，所以重启程序数据不丢"""
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS records (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            amount     REAL NOT NULL,        -- 金额（永远是正数，靠 type 区分收支）
            type       TEXT NOT NULL,        -- income / expense
            category   TEXT NOT NULL,
            note       TEXT DEFAULT '',
            created_at TEXT NOT NULL         -- 'YYYY-MM-DD HH:MM'
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('budget', ?)",
                 (str(DEFAULT_BUDGET),))
    conn.commit()
    conn.close()


init_db()


def get_setting(key, default):
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    return float(row["value"]) if row else default


def set_setting(key, value):
    conn = get_db()
    conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 (key, str(value)))
    conn.commit()
    conn.close()


def row_to_dict(row):
    return {
        "id": row["id"],
        "amount": row["amount"],
        "type": row["type"],
        "category": row["category"],
        "note": row["note"],
        "created_at": row["created_at"],
    }


# ------------------------------------------------------------
#  小工具：月份处理
# ------------------------------------------------------------
def this_month():
    return datetime.now().strftime("%Y-%m")


def parse_month(raw):
    """把 '2026-11' 解成 (年, 月, 天数)；格式不对就返回 None"""
    try:
        year, month = int(raw[:4]), int(raw[5:7])
        if not (1 <= month <= 12):
            return None
        return year, month, calendar.monthrange(year, month)[1]
    except (ValueError, TypeError, IndexError):
        return None


def shift_month(month, delta):
    """上个月 / 下个月"""
    year, mon = int(month[:4]), int(month[5:7])
    mon += delta
    if mon < 1:
        year, mon = year - 1, 12
    elif mon > 12:
        year, mon = year + 1, 1
    return f"{year:04d}-{mon:02d}"


# ------------------------------------------------------------
#  门面：把页面发给浏览器
# ------------------------------------------------------------
@app.route("/")
def index():
    return render_template(
        "index.html",
        expense_cats=CATEGORIES["expense"],
        income_cats=CATEGORIES["income"],
    )


# ------------------------------------------------------------
#  接口
# ------------------------------------------------------------

# ① 账单列表（可按月过滤）—— GET /api/records?month=2026-11
@app.route("/api/records", methods=["GET"])
def list_records():
    month = request.args.get("month") or this_month()
    if not parse_month(month):
        return jsonify({"error": "月份格式应为 YYYY-MM"}), 400

    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM records WHERE substr(created_at, 1, 7) = ? "
        "ORDER BY created_at DESC, id DESC",
        (month,),
    ).fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])


def read_record_input(data):
    """厨房验菜：把前端传来的 JSON 洗成能入库的 5 个值。
    新增和修改共用这一份校验，免得出现\"新增拦得住、修改拦不住\"的漏洞。
    返回 (值, 错误信息)；出错时值为 None。"""
    try:
        amount = round(float(data.get("amount", 0)), 2)
    except (TypeError, ValueError):
        return None, "金额得是数字"
    if amount <= 0:
        return None, "金额要大于 0"

    rtype = data.get("type", "expense")
    if rtype not in CATEGORIES:
        return None, "类型只能是 income 或 expense"

    category = data.get("category") or CATEGORIES[rtype][-1]
    if category not in CATEGORIES[rtype]:
        category = CATEGORIES[rtype][-1]

    # 允许补记以前的账：前端传 date（YYYY-MM-DD）；不传交给调用方决定
    day = data.get("date") or None
    if day:
        try:
            datetime.strptime(day, "%Y-%m-%d")
        except ValueError:
            return None, "日期格式应为 YYYY-MM-DD"

    return (amount, rtype, category, (data.get("note") or "")[:50], day), None


# ② 记一笔 —— POST /api/records
@app.route("/api/records", methods=["POST"])
def add_record():
    data = request.get_json(silent=True) or {}

    parsed, err = read_record_input(data)
    if err:
        return jsonify({"error": err}), 400
    amount, rtype, category, note, day = parsed

    # 没传日期就用今天
    day = day or datetime.now().strftime("%Y-%m-%d")
    created_at = f"{day} {datetime.now().strftime('%H:%M')}"

    conn = get_db()
    cursor = conn.execute(
        "INSERT INTO records (amount, type, category, note, created_at) VALUES (?, ?, ?, ?, ?)",
        (amount, rtype, category, note, created_at),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM records WHERE id = ?", (cursor.lastrowid,)).fetchone()
    conn.close()
    return jsonify(row_to_dict(row)), 201


# ②·改 改一笔 —— PUT /api/records/<id>
@app.route("/api/records/<int:record_id>", methods=["PUT"])
def update_record(record_id):
    data = request.get_json(silent=True) or {}

    parsed, err = read_record_input(data)
    if err:
        return jsonify({"error": err}), 400
    amount, rtype, category, note, day = parsed

    conn = get_db()
    row = conn.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify({"error": "这笔账不存在"}), 404

    # 没传日期就保留原来的日期；改了日期也保留原来的"时分"，
    # 免得改个金额就把记账时间刷成现在
    old_day, old_time = row["created_at"][:10], row["created_at"][11:] or "12:00"
    created_at = f"{day or old_day} {old_time}"

    conn.execute(
        "UPDATE records SET amount = ?, type = ?, category = ?, note = ?, created_at = ? "
        "WHERE id = ?",
        (amount, rtype, category, note, created_at, record_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
    conn.close()
    return jsonify(row_to_dict(row))


# ③ 删一笔 —— DELETE /api/records/<id>
@app.route("/api/records/<int:record_id>", methods=["DELETE"])
def delete_record(record_id):
    conn = get_db()
    conn.execute("DELETE FROM records WHERE id = ?", (record_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ④ 清空全部 —— DELETE /api/records/all
@app.route("/api/records/all", methods=["DELETE"])
def clear_records():
    conn = get_db()
    conn.execute("DELETE FROM records")
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ⑤ 设置月预算 —— POST /api/budget
@app.route("/api/budget", methods=["POST"])
def set_budget():
    data = request.get_json(silent=True) or {}
    try:
        budget = round(float(data.get("budget", 0)), 2)
    except (TypeError, ValueError):
        return jsonify({"error": "预算得是数字"}), 400
    if budget <= 0:
        return jsonify({"error": "预算要大于 0"}), 400
    set_setting("budget", budget)
    return jsonify({"budget": budget})


# ⑥ 统计 —— GET /api/stats?month=2026-11
#    核心思想：所有数字都在厨房算好，前端只负责摆到页面上
@app.route("/api/stats", methods=["GET"])
def stats():
    month = request.args.get("month") or this_month()
    parsed = parse_month(month)
    if not parsed:
        return jsonify({"error": "月份格式应为 YYYY-MM"}), 400
    _, _, days_in_month = parsed

    conn = get_db()

    def total(rtype):
        return conn.execute(
            "SELECT COALESCE(SUM(amount), 0) FROM records "
            "WHERE type = ? AND substr(created_at, 1, 7) = ?",
            (rtype, month),
        ).fetchone()[0]

    total_income = total("income")
    total_expense = total("expense")

    # 分类汇总（只统计支出）：花得多的排前面
    cat_rows = conn.execute("""
        SELECT category, SUM(amount) AS total, COUNT(*) AS cnt
        FROM records
        WHERE type = 'expense' AND substr(created_at, 1, 7) = ?
        GROUP BY category
        ORDER BY total DESC
    """, (month,)).fetchall()

    # 每天花了多少：先铺一整月的 0，再把有账的日子填进去
    daily = [0.0] * days_in_month
    day_rows = conn.execute("""
        SELECT CAST(substr(created_at, 9, 2) AS INTEGER) AS d, SUM(amount) AS total
        FROM records
        WHERE type = 'expense' AND substr(created_at, 1, 7) = ?
        GROUP BY d
    """, (month,)).fetchall()
    for r in day_rows:
        if 1 <= r["d"] <= days_in_month:
            daily[r["d"] - 1] = round(r["total"], 2)

    count = conn.execute(
        "SELECT COUNT(*) FROM records WHERE substr(created_at, 1, 7) = ?", (month,)
    ).fetchone()[0]
    conn.close()

    # —— 下面这些是"拒绝糊涂账"的关键：预算还剩多少、每天还能花多少
    budget = get_setting("budget", DEFAULT_BUDGET)
    budget_left = round(budget - total_expense, 2)

    now = datetime.now()
    is_current = (month == now.strftime("%Y-%m"))
    # 剩余天数：本月=含今天到最后一天；看历史月份=0；看未来月份=整月
    if is_current:
        days_left = days_in_month - now.day + 1
    elif month < now.strftime("%Y-%m"):
        days_left = 0
    else:
        days_left = days_in_month
    per_day_left = round(budget_left / days_left, 2) if days_left > 0 else 0

    # —— 按现在的花法往后推：这才是"糊涂账"变"明白账"的那一下
    # 已经过了几天（本月=今天几号；历史月份=整月；未来月份=0，没什么可推的）
    if is_current:
        elapsed_days = now.day
    elif month < now.strftime("%Y-%m"):
        elapsed_days = days_in_month
    else:
        elapsed_days = 0
    daily_avg = round(total_expense / elapsed_days, 2) if elapsed_days else 0
    # 才过一两天就预测没意义，波动太大
    projected = round(daily_avg * days_in_month, 2) if elapsed_days >= 3 else None

    by_category = []
    for r in cat_rows:
        pct = round(r["total"] / total_expense * 100, 1) if total_expense else 0
        by_category.append({
            "category": r["category"],
            "total": round(r["total"], 2),
            "count": r["cnt"],
            "pct": pct,
        })

    return jsonify({
        "month": month,
        "prev_month": shift_month(month, -1),
        "next_month": shift_month(month, 1),
        "is_current": is_current,
        "days_in_month": days_in_month,
        "days_left": days_left,
        "total_income": round(total_income, 2),
        "total_expense": round(total_expense, 2),
        "balance": round(total_income - total_expense, 2),
        "budget": budget,
        "budget_left": budget_left,
        "used_pct": round(total_expense / budget * 100, 1) if budget else 0,
        "per_day_left": per_day_left,
        "elapsed_days": elapsed_days,
        "daily_avg": daily_avg,
        "projected_expense": projected,
        "projected_left": round(budget - projected, 2) if projected is not None else None,
        "count": count,
        "top_category": by_category[0]["category"] if by_category else None,
        "top_category_total": by_category[0]["total"] if by_category else 0,
        "top_category_pct": by_category[0]["pct"] if by_category else 0,
        "by_category": by_category,
        "daily": daily,
    })


# ⑦ 塞一份示例账单 —— POST /api/demo
#    纯粹为了让你第一眼看到页面长什么样，随时可以清空
@app.route("/api/demo", methods=["POST"])
def load_demo():
    rnd = random.Random(20261103)     # 固定种子，每次生成的数据都一样，方便对比
    today = datetime.now()
    cur, prev = this_month(), shift_month(this_month(), -1)

    # 这个月里的大额支出：日期写死，过了那天才会出现
    BIG = [
        (2,  "学习", 68.0,                          "网课资料"),
        (3,  "购物", round(rnd.uniform(89, 260), 1), "换季衣服"),
        (8,  "娱乐", round(rnd.uniform(30, 70), 1),  "电影和宵夜"),
        (11, "学习", round(rnd.uniform(35, 90), 1),  "专业书"),
        (15, "话费", 39.0,                           "校园套餐"),
        (18, "购物", round(rnd.uniform(45, 120), 1), "耳机"),
        (21, "娱乐", round(rnd.uniform(25, 60), 1),  "KTV"),
    ]

    def build(month, last_day):
        """给某个月造账单，只造到 last_day 号为止 —— 日子没到就不该有账"""
        rows = [(f"{month}-01", "income", "生活费", 1500.0, "本月生活费")]
        if last_day >= 12:
            rows.append((f"{month}-12", "income", "兼职", 320.0, "家教两小时"))

        for d in range(1, last_day + 1):
            day = f"{month}-{d:02d}"
            # 餐饮：一天 1~3 顿
            for _ in range(rnd.choice([1, 1, 2, 2, 2, 3])):
                rows.append((day, "expense", "餐饮", round(rnd.uniform(8, 26), 1),
                             rnd.choice(["食堂", "食堂二楼", "牛肉面", "麻辣烫", "快餐"])))
            # 奶茶：三天两头一杯
            if d % 3 == 0 or d % 7 == 1:
                rows.append((day, "expense", "奶茶", round(rnd.uniform(9, 22), 1),
                             rnd.choice(["瑞幸", "古茗", "蜜雪"])))
            # 交通：隔几天一次
            if d % 4 == 0:
                rows.append((day, "expense", "交通", round(rnd.uniform(2, 9), 1),
                             rnd.choice(["公交", "地铁", "共享单车"])))
            # 日用：偶尔
            if d % 9 == 0:
                rows.append((day, "expense", "日用", round(rnd.uniform(12, 45), 1),
                             rnd.choice(["洗衣液", "纸巾", "洗发水"])))

        for d, cat, amount, note in BIG:
            if d <= last_day:
                rows.append((f"{month}-{d:02d}", "expense", cat, amount, note))
        if last_day >= 20:
            rows.append((f"{month}-20", "expense", "医疗", 58.0, "感冒药"))
        return rows

    # 上个月造整月（看起来是个"过完了的月"），本月只造到昨天
    plan = build(prev, parse_month(prev)[2]) + build(cur, max(1, today.day - 1))

    conn = get_db()
    conn.execute("DELETE FROM records")
    conn.executemany(
        "INSERT INTO records (amount, type, category, note, created_at) VALUES (?, ?, ?, ?, ?)",
        [(a, t, c, n, f"{day} {rnd.randint(7, 21):02d}:{rnd.randint(0, 59):02d}")
         for day, t, c, a, n in plan],
    )
    conn.commit()
    n = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
    conn.close()
    return jsonify({"ok": True, "count": n})


if __name__ == "__main__":
    print("生活费账本开张啦 → http://127.0.0.1:5001")
    # 关掉自动重载：重载器会派生父子两个进程，反复重启容易在端口上堆一堆僵尸
    app.run(debug=True, port=5001, use_reloader=False)
