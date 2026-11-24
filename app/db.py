"""Pattern Seeker 데이터 계층: SQLite 연결, 마이그레이션, 백업/복구(검증 포함).

데이터 보존 원칙
- 마이그레이션은 (1) 현재 DB 사본에 먼저 적용해 검증하고, (2) 원본을 백업한 뒤, (3) 원본에 적용한다.
- 백업은 SQLite backup API 로 만들고 integrity_check + 테이블별 행 수 비교로 검증한다.
- 복구 전에는 현재 DB 를 'pre-restore' 백업으로 남긴다.
"""
import datetime
import json
import os
import sqlite3

APP_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(APP_DIR)
DATA_DIR = os.environ.get("PATTERN_SEEKER_DATA") or os.path.join(ROOT_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "pattern_seeker.db")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
FILES_DIR = os.path.join(DATA_DIR, "files")
MIGRATION_DIR = os.path.join(APP_DIR, "migrations")

STATUSES = ["자료 있음", "자료 없음", "계획 없음", "의뢰 중", "미업로드"]
DEFAULT_STATUS = "미업로드"


def now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def ensure_dirs():
    for d in (DATA_DIR, BACKUP_DIR, FILES_DIR):
        os.makedirs(d, exist_ok=True)


def connect(path=None):
    conn = sqlite3.connect(path or DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ---------------------------------------------------------------- 분석 종류 기본 정의
# fields  : 수동 입력/추출 값 (values_json 의 키)
# metrics : 비교표·그래프에 쓰는 수치 (values 또는 computed.metrics 에서 찾음)
# default_conditions : 기본 안내 조건 (source='default' 로 저장되어 실측 조건과 구분)
def _f(key, label, unit="", help="", decimals=2):
    return {"key": key, "label": label, "unit": unit, "help": help, "decimals": decimals}


BUILTIN_TYPES = [
    {
        "code": "XRD", "name": "XRD", "group": "구조", "order": 10,
        "description": "X선 회절. 피크 면적·FWHM·중심 2θ 로 결정립 크기(GS)와 Sharpness Index(SI)를 계산합니다.",
        "config": {
            "tool": "xrd",
            "fields": [],
            "metrics": [
                _f("gs_101", "(101) GS", "nm", "Scherrer 식으로 계산한 (101) 결정립 크기"),
                _f("gs_110", "(110) GS", "nm", "Scherrer 식으로 계산한 (110) 결정립 크기"),
                _f("si_110", "(110) SI", "", "Sharpness Index = 피크 적분 면적 / FWHM", 0),
                _f("si_101", "(101) SI", "", "Sharpness Index = 피크 적분 면적 / FWHM", 0),
                _f("fwhm_110", "(110) FWHM", "°"), _f("fwhm_101", "(101) FWHM", "°"),
                _f("center_110", "(110) 2θ", "°"), _f("center_101", "(101) 2θ", "°"),
            ],
            "default_conditions": {
                "wavelength_nm": {"value": 0.15418, "unit": "nm", "label": "X선 파장 (Cu Kα)"},
                "scherrer_k": {"value": 0.94, "unit": "", "label": "Scherrer 상수 K"},
            },
        },
    },
    {
        "code": "BET", "name": "BET", "group": "표면·기공", "order": 20,
        "description": "질소 흡착 비표면적. 보고서 값과 앱 재계산 값을 구분해 저장합니다.",
        "config": {
            "tool": "bet",
            "fields": [
                _f("bet_ssa", "BET 비표면적", "m²/g", "보고서에 기재된 BET 비표면적"),
                _f("tplot_micro_area", "t-plot 미세기공 면적", "m²/g", "t-plot 으로 구한 미세기공(<2 nm) 면적"),
                _f("tplot_ext_area", "t-plot 외부 표면적", "m²/g", "t-plot 으로 구한 미세기공 외 표면적"),
                _f("pore_volume", "기공 부피", "cm³/g", "총 기공 부피 (보고서 기준 p/p0 확인)"),
                _f("pore_size", "평균 기공 크기", "nm", "보고서 평균 기공 직경 (Å 는 nm 로 환산)"),
            ],
            "metrics": [
                _f("bet_ssa", "BET 비표면적(보고서)", "m²/g"),
                _f("bet_ssa_recalc", "BET 비표면적(앱 재계산)", "m²/g", "앱이 등온선 데이터로 다시 계산한 값"),
                _f("tplot_micro_area", "t-plot 미세기공 면적", "m²/g"),
                _f("tplot_ext_area", "t-plot 외부 표면적", "m²/g"),
                _f("pore_volume", "기공 부피", "cm³/g"),
                _f("pore_size", "평균 기공 크기", "nm"),
            ],
        },
    },
    {
        "code": "XRF", "name": "XRF", "group": "조성", "order": 30,
        "description": "형광 X선 원소 함량. 계산 순도와 Cl·Si·Na 등 관심 불순물을 기록합니다.",
        "config": {
            "tool": "xrf",
            "fields": [],
            "metrics": [
                _f("purity", "계산 순도", "%", "선택한 주성분 합 / 보고된 성분 합 × 100"),
                _f("imp_Cl", "Cl", "wt%"), _f("imp_Si", "Si", "wt%"), _f("imp_Na", "Na", "wt%"),
            ],
            "interest_elements": ["Cl", "Si", "Na"],
            "main_components": ["IrO2"],
        },
    },
    {
        "code": "PSA", "name": "PSA (입도)", "group": "입자", "order": 40,
        "description": "분말을 용매에 분산해 측정한 입도 분포.",
        "config": {
            "tool": "psa",
            "fields": [
                _f("d10", "D10", "µm", "누적 분포 10 % 지점 입경"),
                _f("d50", "D50", "µm", "누적 분포 50 % 지점 입경 (중앙값)"),
                _f("d90", "D90", "µm", "누적 분포 90 % 지점 입경"),
            ],
            "metrics": [
                _f("d10", "D10", "µm"), _f("d50", "D50", "µm"), _f("d90", "D90", "µm"),
                _f("span", "Span", "", "Span = (D90 − D10) / D50, 분포 폭의 무차원 지표"),
            ],
            "reference_ranges": {"d90": {"min": 10, "max": 25, "unit": "µm",
                                         "label": "경험상 양품 참고 범위(확정 기준 아님)"}},
            "default_conditions": {
                "powder_g": {"value": 0.1, "unit": "g", "label": "분말 양"},
                "solvent": {"value": "물", "unit": "", "label": "분산 용매"},
                "solvent_ml": {"value": 5, "unit": "mL", "label": "용매 부피"},
                "dispersion": {"value": "손으로 분산 후 의뢰", "unit": "", "label": "분산 방법"},
            },
        },
    },
    {
        "code": "TGA", "name": "TGA", "group": "열분석", "order": 50,
        "description": "열중량 분석. 원시 데이터로 질량·DTG 곡선을 그리고 수분 함량을 계산합니다.",
        "config": {
            "tool": "tga",
            "fields": [],
            "metrics": [_f("water_content", "수분 함량", "%", "선택 온도 구간의 질량 감소 / 초기 질량 × 100")],
        },
    },
    {
        "code": "PH", "name": "분말 pH", "group": "기타", "order": 60,
        "description": "최종 분말 현탁액의 pH.",
        "config": {
            "tool": "generic",
            "fields": [_f("ph", "pH", "", "현탁액 pH")],
            "metrics": [_f("ph", "pH", "")],
            "default_conditions": {
                "powder_g": {"value": 0.1, "unit": "g", "label": "분말 양"},
                "water_ml": {"value": 10, "unit": "mL", "label": "정제수"},
                "procedure": {"value": "손으로 혼합한 직후 측정", "unit": "", "label": "절차"},
            },
        },
    },
    {
        "code": "EC", "name": "전기화학 (CV·LSV·OCV)", "group": "전기화학", "order": 70,
        "description": "전기화학 원시 데이터와 측정 순서·메모.",
        "config": {"tool": "ec", "fields": [], "metrics": []},
    },
    {
        "code": "ECSA", "name": "ECSA / Cdl", "group": "전기화학", "order": 80,
        "description": "scan rate 별 CV 로 이중층 정전용량(Cdl)을 구하고, 가정한 Cs 로 ECSA 를 추정합니다.",
        "config": {
            "tool": "ecsa",
            "fields": [],
            "metrics": [
                _f("cdl", "Cdl", "mF", "이중층 정전용량: 전류−scan rate 직선의 기울기"),
                _f("ecsa", "ECSA (추정)", "cm²", "ECSA = Cdl / Cs. Cs 는 가정값"),
                _f("ecsa_per_mass", "ECSA/질량 (추정)", "cm²/mg"),
            ],
        },
    },
]

DEFAULT_SETTINGS = {
    "reagent_default_supplier": "H사",
    "heat_treatment_defaults": {"temperature": {"value": 450, "unit": "°C"},
                                "ramp_min": {"value": 50, "unit": "min"},
                                "hold_min": {"value": 30, "unit": "min"}},
    "ec_defaults": {"rde_no": {"value": "모름", "unit": ""},
                    "ink_name": {"value": "기존", "unit": ""},
                    "coating": {"value": "2 µL × 1회", "unit": ""},
                    "loading_mg": {"value": 0.222, "unit": "mg"}},
}


def seed_v1(conn):
    for t in BUILTIN_TYPES:
        conn.execute(
            "INSERT OR IGNORE INTO analysis_types(code,name,group_name,description,sort_order,active,builtin,config_json)"
            " VALUES(?,?,?,?,?,1,1,?)",
            (t["code"], t["name"], t["group"], t["description"], t["order"],
             json.dumps(t["config"], ensure_ascii=False)))
    for k, v in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings(key,value_json) VALUES(?,?)",
                     (k, json.dumps(v, ensure_ascii=False)))


