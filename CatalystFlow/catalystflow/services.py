"""업무 규칙 계층.

- 화면(HTTP/JS)과 저장(SQLite)에서 분리된 순수 업무 로직.
- 모든 쓰기 명령은 @command 로 감싸져 하나의 트랜잭션 안에서 실행된다.
  * 전체 성공 또는 전체 취소
  * op_id 가 같으면 두 번째 실행은 첫 결과를 돌려줄 뿐 아무것도 바꾸지 않는다(중복 클릭·재시도 방지)
- 수정은 version 으로 충돌을 막고, 수정 전/후 값을 audit_log 에 남긴다.
"""
from __future__ import annotations

import json
import math
from typing import Any, Callable

from .db import Database, now_iso
from .errors import ConflictError, UserError
from .schema import INTERNAL_QC, LONG_WAIT_QC, REQUIRED_PRODUCT_QC

EPS = 1e-6
QTY_KINDS = {"measured", "estimated", "calculated", "planned", "unknown"}
BASES = {"slurry_total", "wet", "dry", "as_is", "unspecified"}
FIRM_KINDS = {"measured", "calculated"}  # 확정 수량으로 검증에 쓰는 종류

BASIS_KO = {"slurry_total": "슬러리 전체", "wet": "습윤", "dry": "건조", "as_is": "그대로", "unspecified": "기준 미지정"}
KIND_KO = {"measured": "실측", "estimated": "추정", "calculated": "계산", "planned": "계획", "unknown": "미측정"}
STATUS_KO = {"planned": "계획", "in_progress": "진행 중", "paused": "보류", "done": "완료", "cancelled": "기록 취소"}


# ---------------------------------------------------------------------------
# 명령 실행 기반
# ---------------------------------------------------------------------------
class Ctx:
    def __init__(self, conn, op_id: str | None):
        self.c = conn
        self.op_id = op_id
        self.ts = now_iso()

    def q(self, sql, p=()):
        return [dict(r) for r in self.c.execute(sql, p).fetchall()]

    def q1(self, sql, p=()):
        r = self.c.execute(sql, p).fetchone()
        return dict(r) if r else None

    def x(self, sql, p=()):
        return self.c.execute(sql, p)

    def insert(self, table: str, row: dict) -> int:
        cols = ",".join(row)
        qs = ",".join("?" for _ in row)
        return self.c.execute(f"INSERT INTO {table}({cols}) VALUES({qs})", tuple(row.values())).lastrowid

    def audit(self, entity, entity_id, action, before=None, after=None, batch_id=None, reason=""):
        self.insert("audit_log", {
            "at": self.ts, "entity": entity, "entity_id": entity_id, "batch_id": batch_id,
            "action": action,
            "before_json": json.dumps(before, ensure_ascii=False) if before is not None else None,
            "after_json": json.dumps(after, ensure_ascii=False) if after is not None else None,
            "reason": reason or "", "op_id": self.op_id,
        })

    def get(self, table, id_, what="기록"):
        row = self.q1(f"SELECT * FROM {table} WHERE id=?", (id_,))
        if not row:
            raise UserError(f"{what}을(를) 찾을 수 없습니다 (#{id_}).", code="not_found")
        return row

    def check_version(self, row: dict, version):
        if version is None:
            return
        if int(version) != int(row["version"]):
            raise ConflictError()

    def update(self, table, row: dict, changes: dict, *, entity=None, batch_id=None, reason="", action="update"):
        """변경된 필드만 갱신 + version 증가 + 변경 이력."""
        changes = {k: v for k, v in changes.items() if k in row and row[k] != v}
        if not changes:
            return row
        sets = ",".join(f"{k}=?" for k in changes)
        extra = ""
        if "version" in row:
            extra = ", version = version + 1"
        if "updated_at" in row and "updated_at" not in changes:
            extra += ", updated_at = ?"
            params = (*changes.values(), self.ts, row["id"])
        else:
            params = (*changes.values(), row["id"])
        self.x(f"UPDATE {table} SET {sets}{extra} WHERE id=?", params)
        self.audit(entity or table, row["id"], action,
                   {k: row[k] for k in changes}, changes, batch_id=batch_id, reason=reason)
        return self.q1(f"SELECT * FROM {table} WHERE id=?", (row["id"],))


COMMANDS: dict[str, Callable] = {}


def command(fn):
    """쓰기 명령 등록. 트랜잭션 + 멱등성."""
    name = fn.__name__

    def run(db: Database, payload: dict | None = None, op_id: str | None = None):
        payload = dict(payload or {})
        with db.tx() as conn:
            if op_id:
                prev = conn.execute("SELECT result_json FROM ops WHERE op_id=?", (op_id,)).fetchone()
                if prev:
                    res = json.loads(prev[0]) if prev[0] else {}
                    if isinstance(res, dict):
                        res["replayed"] = True
                    return res
            ctx = Ctx(conn, op_id)
            result = fn(ctx, **payload)
            if op_id:
                conn.execute("INSERT INTO ops(op_id, kind, result_json, at) VALUES(?,?,?,?)",
                             (op_id, name, json.dumps(result, ensure_ascii=False), ctx.ts))
            return result

    run.__name__ = name
    run.__doc__ = fn.__doc__
    COMMANDS[name] = run
    return run


# ---------------------------------------------------------------------------
# 입력값 도우미
# ---------------------------------------------------------------------------
def _num(v, what="수량", allow_none=True, positive=False) -> float | None:
    if v is None or (isinstance(v, str) and v.strip() == ""):
        if allow_none:
            return None
        raise UserError(f"{what}을(를) 입력하세요.")
    try:
        f = float(str(v).replace(",", ""))
    except ValueError:
        raise UserError(f"{what}은(는) 숫자여야 합니다: {v!r}")
    if math.isnan(f) or math.isinf(f):
        raise UserError(f"{what} 값이 올바르지 않습니다.")
    if f < 0:
        raise UserError(f"{what}은(는) 음수일 수 없습니다.")
    if positive and f <= 0:
        raise UserError(f"{what}은(는) 0보다 커야 합니다.")
    return round(f, 6)


def _s(v) -> str:
    return "" if v is None else str(v).strip()


def _opt(v) -> str | None:
    v = _s(v)
    return v or None


def _kind(v, default="measured") -> str:
    v = v or default
    if v not in QTY_KINDS:
        raise UserError(f"알 수 없는 수량 종류: {v}")
    return v


def _basis(v, default="unspecified") -> str:
    v = v or default
    if v not in BASES:
        raise UserError(f"알 수 없는 질량 기준: {v}")
    return v


def fmt_g(v) -> str:
    if v is None:
        return "미측정"
    return f"{v:,.3f}".rstrip("0").rstrip(".") + " g"


def _qty_pair(qty, kind) -> tuple[float | None, str]:
    """미측정(None)과 0을 구분한다. 수량이 없으면 kind는 unknown."""
    q = _num(qty)
    if q is None:
        return None, "unknown"
    k = _kind(kind, "measured")
    if k == "unknown":
        k = "measured"
    return q, k


# ---------------------------------------------------------------------------
# 원료
# ---------------------------------------------------------------------------
def lot_remaining(conn_or_ctx, lot_id) -> float:
    q1 = conn_or_ctx.q1
    lot = q1("SELECT received_qty_g FROM raw_lots WHERE id=?", (lot_id,))
    s = q1("SELECT COALESCE(SUM(delta_g),0) AS s FROM raw_ledger WHERE lot_id=? AND voided_at IS NULL", (lot_id,))
    return round(lot["received_qty_g"] + s["s"], 6)


@command
def add_raw_material(ctx: Ctx, name, note=""):
    name = _s(name)
    if not name:
        raise UserError("원료 이름을 입력하세요.")
    if ctx.q1("SELECT id FROM raw_materials WHERE name=?", (name,)):
        raise UserError(f"'{name}' 원료가 이미 있습니다.")
    rid = ctx.insert("raw_materials", {"name": name, "note": _s(note), "created_at": ctx.ts})
    ctx.audit("raw_material", rid, "create", after={"name": name})
    return {"id": rid}


@command
def receive_lot(ctx: Ctx, raw_material_id, lot_code, received_qty_g, received_date=None, supplier="", note=""):
    ctx.get("raw_materials", raw_material_id, "원료")
    code = _s(lot_code)
    if not code:
        raise UserError("Lot 번호를 입력하세요.")
    qty = _num(received_qty_g, "입고량", allow_none=False, positive=True)
    dup = ctx.q1("SELECT id FROM raw_lots WHERE raw_material_id=? AND lot_code=? AND deleted_at IS NULL",
                 (raw_material_id, code))
    warning = None
    if dup:
        warning = f"같은 Lot 번호({code})가 이미 있습니다. 중복 입고가 아닌지 확인하세요."
    row = {"raw_material_id": raw_material_id, "lot_code": code, "received_date": _opt(received_date),
           "received_qty_g": qty, "supplier": _s(supplier), "note": _s(note), "created_at": ctx.ts}
    lid = ctx.insert("raw_lots", row)
    ctx.audit("raw_lot", lid, "create", after=row)
    return {"id": lid, "warning": warning}


@command
def update_lot(ctx: Ctx, lot_id, version=None, **fields):
    lot = ctx.get("raw_lots", lot_id, "원료 Lot")
    ctx.check_version(lot, version)
    ch = {}
    if "lot_code" in fields:
        ch["lot_code"] = _s(fields["lot_code"]) or lot["lot_code"]
    if "received_qty_g" in fields:
        ch["received_qty_g"] = _num(fields["received_qty_g"], "입고량", allow_none=False, positive=True)
    for k in ("received_date",):
        if k in fields:
            ch[k] = _opt(fields[k])
    for k in ("supplier", "note"):
        if k in fields:
            ch[k] = _s(fields[k])
    ctx.update("raw_lots", lot, ch, entity="raw_lot", reason=_s(fields.get("reason")))
    return {"id": lot_id}


def _lot_usage(ctx, lot_id):
    return ctx.q("""SELECT l.*, b.code AS batch_code, s.name AS step_name FROM raw_ledger l
                    LEFT JOIN batches b ON b.id=l.batch_id LEFT JOIN steps s ON s.id=l.step_id
                    WHERE l.lot_id=? AND l.kind='consume' AND l.voided_at IS NULL""", (lot_id,))


