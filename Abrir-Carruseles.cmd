@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Un solo comando: se actualiza solo, abre Chrome y arranca la app.
call npm run abrir
echo.
echo (La app se detuvo. Podes cerrar esta ventana.)
pause
