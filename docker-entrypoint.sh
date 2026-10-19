#!/bin/sh
# The data volume is created as root. The app runs as nextjs so it can write SQLite.
# An older image that honored DATABASE_URL=file:./data/app.db wrote the real
# database at /app/data/app.db (container layer), leaving the /data volume empty.
set -eu
mkdir -p /data

is_sqlite() {
  [ -f "$1" ] || return 1
  magic=$(dd if="$1" bs=15 count=1 2>/dev/null || true)
  [ "$magic" = "SQLite format 3" ]
}

adopt_legacy() {
  target="/data/app.db"
  if is_sqlite "$target"; then
    return 0
  fi
  for src in /app/data/app.db /app/app.db; do
    if [ "$src" = "$target" ]; then
      continue
    fi
    if is_sqlite "$src"; then
      if [ -e "$target" ]; then
        mv "$target" "${target}.not-sqlite"
        echo "[db] ${target} was not sqlite; moved aside before adopting ${src}"
      fi
      rm -f "${target}-wal" "${target}-shm" "${target}-journal"
      cp -p "$src" "$target"
      chmod 600 "$target"
      for suffix in -wal -shm -journal; do
        if [ -f "${src}${suffix}" ]; then
          cp -p "${src}${suffix}" "${target}${suffix}"
          chmod 600 "${target}${suffix}"
        fi
      done
      srcdir=$(dirname "$src")
      for name in token.key session.secret; do
        if [ -f "${srcdir}/${name}" ] && [ ! -e "/data/${name}" ]; then
          cp -p "${srcdir}/${name}" "/data/${name}"
          chmod 600 "/data/${name}"
        fi
      done
      echo "[db] adopted legacy sqlite ${src} -> ${target}"
      return 0
    fi
  done
  if [ -e "$target" ]; then
    bytes=$(wc -c < "$target" | tr -d ' ')
    mv "$target" "${target}.not-sqlite"
    echo "[db] ${target} is not a sqlite database (${bytes} bytes); moved aside"
  fi
}

adopt_legacy
chown -R nextjs:nodejs /data
exec su-exec nextjs:nodejs "$@"