BET_V2_FIELDS = [
    _f("single_point_sa", "단일점 비표면적", "m²/g", "보고서의 Single point surface area (해당 P/Po 기록)"),
    _f("tplot_micro_volume", "t-plot 미세기공 부피", "cm³/g", "t-plot 으로 구한 미세기공 부피"),
    _f("bjh_ads_volume", "BJH 흡착 누적 기공 부피", "cm³/g", "BJH Adsorption cumulative volume (보고서의 직경 범위 기준)"),
    _f("bjh_des_volume", "BJH 탈착 누적 기공 부피", "cm³/g", "BJH Desorption cumulative volume"),
    _f("bjh_ads_pore_size", "BJH 흡착 평균 기공 직경", "nm", "BJH Adsorption average pore diameter (4V/A)"),
    _f("hk_max_volume", "HK 최대 기공 부피", "cm³/g", "Horvath–Kawazoe 최대 기공 부피 (미세기공)"),
    _f("hk_median_width", "HK 중간 기공 폭", "nm", "Horvath–Kawazoe median pore width"),
]
BET_V2_METRICS = BET_V2_FIELDS + [
    _f("micro_area_ratio", "미세기공 면적 비율", "%", "t-plot 미세기공 면적 / BET 비표면적 × 100 (앱 계산)"),
    _f("bet_c_report", "BET C (보고서)", "", "보고서 BET 계산의 C 값", 1),
]
NONMETALS = ["H", "He", "C", "N", "O", "F", "Ne", "P", "S", "Cl", "Ar", "Se", "Br", "Kr", "I", "Xe"]


