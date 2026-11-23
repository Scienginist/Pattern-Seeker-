"""운영 데이터 위치. 프로그램 설치 위치와 분리한다(업데이트해도 같은 데이터 사용)."""
import os
import sys
from pathlib import Path


def data_dir() -> Path:
    env = os.environ.get("CATALYSTFLOW_DATA")
    if env:
        p = Path(env)
    elif sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        p = Path(base) / "CatalystFlow"
    else:
        p = Path.home() / ".local" / "share" / "CatalystFlow"
    p.mkdir(parents=True, exist_ok=True)
    return p


def db_path() -> Path:
    return data_dir() / "catalystflow.db"


def backups_dir() -> Path:
    p = data_dir() / "backups"
    p.mkdir(parents=True, exist_ok=True)
    return p


def logs_dir() -> Path:
    p = data_dir() / "logs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def user_backup_default_dir() -> Path:
    docs = Path.home() / "Documents"
    return (docs if docs.exists() else Path.home()) / "CatalystFlow 백업"


def web_dir() -> Path:
    # PyInstaller로 묶였을 때도 동작
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    cand = base / "catalystflow" / "web"
    return cand if cand.exists() else Path(__file__).resolve().parent / "web"
