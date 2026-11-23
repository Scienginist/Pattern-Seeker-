"""250 g 배치 실제 사례를 끝까지 따라가며 검증 항목 1~14를 확인한다."""
import json
import sqlite3
import uuid

import pytest

from catalystflow import services as S
from catalystflow.db import Database
from catalystflow.errors import ConflictError, UserError


def op():
    return uuid.uuid4().hex


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "data" / "catalystflow.db")
    yield d
    d.close()


def run(db, _cmd, **payload):
    return S.COMMANDS[_cmd](db, payload, op_id=op())


def mat(db, mid):
    return db.q1("SELECT * FROM materials WHERE id=?", (mid,))


def lot_rem(db, lot_id):
    return S.lot_remaining(db, lot_id)


@pytest.fixture
def case(db):
    """원료 입고 → 배치 → 250 g 투입 → 슬러리 1,839 g(실측) → 31×50 g 소분."""
    ir = db.q1("SELECT id FROM raw_materials WHERE name='IrCl₃'")["id"]
    lot = run(db, "receive_lot", raw_material_id=ir, lot_code="IR-2611-01", received_qty_g=1000,
              received_date="2026-11-01")["id"]
    b = run(db, "create_batch", code="B-261110", title="IrOx 250 g 배치", common_conditions="전구체 공통 조건 A")
    batch, prod = b["id"], b["branch_id"]
    ch = run(db, "charge_raw", batch_id=batch, branch_id=prod, raw_lines=[{"lot_id": lot, "qty_g": 250}],
             output={"label": "전구체 슬러리", "form": "슬러리", "mass_basis": "slurry_total",
                     "qty_g": 1839, "qty_kind": "measured"},
             actual_start="2026-11-10 09:00")
    slurry = ch["output_ids"][0]
    sp = run(db, "split_material", source_material_id=slurry, count=31, per_qty_g=50, label_prefix="도가니")
    return dict(lot=lot, batch=batch, prod=prod, slurry=slurry, split=sp, crucibles=sp["output_ids"])


# 1 -----------------------------------------------------------------
def test_01_split_remaining_289(db, case):
    assert case["split"]["total_g"] == 1550
    s = mat(db, case["slurry"])
    assert s["qty_g"] == 289 and s["qty_kind"] == "calculated" and s["status"] == "active"
    labels = [mat(db, i)["label"] for i in case["crucibles"]]
    assert len(labels) == 31 and labels[0] == "도가니 01" and labels[-1] == "도가니 31"
    c = mat(db, case["crucibles"][0])
    # 상태·질량 기준을 원본에서 이어받음
    assert c["form"] == "슬러리" and c["mass_basis"] == "slurry_total" and c["qty_g"] == 50
    # 소분은 한 번의 저장으로 '완료' 공정이 됨
    st = db.q1("SELECT * FROM steps WHERE id=?", (case["split"]["id"],))
    assert st["status"] == "done" and st["kind"] == "split"
    # 시각을 입력하지 않았으면 미기록(현재 시각으로 확정하지 않음)
    assert st["actual_start"] is None and st["actual_end"] is None


# 2 -----------------------------------------------------------------
def test_02_raw_not_deducted_again(db, case):
    assert lot_rem(db, case["lot"]) == 750
    run(db, "record_step", batch_id=case["batch"], branch_id=case["prod"], name="열처리", status="done",
        equipment="대형 퍼니스", inputs=[{"material_id": m, "role": "through"} for m in case["crucibles"]],
        after_state={"form": "소성 분말", "mass_basis": "as_is", "qty_reset": True})
    assert lot_rem(db, case["lot"]) == 750
    assert db.q1("SELECT COUNT(*) n FROM raw_ledger")["n"] == 1


