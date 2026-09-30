#!/bin/bash
# Print an original (asmorig) proc from the restunts reference clone.
# usage: tools/asm.sh procname [skip] [count]
cd "$(dirname "$0")/../ref/restunts/src/restunts/asmorig" || exit 1
f=$(grep -al "^$1 proc" seg*.asm | head -1)
[ -z "$f" ] && { echo "not found: $1"; exit 1; }
tr -d '\r' < "$f" | awk -v n="$1" '$1==n && $2=="proc"{p=1} p{print} $1==n && $2=="endp"{exit}' | grep -av '^\s*$' | sed -n "$((${2:-0}+1)),$((${2:-0}+${3:-100000}))p"