@command
def trash_lot(ctx: Ctx, lot_id, reason=""):
    lot = ctx.get("raw_lots", lot_id, "원료 Lot")
    uses = _lot_usage(ctx, lot_id)
    if uses:
        details = [f"배치 {u['batch_code']} · {u['step_name'] or '원료 투입'}: {fmt_g(-u['delta_g'])} 투입 (원장 #{u['id']})"
                   for u in uses]
        raise UserError(
            f"Lot {lot['lot_code']}은(는) 실제 투입 이력이 있어 휴지통으로 옮길 수 없습니다. "
            "투입 이력을 지우면 배치의 원료 기록이 끊깁니다. 중복 입고 Lot이라면 아래 투입을 "
            "올바른 Lot으로 '투입 Lot 변경'한 뒤 다시 시도하세요.",
            code="linked", details=details)
    ctx.x("UPDATE raw_lots SET deleted_at=?, version=version+1 WHERE id=?", (ctx.ts, lot_id))
    ctx.audit("raw_lot", lot_id, "trash", before={"deleted_at": None}, after={"deleted_at": ctx.ts}, reason=reason)
    return {"id": lot_id}


@command
def restore_lot(ctx: Ctx, lot_id):
    ctx.get("raw_lots", lot_id, "원료 Lot")
    ctx.x("UPDATE raw_lots SET deleted_at=NULL, version=version+1 WHERE id=?", (lot_id,))
    ctx.audit("raw_lot", lot_id, "restore")
    return {"id": lot_id}


@command
def correct_lot_remaining(ctx: Ctx, lot_id, measured_remaining_g, at=None, note=""):
    """실측 잔량 정정: 차이만큼 정정 원장을 남긴다(기존 기록은 그대로)."""
    lot = ctx.get("raw_lots", lot_id, "원료 Lot")
    measured = _num(measured_remaining_g, "실측 잔량", allow_none=False)
    cur = lot_remaining(ctx, lot_id)
    delta = round(measured - cur, 6)
    if abs(delta) < EPS:
        return {"id": None, "delta_g": 0}
    lid = ctx.insert("raw_ledger", {"lot_id": lot_id, "kind": "adjust", "delta_g": delta, "at": _opt(at),
                                    "note": _s(note) or "실측 잔량 정정", "created_at": ctx.ts})
    ctx.audit("raw_lot", lot_id, "correct_remaining", before={"remaining_g": cur},
              after={"remaining_g": measured}, reason=_s(note))
    return {"id": lid, "delta_g": delta}


@command
def return_raw(ctx: Ctx, ledger_id, qty_g, at=None, note=""):
    """실제 물질 반환(쓰고 남은 원료를 Lot에 되돌림). 투입 기록은 유지하고 반환을 별도로 남긴다."""
    led = ctx.get("raw_ledger", ledger_id, "투입 기록")
    q = _num(qty_g, "반환량", allow_none=False, positive=True)
    if q > -led["delta_g"] + EPS:
        raise UserError(f"반환량({fmt_g(q)})이 투입량({fmt_g(-led['delta_g'])})보다 많습니다.")
    nid = ctx.insert("raw_ledger", {"lot_id": led["lot_id"], "kind": "adjust", "delta_g": q, "step_id": led["step_id"],
                                    "batch_id": led["batch_id"], "at": _opt(at),
                                    "note": "실물 반환" + (f": {_s(note)}" if note else ""), "created_at": ctx.ts})
    ctx.audit("raw_ledger", nid, "physical_return", after={"qty_g": q}, batch_id=led["batch_id"], reason=_s(note))
    return {"id": nid}


@command
def void_raw_consumption(ctx: Ctx, ledger_id, reason=""):
    """기록 취소: 잘못 입력한 투입. 원장 행은 남기되 계산에서 제외."""
    led = ctx.get("raw_ledger", ledger_id, "투입 기록")
    if led["voided_at"]:
        return {"id": ledger_id}
    if not _s(reason):
        raise UserError("취소 사유를 입력하세요.")
    ctx.x("UPDATE raw_ledger SET voided_at=?, void_reason=? WHERE id=?", (ctx.ts, _s(reason), ledger_id))
    ctx.audit("raw_ledger", ledger_id, "void", before={"delta_g": led["delta_g"]}, batch_id=led["batch_id"],
              reason=reason)
    return {"id": ledger_id}


@command
def reassign_consumption(ctx: Ctx, ledger_id, new_lot_id, reason=""):
    """투입 Lot 변경(중복 입고 Lot 정리용). 같은 원료끼리만."""
    led = ctx.get("raw_ledger", ledger_id, "투입 기록")
    old = ctx.get("raw_lots", led["lot_id"], "원료 Lot")
    new = ctx.get("raw_lots", new_lot_id, "원료 Lot")
    if new["deleted_at"]:
        raise UserError("휴지통에 있는 Lot으로는 옮길 수 없습니다.")
    if new["raw_material_id"] != old["raw_material_id"]:
        raise UserError("다른 원료의 Lot으로는 옮길 수 없습니다.")
    ctx.x("UPDATE raw_ledger SET lot_id=? WHERE id=?", (new_lot_id, ledger_id))
    ctx.audit("raw_ledger", ledger_id, "reassign_lot", before={"lot_id": old["id"], "lot_code": old["lot_code"]},
              after={"lot_id": new["id"], "lot_code": new["lot_code"]}, batch_id=led["batch_id"], reason=reason)
    return {"id": ledger_id}


# ---------------------------------------------------------------------------
# 배치·가지
# ---------------------------------------------------------------------------
@command
def create_batch(ctx: Ctx, code, title="", purpose="", common_conditions="", note="",
                 first_branch_name="생산", first_branch_kind="production"):
    code = _s(code)
    if not code:
        raise UserError("배치 번호를 입력하세요.")
    if ctx.q1("SELECT id FROM batches WHERE code=?", (code,)):
        raise UserError(f"배치 번호 '{code}'가 이미 있습니다.")
    row = {"code": code, "title": _s(title), "purpose": _s(purpose), "common_conditions": _s(common_conditions),
           "note": _s(note), "created_at": ctx.ts, "updated_at": ctx.ts}
    bid = ctx.insert("batches", row)
    ctx.audit("batch", bid, "create", after=row, batch_id=bid)
    br = ctx.insert("branches", {"batch_id": bid, "name": _s(first_branch_name) or "생산",
                                 "kind": first_branch_kind, "created_at": ctx.ts})
    ctx.audit("branch", br, "create", after={"name": first_branch_name}, batch_id=bid)
    return {"id": bid, "branch_id": br}


@command
def update_batch(ctx: Ctx, batch_id, version=None, **fields):
    b = ctx.get("batches", batch_id, "배치")
    ctx.check_version(b, version)
    ch = {k: _s(fields[k]) for k in ("title", "purpose", "common_conditions", "note") if k in fields}
    if "code" in fields:
        code = _s(fields["code"])
        if not code:
            raise UserError("배치 번호는 비울 수 없습니다.")
        if code != b["code"] and ctx.q1("SELECT id FROM batches WHERE code=?", (code,)):
            raise UserError(f"배치 번호 '{code}'가 이미 있습니다.")
        ch["code"] = code
    ctx.update("batches", b, ch, entity="batch", batch_id=batch_id, reason=_s(fields.get("reason")))
    return {"id": batch_id}


@command
def set_batch_status(ctx: Ctx, batch_id, action, reason=""):
    """action: archive | unarchive | trash | restore"""
    b = ctx.get("batches", batch_id, "배치")
    if action == "archive":
        new, extra = "archived", {}
    elif action == "unarchive":
        new, extra = "active", {}
    elif action == "trash":
        new, extra = "trashed", {"trashed_from": b["status"]}
    elif action == "restore":
        new, extra = (b["trashed_from"] or "active"), {"trashed_from": None}
    else:
        raise UserError(f"알 수 없는 동작: {action}")
    ctx.update("batches", b, {"status": new, **extra}, entity="batch", batch_id=batch_id, reason=reason, action=action)
    return {"id": batch_id, "status": new}


@command
def add_branch(ctx: Ctx, batch_id, name, kind="research", condition_diff="", note=""):
    ctx.get("batches", batch_id, "배치")
    name = _s(name)
    if not name:
        raise UserError("가지 이름을 입력하세요.")
    if kind not in ("production", "research", "exception"):
        raise UserError("가지 종류는 생산/연구/예외 중 하나입니다.")
    order = ctx.q1("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM branches WHERE batch_id=?", (batch_id,))["n"]
    row = {"batch_id": batch_id, "name": name, "kind": kind, "condition_diff": _s(condition_diff),
           "note": _s(note), "sort_order": order, "created_at": ctx.ts}
    bid = ctx.insert("branches", row)
    ctx.audit("branch", bid, "create", after=row, batch_id=batch_id)
    return {"id": bid}


@command
def update_branch(ctx: Ctx, branch_id, version=None, **fields):
    br = ctx.get("branches", branch_id, "가지")
    ctx.check_version(br, version)
    ch = {k: _s(fields[k]) for k in ("name", "condition_diff", "note") if k in fields}
    if "status" in fields:
        if fields["status"] not in ("active", "done", "paused", "dropped"):
            raise UserError("가지 상태 값이 올바르지 않습니다.")
        ch["status"] = fields["status"]
    if "kind" in fields:
        ch["kind"] = fields["kind"]
    if ch.get("name") == "":
        raise UserError("가지 이름은 비울 수 없습니다.")
    ctx.update("branches", br, ch, entity="branch", batch_id=br["batch_id"], reason=_s(fields.get("reason")))
    return {"id": branch_id}


# ---------------------------------------------------------------------------
# 물질 단위
# ---------------------------------------------------------------------------
def _material(ctx, mid):
    return ctx.get("materials", mid, "물질")


def _is_product(ctx, mid) -> bool:
    return bool(ctx.q1("SELECT id FROM products WHERE material_id=? AND status='active'", (mid,)))


def _new_material(ctx, step, spec: dict, branch_id=None) -> int:
    label = _s(spec.get("label"))
    if not label:
        raise UserError("산출 물질 이름을 입력하세요.")
    qty, kind = _qty_pair(spec.get("qty_g"), spec.get("qty_kind"))
    row = {"batch_id": step["batch_id"], "branch_id": branch_id or spec.get("branch_id") or step["branch_id"],
           "label": label, "form": _s(spec.get("form")), "container": _s(spec.get("container")),
           "mass_basis": _basis(spec.get("mass_basis")), "qty_g": qty, "qty_kind": kind,
           "tag": _s(spec.get("tag")), "note": _s(spec.get("note")), "created_step_id": step["id"],
           "created_at": ctx.ts}
    br = ctx.get("branches", row["branch_id"], "가지")
    if br["batch_id"] != step["batch_id"]:
        raise UserError("산출 물질은 같은 배치의 가지에만 만들 수 있습니다.")
    mid = ctx.insert("materials", row)
    ctx.insert("step_io", {"step_id": step["id"], "material_id": mid, "role": "out", "qty_g": qty,
                           "qty_kind": kind, "created_at": ctx.ts})
    ctx.audit("material", mid, "create", after=row, batch_id=step["batch_id"])
    return mid