# 3 -----------------------------------------------------------------
def test_03_unknown_total_no_remaining(db, case):
    m = run(db, "record_step", batch_id=case["batch"], branch_id=case["prod"], name="별도 슬러리", status="done",
            outputs=[{"label": "미측정 슬러리", "form": "슬러리", "mass_basis": "slurry_total"}])
    mid = m["output_ids"][0]
    assert mat(db, mid)["qty_g"] is None and mat(db, mid)["qty_kind"] == "unknown"
    pv = S.step_preview_split(db, mid, count=4, per_qty_g=50)
    assert pv["remaining_g"] is None and pv["total_g"] == 200
    run(db, "split_material", source_material_id=mid, count=4, per_qty_g=50)
    after = mat(db, mid)
    assert after["qty_g"] is None and after["qty_kind"] == "unknown" and after["status"] == "active"


def test_03b_estimated_is_not_firm(db, case):
    r = run(db, "record_step", batch_id=case["batch"], branch_id=case["prod"], name="메모", status="done",
            outputs=[{"label": "추정 잔량", "qty_g": 275, "qty_kind": "estimated"}])
    mid = r["output_ids"][0]
    run(db, "split_material", source_material_id=mid, count=2, per_qty_g=25)
    m = mat(db, mid)
    assert m["qty_kind"] == "estimated" and m["qty_g"] == 225   # 추정은 추정으로 남음


def test_split_cannot_exceed_measured(db, case):
    with pytest.raises(UserError):
        run(db, "split_material", source_material_id=case["slurry"], count=6, per_qty_g=50)  # 300 > 289
    assert mat(db, case["slurry"])["qty_g"] == 289
    assert db.q1("SELECT COUNT(*) n FROM materials")["n"] == 32   # 아무것도 생기지 않음


def _heat_and_separate(db, case):
    run(db, "record_step", batch_id=case["batch"], branch_id=case["prod"], name="열처리", status="done",
        equipment="대형 퍼니스", observations="도가니 4개에서 노란 기체 머묾",
        inputs=[{"material_id": m, "role": "through"} for m in case["crucibles"]],
        after_state={"form": "소성 분말", "mass_basis": "as_is", "qty_reset": True})
    odd = case["crucibles"][:4]
    mv = run(db, "move_materials", material_ids=odd, new_branch={"name": "확인군", "kind": "exception"},
             reason="열처리 중 노란 기체 관찰")
    return odd, [m for m in case["crucibles"] if m not in odd], mv["to_branch_id"]


# 4 -----------------------------------------------------------------
def test_04_identity_and_moves(db, case):
    odd, normal, exc = _heat_and_separate(db, case)
    assert db.q1("SELECT COUNT(*) n FROM materials")["n"] == 32  # 이동은 새 물질을 만들지 않음
    for m in odd:
        row = mat(db, m)
        assert row["branch_id"] == exc and row["form"] == "소성 분말"
        lin = S.lineage(db, m)
        assert lin["moves"][0]["to_name"] == "확인군"
        assert lin["ancestors"][0]["step"]["kind"] == "split"
        assert lin["ancestors"][1]["raw"][0]["lot_code"] == "IR-2611-01"
    for m in normal:
        assert mat(db, m)["branch_id"] == case["prod"]
    # 확인군 4개를 섞어 분석 시료 하나로
    r = run(db, "record_step", batch_id=case["batch"], branch_id=exc, name="확인군 혼합", kind="merge",
            status="done", inputs=[{"material_id": m} for m in odd],
            outputs=[{"label": "확인군 혼합 시료", "mass_basis": "as_is"}])
    sample = r["output_ids"][0]
    for t in ("XRD", "BET"):
        run(db, "add_qc", material_id=sample, test=t)
    lin = S.lineage(db, sample)
    assert {i["label"] for i in lin["ancestors"][0]["inputs"]} == {mat(db, m)["label"] for m in odd}


# 5 -----------------------------------------------------------------
def test_05_unselected_slurry_not_included(db, case):
    _, normal, _ = _heat_and_separate(db, case)
    r = run(db, "record_step", batch_id=case["batch"], branch_id=case["prod"], name="세척(질산→물→물)",
            kind="merge", status="done", equipment="대형 필터", actual_conditions="질산 → 물 → 물",
            inputs=[{"material_id": m} for m in normal],
            outputs=[{"label": "정상군 세척 케이크", "form": "케이크", "mass_basis": "wet"}])
    s = mat(db, case["slurry"])
    assert s["status"] == "active" and s["qty_g"] == 289
    ins = db.q("SELECT material_id FROM step_io WHERE step_id=? AND role='in'", (r["id"],))
    assert case["slurry"] not in {i["material_id"] for i in ins} and len(ins) == 27


