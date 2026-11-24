#!/usr/bin/env python3
"""Pattern Seeker 로컬 서버 (Python 표준 라이브러리만 사용, 오프라인 동작).

실행: python app/server.py  (Windows 에서는 run.bat)
브라우저: http://127.0.0.1:8765
"""
import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import sys
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db  # noqa: E402

STATIC_DIR = os.path.join(db.APP_DIR, "static")
HOST = os.environ.get("PATTERN_SEEKER_HOST", "127.0.0.1")
PORT = int(os.environ.get("PATTERN_SEEKER_PORT", "8765"))
MAX_BODY = 200 * 1024 * 1024
MAX_READ = 60 * 1024 * 1024

LOCK = threading.RLock()  # 로컬 단일 사용자 앱: 요청을 직렬화해 동시 쓰기/복구 충돌을 막는다
ROUTES = []

PALETTE = ["#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#ff7f0e", "#17becf",
           "#8c564b", "#e377c2", "#bcbd22", "#7f7f7f", "#393b79", "#ad494a",
           "#637939", "#843c39", "#3182bd", "#e6550d"]


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status
        self.msg = msg


def route(method, pattern):
    rx = re.compile("^" + re.sub(r":(\w+)", r"(?P<\1>[^/]+)", pattern) + "$")

    def deco(fn):
        ROUTES.append((method, rx, fn))
        return fn
    return deco


# ---------------------------------------------------------------- helpers
JSON_COLS = {"params_json", "config_json", "conditions_json", "values_json", "computed_json",
             "source_json", "columns_json", "data_json", "meta_json", "evidence_json", "value_json"}


def rowd(row):
    if row is None:
        return None
    d = dict(row)
    for k in list(d.keys()):
        if k in JSON_COLS:
            try:
                d[k[:-5]] = json.loads(d.pop(k) or "null")
            except ValueError:
                d[k[:-5]] = None
    return d


def rows(cur):
    return [rowd(r) for r in cur.fetchall()]


def jdump(v):
    return json.dumps(v if v is not None else {}, ensure_ascii=False)


def audit(conn, entity, eid, action, before=None, after=None):
    conn.execute("INSERT INTO audit_log(ts,entity,entity_id,action,before_json,after_json) VALUES(?,?,?,?,?,?)",
                 (db.now(), entity, eid, action,
                  json.dumps(before, ensure_ascii=False, default=str) if before is not None else None,
                  json.dumps(after, ensure_ascii=False, default=str) if after is not None else None))


def need(body, *keys):
    for k in keys:
        if body.get(k) in (None, ""):
            raise ApiError(400, f"'{k}' 값이 필요합니다")


def get_sample(conn, sid, allow_deleted=False):
    r = conn.execute("SELECT * FROM samples WHERE id=?", (sid,)).fetchone()
    if not r or (r["deleted_at"] and not allow_deleted):
        raise ApiError(404, "샘플을 찾을 수 없습니다")
    return rowd(r)


def set_status(conn, sid, code, status, note=""):
    if status not in db.STATUSES:
        raise ApiError(400, f"알 수 없는 상태: {status}")
    conn.execute("INSERT INTO sample_analysis_status(sample_id,analysis_code,status,note,updated_at) VALUES(?,?,?,?,?)"
                 " ON CONFLICT(sample_id,analysis_code) DO UPDATE SET status=excluded.status, note=excluded.note,"
                 " updated_at=excluded.updated_at", (sid, code, status, note, db.now()))


DATE_PATTERNS = [
    (re.compile(r"(20\d{2})[-./년 ]\s?(\d{1,2})[-./월 ]\s?(\d{1,2})"), ("y", "m", "d")),
    (re.compile(r"(\d{1,2})/(\d{1,2})/(20\d{2})"), ("m", "d", "y")),
    (re.compile(r"(\d{1,2})\.(\d{1,2})\.(20\d{2})"), ("d", "m", "y")),
]


def date_candidates(text, limit=5):
    """파일 본문에 기재된 날짜 후보. 자동 입력용이며 사용자가 고른 날짜가 우선한다."""
    found = []
    for rx, order in DATE_PATTERNS:
        for m in rx.finditer(text[:200000]):
            parts = dict(zip(order, m.groups()))
            try:
                y, mo, d = int(parts["y"]), int(parts["m"]), int(parts["d"])
                if 1 <= mo <= 12 and 1 <= d <= 31:
                    iso = f"{y:04d}-{mo:02d}-{d:02d}"
                    ctx = text[max(0, m.start() - 30):m.end() + 10].replace("\n", " ")
                    if iso not in [f["date"] for f in found]:
                        found.append({"date": iso, "context": ctx.strip()})
            except (ValueError, KeyError):
                pass
            if len(found) >= limit:
                return found
    return found


def decode_text(raw):
    for enc in ("utf-8-sig", "cp949", "utf-16", "latin-1"):
        try:
            t = raw.decode(enc)
            if enc == "utf-16" and "\x00" in t:
                continue
            return t, enc
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", "replace"), "latin-1"


def capabilities():
    caps = {"pdf_text": True, "pdf_builtin": True, "pypdf": False, "ocr": False}
    try:
        import pypdf  # noqa: F401
        caps["pypdf"] = True
    except ImportError:
        pass
    try:
        import pytesseract  # noqa: F401
        caps["ocr"] = shutil.which("tesseract") is not None
    except ImportError:
        pass
    return caps


def pdf_text(raw):
    """내장 추출기(표준 라이브러리, 장비 '인쇄→PDF' 양식에 맞춤)를 먼저 쓰고, 실패하면 pypdf 를 쓴다."""
    import pdftext
    try:
        return pdftext.extract_text(raw)
    except pdftext.PdfTextError as builtin_err:
        err = builtin_err
    try:
        import io
        import pypdf
    except ImportError:
        raise ApiError(501, f"내장 PDF 추출기로 읽지 못했습니다 ({err}). pypdf 를 설치하거나(pip install pypdf) PDF 뷰어에서 텍스트를 복사해 붙여 넣으세요.")
    reader = pypdf.PdfReader(io.BytesIO(raw))
    pages = []
    for p in reader.pages:
        try:
            pages.append(p.extract_text() or "")
        except Exception:  # noqa: BLE001
            pages.append("")
    return "\n\n".join(pages)


def ocr_image(raw):
    caps = capabilities()
    if not caps["ocr"]:
        raise ApiError(501, "OCR(Tesseract)이 설치되어 있지 않습니다. 캡처의 숫자를 직접 입력하거나 PDF 텍스트를 붙여 넣으세요.")
    import io
    import pytesseract
    from PIL import Image
    return pytesseract.image_to_string(Image.open(io.BytesIO(raw)), lang="eng")