@command
def update_material(ctx: Ctx, material_id, version=None, **fields):
    """라벨·메모·태그·상태·실측 질량 입력."""
    m = _material(ctx, material_id)
    ctx.check_version(m, version)
    ch = {}
    for k in ("label", "form", "container", "tag", "note"):
        if k in fields:
            ch[k] = _s(fields[k])
    if "mass_basis" in fields:
        ch["mass_basis"] = _basis(fields["mass_basis"])
    if "qty_g" in fields or "qty_kind" in fields:
        q, k = _qty_pair(fields.get("qty_g", m["qty_g"]), fields.get("qty_kind", m["qty_kind"]))
        ch["qty_g"], ch["qty_kind"] = q, k
    if ch.get("label") == "":
        raise UserError("물질 이름은 비울 수 없습니다.")
    ctx.update("materials", m, ch, entity="material", batch_id=m["batch_id"], reason=_s(fields.get("reason")))
    return {"id": material_id}


@command
def move_materials(ctx: Ctx, material_ids, to_branch_id=None, new_branch=None, reason=""):
    """이미 나뉜 물질을 다른 가지로 옮긴다. 새 물질·새 소분을 만들지 않는다."""
    if not material_ids:
        raise UserError("옮길 물질을 선택하세요.")
    mats = [_material(ctx, i) for i in material_ids]
    batch_id = mats[0]["batch_id"]
    if any(m["batch_id"] != batch_id for m in mats):
        raise UserError("같은 배치의 물질만 함께 옮길 수 있습니다.")
    if new_branch:
        to_branch_id = _add_branch_inline(ctx, batch_id, new_branch)
    if not to_branch_id:
        raise UserError("옮길 가지를 선택하세요.")
    br = ctx.get("branches", to_branch_id, "가지")
    if br["batch_id"] != batch_id:
        raise UserError("다른 배치의 가지로는 옮길 수 없습니다.")
    moved = 0
    for m in mats:
        if m["status"] == "voided":
            raise UserError(f"{m['label']}은(는) 취소된 물질입니다.")
        if m["branch_id"] == to_branch_id:
            continue
        ctx.insert("material_moves", {"material_id": m["id"], "from_branch_id": m["branch_id"],
                                      "to_branch_id": to_branch_id, "reason": _s(reason), "op_id": ctx.op_id,
                                      "at": ctx.ts})
        ctx.x("UPDATE materials SET branch_id=?, version=version+1 WHERE id=?", (to_branch_id, m["id"]))
        ctx.audit("material", m["id"], "move", before={"branch_id": m["branch_id"]},
                  after={"branch_id": to_branch_id}, batch_id=batch_id, reason=reason)
        moved += 1
    return {"moved": moved, "to_branch_id": to_branch_id}


def _add_branch_inline(ctx, batch_id, spec):
    name = _s(spec.get("name"))
    if not name:
        raise UserError("새 가지 이름을 입력하세요.")
    kind = spec.get("kind") or "exception"
    order = ctx.q1("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM branches WHERE batch_id=?", (batch_id,))["n"]
    row = {"batch_id": batch_id, "name": name, "kind": kind, "condition_diff": _s(spec.get("condition_diff")),
           "note": _s(spec.get("note")), "sort_order": order, "created_at": ctx.ts}
    bid = ctx.insert("branches", row)
    ctx.audit("branch", bid, "create", after=row, batch_id=batch_id)
    return bid


# ---------------------------------------------------------------------------
# 공정
# ---------------------------------------------------------------------------
STEP_TEXT_FIELDS = ("name", "planned_conditions", "operator", "equipment", "actual_conditions", "observations")


def _step_row_from(fields: dict) -> dict:
    row = {}
    for k in STEP_TEXT_FIELDS:
        if k in fields:
            row[k] = _s(fields[k])
    for k in ("scheduled_date", "actual_start", "actual_end"):
        if k in fields:
            row[k] = _opt(fields[k])  # 비워두면 미기록. 현재 시각으로 채우지 않는다.
    if "expected_hours" in fields:
        row["expected_hours"] = _num(fields["expected_hours"], "예상 소요시간")
    return row


def _event(ctx, step_id, event, at=None, note=""):
    ctx.insert("step_events", {"step_id": step_id, "event": event, "at": _opt(at), "note": _s(note),
                               "recorded_at": ctx.ts})


def _apply_inputs(ctx: Ctx, step: dict, inputs: list[dict], after_state: dict | None = None):
    """투입 연결. role=in(전량/일부 소비), through(제자리 처리)."""
    seen = set()
    for spec in inputs or []:
        mid = int(spec["material_id"])
        if mid in seen:
            raise UserError("같은 물질을 두 번 선택했습니다.")
        seen.add(mid)
        m = _material(ctx, mid)
        if m["batch_id"] != step["batch_id"]:
            raise UserError(f"{m['label']}은(는) 다른 배치의 물질입니다. 제품 재처리는 '제품 사용 → 재처리'로 기록하세요.")
        if m["status"] != "active":
            raise UserError(f"{m['label']}은(는) 이미 {('다른 공정에 전량 투입' if m['status']=='consumed' else '취소')}된 물질입니다.")
        if _is_product(ctx, mid):
            raise UserError(f"{m['label']}은(는) 제품 재고로 등록되어 있습니다. 제품 화면의 '사용 기록'으로 사용하세요.")
        if ctx.q1("SELECT id FROM step_io WHERE step_id=? AND material_id=?", (step["id"], mid)):
            raise UserError(f"{m['label']}은(는) 이미 이 공정에 연결되어 있습니다.")
        role = spec.get("role") or "in"
        if role not in ("in", "through"):
            raise UserError("투입 방식은 '투입' 또는 '제자리 처리'입니다.")
        io = {"step_id": step["id"], "material_id": mid, "role": role, "created_at": ctx.ts,
              "prev_qty_g": m["qty_g"], "prev_qty_kind": m["qty_kind"], "prev_status": m["status"],
              "prev_form": m["form"], "prev_basis": m["mass_basis"], "note": _s(spec.get("note"))}
        if role == "in":
            take = _num(spec.get("qty_g"), f"{m['label']} 사용량")
            full = bool(spec.get("full_use", take is None))
            if full:
                io.update(full_use=1, qty_g=m["qty_g"] if take is None else take,
                          qty_kind=m["qty_kind"] if take is None else _kind(spec.get("qty_kind"), "measured"))
                ctx.x("UPDATE materials SET status='consumed', version=version+1 WHERE id=?", (mid,))
            else:
                if take is None:
                    raise UserError(f"{m['label']}에서 일부만 사용하려면 사용량(g)을 입력하세요.")
                io.update(full_use=0, qty_g=take, qty_kind=_kind(spec.get("qty_kind"), "measured"))
                new_q, new_k, new_status = _subtract(m, take)
                ctx.x("UPDATE materials SET qty_g=?, qty_kind=?, status=?, version=version+1 WHERE id=?",
                      (new_q, new_k, new_status, mid))
        else:
            io.update(full_use=0, qty_g=None, qty_kind="unknown")
            if after_state:
                ch = {}
                if _s(after_state.get("form")):
                    ch["form"] = _s(after_state["form"])
                if after_state.get("mass_basis"):
                    ch["mass_basis"] = _basis(after_state["mass_basis"])
                if after_state.get("qty_reset"):
                    ch["qty_g"], ch["qty_kind"] = None, "unknown"
                if ch:
                    sets = ",".join(f"{k}=?" for k in ch)
                    ctx.x(f"UPDATE materials SET {sets}, version=version+1 WHERE id=?", (*ch.values(), mid))
        ctx.insert("step_io", io)
        ctx.audit("step_io", step["id"], "link_input",
                  after={"material_id": mid, "label": m["label"], "role": io["role"], "qty_g": io["qty_g"],
                         "full_use": io["full_use"]}, batch_id=step["batch_id"])


def _subtract(m: dict, take: float):
    """일부 사용 후 잔량. 확정 수량이면 초과를 막고, 추정치는 추정으로 남기고, 미측정이면 계산하지 않는다."""
    if m["qty_g"] is None:
        return None, "unknown", "active"
    if m["qty_kind"] in FIRM_KINDS and take > m["qty_g"] + EPS:
        raise UserError(f"{m['label']}의 알려진 양({fmt_g(m['qty_g'])})보다 많이 사용할 수 없습니다 "
                        f"(요청 {fmt_g(take)}). 실측 질량이 다르면 먼저 물질의 질량을 정정하세요.")
    rem = round(max(m["qty_g"] - take, 0.0), 6)
    kind = "calculated" if m["qty_kind"] in FIRM_KINDS else m["qty_kind"]
    status = "consumed" if (kind == "calculated" and rem <= EPS) else "active"
    return rem, kind, status


def _apply_outputs(ctx: Ctx, step: dict, outputs: list[dict]):
    ids = []
    for spec in outputs or []:
        spec = dict(spec)
        if step["kind"] == "merge" and _num(spec.get("qty_g")) is None:
            calc = _merge_sum(ctx, step["id"], _basis(spec.get("mass_basis")))
            if calc is not None:
                spec["qty_g"], spec["qty_kind"] = calc, "calculated"
        ids.append(_new_material(ctx, step, spec))
    if step["kind"] == "merge":
        _check_merge(ctx, step)
    return ids


def _merge_sum(ctx, step_id, basis):
    ins = ctx.q("""SELECT io.qty_g, io.qty_kind, m.mass_basis FROM step_io io JOIN materials m ON m.id=io.material_id
                   WHERE io.step_id=? AND io.role='in'""", (step_id,))
    if not ins:
        return None
    if any(i["qty_g"] is None or i["qty_kind"] not in FIRM_KINDS or i["mass_basis"] != basis for i in ins):
        return None
    return round(sum(i["qty_g"] for i in ins), 6)


def _check_merge(ctx, step):
    """단순 병합: 같은 질량 기준이고 모든 투입량이 확정이면 산출이 투입 합을 넘을 수 없다."""
    outs = ctx.q("""SELECT io.qty_g, io.qty_kind, m.mass_basis, m.label FROM step_io io JOIN materials m ON m.id=io.material_id
                    WHERE io.step_id=? AND io.role='out'""", (step["id"],))
    for o in outs:
        if o["qty_g"] is None:
            continue
        s = _merge_sum(ctx, step["id"], o["mass_basis"])
        if s is not None and o["qty_g"] > s + 1e-3:
            raise UserError(f"병합 산출 {o['label']}({fmt_g(o['qty_g'])})이 같은 기준({BASIS_KO[o['mass_basis']]}) "
                            f"투입 합계({fmt_g(s)})보다 많습니다. 실측값을 확인하세요.")


