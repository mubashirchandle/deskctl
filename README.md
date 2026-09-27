# deskctl

Lets AI agents (Claude Code, Codex) see and drive a GNOME desktop on Wayland, so they can check
their own work on desktop-environment tasks: themes, settings, extensions, keybindings, the
panel, app appearance.

```bash
deskctl status                              # monitors, workspaces, focus, theme settings, extension errors
deskctl screenshot --window focused         # prints the PNG path, then JSON metadata
deskctl workspace 2                         # switch; waits for the animation to finish
deskctl key super+s && deskctl tree quick-settings   # open Quick Settings, read it as text
deskctl settings snapshot && ... && deskctl settings diff
deskctl sandbox start --seed                # a disposable headless copy of your desktop
```

## Why an extension

On GNOME Wayland, outside programs can't take silent screenshots, inject input or switch
workspaces:

- `org.gnome.Shell.Screenshot` is restricted to allowlisted callers.
- The screenshot portal shows a dialog.
- `grim`, `wtype` and `xdotool` don't work on Mutter.
- `Shell.Eval` needs unsafe mode.

`deskctl@local` is a small extension that runs inside GNOME Shell and exposes a narrow D-Bus API
for these operations. `deskctl` is the CLI agents call.

| Component | Path |
|---|---|
| CLI | `bin/deskctl` (Python 3 + PyGObject), linked as `~/.local/bin/deskctl` |
| Extension | `extension/`, linked as `~/.local/share/gnome-shell/extensions/deskctl@local` |
| Agent skill | `skill/SKILL.md`, linked into `~/.claude/skills/deskctl` and `~/.codex/skills/deskctl` |

Requirements: GNOME Shell 50 on Wayland (developed on Fedora 44), Python 3 with PyGObject, ImageMagick 7,
`dconf`, `gsettings`, `dbus-daemon`. No extra packages are needed.

## Install

```bash
./install.sh
```

The script links the files above, compiles the extension's GSettings schema, and refuses to
overwrite anything it didn't create. Keep the project directory in place: the links point into
it.

GNOME 50 loads new extension code only at login. Log out and back in, then:

```bash
gnome-extensions enable deskctl@local
deskctl status
```

Changing extension JavaScript also requires logging out and back in. Test changes in the
sandbox first. `./uninstall.sh` stops sandboxes and removes only the links it created.

## Safety model

**Indicator.** An eye icon sits in the system status area, next to Wi-Fi, volume and battery.
It turns red while an agent captures the screen, lists windows, reads the shell tree or injects
input, and is crossed out while access is off. The extension's preferences choose when it shows:

| Setting | Icon shown |
|---|---|
| Always (default) | At all times |
| When access is allowed | Only while agent access is on |
| While an agent is using it | Only during agent activity, and for 2 s after |

**Kill switch.** Quick Settings (click the status area) has an **Agents** toggle. It is always
there, whatever the icon setting. Expanding it shows the last five agent actions with the
calling program (`claude`, `codex`, …) and a link to the preferences. When the toggle is off:
- every method except `GetState` fails,
- `deskctl` exits with status 4,
- the agent skill tells agents to stop and ask you.

