@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PY="
where py >/dev/null 2>/dev/null && set "PY=py -3"
if not defined PY where python >/dev/null 2>/dev/null && set "PY=python"
if not defined PY (
  echo [Pattern Seeker] Python 3.8 이상이 필요합니다. python.org 에서 설치하세요 ^(설치 시 "Add python.exe to PATH" 체크^).
  pause
  exit /b 1
)
echo [Pattern Seeker] 서버를 시작합니다. 이 창을 닫으면 앱이 종료됩니다.
%PY% app\server.py
pause