def _full_production(db, case):
    odd, normal, exc = _heat_and_separate(db, case)
    w = run(db, "record_step", batch_id=case["batch"], branch_id=case["prod"], name="세척", kind="merge",
            status="done", actual_conditions="질산 → 물 → 물",
            inputs=[{"material_id": m} for m in normal],
            outputs=[{"label": "정상군 세척 케이크", "form": "케이크", "mass_basis": "wet"}])
    cake = w["output_ids"][0]
    fd = run(db, "record_step", batch_id=case["batch"], branch_id=case["prod"], name="동결건조", status="done",
             inputs=[{"material_id": cake}],
             outputs=[{"label": "IrOx 분말 (정상군)", "form": "분말", "mass_basis": "dry", "qty_g": 205.4}])
    powder = fd["output_ids"][0]
    return dict(odd=odd, normal=normal, exc=exc, wash=w["id"], cake=cake, powder=powder)


# 9, 10 -------------------------------------------------------------
def test_09_wrong_input_correction(db, case):
    odd, normal, _ = _heat_and_separate(db, case)
    # 실수: 정상 27개 + 잔여 슬러리 전부를 세척에 함께 선택
    w = run(db, "record_step", batch_id=case["batch"], branch_id=case["prod"], name="세척", kind="merge",
            status="done", inputs=[{"material_id": m} for m in normal] + [{"material_id": case["slurry"]}],
            outputs=[{"label": "정상군 세척 케이크", "mass_basis": "wet"}])
    assert mat(db, case["slurry"])["status"] == "consumed"
    io = db.q1("SELECT id FROM step_io WHERE step_id=? AND material_id=?", (w["id"], case["slurry"]))
    ver = db.q1("SELECT version FROM steps WHERE id=?", (w["id"],))["version"]
    run(db, "correct_step_io", step_id=w["id"], version=ver, remove_io_ids=[io["id"]],
        reason="잔여 슬러리는 세척에 넣지 않았음")
    s = mat(db, case["slurry"])
    assert s["status"] == "active" and s["qty_g"] == 289 and s["qty_kind"] == "calculated"
    assert db.q1("SELECT COUNT(*) n FROM step_io WHERE step_id=? AND role='in'", (w["id"],))["n"] == 27
    assert S.lot_remaining(db, case["lot"]) == 750
    hist = S.audit(db, batch_id=case["batch"])
    assert any(h["action"] == "unlink" and "잔여 슬러리" in h["reason"] for h in hist)


def test_10_partial_failure_rolls_back(db, case):
    p = _full_production(db, case)
    io_slurry_like = db.q1("SELECT id FROM step_io WHERE step_id=? AND role='in' LIMIT 1", (p["wash"],))
    io_out = db.q1("SELECT id FROM step_io WHERE step_id=? AND role='out'", (p["wash"],))
    ver = db.q1("SELECT version FROM steps WHERE id=?", (p["wash"],))["version"]
    before = db.q("SELECT id, status, qty_g, branch_id FROM materials ORDER BY id")
    before_io = db.q("SELECT * FROM step_io ORDER BY id")
    # 투입 하나 제거 + 산출(이미 동결건조에 쓰임) 제거 → 후자가 막히면 전체 취소
    with pytest.raises(UserError) as e:
        run(db, "correct_step_io", step_id=p["wash"], version=ver,
            remove_io_ids=[io_slurry_like["id"], io_out["id"]], reason="시험")
    assert e.value.code == "linked" and any("동결건조" in d for d in e.value.details)
    assert db.q("SELECT id, status, qty_g, branch_id FROM materials ORDER BY id") == before
    assert db.q("SELECT * FROM step_io ORDER BY id") == before_io
    # 조건·메모 수정은 막지 않음
    run(db, "update_step", step_id=p["wash"], version=ver, actual_conditions="질산 1M → 물 → 물",
        reason="농도 추가")