Switching off also stops input already under way: typing or a drag halts at its next
keystroke or pointer step, every key and mouse button the agent holds is released, and the
interrupted command exits with status 4 saying how far it got (for example "stopped after 43 of
200 characters"). Captures and window actions take milliseconds, so they simply finish.

No D-Bus method can turn access back on. Only the toggle can, or the preferences window
(`gnome-extensions prefs deskctl@local`).

**API scope.** The API has no way to run commands, evaluate code or open files.
- Screenshots are written to a file descriptor the caller passes in.
- App launches take a desktop-file ID only.
- User extensions are unloaded on the lock screen, so nothing works while locked.

**What this is not.** It is not a security boundary against other programs running as you. Any
such program could already edit your dotfiles or install its own extension. The icon and
toggle give you visibility and control over agents. Sandboxed Flatpak apps can't reach
`org.gnome.Shell` at all.

## Conventions

- **Coordinates** are logical stage pixels. A 2560×1600 display at 2× is a 1280×800 stage.
  - Screenshots are downscaled to logical size, so an image pixel plus the capture origin is a
    clickable coordinate.
  - `--full-res` keeps physical pixels.
  - `--grid [STEP]` overlays labelled coordinate lines.
- **Workspaces** are numbered from 1, like Super+1. Monitors are indexed from 0.
- **Settling:** action commands wait for workspace, overview and window animations, and then for
  the screen to stop repainting (so menus finish opening), before returning. That last wait is
  capped at ¾ s, so a playing video can't stall them. Use `--no-settle` to skip it.
- **Workspace restore:** `screenshot --workspace N` switches back by workspace identity, not
  number. Dynamic workspaces renumber when an empty one vanishes, and the metadata reports whether
  the restore was exact.
- **Exit statuses:**

  | Status | Meaning |
  |---|---|
  | 0 | OK |
  | 1 | Failed |
  | 2 | Bad arguments |
  | 3 | Extension or sandbox not running |
  | 4 | Switched off by you |
  | 5 | Session locked |
  | 6 | Not found |
  | 7 | Timeout |

Run `deskctl --help` and `deskctl COMMAND --help` for every command. `skill/SKILL.md` is the
agent-oriented guide.

## Sandbox

`deskctl sandbox start` runs a separate headless `gnome-shell --headless --virtual-monitor` with:
- its own `dbus-daemon`,
- its own dconf database, XDG config/data/cache/state directories and runtime directory, all
  under `~/.cache/deskctl/sandbox/NAME`.

Before starting the shell it writes a canary key and refuses to continue unless the key landed in
the sandbox's own database. It returns only once the sandbox is ready for input: GNOME Shell
ignores keyboard shortcuts for a few seconds after starting, so `start` presses the Quick Settings
shortcut until its menu opens. It also moves the pointer out of the top-left hot corner, where
it starts. Expect about 2.5 s.

| Option | Effect |
|---|---|
| `--size WxH --scale S` | Virtual monitor. Match your display (see `deskctl status`), e.g. `--size 2560x1600 --scale 2`. |
| `--seed` | Copy your dconf settings (minus policy-locked keys) and user extensions in. |
| `--extension DIR` | Link and enable an extension you're developing. |
| `--link-config NAME` | Symlink `~/.config/NAME`, e.g. `gtk-4.0`. Writes there are real. |
| `--fresh` | Discard settings left from earlier runs. |

Use it with `deskctl --sandbox NAME ...` or `DESKCTL_SANDBOX=NAME`.
`deskctl sandbox run -- APP` starts a Wayland client inside it, and `deskctl sandbox env` prints
its environment.

The sandbox isolates the session only. Apps inside it still use the real system bus, so
NetworkManager, Bluetooth, power and accounts changes affect the machine. There is no systemd
user session, portal or accessibility bus inside, so Flatpak apps and portal-dependent features
won't work there.

## How it works

The extension exports `org.gnome.Shell.Extensions.Deskctl1` at
`/org/gnome/Shell/Extensions/Deskctl` on the shell's session bus. Every method returns one JSON
string.

| Area | How |
|---|---|
| Screen captures | `Shell.Screenshot.screenshot_stage_to_content` + `composite_to_stream` |
| Window captures | `paint_to_content`, cropped to the frame rect, the same approach as GNOME's screenshot UI |
| Input | Clutter virtual keyboard and pointer, so compositor keybindings fire exactly as for hardware |
| Settling | Polls the overview, workspace-switch and window-manager animation state, then waits for a short stretch with no stage repaints |
| Indicator | A Quick Settings `SystemIndicator` (status-area icon) with an `Agents` `QuickMenuToggle`, like the built-in toggles |

The CLI adds downscaling, grids, diffs (`magick compare`), dconf snapshots, journal filtering and
sandbox management.

## Testing

```bash
python3 -m unittest discover -s tests -p 'test_*.py'   # unit + invariant tests, no shell needed
tests/smoke.sh                                         # end-to-end in a throwaway sandbox (~10 s)
```

See `docs/TESTING.md` for the live-session checklist.
