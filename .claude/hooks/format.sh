#!/bin/sh
# Formats the file an Edit or Write call touched, so `npm run format:check` stays green. Never fails the call.
file=$(node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).tool_input.file_path||"")}catch{}})')
[ -n "$file" ] && npx --no-install prettier --write --ignore-unknown "$file" >/dev/null 2>&1
exit 0
