@echo off
rem Launch the function generator GUI (pc\fgen_gui.py)
cd /d "%~dp0pc"

where python >nul 2>nul
if errorlevel 1 (
    echo Python was not found. Please install Python 3 and add it to PATH.
    pause
    exit /b 1
)

rem Install pyserial on first run
python -c "import serial" >nul 2>nul
if errorlevel 1 (
    echo Installing pyserial...
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo Failed to install pyserial.
        pause
        exit /b 1
    )
)

rem pythonw = no console window
start "" pythonw fgen_gui.py
