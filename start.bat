@echo off
cd /d "%~dp0"
echo Starting Skill Manager at http://127.0.0.1:7788
start "Skill Manager" /min node --experimental-strip-types src/server.ts
echo Server started. Open http://127.0.0.1:7788