# 11 ----------------------------------------------------------------
def test_11_idempotent_retry(db, case):
    key = op()
    payload = dict(source_material_id=case["slurry"], count=2, per_qty_g=25, label_prefix="석영 비커")
    a = S.COMMANDS["split_material"](db, payload, op_id=key)
    b = S.COMMANDS["split_material"](db, payload, op_id=key)  # 재시도/더블클릭
    assert b.get("replayed") and a["output_ids"] == b["output_ids"]
    assert mat(db, case["slurry"])["qty_g"] == 239
    assert db.q1("SELECT COUNT(*) n FROM materials WHERE label LIKE '석영 비커%'")["n"] == 2
    k2 = op()
    lot = case["lot"]
    S.COMMANDS["correct_lot_remaining"](db, {"lot_id": lot, "measured_remaining_g": 748}, op_id=k2)
    S.COMMANDS["correct_lot_remaining"](db, {"lot_id": lot, "measured_remaining_g": 748}, op_id=k2)
    assert S.lot_remaining(db, lot) == 748


def test_11b_stale_window_conflict(db, case):
    st = db.q1("SELECT * FROM steps WHERE id=?", (case["split"]["id"],))
    run(db, "update_step", step_id=st["id"], version=st["version"], operator="김연구")
    with pytest.raises(ConflictError):
        run(db, "update_step", step_id=st["id"], version=st["version"], operator="오래된 창")
    assert db.q1("SELECT operator FROM steps WHERE id=?", (st["id"],))["operator"] == "김연구"


# 8 -----------------------------------------------------------------
def test_08_edit_done_step_with_history(db, case):
    st = db.q1("SELECT * FROM steps WHERE id=?", (case["split"]["id"],))
    run(db, "update_step", step_id=st["id"], version=st["version"], name="슬러리 소분 31개",
        actual_start="2026-11-10 13:00", observations="도가니 무게 확인", reason="시각 기억남")
    st2 = db.q1("SELECT * FROM steps WHERE id=?", (st["id"],))
    assert st2["name"] == "슬러리 소분 31개" and st2["actual_start"] == "2026-11-10 13:00"
    h = S.audit(db, entity="step", entity_id=st["id"])
    u = next(x for x in h if x["action"] == "update")
    assert json.loads(u["before_json"])["actual_start"] is None
    assert json.loads(u["after_json"])["actual_start"] == "2026-11-10 13:00"


# 12 ----------------------------------------------------------------
def test_12_no_auto_pass(db, case):
    p = _full_production(db, case)
    pid = run(db, "register_product", material_id=p["powder"], code="P-261120-01")["id"]
    qcs = db.q("SELECT * FROM qc_items WHERE product_id=?", (pid,))
    assert sorted(q["test"] for q in qcs) == sorted(["XRD", "BET", "과전압", "pH", "TGA", "XRF"])
    assert {q["test"] for q in qcs if q["internal"]} == {"과전압", "pH"}
    # 이중 입고 방지
    with pytest.raises(UserError):
        run(db, "register_product", material_id=p["powder"], code="P-dup")
    # 5개만 결과 수령
    for q in qcs[:-1]:
        run(db, "update_qc", qc_id=q["id"], version=q["version"], status="received", result_summary="OK",
            representative=1)
    with pytest.raises(UserError) as e:
        run(db, "decide_product", product_id=pid, decision="pass", reason="좋아 보임")
    assert e.value.code == "qc_incomplete"
    last = db.q1("SELECT * FROM qc_items WHERE id=?", (qcs[-1]["id"],))
    run(db, "update_qc", qc_id=last["id"], version=last["version"], status="received", result_summary="OK")
    # 결과가 다 나와도 대표성 미확인이면 합격 불가 & 자동 판정 없음
    assert S.product_qc_state(db, pid)["decision"] is None
    with pytest.raises(UserError):
        run(db, "decide_product", product_id=pid, decision="pass", reason="x")
    last = db.q1("SELECT * FROM qc_items WHERE id=?", (qcs[-1]["id"],))
    run(db, "update_qc", qc_id=last["id"], version=last["version"], representative=1)
    assert S.product_qc_state(db, pid)["ready"] and S.product_qc_state(db, pid)["decision"] is None
    run(db, "decide_product", product_id=pid, decision="pass", reason="필수 6종 기준 충족, 기존 양품 대비 동등")
    assert S.product_qc_state(db, pid)["decision"]["decision"] == "pass"


