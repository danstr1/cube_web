@echo off
taskkill /F /IM node.exe
cd /d C:\cube_web
node server.js
pause

