# PyInstaller 사양: Windows용 폴더형(onedir) 실행 파일. 운영 데이터는 포함하지 않는다(%LOCALAPPDATA%\CatalystFlow).
# 빌드: CatalystFlow 폴더에서  pyinstaller packaging/CatalystFlow.spec --noconfirm
from pathlib import Path

root = Path(SPECPATH).parent
a = Analysis(
    [str(root / "packaging" / "launch.py")],
    pathex=[str(root)],
    datas=[(str(root / "catalystflow" / "web"), "catalystflow/web")],
    hiddenimports=["webview"],
    excludes=["tkinter", "numpy", "pandas", "matplotlib", "PyQt5", "PySide6"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="CatalystFlow", console=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="CatalystFlow", upx=False)