def seed_v2(conn):
    """BET 항목 추가, XRF Metal basis 설정. 기존 정의는 보존하고 없는 키만 덧붙인다."""
    r = conn.execute("SELECT config_json FROM analysis_types WHERE code='BET'").fetchone()
    if r:
        cfg = json.loads(r[0])
        for key, extra in (("fields", BET_V2_FIELDS), ("metrics", BET_V2_METRICS)):
            have = {x["key"] for x in cfg.get(key, [])}
            cfg.setdefault(key, []).extend(x for x in extra if x["key"] not in have)
        for key in ("fields", "metrics"):  # 부피(cm³/g)는 소수 넷째 자리로 표시
            for f in cfg.get(key, []):
                if f.get("unit") == "cm³/g":
                    f["decimals"] = 4
        cfg.setdefault("default_conditions", {}).setdefault("degas", {"value": "", "unit": "", "label": "전처리(탈기) 조건"})
        conn.execute("UPDATE analysis_types SET config_json=? WHERE code='BET'", (json.dumps(cfg, ensure_ascii=False),))
    r = conn.execute("SELECT config_json FROM analysis_types WHERE code='XRF'").fetchone()
    if r:
        cfg = json.loads(r[0])
        cfg.setdefault("purity_basis", "metal")
        cfg.setdefault("metal_basis_exclude", NONMETALS)
        for m in cfg.get("metrics", []):
            if m.get("key") == "purity":
                m["label"] = "순도 (Metal basis)"
                m["help"] = "주성분 / (주성분 + 금속 불순물 합) × 100. Cl·I·S 등 비금속 원소는 제외"
        conn.execute("UPDATE analysis_types SET config_json=? WHERE code='XRF'", (json.dumps(cfg, ensure_ascii=False),))