def test_qc_not_inherited_after_merge(db, case):
    p = _full_production(db, case)
    # 정상군 분말에 XRD 결과
    q = run(db, "add_qc", material_id=p["powder"], test="XRD")["id"]
    row = db.q1("SELECT * FROM qc_items WHERE id=?", (q,))
    run(db, "update_qc", qc_id=q, version=row["version"], status="received", result_summary="rutile IrO2")
    # 확인군 합쳐 새 산물을 만들면 기존 결과는 자동 승계되지 않음
    r = run(db, "record_step", batch_id=case["batch"], branch_id=case["prod"], name="정상군+확인군 병합",
            kind="merge", status="done", inputs=[{"material_id": p["powder"]}] + [{"material_id": m} for m in p["odd"]],
            outputs=[{"label": "병합 분말", "mass_basis": "dry"}])
    new = r["output_ids"][0]
    pid = run(db, "register_product", material_id=new, code="P-merged")["id"]
    xrd = db.q1("SELECT * FROM qc_items WHERE product_id=? AND test='XRD'", (pid,))
    assert xrd["status"] == "planned" and xrd["result_summary"] == ""
    refs = S.ancestor_qc(db, pid)
    assert any(r["id"] == q for r in refs)
    with pytest.raises(UserError):
        run(db, "adopt_qc_result", product_id=pid, source_qc_id=q)  # 근거 없이 인정 불가
    run(db, "adopt_qc_result", product_id=pid, source_qc_id=q, representative_note="정상군이 92% 비중, 확인군 XRD 동일")
    xrd = db.q1("SELECT * FROM qc_items WHERE product_id=? AND test='XRD'", (pid,))
    assert xrd["status"] == "received" and xrd["source_qc_id"] == q and xrd["representative"] == 1
    assert db.q1("SELECT result_summary FROM qc_items WHERE id=?", (q,))["result_summary"] == "rutile IrO2"


# 13 ----------------------------------------------------------------
def test_13_research_continues_after_production_done(db, case):
    p = _full_production(db, case)
    br = db.q1("SELECT * FROM branches WHERE id=?", (case["prod"],))
    run(db, "update_branch", branch_id=br["id"], version=br["version"], status="done")
    rb = run(db, "add_branch", batch_id=case["batch"], name="잔여 슬러리 연구", kind="research",
             condition_diff="히팅맨틀 열처리, 스터링 유/무 비교")["id"]
    sp = run(db, "split_material", source_material_id=case["slurry"], count=2, per_qty_g=25,
             label_prefix="석영 비커 100mL", target_branch_id=rb)
    a, b = sp["output_ids"]
    assert mat(db, case["slurry"])["qty_g"] == 239
    run(db, "record_step", batch_id=case["batch"], branch_id=rb, name="히팅맨틀 열처리 (스터링 O)", status="done",
        inputs=[{"material_id": a, "role": "through"}])
    run(db, "record_step", batch_id=case["batch"], branch_id=rb, name="히팅맨틀 열처리 (스터링 X)", status="done",
        inputs=[{"material_id": b, "role": "through"}])
    for m in (a, b):
        run(db, "add_qc", material_id=m, test="BET")
    run(db, "record_step", batch_id=case["batch"], branch_id=rb, name="1 L 석영 비커 확대 (~225 g)",
        status="planned", scheduled_date="2026-12-01", planned_conditions="선택 조건으로 약 225 g")
    d = S.batch_detail(db, case["batch"])
    assert any("1 L" in x["label"] for x in d["next_actions"])
    dash = S.dashboard(db, today="2026-11-23")
    assert any(s["name"].startswith("1 L") for s in dash["schedule"])
    assert len(dash["qc"]["to_request"]) >= 2


