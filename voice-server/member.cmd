@echo off
REM Maintenance helper: manage members directly on the server.
REM
REM Usage (from the voice-server folder):
REM     member.cmd list
REM     member.cmd rename <userId> <newName>
REM     member.cmd promote <userId>
REM     member.cmd delete <userId>
REM
REM It runs src/fix-member.mjs on the server over ssh, so you will be
REM asked for the ssh password. Run deploy.cmd first at least once so
REM the tool exists on the server.
REM
REM NOTE: keep this file pure ASCII. Non-ASCII in a .cmd file breaks
REM under the default console code page.
REM
REM Working directory matters: the SQLite file lives at
REM /opt/voice-server/data/voice.db, so we cd to /opt/voice-server
REM (NOT into backend/, which would look in backend/data/ and fail).
REM
REM The first check turns a bare "Cannot find module" into a clear
REM instruction -- the tool only exists on the server after deploy.cmd.

ssh -p 22 root@YOUR_SERVER_IP "cd /opt/voice-server && if [ ! -f backend/src/fix-member.mjs ]; then echo ''; echo '  [ERROR] backend/src/fix-member.mjs is not on the server yet.'; echo '          Run deploy.cmd first -- that uploads it.'; echo ''; exit 1; fi; sudo node backend/src/fix-member.mjs %*"
