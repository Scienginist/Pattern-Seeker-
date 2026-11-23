@echo off
REM 소스에서 바로 실행(파이썬 3.10+ 필요). 설치형 실행 파일은 CatalystFlow.exe 를 사용하세요.
cd /d "%~dp0"
py -3 -c "import webview" 2>nul || py -3 -m pip install --user -r requirements.txt
py -3 -m catalystflow