# 6, 7 --------------------------------------------------------------
def test_06_07_drafts_isolated_and_persist(tmp_path):
    path = tmp_path / "d.db"
    db = Database(path)
    k1 = S.draft_key(1, 2, 10, "complete")
    k2 = S.draft_key(1, 2, 11, "complete")
    k3 = S.draft_key(1, 2, 10, "edit")
    S.save_draft(db, k1, "complete", {"step_id": 10, "title": "열처리", "observations": "노란 기체"}, 1, 2, 10, "열처리 완료")
    S.save_draft(db, k2, "complete", {"step_id": 11, "title": "세척"}, 1, 2, 11, "세척 완료")
    S.save_draft(db, k3, "edit", {"step_id": 10, "name": "열처리 수정"}, 1, 2, 10, "열처리 수정")
    db.close()
    db = Database(path)  # 앱 재실행
    assert S.get_draft(db, k1)["payload"]["observations"] == "노란 기체"
    assert S.get_draft(db, k2)["payload"]["step_id"] == 11
    assert S.get_draft(db, k3)["payload"]["name"] == "열처리 수정"
    assert len(S.list_drafts(db)) == 3
    # 초안은 실제 기록이 아님
    assert db.q1("SELECT COUNT(*) n FROM steps")["n"] == 0
    db.close()


# 14 ----------------------------------------------------------------
def test_14_backup_restore(db, case, tmp_path):
    p = _full_production(db, case)
    pid = run(db, "register_product", material_id=p["powder"], code="P-1")["id"]
    run(db, "use_product", product_id=pid, purpose="qc", qty_g=2.0)
    S.save_draft(db, "kx", "edit", {"x": 1})
    snap = {t: db.q(f"SELECT * FROM {t} ORDER BY 1") for t in
            ("raw_lots", "raw_ledger", "products", "product_usages", "steps", "step_io", "materials", "qc_items",
             "drafts", "audit_log", "material_moves")}
    bk = db.backup_to(tmp_path / "out" / "my.cfdb")
    # 이후 변경
    run(db, "receive_lot", raw_material_id=1, lot_code="X", received_qty_g=5)
    S.delete_draft(db, "kx")
    res = db.restore_from(bk)
    from pathlib import Path
    assert Path(res["safety_backup"]).exists()
    for t, rows in snap.items():
        assert db.q(f"SELECT * FROM {t} ORDER BY 1") == rows, t
    # 손상된 파일은 거부, 원본 유지
    bad = tmp_path / "bad.cfdb"
    bad.write_bytes(b"not a database" * 100)
    with pytest.raises(UserError):
        db.restore_from(bad)
    assert db.q1("SELECT COUNT(*) n FROM products")["n"] == 1
    # 다른 SQLite 파일도 거부
    other = tmp_path / "other.db"
    c = sqlite3.connect(other)
    c.execute("create table t(x)")
    c.commit()
    c.close()
    with pytest.raises(UserError):
        db.restore_from(other)


# 원료 Lot 정리 -------------------------------------------------------
def test_lot_trash_blocked_and_reassign(db, case):
    ir = db.q1("SELECT id FROM raw_materials WHERE name='IrCl₃'")["id"]
    dup = run(db, "receive_lot", raw_material_id=ir, lot_code="IR-2611-01", received_qty_g=1000)
    assert dup["warning"]
    with pytest.raises(UserError) as e:
        run(db, "trash_lot", lot_id=case["lot"])
    assert e.value.code == "linked" and "B-261110" in e.value.details[0]
    led = db.q1("SELECT id FROM raw_ledger WHERE lot_id=?", (case["lot"],))["id"]
    run(db, "reassign_consumption", ledger_id=led, new_lot_id=dup["id"], reason="중복 입고 정리")
    run(db, "trash_lot", lot_id=case["lot"], reason="중복")
    assert S.lot_remaining(db, dup["id"]) == 750
    run(db, "restore_lot", lot_id=case["lot"])
    assert db.q1("SELECT deleted_at FROM raw_lots WHERE id=?", (case["lot"],))["deleted_at"] is None