def _recalc_merge_outputs(ctx, step):
    if step["kind"] != "merge":
        return
    outs = ctx.q("""SELECT io.id, io.material_id, m.mass_basis FROM step_io io JOIN materials m ON m.id=io.material_id
                    WHERE io.step_id=? AND io.role='out' AND io.qty_kind='calculated'""", (step["id"],))
    for o in outs:
        s = _merge_sum(ctx, step["id"], o["mass_basis"])
        k = "calculated" if s is not None else "unknown"
        ctx.x("UPDATE step_io SET qty_g=?, qty_kind=? WHERE id=?", (s, k, o["id"]))
        m = ctx.q1("SELECT * FROM materials WHERE id=?", (o["material_id"],))
        if m["qty_kind"] in ("calculated", "unknown"):
            ctx.x("UPDATE materials SET qty_g=?, qty_kind=?, version=version+1 WHERE id=?", (s, k, m["id"]))


@command
def record_step(ctx: Ctx, batch_id, branch_id, name, status="done", kind="process", inputs=None, outputs=None,
                after_state=None, **fields):
    """공정 기록(계획 / 시작 / 바로 완료). 짧은 작업은 status='done'으로 한 번에 기록."""
    b = ctx.get("batches", batch_id, "배치")
    br = ctx.get("branches", branch_id, "가지")
    if br["batch_id"] != b["id"]:
        raise UserError("가지가 이 배치에 속하지 않습니다.")
    if kind not in ("process", "merge"):
        raise UserError("일반 공정은 process/merge 만 이 경로로 기록합니다.")
    if status not in ("planned", "in_progress", "done"):
        raise UserError("상태는 계획/진행 중/완료 중 하나입니다.")
    name = _s(name)
    if not name:
        raise UserError("공정명을 입력하세요.")
    if status == "planned" and (inputs or outputs):
        raise UserError("계획 단계에서는 실제 투입·산출을 연결하지 않습니다. 시작하거나 완료할 때 선택하세요.")
    if kind == "merge" and len(inputs or []) < 2:
        raise UserError("합치기는 투입 물질을 2개 이상 선택하세요.")
    row = {"batch_id": batch_id, "branch_id": branch_id, "kind": kind, "name": name, "status": status,
           "created_at": ctx.ts, "updated_at": ctx.ts, **_step_row_from(fields)}
    sid = ctx.insert("steps", row)
    step = ctx.get("steps", sid)
    ctx.audit("step", sid, "create", after=row, batch_id=batch_id)
    if status in ("in_progress", "done"):
        _event(ctx, sid, "start", row.get("actual_start"))
    _apply_inputs(ctx, step, inputs or [], after_state)
    out_ids = _apply_outputs(ctx, step, outputs or [])
    if status == "done":
        _event(ctx, sid, "complete", row.get("actual_end"))
    return {"id": sid, "output_ids": out_ids}


@command
def start_step(ctx: Ctx, step_id, version=None, actual_start=None, inputs=None, after_state=None, **fields):
    st = ctx.get("steps", step_id, "공정")
    ctx.check_version(st, version)
    if st["status"] != "planned":
        raise UserError(f"이 공정은 이미 '{STATUS_KO[st['status']]}' 상태입니다.")
    ch = {"status": "in_progress", "actual_start": _opt(actual_start), **_step_row_from(fields)}
    st = ctx.update("steps", st, ch, entity="step", batch_id=st["batch_id"], action="start")
    _event(ctx, step_id, "start", actual_start)
    _apply_inputs(ctx, st, inputs or [], after_state)
    return {"id": step_id}


@command
def pause_step(ctx: Ctx, step_id, version=None, at=None, note=""):
    st = ctx.get("steps", step_id, "공정")
    ctx.check_version(st, version)
    if st["status"] != "in_progress":
        raise UserError("진행 중인 공정만 보류할 수 있습니다.")
    ctx.update("steps", st, {"status": "paused"}, entity="step", batch_id=st["batch_id"], action="pause", reason=note)
    _event(ctx, step_id, "pause", at, note)
    return {"id": step_id}


@command
def resume_step(ctx: Ctx, step_id, version=None, at=None, note=""):
    st = ctx.get("steps", step_id, "공정")
    ctx.check_version(st, version)
    if st["status"] != "paused":
        raise UserError("보류된 공정만 재개할 수 있습니다.")
    ctx.update("steps", st, {"status": "in_progress"}, entity="step", batch_id=st["batch_id"], action="resume",
               reason=note)
    _event(ctx, step_id, "resume", at, note)
    return {"id": step_id}


@command
def complete_step(ctx: Ctx, step_id, version=None, actual_end=None, inputs=None, outputs=None, after_state=None,
                  **fields):
    """완료 기록. 계획 상태에서 바로 완료해도 된다(시작 시각은 미기록 가능)."""
    st = ctx.get("steps", step_id, "공정")
    ctx.check_version(st, version)
    if st["status"] in ("done", "cancelled"):
        raise UserError(f"이 공정은 이미 '{STATUS_KO[st['status']]}' 상태입니다. 내용 변경은 '수정'을 사용하세요.")
    if st["status"] == "planned":
        _event(ctx, step_id, "start", fields.get("actual_start"))
    ch = {"status": "done", "actual_end": _opt(actual_end), **_step_row_from(fields)}
    st = ctx.update("steps", st, ch, entity="step", batch_id=st["batch_id"], action="complete")
    _apply_inputs(ctx, st, inputs or [], after_state)
    out_ids = _apply_outputs(ctx, st, outputs or [])
    _event(ctx, step_id, "complete", actual_end)
    return {"id": step_id, "output_ids": out_ids}


@command
def update_step(ctx: Ctx, step_id, version=None, reason="", **fields):
    """계획·진행·완료 공정 모두 수정 가능. 공정명·조건·메모·장비·작업자·실제 시각·예정일."""
    st = ctx.get("steps", step_id, "공정")
    ctx.check_version(st, version)
    ch = _step_row_from(fields)
    if "name" in ch and not ch["name"]:
        raise UserError("공정명은 비울 수 없습니다.")
    if "status" in fields and fields["status"] != st["status"]:
        new = fields["status"]
        if new not in ("planned", "in_progress", "paused", "done"):
            raise UserError("상태 값이 올바르지 않습니다.")
        if new == "planned" and ctx.q1("SELECT id FROM step_io WHERE step_id=?", (step_id,)):
            raise UserError("투입·산출이 연결된 공정은 '계획'으로 되돌릴 수 없습니다. 먼저 연결을 정정하세요.")
        ch["status"] = new
        _event(ctx, step_id, "reopen" if st["status"] == "done" else "start", None, f"상태 수정: {reason}")
    if "branch_id" in fields and int(fields["branch_id"]) != st["branch_id"]:
        br = ctx.get("branches", fields["branch_id"], "가지")
        if br["batch_id"] != st["batch_id"]:
            raise UserError("다른 배치의 가지로는 옮길 수 없습니다.")
        ch["branch_id"] = br["id"]
    ctx.update("steps", st, ch, entity="step", batch_id=st["batch_id"], reason=reason)
    return {"id": step_id}


def _downstream_blockers(ctx, material_id, exclude_step_id) -> list[str]:
    out = []
    for r in ctx.q("""SELECT s.id, s.name, s.status, io.role FROM step_io io JOIN steps s ON s.id=io.step_id
                      WHERE io.material_id=? AND io.step_id<>? AND io.role IN ('in','through')""",
                   (material_id, exclude_step_id)):
        out.append(f"후속 공정 #{r['id']} '{r['name']}'에 {'투입' if r['role']=='in' else '처리 대상'}으로 연결됨")
    p = ctx.q1("SELECT code FROM products WHERE material_id=? AND status='active'", (material_id,))
    if p:
        out.append(f"제품 재고 {p['code']}로 등록됨")
    for q in ctx.q("SELECT test, status FROM qc_items WHERE material_id=? AND status IN ('requested','received')",
                   (material_id,)):
        out.append(f"QC {q['test']} ({'의뢰됨' if q['status']=='requested' else '결과 있음'})")
    return out


def _remove_io(ctx: Ctx, step: dict, io: dict, reason: str):
    m = _material(ctx, io["material_id"])
    if io["role"] == "out":
        blockers = _downstream_blockers(ctx, m["id"], step["id"])
        if blockers:
            raise UserError(
                f"산출 물질 '{m['label']}'은(는) 이미 다음 기록과 연결되어 있어 제거할 수 없습니다. "
                "먼저 아래 연결을 정정하거나 취소하세요. (조건·메모 수정은 그대로 가능합니다)",
                code="linked", details=blockers)
        ctx.x("UPDATE materials SET status='voided', version=version+1 WHERE id=?", (m["id"],))
        ctx.x("DELETE FROM qc_items WHERE material_id=? AND status='planned'", (m["id"],))
    elif io["role"] == "in":
        if io["full_use"]:
            later = [f"후속 공정 #{r['id']} '{r['name']}'" for r in ctx.q(
                """SELECT s.id, s.name FROM step_io io JOIN steps s ON s.id=io.step_id
                   WHERE io.material_id=? AND io.id>? AND io.role IN ('in','through')""", (m["id"], io["id"]))]
            if later:
                raise UserError(f"'{m['label']}'은(는) 다른 공정에도 연결되어 있어 되돌릴 수 없습니다.",
                                code="linked", details=later)
            ctx.x("UPDATE materials SET status=?, version=version+1 WHERE id=?",
                  (io["prev_status"] or "active", m["id"]))
        else:
            if m["qty_g"] is not None and io["qty_g"] is not None:
                new_q = round(m["qty_g"] + io["qty_g"], 6)
                ctx.x("UPDATE materials SET qty_g=?, status='active', version=version+1 WHERE id=?", (new_q, m["id"]))
            elif m["status"] == "consumed":
                ctx.x("UPDATE materials SET status='active', version=version+1 WHERE id=?", (m["id"],))
    else:  # through: 이 공정이 바꾼 상태를 되돌림(이후 다른 공정이 없을 때만)
        later = ctx.q1("""SELECT io.id FROM step_io io WHERE io.material_id=? AND io.id>?""", (m["id"], io["id"]))
        if not later:
            ctx.x("UPDATE materials SET form=?, mass_basis=?, qty_g=?, qty_kind=?, version=version+1 WHERE id=?",
                  (io["prev_form"], io["prev_basis"], io["prev_qty_g"], io["prev_qty_kind"], m["id"]))
    ctx.x("DELETE FROM step_io WHERE id=?", (io["id"],))
    ctx.audit("step_io", step["id"], "unlink",
              before={"material_id": m["id"], "label": m["label"], "role": io["role"], "qty_g": io["qty_g"],
                      "full_use": io["full_use"]}, batch_id=step["batch_id"], reason=reason)


