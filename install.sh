#!/usr/bin/bash
set -euo pipefail
if (( EUID == 0 )); then
    echo 'Run install.sh as your normal desktop user, not root.' >&2
    exit 1
fi
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
codex_home=${CODEX_HOME:-$HOME/.codex}

# destination|source pairs; every destination is a symlink into this project.
links=(
    "$HOME/.local/bin/deskctl|$project_dir/bin/deskctl"
    "$HOME/.local/share/gnome-shell/extensions/deskctl@local|$project_dir/extension"
    "$HOME/.claude/skills/deskctl|$project_dir/skill"
    "$codex_home/skills/deskctl|$project_dir/skill"
)

for program in python3 gnome-extensions glib-compile-schemas magick dconf gsettings gnome-shell dbus-daemon; do
    command -v "$program" >/dev/null || { echo "Missing dependency: $program" >&2; exit 1; }
done
/usr/bin/python3 -c 'from gi.repository import Gio, GLib'
for link in "${links[@]}"; do
    destination=${link%%|*} source_path=${link#*|}
    if [[ -e "$destination" || -L "$destination" ]]; then
        if [[ ! -L "$destination" || "$(readlink -- "$destination")" != "$source_path" ]]; then
            echo "Refusing to replace unrelated installation: $destination" >&2
            exit 1
        fi
    fi
done

chmod 755 "$project_dir/bin/deskctl"
glib-compile-schemas "$project_dir/extension/schemas"
for link in "${links[@]}"; do
    destination=${link%%|*} source_path=${link#*|}
    mkdir -p -- "${destination%/*}"
    [[ -L "$destination" ]] || ln -s -- "$source_path" "$destination"
    echo "Linked $destination"
done
case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo 'WARNING: ~/.local/bin is absent from PATH; agents need the full path to deskctl.' >&2 ;;
esac
cat <<'MSG'

GNOME 50 loads new extension code only at login. Log out and back in, then:
  gnome-extensions enable deskctl@local
  deskctl status

Until then, the headless sandbox already works:
  deskctl sandbox start && deskctl --sandbox default screenshot
MSG
