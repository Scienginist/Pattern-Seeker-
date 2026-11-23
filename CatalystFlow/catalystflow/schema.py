"""CatalystFlow SQLite schema.

설계 원칙
- 질량은 g 단위 REAL. NULL = 미측정(0과 구분).
- qty_kind: measured(실측) / estimated(추정) / calculated(계산) / planned(계획) / unknown(미측정)
- 모든 편집 가능한 행은 version 컬럼으로 낙관적 잠금(오래 열린 창의 덮어쓰기 방지).
- ops 테이블: 클라이언트가 보낸 op_id로 중복 실행(더블클릭·재시도)을 막는다.
- audit_log: 수정 전/후 값을 JSON으로 보존.
"""

SCHEMA_VERSION = 1
APP_ID = "CatalystFlow"

SCHEMA_V1 = r"""
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS raw_materials (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_lots (
    id INTEGER PRIMARY KEY,
    raw_material_id INTEGER NOT NULL REFERENCES raw_materials(id),
    lot_code TEXT NOT NULL,
    received_date TEXT,              -- YYYY-MM-DD, NULL=미기록
    received_qty_g REAL NOT NULL,
    supplier TEXT DEFAULT '',
    note TEXT DEFAULT '',
    deleted_at TEXT,                 -- 휴지통(복원 가능)
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

-- 원료 원장: 잔량 = 입고 + SUM(delta) (투입은 음수, 정정은 +/-)
CREATE TABLE IF NOT EXISTS raw_ledger (
    id INTEGER PRIMARY KEY,
    lot_id INTEGER NOT NULL REFERENCES raw_lots(id),
    kind TEXT NOT NULL CHECK (kind IN ('consume','adjust')),
    delta_g REAL NOT NULL,
    step_id INTEGER REFERENCES steps(id),
    batch_id INTEGER REFERENCES batches(id),
    at TEXT,                         -- 실제 일시(모르면 NULL)
    note TEXT DEFAULT '',
    voided_at TEXT,                  -- 잘못된 기록 취소(행은 보존)
    void_reason TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    title TEXT DEFAULT '',
    purpose TEXT DEFAULT '',
    common_conditions TEXT DEFAULT '',
    note TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','trashed')),
    trashed_from TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('production','research','exception')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','paused','dropped')),
    condition_diff TEXT DEFAULT '',  -- 공통 조건 대비 달라진 조건
    note TEXT DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

-- 공정: 계획과 실행을 한 행에. status로 단계 구분.
CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    kind TEXT NOT NULL DEFAULT 'process'
        CHECK (kind IN ('process','charge','split','merge','move','reprocess')),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned','in_progress','paused','done','cancelled')),
    planned_conditions TEXT DEFAULT '',
    scheduled_date TEXT,             -- 사용자가 직접 지정한 작업 예정일
    expected_hours REAL,
    actual_start TEXT,               -- NULL = 미기록
    actual_end TEXT,
    operator TEXT DEFAULT '',
    equipment TEXT DEFAULT '',
    actual_conditions TEXT DEFAULT '',
    observations TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS step_events (
    id INTEGER PRIMARY KEY,
    step_id INTEGER NOT NULL REFERENCES steps(id),
    event TEXT NOT NULL CHECK (event IN ('start','pause','resume','complete','cancel','reopen')),
    at TEXT,                         -- 실제 시각(모르면 NULL)
    note TEXT DEFAULT '',
    recorded_at TEXT NOT NULL
);

-- 물질 단위: 슬러리, 도가니별 내용물, 세척 케이크, 분말 등
CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    label TEXT NOT NULL,
    form TEXT DEFAULT '',            -- 슬러리 / 분말 / 케이크 / 용액 ...
    container TEXT DEFAULT '',
    mass_basis TEXT NOT NULL DEFAULT 'unspecified'
        CHECK (mass_basis IN ('slurry_total','wet','dry','as_is','unspecified')),
    qty_g REAL,                      -- NULL = 미측정
    qty_kind TEXT NOT NULL DEFAULT 'unknown'
        CHECK (qty_kind IN ('measured','estimated','calculated','planned','unknown')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','consumed','voided')),
    tag TEXT DEFAULT '',             -- 예: 정상군 / 확인군
    note TEXT DEFAULT '',
    created_step_id INTEGER REFERENCES steps(id),
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

-- 공정-물질 연결. role: in(소비/일부 사용), out(산출), through(제자리 처리: 정체성 유지)
CREATE TABLE IF NOT EXISTS step_io (
    id INTEGER PRIMARY KEY,
    step_id INTEGER NOT NULL REFERENCES steps(id),
    material_id INTEGER NOT NULL REFERENCES materials(id),
    role TEXT NOT NULL CHECK (role IN ('in','out','through')),
    qty_g REAL,                      -- in: 가져간 양(NULL=전량/미측정), out: 산출량
    qty_kind TEXT NOT NULL DEFAULT 'unknown',
    full_use INTEGER NOT NULL DEFAULT 1,   -- in: 1이면 물질 전체 사용(소비 처리)
    prev_qty_g REAL,                 -- in: 연결 직전 물질 질량(정정 시 정확한 복원용)
    prev_qty_kind TEXT,
    prev_status TEXT,
    prev_form TEXT,
    prev_basis TEXT,
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (step_id, material_id, role)
);

-- 가지 이동 이력(이동은 소분이 아님)
CREATE TABLE IF NOT EXISTS material_moves (
    id INTEGER PRIMARY KEY,
    material_id INTEGER NOT NULL REFERENCES materials(id),
    from_branch_id INTEGER NOT NULL,
    to_branch_id INTEGER NOT NULL,
    reason TEXT DEFAULT '',
    op_id TEXT,
    at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    material_id INTEGER NOT NULL UNIQUE REFERENCES materials(id),  -- 이중 입고 방지
    code TEXT NOT NULL UNIQUE,
    name TEXT DEFAULT '',
    registered_date TEXT,
    initial_qty_g REAL,              -- NULL = 미측정(나중에 실측 입력)
    initial_qty_kind TEXT NOT NULL DEFAULT 'unknown',
    note TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_usages (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    purpose TEXT NOT NULL CHECK (purpose IN ('ship','qc','internal','research','reprocess','adjust')),
    qty_g REAL NOT NULL,
    used_date TEXT,
    destination TEXT DEFAULT '',
    note TEXT DEFAULT '',
    reprocess_material_id INTEGER REFERENCES materials(id),
    voided_at TEXT,
    void_reason TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qc_items (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    material_id INTEGER NOT NULL REFERENCES materials(id),   -- 측정 대상 물질
    product_id INTEGER REFERENCES products(id),              -- 제품 판정용이면 설정
    test TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 0,
    internal INTEGER NOT NULL DEFAULT 0,  -- 내부 측정(과전압·pH): 측정일 직접 일정
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned','requested','received','cancelled')),
    scheduled_date TEXT,             -- 내부 측정 예정일
    requested_date TEXT,
    expected_date TEXT,              -- 회신 예상일
    measured_date TEXT,              -- 확인된 경우만
    received_date TEXT,
    result_summary TEXT DEFAULT '',
    evidence_path TEXT DEFAULT '',   -- 원본 파일은 경로로 연결(복사하지 않음)
    representative INTEGER,          -- NULL=미확인, 1=최종 산물 대표 확인, 0=대표 아님
    representative_note TEXT DEFAULT '',
    source_qc_id INTEGER REFERENCES qc_items(id), -- 이전 산물 결과를 사용자가 인정한 경우
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS qc_decisions (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    decision TEXT NOT NULL CHECK (decision IN ('pass','fail','hold')),
    reason TEXT DEFAULT '',
    decided_date TEXT,
    voided_at TEXT,
    void_reason TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
    draft_key TEXT PRIMARY KEY,      -- batch|branch|step|action
    batch_id INTEGER,
    branch_id INTEGER,
    step_ref TEXT,
    action TEXT NOT NULL,
    title TEXT DEFAULT '',
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    batch_id INTEGER,
    action TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    reason TEXT DEFAULT '',
    op_id TEXT
);

CREATE TABLE IF NOT EXISTS ops (
    op_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    result_json TEXT,
    at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_steps_batch ON steps(batch_id, branch_id);
CREATE INDEX IF NOT EXISTS ix_io_step ON step_io(step_id);
CREATE INDEX IF NOT EXISTS ix_io_mat ON step_io(material_id);
CREATE INDEX IF NOT EXISTS ix_mat_batch ON materials(batch_id, branch_id);
CREATE INDEX IF NOT EXISTS ix_ledger_lot ON raw_ledger(lot_id);
CREATE INDEX IF NOT EXISTS ix_qc_mat ON qc_items(material_id);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS ix_audit_batch ON audit_log(batch_id);
"""

# 앞으로 스키마가 바뀌면 (from_version -> SQL) 을 여기에 추가한다.
MIGRATIONS: dict[int, str] = {}

REQUIRED_PRODUCT_QC = ["XRD", "BET", "과전압", "pH", "TGA", "XRF"]
INTERNAL_QC = {"과전압", "pH"}
LONG_WAIT_QC = {"BET", "TGA"}
DEFAULT_RAW_MATERIALS = ["IrCl₃", "RuCl₃"]