@command
def correct_step_io(ctx: Ctx, step_id, version=None, remove_io_ids=None, add_inputs=None, add_outputs=None,
                    void_raw_ids=None, add_raw=None, after_state=None, reason=""):
    """투입·산출 연결 정정. 전체가 한 트랜잭션: 하나라도 실패하면 아무것도 바뀌지 않는다."""
    st = ctx.get("steps", step_id, "공정")
    ctx.check_version(st, version)
    if not _s(reason):
        raise UserError("정정 사유를 입력하세요. (변경 이력에 남습니다)")
    # 산출 먼저 제거(후속 연결 확인) → 투입 제거
    ios = [ctx.get("step_io", i, "연결") for i in (remove_io_ids or [])]
    for io in ios:
        if io["step_id"] != step_id:
            raise UserError("다른 공정의 연결입니다.")
    for io in sorted(ios, key=lambda r: 0 if r["role"] == "out" else 1):
        _remove_io(ctx, st, io, reason)
    for lid in void_raw_ids or []:
        led = ctx.get("raw_ledger", lid, "투입 기록")
        if led["step_id"] != step_id:
            raise UserError("다른 공정의 원료 투입입니다.")
        ctx.x("UPDATE raw_ledger SET voided_at=?, void_reason=? WHERE id=?", (ctx.ts, reason, lid))
        ctx.audit("raw_ledger", lid, "void", before={"delta_g": led["delta_g"]}, batch_id=st["batch_id"], reason=reason)
    for line in add_raw or []:
        _consume_raw(ctx, st, line)
    _apply_inputs(ctx, st, add_inputs or [], after_state)
    _recalc_merge_outputs(ctx, st)
    _apply_outputs(ctx, st, add_outputs or [])
    ctx.x("UPDATE steps SET version=version+1, updated_at=? WHERE id=?", (ctx.ts, step_id))
    return {"id": step_id}


@command
def cancel_step(ctx: Ctx, step_id, version=None, reason=""):
    """기록 취소(잘못 입력한 공정). 실제 물질 반환과는 다르다: 이 공정이 없었던 것으로 되돌린다."""
    st = ctx.get("steps", step_id, "공정")
    ctx.check_version(st, version)
    if st["status"] == "cancelled":
        return {"id": step_id}
    if not _s(reason):
        raise UserError("취소 사유를 입력하세요.")
    ios = ctx.q("SELECT * FROM step_io WHERE step_id=? ORDER BY CASE role WHEN 'out' THEN 0 ELSE 1 END, id DESC",
                (step_id,))
    for io in ios:
        _remove_io(ctx, st, io, reason)
    for led in ctx.q("SELECT * FROM raw_ledger WHERE step_id=? AND voided_at IS NULL AND kind='consume'", (step_id,)):
        ctx.x("UPDATE raw_ledger SET voided_at=?, void_reason=? WHERE id=?", (ctx.ts, reason, led["id"]))
    ctx.update("steps", st, {"status": "cancelled"}, entity="step", batch_id=st["batch_id"], action="cancel",
               reason=reason)
    _event(ctx, step_id, "cancel", None, reason)
    return {"id": step_id}


# ---------------------------------------------------------------------------
# 원료 투입 / 소분 / 재처리
# ---------------------------------------------------------------------------
def _consume_raw(ctx, step, line):
    lot = ctx.get("raw_lots", line["lot_id"], "원료 Lot")
    if lot["deleted_at"]:
        raise UserError(f"Lot {lot['lot_code']}은(는) 휴지통에 있습니다.")
    q = _num(line.get("qty_g"), "원료 투입량", allow_none=False, positive=True)
    rem = lot_remaining(ctx, lot["id"])
    if q > rem + EPS:
        raise UserError(f"Lot {lot['lot_code']} 잔량({fmt_g(rem)})보다 많이 투입할 수 없습니다 (요청 {fmt_g(q)}). "
                        "실측 잔량이 다르면 원료 화면에서 잔량을 먼저 정정하세요.")
    lid = ctx.insert("raw_ledger", {"lot_id": lot["id"], "kind": "consume", "delta_g": -q, "step_id": step["id"],
                                    "batch_id": step["batch_id"], "at": _opt(line.get("at")) or step.get("actual_start"),
                                    "note": _s(line.get("note")), "created_at": ctx.ts})
    ctx.audit("raw_ledger", lid, "consume", after={"lot": lot["lot_code"], "qty_g": q}, batch_id=step["batch_id"])
    return lid


@command
def charge_raw(ctx: Ctx, batch_id, branch_id, raw_lines, output=None, name="원료 투입", status="done", **fields):
    """원료 실제 투입 → 산출 물질(예: 전구체 슬러리). 원료 재고는 여기서만 차감된다."""
    b = ctx.get("batches", batch_id, "배치")
    br = ctx.get("branches", branch_id, "가지")
    if br["batch_id"] != b["id"]:
        raise UserError("가지가 이 배치에 속하지 않습니다.")
    if not raw_lines:
        raise UserError("투입할 원료 Lot을 선택하세요.")
    if status not in ("in_progress", "done"):
        raise UserError("원료 투입은 진행 중 또는 완료로 기록합니다.")
    row = {"batch_id": batch_id, "branch_id": branch_id, "kind": "charge", "name": _s(name) or "원료 투입",
           "status": status, "created_at": ctx.ts, "updated_at": ctx.ts, **_step_row_from(fields)}
    sid = ctx.insert("steps", row)
    step = ctx.get("steps", sid)
    ctx.audit("step", sid, "create", after=row, batch_id=batch_id)
    _event(ctx, sid, "start", row.get("actual_start"))
    seen = set()
    for line in raw_lines:
        if int(line["lot_id"]) in seen:
            raise UserError("같은 Lot을 두 번 선택했습니다. 양을 합쳐 한 줄로 입력하세요.")
        seen.add(int(line["lot_id"]))
        _consume_raw(ctx, step, line)
    out_ids = []
    if output:
        out_ids = _apply_outputs(ctx, step, [output])
    if status == "done":
        _event(ctx, sid, "complete", row.get("actual_end"))
    return {"id": sid, "output_ids": out_ids}


def preview_split(m: dict, count, per_qty_g=None, quantities=None) -> dict:
    """저장 없이 미리보기. 31 × 50 g → 총 1,550 g, 잔량 계산."""
    if quantities:
        qs = [_num(q, "용기별 양", allow_none=False, positive=True) for q in quantities]
        count = len(qs)
    else:
        count = int(_num(count, "용기 수", allow_none=False, positive=True))
        if count > 500:
            raise UserError("용기 수가 너무 많습니다(최대 500).")
        per = _num(per_qty_g, "용기당 양", allow_none=False, positive=True)
        qs = [per] * count
    total = round(sum(qs), 6)
    res = {"count": count, "quantities": qs, "total_g": total, "source_qty_g": m["qty_g"],
           "source_qty_kind": m["qty_kind"], "remaining_g": None, "remaining_kind": "unknown", "error": None,
           "note": ""}
    if m["qty_g"] is None:
        res["note"] = "원본 전체 질량이 미측정이라 잔량은 계산하지 않습니다."
    else:
        if m["qty_kind"] in FIRM_KINDS and total > m["qty_g"] + EPS:
            res["error"] = f"소분 합계 {fmt_g(total)}가 알려진 양 {fmt_g(m['qty_g'])}보다 많습니다."
        res["remaining_g"] = round(max(m["qty_g"] - total, 0), 6)
        res["remaining_kind"] = "calculated" if m["qty_kind"] in FIRM_KINDS else m["qty_kind"]
        if m["qty_kind"] not in FIRM_KINDS:
            res["note"] = f"원본 질량이 {KIND_KO[m['qty_kind']]}값이라 잔량도 {KIND_KO[m['qty_kind']]}값입니다(확정 재고 아님)."
    return res


@command
def split_material(ctx: Ctx, source_material_id, count=None, per_qty_g=None, quantities=None, label_prefix="도가니",
                   start_index=1, container="", target_branch_id=None, qty_kind="measured", name=None,
                   use_all=False, **fields):
    """같은 양으로 소분: 한 번의 저장으로 공정(완료)·산출 물질 N개·잔량 계산을 모두 기록."""
    src = _material(ctx, source_material_id)
    if src["status"] != "active":
        raise UserError(f"{src['label']}은(는) 사용 가능한 상태가 아닙니다.")
    if _is_product(ctx, src["id"]):
        raise UserError("제품 재고는 제품 화면의 '사용 기록'으로 나눠 쓰세요.")
    pv = preview_split(src, count, per_qty_g, quantities)
    if pv["error"]:
        raise UserError(pv["error"] + " 실측 질량이 다르면 먼저 원본 질량을 정정하세요.")
    branch_id = int(target_branch_id or src["branch_id"])
    prefix = _s(label_prefix) or "용기"
    start = int(start_index or 1)
    n = pv["count"]
    row = {"batch_id": src["batch_id"], "branch_id": branch_id, "kind": "split",
           "name": _s(name) or f"소분 {n}개 × {fmt_g(pv['quantities'][0]) if len(set(pv['quantities']))==1 else '개별'}",
           "status": "done", "created_at": ctx.ts, "updated_at": ctx.ts, **_step_row_from(fields)}
    sid = ctx.insert("steps", row)
    step = ctx.get("steps", sid)
    ctx.audit("step", sid, "create", after=row, batch_id=src["batch_id"])
    _event(ctx, sid, "start", row.get("actual_start"))
    full = bool(use_all) or (pv["remaining_kind"] == "calculated" and (pv["remaining_g"] or 0) <= EPS)
    _apply_inputs(ctx, step, [{"material_id": src["id"], "role": "in", "qty_g": pv["total_g"],
                               "full_use": full, "qty_kind": qty_kind}])
    width = max(2, len(str(start + n - 1)))
    outs = []
    for i, q in enumerate(pv["quantities"]):
        outs.append({"label": f"{prefix} {str(start + i).zfill(width)}", "form": src["form"],
                     "container": _s(container) or prefix, "mass_basis": src["mass_basis"], "qty_g": q,
                     "qty_kind": qty_kind, "tag": src["tag"], "branch_id": branch_id})
    ids = _apply_outputs(ctx, step, outs)
    _event(ctx, sid, "complete", row.get("actual_end"))
    after = _material(ctx, src["id"])
    return {"id": sid, "output_ids": ids, "total_g": pv["total_g"], "remaining_g": after["qty_g"],
            "remaining_kind": after["qty_kind"], "source_status": after["status"]}


