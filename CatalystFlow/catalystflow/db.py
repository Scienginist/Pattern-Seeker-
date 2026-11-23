"""저장 계층: SQLite 연결, 트랜잭션, 스키마 이전(복사본에서 검증), 백업/복원."""
from __future__ import annotations

import contextlib
import datetime as _dt
import os
import shutil
import sqlite3
import threading
from pathlib import Path

from .errors import UserError
from .schema import APP_ID, MIGRATIONS, SCHEMA_V1, SCHEMA_VERSION, DEFAULT_RAW_MATERIALS


def now_iso() -> str:
    return _dt.datetime.now().replace(microsecond=0).isoformat(sep=" ")


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), isolation_level=None, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = FULL")
    return conn


def read_schema_version(conn: sqlite3.Connection) -> int | None:
    try:
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    except sqlite3.DatabaseError:
        return None
    return int(row[0]) if row else None


def verify_db_file(path: Path) -> tuple[bool, str]:
    """복원·이전 전에 파일이 온전한 CatalystFlow DB인지 확인."""
    if not path.exists() or path.stat().st_size == 0:
        return False, "파일이 없거나 비어 있습니다."
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            ok = conn.execute("PRAGMA integrity_check").fetchone()[0]
            if ok != "ok":
                return False, f"무결성 검사 실패: {ok}"
            app = conn.execute("SELECT value FROM meta WHERE key='app'").fetchone()
            if not app or app[0] != APP_ID:
                return False, "CatalystFlow 백업 파일이 아닙니다."
            ver = int(conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0])
            if ver > SCHEMA_VERSION:
                return False, f"더 새로운 버전(v{ver})의 데이터입니다. 앱을 먼저 업데이트하세요."
            return True, f"v{ver}"
        finally:
            conn.close()
    except sqlite3.DatabaseError as e:
        return False, f"SQLite 파일로 읽을 수 없습니다: {e}"


def _create_fresh(conn: sqlite3.Connection) -> None:
    conn.executescript("BEGIN;" + SCHEMA_V1 + "COMMIT;")
    ts = now_iso()
    conn.execute("BEGIN")
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('app',?)", (APP_ID,))
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('created_at',?)", (ts,))
    for name in DEFAULT_RAW_MATERIALS:
        conn.execute("INSERT OR IGNORE INTO raw_materials(name, created_at) VALUES(?,?)", (name, ts))
    conn.execute("COMMIT")


def _migrate_copy(path: Path, backups_dir: Path) -> None:
    """구버전 DB는 복사본에서 이전·검증한 뒤에만 교체한다. 실패하면 원본은 그대로."""
    src = sqlite3.connect(str(path))
    ver = read_schema_version(src)
    if ver is None or ver >= SCHEMA_VERSION:
        src.close()
        return
    work = path.with_suffix(".migrating")
    if work.exists():
        work.unlink()
    dst = sqlite3.connect(str(work))
    src.backup(dst)
    dst.execute("PRAGMA journal_mode=DELETE")
    src.close()
    try:
        for v in range(ver, SCHEMA_VERSION):
            dst.executescript("BEGIN;" + MIGRATIONS[v] + "COMMIT;")
            dst.execute("UPDATE meta SET value=? WHERE key='schema_version'", (str(v + 1),))
            dst.commit()
        dst.close()
        ok, msg = verify_db_file(work)
        if not ok:
            raise RuntimeError(msg)
        backups_dir.mkdir(parents=True, exist_ok=True)
        stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, backups_dir / f"before-migrate-v{ver}-{stamp}.cfdb")
        os.replace(work, path)
    except Exception:
        with contextlib.suppress(Exception):
            dst.close()
        with contextlib.suppress(Exception):
            work.unlink()
        raise


class Database:
    """하나의 연결을 잠금으로 직렬화한다(1인 사용 앱). 모든 쓰기는 tx() 안에서만."""

    def __init__(self, path: Path, backups_dir: Path | None = None):
        self.path = Path(path)
        self.backups_dir = Path(backups_dir) if backups_dir else self.path.parent / "backups"
        self.lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = self._open()

    def _open(self) -> sqlite3.Connection:
        fresh = not self.path.exists() or self.path.stat().st_size == 0
        if not fresh:
            _migrate_copy(self.path, self.backups_dir)
        conn = _connect(self.path)
        if fresh:
            _create_fresh(conn)
        return conn

    def close(self) -> None:
        with self.lock:
            with contextlib.suppress(Exception):
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.conn.close()

    # ---------- 조회 ----------
    def q(self, sql: str, params=()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def q1(self, sql: str, params=()) -> dict | None:
        with self.lock:
            r = self.conn.execute(sql, params).fetchone()
            return dict(r) if r else None

    # ---------- 트랜잭션 ----------
    @contextlib.contextmanager
    def tx(self):
        """전체 성공 또는 전체 취소."""
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            else:
                self.conn.execute("COMMIT")

    # ---------- 백업/복원 ----------
    def backup_to(self, dest: Path) -> Path:
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".partial")
        with self.lock:
            out = sqlite3.connect(str(tmp))
            try:
                self.conn.backup(out)
                out.execute("PRAGMA journal_mode=DELETE")  # 단일 파일로 보관
            finally:
                out.close()
        ok, msg = verify_db_file(tmp)
        if not ok:
            tmp.unlink(missing_ok=True)
            raise UserError(f"백업 파일 검증 실패: {msg}")
        os.replace(tmp, dest)
        return dest

    def auto_backup(self, reason: str) -> Path:
        stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        return self.backup_to(self.backups_dir / f"auto-{reason}-{stamp}.cfdb")

    def restore_from(self, src: Path) -> dict:
        """1) 후보 파일 검증 2) 현재 데이터 안전 백업 3) 복사본 이전·검증 4) 교체. 실패 시 원본 유지."""
        src = Path(src)
        ok, msg = verify_db_file(src)
        if not ok:
            raise UserError(f"복원할 수 없습니다: {msg} (현재 데이터는 그대로입니다)")
        with self.lock:
            safety = self.auto_backup("before-restore")
            staging = self.path.with_name("restore-staging.cfdb")
            staging.unlink(missing_ok=True)
            s = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
            d = sqlite3.connect(str(staging))
            try:
                s.backup(d)
                d.execute("PRAGMA journal_mode=DELETE")
            finally:
                s.close()
                d.close()
            try:
                _migrate_copy(staging, self.backups_dir)
                ok, msg = verify_db_file(staging)
                if not ok:
                    raise UserError(f"복원 준비 중 검증 실패: {msg}")
            except Exception:
                staging.unlink(missing_ok=True)
                raise
            # 교체: 현재 연결을 닫고 WAL까지 정리한 뒤 원자적 교체
            self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.conn.close()
            try:
                for suffix in ("-wal", "-shm"):
                    Path(str(self.path) + suffix).unlink(missing_ok=True)
                os.replace(staging, self.path)
            finally:
                self.conn = _connect(self.path)
        return {"safety_backup": str(safety), "restored_from": str(src)}