def _read_sql(name):
    with open(os.path.join(MIGRATION_DIR, name), encoding="utf-8") as f:
        return f.read()


# (버전, 설명, SQL 파일, 후처리 함수)
MIGRATIONS = [
    (1, "초기 스키마", "001_initial.sql", seed_v1),
    (2, "BET 항목 확장 · XRF Metal basis 순도 설정", "002_bet_xrf_config.sql", seed_v2),
]
LATEST_VERSION = MIGRATIONS[-1][0]


def schema_version(conn):
    try:
        row = conn.execute("SELECT value FROM schema_meta WHERE key='schema_version'").fetchone()
        return int(row[0]) if row else 0
    except sqlite3.OperationalError:
        return 0


def _apply(conn, migrations):
    for ver, desc, sqlfile, post in migrations:
        conn.execute("BEGIN")
        try:
            for stmt in _split_sql(_read_sql(sqlfile)):
                conn.execute(stmt)
            if post:
                post(conn)
            conn.execute("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('schema_version',?)", (str(ver),))
            conn.execute("INSERT INTO audit_log(ts,entity,entity_id,action,after_json) VALUES(?,?,?,?,?)",
                         (now(), "schema", ver, "migrate", json.dumps({"description": desc}, ensure_ascii=False)))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise


def _split_sql(sql):
    # 주석 제거 후 ; 기준으로 분할 (트리거 등 복합 문은 아직 사용하지 않음)
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    out = []
    for part in "\n".join(lines).split(";"):
        part = part.strip()
        if part:
            out.append(part)
    return out


def table_counts(conn):
    names = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    return {n: conn.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0] for n in names}


def integrity(conn):
    return conn.execute("PRAGMA integrity_check").fetchone()[0]


def migrate(log=print):
    """필요한 마이그레이션을 사본 검증 → 백업 → 적용 순서로 실행한다."""
    ensure_dirs()
    fresh = not os.path.exists(DB_PATH)
    conn = connect()
    conn.isolation_level = None
    try:
        ver = schema_version(conn)
        pending = [m for m in MIGRATIONS if m[0] > ver]
        if not pending:
            return {"applied": [], "version": ver}
        if fresh or ver == 0 and not table_counts(conn):
            _apply(conn, pending)
            return {"applied": [m[0] for m in pending], "version": LATEST_VERSION, "fresh": True}
        before = table_counts(conn)
    finally:
        conn.close()

    # 1) 사본에서 검증
    test_path = DB_PATH + ".migtest"
    if os.path.exists(test_path):
        os.remove(test_path)
    _backup_file(DB_PATH, test_path)
    t = connect(test_path)
    t.isolation_level = None
    try:
        _apply(t, pending)
        if integrity(t) != "ok":
            raise RuntimeError("마이그레이션 사본 무결성 검사 실패")
        after = table_counts(t)
        lost = {k: (v, after.get(k)) for k, v in before.items() if k != "audit_log" and after.get(k, -1) < v}
        if lost:
            raise RuntimeError(f"마이그레이션 사본에서 행 수 감소: {lost}")
    finally:
        t.close()
        os.remove(test_path)
    # 2) 원본 백업
    b = make_backup(reason=f"마이그레이션 전 자동 백업 (v{ver} → v{LATEST_VERSION})")
    if not b["verified"]:
        raise RuntimeError("마이그레이션 전 백업 검증 실패: 적용을 중단합니다")
    # 3) 원본 적용
    conn = connect()
    conn.isolation_level = None
    try:
        _apply(conn, pending)
    finally:
        conn.close()
    log(f"[Pattern Seeker] 스키마 v{ver} → v{LATEST_VERSION} 적용, 백업: {b['name']}")
    return {"applied": [m[0] for m in pending], "version": LATEST_VERSION, "backup": b["name"]}


