#!/usr/bin/bash
set -euo pipefail
if (( EUID == 0 )); then
    echo 'Run uninstall.sh as your normal desktop user, not root.' >&2
    exit 1
fi
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
codex_home=${CODEX_HOME:-$HOME/.codex}
extension="$HOME/.local/share/gnome-shell/extensions/deskctl@local"
links=(
    "$HOME/.local/bin/deskctl|$project_dir/bin/deskctl"
    "$extension|$project_dir/extension"
    "$HOME/.claude/skills/deskctl|$project_dir/skill"
    "$codex_home/skills/deskctl|$project_dir/skill"
)

# Stop sandboxes first; they run gnome-shell processes from this project.
for state in "${XDG_CACHE_HOME:-$HOME/.cache}"/deskctl/sandbox/*/state.json; do
    [[ -e "$state" ]] || continue
    name=$(basename -- "$(dirname -- "$state")")
    "$project_dir/bin/deskctl" sandbox stop --name "$name" >/dev/null || true
    echo "Stopped sandbox $name"
done
if [[ -L "$extension" && "$(readlink -- "$extension")" == "$project_dir/extension" ]]; then
    if ! gnome-extensions disable deskctl@local 2>/dev/null; then
        echo 'Extension could not be disabled (it may not be loaded); log out to unload it if necessary.' >&2
    fi
fi
for link in "${links[@]}"; do
    destination=${link%%|*} source_path=${link#*|}
    if [[ -L "$destination" && "$(readlink -- "$destination")" == "$source_path" ]]; then
        unlink -- "$destination"
        echo "Removed $destination"
    elif [[ -e "$destination" || -L "$destination" ]]; then
        echo "Leaving unrelated installation: $destination"
    fi
done
echo "Uninstalled. Project sources and ${XDG_CACHE_HOME:-$HOME/.cache}/deskctl (screenshots, sandboxes) were kept."
