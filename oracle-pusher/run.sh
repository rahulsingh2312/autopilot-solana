#!/usr/bin/env bash
# Daily price push. Scheduled after the US close; see push.cjs for why once a
# day is enough (the program's equity staleness bound is four days).
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
exec node push.cjs
