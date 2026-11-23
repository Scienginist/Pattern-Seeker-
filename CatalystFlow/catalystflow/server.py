"""로컬 전용 HTTP 계층(127.0.0.1). 화면(JS)과 업무 규칙(services)을 잇기만 한다."""
from __future__ import annotations

import datetime as dt
import json
import logging
import mimetypes
import secrets
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import __version__, paths
from . import services as S
from .db import Database
from .errors import ConflictError, UserError

log = logging.getLogger("catalystflow")


class App:
    def __init__(self, db: Database, web_dir: Path | None = None, user_backup_dir: Path | None = None):
        self.db = db
        self.web = Path(web_dir or paths.web_dir())
        self.token = secrets.token_urlsafe(24)
        self.user_backup_dir = Path(user_backup_dir or paths.user_backup_default_dir())

    # ---------------- GET ----------------
    def get(self, path: str, qs: dict):
        db = self.db
        one = lambda k, d=None: (qs.get(k) or [d])[0]
        parts = [p for p in path.split("/") if p][1:]  # api/...
        name = parts[0] if parts else ""
        if name == "info":
            return {"version": __version__, "data_dir": str(db.path.parent), "db_path": str(db.path),
                    "backups_dir": str(db.backups_dir), "user_backup_dir": str(self.user_backup_dir),
                    "today": dt.date.today().isoformat()}
        if name == "dashboard":
            return S.dashboard(db)
        if name == "batches":
            return S.batches_list(db, one("status", "active"))
        if name == "batch":
            return S.batch_detail(db, int(parts[1]))
        if name == "raw":
            return S.raw_stock(db, include_deleted=one("deleted") == "1")
        if name == "products":
            return S.products_list(db)
        if name == "qc":
            return S.qc_board(db)
        if name == "lineage":
            return S.lineage(db, int(parts[1]))
        if name == "ancestor_qc":
            return S.ancestor_qc(db, int(parts[1]))
        if name == "audit":
            return S.audit(db, batch_id=one("batch_id"), entity=one("entity"), entity_id=one("entity_id"))
        if name == "drafts":
            return S.list_drafts(db)
        if name == "draft":
            return S.get_draft(db, one("key"))
        if name == "preview_split":
            q = one("quantities")
            return S.step_preview_split(db, int(one("source")), one("count"), one("per"),
                                        json.loads(q) if q else None)
        if name == "backups":
            out = []
            for d in (db.backups_dir, self.user_backup_dir):
                if d.exists():
                    for f in sorted(d.glob("*.cfdb"), key=lambda p: p.stat().st_mtime, reverse=True)[:40]:
                        out.append({"path": str(f), "name": f.name, "size": f.stat().st_size,
                                    "mtime": dt.datetime.fromtimestamp(f.stat().st_mtime).isoformat(sep=" ")[:19],
                                    "auto": d == db.backups_dir})
            return out
        raise UserError("알 수 없는 요청입니다.", code="not_found")

    # ---------------- POST ----------------
    def post(self, path: str, body: dict):
        db = self.db
        parts = [p for p in path.split("/") if p][1:]
        name = parts[0] if parts else ""
        if name == "cmd":
            cmd = S.COMMANDS.get(parts[1])
            if not cmd:
                raise UserError("알 수 없는 명령입니다.", code="not_found")
            return cmd(db, body.get("payload") or {}, op_id=body.get("op_id"))
        if name == "draft":
            if parts[1:] == ["delete"]:
                return S.delete_draft(db, body["key"])
            return S.save_draft(db, body.get("key"), body.get("action"), body.get("payload") or {},
                                body.get("batch_id"), body.get("branch_id"), body.get("step_ref"),
                                body.get("title") or "")
        if name == "backup":
            target = body.get("path")
            if target:
                p = Path(target)
                if p.is_dir() or not p.suffix:
                    p = p / f"CatalystFlow-{dt.datetime.now():%Y%m%d-%H%M%S}.cfdb"
            else:
                p = self.user_backup_dir / f"CatalystFlow-{dt.datetime.now():%Y%m%d-%H%M%S}.cfdb"
            out = db.backup_to(p)
            return {"path": str(out)}
        if name == "restore":
            if not body.get("path"):
                raise UserError("복원할 백업 파일을 선택하세요.")
            return db.restore_from(Path(body["path"]))
        raise UserError("알 수 없는 요청입니다.", code="not_found")


def make_handler(app: App):
    class H(BaseHTTPRequestHandler):
        server_version = "CatalystFlow"

        def log_message(self, fmt, *args):  # 콘솔 소음 억제
            log.debug(fmt, *args)

        def _send(self, code, obj=None, raw: bytes | None = None, ctype="application/json; charset=utf-8"):
            data = raw if raw is not None else json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            return secrets.compare_digest(self.headers.get("X-CF-Token", ""), app.token)

        def _run(self, fn):
            try:
                if not self._authorized():
                    return self._send(403, {"error": "허용되지 않은 요청입니다."})
                return self._send(200, fn())
            except ConflictError as e:
                return self._send(409, {"error": e.message, "code": e.code, "details": e.details})
            except UserError as e:
                return self._send(400, {"error": e.message, "code": e.code, "details": e.details})
            except Exception as e:  # 예기치 못한 오류: 트랜잭션은 이미 롤백됨
                log.error("unhandled: %s\n%s", e, traceback.format_exc())
                return self._send(500, {"error": f"저장하지 못했습니다(내부 오류: {e}). 입력 내용은 그대로 남아 있습니다.",
                                        "code": "internal"})

        def do_GET(self):
            u = urlparse(self.path)
            if u.path.startswith("/api/"):
                return self._run(lambda: app.get(u.path, parse_qs(u.query)))
            rel = "index.html" if u.path in ("/", "") else u.path.lstrip("/")
            f = (app.web / rel).resolve()
            if not str(f).startswith(str(app.web.resolve())) or not f.is_file():
                return self._send(404, {"error": "not found"})
            data = f.read_bytes()
            if rel == "index.html":
                data = data.replace(b"__CF_TOKEN__", app.token.encode())
            ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            return self._send(200, raw=data, ctype=ctype)

        def do_POST(self):
            u = urlparse(self.path)
            n = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"error": "잘못된 요청 형식"})
            return self._run(lambda: app.post(u.path, body))

    return H


def serve(app: App, port: int = 0) -> tuple[ThreadingHTTPServer, threading.Thread]:
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    httpd.daemon_threads = True
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, t
