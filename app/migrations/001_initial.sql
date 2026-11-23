-- Pattern Seeker schema v1
-- 원칙: 원본 기록(values/datasets), 계산값(computed), 사용자 해석, AI 가설을 서로 다른 칸/테이블에 저장한다.
-- 측정되지 않은 값은 NULL(또는 키 없음)로 둔다. 0으로 채우지 않는다.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 최종 분말 단위의 샘플
CREATE TABLE samples (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  color          TEXT NOT NULL,              -- 모든 그래프에서 동일하게 쓰는 샘플 색
  synthesized_on TEXT,                       -- YYYY-MM-DD
  description    TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT                        -- 소프트 삭제(휴지통)
);

-- 파생·분기·결합 관계 (다대다 DAG). 시리즈 분류와는 별개.
CREATE TABLE sample_links (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER NOT NULL REFERENCES samples(id),
  child_id   INTEGER NOT NULL REFERENCES samples(id),
  relation   TEXT NOT NULL DEFAULT '파생',  -- 파생 / 분기 / 결합 / 재처리 / 기타
  branch_point TEXT NOT NULL DEFAULT '',     -- 어느 단계에서 갈라졌는가 (예: 프리커서, 열처리 후)
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(parent_id, child_id),
  CHECK(parent_id <> child_id)
);

CREATE TABLE series (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE series_members (
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  sample_id INTEGER NOT NULL REFERENCES samples(id),
  PRIMARY KEY(series_id, sample_id)
);

-- 합성 단계. params_json = {키: {value, unit, source: default|user|file}}
CREATE TABLE synthesis_steps (
  id          INTEGER PRIMARY KEY,
  sample_id   INTEGER NOT NULL REFERENCES samples(id),
  seq         INTEGER NOT NULL,
  step_type   TEXT NOT NULL,                 -- 시약 혼합 / 열처리 / 세척 / 건조 / 분기 후 처리 / 기타
  title       TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE reagents (
  id              INTEGER PRIMARY KEY,
  step_id         INTEGER NOT NULL REFERENCES synthesis_steps(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  amount          REAL,
  unit            TEXT NOT NULL DEFAULT '',
  supplier        TEXT NOT NULL DEFAULT 'H사',
  supplier_source TEXT NOT NULL DEFAULT 'default',   -- default | user
  lot             TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT ''
);

-- 분석 종류 레지스트리 (화면 코드와 분리된 데이터 정의)
CREATE TABLE analysis_types (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  group_name  TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 100,
  active      INTEGER NOT NULL DEFAULT 1,
  builtin     INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}'    -- fields, metrics, default_conditions
);

-- 샘플별 분석 상태. 행이 없으면 '미업로드'.
CREATE TABLE sample_analysis_status (
  sample_id     INTEGER NOT NULL REFERENCES samples(id),
  analysis_code TEXT NOT NULL REFERENCES analysis_types(code),
  status        TEXT NOT NULL CHECK(status IN ('자료 있음','자료 없음','계획 없음','의뢰 중','미업로드')),
  note          TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL,
  PRIMARY KEY(sample_id, analysis_code)
);

-- 전기화학 전극/세션 정보. 측정 시 conditions 에 스냅샷으로 고정되는 항목과
-- 세션을 따라 바뀌는 항목(live)을 앱에서 구분한다.
CREATE TABLE ec_sessions (
  id          INTEGER PRIMARY KEY,
  sample_id   INTEGER NOT NULL REFERENCES samples(id),
  name        TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 측정 기록
--   conditions_json : 측정 조건 {키:{value,unit,source}}
--   values_json     : 보고서/입력/추출 값 {키:{value,unit,source,...}} 또는 분석별 구조
--   computed_json   : 앱 계산값 {metrics:{키:{value,unit,formula,inputs}}, details:{...}}
--   source_json     : 출처 {file_name, method: manual|paste|pdf_text|ocr, edited:bool, ...}
CREATE TABLE measurements (
  id                 INTEGER PRIMARY KEY,
  sample_id          INTEGER NOT NULL REFERENCES samples(id),
  analysis_code      TEXT NOT NULL REFERENCES analysis_types(code),
  ec_session_id      INTEGER REFERENCES ec_sessions(id),
  seq                INTEGER,                -- 측정 순서 (전기화학 등)
  title              TEXT NOT NULL DEFAULT '',
  measured_on        TEXT,
  measured_on_source TEXT NOT NULL DEFAULT 'none',  -- user | file | none
  conditions_json    TEXT NOT NULL DEFAULT '{}',
  values_json        TEXT NOT NULL DEFAULT '{}',
  computed_json      TEXT NOT NULL DEFAULT '{}',
  source_json        TEXT NOT NULL DEFAULT '{}',
  notes              TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);

-- 원시 곡선 데이터 (XY, TGA, CV ...). 원본은 그대로 보존하고 처리 조건은 meta 에 둔다.
CREATE TABLE datasets (
  id             INTEGER PRIMARY KEY,
  measurement_id INTEGER NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
  name           TEXT NOT NULL DEFAULT '',
  columns_json   TEXT NOT NULL DEFAULT '[]',
  data_json      TEXT NOT NULL DEFAULT '[]',  -- 열 배열들: [[x...],[y...],...]
  meta_json      TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);

-- 첨부: link(경로만 저장) 또는 copy(앱 폴더로 복사)
CREATE TABLE attachments (
  id             INTEGER PRIMARY KEY,
  sample_id      INTEGER REFERENCES samples(id),
  measurement_id INTEGER REFERENCES measurements(id),
  mode           TEXT NOT NULL CHECK(mode IN ('link','copy')),
  original_path  TEXT NOT NULL DEFAULT '',
  stored_path    TEXT NOT NULL DEFAULT '',
  file_name      TEXT NOT NULL,
  size           INTEGER,
  mtime          REAL,
  sha256         TEXT,
  role           TEXT NOT NULL DEFAULT '원본',  -- 원본 / 보고서 그래프 / 기타
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);

-- 사용자 해석과 AI 가설은 같은 테이블이지만 kind 로 엄격히 구분한다.
CREATE TABLE interpretations (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK(kind IN ('user_interpretation','ai_hypothesis')),
  sample_id      INTEGER REFERENCES samples(id),
  measurement_id INTEGER REFERENCES measurements(id),
  text           TEXT NOT NULL,
  evidence_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

-- 변경 이력: 수정/삭제 전 상태를 남겨 덮어쓰기 손실을 막는다.
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  action     TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT
);

CREATE INDEX idx_links_child ON sample_links(child_id);
CREATE INDEX idx_links_parent ON sample_links(parent_id);
CREATE INDEX idx_steps_sample ON synthesis_steps(sample_id, seq);
CREATE INDEX idx_meas_sample ON measurements(sample_id, analysis_code);
CREATE INDEX idx_datasets_meas ON datasets(measurement_id);
CREATE INDEX idx_att_meas ON attachments(measurement_id);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