# ---------------------------------------------------------------------------
# 제품
# ---------------------------------------------------------------------------
def product_remaining(ctx_or_db, product_id):
    p = ctx_or_db.q1("SELECT * FROM products WHERE id=?", (product_id,))
    if p["initial_qty_g"] is None:
        return None
    used = ctx_or_db.q1("SELECT COALESCE(SUM(qty_g),0) AS s FROM product_usages WHERE product_id=? AND voided_at IS NULL",
                        (product_id,))["s"]
    return round(p["initial_qty_g"] - used, 6)


@command
def register_product(ctx: Ctx, material_id, code, name="", registered_date=None, qty_g=None, qty_kind="measured",
                     note="", extra_tests=None, required_tests=None):
    m = _material(ctx, material_id)
    if m["status"] != "active":
        raise UserError(f"{m['label']}은(는) 이미 다른 공정에 투입되었거나 취소되어 제품으로 등록할 수 없습니다.")
    exist = ctx.q1("SELECT code FROM products WHERE material_id=?", (material_id,))
    if exist:
        raise UserError(f"이 물질은 이미 제품 {exist['code']}로 등록되어 있습니다(이중 입고 방지).")
    code = _s(code)
    if not code:
        raise UserError("제품 코드를 입력하세요.")
    if ctx.q1("SELECT id FROM products WHERE code=?", (code,)):
        raise UserError(f"제품 코드 '{code}'가 이미 있습니다.")
    if qty_g in (None, "") and m["qty_g"] is not None and m["qty_kind"] in FIRM_KINDS:
        q, k = m["qty_g"], m["qty_kind"]
    else:
        q, k = _qty_pair(qty_g, qty_kind)
    row = {"material_id": material_id, "code": code, "name": _s(name) or m["label"],
           "registered_date": _opt(registered_date), "initial_qty_g": q, "initial_qty_kind": k, "note": _s(note),
           "created_at": ctx.ts}
    pid = ctx.insert("products", row)
    ctx.audit("product", pid, "create", after=row, batch_id=m["batch_id"])
    tests = list(required_tests if required_tests is not None else REQUIRED_PRODUCT_QC)
    for t in tests:
        _add_qc(ctx, m, t, required=True, product_id=pid)
    for t in extra_tests or []:
        _add_qc(ctx, m, t, required=False, product_id=pid)
    return {"id": pid}


@command
def update_product(ctx: Ctx, product_id, version=None, **fields):
    p = ctx.get("products", product_id, "제품")
    ctx.check_version(p, version)
    ch = {}
    for k in ("name", "note"):
        if k in fields:
            ch[k] = _s(fields[k])
    if "registered_date" in fields:
        ch["registered_date"] = _opt(fields["registered_date"])
    if "initial_qty_g" in fields:
        q, k = _qty_pair(fields["initial_qty_g"], fields.get("initial_qty_kind", "measured"))
        ch["initial_qty_g"], ch["initial_qty_kind"] = q, k
        used = ctx.q1("SELECT COALESCE(SUM(qty_g),0) s FROM product_usages WHERE product_id=? AND voided_at IS NULL",
                      (product_id,))["s"]
        if q is not None and used > q + EPS:
            raise UserError(f"이미 기록된 사용량 합계({fmt_g(used)})가 새 제품량보다 많습니다. 사용 기록을 먼저 확인하세요.")
    m = _material(ctx, p["material_id"])
    ctx.update("products", p, ch, entity="product", batch_id=m["batch_id"], reason=_s(fields.get("reason")))
    return {"id": product_id}


@command
def use_product(ctx: Ctx, product_id, purpose, qty_g, used_date=None, destination="", note="", reprocess=None):
    """제품 사용: 출하 / QC / 내부 측정 / 연구 실험 / 재처리."""
    p = ctx.get("products", product_id, "제품")
    if purpose not in ("ship", "qc", "internal", "research", "reprocess"):
        raise UserError("사용 용도를 선택하세요.")
    q = _num(qty_g, "사용량", allow_none=False, positive=True)
    rem = product_remaining(ctx, product_id)
    if rem is not None and p["initial_qty_kind"] in FIRM_KINDS and q > rem + EPS:
        raise UserError(f"제품 잔량({fmt_g(rem)})보다 많이 사용할 수 없습니다. 제품량이 실측과 다르면 먼저 제품량을 정정하세요.")
    m = _material(ctx, p["material_id"])
    row = {"product_id": product_id, "purpose": purpose, "qty_g": q, "used_date": _opt(used_date),
           "destination": _s(destination), "note": _s(note), "created_at": ctx.ts}
    reproc_mid = None
    if purpose == "reprocess":
        rp = reprocess or {}
        tb = ctx.get("batches", rp.get("batch_id") or m["batch_id"], "배치")
        tbr = ctx.get("branches", rp.get("branch_id") or m["branch_id"], "가지")
        if tbr["batch_id"] != tb["id"]:
            raise UserError("재처리 가지가 선택한 배치에 속하지 않습니다.")
        srow = {"batch_id": tb["id"], "branch_id": tbr["id"], "kind": "reprocess",
                "name": _s(rp.get("step_name")) or f"재처리 투입 ({p['code']})", "status": "done",
                "actual_start": _opt(used_date), "created_at": ctx.ts, "updated_at": ctx.ts}
        sid = ctx.insert("steps", srow)
        _event(ctx, sid, "start", used_date)
        ctx.insert("step_io", {"step_id": sid, "material_id": m["id"], "role": "in", "qty_g": q,
                               "qty_kind": "measured", "full_use": 0, "prev_status": m["status"],
                               "note": "제품 재고에서 투입", "created_at": ctx.ts})
        reproc_mid = _new_material(ctx, ctx.get("steps", sid), {
            "label": _s(rp.get("label")) or f"{p['code']} 재처리분", "form": m["form"], "mass_basis": m["mass_basis"],
            "qty_g": q, "qty_kind": "measured"}, branch_id=tbr["id"])
        _event(ctx, sid, "complete", used_date)
        row["reprocess_material_id"] = reproc_mid
    uid = ctx.insert("product_usages", row)
    ctx.audit("product_usage", uid, "create", after=row, batch_id=m["batch_id"])
    return {"id": uid, "reprocess_material_id": reproc_mid}


@command
def void_usage(ctx: Ctx, usage_id, reason=""):
    u = ctx.get("product_usages", usage_id, "사용 기록")
    if u["voided_at"]:
        return {"id": usage_id}
    if not _s(reason):
        raise UserError("취소 사유를 입력하세요.")
    p = ctx.get("products", u["product_id"])
    if u["reprocess_material_id"]:
        mid = u["reprocess_material_id"]
        st = ctx.q1("SELECT s.* FROM steps s WHERE s.id=(SELECT created_step_id FROM materials WHERE id=?)", (mid,))
        blockers = _downstream_blockers(ctx, mid, st["id"])
        if blockers:
            raise UserError("재처리분이 이미 다음 공정에 쓰여 사용 기록을 취소할 수 없습니다. 후속 기록을 먼저 정정하세요.",
                            code="linked", details=blockers)
        ctx.x("UPDATE materials SET status='voided', version=version+1 WHERE id=?", (mid,))
        ctx.x("UPDATE steps SET status='cancelled', version=version+1 WHERE id=?", (st["id"],))
        ctx.x("DELETE FROM step_io WHERE step_id=?", (st["id"],))
        _event(ctx, st["id"], "cancel", None, reason)
    ctx.x("UPDATE product_usages SET voided_at=?, void_reason=? WHERE id=?", (ctx.ts, _s(reason), usage_id))
    ctx.audit("product_usage", usage_id, "void", before={"qty_g": u["qty_g"], "purpose": u["purpose"]},
              batch_id=_material(ctx, p["material_id"])["batch_id"], reason=reason)
    return {"id": usage_id}


# ---------------------------------------------------------------------------
# QC
# ---------------------------------------------------------------------------
def _add_qc(ctx, m, test, required=False, product_id=None, **extra):
    test = _s(test)
    if not test:
        raise UserError("분석 항목 이름을 입력하세요.")
    row = {"batch_id": m["batch_id"], "material_id": m["id"], "product_id": product_id, "test": test,
           "required": 1 if required else 0, "internal": 1 if test in INTERNAL_QC else 0,
           "created_at": ctx.ts, "updated_at": ctx.ts, **extra}
    qid = ctx.insert("qc_items", row)
    ctx.audit("qc", qid, "create", after=row, batch_id=m["batch_id"])
    return qid


@command
def add_qc(ctx: Ctx, material_id, test, required=False, product_id=None, note=""):
    """연구 가지·예외 시료 등 자유 분석 항목 추가(PSA 등)."""
    m = _material(ctx, material_id)
    if product_id:
        p = ctx.get("products", product_id, "제품")
        if p["material_id"] != m["id"]:
            raise UserError("제품과 물질이 맞지 않습니다.")
    return {"id": _add_qc(ctx, m, test, required=required, product_id=product_id, note=_s(note))}


QC_DATE_FIELDS = ("scheduled_date", "requested_date", "expected_date", "measured_date", "received_date")


@command
def update_qc(ctx: Ctx, qc_id, version=None, **fields):
    """의뢰·결과·대표성 기록. 측정일·회신일을 모르면 비워 둔다(미정)."""
    q = ctx.get("qc_items", qc_id, "QC 항목")
    ctx.check_version(q, version)
    ch = {}
    for k in QC_DATE_FIELDS:
        if k in fields:
            ch[k] = _opt(fields[k])
    for k in ("result_summary", "evidence_path", "representative_note", "note", "test"):
        if k in fields:
            ch[k] = _s(fields[k])
    if "representative" in fields:
        v = fields["representative"]
        ch["representative"] = None if v in (None, "") else (1 if v in (1, True, "1", "true", "yes") else 0)
    if "required" in fields:
        ch["required"] = 1 if fields["required"] else 0
    if "status" in fields:
        if fields["status"] not in ("planned", "requested", "received", "cancelled"):
            raise UserError("QC 상태 값이 올바르지 않습니다.")
        ch["status"] = fields["status"]
    new = {**q, **ch}
    if new["status"] == "received" and not new["result_summary"] and not new["evidence_path"]:
        raise UserError("결과 수령으로 표시하려면 결과 요약이나 근거 파일 위치를 입력하세요.")
    ctx.update("qc_items", q, ch, entity="qc", batch_id=q["batch_id"], reason=_s(fields.get("reason")))
    return {"id": qc_id}


