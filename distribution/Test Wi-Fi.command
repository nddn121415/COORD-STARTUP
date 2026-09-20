#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 24 LTS from https://nodejs.org, then open this file again.'
  read -r -p 'Press Enter to close.'
  exit 1
fi
node coord-peer.cjs demo --wifi
result=$?
read -r -p 'Press Enter to close.'
exit "$result"
