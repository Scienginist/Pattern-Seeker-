"""CatalystFlow 실행 진입점.

- 로컬 서버(127.0.0.1)를 띄우고 pywebview(Windows: Edge WebView2) 창으로 화면을 연다.
- pywebview가 없으면 Edge/Chrome 앱 모드 → 기본 브라우저 순으로 연다.
- 인터넷 연결이 필요 없다.
"""
from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

from . import paths
from .db import Database
from .server import App, serve

log = logging.getLogger("catalystflow")
KEEP_AUTO_BACKUPS = 30


def _setup_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(paths.logs_dir() / "catalystflow.log", encoding="utf-8")],
    )


def _single_instance_lock():
    f = open(paths.data_dir() / ".lock", "a+")
    try:
        if sys.platform.startswith("win"):
            import msvcrt
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return None
    return f


def _daily_backup(db: Database):
    """하루 한 번 시작 시 자동 백업. 오래된 자동 백업은 일정 개수만 남긴다."""
    today = dt.date.today().strftime("%Y%m%d")
    existing = list(db.backups_dir.glob(f"auto-daily-{today}-*.cfdb"))
    if not existing:
        db.auto_backup("daily")
    autos = sorted(db.backups_dir.glob("auto-daily-*.cfdb"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in autos[KEEP_AUTO_BACKUPS:]:
        old.unlink(missing_ok=True)


def _app_mode_browser(url: str) -> bool:
    cands = []
    if sys.platform.startswith("win"):
        pf = [os.environ.get("ProgramFiles(x86)", ""), os.environ.get("ProgramFiles", ""),
              os.environ.get("LOCALAPPDATA", "")]
        for base in pf:
            cands += [Path(base) / "Microsoft/Edge/Application/msedge.exe",
                      Path(base) / "Google/Chrome/Application/chrome.exe"]
    else:
        for n in ("chromium", "chromium-browser", "google-chrome", "microsoft-edge"):
            w = shutil.which(n)
            if w:
                cands.append(Path(w))
    for c in cands:
        if c.exists():
            subprocess.Popen([str(c), f"--app={url}", "--window-size=1400,900"])
            return True
    return False


def main(argv=None):
    ap = argparse.ArgumentParser(prog="CatalystFlow")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--no-window", action="store_true", help="서버만 실행(테스트용)")
    ap.add_argument("--browser", action="store_true", help="pywebview 대신 브라우저로 열기")
    args = ap.parse_args(argv)

    _setup_logging()
    lock = _single_instance_lock()
    if lock is None:
        msg = "CatalystFlow가 이미 실행 중입니다. 열려 있는 창을 사용하세요."
        print(msg)
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, msg, "CatalystFlow", 0x40)
        except Exception:
            pass
        return 1

    db = Database(paths.db_path(), paths.backups_dir())
    try:
        _daily_backup(db)
    except Exception as e:
        log.warning("daily backup failed: %s", e)
    app = App(db)
    httpd, _ = serve(app, args.port)
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    log.info("CatalystFlow at %s data=%s", url, db.path)
    print(f"CatalystFlow: {url}\n데이터 위치: {db.path}")

    try:
        if args.no_window:
            while True:
                time.sleep(3600)
        webview = None
        if not args.browser:
            try:
                import webview  # type: ignore
            except Exception:
                webview = None
        if webview is not None:
            win = webview.create_window("CatalystFlow", url, width=1440, height=920, min_size=(1000, 680),
                                        text_select=True)

            def on_closing():
                # 종료 직전 마지막 초안 저장(입력 0.5초마다 자동저장되므로 보조 장치). 최대 3초만 기다린다.
                import threading

                def flush():
                    try:
                        win.evaluate_js("window.cfBeforeClose && window.cfBeforeClose()")
                    except Exception as e:
                        log.warning("flush drafts on close failed: %s", e)
                t = threading.Thread(target=flush, daemon=True)
                t.start()
                t.join(3)
                return True

            win.events.closing += on_closing
            webview.start(private_mode=False)
        else:
            if not _app_mode_browser(url):
                webbrowser.open(url)
            print("창을 닫은 뒤 이 콘솔에서 Ctrl+C 로 종료하세요.")
            while True:
                time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