@command
def adopt_qc_result(ctx: Ctx, product_id, source_qc_id, representative_note=""):
    """이전 산물의 결과를 이 제품의 대표 결과로 사용자가 인정(자동 승계 아님)."""
    p = ctx.get("products", product_id, "제품")
    src = ctx.get("qc_items", source_qc_id, "QC 결과")
    if src["status"] != "received":
        raise UserError("결과가 수령된 항목만 인정할 수 있습니다.")
    if not _s(representative_note):
        raise UserError("이 결과가 최종 제품을 대표한다고 보는 근거를 적어주세요.")
    m = _material(ctx, p["material_id"])
    target = ctx.q1("""SELECT * FROM qc_items WHERE product_id=? AND test=? AND status IN ('planned','requested')
                       ORDER BY required DESC, id LIMIT 1""", (product_id, src["test"]))
    vals = {"status": "received", "result_summary": src["result_summary"], "evidence_path": src["evidence_path"],
            "requested_date": src["requested_date"], "measured_date": src["measured_date"],
            "received_date": src["received_date"], "representative": 1,
            "representative_note": _s(representative_note), "source_qc_id": src["id"]}
    if target:
        ctx.update("qc_items", target, vals, entity="qc", batch_id=m["batch_id"], action="adopt",
                   reason=representative_note)
        return {"id": target["id"]}
    qid = _add_qc(ctx, m, src["test"], required=False, product_id=product_id, **vals)
    return {"id": qid}


def product_qc_state(ctx_or_db, product_id) -> dict:
    items = ctx_or_db.q("SELECT * FROM qc_items WHERE product_id=? AND status<>'cancelled'", (product_id,))
    req = [i for i in items if i["required"]]
    missing = []
    for i in req:
        if i["status"] != "received":
            missing.append(f"{i['test']}: {'결과 대기' if i['status']=='requested' else '미의뢰'}")
        elif i["representative"] != 1:
            missing.append(f"{i['test']}: 최종 제품 대표성 미확인")
    dec = ctx_or_db.q1("""SELECT * FROM qc_decisions WHERE product_id=? AND voided_at IS NULL
                          ORDER BY id DESC LIMIT 1""", (product_id,))
    done = sum(1 for i in req if i["status"] == "received")
    return {"required_total": len(req), "required_received": done, "missing": missing,
            "ready": not missing and len(req) > 0, "decision": dec}


@command
def decide_product(ctx: Ctx, product_id, decision, reason="", decided_date=None):
    """사용자 합불 판정. 앱은 수치로 자동 합격시키지 않는다."""
    ctx.get("products", product_id, "제품")
    if decision not in ("pass", "fail", "hold"):
        raise UserError("판정은 합격/불합격/보류 중 하나입니다.")
    st = product_qc_state(ctx, product_id)
    if decision == "pass" and not st["ready"]:
        raise UserError("필수 QC 결과와 대표성 확인이 모두 끝나야 합격 판정을 할 수 있습니다.",
                        code="qc_incomplete", details=st["missing"] or ["필수 QC 항목이 없습니다."])
    if not _s(reason):
        raise UserError("판정 근거를 입력하세요.")
    for d in ctx.q("SELECT id FROM qc_decisions WHERE product_id=? AND voided_at IS NULL", (product_id,)):
        ctx.x("UPDATE qc_decisions SET voided_at=?, void_reason=? WHERE id=?", (ctx.ts, "새 판정으로 대체", d["id"]))
    did = ctx.insert("qc_decisions", {"product_id": product_id, "decision": decision, "reason": _s(reason),
                                      "decided_date": _opt(decided_date), "created_at": ctx.ts})
    ctx.audit("qc_decision", did, "decide", after={"decision": decision, "reason": reason},
              batch_id=_material(ctx, ctx.get("products", product_id)["material_id"])["batch_id"])
    return {"id": did}


@command
def void_decision(ctx: Ctx, decision_id, reason=""):
    d = ctx.get("qc_decisions", decision_id, "판정")
    if not _s(reason):
        raise UserError("취소 사유를 입력하세요.")
    ctx.x("UPDATE qc_decisions SET voided_at=?, void_reason=? WHERE id=?", (ctx.ts, _s(reason), decision_id))
    ctx.audit("qc_decision", decision_id, "void", before={"decision": d["decision"]}, reason=reason)
    return {"id": decision_id}


# ---------------------------------------------------------------------------
# 초안: 배치|가지|공정|동작 단위로 분리. 실제 기록과 완전히 별개.
# ---------------------------------------------------------------------------
def draft_key(batch_id, branch_id, step_ref, action) -> str:
    return f"b{batch_id or '-'}|br{branch_id or '-'}|s{step_ref or 'new'}|{action}"


def save_draft(db: Database, key, action, payload, batch_id=None, branch_id=None, step_ref=None, title=""):
    if not key or not action:
        raise UserError("초안 키가 없습니다.")
    with db.tx() as c:
        c.execute("""INSERT INTO drafts(draft_key,batch_id,branch_id,step_ref,action,title,payload,updated_at)
                     VALUES(?,?,?,?,?,?,?,?)
                     ON CONFLICT(draft_key) DO UPDATE SET payload=excluded.payload, title=excluded.title,
                       updated_at=excluded.updated_at""",
                  (key, batch_id, branch_id, step_ref, action, title, json.dumps(payload, ensure_ascii=False),
                   now_iso()))
    return {"key": key, "saved_at": now_iso()}


def get_draft(db: Database, key):
    r = db.q1("SELECT * FROM drafts WHERE draft_key=?", (key,))
    if r:
        r["payload"] = json.loads(r["payload"])
    return r


def delete_draft(db: Database, key):
    with db.tx() as c:
        c.execute("DELETE FROM drafts WHERE draft_key=?", (key,))
    return {"key": key}


def list_drafts(db: Database):
    return db.q("SELECT draft_key, batch_id, branch_id, step_ref, action, title, updated_at FROM drafts ORDER BY updated_at DESC")


# ---------------------------------------------------------------------------
# 조회
# ---------------------------------------------------------------------------
def raw_stock(db: Database, include_deleted=False):
    mats = db.q("SELECT * FROM raw_materials ORDER BY id")
    out = []
    for rm in mats:
        lots = db.q(f"""SELECT * FROM raw_lots WHERE raw_material_id=? {'' if include_deleted else 'AND deleted_at IS NULL'}
                        ORDER BY received_date, id""", (rm["id"],))
        for l in lots:
            l["remaining_g"] = lot_remaining(db, l["id"])
            l["ledger"] = db.q("""SELECT l.*, b.code AS batch_code, s.name AS step_name FROM raw_ledger l
                                  LEFT JOIN batches b ON b.id=l.batch_id LEFT JOIN steps s ON s.id=l.step_id
                                  WHERE l.lot_id=? ORDER BY l.id""", (l["id"],))
        live = [l for l in lots if not l["deleted_at"]]
        out.append({**rm, "lots": lots, "total_remaining_g": round(sum(l["remaining_g"] for l in live), 6)})
    return out


def _material_view(db, m):
    p = db.q1("SELECT id, code FROM products WHERE material_id=? AND status='active'", (m["id"],))
    m["product"] = p
    m["used_in"] = db.q("""SELECT s.id, s.name, io.role FROM step_io io JOIN steps s ON s.id=io.step_id
                           WHERE io.material_id=? AND io.role IN ('in','through') ORDER BY s.id""", (m["id"],))
    return m


def batch_detail(db: Database, batch_id):
    b = db.q1("SELECT * FROM batches WHERE id=?", (batch_id,))
    if not b:
        raise UserError("배치를 찾을 수 없습니다.", code="not_found")
    branches = db.q("SELECT * FROM branches WHERE batch_id=? ORDER BY sort_order, id", (batch_id,))
    steps = db.q("SELECT * FROM steps WHERE batch_id=? ORDER BY id", (batch_id,))  # 기록 순서 = 실제 흐름
    for s in steps:
        s["io"] = db.q("""SELECT io.*, m.label, m.branch_id AS material_branch_id, m.status AS material_status
                          FROM step_io io JOIN materials m ON m.id=io.material_id WHERE io.step_id=? ORDER BY io.id""",
                       (s["id"],))
        s["raw"] = db.q("""SELECT l.*, lot.lot_code, rm.name AS raw_name FROM raw_ledger l
                           JOIN raw_lots lot ON lot.id=l.lot_id JOIN raw_materials rm ON rm.id=lot.raw_material_id
                           WHERE l.step_id=? ORDER BY l.id""", (s["id"],))
        s["events"] = db.q("SELECT * FROM step_events WHERE step_id=? ORDER BY id", (s["id"],))
    mats = [_material_view(db, m) for m in db.q("SELECT * FROM materials WHERE batch_id=? ORDER BY id", (batch_id,))]
    products = db.q("""SELECT p.* FROM products p JOIN materials m ON m.id=p.material_id WHERE m.batch_id=?
                       ORDER BY p.id""", (batch_id,))
    for p in products:
        p["remaining_g"] = product_remaining(db, p["id"])
        p["qc_state"] = product_qc_state(db, p["id"])
    qc = db.q("SELECT q.*, m.label AS material_label FROM qc_items q JOIN materials m ON m.id=q.material_id "
              "WHERE q.batch_id=? ORDER BY q.id", (batch_id,))
    moves = db.q("""SELECT mv.*, m.label FROM material_moves mv JOIN materials m ON m.id=mv.material_id
                    WHERE m.batch_id=? ORDER BY mv.id""", (batch_id,))
    detail = {"batch": b, "branches": branches, "steps": steps, "materials": mats, "products": products,
              "qc": qc, "moves": moves}
    detail["next_actions"] = next_actions(detail)
    return detail