def read_path_bytes(path):
    path = os.path.expandvars(os.path.expanduser(path.strip().strip('"')))
    if not os.path.isfile(path):
        raise ApiError(404, f"파일을 찾을 수 없습니다: {path}")
    size = os.path.getsize(path)
    if size > MAX_READ:
        raise ApiError(413, "파일이 너무 큽니다 (60 MB 초과)")
    with open(path, "rb") as f:
        return path, f.read()


# ---------------------------------------------------------------- meta / settings
@route("GET", "/api/meta")
def api_meta(conn, p, q, b):
    types = rows(conn.execute("SELECT * FROM analysis_types ORDER BY sort_order, code"))
    settings = {r["key"]: json.loads(r["value_json"]) for r in conn.execute("SELECT * FROM settings")}
    return {"analysis_types": types, "statuses": db.STATUSES, "default_status": db.DEFAULT_STATUS,
            "settings": settings, "capabilities": capabilities(), "schema_version": db.schema_version(conn),
            "data_dir": db.DATA_DIR, "palette": PALETTE}


@route("PUT", "/api/settings/:key")
def api_setting(conn, p, q, b):
    old = conn.execute("SELECT value_json FROM settings WHERE key=?", (p["key"],)).fetchone()
    conn.execute("INSERT INTO settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                 (p["key"], jdump(b.get("value"))))
    audit(conn, "settings", None, "update", json.loads(old[0]) if old else None, {p["key"]: b.get("value")})
    return {"ok": True}


@route("POST", "/api/analysis_types")
def api_type_create(conn, p, q, b):
    need(b, "code", "name")
    code = re.sub(r"[^A-Za-z0-9_]", "", b["code"]).upper()
    if not code:
        raise ApiError(400, "코드는 영문/숫자로 입력하세요")
    if conn.execute("SELECT 1 FROM analysis_types WHERE code=?", (code,)).fetchone():
        raise ApiError(409, "이미 있는 코드입니다")
    cfg = b.get("config") or {"tool": "generic", "fields": [], "metrics": []}
    cfg.setdefault("tool", "generic")
    cfg.setdefault("metrics", cfg.get("fields", []))
    conn.execute("INSERT INTO analysis_types(code,name,group_name,description,sort_order,active,builtin,config_json)"
                 " VALUES(?,?,?,?,?,1,0,?)", (code, b["name"], b.get("group_name", "사용자 정의"),
                                              b.get("description", ""), int(b.get("sort_order", 200)), jdump(cfg)))
    audit(conn, "analysis_type", None, "create", None, b)
    return {"code": code}


@route("PUT", "/api/analysis_types/:code")
def api_type_update(conn, p, q, b):
    old = conn.execute("SELECT * FROM analysis_types WHERE code=?", (p["code"],)).fetchone()
    if not old:
        raise ApiError(404, "분석 종류 없음")
    old = rowd(old)
    cfg = b.get("config", old["config"])
    conn.execute("UPDATE analysis_types SET name=?, group_name=?, description=?, sort_order=?, active=?, config_json=? WHERE code=?",
                 (b.get("name", old["name"]), b.get("group_name", old["group_name"]), b.get("description", old["description"]),
                  int(b.get("sort_order", old["sort_order"])), int(b.get("active", old["active"])), jdump(cfg), p["code"]))
    audit(conn, "analysis_type", None, "update", old, b)
    return {"ok": True}


# ---------------------------------------------------------------- samples
def sample_summaries(conn, where="s.deleted_at IS NULL", args=()):
    samples = rows(conn.execute(f"SELECT s.* FROM samples s WHERE {where} ORDER BY s.created_at DESC, s.id DESC", args))
    ids = [s["id"] for s in samples]
    if not ids:
        return []
    ph = ",".join("?" * len(ids))
    st, cnt, ser, par, chi = {}, {}, {}, {}, {}
    for r in conn.execute(f"SELECT * FROM sample_analysis_status WHERE sample_id IN ({ph})", ids):
        st.setdefault(r["sample_id"], {})[r["analysis_code"]] = {"status": r["status"], "note": r["note"]}
    for r in conn.execute(f"SELECT sample_id, analysis_code, COUNT(*) n FROM measurements WHERE deleted_at IS NULL AND sample_id IN ({ph}) GROUP BY 1,2", ids):
        cnt.setdefault(r["sample_id"], {})[r["analysis_code"]] = r["n"]
    for r in conn.execute(f"SELECT m.sample_id, s.id, s.name FROM series_members m JOIN series s ON s.id=m.series_id WHERE m.sample_id IN ({ph})", ids):
        ser.setdefault(r["sample_id"], []).append({"id": r["id"], "name": r["name"]})
    for r in conn.execute(f"SELECT l.child_id, l.relation, p.id, p.name FROM sample_links l JOIN samples p ON p.id=l.parent_id WHERE l.child_id IN ({ph})", ids):
        par.setdefault(r["child_id"], []).append({"id": r["id"], "name": r["name"], "relation": r["relation"]})
    for r in conn.execute(f"SELECT l.parent_id, c.id, c.name FROM sample_links l JOIN samples c ON c.id=l.child_id WHERE l.parent_id IN ({ph}) AND c.deleted_at IS NULL", ids):
        chi.setdefault(r["parent_id"], []).append({"id": r["id"], "name": r["name"]})
    for s in samples:
        s["statuses"] = st.get(s["id"], {})
        s["counts"] = cnt.get(s["id"], {})
        s["series"] = ser.get(s["id"], [])
        s["parents"] = par.get(s["id"], [])
        s["children"] = chi.get(s["id"], [])
    return samples


@route("GET", "/api/samples")
def api_samples(conn, p, q, b):
    return {"samples": sample_summaries(conn)}


@route("POST", "/api/samples")
def api_sample_create(conn, p, q, b):
    need(b, "name")
    name = b["name"].strip()
    if conn.execute("SELECT 1 FROM samples WHERE name=?", (name,)).fetchone():
        raise ApiError(409, f"같은 이름의 샘플이 이미 있습니다: {name} (휴지통 포함)")
    n = conn.execute("SELECT COUNT(*) FROM samples").fetchone()[0]
    color = b.get("color") or PALETTE[n % len(PALETTE)]
    t = db.now()
    cur = conn.execute("INSERT INTO samples(name,color,synthesized_on,description,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                       (name, color, b.get("synthesized_on") or None, b.get("description", ""), b.get("notes", ""), t, t))
    sid = cur.lastrowid
    for par in b.get("parents") or []:
        _link(conn, par.get("id"), sid, par.get("relation", "파생"), par.get("branch_point", ""), par.get("note", ""))
    for se in b.get("series_ids") or []:
        conn.execute("INSERT OR IGNORE INTO series_members(series_id,sample_id) VALUES(?,?)", (se, sid))
    if b.get("copy_steps_from"):
        _copy_steps(conn, int(b["copy_steps_from"]), sid)
    audit(conn, "sample", sid, "create", None, b)
    return {"id": sid}


def _copy_steps(conn, src, dst):
    for s in conn.execute("SELECT * FROM synthesis_steps WHERE sample_id=? ORDER BY seq", (src,)).fetchall():
        t = db.now()
        cur = conn.execute("INSERT INTO synthesis_steps(sample_id,seq,step_type,title,params_json,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                           (dst, s["seq"], s["step_type"], s["title"], s["params_json"], s["notes"], t, t))
        for r in conn.execute("SELECT * FROM reagents WHERE step_id=?", (s["id"],)).fetchall():
            conn.execute("INSERT INTO reagents(step_id,name,amount,unit,supplier,supplier_source,lot,notes) VALUES(?,?,?,?,?,?,?,?)",
                         (cur.lastrowid, r["name"], r["amount"], r["unit"], r["supplier"], r["supplier_source"], r["lot"], r["notes"]))


@route("GET", "/api/samples/:id")
def api_sample_get(conn, p, q, b):
    sid = int(p["id"])
    s = get_sample(conn, sid, allow_deleted=True)
    summ = sample_summaries(conn, "s.id=?", (sid,))
    if summ:
        s.update({k: summ[0][k] for k in ("statuses", "counts", "series", "parents", "children")})
    s["links_up"] = rows(conn.execute("SELECT l.*, p.name parent_name, p.color parent_color FROM sample_links l JOIN samples p ON p.id=l.parent_id WHERE l.child_id=?", (sid,)))
    s["links_down"] = rows(conn.execute("SELECT l.*, c.name child_name, c.color child_color FROM sample_links l JOIN samples c ON c.id=l.child_id WHERE l.parent_id=? AND c.deleted_at IS NULL", (sid,)))
    steps = rows(conn.execute("SELECT * FROM synthesis_steps WHERE sample_id=? ORDER BY seq, id", (sid,)))
    for st in steps:
        st["reagents"] = rows(conn.execute("SELECT * FROM reagents WHERE step_id=? ORDER BY id", (st["id"],)))
    s["steps"] = steps
    s["measurements"] = rows(conn.execute(
        "SELECT id, sample_id, analysis_code, ec_session_id, seq, title, measured_on, measured_on_source, conditions_json, values_json,"
        " computed_json, source_json, notes, created_at, updated_at FROM measurements WHERE sample_id=? AND deleted_at IS NULL"
        " ORDER BY analysis_code, COALESCE(seq, 1e9), measured_on DESC, id DESC", (sid,)))
    s["ec_sessions"] = rows(conn.execute("SELECT * FROM ec_sessions WHERE sample_id=? ORDER BY id", (sid,)))
    s["attachments"] = rows(conn.execute("SELECT * FROM attachments WHERE sample_id=? ORDER BY id DESC", (sid,)))
    s["interpretations"] = rows(conn.execute("SELECT * FROM interpretations WHERE sample_id=? AND deleted_at IS NULL ORDER BY id DESC", (sid,)))
    return s


@route("PUT", "/api/samples/:id")
def api_sample_update(conn, p, q, b):
    sid = int(p["id"])
    old = get_sample(conn, sid)
    name = (b.get("name") or old["name"]).strip()
    if name != old["name"] and conn.execute("SELECT 1 FROM samples WHERE name=? AND id<>?", (name, sid)).fetchone():
        raise ApiError(409, "같은 이름의 샘플이 이미 있습니다")
    conn.execute("UPDATE samples SET name=?, color=?, synthesized_on=?, description=?, notes=?, updated_at=? WHERE id=?",
                 (name, b.get("color", old["color"]), b.get("synthesized_on", old["synthesized_on"]) or None,
                  b.get("description", old["description"]), b.get("notes", old["notes"]), db.now(), sid))
    audit(conn, "sample", sid, "update", old, b)
    return {"ok": True}


@route("DELETE", "/api/samples/:id")
def api_sample_delete(conn, p, q, b):
    sid = int(p["id"])
    old = get_sample(conn, sid)
    conn.execute("UPDATE samples SET deleted_at=? WHERE id=?", (db.now(), sid))
    audit(conn, "sample", sid, "soft_delete", old, None)
    return {"ok": True, "trash": True}


@route("POST", "/api/samples/:id/restore")
def api_sample_restore(conn, p, q, b):
    sid = int(p["id"])
    conn.execute("UPDATE samples SET deleted_at=NULL WHERE id=?", (sid,))
    audit(conn, "sample", sid, "restore")
    return {"ok": True}


@route("PUT", "/api/samples/:id/status/:code")
def api_status(conn, p, q, b):
    sid = int(p["id"])
    get_sample(conn, sid)
    old = conn.execute("SELECT * FROM sample_analysis_status WHERE sample_id=? AND analysis_code=?", (sid, p["code"])).fetchone()
    set_status(conn, sid, p["code"], b.get("status"), b.get("note", ""))
    audit(conn, "status", sid, "update", dict(old) if old else None, {"code": p["code"], **b})
    return {"ok": True}


# ---------------------------------------------------------------- links / lineage
def _would_cycle(conn, parent, child):
    # child 의 후손 중에 parent 가 있으면 순환
    seen, stack = set(), [child]
    while stack:
        n = stack.pop()
        if n == parent:
            return True
        if n in seen:
            continue
        seen.add(n)
        stack += [r[0] for r in conn.execute("SELECT child_id FROM sample_links WHERE parent_id=?", (n,))]
    return False


def _link(conn, parent, child, relation, branch_point="", note=""):
    parent, child = int(parent), int(child)
    if parent == child:
        raise ApiError(400, "자기 자신과 연결할 수 없습니다")
    get_sample(conn, parent)
    get_sample(conn, child)
    if _would_cycle(conn, parent, child):
        raise ApiError(400, "순환 관계가 됩니다 (하위 샘플을 상위로 연결할 수 없음)")
    cur = conn.execute("INSERT OR IGNORE INTO sample_links(parent_id,child_id,relation,branch_point,note,created_at) VALUES(?,?,?,?,?,?)",
                       (parent, child, relation or "파생", branch_point or "", note or "", db.now()))
    return cur.lastrowid


@route("POST", "/api/links")
def api_link_create(conn, p, q, b):
    need(b, "parent_id", "child_id")
    lid = _link(conn, b["parent_id"], b["child_id"], b.get("relation"), b.get("branch_point"), b.get("note"))
    audit(conn, "link", lid, "create", None, b)
    return {"id": lid}


@route("PUT", "/api/links/:id")
def api_link_update(conn, p, q, b):
    old = conn.execute("SELECT * FROM sample_links WHERE id=?", (int(p["id"]),)).fetchone()
    if not old:
        raise ApiError(404, "관계 없음")
    conn.execute("UPDATE sample_links SET relation=?, branch_point=?, note=? WHERE id=?",
                 (b.get("relation", old["relation"]), b.get("branch_point", old["branch_point"]), b.get("note", old["note"]), int(p["id"])))
    audit(conn, "link", int(p["id"]), "update", dict(old), b)
    return {"ok": True}


@route("DELETE", "/api/links/:id")
def api_link_delete(conn, p, q, b):
    old = conn.execute("SELECT * FROM sample_links WHERE id=?", (int(p["id"]),)).fetchone()
    if not old:
        raise ApiError(404, "관계 없음")
    conn.execute("DELETE FROM sample_links WHERE id=?", (int(p["id"]),))
    audit(conn, "link", int(p["id"]), "delete", dict(old), None)
    return {"ok": True}


@route("GET", "/api/lineage/:id")
def api_lineage(conn, p, q, b):
    """선택 샘플이 속한 연결 요소(조상·후손·형제 분기 포함)를 반환한다."""
    start = int(p["id"])
    get_sample(conn, start, allow_deleted=True)
    nodes, edges, stack = set(), {}, [start]
    while stack and len(nodes) < 300:
        n = stack.pop()
        if n in nodes:
            continue
        nodes.add(n)
        for r in conn.execute("SELECT * FROM sample_links WHERE parent_id=? OR child_id=?", (n, n)):
            edges[r["id"]] = dict(r)
            for m in (r["parent_id"], r["child_id"]):
                if m not in nodes:
                    stack.append(m)
    ph = ",".join("?" * len(nodes))
    ns = rows(conn.execute(f"SELECT id,name,color,synthesized_on,deleted_at FROM samples WHERE id IN ({ph})", list(nodes)))
    return {"root": start, "nodes": ns, "edges": list(edges.values())}


# ---------------------------------------------------------------- series
@route("GET", "/api/series")
def api_series(conn, p, q, b):
    ss = rows(conn.execute("SELECT * FROM series ORDER BY name"))
    for s in ss:
        s["sample_ids"] = [r[0] for r in conn.execute(
            "SELECT m.sample_id FROM series_members m JOIN samples s ON s.id=m.sample_id WHERE m.series_id=? AND s.deleted_at IS NULL", (s["id"],))]
    return {"series": ss}


@route("POST", "/api/series")
def api_series_create(conn, p, q, b):
    need(b, "name")
    if conn.execute("SELECT 1 FROM series WHERE name=?", (b["name"].strip(),)).fetchone():
        raise ApiError(409, "같은 이름의 시리즈가 있습니다")
    cur = conn.execute("INSERT INTO series(name,description,created_at) VALUES(?,?,?)", (b["name"].strip(), b.get("description", ""), db.now()))
    audit(conn, "series", cur.lastrowid, "create", None, b)
    return {"id": cur.lastrowid}


@route("PUT", "/api/series/:id")
def api_series_update(conn, p, q, b):
    old = conn.execute("SELECT * FROM series WHERE id=?", (int(p["id"]),)).fetchone()
    if not old:
        raise ApiError(404, "시리즈 없음")
    conn.execute("UPDATE series SET name=?, description=? WHERE id=?", (b.get("name", old["name"]), b.get("description", old["description"]), int(p["id"])))
    audit(conn, "series", int(p["id"]), "update", dict(old), b)
    return {"ok": True}


@route("DELETE", "/api/series/:id")
def api_series_delete(conn, p, q, b):
    sid = int(p["id"])
    old = conn.execute("SELECT * FROM series WHERE id=?", (sid,)).fetchone()
    members = [r[0] for r in conn.execute("SELECT sample_id FROM series_members WHERE series_id=?", (sid,))]
    conn.execute("DELETE FROM series WHERE id=?", (sid,))
    audit(conn, "series", sid, "delete", {**dict(old), "members": members} if old else None, None)
    return {"ok": True}


@route("POST", "/api/series/:id/members")
def api_series_add(conn, p, q, b):
    need(b, "sample_id")
    conn.execute("INSERT OR IGNORE INTO series_members(series_id,sample_id) VALUES(?,?)", (int(p["id"]), int(b["sample_id"])))
    audit(conn, "series_member", int(p["id"]), "add", None, b)
    return {"ok": True}


@route("DELETE", "/api/series/:id/members/:sid")
def api_series_remove(conn, p, q, b):
    conn.execute("DELETE FROM series_members WHERE series_id=? AND sample_id=?", (int(p["id"]), int(p["sid"])))
    audit(conn, "series_member", int(p["id"]), "remove", {"sample_id": int(p["sid"])}, None)
    return {"ok": True}


# ---------------------------------------------------------------- synthesis steps
def _save_reagents(conn, step_id, reagents, default_supplier):
    conn.execute("DELETE FROM reagents WHERE step_id=?", (step_id,))
    for r in reagents or []:
        if not (r.get("name") or "").strip():
            continue
        supplier = (r.get("supplier") or "").strip()
        src = r.get("supplier_source") or ("user" if supplier and supplier != default_supplier else "default")
        if not supplier:
            supplier, src = default_supplier, "default"
        amt = r.get("amount")
        conn.execute("INSERT INTO reagents(step_id,name,amount,unit,supplier,supplier_source,lot,notes) VALUES(?,?,?,?,?,?,?,?)",
                     (step_id, r["name"].strip(), float(amt) if amt not in (None, "") else None, r.get("unit", ""),
                      supplier, src, r.get("lot", ""), r.get("notes", "")))


def _default_supplier(conn):
    r = conn.execute("SELECT value_json FROM settings WHERE key='reagent_default_supplier'").fetchone()
    return json.loads(r[0]) if r else "H사"


@route("POST", "/api/samples/:id/steps")
def api_step_create(conn, p, q, b):
    sid = int(p["id"])
    get_sample(conn, sid)
    need(b, "step_type")
    seq = b.get("seq")
    if seq in (None, ""):
        seq = (conn.execute("SELECT MAX(seq) FROM synthesis_steps WHERE sample_id=?", (sid,)).fetchone()[0] or 0) + 1
    t = db.now()
    cur = conn.execute("INSERT INTO synthesis_steps(sample_id,seq,step_type,title,params_json,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                       (sid, int(seq), b["step_type"], b.get("title", ""), jdump(b.get("params")), b.get("notes", ""), t, t))
    _save_reagents(conn, cur.lastrowid, b.get("reagents"), _default_supplier(conn))
    audit(conn, "step", cur.lastrowid, "create", None, b)
    return {"id": cur.lastrowid}


@route("PUT", "/api/steps/:id")
def api_step_update(conn, p, q, b):
    stid = int(p["id"])
    old = rowd(conn.execute("SELECT * FROM synthesis_steps WHERE id=?", (stid,)).fetchone())
    if not old:
        raise ApiError(404, "단계 없음")
    old["reagents"] = rows(conn.execute("SELECT * FROM reagents WHERE step_id=?", (stid,)))
    conn.execute("UPDATE synthesis_steps SET seq=?, step_type=?, title=?, params_json=?, notes=?, updated_at=? WHERE id=?",
                 (int(b.get("seq", old["seq"])), b.get("step_type", old["step_type"]), b.get("title", old["title"]),
                  jdump(b.get("params", old["params"])), b.get("notes", old["notes"]), db.now(), stid))
    if "reagents" in b:
        _save_reagents(conn, stid, b["reagents"], _default_supplier(conn))
    audit(conn, "step", stid, "update", old, b)
    return {"ok": True}


@route("DELETE", "/api/steps/:id")
def api_step_delete(conn, p, q, b):
    stid = int(p["id"])
    old = rowd(conn.execute("SELECT * FROM synthesis_steps WHERE id=?", (stid,)).fetchone())
    if not old:
        raise ApiError(404, "단계 없음")
    old["reagents"] = rows(conn.execute("SELECT * FROM reagents WHERE step_id=?", (stid,)))
    conn.execute("DELETE FROM synthesis_steps WHERE id=?", (stid,))
    audit(conn, "step", stid, "delete", old, None)  # 감사 로그에 전체 내용을 남겨 복원 가능
    return {"ok": True}


# ---------------------------------------------------------------- measurements
def _meas_row(conn, mid):
    r = conn.execute("SELECT * FROM measurements WHERE id=?", (mid,)).fetchone()
    if not r:
        raise ApiError(404, "측정 기록 없음")
    return rowd(r)


def _save_datasets(conn, mid, datasets):
    conn.execute("DELETE FROM datasets WHERE measurement_id=?", (mid,))
    for d in datasets or []:
        conn.execute("INSERT INTO datasets(measurement_id,name,columns_json,data_json,meta_json,created_at) VALUES(?,?,?,?,?,?)",
                     (mid, d.get("name", ""), jdump(d.get("columns", [])), json.dumps(d.get("data", [])),
                      jdump(d.get("meta", {})), db.now()))


@route("GET", "/api/measurements/:id")
def api_meas_get(conn, p, q, b):
    m = _meas_row(conn, int(p["id"]))
    m["datasets"] = rows(conn.execute("SELECT * FROM datasets WHERE measurement_id=? ORDER BY id", (m["id"],)))
    m["attachments"] = rows(conn.execute("SELECT * FROM attachments WHERE measurement_id=? ORDER BY id", (m["id"],)))
    m["interpretations"] = rows(conn.execute("SELECT * FROM interpretations WHERE measurement_id=? AND deleted_at IS NULL ORDER BY id DESC", (m["id"],)))
    if m["ec_session_id"]:
        m["ec_session"] = rowd(conn.execute("SELECT * FROM ec_sessions WHERE id=?", (m["ec_session_id"],)).fetchone())
    return m


@route("POST", "/api/measurements")
def api_meas_create(conn, p, q, b):
    need(b, "sample_id", "analysis_code")
    sid = int(b["sample_id"])
    get_sample(conn, sid)
    if not conn.execute("SELECT 1 FROM analysis_types WHERE code=?", (b["analysis_code"],)).fetchone():
        raise ApiError(400, "알 수 없는 분석 종류")
    t = db.now()
    cur = conn.execute(
        "INSERT INTO measurements(sample_id,analysis_code,ec_session_id,seq,title,measured_on,measured_on_source,conditions_json,values_json,"
        "computed_json,source_json,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (sid, b["analysis_code"], b.get("ec_session_id") or None, b.get("seq"), b.get("title", ""), b.get("measured_on") or None,
         b.get("measured_on_source") or ("user" if b.get("measured_on") else "none"), jdump(b.get("conditions")),
         jdump(b.get("values")), jdump(b.get("computed")), jdump(b.get("source")), b.get("notes", ""), t, t))
    mid = cur.lastrowid
    _save_datasets(conn, mid, b.get("datasets"))
    set_status(conn, sid, b["analysis_code"], "자료 있음", "결과 저장으로 자동 반영")
    audit(conn, "measurement", mid, "create", None, {k: v for k, v in b.items() if k != "datasets"})
    return {"id": mid}


@route("PUT", "/api/measurements/:id")
def api_meas_update(conn, p, q, b):
    mid = int(p["id"])
    old = _meas_row(conn, mid)
    if old["deleted_at"]:
        raise ApiError(400, "삭제된 기록은 먼저 복원하세요")
    f = lambda k: b.get(k, old.get(k))  # noqa: E731
    conn.execute(
        "UPDATE measurements SET ec_session_id=?, seq=?, title=?, measured_on=?, measured_on_source=?, conditions_json=?, values_json=?,"
        " computed_json=?, source_json=?, notes=?, updated_at=? WHERE id=?",
        (f("ec_session_id") or None, f("seq"), f("title"), f("measured_on") or None, f("measured_on_source") or "none",
         jdump(f("conditions")), jdump(f("values")), jdump(f("computed")), jdump(f("source")), f("notes"), db.now(), mid))
    if "datasets" in b:
        _save_datasets(conn, mid, b["datasets"])
    set_status(conn, old["sample_id"], old["analysis_code"], "자료 있음", "결과 저장으로 자동 반영")
    audit(conn, "measurement", mid, "update", old, {k: v for k, v in b.items() if k != "datasets"})
    return {"ok": True}


@route("DELETE", "/api/measurements/:id")
def api_meas_delete(conn, p, q, b):
    mid = int(p["id"])
    old = _meas_row(conn, mid)
    conn.execute("UPDATE measurements SET deleted_at=? WHERE id=?", (db.now(), mid))
    left = conn.execute("SELECT COUNT(*) FROM measurements WHERE sample_id=? AND analysis_code=? AND deleted_at IS NULL",
                        (old["sample_id"], old["analysis_code"])).fetchone()[0]
    st = conn.execute("SELECT status FROM sample_analysis_status WHERE sample_id=? AND analysis_code=?",
                      (old["sample_id"], old["analysis_code"])).fetchone()
    if left == 0 and st and st[0] == "자료 있음":
        set_status(conn, old["sample_id"], old["analysis_code"], "미업로드", "기록 삭제로 자동 반영")
    audit(conn, "measurement", mid, "soft_delete", old, None)
    return {"ok": True, "trash": True}


@route("POST", "/api/measurements/:id/restore")
def api_meas_restore(conn, p, q, b):
    mid = int(p["id"])
    m = _meas_row(conn, mid)
    s = conn.execute("SELECT deleted_at FROM samples WHERE id=?", (m["sample_id"],)).fetchone()
    if s and s[0]:
        raise ApiError(400, "샘플이 휴지통에 있습니다. 샘플을 먼저 복원하세요")
    conn.execute("UPDATE measurements SET deleted_at=NULL WHERE id=?", (mid,))
    set_status(conn, m["sample_id"], m["analysis_code"], "자료 있음", "기록 복원")
    audit(conn, "measurement", mid, "restore")
    return {"ok": True}


# ---------------------------------------------------------------- ec sessions
@route("POST", "/api/ec_sessions")
def api_ec_create(conn, p, q, b):
    need(b, "sample_id")
    get_sample(conn, int(b["sample_id"]))
    t = db.now()
    cur = conn.execute("INSERT INTO ec_sessions(sample_id,name,params_json,notes,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                       (int(b["sample_id"]), b.get("name", ""), jdump(b.get("params")), b.get("notes", ""), t, t))
    audit(conn, "ec_session", cur.lastrowid, "create", None, b)
    return {"id": cur.lastrowid}


@route("PUT", "/api/ec_sessions/:id")
def api_ec_update(conn, p, q, b):
    eid = int(p["id"])
    old = rowd(conn.execute("SELECT * FROM ec_sessions WHERE id=?", (eid,)).fetchone())
    if not old:
        raise ApiError(404, "세션 없음")
    conn.execute("UPDATE ec_sessions SET name=?, params_json=?, notes=?, updated_at=? WHERE id=?",
                 (b.get("name", old["name"]), jdump(b.get("params", old["params"])), b.get("notes", old["notes"]), db.now(), eid))
    audit(conn, "ec_session", eid, "update", old, b)
    return {"ok": True}


# ---------------------------------------------------------------- attachments & files
def _stat(path):
    try:
        st = os.stat(path)
        return st.st_size, st.st_mtime
    except OSError:
        return None, None


def attachment_state(a):
    path = a["stored_path"] if a["mode"] == "copy" else a["original_path"]
    size, mtime = _stat(path)
    if size is None:
        return "missing"
    if a["mode"] == "link" and a.get("size") is not None and (size != a["size"] or abs((mtime or 0) - (a.get("mtime") or 0)) > 2):
        return "changed"
    return "ok"


@route("POST", "/api/attachments")
def api_att_create(conn, p, q, b):
    mode = b.get("mode", "link")
    if mode not in ("link", "copy"):
        raise ApiError(400, "mode 는 link 또는 copy")
    sid, mid = b.get("sample_id"), b.get("measurement_id")
    if not sid and mid:
        sid = _meas_row(conn, int(mid))["sample_id"]
    orig, raw, fname = "", None, b.get("file_name", "")
    if b.get("path"):
        orig = os.path.expandvars(os.path.expanduser(b["path"].strip().strip('"')))
        fname = fname or os.path.basename(orig)
        if mode == "copy":
            orig, raw = read_path_bytes(orig)
        elif not os.path.isfile(orig):
            raise ApiError(404, f"경로에 파일이 없습니다: {orig}")
    elif b.get("content_b64"):
        if mode == "link":
            raise ApiError(400, "업로드한 파일은 경로를 알 수 없으므로 '앱에 복사' 방식만 가능합니다")
        raw = base64.b64decode(b["content_b64"])
    else:
        raise ApiError(400, "path 또는 content_b64 가 필요합니다")
    stored, sha = "", None
    if mode == "copy":
        sha = hashlib.sha256(raw).hexdigest()
        safe = re.sub(r'[\\/:*?"<>|]', "_", fname or "file")
        stored = os.path.join(db.FILES_DIR, f"{sha[:16]}_{safe}")
        if not os.path.exists(stored):
            with open(stored, "wb") as f:
                f.write(raw)
        size, mtime = len(raw), None
    else:
        size, mtime = _stat(orig)
    cur = conn.execute("INSERT INTO attachments(sample_id,measurement_id,mode,original_path,stored_path,file_name,size,mtime,sha256,role,note,created_at)"
                       " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                       (sid, mid, mode, orig, stored, fname or "file", size, mtime, sha, b.get("role", "원본"), b.get("note", ""), db.now()))
    audit(conn, "attachment", cur.lastrowid, "create", None, {k: v for k, v in b.items() if k != "content_b64"})
    return {"id": cur.lastrowid}


@route("GET", "/api/attachments/check")
def api_att_check(conn, p, q, b):
    ids = [int(x) for x in (q.get("ids", [""])[0] or "").split(",") if x]
    out = {}
    for i in ids:
        a = conn.execute("SELECT * FROM attachments WHERE id=?", (i,)).fetchone()
        if a:
            out[i] = attachment_state(dict(a))
    return {"states": out}


@route("PUT", "/api/attachments/:id")
def api_att_update(conn, p, q, b):
    aid = int(p["id"])
    old = conn.execute("SELECT * FROM attachments WHERE id=?", (aid,)).fetchone()
    if not old:
        raise ApiError(404, "첨부 없음")
    path = b.get("path")
    if path and old["mode"] == "link":  # 깨진 링크 경로 재지정
        path = os.path.expandvars(os.path.expanduser(path.strip().strip('"')))
        size, mtime = _stat(path)
        if size is None:
            raise ApiError(404, f"경로에 파일이 없습니다: {path}")
        conn.execute("UPDATE attachments SET original_path=?, file_name=?, size=?, mtime=? WHERE id=?",
                     (path, os.path.basename(path), size, mtime, aid))
    if "note" in b or "role" in b:
        conn.execute("UPDATE attachments SET note=?, role=? WHERE id=?", (b.get("note", old["note"]), b.get("role", old["role"]), aid))
    audit(conn, "attachment", aid, "update", dict(old), b)
    return {"ok": True}


@route("DELETE", "/api/attachments/:id")
def api_att_delete(conn, p, q, b):
    aid = int(p["id"])
    old = conn.execute("SELECT * FROM attachments WHERE id=?", (aid,)).fetchone()
    if not old:
        raise ApiError(404, "첨부 없음")
    # 연결 정보만 지운다. 원본 파일(링크)과 복사본 파일은 지우지 않는다.
    conn.execute("DELETE FROM attachments WHERE id=?", (aid,))
    audit(conn, "attachment", aid, "delete", dict(old), None)
    return {"ok": True}


def attachment_file(conn, aid):
    a = conn.execute("SELECT * FROM attachments WHERE id=?", (aid,)).fetchone()
    if not a:
        raise ApiError(404, "첨부 없음")
    path = a["stored_path"] if a["mode"] == "copy" else a["original_path"]
    if not os.path.isfile(path):
        raise ApiError(404, f"파일이 없습니다 (경로 깨짐): {path}")
    return path, a["file_name"]


@route("POST", "/api/files/read")
def api_file_read(conn, p, q, b):
    """경로로 연결한 파일을 읽어 텍스트로 돌려준다 (가져오기 미리보기용, 앱에 저장하지 않음)."""
    if b.get("attachment_id"):
        path, _ = attachment_file(conn, int(b["attachment_id"]))
    else:
        need(b, "path")
        path = b["path"]
    path, raw = read_path_bytes(path)
    name = os.path.basename(path)
    ext = os.path.splitext(name)[1].lower()
    if ext == ".pdf":
        text, enc, method = pdf_text(raw), "pdf", "pdf_text"
    elif ext in (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"):
        text, enc, method = ocr_image(raw), "ocr", "ocr"
    else:
        text, enc = decode_text(raw)
        method = "text"
    size, mtime = _stat(path)
    return {"path": path, "file_name": name, "text": text, "encoding": enc, "method": method, "size": size,
            "mtime": mtime, "date_candidates": date_candidates(text)}


@route("POST", "/api/files/list")
def api_file_list(conn, p, q, b):
    """폴더 안의 파일 목록 (가져오기 후보 찾기용, 내용은 읽지 않음)."""
    need(b, "dir")
    d = os.path.expandvars(os.path.expanduser(b["dir"].strip().strip('"')))
    if not os.path.isdir(d):
        raise ApiError(404, f"폴더를 찾을 수 없습니다: {d}")
    exts = tuple(x.lower() for x in (b.get("exts") or [".pdf"]))
    out = []
    walker = os.walk(d) if b.get("recursive") else [(d, [], os.listdir(d))]
    for root, _dirs, files in walker:
        for fn in sorted(files):
            fp = os.path.join(root, fn)
            if fn.lower().endswith(exts) and os.path.isfile(fp):
                st = os.stat(fp)
                out.append({"path": fp, "name": fn, "size": st.st_size, "mtime": st.st_mtime})
            if len(out) >= 500:
                break
    return {"dir": d, "files": out, "truncated": len(out) >= 500}


@route("POST", "/api/extract")
def api_extract(conn, p, q, b):
    """업로드한 PDF/이미지에서 텍스트 추출 (파일은 저장하지 않음)."""
    need(b, "content_b64")
    raw = base64.b64decode(b["content_b64"])
    name = b.get("file_name", "")
    ext = os.path.splitext(name)[1].lower()
    if ext == ".pdf":
        text, method = pdf_text(raw), "pdf_text"
    elif ext in (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"):
        text, method = ocr_image(raw), "ocr"
    else:
        text, _ = decode_text(raw)
        method = "text"
    return {"file_name": name, "text": text, "method": method, "date_candidates": date_candidates(text)}


@route("POST", "/api/dates")
def api_dates(conn, p, q, b):
    return {"date_candidates": date_candidates(b.get("text", ""))}


# ---------------------------------------------------------------- interpretations
@route("POST", "/api/interpretations")
def api_interp_create(conn, p, q, b):
    need(b, "kind", "text")
    if b["kind"] not in ("user_interpretation", "ai_hypothesis"):
        raise ApiError(400, "kind 오류")
    cur = conn.execute("INSERT INTO interpretations(kind,sample_id,measurement_id,text,evidence_json,created_at) VALUES(?,?,?,?,?,?)",
                       (b["kind"], b.get("sample_id"), b.get("measurement_id"), b["text"], jdump(b.get("evidence")), db.now()))
    audit(conn, "interpretation", cur.lastrowid, "create", None, b)
    return {"id": cur.lastrowid}


@route("DELETE", "/api/interpretations/:id")
def api_interp_delete(conn, p, q, b):
    iid = int(p["id"])
    old = conn.execute("SELECT * FROM interpretations WHERE id=?", (iid,)).fetchone()
    conn.execute("UPDATE interpretations SET deleted_at=? WHERE id=?", (db.now(), iid))
    audit(conn, "interpretation", iid, "soft_delete", dict(old) if old else None, None)
    return {"ok": True}


# ---------------------------------------------------------------- compare / export
@route("POST", "/api/compare")
def api_compare(conn, p, q, b):
    ids = [int(x) for x in b.get("sample_ids", [])]
    code = b.get("analysis_code")
    if not ids or not code:
        raise ApiError(400, "sample_ids 와 analysis_code 가 필요합니다")
    ph = ",".join("?" * len(ids))
    ms = rows(conn.execute(f"SELECT * FROM measurements WHERE deleted_at IS NULL AND analysis_code=? AND sample_id IN ({ph})"
                           " ORDER BY sample_id, COALESCE(seq,1e9), measured_on, id", [code] + ids))
    if b.get("include_datasets", True):
        for m in ms:
            m["datasets"] = rows(conn.execute("SELECT * FROM datasets WHERE measurement_id=? ORDER BY id", (m["id"],)))
    sessions = {}
    for m in ms:
        if m.get("ec_session_id") and m["ec_session_id"] not in sessions:
            sessions[m["ec_session_id"]] = rowd(conn.execute("SELECT * FROM ec_sessions WHERE id=?", (m["ec_session_id"],)).fetchone())
    return {"measurements": ms, "ec_sessions": sessions}


@route("POST", "/api/metrics")
def api_metrics(conn, p, q, b):
    """패턴 탐색용: 선택 샘플의 모든 측정 요약(데이터셋 제외)."""
    ids = [int(x) for x in b.get("sample_ids", [])]
    if not ids:
        return {"measurements": []}
    ph = ",".join("?" * len(ids))
    ms = rows(conn.execute(f"SELECT id,sample_id,analysis_code,title,measured_on,measured_on_source,conditions_json,values_json,computed_json,source_json"
                           f" FROM measurements WHERE deleted_at IS NULL AND sample_id IN ({ph})", ids))
    return {"measurements": ms}


SOURCE_LEGEND = {
    "default": "앱 기본값(사용자가 확인·수정하지 않음). 실측/실제 조건으로 간주하지 말 것",
    "user": "사용자가 직접 입력 또는 수정",
    "file": "파일에 기재된 값을 자동 입력",
    "extracted": "PDF/OCR/붙여넣기에서 추출, 사용자가 수정하지 않음",
    "extracted_edited": "추출 후 사용자가 수정",
    "computed": "앱 계산값 (formula 참조)",
}


@route("GET", "/api/export/context")
def api_export(conn, p, q, b):
    ids_q = (q.get("ids", [""])[0] or "")
    if ids_q:
        ids = [int(x) for x in ids_q.split(",") if x]
    else:
        ids = [r[0] for r in conn.execute("SELECT id FROM samples WHERE deleted_at IS NULL")]
    types = {r["code"]: r for r in rows(conn.execute("SELECT * FROM analysis_types"))}
    out_samples = []
    for sid in ids:
        s = api_sample_get(conn, {"id": sid}, {}, {})
        if s.get("deleted_at"):
            continue
        meas = []
        for m in s["measurements"]:
            ds = rows(conn.execute("SELECT name, columns_json, meta_json, length(data_json) bytes FROM datasets WHERE measurement_id=?", (m["id"],)))
            meas.append({
                "id": m["id"], "analysis": m["analysis_code"], "analysis_name": types.get(m["analysis_code"], {}).get("name"),
                "title": m["title"], "sequence": m["seq"], "measured_on": m["measured_on"], "measured_on_source": m["measured_on_source"],
                "conditions": m["conditions"], "recorded_values": m["values"], "computed_values": m["computed"],
                "provenance": m["source"], "notes": m["notes"],
                "raw_datasets": [{"name": d["name"], "columns": d["columns"], "processing": d["meta"], "size_bytes": d["bytes"]} for d in ds],
            })
        out_samples.append({
            "id": s["id"], "name": s["name"], "synthesized_on": s["synthesized_on"], "description": s["description"], "notes": s["notes"],
            "series": [x["name"] for x in s["series"]],
            "parents": [{"name": l["parent_name"], "relation": l["relation"], "branch_point": l["branch_point"], "note": l["note"]} for l in s["links_up"]],
            "children": [{"name": l["child_name"], "relation": l["relation"], "branch_point": l["branch_point"]} for l in s["links_down"]],
            "synthesis_steps": [{"seq": st["seq"], "type": st["step_type"], "title": st["title"], "parameters": st["params"], "notes": st["notes"],
                                 "reagents": [{k: r[k] for k in ("name", "amount", "unit", "supplier", "supplier_source", "lot", "notes")} for r in st["reagents"]]}
                                for st in s["steps"]],
            "analysis_status": {code: (s["statuses"].get(code) or {"status": db.DEFAULT_STATUS})["status"] for code in types},
            "measurements": meas,
            "ec_sessions": s["ec_sessions"],
            "user_interpretations": [i for i in s["interpretations"] if i["kind"] == "user_interpretation"],
            "ai_hypotheses": [i for i in s["interpretations"] if i["kind"] == "ai_hypothesis"],
        })
    return {
        "format": "pattern-seeker-context", "format_version": 1, "exported_at": db.now(), "schema_version": db.schema_version(conn),
        "reading_guide": {
            "missing_values": "키가 없거나 null 인 값은 측정되지 않음/보고되지 않음을 뜻한다. 0 이나 정상으로 해석하지 말 것",
            "source_codes": SOURCE_LEGEND,
            "recorded_vs_computed": "recorded_values 는 보고서·입력·추출 값, computed_values 는 앱 계산값(formula 포함)이다",
            "interpretations": "user_interpretations 는 연구자의 해석, ai_hypotheses 는 AI 가설이며 사실로 취급하지 말 것",
            "statuses": {"자료 있음": "결과 저장됨", "자료 없음": "자료가 없음이 확인됨", "계획 없음": "분석 계획이 없음",
                         "의뢰 중": "분석 의뢰 후 대기", "미업로드": "기본값: 아직 등록되지 않음"},
            "correlation": "샘플 간 비교에서 얻은 상관은 인과가 아니다. 조건이 다른 측정을 같은 조건처럼 합치지 말 것",
        },
        "analysis_types": {c: {"name": t["name"], "metrics": t["config"].get("metrics", []), "description": t["description"]} for c, t in types.items()},
        "samples": out_samples,
    }


# ---------------------------------------------------------------- trash / backup
@route("GET", "/api/trash")
def api_trash(conn, p, q, b):
    return {
        "samples": rows(conn.execute("SELECT id,name,deleted_at FROM samples WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")),
        "measurements": rows(conn.execute("SELECT m.id, m.analysis_code, m.title, m.deleted_at, s.name sample_name FROM measurements m"
                                          " JOIN samples s ON s.id=m.sample_id WHERE m.deleted_at IS NOT NULL ORDER BY m.deleted_at DESC")),
    }


@route("GET", "/api/audit")
def api_audit(conn, p, q, b):
    lim = min(int(q.get("limit", ["100"])[0]), 1000)
    return {"entries": [dict(r) for r in conn.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (lim,))]}


@route("GET", "/api/backups")
def api_backups(conn, p, q, b):
    return {"backups": db.list_backups(), "backup_dir": db.BACKUP_DIR}


@route("POST", "/api/backups")
def api_backup_make(conn, p, q, b):
    conn.commit()
    return db.make_backup(b.get("reason") or "수동 백업")


@route("POST", "/api/backups/verify")
def api_backup_verify(conn, p, q, b):
    try:
        return db.verify_backup(db._safe_backup_path(b.get("name")))
    except (ValueError, FileNotFoundError) as e:
        raise ApiError(400, str(e))


# POST /api/backups/restore 는 열린 연결이 없는 상태에서 처리해야 하므로 Handler._api 에서 직접 처리한다.


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "PatternSeeker/1"

    def log_message(self, fmt, *args):
        if os.environ.get("PATTERN_SEEKER_VERBOSE"):
            super().log_message(fmt, *args)

    def _send(self, status, obj=None, raw=None, ctype="application/json; charset=utf-8", headers=None):
        data = raw if raw is not None else json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ApiError(413, "요청이 너무 큽니다")
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except ValueError:
            raise ApiError(400, "JSON 형식 오류")

    def _api(self, method):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        try:
            body = self._body() if method in ("POST", "PUT") else {}
            m = re.match(r"^/api/attachments/(\d+)/file$", path)
            if method == "GET" and m:
                with LOCK:
                    c = db.connect()
                    try:
                        fpath, fname = attachment_file(c, int(m.group(1)))
                    finally:
                        c.close()
                with open(fpath, "rb") as f:
                    data = f.read()
                ctype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
                return self._send(200, raw=data, ctype=ctype, headers={"Content-Disposition": "inline"})
            if method == "POST" and path == "/api/backups/restore":
                with LOCK:
                    try:
                        return self._send(200, db.restore_backup(body.get("name")))
                    except (ValueError, FileNotFoundError) as e:
                        raise ApiError(400, str(e))
            for meth, rx, fn in ROUTES:
                if meth != method:
                    continue
                mm = rx.match(path)
                if not mm:
                    continue
                params = {k: unquote(v) for k, v in mm.groupdict().items()}
                with LOCK:
                    conn = db.connect()
                    try:
                        res = fn(conn, params, q, body)
                        conn.commit()
                    except Exception:
                        conn.rollback()
                        raise
                    finally:
                        conn.close()
                return self._send(200, res)
            raise ApiError(404, f"API 없음: {method} {path}")
        except ApiError as e:
            self._send(e.status, {"error": e.msg})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._send(500, {"error": f"서버 오류: {e}"})

    def _static(self):
        path = urlparse(self.path).path
        if path in ("/", ""):
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            return self._send(404, {"error": "not found"})
        with open(full, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, raw=data, ctype=ctype)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._api("GET")
        self._static()

    def do_POST(self):
        self._api("POST")

    def do_PUT(self):
        self._api("PUT")

    def do_DELETE(self):
        self._api("DELETE")


def main():
    mimetypes.add_type("application/javascript", ".js")
    res = db.migrate()
    print(f"[Pattern Seeker] 데이터 폴더: {db.DATA_DIR}  (스키마 v{res['version']})")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"[Pattern Seeker] {url} 에서 실행 중. 종료하려면 이 창에서 Ctrl+C")
    if "--no-browser" not in sys.argv and not os.environ.get("PATTERN_SEEKER_NO_BROWSER"):
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[Pattern Seeker] 종료")


if __name__ == "__main__":
    main()
