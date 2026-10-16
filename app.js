import html
import re
import sqlite3
import subprocess
import json
from datetime import datetime, date, time
from pathlib import Path

import streamlit as st

DB = Path.cwd() / "consumables.db"
ADMIN_PW = "6011"


def db():
    c = sqlite3.connect(DB, timeout=15)
    c.row_factory = sqlite3.Row
    return c



def force_cancel_firebase(reservation_no):
    """Firebase 예약을 강제취소하고 예약수량/시간대 사용량을 원복."""
    helper_path = Path.cwd() / "firebase_sync.py"
    if not helper_path.exists():
        return {"ok": False, "error": "firebase_sync.py 파일이 없습니다."}
    try:
        completed = subprocess.run(
            ["py", str(helper_path), "cancel", "--reservation-no", str(reservation_no)],
            cwd=Path.cwd(), capture_output=True, text=True, timeout=60,
        )
        lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
        if lines:
            try:
                return json.loads(lines[-1])
            except json.JSONDecodeError:
                pass
        return {"ok": False, "error": (completed.stderr or completed.stdout or "Firebase 강제취소 실패").strip()}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

def force_receive_firebase(reservation_no, user):
    """Firebase 예약을 먼저 수령완료 처리해 자동수신 재생성을 방지합니다."""
    helper_path = Path.cwd() / "firebase_sync.py"
    if not helper_path.exists():
        return {"ok": False, "error": "firebase_sync.py 파일이 없습니다."}
    try:
        completed = subprocess.run(
            ["py", str(helper_path), "receive", "--reservation-no", str(reservation_no),
             "--receiver-card-id", str(user["card_id"] or ""),
             "--receiver-emp-id", str(user["emp_id"] or ""),
             "--receiver-name", str(user["name"] or "")],
            cwd=Path.cwd(), capture_output=True, text=True, timeout=60,
        )
        lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
        if lines:
            try:
                return json.loads(lines[-1])
            except json.JSONDecodeError:
                pass
        return {"ok": False, "error": (completed.stderr or completed.stdout or "Firebase 수령완료 실패").strip()}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

