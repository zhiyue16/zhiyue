@echo off
chcp 65001 >nul
cd /d %~dp0
git add -A
git commit -m "更新专注计时器"
git push origin main
echo.
echo ======== 更新完成，Vercel 自动部署中 ========
pause
