#!/bin/bash
# A throwaway Herdr in a headless KWin, with a local stand-in for the Mattermost server. AGENTS.md has the how-to.
set -u

# A socket path can't exceed 108 bytes, which rules out anything deep such as a session's scratch folder.
S=/var/tmp/mmt
REPO=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
BIN=$S/home/.local/bin
SCREEN_W=${SCREEN_W:-1280}
SCREEN_H=${SCREEN_H:-820}

# env -i leaves out the real session's socket, display and token, so nothing in here can reach the live window.
sandboxed() {
  env -i HOME="$S/home" PATH="$BIN:$S/path" XDG_RUNTIME_DIR="$S/run" WAYLAND_DISPLAY=wl-x \
    HERDR_APP_HOME="$S/app" HC_SESSION=mmt XDG_STATE_HOME="$S/state" "$@"
}

# Not with pkill -f, which can match this shell and the real desktop's KWin.
pids_matching() {
  local p
  for p in /proc/[0-9]*; do
    grep -qzxF -- "$2" "$p/$1" 2>/dev/null && echo "${p#/proc/}"
  done
}

stop_matching() {
  local i pids
  for i in $(seq 40); do
    pids=$(pids_matching "$1" "$2")
    [ -z "$pids" ] && return 0
    [ "$i" = 1 ] && kill $pids 2>/dev/null
    sleep 0.25
  done
  echo "Still running: $pids" >&2
  return 1
}

# Everything on PATH minus $HIDE, so a test can run without kdialog, say, and minus Herdr, whose copies are in $BIN.
build_path() {
  rm -rf "$S/path"
  mkdir -p "$S/path"
  local dir file name IFS=:
  for dir in $PATH; do
    for file in "$dir"/*; do
      name=${file##*/}
      case " ${HIDE:-} herdr-app herdr-core hc " in *" $name "*) continue ;; esac
      [ -x "$file" ] && [ ! -e "$S/path/$name" ] && ln -s "$file" "$S/path/$name"
    done
  done
  # The real one shows a browser over the window, which then silently takes the injected clicks.
  rm -f "$S/path/xdg-open"
  printf '#!/bin/sh\necho "$@" >> %s/xdg-open.log\n' "$S" > "$S/path/xdg-open"
  chmod +x "$S/path/xdg-open"
}

start_herdr() {
  sandboxed setsid nohup herdr-app >"$S/herdr.log" 2>&1 &
  local i
  for i in $(seq 80); do
    sandboxed herdr-app status >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  echo "Herdr didn't start, see $S/herdr.log" >&2
  return 1
}

cmd_stop() {
  stop_matching environ "XDG_RUNTIME_DIR=$S/run"
  # KWin's capabilities keep its environment unreadable, so it goes by its socket argument.
  stop_matching cmdline "--socket=wl-x"
  rm -rf "$S"
}

cmd_start() {
  local layout=${1:-demo}
  cmd_stop
  mkdir -p "$S/run" "$S/shots" "$S/app/mods" "$S/app/layouts" "$S/app/themes" "$S/state" "$S/home/Downloads" "$BIN"
  chmod 700 "$S/run"

  # Copies, because a window started from the installed binary can install a waiting update over it.
  cp "$(readlink -f "$(command -v herdr-app)")" "$BIN/herdr-app"
  cp "$(readlink -f "$(command -v herdr-core)")" "$BIN/herdr-core"
  ln -s herdr-core "$BIN/hc"
  build_path

  cp -r "$REPO/mods/mattermost" "$S/app/mods/"
  local theme=$HOME/.config/herdr-app/themes/breeze.json
  [ -f "$theme" ] && cp "$theme" "$S/app/themes/"
  echo '{ "zoom": 1.23, "font": "JetBrainsMono Nerd Font", "font_size": 14, "theme": "breeze" }' > "$S/app/settings.json"
  echo '{ "frame.welcomed": true }' > "$S/app/shared.json"
  # Maximized and without a title bar in the layouts below, so that screenshot pixels and pointer positions are the same numbers.
  echo "{ \"state\": \"maximized\", \"bounds\": [0.0, 0.0, $SCREEN_W.0, $SCREEN_H.0] }" > "$S/app/window.json"
  echo '{ "url": "http://127.0.0.1:18069", "token": "fake-token", "team": "team" }' > "$S/app/mattermost.json"
  echo '{ "id": "root", "type": "block", "titlebar": "none", "content": { "mod": "mattermost", "props": { "demo": true, "channel": "design", "frame": true } } }' > "$S/app/layouts/demo.json"
  echo '{ "id": "root", "type": "block", "titlebar": "none", "content": { "mod": "mattermost", "props": { "channel": "bugs", "frame": true } } }' > "$S/app/layouts/server.json"

  XDG_RUNTIME_DIR="$S/run" KWIN_WAYLAND_NO_PERMISSION_CHECKS=1 setsid nohup dbus-run-session -- \
    kwin_wayland --virtual --width "$SCREEN_W" --height "$SCREEN_H" --no-lockscreen --no-global-shortcuts --no-kactivities --socket=wl-x \
    >"$S/kwin.log" 2>&1 &
  local i
  for i in $(seq 80); do
    [ -S "$S/run/wl-x" ] && break
    sleep 0.25
  done
  [ -S "$S/run/wl-x" ] || { echo "KWin didn't start, see $S/kwin.log" >&2; return 1; }

  XDG_RUNTIME_DIR="$S/run" setsid nohup python3 -I "$REPO/test/mock_server.py" "$S/mock.log" >"$S/mock.err" 2>&1 &

  start_herdr || return 1
  cmd_layout "$layout"
}

cmd_restart() {
  stop_matching environ "HERDR_APP_HOME=$S/app" || return 1
  build_path
  start_herdr || return 1
  cmd_layout "${1:-demo}"
}

cmd_layout() {
  sandboxed herdr-app do layout.switch "{\"name\":\"$1\"}" >/dev/null || return 1
  # The panel draws its first frame only after its first requests come back.
  sleep 2
}

cmd_sync() {
  cp -r "$REPO/mods/mattermost/." "$S/app/mods/mattermost/"
}

cmd_in() {
  XDG_RUNTIME_DIR="$S/run" WAYLAND_DISPLAY=wl-x python3 -I "$REPO/test/wlinput.py" "$@"
}

cmd_shot() {
  local name=$1
  shift
  if [ $# -gt 0 ]; then cmd_in "$@" || return 1; fi
  sleep "${WAIT:-1.2}"
  sandboxed herdr-app shot "$S/shots/$name.png" >/dev/null || return 1
  sandboxed herdr-app status | python3 -Ic 'import json, sys; d = json.load(sys.stdin); print("errors:", d["errors"], "overlays:", d["overlays"])'
  echo "$S/shots/$name.png"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  stop) cmd_stop ;;
  restart) shift; cmd_restart "$@" ;;
  layout) shift; cmd_layout "$@" ;;
  sync) cmd_sync ;;
  in) shift; cmd_in "$@" ;;
  shot) shift; cmd_shot "$@" ;;
  herdr) shift; sandboxed herdr-app "$@" ;;
  run) shift; sandboxed "$@" ;;
  *) echo "usage: $0 start|stop|restart|layout|sync|in|shot|herdr|run, see AGENTS.md" >&2; exit 2 ;;
esac