# ---------------------------------------------------------------- 백업 / 복구
def _backup_file(src_path, dst_path):
    src = sqlite3.connect(src_path)
    dst = sqlite3.connect(dst_path)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()


def verify_backup(path, expect_counts=None):
    res = {"path": path, "ok": False}
    try:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            res["integrity"] = integrity(c)
            res["schema_version"] = schema_version(c)
            res["counts"] = table_counts(c)
        finally:
            c.close()
        res["ok"] = res["integrity"] == "ok"
        if expect_counts is not None:
            diff = {k: (v, res["counts"].get(k)) for k, v in expect_counts.items() if res["counts"].get(k) != v}
            res["count_diff"] = diff
            res["ok"] = res["ok"] and not diff
    except Exception as e:  # noqa: BLE001
        res["error"] = str(e)
    return res


def make_backup(reason="수동 백업"):
    ensure_dirs()
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    name = f"ps_{stamp}.db"
    path = os.path.join(BACKUP_DIR, name)
    c = connect()
    try:
        live_counts = table_counts(c)
    finally:
        c.close()
    _backup_file(DB_PATH, path)
    v = verify_backup(path, live_counts)
    meta = {"name": name, "created_at": now(), "reason": reason, "verified": v["ok"],
            "integrity": v.get("integrity"), "schema_version": v.get("schema_version"),
            "counts": v.get("counts"), "size": os.path.getsize(path)}
    with open(path + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    return meta


def list_backups():
    ensure_dirs()
    out = []
    for fn in sorted(os.listdir(BACKUP_DIR), reverse=True):
        if not fn.endswith(".db"):
            continue
        meta = {"name": fn, "size": os.path.getsize(os.path.join(BACKUP_DIR, fn))}
        mp = os.path.join(BACKUP_DIR, fn + ".json")
        if os.path.exists(mp):
            try:
                with open(mp, encoding="utf-8") as f:
                    meta.update(json.load(f))
            except Exception:  # noqa: BLE001
                meta["meta_error"] = True
        out.append(meta)
    return out


def _safe_backup_path(name):
    if not name or "/" in name or "\\" in name or not name.endswith(".db"):
        raise ValueError("잘못된 백업 이름")
    p = os.path.join(BACKUP_DIR, name)
    if not os.path.exists(p):
        raise FileNotFoundError(name)
    return p


def restore_backup(name):
    """백업 검증 → 현재 DB 백업 → 덮어쓰기 → 복구 결과 검증."""
    path = _safe_backup_path(name)
    v = verify_backup(path)
    if not v["ok"]:
        raise RuntimeError(f"백업 파일 검증 실패: {v.get('integrity') or v.get('error')}")
    safety = make_backup(reason=f"복구 직전 자동 백업 ({name} 로 복구하기 전)")
    _backup_file(path, DB_PATH)
    after = verify_backup(DB_PATH, v["counts"])
    result = {"restored": name, "safety_backup": safety["name"], "verified": after["ok"],
              "count_diff": after.get("count_diff"), "integrity": after.get("integrity")}
    if v.get("schema_version", 0) < LATEST_VERSION:
        result["migration"] = migrate()
    return result