def next_actions(d) -> list[dict]:
    """다음 행동 제안. 순서를 강제하지 않고, 현재 상태에서 할 수 있는 것을 우선순위로 보여준다."""
    acts = []
    steps = [s for s in d["steps"] if s["status"] != "cancelled"]
    br_name = {b["id"]: b["name"] for b in d["branches"]}
    if not any(s["kind"] == "charge" for s in steps):
        acts.append({"kind": "charge", "label": "원료 투입 기록", "branch_id": d["branches"][0]["id"] if d["branches"] else None})
    for s in steps:
        if s["status"] == "in_progress":
            acts.append({"kind": "complete", "step_id": s["id"], "branch_id": s["branch_id"],
                         "label": f"[{br_name.get(s['branch_id'])}] {s['name']} 완료 기록"})
        elif s["status"] == "paused":
            acts.append({"kind": "resume", "step_id": s["id"], "branch_id": s["branch_id"],
                         "label": f"[{br_name.get(s['branch_id'])}] {s['name']} 재개"})
    for s in sorted([s for s in steps if s["status"] == "planned"], key=lambda s: s["scheduled_date"] or "9999"):
        acts.append({"kind": "start", "step_id": s["id"], "branch_id": s["branch_id"], "date": s["scheduled_date"],
                     "label": f"[{br_name.get(s['branch_id'])}] {s['name']} 시작" +
                              (f" (예정 {s['scheduled_date']})" if s["scheduled_date"] else "")})
    for br in d["branches"]:
        if br["status"] != "active":
            continue
        idle = [m for m in d["materials"] if m["branch_id"] == br["id"] and m["status"] == "active"
                and not m["product"]]
        busy = any(s["branch_id"] == br["id"] and s["status"] in ("planned", "in_progress", "paused") for s in steps)
        if idle and not busy:
            acts.append({"kind": "process", "branch_id": br["id"],
                         "label": f"[{br['name']}] 다음 공정 기록 (대기 물질 {len(idle)}개)"})
    for p in d["products"]:
        st = p["qc_state"]
        if st["decision"]:
            continue
        unreq = [q for q in d["qc"] if q["product_id"] == p["id"] and q["required"] and q["status"] == "planned"]
        if unreq:
            acts.append({"kind": "qc_request", "product_id": p["id"],
                         "label": f"{p['code']} QC 의뢰/일정 ({', '.join(q['test'] for q in unreq)})"})
        if st["ready"]:
            acts.append({"kind": "decide", "product_id": p["id"], "label": f"{p['code']} 합불 판정"})
    return acts


def lineage(db: Database, material_id):
    """선택한 물질의 조상·자손(여러 입력·출력 그래프)."""
    def up(mid, seen):
        res = []
        m = db.q1("SELECT id, label, created_step_id FROM materials WHERE id=?", (mid,))
        if not m or not m["created_step_id"]:
            return res
        st = db.q1("SELECT id, name, kind FROM steps WHERE id=?", (m["created_step_id"],))
        ins = db.q("""SELECT m.id, m.label, io.role, io.qty_g FROM step_io io JOIN materials m ON m.id=io.material_id
                      WHERE io.step_id=? AND io.role='in'""", (st["id"],))
        raws = db.q("""SELECT rl.delta_g, lot.lot_code, rm.name FROM raw_ledger rl JOIN raw_lots lot ON lot.id=rl.lot_id
                       JOIN raw_materials rm ON rm.id=lot.raw_material_id WHERE rl.step_id=? AND rl.voided_at IS NULL""",
                    (st["id"],))
        res.append({"step": st, "inputs": ins, "raw": raws})
        for i in ins:
            if i["id"] not in seen:
                seen.add(i["id"])
                res += up(i["id"], seen)
        return res

    def down(mid, seen):
        res = []
        uses = db.q("""SELECT s.id, s.name, s.kind, io.role FROM step_io io JOIN steps s ON s.id=io.step_id
                       WHERE io.material_id=? AND io.role IN ('in','through') ORDER BY s.id""", (mid,))
        for u in uses:
            outs = db.q("""SELECT m.id, m.label FROM step_io io JOIN materials m ON m.id=io.material_id
                           WHERE io.step_id=? AND io.role='out'""", (u["id"],))
            res.append({"step": u, "outputs": outs})
            for o in outs:
                if o["id"] not in seen:
                    seen.add(o["id"])
                    res += down(o["id"], seen)
        return res

    m = db.q1("SELECT * FROM materials WHERE id=?", (material_id,))
    if not m:
        raise UserError("물질을 찾을 수 없습니다.", code="not_found")
    moves = db.q("""SELECT mv.*, f.name AS from_name, t.name AS to_name FROM material_moves mv
                    JOIN branches f ON f.id=mv.from_branch_id JOIN branches t ON t.id=mv.to_branch_id
                    WHERE mv.material_id=? ORDER BY mv.id""", (material_id,))
    qc = db.q("SELECT * FROM qc_items WHERE material_id=?", (material_id,))
    return {"material": m, "ancestors": up(material_id, {material_id}), "descendants": down(material_id, {material_id}),
            "moves": moves, "qc": qc,
            "history": db.q("SELECT * FROM audit_log WHERE entity='material' AND entity_id=? ORDER BY id", (material_id,))}


def ancestor_qc(db: Database, product_id):
    """새 산물의 조상 물질에서 나온 QC 결과(참고용, 자동 승계하지 않음)."""
    p = db.q1("SELECT * FROM products WHERE id=?", (product_id,))
    lin = lineage(db, p["material_id"])
    ids = {i["id"] for a in lin["ancestors"] for i in a["inputs"]}
    # 형제(같은 원본에서 갈라진 확인군 등)도 비교 대상으로 보여준다
    rel = set(ids)
    for mid in ids:
        for r in db.q("""SELECT io2.material_id FROM step_io io JOIN step_io io2 ON io2.step_id=io.step_id
                         WHERE io.material_id=? AND io.role='in' AND io2.role='out'""", (mid,)):
            rel.add(r["material_id"])
    rel.discard(p["material_id"])
    if not rel:
        return []
    qs = ",".join("?" * len(rel))
    return db.q(f"""SELECT q.*, m.label AS material_label FROM qc_items q JOIN materials m ON m.id=q.material_id
                    WHERE q.material_id IN ({qs}) AND q.status='received' ORDER BY q.id""", tuple(rel))


def products_list(db: Database):
    ps = db.q("""SELECT p.*, m.label AS material_label, m.batch_id, b.code AS batch_code, b.status AS batch_status
                 FROM products p JOIN materials m ON m.id=p.material_id JOIN batches b ON b.id=m.batch_id
                 WHERE p.status='active' AND b.status<>'trashed' ORDER BY p.id DESC""")
    for p in ps:
        p["remaining_g"] = product_remaining(db, p["id"])
        p["qc_state"] = product_qc_state(db, p["id"])
        p["usages"] = db.q("SELECT * FROM product_usages WHERE product_id=? ORDER BY id", (p["id"],))
        p["qc"] = db.q("SELECT * FROM qc_items WHERE product_id=? ORDER BY required DESC, id", (p["id"],))
    return ps


def qc_board(db: Database, today: str | None = None):
    import datetime as dt
    today = today or dt.date.today().isoformat()
    rows = db.q("""SELECT q.*, m.label AS material_label, b.code AS batch_code, p.code AS product_code,
                          br.name AS branch_name
                   FROM qc_items q JOIN materials m ON m.id=q.material_id JOIN batches b ON b.id=q.batch_id
                   JOIN branches br ON br.id=m.branch_id
                   LEFT JOIN products p ON p.id=q.product_id
                   WHERE b.status='active' AND q.status IN ('planned','requested') ORDER BY q.id""")
    for r in rows:
        r["long_wait"] = r["test"] in LONG_WAIT_QC
        r["days_waiting"] = None
        if r["requested_date"]:
            try:
                r["days_waiting"] = (dt.date.fromisoformat(today) - dt.date.fromisoformat(r["requested_date"][:10])).days
            except ValueError:
                pass
        r["overdue"] = bool(r["expected_date"] and r["expected_date"][:10] < today and r["status"] == "requested")
    return {"to_request": [r for r in rows if r["status"] == "planned"],
            "waiting": [r for r in rows if r["status"] == "requested"]}


def dashboard(db: Database, today: str | None = None):
    import datetime as dt
    today = today or dt.date.today().isoformat()
    batches = []
    for b in db.q("SELECT * FROM batches WHERE status='active' ORDER BY id DESC"):
        d = batch_detail(db, b["id"])
        lanes = []
        for br in d["branches"]:
            ss = [s for s in d["steps"] if s["branch_id"] == br["id"] and s["status"] != "cancelled"]
            cur = next((s for s in ss if s["status"] in ("in_progress", "paused")), None)
            last = next((s for s in reversed(ss) if s["status"] == "done"), None)
            nxt = next((s for s in ss if s["status"] == "planned"), None)
            active_mats = sum(1 for m in d["materials"] if m["branch_id"] == br["id"] and m["status"] == "active")
            lanes.append({"branch": br, "current": cur, "last_done": last, "next_planned": nxt,
                          "active_materials": active_mats})
        batches.append({"batch": b, "lanes": lanes, "next_actions": d["next_actions"][:4]})
    sched = db.q("""SELECT s.id, s.name, s.status, s.scheduled_date, s.expected_hours, b.code AS batch_code, b.id AS batch_id,
                           br.name AS branch_name
                    FROM steps s JOIN batches b ON b.id=s.batch_id JOIN branches br ON br.id=s.branch_id
                    WHERE b.status='active' AND s.status IN ('planned','in_progress','paused') ORDER BY
                    COALESCE(s.scheduled_date,'9999'), s.id""")
    for s in sched:
        s["type"] = "step"
        s["overdue"] = bool(s["scheduled_date"] and s["scheduled_date"][:10] < today and s["status"] == "planned")
    qcs = db.q("""SELECT q.id, q.test, q.scheduled_date, q.status, b.code AS batch_code, b.id AS batch_id,
                         m.label AS material_label FROM qc_items q JOIN batches b ON b.id=q.batch_id
                  JOIN materials m ON m.id=q.material_id
                  WHERE b.status='active' AND q.internal=1 AND q.status='planned' AND q.scheduled_date IS NOT NULL""")
    for q in qcs:
        q["type"] = "qc"
        q["overdue"] = q["scheduled_date"][:10] < today
    products = products_list(db)
    return {"today": today, "batches": batches, "schedule": sched, "qc_schedule": qcs, "qc": qc_board(db, today),
            "raw": raw_stock(db), "products": [p for p in products if (p["remaining_g"] is None or p["remaining_g"] > EPS)],
            "drafts": list_drafts(db)}


def batches_list(db: Database, status="active"):
    rows = db.q("SELECT * FROM batches WHERE status=? ORDER BY id DESC", (status,))
    for r in rows:
        r["branch_count"] = db.q1("SELECT COUNT(*) n FROM branches WHERE batch_id=?", (r["id"],))["n"]
    return rows


def audit(db: Database, batch_id=None, entity=None, entity_id=None, limit=300):
    sql = "SELECT * FROM audit_log WHERE 1=1"
    p = []
    if batch_id:
        sql += " AND batch_id=?"
        p.append(batch_id)
    if entity:
        sql += " AND entity=?"
        p.append(entity)
    if entity_id:
        sql += " AND entity_id=?"
        p.append(entity_id)
    sql += " ORDER BY id DESC LIMIT ?"
    p.append(limit)
    return db.q(sql, tuple(p))


def step_preview_split(db: Database, source_material_id, count=None, per_qty_g=None, quantities=None):
    m = db.q1("SELECT * FROM materials WHERE id=?", (source_material_id,))
    if not m:
        raise UserError("물질을 찾을 수 없습니다.", code="not_found")
    return preview_split(m, count, per_qty_g, quantities)
