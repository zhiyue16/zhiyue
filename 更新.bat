@echo off
cd /d %~dp0
git add -A
git commit -m "update timer"
git push origin main
echo.
echo ======== DONE - Vercel deploying ========
pause