def test_product_usage_and_reprocess(db, case):
    p = _full_production(db, case)
    pid = run(db, "register_product", material_id=p["powder"], code="P-2")["id"]
    assert S.product_remaining(db, pid) == 205.4
    u = run(db, "use_product", product_id=pid, purpose="ship", qty_g=100, destination="고객 A")
    with pytest.raises(UserError):
        run(db, "use_product", product_id=pid, purpose="ship", qty_g=200)
    run(db, "void_usage", usage_id=u["id"], reason="출하 취소(미발송)")
    assert S.product_remaining(db, pid) == 205.4
    rb = run(db, "add_branch", batch_id=case["batch"], name="재처리", kind="exception")["id"]
    r = run(db, "use_product", product_id=pid, purpose="reprocess", qty_g=20,
            reprocess={"branch_id": rb, "label": "재소성 시료"})
    lin = S.lineage(db, r["reprocess_material_id"])
    assert lin["ancestors"][0]["inputs"][0]["id"] == p["powder"]
    assert S.product_remaining(db, pid) == 185.4


def test_step_lifecycle_and_unknown_times(db, case):
    s = run(db, "record_step", batch_id=case["batch"], branch_id=case["prod"], name="열처리", status="planned",
            scheduled_date="2026-11-12", expected_hours=8, planned_conditions="500 ℃ 2 h")["id"]
    row = db.q1("SELECT * FROM steps WHERE id=?", (s,))
    run(db, "start_step", step_id=s, version=row["version"],
        inputs=[{"material_id": m, "role": "through"} for m in case["crucibles"]])
    row = db.q1("SELECT * FROM steps WHERE id=?", (s,))
    assert row["actual_start"] is None  # 입력 안 했으면 미기록
    run(db, "pause_step", step_id=s, version=row["version"], note="정전")
    row = db.q1("SELECT * FROM steps WHERE id=?", (s,))
    run(db, "resume_step", step_id=s, version=row["version"], at="2026-11-12 15:00")
    row = db.q1("SELECT * FROM steps WHERE id=?", (s,))
    run(db, "complete_step", step_id=s, version=row["version"], actual_end="2026-11-13 08:00")
    ev = [e["event"] for e in db.q("SELECT event FROM step_events WHERE step_id=? ORDER BY id", (s,))]
    assert ev == ["start", "pause", "resume", "complete"]
    # 다음 단계는 자동 시작되지 않음
    assert db.q1("SELECT COUNT(*) n FROM steps WHERE status='in_progress'")["n"] == 0


def test_cancel_step_restores(db, case):
    sp = run(db, "split_material", source_material_id=case["slurry"], count=2, per_qty_g=25)
    v = db.q1("SELECT version FROM steps WHERE id=?", (sp["id"],))["version"]
    run(db, "cancel_step", step_id=sp["id"], version=v, reason="잘못 입력")
    assert mat(db, case["slurry"])["qty_g"] == 289
    assert all(mat(db, i)["status"] == "voided" for i in sp["output_ids"])
    # 원료 투입 기록 취소 → 재고 복원
    ch = db.q1("SELECT id, version FROM steps WHERE kind='charge'")
    with pytest.raises(UserError):  # 산출 슬러리가 후속 소분에 쓰였으므로 막힘
        run(db, "cancel_step", step_id=ch["id"], version=ch["version"], reason="x")
    assert S.lot_remaining(db, case["lot"]) == 750


def test_archive_trash(db, case):
    run(db, "set_batch_status", batch_id=case["batch"], action="archive")
    assert S.batches_list(db, "archived")[0]["id"] == case["batch"]
    assert S.dashboard(db)["batches"] == []
    run(db, "set_batch_status", batch_id=case["batch"], action="trash")
    run(db, "set_batch_status", batch_id=case["batch"], action="restore")
    assert db.q1("SELECT status FROM batches WHERE id=?", (case["batch"],))["status"] == "archived"
