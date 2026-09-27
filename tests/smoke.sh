#!/usr/bin/bash
# End-to-end check of the extension and CLI in a disposable headless sandbox.
# It never acts on the live session; it only reads the real dconf database to
# prove the sandbox left it unchanged.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
D=bin/deskctl
name=smoke
export DESKCTL_SANDBOX=$name
tmp=$(mktemp -d "${TMPDIR:-/tmp}/deskctl-smoke.XXXXXX")
cleanup() {
    "$D" sandbox stop --name "$name" --purge >/dev/null 2>&1 || true
    rm -rf -- "$tmp"
}
trap cleanup EXIT

passed=0
check() {
    local what=$1
    shift
    if "$@" >/dev/null 2>&1; then
        printf 'ok    %s\n' "$what"
        passed=$((passed + 1))
    else
        printf 'FAIL  %s\n' "$what" >&2
        exit 1
    fi
}
size() { magick identify -format '%wx%h' "$1"; }
sandbox_env() { "$D" sandbox env --name "$name" | sed 's/^export //'; }
ext_setting() {
    env $(sandbox_env) gsettings --schemadir extension/schemas \
        set org.gnome.shell.extensions.deskctl "$1" "$2"
}
kill_switch() { ext_setting enabled "$1"; }
indicator() { "$D" status | jq -c '.indicator'; }
idle() { sleep 2.5; }  # Activity keeps the indicator "in use" for 2 s.

real_before=$(dconf dump / | sha256sum)
"$D" sandbox start --name "$name" --fresh --size 1600x1000 --scale 1.25 >"$tmp/start.json"
check 'extension active in sandbox' jq -e '.extensions["deskctl@local"].state == "ACTIVE"' "$tmp/start.json"
check 'scaled 1280x800 logical stage' jq -e '.state.stage == {"width":1280,"height":800}' "$tmp/start.json"

"$D" screenshot -o "$tmp/screen.png" >"$tmp/shot.txt"
check 'screenshot downscaled to logical size' test "$(size "$tmp/screen.png")" = 1280x800
check 'screenshot prints path then metadata' jq -e '.scale == 1 and .target == "screen"' <(sed -n 2p "$tmp/shot.txt")
"$D" screenshot --full-res -o "$tmp/full.png" >/dev/null
check 'full-res keeps physical pixels' test "$(size "$tmp/full.png")" = 1600x1000
"$D" screenshot --area 0,0,400,100 --grid 50 -o "$tmp/grid.png" >/dev/null
check 'area capture with grid' test "$(size "$tmp/grid.png")" = 400x100
check 'pixel colour' jq -e '.color | test("^#[0-9a-f]{6}$")' <("$D" pixel 5 5)

check 'switch to workspace 2' jq -e '.active == 2' <("$D" workspace 2)
check 'switch back to workspace 1' jq -e '.active == 1' <("$D" workspace 1)

"$D" launch org.gnome.TextEditor --wait --timeout 30 >"$tmp/launch.json"
check 'launched window is placed and focused' jq -e '.window.focused and .window.rect.width > 0' "$tmp/launch.json"
"$D" screenshot --window focused -o "$tmp/before.png" >/dev/null
"$D" type 'deskctl smoke test' >/dev/null
"$D" screenshot --window focused -o "$tmp/after.png" >/dev/null
check 'typing changes the window' jq -e '.changed_pixels > 100 and .bbox != null' \
    <("$D" diff "$tmp/before.png" "$tmp/after.png")
check 'window title reflects typed text' jq -e 'any(.[]; .title | test("deskctl smoke test"))' <("$D" windows)

"$D" key super >/dev/null
check 'overlay key opens the overview' jq -e '.overview.visible' <("$D" status)
"$D" key Escape >/dev/null
check 'Escape closes the overview' jq -e '.overview.visible | not' <("$D" status)
check 'panel tree has the clock' grep -q '\.clock ' <("$D" tree panel)
"$D" click 640 780 >/dev/null
check 'pointer lands where clicked' jq -e '.pointer == {"x":640,"y":780}' <("$D" status)

