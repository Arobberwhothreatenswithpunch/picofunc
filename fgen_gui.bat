@echo off
rem FuncGen PC app: serves web\ locally and opens it in a Chrome / Edge app window.
rem (The old tkinter GUI is still available: python pc\fgen_gui.py)
cd /d "%~dp0"

where pythonw >nul 2>nul
if errorlevel 1 (
    echo Python 3 was not found. Please install Python 3 and add it to PATH.
    pause
    exit /b 1
)

start "" pythonw pc\launch_web.py