def init_db():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users(
            card_id TEXT PRIMARY KEY,
            emp_id TEXT,
            name TEXT NOT NULL,
            dept TEXT,
            role TEXT NOT NULL DEFAULT '사용자',
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS items(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            stock INTEGER NOT NULL DEFAULT 0,
            target_stock INTEGER NOT NULL DEFAULT 0,
            state TEXT,
            unit TEXT NOT NULL DEFAULT '개',
            pack_unit TEXT NOT NULL DEFAULT '박스',
            pack_qty INTEGER NOT NULL DEFAULT 1,
            ship_limit TEXT,
            stock_state TEXT,
            max_qty INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS transactions(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            type TEXT NOT NULL,
            card_id TEXT,
            emp_id TEXT,
            name TEXT,
            dept TEXT,
            item_id INTEGER,
            item_name TEXT NOT NULL,
            qty INTEGER NOT NULL,
            display_qty TEXT,
            status TEXT NOT NULL DEFAULT '정상',
            cancel_at TEXT,
            source TEXT NOT NULL DEFAULT '시스템'
        );
        """)
        # 기존 DB 자동 보강
        table_cols = {
            "users": {r["name"] for r in c.execute("PRAGMA table_info(users)")},
            "items": {r["name"] for r in c.execute("PRAGMA table_info(items)")},
            "transactions": {r["name"] for r in c.execute("PRAGMA table_info(transactions)")},
        }
        additions = {
            "users": [("active", "INTEGER NOT NULL DEFAULT 1")],
            "items": [
                ("target_stock", "INTEGER NOT NULL DEFAULT 0"),
                ("state", "TEXT"), ("ship_limit", "TEXT"),
                ("stock_state", "TEXT"), ("active", "INTEGER NOT NULL DEFAULT 1"),
                ("reservable", "INTEGER NOT NULL DEFAULT 0"),
                ("reservation_max_qty", "INTEGER NOT NULL DEFAULT 0"),
                ("reservation_unit", "TEXT NOT NULL DEFAULT '박스+낱개'"),
                ("reservation_min_stock", "INTEGER NOT NULL DEFAULT 0"),
                ("category", "TEXT NOT NULL DEFAULT '기타'")
            ],
            "transactions": [("source", "TEXT NOT NULL DEFAULT '시스템'")],
        }
        for table, cols in additions.items():
            for col, definition in cols:
                if col not in table_cols[table]:
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {definition}")
        c.execute("UPDATE items SET category='기타' WHERE category IS NULL OR TRIM(category)=''")
        c.executescript("""
        CREATE TABLE IF NOT EXISTS reservation_settings(
          id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER DEFAULT 1,
          notice TEXT DEFAULT '예약할 품목과 수령 시간을 선택해주세요.',
          weekdays TEXT DEFAULT '0,1,2,3,4', days_ahead INTEGER DEFAULT 14,
          cutoff_hours INTEGER DEFAULT 2, cancel_hours INTEGER DEFAULT 2);
        INSERT OR IGNORE INTO reservation_settings(id) VALUES(1);
        CREATE TABLE IF NOT EXISTS reservation_slots(
          id INTEGER PRIMARY KEY AUTOINCREMENT, slot_time TEXT UNIQUE,
          capacity INTEGER DEFAULT 3, active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS brands(
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS reservations(
          id INTEGER PRIMARY KEY AUTOINCREMENT, reservation_no TEXT UNIQUE,
          brand TEXT, booking_date TEXT, booking_time TEXT, item_id INTEGER,
          item_name TEXT, qty INTEGER, display_qty TEXT, status TEXT DEFAULT '예약',
          created_at TEXT, receiver_card_id TEXT, receiver_emp_id TEXT,
          receiver_name TEXT, received_at TEXT, cancel_at TEXT);
        """)
        reservation_setting_cols = {r["name"] for r in c.execute("PRAGMA table_info(reservation_settings)")}
        reservation_setting_additions = [
            ("application_start_time", "TEXT NOT NULL DEFAULT '10:00'"),
            ("application_end_time", "TEXT NOT NULL DEFAULT '11:30'"),
            ("pickup_day_offset", "INTEGER NOT NULL DEFAULT 1"),
        ]
        for col, definition in reservation_setting_additions:
            if col not in reservation_setting_cols:
                c.execute(f"ALTER TABLE reservation_settings ADD COLUMN {col} {definition}")

        if c.execute("SELECT COUNT(*) FROM reservation_slots").fetchone()[0] == 0:
            c.executemany("INSERT INTO reservation_slots(slot_time,capacity) VALUES(?,?)",
                          [("10:00",3),("11:00",3),("14:00",3),("15:00",3)])



def calculated_inventory_values(item):
    stock = max(0, int(item["stock"] or 0))
    target = max(0, int(item["target_stock"] or 0))
    pack_qty = max(1, int(item["pack_qty"] or 1))
    unit = str(item["unit"] or "개")
    pack_unit = str(item["pack_unit"] or "박스")

    if stock <= 0:
        state = "품절"
    elif target > 0 and stock < target:
        state = "부족"
    else:
        state = "정상"

    if pack_qty <= 1:
        stock_state = f"{stock}{unit}"
    else:
        boxes, remainder = divmod(stock, pack_qty)
        if boxes and remainder:
            stock_state = f"{boxes}{pack_unit} {remainder}{unit}"
        elif boxes:
            stock_state = f"{boxes}{pack_unit}"
        else:
            stock_state = f"{remainder}{unit}"
    return state, stock_state


def refresh_inventory_states():
    """현재고/적정재고/포장정보를 기준으로 상태와 재고상태를 항상 다시 계산."""
    with db() as con:
        item_list = con.execute("SELECT * FROM items").fetchall()
        for item in item_list:
            state, stock_state = calculated_inventory_values(item)
            if (item["state"] or "") != state or (item["stock_state"] or "") != stock_state:
                con.execute("UPDATE items SET state=?,stock_state=? WHERE id=?",
                            (state, stock_state, item["id"]))


def normal(v):
    return str(v or "").strip().upper()


def smart_tag(v):
    s = normal(v).replace(" ", "")
    try:
        if len(s) >= 6 and not s.isdigit():
            fac = int(s[4:6], 16)
            ident = int(s[2:4] + s[0:2], 16)
            return f"{fac}{ident:05d}".zfill(8)
        if s.isdigit():
            return str(int(s)).zfill(8)
    except (ValueError, IndexError):
        pass
    return s


def find_user(value):
    q1, q2 = normal(value), smart_tag(value)
    with db() as c:
        return c.execute("""
            SELECT * FROM users
            WHERE active=1 AND (
                UPPER(TRIM(card_id)) IN (?,?) OR
                UPPER(TRIM(emp_id)) IN (?,?)
            ) LIMIT 1
        """, (q1, q2, q1, q2)).fetchone()


def item_rows(active_only=True):
    with db() as c:
        sql = "SELECT * FROM items"
        if active_only:
            sql += " WHERE active=1"
        return c.execute(sql + " ORDER BY name").fetchall()


def item_by_name(name):
    with db() as c:
        return c.execute("SELECT * FROM items WHERE name=?", (name,)).fetchone()


def item_by_id(item_id):
    with db() as c:
        return c.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()


def qty_text(qty, item):
    qty = int(qty)
    pqty = max(1, int(item["pack_qty"] or 1))
    unit = item["unit"] or "개"
    pack = item["pack_unit"] or "박스"
    if pqty <= 1:
        return f"{qty}{unit}"
    box, rem = divmod(qty, pqty)
    if box and rem:
        return f"{box}{pack} {rem}{unit}"
    if box:
        return f"{box}{pack}"
    return f"{rem}{unit}"


def parse_int(v):
    try:
        return int(float(str(v).replace(",", "").strip() or "0"))
    except (ValueError, TypeError):
        return 0


def parse_datetime(v):
    text = str(v or "").strip()
    for fmt in (
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
        "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y/%m/%d",
        "%Y.%m.%d %H:%M:%S", "%Y.%m.%d"
    ):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def parse_clipboard(text):
    return [[cell.strip() for cell in line.split("\t")]
            for line in text.splitlines() if line.strip()]


def is_header(row):
    s = " ".join(row).replace(" ", "")
    return any(word in s for word in ("카드번호", "물품명", "품목명", "현재고", "사번", "일시", "날짜"))


def quantity_from_display(raw, item):
    """1박스 20개 같은 과거 수령기록을 낱개 수량으로 변환."""
    text = str(raw or "").strip().replace(",", "")
    if not text:
        return 0
    if re.fullmatch(r"[-+]?\d+(?:\.0+)?", text):
        return parse_int(text)
    pack_qty = max(1, int(item["pack_qty"] or 1))
    pack_unit = re.escape(item["pack_unit"] or "박스")
    unit = re.escape(item["unit"] or "개")
    pack_match = re.search(rf"(\d+)\s*{pack_unit}", text)
    unit_matches = re.findall(rf"(\d+)\s*{unit}", text)
    boxes = int(pack_match.group(1)) if pack_match else 0
    singles = int(unit_matches[-1]) if unit_matches else 0
    if boxes or singles:
        return boxes * pack_qty + singles
    nums = re.findall(r"\d+", text)
    return int("".join(nums)) if nums else 0


def checkout(user, cart):
    now = datetime.now().isoformat(timespec="seconds")
    receipt_lines = []
    with db() as c:
        c.execute("BEGIN IMMEDIATE")
        for line in cart.values():
            item = c.execute("SELECT * FROM items WHERE id=?", (line["item_id"],)).fetchone()
            if not item or item["stock"] < line["qty"]:
                raise ValueError(f"{line['name']} 재고가 부족합니다.")
            if item["max_qty"] > 0 and line["qty"] > item["max_qty"] and not line.get("approved"):
                raise ValueError(f"{line['name']} 최대수량을 초과했습니다.")
        for line in cart.values():
            item = c.execute("SELECT * FROM items WHERE id=?", (line["item_id"],)).fetchone()
            note = qty_text(line["qty"], item)
            c.execute("UPDATE items SET stock=stock-? WHERE id=?", (line["qty"], line["item_id"]))
            c.execute("""
                INSERT INTO transactions(
                    created_at,type,card_id,emp_id,name,dept,item_id,item_name,
                    qty,display_qty,status,source
                ) VALUES(?,?,?,?,?,?,?,?,?,?,'정상','시스템')
            """, (now, "출고", user["card_id"], user["emp_id"], user["name"],
                  user["dept"], line["item_id"], line["name"], line["qty"], note))
            receipt_lines.append((line["name"], note))
    return {"dept": user["dept"], "emp_id": user["emp_id"], "name": user["name"],
            "at": now, "lines": receipt_lines}


def add_stock(item_id, qty, actor="관리자"):
    now = datetime.now().isoformat(timespec="seconds")
    with db() as c:
        c.execute("BEGIN IMMEDIATE")
        item = c.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
        if not item:
            raise ValueError("품목을 찾을 수 없습니다.")
        note = qty_text(qty, item)
        c.execute("UPDATE items SET stock=stock+? WHERE id=?", (qty, item_id))
        c.execute("""
            INSERT INTO transactions(created_at,type,name,item_id,item_name,qty,display_qty,status,source)
            VALUES(?,?,?,?,?,?,?,'정상','시스템')
        """, (now, "입고", actor, item_id, item["name"], qty, note))


def cancel_transaction(tx_id):
    with db() as c:
        c.execute("BEGIN IMMEDIATE")
        tx = c.execute("SELECT * FROM transactions WHERE id=? AND status='정상'", (tx_id,)).fetchone()
        if not tx:
            raise ValueError("취소 가능한 기록이 아닙니다.")
        stock = c.execute("SELECT stock FROM items WHERE id=?", (tx["item_id"],)).fetchone()
        delta = tx["qty"] if tx["type"] == "출고" else -tx["qty"]
        if not stock or stock["stock"] + delta < 0:
            raise ValueError("원복하면 재고가 음수가 됩니다.")
        c.execute("UPDATE items SET stock=stock+? WHERE id=?", (delta, tx["item_id"]))
        c.execute("UPDATE transactions SET status='취소',cancel_at=? WHERE id=?",
                  (datetime.now().isoformat(timespec="seconds"), tx_id))


def receipt_html(receipt):
    rows = "".join(
        f"<div class='line'>- {html.escape(str(name))} / {html.escape(str(note))}</div>"
        for name, note in receipt["lines"]
    )
    return f"""<!doctype html><html><head><meta charset='utf-8'>
    <style>
    @page{{size:80mm auto;margin:4mm}} body{{font-family:'Malgun Gothic',sans-serif;width:70mm;font-size:13px}}
    h3{{text-align:center;margin:5px}} .line{{margin:6px 0}} hr{{border:0;border-top:1px dashed #555}}
    button{{width:100%;padding:10px;font-size:15px;margin-top:12px}}
    @media print{{button{{display:none}}}}
    </style></head><body>
    <h3>소모품 수령 영수증</h3>
    <div>브랜드 : {html.escape(str(receipt['dept']))}</div>
    <div>사번 / 이름 : {html.escape(str(receipt['emp_id']))} / {html.escape(str(receipt['name']))}</div>
    <div>일시 : {html.escape(str(receipt['at']))}</div><hr>{rows}<hr>
    <button onclick='window.print()'>영수증 인쇄</button>
    </body></html>"""


def monthly_statistics(year, month):
    with db() as c:
        rows = c.execute("""
            SELECT created_at,dept,item_name,qty FROM transactions
            WHERE type='출고' AND status='정상' ORDER BY created_at
        """).fetchall()
    groups = {}
    for row in rows:
        dt = parse_datetime(row["created_at"])
        if not dt:
            continue
        key = (row["dept"] or "", row["item_name"] or "")
        g = groups.setdefault(key, {"total": 0, "months": set(), "dates": [], "target": 0})
        qty = int(row["qty"] or 0)
        g["total"] += qty
        g["months"].add((dt.year, dt.month))
        g["dates"].append(dt.date())
        if dt.year == year and dt.month == month:
            g["target"] += qty
    result = []
    for (dept, item), g in groups.items():
        if g["target"] <= 0:
            continue
        avg = round(g["total"] / max(1, len(g["months"])), 1)
        target = g["target"]
        ratio = round(target / (avg if avg else 1), 1)
        analysis = f"⚠ 과수령 주의 ({ratio}배)" if target > avg * 1.5 and target > 5 else "정상 범위"
        dates = sorted(g["dates"])
        count = len(dates)
        if count < 2:
            life = "신규 불출 (비교불가)"
        else:
            gaps = [(dates[i + 1] - dates[i]).days for i in range(count - 1)]
            days = round(sum(gaps) / len(gaps))
            life = "당일 연속 수령" if days == 0 else f"{round(days / 30.4, 1)}개월 ({days}일)"
        result.append({
            "브랜드(부서)": dept, "품목명": item,
            f"{month}월 불출 수량": target, "평소 월평균 불출량": avg,
            "과수령 분석 결과": analysis, "평균 자재 유지 기간": life,
            "총 불출 횟수": f"{count}회"
        })
    return sorted(result, key=lambda x: (x["브랜드(부서)"], x["품목명"]))


def flash(message):
    st.session_state["flash"] = message
    st.rerun()


def show_flash():
    if st.session_state.get("flash"):
        st.success(st.session_state.pop("flash"))


def bulk_import_tab():
    st.subheader("📋 Excel 복붙 일괄등록")
    staff_tab, item_tab, out_tab, in_tab = st.tabs(["직원명부", "재고목록", "과거 수령기록", "과거 입고기록"])

    with staff_tab:
        text = st.text_area("A 카드번호 | B 사번 | C 성명 | D 브랜드 | E 권한", height=170,
                            key="paste_staff", placeholder="Excel A:E 범위를 복사해 붙여넣기")
        rows = parse_clipboard(text)
        data = rows[1:] if rows and is_header(rows[0]) else rows
        preview = [{"카드번호": r[0], "사번": r[1], "성명": r[2],
                    "브랜드": r[3] if len(r) > 3 else "",
                    "권한": r[4] if len(r) > 4 and r[4] else "사용자"}
                   for r in data if len(r) >= 3]
        if preview:
            st.dataframe(preview, use_container_width=True, hide_index=True)
        if st.button("직원명부 일괄등록", type="primary"):
            ok, bad = 0, []
            with db() as c:
                for i, r in enumerate(data, 1):
                    if len(r) < 3 or not r[0] or not r[2]:
                        bad.append(i); continue
                    card, emp, name = normal(r[0]), str(r[1]).strip(), r[2].strip()
                    dept = r[3].strip() if len(r) > 3 else ""
                    role = r[4].strip() if len(r) > 4 and r[4].strip() else "사용자"
                    old = c.execute("SELECT card_id FROM users WHERE UPPER(TRIM(card_id))=?", (card,)).fetchone()
                    if old:
                        c.execute("UPDATE users SET emp_id=?,name=?,dept=?,role=?,active=1 WHERE card_id=?",
                                  (emp, name, dept, role, old["card_id"]))
                    else:
                        c.execute("INSERT INTO users(card_id,emp_id,name,dept,role,active) VALUES(?,?,?,?,?,1)",
                                  (card, emp, name, dept, role))
                    ok += 1
            flash(f"직원명부 {ok}건 등록/업데이트 완료" + (f" / 오류행 {bad}" if bad else ""))

    with item_tab:
        text = st.text_area(
            "A 물품명 | B 현재고 | C 적정재고 | D 상태 | E 단위 | F 포장단위 | G 입수량 | H 출고제한(날개) | I 재고상태 | J 최대수량",
            height=190, key="paste_items", placeholder="Excel A:J 범위를 복사해 붙여넣기")
        rows = parse_clipboard(text)
        data = rows[1:] if rows and is_header(rows[0]) else rows
        preview = []
        for r in data:
            if r:
                preview.append({"물품명": r[0], "현재고": r[1] if len(r)>1 else 0,
                                "적정재고": r[2] if len(r)>2 else 0,
                                "단위": r[4] if len(r)>4 else "개",
                                "포장단위": r[5] if len(r)>5 else "박스",
                                "입수량": r[6] if len(r)>6 else 1,
                                "최대수량": r[9] if len(r)>9 else 0})
        if preview:
            st.dataframe(preview, use_container_width=True, hide_index=True)
        if st.button("재고목록 일괄등록", type="primary"):
            ok, bad = 0, []
            with db() as c:
                for i, r in enumerate(data, 1):
                    if not r or not r[0].strip():
                        bad.append(i); continue
                    values = (
                        r[0].strip(), parse_int(r[1] if len(r)>1 else 0),
                        parse_int(r[2] if len(r)>2 else 0), r[3].strip() if len(r)>3 else "",
                        r[4].strip() if len(r)>4 and r[4].strip() else "개",
                        r[5].strip() if len(r)>5 and r[5].strip() else "박스",
                        max(1, parse_int(r[6] if len(r)>6 else 1)),
                        r[7].strip() if len(r)>7 else "", r[8].strip() if len(r)>8 else "",
                        parse_int(r[9] if len(r)>9 else 0)
                    )
                    c.execute("""
                        INSERT INTO items(name,stock,target_stock,state,unit,pack_unit,pack_qty,ship_limit,stock_state,max_qty,active)
                        VALUES(?,?,?,?,?,?,?,?,?,?,1)
                        ON CONFLICT(name) DO UPDATE SET
                            stock=excluded.stock,target_stock=excluded.target_stock,state=excluded.state,
                            unit=excluded.unit,pack_unit=excluded.pack_unit,pack_qty=excluded.pack_qty,
                            ship_limit=excluded.ship_limit,stock_state=excluded.stock_state,
                            max_qty=excluded.max_qty,active=1
                    """, values)
                    ok += 1
            flash(f"재고목록 {ok}건 등록/업데이트 완료" + (f" / 오류행 {bad}" if bad else ""))

    with out_tab:
        st.info("현재고는 변경하지 않고 과거 이력만 가져옵니다.")
        text = st.text_area("A 일시 | B 사번 | C 이름 | D 브랜드 | E 품목명 | F 표시수량",
                            height=180, key="paste_out", placeholder="수령기록 A:F 복붙")
        rows = parse_clipboard(text)
        data = rows[1:] if rows and is_header(rows[0]) else rows
        if data:
            st.dataframe([{"일시":r[0], "사번":r[1] if len(r)>1 else "", "이름":r[2] if len(r)>2 else "",
                           "브랜드":r[3] if len(r)>3 else "", "품목":r[4] if len(r)>4 else "",
                           "수량":r[5] if len(r)>5 else ""} for r in data], use_container_width=True, hide_index=True)
        if st.button("과거 수령기록 가져오기", type="primary"):
            ok, bad = 0, []
            with db() as c:
                for i, r in enumerate(data, 1):
                    if len(r)<6:
                        bad.append(i); continue
                    dt, item = parse_datetime(r[0]), c.execute("SELECT * FROM items WHERE name=?", (r[4].strip(),)).fetchone()
                    if not dt or not item:
                        bad.append(i); continue
                    qty = quantity_from_display(r[5], item)
                    if qty <= 0:
                        bad.append(i); continue
                    # 동일한 과거기록 중복 방지
                    exists = c.execute("""SELECT 1 FROM transactions WHERE created_at=? AND type='출고' AND emp_id=? AND item_name=? AND qty=? AND source='이관'""",
                                       (dt.isoformat(sep=" ", timespec="seconds"), r[1].strip(), r[4].strip(), qty)).fetchone()
                    if not exists:
                        c.execute("""INSERT INTO transactions(created_at,type,emp_id,name,dept,item_id,item_name,qty,display_qty,status,source)
                                     VALUES(?,'출고',?,?,?,?,?,?,?,'정상','이관')""",
                                  (dt.isoformat(sep=" ",timespec="seconds"), r[1].strip(), r[2].strip(), r[3].strip(),
                                   item["id"], item["name"], qty, r[5].strip()))
                    ok += 1
            flash(f"과거 수령기록 {ok}건 처리 완료, 현재고 미반영" + (f" / 오류행 {bad}" if bad else ""))

    with in_tab:
        st.info("현재고는 변경하지 않고 과거 이력만 가져옵니다.")
        text = st.text_area("A 일시 | B 사번 | C 이름 | D 품목명 | E 실제수량 | F 표시수량",
                            height=180, key="paste_in", placeholder="입고기록 A:F 복붙")
        rows = parse_clipboard(text)
        data = rows[1:] if rows and is_header(rows[0]) else rows
        if data:
            st.dataframe([{"일시":r[0], "사번":r[1] if len(r)>1 else "", "이름":r[2] if len(r)>2 else "",
                           "품목":r[3] if len(r)>3 else "", "실제수량":r[4] if len(r)>4 else "",
                           "표시수량":r[5] if len(r)>5 else ""} for r in data], use_container_width=True, hide_index=True)
        if st.button("과거 입고기록 가져오기", type="primary"):
            ok, bad = 0, []
            with db() as c:
                for i, r in enumerate(data, 1):
                    if len(r)<5:
                        bad.append(i); continue
                    dt, item, qty = parse_datetime(r[0]), c.execute("SELECT * FROM items WHERE name=?", (r[3].strip(),)).fetchone(), parse_int(r[4])
                    if not dt or not item or qty<=0:
                        bad.append(i); continue
                    note = r[5].strip() if len(r)>5 and r[5].strip() else qty_text(qty,item)
                    exists = c.execute("""SELECT 1 FROM transactions WHERE created_at=? AND type='입고' AND emp_id=? AND item_name=? AND qty=? AND source='이관'""",
                                       (dt.isoformat(sep=" ",timespec="seconds"), r[1].strip(), r[3].strip(), qty)).fetchone()
                    if not exists:
                        c.execute("""INSERT INTO transactions(created_at,type,emp_id,name,item_id,item_name,qty,display_qty,status,source)
                                     VALUES(?,'입고',?,?,?,?,?,?,'정상','이관')""",
                                  (dt.isoformat(sep=" ",timespec="seconds"), r[1].strip(), r[2].strip(), item["id"], item["name"], qty, note))
                    ok += 1
            flash(f"과거 입고기록 {ok}건 처리 완료, 현재고 미반영" + (f" / 오류행 {bad}" if bad else ""))


def original_general_page():
    st.title("📦 소모품 수령 시스템")
    card = st.text_input("사원증을 태그해주세요", placeholder="카드번호 또는 사번")
    user = find_user(card) if card.strip() else None
    if card and not user:
        st.error("등록되지 않은 사용자입니다.")
    if not user:
        return
    st.success(f"{user['name']} / {user['dept']} / {user['emp_id']}")
    rows = item_rows()
    if not rows:
        st.warning("등록된 품목이 없습니다."); return
    name = st.selectbox("품목 선택", [x["name"] for x in rows])
    item = item_by_name(name)
    already = st.session_state.cart.get(name, {}).get("qty", 0)
    limit = min(item["stock"], item["max_qty"]) if item["max_qty"] > 0 else item["stock"]
    available = max(0, limit - already)
    a,b,c = st.columns(3)
    a.metric("현재고", f"{item['stock']:,}{item['unit']}")
    b.metric("최대수량", "제한 없음" if item["max_qty"] == 0 else f"{item['max_qty']:,}{item['unit']}")
    c.metric("즉시 수령 가능", f"{available:,}{item['unit']}")
    left,right = st.columns(2)
    boxes = left.number_input(f"{item['pack_unit']} 수량 ({item['pack_qty']}{item['unit']}/{item['pack_unit']})", 0, step=1)
    singles = right.number_input(f"{item['unit']} 수량", 0, step=1)
    qty = int(boxes) * max(1,item["pack_qty"]) + int(singles)
    st.caption(f"입력 합계: {qty:,}{item['unit']}")
    if st.button("🛒 장바구니 담기", type="primary", use_container_width=True):
        total = already + qty
        if qty <= 0:
            st.error("수량을 입력해주세요.")
        elif total > item["stock"]:
            st.error("잔여 재고가 부족합니다.")
        elif item["max_qty"] > 0 and total > item["max_qty"]:
            st.session_state.pending = {"item":name,"total":total}
            st.warning("최대수량을 초과했습니다. 관리자 승인이 필요합니다.")
        else:
            st.session_state.cart[name] = {"item_id":item["id"],"name":name,"qty":total,"approved":False}
            st.rerun()
    if st.session_state.pending:
        pw = st.text_input("관리자 승인 비밀번호", type="password")
        if st.button("초과수령 승인"):
            if pw == ADMIN_PW:
                p=st.session_state.pending; it=item_by_name(p["item"])
                st.session_state.cart[p["item"]]={"item_id":it["id"],"name":p["item"],"qty":p["total"],"approved":True}
                st.session_state.pending=None; st.rerun()
            else:
                st.error("관리자 인증 실패")
    st.subheader("🛒 장바구니")
    for n,line in st.session_state.cart.items():
        st.write(f"• **{n}** {line['qty']:,}개" + (" 🔑 승인" if line.get("approved") else ""))
    if st.session_state.cart:
        l,r=st.columns(2)
        if l.button("비우기",use_container_width=True):
            st.session_state.cart={};st.session_state.pending=None;st.rerun()
        if r.button("✅ 수령확정",type="primary",use_container_width=True):
            try:
                st.session_state.receipt=checkout(user,st.session_state.cart)
                st.session_state.cart={};st.session_state.pending=None;st.rerun()
            except Exception as e:
                st.error(str(e))
    if st.session_state.receipt:
        st.success("수령 반영 완료")
        receipt = receipt_html(st.session_state.receipt)
        st.components.v1.html(receipt, height=360, scrolling=True)
        st.download_button("영수증 HTML 저장", receipt, "receipt.html", "text/html")
        if st.button("영수증 닫기"):
            st.session_state.receipt=None;st.rerun()



def receive_mode_cards():
    st.markdown("### 수령 방식을 선택하세요")
    left, right = st.columns(2)
    with left:
        st.markdown("""<div class='mode-card'><div class='mode-title'>📦 일반 수령</div>
        <div class='mode-desc'>예약 없이 바로 수령<br>카드 태그 → 품목 선택 → 수령확정</div></div>""", unsafe_allow_html=True)
        if st.button("일반 수령 시작", use_container_width=True,
                     type="primary" if st.session_state.receive_mode=="일반" else "secondary"):
            st.session_state.receive_mode="일반"; st.rerun()
    with right:
        st.markdown("""<div class='mode-card'><div class='mode-title'>📅 예약 수령</div>
        <div class='mode-desc'>브랜드 예약물품 수령<br>예약 선택 → 수령자 카드 태그 → 완료</div></div>""", unsafe_allow_html=True)
        if st.button("예약 수령 시작", use_container_width=True,
                     type="primary" if st.session_state.receive_mode=="예약" else "secondary"):
            st.session_state.receive_mode="예약"; st.rerun()


def reservation_root_no(reservation_no):
    """다품목 예약의 로컬 행 번호(R...-1, R...-2)를 원 신청번호로 묶습니다."""
    value = str(reservation_no or "").strip()
    head, sep, tail = value.rpartition("-")
    is_child = (
        sep and tail.isdigit()
        and ((value.startswith("예약-") and value.count("-") >= 4)
             or (value.startswith("R") and value.count("-") >= 2))
    )
    return head if is_child else value


def reservation_receive_page():
    st.divider()
    st.header("📅 예약 수령")
    with db() as con:
        pending_rows = con.execute(
            """SELECT * FROM reservations
               WHERE status='예약'
               ORDER BY booking_date,booking_time,reservation_no,id"""
        ).fetchall()

    if not pending_rows:
        st.info("현재 수령 대기 중인 예약이 없습니다.")
        return

    # 신청번호 기준으로 묶어 한 신청의 모든 품목을 한 번에 보여줍니다.
    applications = {}
    for row in pending_rows:
        root_no = reservation_root_no(row["reservation_no"])
        group = applications.setdefault(root_no, {
            "reservation_no": root_no,
            "brand": row["brand"],
            "booking_date": row["booking_date"],
            "booking_time": row["booking_time"],
            "rows": [],
        })
        group["rows"].append(row)

    st.markdown("**1. 수령할 신청의 행을 선택하세요.**")
    application_list = list(applications.values())
    receive_event = st.dataframe(
        [{
            "신청번호": x["reservation_no"],
            "브랜드": x["brand"],
            "수령일": x["booking_date"],
            "수령시간": x["booking_time"],
            "신청품목수": f"{len(x['rows'])}종",
            "신청품목 전체": " / ".join(
                f"{r['item_name']} {r['display_qty'] or str(r['qty'])+'개'}" for r in x["rows"]
            ),
        } for x in application_list],
        use_container_width=True,
        hide_index=True,
        on_select="rerun",
        selection_mode="single-row",
        key="reservation_receive_table",
    )
    receive_indices = list(receive_event.selection.rows)
    if not receive_indices:
        st.info("위 표에서 수령할 신청번호 행을 선택하세요.")
        return
    application = application_list[receive_indices[0]]
    brand = application["brand"]
    reservation_no = application["reservation_no"]
    application_rows = application["rows"]

    info1, info2, info3 = st.columns(3)
    info1.metric("신청번호", reservation_no)
    info2.metric("브랜드", brand)
    info3.metric(
        "수령 예정",
        f"{application['booking_date']} {application['booking_time']}",
    )

    st.markdown("##### 신청 품목 전체")
    item_table = [
        {
            "품목명": row["item_name"],
            "신청수량": row["display_qty"] or f"{row['qty']:,}개",
            "낱개환산": f"{row['qty']:,}개",
        }
        for row in application_rows
    ]
    st.dataframe(item_table, use_container_width=True, hide_index=True)
    st.caption(f"신청 품목 {len(application_rows)}종을 한 번에 수령 처리합니다.")

    st.markdown("**2. 실제 수령자 카드를 태그하세요.**")
    card = st.text_input(
        "카드번호 또는 사번",
        key="reserved_card",
        placeholder="해당 브랜드 직원의 카드를 태그하세요",
    )
    user = find_user(card) if card.strip() else None
    if card and not user:
        st.error("등록되지 않은 사용자입니다.")
        return
    if not user:
        return
    st.success(f"수령자 확인: {user['name']} / {user['dept']} / {user['emp_id']}")
    st.markdown("**3. 신청 품목 전체를 확인한 뒤 수령완료를 누르세요.**")
    if st.button(
        "✅ 신청 품목 전체 수령완료 및 재고차감",
        type="primary",
        use_container_width=True,
    ):
        cloud_result = force_receive_firebase(reservation_no, user)
        if not cloud_result.get("ok"):
            st.error(
                "Firebase 수령완료 반영에 실패해 로컬 재고도 변경하지 않았습니다. "
                + str(cloud_result.get("error") or "알 수 없는 오류")
            )
            return
        try:
            now = datetime.now().isoformat(timespec="seconds")
            receipt_lines = []
            with db() as con:
                con.execute("BEGIN IMMEDIATE")

                # 선택한 신청의 모든 행을 다시 조회하여 중복 처리를 방지합니다.
                current_rows = []
                for selected_row in application_rows:
                    current = con.execute(
                        "SELECT * FROM reservations WHERE id=? AND status='예약'",
                        (selected_row["id"],),
                    ).fetchone()
                    if not current:
                        raise ValueError(
                            "신청 품목 중 이미 처리되었거나 취소된 항목이 있습니다."
                        )
                    item = con.execute(
                        "SELECT * FROM items WHERE id=?",
                        (current["item_id"],),
                    ).fetchone()
                    if not item:
                        raise ValueError(f"{current['item_name']} 품목을 찾을 수 없습니다.")
                    if item["stock"] < current["qty"]:
                        raise ValueError(
                            f"{current['item_name']}의 현재 재고가 부족합니다. "
                            f"현재 {item['stock']:,}{item['unit']} / 신청 {current['qty']:,}{item['unit']}"
                        )
                    current_rows.append((current, item))

                # 모든 품목 검증이 끝난 뒤 한 번에 차감하고 완료 처리합니다.
                for current, item in current_rows:
                    con.execute(
                        "UPDATE items SET stock=stock-? WHERE id=?",
                        (current["qty"], current["item_id"]),
                    )
                    con.execute(
                        """INSERT INTO transactions(
                               created_at,type,card_id,emp_id,name,dept,item_id,item_name,
                               qty,display_qty,status,source
                           ) VALUES(?,?,?,?,?,?,?,?,?,?,'정상','예약수령')""",
                        (
                            now,
                            "출고",
                            user["card_id"],
                            user["emp_id"],
                            user["name"],
                            brand,
                            current["item_id"],
                            current["item_name"],
                            current["qty"],
                            current["display_qty"],
                        ),
                    )
                    con.execute(
                        """UPDATE reservations
                           SET status='수령완료',receiver_card_id=?,receiver_emp_id=?,
                               receiver_name=?,received_at=?
                           WHERE id=?""",
                        (
                            user["card_id"],
                            user["emp_id"],
                            user["name"],
                            now,
                            current["id"],
                        ),
                    )
                    receipt_lines.append(
                        (
                            current["item_name"],
                            current["display_qty"] or f"{current['qty']:,}개",
                        )
                    )

            st.session_state.receipt = {
                "dept": brand,
                "emp_id": user["emp_id"],
                "name": user["name"],
                "at": now,
                "lines": receipt_lines,
            }
            st.rerun()
        except Exception as exc:
            st.error(str(exc))


def operation_guide():
    st.markdown("""
    <div class="operation-guide">
      <div class="operation-guide-title">소모품 수령 안내</div>
      <div class="operation-guide-grid">
        <div class="operation-guide-card guide-direct">
          <div class="operation-guide-label">현장 직접수령</div>
          <div class="operation-guide-value">월~금 10:00~18:00</div>
          <div class="operation-guide-note">기존과 동일하게 현장에서 바로 수령할 수 있습니다.</div>
        </div>
        <div class="operation-guide-card guide-pause">
          <div class="operation-guide-label">현장 수령 제한시간</div>
          <div class="operation-guide-value">12:00~14:00</div>
          <div class="operation-guide-note">점심 및 재고 이동으로 현장 수령이 제한됩니다.</div>
        </div>
        <div class="operation-guide-card guide-reservation">
          <div class="operation-guide-label">추가된 모바일 예약</div>
          <div class="operation-guide-value">당일 10:00~11:30 신청</div>
          <div class="operation-guide-note">현장 직접수령과 별도로 이용할 수 있습니다.</div>
        </div>
        <div class="operation-guide-card guide-pickup">
          <div class="operation-guide-label">예약 물품 수령</div>
          <div class="operation-guide-value">익일 15:00~18:00</div>
          <div class="operation-guide-note">문의: 내선 6026</div>
        </div>
      </div>
    </div>
    """, unsafe_allow_html=True)


def user_page():
    st.title("📦 소모품 수령 시스템")
    operation_guide()
    if st.session_state.receipt:
        st.success("수령 처리가 완료되었습니다.")
        rh=receipt_html(st.session_state.receipt)
        st.components.v1.html(rh,height=360,scrolling=True)
        if st.button("새 수령 시작"):
            st.session_state.receipt=None; st.session_state.cart={}; st.rerun()
        return
    receive_mode_cards()
    if st.session_state.receive_mode=="일반":
        original_general_page()
    else:
        reservation_receive_page()


def reservation_item_admin():
    st.subheader("📦 품목별 예약 설정")
    data=item_rows(False)
    st.dataframe([{'품목':x['name'],'현재고':x['stock'],'예약대상':'사용' if x['reservable'] else '미사용','예약상한':x['reservation_max_qty'],'예약단위':x['reservation_unit']} for x in data],use_container_width=True,hide_index=True)
    if not data:return
    mp={x['name']:x for x in data}; it=mp[st.selectbox("품목",list(mp))]
    a,b,c=st.columns(3)
    enabled=a.toggle("예약 대상",value=bool(it['reservable']))
    maxq=b.number_input("1회 예약상한 (0=현재고)",0,value=int(it['reservation_max_qty'] or 0),step=1)
    units=['박스+낱개','박스만','낱개만']; unit=c.selectbox("예약 단위",units,index=units.index(it['reservation_unit'] or '박스+낱개'))
    if st.button("예약 설정 저장",type="primary"):
        with db() as con: con.execute("UPDATE items SET reservable=?,reservation_max_qty=?,reservation_unit=? WHERE id=?",(int(enabled),maxq,unit,it['id']))
        flash("품목 예약 설정을 저장했습니다.")


def reservation_brand_admin():
    st.subheader("🏪 브랜드 관리")
    with db() as con:data=con.execute("SELECT * FROM brands ORDER BY active DESC,name").fetchall()
    st.dataframe([{'브랜드':x['name'],'예약':'사용' if x['active'] else '중지'} for x in data],use_container_width=True,hide_index=True)
    name=st.text_input("새 브랜드명")
    if st.button("브랜드 추가"):
        try:
            with db() as con: con.execute("INSERT INTO brands(name) VALUES(?)",(name.strip(),))
            flash("브랜드를 추가했습니다.")
        except Exception: st.error("브랜드명을 확인하세요.")
    if data:
        mp={x['name']:x for x in data}; br=mp[st.selectbox("기존 브랜드",list(mp))]
        active=st.toggle("예약 사용",value=bool(br['active']))
        if st.button("브랜드 상태 저장"):
            with db() as con:con.execute("UPDATE brands SET active=? WHERE id=?",(int(active),br['id']))
            flash("브랜드 상태를 저장했습니다.")


def reservation_settings_admin():
    st.subheader("🕒 예약 운영설정")
    with db() as con:
        cfg = con.execute("SELECT * FROM reservation_settings WHERE id=1").fetchone()
        slots = con.execute("SELECT * FROM reservation_slots ORDER BY slot_time").fetchall()

    enabled = st.toggle("외부 예약 접수", value=bool(cfg["enabled"]))
    notice = st.text_area("외부 공지", cfg["notice"] or "")
    weekday_names = ["월", "화", "수", "목", "금", "토", "일"]
    current_days = [int(x) for x in str(cfg["weekdays"] or "").split(",") if x != ""]
    selected_days = st.multiselect(
        "예약 가능 요일",
        weekday_names,
        default=[weekday_names[i] for i in current_days],
    )
    st.markdown("##### 모바일 예약 신청시간")
    apply_left, apply_right, pickup_day_col = st.columns(3)
    application_start = apply_left.time_input(
        "예약 신청 시작",
        value=datetime.strptime(cfg["application_start_time"] or "10:00", "%H:%M").time(),
        key="application_start_time",
    )
    application_end = apply_right.time_input(
        "예약 신청 마감",
        value=datetime.strptime(cfg["application_end_time"] or "11:30", "%H:%M").time(),
        key="application_end_time",
    )
    pickup_day_offset = pickup_day_col.number_input(
        "수령일 (신청일 기준 며칠 후)",
        min_value=0,
        max_value=30,
        value=int(cfg["pickup_day_offset"] or 1),
        step=1,
    )
    st.caption("예: 1일 후 = 익일 수령. 아래 예약 시간대에서 실제 수령시간을 자유롭게 추가·수정·삭제할 수 있습니다.")

    if st.button("운영설정 저장", type="primary", use_container_width=True):
        if application_start >= application_end:
            st.error("예약 신청 마감시간은 시작시간보다 늦어야 합니다.")
        else:
            weekdays = ",".join(str(weekday_names.index(x)) for x in selected_days)
            with db() as con:
                con.execute(
                    """UPDATE reservation_settings
                       SET enabled=?, notice=?, weekdays=?, application_start_time=?,
                           application_end_time=?, pickup_day_offset=?
                       WHERE id=1""",
                    (
                        int(enabled), notice.strip(), weekdays,
                        application_start.strftime("%H:%M"),
                        application_end.strftime("%H:%M"),
                        pickup_day_offset,
                    ),
                )
            flash("예약 운영설정을 저장했습니다.")

    st.divider()
    st.markdown("#### 예약 시간대 관리")
    st.dataframe(
        [
            {
                "시간": row["slot_time"],
                "시간당 최대 예약": row["capacity"],
                "사용여부": "사용" if row["active"] else "중지",
            }
            for row in slots
        ],
        use_container_width=True,
        hide_index=True,
    )

    st.markdown("##### 새 시간대 추가")
    add_left, add_right = st.columns(2)
    new_time = add_left.time_input("새 시간", value=time(16, 0), key="new_reservation_time")
    new_capacity = add_right.number_input(
        "새 시간대 최대 예약", 1, 100, 3, key="new_reservation_capacity"
    )
    if st.button("시간대 추가", use_container_width=True, key="add_reservation_slot"):
        try:
            with db() as con:
                con.execute(
                    "INSERT INTO reservation_slots(slot_time, capacity, active) VALUES(?, ?, 1)",
                    (new_time.strftime("%H:%M"), new_capacity),
                )
            flash(f"{new_time.strftime('%H:%M')} 시간대를 추가했습니다.")
        except sqlite3.IntegrityError:
            st.error("이미 등록된 시간입니다.")

    if slots:
        st.markdown("##### 기존 시간대 수정·삭제")
        slot_list = list(slots)
        slot_event = st.dataframe(
            [{
                "시간": row["slot_time"],
                "최대예약": f"{row['capacity']}건",
                "사용여부": "사용" if row["active"] else "중지",
            } for row in slot_list],
            use_container_width=True,
            hide_index=True,
            on_select="rerun",
            selection_mode="single-row",
            key="manage_reservation_slot_table",
        )
        slot_indices = list(slot_event.selection.rows)
        if not slot_indices:
            st.info("수정하거나 삭제할 시간대 행을 선택하세요.")
            return
        selected = slot_list[slot_indices[0]]

        edit_left, edit_right = st.columns(2)
        capacity = edit_left.number_input(
            "시간당 최대 예약건수",
            1,
            100,
            int(selected["capacity"] or 1),
            key=f"slot_capacity_{selected['id']}",
        )
        active = edit_right.toggle(
            "시간대 사용",
            value=bool(selected["active"]),
            key=f"slot_active_{selected['id']}",
        )

        save_col, delete_col = st.columns(2)
        if save_col.button(
            "선택 시간대 수정 저장",
            type="primary",
            use_container_width=True,
            key=f"slot_save_{selected['id']}",
        ):
            with db() as con:
                con.execute(
                    "UPDATE reservation_slots SET capacity=?, active=? WHERE id=?",
                    (capacity, int(active), selected["id"]),
                )
            flash(f"{selected['slot_time']} 시간대를 수정했습니다.")

        with delete_col:
            delete_confirmed = st.checkbox(
                "삭제 확인", key=f"slot_delete_confirm_{selected['id']}"
            )
            if st.button(
                "선택 시간대 삭제",
                disabled=not delete_confirmed,
                use_container_width=True,
                key=f"slot_delete_{selected['id']}",
            ):
                slot_time = selected["slot_time"]
                with db() as con:
                    con.execute("DELETE FROM reservation_slots WHERE id=?", (selected["id"],))
                    con.commit()
                    remains = con.execute(
                        "SELECT COUNT(*) FROM reservation_slots WHERE id=?",
                        (selected["id"],),
                    ).fetchone()[0]
                if remains:
                    st.error("시간대 삭제에 실패했습니다.")
                else:
                    st.session_state.pop(f"slot_delete_confirm_{selected['id']}", None)
                    flash(f"{slot_time} 시간대를 삭제했습니다.")


def reservation_admin():
    st.subheader("📅 예약관리")
    with db() as con:data=con.execute("SELECT * FROM reservations ORDER BY booking_date,booking_time,id").fetchall()
    st.dataframe([dict(x) for x in data],use_container_width=True,hide_index=True)
    active=[x for x in data if x['status']=='예약']
    if not active:return
    mp={f"{x['reservation_no']} | {x['brand']} | {x['booking_date']} {x['booking_time']} | {x['item_name']}":x for x in active}; r=mp[st.selectbox("예약 선택",list(mp))]
    st.info("수령완료는 사용자 화면의 '예약 수령'에서 실제 수령자 카드를 태그해 처리합니다.")
    if st.button("❌ 선택 예약 취소"):
        with db() as con:con.execute("UPDATE reservations SET status='예약취소',cancel_at=? WHERE id=?",(datetime.now().isoformat(timespec='seconds'),r['id']))
        flash("예약을 취소했습니다.")

def inventory_item_management():
    st.subheader("📦 품목 통합관리")
    st.caption("재고정보와 예약설정을 한 화면에서 확인하고, 표의 행을 눌러 바로 수정·삭제합니다.")

    all_rows = item_rows(False)
    search_col, inactive_col = st.columns([3, 1])
    keyword = search_col.text_input(
        "🔎 품목 검색",
        placeholder="품목명, 카테고리, 단위 입력",
        key="item_search",
    ).strip().lower()
    show_inactive = inactive_col.toggle(
        "사용 중지 포함", value=False, key="show_inactive_items"
    )

    rows = [
        row for row in all_rows
        if (show_inactive or bool(row["active"]))
        and (
            not keyword
            or keyword in str(row["name"] or "").lower()
            or keyword in str(row["category"] or "기타").lower()
            or keyword in str(row["unit"] or "").lower()
            or keyword in str(row["pack_unit"] or "").lower()
        )
    ]
    active_count = sum(1 for row in all_rows if row["active"])
    reserved_count = sum(1 for row in all_rows if row["reservable"])
    st.caption(
        f"표시 {len(rows)}건 · 사용 품목 {active_count}건 · "
        f"예약 대상 {reserved_count}건 · 전체 {len(all_rows)}건"
    )

    if not rows:
        st.info("조건에 맞는 품목이 없습니다.")
        return

    summary = [
        {
            "번호": int(row["id"]),
            "카테고리": row["category"] or "기타",
            "품목명": row["name"],
            "현재고": qty_text(int(row["stock"] or 0), row),
            "낱개환산": int(row["stock"] or 0),
            "적정재고": qty_text(int(row["target_stock"] or 0), row),
            "예약대상": "사용" if row["reservable"] else "미사용",
            "예약가능": qty_text(
                max(
                    0,
                    int(row["stock"] or 0)
                    - int(row["reservation_min_stock"] or 0),
                ),
                row,
            ) if row["reservable"] else "-",
            "예약상한": (
                qty_text(int(row["reservation_max_qty"] or 0), row)
                if int(row["reservation_max_qty"] or 0) > 0
                else "예약가능수량"
            ),
            "예약단위": row["reservation_unit"] or "박스+낱개",
            "기준재고": qty_text(int(row["reservation_min_stock"] or 0), row),
            "사용여부": "사용" if row["active"] else "중지",
        }
        for row in rows
    ]

    st.markdown("#### 품목 현황 및 선택")
    st.caption("수정할 품목의 행을 한 번 누르세요. 드롭다운 선택은 사용하지 않습니다.")
    selection_event = st.dataframe(
        summary,
        use_container_width=True,
        hide_index=True,
        on_select="rerun",
        selection_mode="single-row",
        key="integrated_item_table",
        column_config={
            "번호": st.column_config.NumberColumn(width="small"),
            "품목명": st.column_config.TextColumn(width="large"),
            "현재고": st.column_config.TextColumn(width="medium"),
            "예약가능": st.column_config.TextColumn(width="medium"),
        },
    )

    selected_indices = list(selection_event.selection.rows)
    if not selected_indices:
        st.info("위 표에서 수정하거나 삭제할 품목 행을 선택하세요.")
    else:
        selected = rows[selected_indices[0]]
        item_id = int(selected["id"])
        st.markdown(f"#### 선택 품목 수정 · {selected['name']}")

        row1a, row1b, row1c = st.columns(3)
        new_name = row1a.text_input(
            "품목명", value=selected["name"], key=f"item_name_{item_id}"
        )
        existing_categories = sorted({
            str(row["category"] or "기타").strip() or "기타" for row in all_rows
        })
        category = row1b.text_input(
            "카테고리",
            value=selected["category"] or "기타",
            key=f"item_category_{item_id}",
            help="기존 카테고리 또는 새 카테고리를 직접 입력할 수 있습니다.",
        )
        active = row1c.toggle(
            "품목 사용", value=bool(selected["active"]), key=f"item_active_{item_id}"
        )

        row2a, row2b, row2c = st.columns(3)
        stock = row2a.number_input(
            "현재고(낱개환산)", min_value=0,
            value=int(selected["stock"] or 0), step=1, key=f"item_stock_{item_id}"
        )
        target = row2b.number_input(
            "적정재고(낱개환산)", min_value=0,
            value=int(selected["target_stock"] or 0), step=1, key=f"item_target_{item_id}"
        )
        max_qty = row2c.number_input(
            "현장 1회 최대수량", min_value=0,
            value=int(selected["max_qty"] or 0), step=1, key=f"item_max_{item_id}"
        )

        row3a, row3b, row3c = st.columns(3)
        unit = row3a.text_input(
            "낱개 단위", value=selected["unit"] or "개", key=f"item_unit_{item_id}"
        )
        pack_unit = row3b.text_input(
            "포장 단위", value=selected["pack_unit"] or "박스", key=f"item_pack_{item_id}"
        )
        pack_qty = row3c.number_input(
            "포장당 입수량", min_value=1,
            value=max(1, int(selected["pack_qty"] or 1)), step=1,
            key=f"item_packqty_{item_id}",
        )

        st.markdown("##### 예약 설정")
        row4a, row4b, row4c, row4d = st.columns(4)
        reservable = row4a.toggle(
            "예약 대상", value=bool(selected["reservable"]),
            key=f"item_reservable_{item_id}",
        )
        reservation_max = row4b.number_input(
            "1회 예약상한",
            min_value=0,
            value=int(selected["reservation_max_qty"] or 0),
            step=1,
            key=f"item_reservation_max_{item_id}",
            help="0이면 현재 예약가능수량까지 허용합니다.",
        )
        reservation_min_stock = row4c.number_input(
            "예약중지 기준재고",
            min_value=0,
            value=int(selected["reservation_min_stock"] or 0),
            step=1,
            key=f"item_reservation_min_{item_id}",
        )
        units = ["박스+낱개", "박스만", "낱개만"]
        current_unit = selected["reservation_unit"] if selected["reservation_unit"] in units else "박스+낱개"
        reservation_unit = row4d.radio(
            "예약단위",
            units,
            index=units.index(current_unit),
            horizontal=True,
            key=f"item_reservation_unit_{item_id}",
        )

        preview_qty = qty_text(int(stock), {
            "pack_qty": pack_qty, "unit": unit, "pack_unit": pack_unit
        })
        st.caption(f"현재고 표시 미리보기: {preview_qty} · 낱개환산 {int(stock):,}{unit}")

        save_col, delete_col = st.columns([2, 1])
        if save_col.button(
            "선택 품목 전체 설정 저장", type="primary", use_container_width=True,
            key=f"save_integrated_item_{item_id}",
        ):
            if not new_name.strip():
                st.error("품목명을 입력하세요.")
            elif not category.strip():
                st.error("카테고리를 입력하세요.")
            else:
                try:
                    with db() as con:
                        con.execute(
                            """UPDATE items SET
                               name=?,category=?,stock=?,target_stock=?,unit=?,pack_unit=?,
                               pack_qty=?,max_qty=?,active=?,reservable=?,reservation_max_qty=?,
                               reservation_min_stock=?,reservation_unit=?
                               WHERE id=?""",
                            (
                                new_name.strip(), category.strip(), stock, target,
                                unit.strip() or "개", pack_unit.strip() or "박스",
                                pack_qty, max_qty, int(active), int(reservable),
                                reservation_max, reservation_min_stock,
                                reservation_unit, item_id,
                            ),
                        )
                        con.execute(
                            "UPDATE transactions SET item_name=? WHERE item_id=?",
                            (new_name.strip(), item_id),
                        )
                        con.execute(
                            "UPDATE reservations SET item_name=? WHERE item_id=?",
                            (new_name.strip(), item_id),
                        )
                    flash("재고정보와 예약설정을 한 번에 저장했습니다.")
                except sqlite3.IntegrityError:
                    st.error("같은 이름의 품목이 이미 있습니다.")

        with delete_col:
            delete_confirmed = st.checkbox(
                "삭제 확인", key=f"integrated_item_delete_confirm_{item_id}"
            )
            if st.button(
                "선택 품목 삭제",
                disabled=not delete_confirmed,
                use_container_width=True,
                key=f"integrated_item_delete_{item_id}",
            ):
                try:
                    with db() as con:
                        con.execute("BEGIN IMMEDIATE")
                        con.execute("UPDATE transactions SET item_id=NULL WHERE item_id=?", (item_id,))
                        con.execute(
                            """UPDATE reservations SET status='예약취소',cancel_at=?
                               WHERE item_id=? AND status='예약'""",
                            (datetime.now().isoformat(timespec="seconds"), item_id),
                        )
                        con.execute("UPDATE reservations SET item_id=NULL WHERE item_id=?", (item_id,))
                        con.execute("DELETE FROM items WHERE id=?", (item_id,))
                    flash(f"{selected['name']} 품목을 삭제했습니다.")
                except Exception as exc:
                    st.error(f"품목 삭제 중 오류가 발생했습니다: {exc}")

    with st.expander("여러 품목 카테고리·예약대상·사용여부 일괄 변경"):
        st.caption("대량 변경이 필요할 때만 사용하세요. 여러 행을 수정한 뒤 한 번에 저장합니다.")
        category_options = sorted({
            str(row["category"] or "기타").strip() or "기타" for row in all_rows
        })
        for default_category in ["쇼핑백", "포장용품", "사무용품", "기타"]:
            if default_category not in category_options:
                category_options.append(default_category)
        bulk_source = [
            {
                "번호": int(row["id"]),
                "품목명": row["name"],
                "카테고리": row["category"] or "기타",
                "예약대상": bool(row["reservable"]),
                "사용중": bool(row["active"]),
            }
            for row in rows
        ]
        bulk_edited = st.data_editor(
            bulk_source,
            use_container_width=True,
            hide_index=True,
            disabled=["번호", "품목명"],
            column_config={
                "카테고리": st.column_config.SelectboxColumn(
                    options=category_options, required=True
                ),
                "예약대상": st.column_config.CheckboxColumn(),
                "사용중": st.column_config.CheckboxColumn(),
            },
            key="bulk_item_settings_editor",
        )
        if st.button(
            "일괄 설정 저장", use_container_width=True, key="save_bulk_item_settings"
        ):
            original_by_id = {int(row["id"]): row for row in rows}
            changed = 0
            with db() as con:
                for edited in bulk_edited:
                    item_id = int(edited["번호"])
                    original = original_by_id.get(item_id)
                    if not original:
                        continue
                    category_value = str(edited["카테고리"] or "기타").strip() or "기타"
                    reservable_value = int(bool(edited["예약대상"]))
                    active_value = int(bool(edited["사용중"]))
                    if (
                        category_value != str(original["category"] or "기타")
                        or reservable_value != int(bool(original["reservable"]))
                        or active_value != int(bool(original["active"]))
                    ):
                        con.execute(
                            "UPDATE items SET category=?,reservable=?,active=? WHERE id=?",
                            (category_value, reservable_value, active_value, item_id),
                        )
                        changed += 1
            flash(f"품목 일괄 설정 {changed}건을 저장했습니다.")


def inventory_user_management():
    st.subheader("👥 사용자 관리")
    st.caption("사용자 행을 선택하면 카드번호, 사번, 성명, 소속, 권한, 사용여부를 수정하거나 삭제할 수 있습니다.")
    with db() as con:
        all_user_rows = con.execute(
            "SELECT * FROM users ORDER BY active DESC,name,emp_id"
        ).fetchall()

    keyword = st.text_input(
        "🔎 사용자 검색",
        placeholder="이름, 사번, 카드번호, 브랜드/소속 입력",
        key="user_search",
    ).strip().lower()
    users = [
        user for user in all_user_rows
        if not keyword
        or keyword in str(user["card_id"] or "").lower()
        or keyword in str(user["emp_id"] or "").lower()
        or keyword in str(user["name"] or "").lower()
        or keyword in str(user["dept"] or "").lower()
    ]
    st.caption(f"검색 결과 {len(users)}건 · 전체 {len(all_user_rows)}건")

    if not users:
        st.info("조건에 맞는 사용자가 없습니다.")
        return

    user_event = st.dataframe(
        [{
            "카드번호": user["card_id"],
            "사번": user["emp_id"],
            "성명": user["name"],
            "브랜드/소속": user["dept"],
            "권한": user["role"],
            "사용여부": "사용" if user["active"] else "중지",
        } for user in users],
        use_container_width=True,
        hide_index=True,
        on_select="rerun",
        selection_mode="single-row",
        key="user_management_table",
    )
    selected_indices = list(user_event.selection.rows)
    if not selected_indices:
        st.info("수정하거나 삭제할 사용자 행을 선택하세요.")
        return

    selected = users[selected_indices[0]]
    old_card_id = str(selected["card_id"])
    st.markdown(f"#### 선택 사용자 수정 · {selected['name']}")
    a, b, c = st.columns(3)
    card_id = a.text_input(
        "카드번호", value=old_card_id, key=f"user_card_{old_card_id}"
    ).strip()
    emp_id = b.text_input(
        "사번", value=selected["emp_id"] or "", key=f"user_emp_{old_card_id}"
    ).strip()
    name = c.text_input(
        "성명", value=selected["name"] or "", key=f"user_name_{old_card_id}"
    ).strip()

    d, e, f = st.columns(3)
    dept = d.text_input(
        "브랜드/소속", value=selected["dept"] or "", key=f"user_dept_{old_card_id}"
    ).strip()
    roles = ["사용자", "관리자"]
    current_role = selected["role"] if selected["role"] in roles else "사용자"
    role = e.radio(
        "권한", roles, index=roles.index(current_role), horizontal=True,
        key=f"user_role_{old_card_id}",
    )
    active = f.toggle(
        "사용", value=bool(selected["active"]), key=f"user_active_{old_card_id}"
    )

    save_col, delete_col = st.columns([2, 1])
    if save_col.button(
        "선택 사용자 수정 저장", type="primary", use_container_width=True,
        key=f"save_user_{old_card_id}",
    ):
        if not card_id:
            st.error("카드번호를 입력하세요.")
        elif not name:
            st.error("성명을 입력하세요.")
        else:
            try:
                with db() as con:
                    con.execute("BEGIN IMMEDIATE")
                    if card_id != old_card_id:
                        duplicate = con.execute(
                            "SELECT 1 FROM users WHERE card_id=?", (card_id,)
                        ).fetchone()
                        if duplicate:
                            raise ValueError("이미 등록된 카드번호입니다.")
                    con.execute(
                        """UPDATE users SET card_id=?,emp_id=?,name=?,dept=?,role=?,active=?
                           WHERE card_id=?""",
                        (card_id, emp_id, name, dept, role, int(active), old_card_id),
                    )
                    con.execute(
                        """UPDATE transactions SET card_id=?,emp_id=?,name=?,dept=?
                           WHERE card_id=?""",
                        (card_id, emp_id, name, dept, old_card_id),
                    )
                    con.execute(
                        """UPDATE reservations SET receiver_card_id=?,receiver_emp_id=?,receiver_name=?
                           WHERE receiver_card_id=?""",
                        (card_id, emp_id, name, old_card_id),
                    )
                flash("사용자 정보를 수정했습니다.")
            except Exception as exc:
                st.error(str(exc))

    with delete_col:
        delete_confirmed = st.checkbox(
            "삭제 확인", key=f"delete_user_confirm_{old_card_id}"
        )
        if st.button(
            "선택 사용자 삭제", disabled=not delete_confirmed,
            use_container_width=True, key=f"delete_user_{old_card_id}",
        ):
            with db() as con:
                con.execute("DELETE FROM users WHERE card_id=?", (old_card_id,))
            flash(f"{selected['name']} 사용자를 삭제했습니다. 과거 거래·수령 기록은 보존됩니다.")


def transaction_management():
    st.subheader("↩ 입고·수령 기록 및 원복")
    with db() as c:
        all_tx_rows=c.execute("SELECT id,created_at,type,name,dept,item_name,qty,display_qty,status,source FROM transactions ORDER BY id DESC LIMIT 2000").fetchall()
    a,b,c1=st.columns([2,1,1])
    keyword=a.text_input("🔎 기록 검색",placeholder="품목, 수령자, 브랜드, 기록번호 입력",key="tx_search").strip().lower()
    type_filter=b.radio("구분",["전체","입고","출고"],horizontal=True,key="tx_type")
    status_filter=c1.radio("상태",["전체","정상","취소"],horizontal=True,key="tx_status")
    rows=[r for r in all_tx_rows if (not keyword or keyword in str(r["id"]).lower() or keyword in str(r["name"] or "").lower() or keyword in str(r["dept"] or "").lower() or keyword in str(r["item_name"] or "").lower()) and (type_filter=="전체" or r["type"]==type_filter) and (status_filter=="전체" or r["status"]==status_filter)]
    st.caption(f"검색 결과: {len(rows)}건 / 최근 기록 {len(all_tx_rows)}건")
    table=[{"기록번호":r["id"],"일시":r["created_at"],"구분":r["type"],"수령자/작업자":r["name"] or "",
            "브랜드/소속":r["dept"] or "","품목명":r["item_name"],"낱개환산수량":r["qty"],
            "표시수량":r["display_qty"] or "","처리상태":r["status"],"등록경로":r["source"]} for r in rows]
    st.dataframe(table,use_container_width=True,hide_index=True)
    txid=st.number_input("원복할 기록번호",min_value=1,step=1)
    if st.button("선택 기록 재고원복 및 취소"):
        try: cancel_transaction(int(txid)); flash("재고 원복 및 취소 처리 완료")
        except Exception as e: st.error(str(e))


def reservation_item_admin_korean():
    st.subheader("📦 품목별 예약 설정")
    all_data=item_rows(False)
    keyword=st.text_input("🔎 예약 품목 검색",placeholder="품목명 입력",key="reservation_item_search").strip().lower()
    data=[x for x in all_data if not keyword or keyword in str(x["name"] or "").lower()]
    st.caption(f"검색 결과: {len(data)}건 / 전체 {len(all_data)}건")
    table=[{"카테고리":x["category"] or "기타","품목명":x["name"],"현재고":x["stock"],
            "예약중지 기준재고":x["reservation_min_stock"],"예약대상":"사용" if x["reservable"] else "미사용",
            "1회 예약상한":x["reservation_max_qty"],"예약단위":x["reservation_unit"],
            "품목 사용여부":"사용" if x["active"] else "중지"} for x in data]
    st.dataframe(table,use_container_width=True,hide_index=True)
    if not data:return
    mp={x["name"]:x for x in data}; it=mp[st.selectbox("예약 설정할 품목",list(mp),key="reserve_item")]
    a,b,c,d=st.columns(4)
    enabled=a.toggle("예약 대상에 포함",value=bool(it["reservable"]))
    maxq=b.number_input("1회 예약상한 (0=현재고)",0,value=int(it["reservation_max_qty"] or 0),step=1)
    min_stock=c.number_input("예약중지 기준재고",0,value=int(it["reservation_min_stock"] or 0),step=1)
    units=["박스+낱개","박스만","낱개만"]
    current=it["reservation_unit"] if it["reservation_unit"] in units else "박스+낱개"
    unit=d.selectbox("예약 단위",units,index=units.index(current))
    if st.button("품목 예약 설정 저장",type="primary",use_container_width=True):
        with db() as con:
            con.execute("UPDATE items SET reservable=?,reservation_max_qty=?,reservation_min_stock=?,reservation_unit=? WHERE id=?",
                        (int(enabled),maxq,min_stock,unit,it["id"]))
        flash("품목 예약 설정을 저장했습니다.")


def reservation_admin_korean():
    st.subheader("📅 예약관리")
    with db() as con:
        all_rows = con.execute(
            """SELECT * FROM reservations
               ORDER BY booking_date DESC,booking_time DESC,reservation_no,id"""
        ).fetchall()

    # 품목 행이 아니라 신청번호 단위로 묶습니다.
    groups = {}
    for row in all_rows:
        root_no = reservation_root_no(row["reservation_no"])
        group = groups.setdefault(root_no, {
            "reservation_no": root_no,
            "brand": row["brand"],
            "booking_date": row["booking_date"],
            "booking_time": row["booking_time"],
            "created_at": row["created_at"],
            "receiver_name": row["receiver_name"] or "",
            "received_at": row["received_at"] or "",
            "rows": [],
        })
        group["rows"].append(row)
        if row["receiver_name"]:
            group["receiver_name"] = row["receiver_name"]
        if row["received_at"]:
            group["received_at"] = row["received_at"]

    def group_status(group):
        statuses = {row["status"] for row in group["rows"]}
        if statuses == {"수령완료"}:
            return "수령완료"
        if statuses == {"예약취소"}:
            return "예약취소"
        if "예약" in statuses:
            return "예약"
        return " / ".join(sorted(statuses))

    for group in groups.values():
        group["status"] = group_status(group)
        group["item_summary"] = " / ".join(
            f"{row['item_name']} {row['display_qty'] or str(row['qty'])+'개'}"
            for row in group["rows"]
        )
        group["item_count"] = len(group["rows"])

    search_col, status_col = st.columns([3, 1])
    keyword = search_col.text_input(
        "🔎 예약 검색",
        placeholder="신청번호, 브랜드, 품목명, 수령자 입력",
        key="reservation_search",
    ).strip().lower()
    status_filter = status_col.radio(
        "예약상태",
        ["전체", "예약", "수령완료", "예약취소"],
        horizontal=True,
        key="reservation_status_filter",
    )

    data = [
        group for group in groups.values()
        if (
            not keyword
            or keyword in group["reservation_no"].lower()
            or keyword in str(group["brand"] or "").lower()
            or keyword in group["item_summary"].lower()
            or keyword in group["receiver_name"].lower()
        )
        and (status_filter == "전체" or group["status"] == status_filter)
    ]
    data.sort(
        key=lambda x: (
            str(x["booking_date"] or ""),
            str(x["booking_time"] or ""),
            str(x["reservation_no"] or ""),
        ),
        reverse=True,
    )

    st.caption(f"신청번호 기준 {len(data)}건 / 전체 {len(groups)}건")
    table = [
        {
            "신청번호": group["reservation_no"],
            "브랜드": group["brand"],
            "수령일": group["booking_date"],
            "수령시간": group["booking_time"],
            "신청품목수": f"{group['item_count']}종",
            "신청품목 전체": group["item_summary"],
            "예약상태": group["status"],
            "신청일시": group["created_at"],
            "실제수령자": group["receiver_name"],
            "수령완료일시": group["received_at"],
        }
        for group in data
    ]
    reservation_event = st.dataframe(
        table,
        use_container_width=True,
        hide_index=True,
        on_select="rerun",
        selection_mode="single-row",
        key="reservation_admin_table",
    )
    reservation_indices = list(reservation_event.selection.rows)
    if not reservation_indices:
        st.info("관리할 신청번호의 행을 선택하세요.")
        return
    selected = data[reservation_indices[0]]
    if selected["status"] != "예약":
        st.info("선택한 신청은 현재 예약 상태가 아니므로 강제취소할 수 없습니다.")
        return

    st.markdown("##### 선택 신청의 전체 품목")
    st.dataframe(
        [
            {
                "품목명": row["item_name"],
                "신청수량": row["display_qty"] or f"{row['qty']:,}개",
                "상태": row["status"],
            }
            for row in selected["rows"]
        ],
        use_container_width=True,
        hide_index=True,
    )
    st.info("수령완료는 사용자 화면의 '예약 수령'에서 신청번호를 선택하고 실제 수령자 카드를 태그해 처리합니다.")

    cancel_confirm = st.checkbox(
        "선택 신청 전체 취소 확인",
        key=f"cancel_application_{selected['reservation_no']}",
    )
    if st.button(
        "선택 신청 전체 강제취소",
        disabled=not cancel_confirm,
        use_container_width=True,
    ):
        cloud_result = force_cancel_firebase(selected["reservation_no"])
        if not cloud_result.get("ok"):
            st.error(
                "Firebase 강제취소에 실패해 로컬 예약도 변경하지 않았습니다. "
                + str(cloud_result.get("error") or "알 수 없는 오류")
            )
        else:
            now = datetime.now().isoformat(timespec="seconds")
            row_ids = [row["id"] for row in selected["rows"] if row["status"] == "예약"]
            with db() as con:
                con.executemany(
                    "UPDATE reservations SET status='예약취소',cancel_at=? WHERE id=? AND status='예약'",
                    [(now, row_id) for row_id in row_ids],
                )
            st.session_state.pop(f"cancel_application_{selected['reservation_no']}", None)
            flash(
                f"{selected['reservation_no']} 신청 전체를 강제취소하고 "
                "예약 가능수량과 시간대 사용량을 원복했습니다."
            )


def inventory_receiving_page():
    st.subheader("📥 입고")
    rows = item_rows()
    if not rows:
        st.info("사용 가능한 품목이 없습니다.")
        return
    keyword = st.text_input(
        "🔎 입고 품목 검색", placeholder="품목명 또는 카테고리 입력", key="receiving_search"
    ).strip().lower()
    filtered = [
        x for x in rows
        if not keyword
        or keyword in str(x["name"] or "").lower()
        or keyword in str(x["category"] or "기타").lower()
    ]
    if not filtered:
        st.warning("검색 결과가 없습니다.")
        return

    st.caption("입고할 품목의 행을 선택하세요.")
    receive_item_event = st.dataframe(
        [{
            "번호": int(x["id"]),
            "카테고리": x["category"] or "기타",
            "품목명": x["name"],
            "현재고": qty_text(int(x["stock"] or 0), x),
            "낱개환산": int(x["stock"] or 0),
            "포장기준": f"1{x['pack_unit']} = {max(1,int(x['pack_qty'] or 1))}{x['unit']}",
        } for x in filtered],
        use_container_width=True,
        hide_index=True,
        on_select="rerun",
        selection_mode="single-row",
        key="receiving_item_table",
    )
    receive_item_indices = list(receive_item_event.selection.rows)
    if not receive_item_indices:
        st.info("위 표에서 입고할 품목 행을 선택하세요.")
        return
    item = filtered[receive_item_indices[0]]
    st.markdown(f"#### 선택 품목 · {item['name']}")
    a, b = st.columns(2)
    boxes = a.number_input(
        f"{item['pack_unit']} 수량", min_value=0, step=1,
        key=f"inbox_{item['id']}"
    )
    singles = b.number_input(
        f"{item['unit']} 수량", min_value=0, step=1,
        key=f"inone_{item['id']}"
    )
    qty = int(boxes) * max(1, int(item["pack_qty"] or 1)) + int(singles)
    display = qty_text(qty, item) if qty else f"0{item['unit']}"
    st.info(f"입고 합계: {display} · 낱개환산 {qty:,}{item['unit']}")
    if st.button("입고확정", type="primary", use_container_width=True):
        if qty <= 0:
            st.error("수량을 입력해주세요.")
        else:
            add_stock(item["id"], qty)
            st.session_state.admin_inventory_menu = "입고"
            flash(f"{item['name']} {display} 입고를 반영했습니다.")


def monthly_page():
    a,b=st.columns(2)
    year=a.number_input("조회 연도",2020,2100,datetime.now().year,step=1)
    month=b.number_input("조회 월",1,12,datetime.now().month,step=1)
    stats=monthly_statistics(int(year),int(month))
    st.subheader(f"브랜드별 {int(year)}년 {int(month)}월 종합 통계")
    if stats:
        st.dataframe(stats,use_container_width=True,hide_index=True)
    else:
        st.info("지정한 월의 정상 출고 내역이 없습니다.")


def admin_page():
    st.title("🔧 관리자")
    if not st.session_state.admin:
        pw = st.text_input("관리자 비밀번호", type="password")
        if st.button("로그인"):
            if pw == ADMIN_PW:
                st.session_state.admin = True
                st.rerun()
            else:
                st.error("인증 실패")
        return

    show_flash()
    top1, top2 = st.columns([1, 4])
    if top1.button("관리자 로그아웃"):
        st.session_state.admin = False
        st.rerun()

    sections = ["📦 재고관리", "📅 예약관리", "👥 사용자 관리", "🗂 데이터관리"]
    current_section = st.session_state.get("admin_section")
    if current_section not in sections:
        st.session_state.admin_section = "📦 재고관리"
    section = st.radio("관리 영역", sections, horizontal=True, key="admin_section")

    if section == "📦 재고관리":
        st.caption("입고와 품목의 재고·예약 가능 설정을 관리합니다.")
        if st.session_state.get("admin_inventory_menu") not in ["입고", "품목 통합관리", "복붙등록"]:
            st.session_state.admin_inventory_menu = "입고"
        inventory_options = ["입고", "품목 통합관리", "복붙등록"]
        inventory_menu = st.radio(
            "재고관리 메뉴", inventory_options, horizontal=True,
            key="admin_inventory_menu",
        )
        st.divider()
        if inventory_menu == "입고":
            inventory_receiving_page()
        elif inventory_menu == "품목 통합관리":
            inventory_item_management()
        else:
            bulk_import_tab()

    elif section == "📅 예약관리":
        st.caption("예약 운영시간, 수령시간대, 예약내역과 강제취소를 관리합니다.")
        if st.session_state.get("admin_reservation_menu") not in ["예약 운영설정", "예약내역 관리"]:
            st.session_state.admin_reservation_menu = "예약 운영설정"
        reservation_menu = st.radio(
            "예약관리 메뉴", ["예약 운영설정", "예약내역 관리"],
            horizontal=True, key="admin_reservation_menu",
        )
        st.divider()
        if reservation_menu == "예약 운영설정":
            reservation_settings_admin()
        else:
            reservation_admin_korean()

    elif section == "👥 사용자 관리":
        inventory_user_management()

    else:
        st.caption("입고·수령 기록 원복과 월간 통계를 확인합니다.")
        if st.session_state.get("admin_data_menu") not in ["기록·원복", "월간통계"]:
            st.session_state.admin_data_menu = "기록·원복"
        data_menu = st.radio(
            "데이터관리 메뉴", ["기록·원복", "월간통계"],
            horizontal=True, key="admin_data_menu",
        )
        st.divider()
        if data_menu == "기록·원복":
            transaction_management()
        else:
            monthly_page()

st.set_page_config(page_title="소모품 관리 시스템",page_icon="📦",layout="wide")
st.markdown("""<style>.mode-card{border:2px solid #dfe4ec;border-radius:16px;padding:20px;min-height:135px;background:#fff}.mode-title{font-size:25px;font-weight:800;color:#1f2937}.mode-desc{margin-top:10px;color:#64748b;line-height:1.6}.operation-guide{margin:10px 0 24px;padding:22px;border:1px solid #dfe4ec;border-radius:18px;background:#fff;box-shadow:0 8px 24px rgba(17,24,39,.05)}.operation-guide-title{font-size:20px;font-weight:850;color:#1f2937;margin-bottom:14px}.operation-guide-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px}.operation-guide-card{padding:15px;border:1px solid #e4e7ec;border-radius:13px;background:#fff}.operation-guide-label{font-size:12px;font-weight:800;color:#667085;margin-bottom:7px}.operation-guide-value{font-size:18px;font-weight:850;color:#172033;letter-spacing:-.03em}.operation-guide-note{font-size:12px;color:#667085;line-height:1.5;margin-top:7px}.guide-direct{border-color:#abefc6;background:#ecfdf3}.guide-pause{border-color:#fedf89;background:#fffaeb}.guide-reservation{border-color:#b2ddff;background:#eff8ff}.guide-pickup{border-color:#d9d6fe;background:#f4f3ff}@media(max-width:900px){.operation-guide-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.operation-guide{padding:16px}.operation-guide-grid{grid-template-columns:1fr}.operation-guide-value{font-size:17px}}</style>""",unsafe_allow_html=True)
init_db()
refresh_inventory_states()
st.session_state.setdefault("cart",{})
st.session_state.setdefault("pending",None)
st.session_state.setdefault("receipt",None)
st.session_state.setdefault("admin",False)
st.session_state.setdefault("receive_mode","일반")
st.session_state.setdefault("admin_section","📦 재고관리")
st.session_state.setdefault("admin_inventory_menu","입고")
st.session_state.setdefault("admin_reservation_menu","예약 운영설정")
st.session_state.setdefault("admin_data_menu","기록·원복")
page=st.sidebar.radio("메뉴",["사용자 수령","관리자"])
user_page() if page=="사용자 수령" else admin_page()