# Super+drag is mutter's window move, so it only works if super stays down throughout.
"$D" window unmaximize focused >/dev/null
focused_rect() { "$D" windows | jq -c '.[] | select(.focused) | .rect'; }
read -r x y w h < <(focused_rect | jq -r '"\(.x) \(.y) \(.width) \(.height)"')
cx=$((x + w / 2)) cy=$((y + h / 2))
"$D" drag "$cx" "$cy" $((cx - 80)) $((cy + 40)) --hold super >/dev/null
check 'drag --hold super moves the window' jq -e --argjson x "$x" --argjson y "$y" \
    '(.x - ($x - 80) | fabs) <= 2 and (.y - ($y + 40) | fabs) <= 2' <(focused_rect)
check 'held keys are released after the drag' jq -e '.held_input == {"keys":0,"buttons":0}' <("$D" status)
read -r x y < <(focused_rect | jq -r '"\(.x) \(.y)"')
"$D" drag $((cx - 80)) $((cy + 40)) "$cx" "$cy" >/dev/null
check 'a plain drag leaves the window in place' jq -e --argjson x "$x" --argjson y "$y" \
    '.x == $x and .y == $y' <(focused_rect)

# Keep a window on workspace 1: GNOME deletes empty workspaces once you leave them.
W=$(jq '.window.id' "$tmp/launch.json")
"$D" launch org.gnome.Calculator --wait --timeout 30 >/dev/null
"$D" window move "$W" --workspace 2 >/dev/null
"$D" screenshot --workspace 2 -o "$tmp/ws2.png" >"$tmp/ws2.txt"
check 'screenshot on another workspace restores exactly' \
    jq -e '.restored_workspace.exact and .workspace == 2' <(sed -n 2p "$tmp/ws2.txt")
check 'still on workspace 1' jq -e '.workspace.active == 1' <("$D" status)

check 'eye icon sits in the system status area' \
    grep -qE '^ {12}StIcon .*icon=view-reveal-symbolic' <("$D" tree panel | sed -n '/QuickSettings/,$p')
"$D" key super+s >/dev/null
check 'Quick Settings has the Agents toggle' \
    grep -qE 'AgentAccessToggle .*:checked' <("$D" tree quick-settings --depth 30)
"$D" key Escape >/dev/null
idle
check 'default visibility: always shown' jq -e '.visible and (.agent_active | not)' <(indicator)
ext_setting indicator-visibility active
check '"active" mode hides the idle icon' jq -e '.visible | not' <(indicator)
"$D" windows >/dev/null
check '"active" mode shows the icon while in use' jq -e '.visible and .agent_active' <(indicator)
idle
check '"active" mode hides it again afterwards' jq -e '.visible | not' <(indicator)
ext_setting indicator-visibility enabled
check '"enabled" mode shows it while allowed' jq -e '.visible' <(indicator)
kill_switch false
check '"enabled" mode hides it when switched off' jq -e '.visible | not' <(indicator)
ext_setting indicator-visibility always
check '"always" mode shows it even when switched off' jq -e '.visible' <(indicator)

set +e
"$D" screenshot -o "$tmp/blocked.png" >/dev/null 2>&1
status=$?
set -e
check 'kill switch refuses calls with exit 4' test "$status" = 4
check 'status still works when switched off' jq -e '.enabled == false' <("$D" status)
kill_switch true
check 'calls work again after re-enabling' "$D" screenshot -o "$tmp/again.png"

# Switching off must also stop input that is already under way.
( rc=0; "$D" type "$(printf 'x%.0s' $(seq 300))" >/dev/null 2>"$tmp/type.err" || rc=$?
  echo "$rc" >"$tmp/type.rc" ) &
sleep 1
kill_switch false
wait
check 'switching off stops typing mid-way with exit 4' test "$(cat "$tmp/type.rc")" = 4
check 'the interrupted command says how far it got' grep -q 'stopped after [0-9]* of 300' "$tmp/type.err"
check 'no key is left held' jq -e '.held_input == {"keys":0,"buttons":0}' <("$D" status)
kill_switch true
( "$D" drag 300 300 900 600 --steps 200 --hold shift >/dev/null 2>&1 || true ) &
sleep 0.6
kill_switch false
wait
check 'switching off mid-drag releases the mouse button and held key' \
    jq -e '.held_input == {"keys":0,"buttons":0}' <("$D" status)
kill_switch true

check 'no deskctl JS errors in the shell log' bash -c "! '$D' logs --all | grep -E 'JS ERROR|Deskctl ' "
check 'real dconf database unchanged' test "$(dconf dump / | sha256sum)" = "$real_before"
printf '\n%d checks passed\n' "$passed"
