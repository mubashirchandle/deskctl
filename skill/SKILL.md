---
name: deskctl
description: See and drive the user's GNOME desktop (GNOME 50 on Wayland) with the `deskctl` CLI — screenshots, workspaces, windows, key/mouse input, GNOME Shell actor trees, dconf diffs, shell logs, and a headless sandbox shell. Use whenever a task changes or inspects the desktop environment (GNOME settings, themes, extensions, keybindings, panel, app appearance) so you can verify your own work visually and textually instead of guessing.
---

# deskctl — verify desktop work on GNOME

`deskctl` talks to the `deskctl@local` GNOME Shell extension. Every data command prints JSON.
Run `deskctl --help` or `deskctl COMMAND --help` for all flags.

## Ground rules

- **Coordinates are logical pixels** (a 2560×1600 display at 2× is a 1280×800 stage;
  `deskctl status` shows the real size and scale).
  Screenshots are downscaled to logical size by default, so a pixel in the image at (x, y)
  plus the capture origin is the coordinate to click. Use `--full-res` only to inspect fine detail.
- **Workspaces are numbered from 1**, like GNOME's Super+1. Monitors are indexed from 0.
- The user may be working while you run. Keep actions minimal, and **put things back**:
  note `workspace.active` and the focused window from `deskctl status` first, and return there
  when done (`deskctl workspace N`, `deskctl window focus ID`). `screenshot --workspace N`
  already switches back by itself.
- **Exit status 4 means the user switched agent access off** from the top-bar eye icon.
  Stop and tell them. Never re-enable it yourself (don't touch the
  `org.gnome.shell.extensions.deskctl` `enabled` key). Status 3 means the extension or
  sandbox isn't running; 5 locked session; 6 not found; 7 timeout; 2 bad arguments.
- Input goes to the real desktop. Don't type into windows you didn't intend to, and never type
  passwords or interact with authentication dialogs.

## Verify-your-work loop

```bash
deskctl status                          # shell, monitors, workspaces, focus, theme/font settings, extension errors
deskctl settings snapshot before        # dconf baseline
deskctl mark                            # log baseline
deskctl screenshot -o /tmp/before.png   # visual baseline (or --window/--area for less noise)

# ... make the change ...

deskctl settings diff before            # exactly which keys changed (and nothing else)
deskctl logs --since-mark               # JS errors / warnings from GNOME Shell since the mark
deskctl screenshot -o /tmp/after.png
deskctl diff /tmp/before.png /tmp/after.png   # changed pixels, bbox, highlight image
```

Then look at the images with your file-reading tool. Prefer targeted captures:
`--area X,Y,W,H` for a panel region, `--window focused` for an app. They are cheaper and clearer
than full screens.

## Commands

| Goal | Command |
|---|---|
| Overall state | `deskctl status` |
| Windows (JSON lines) | `deskctl windows [--workspace N] [--all]` |
| Screenshot | `deskctl screenshot [--monitor I \| --area X,Y,W,H \| --window ID\|focused] [--workspace N [--stay]] [--grid [STEP]] [--cursor] [--full-res] [--delay S] [-o PATH]` → prints path, then JSON meta |
| Pixel colour | `deskctl pixel X Y` → `#rrggbb` |
| Workspaces | `deskctl workspace` (print) · `deskctl workspace N\|next\|prev` |
| Window actions | `deskctl window focus\|close\|minimize\|unminimize\|maximize\|unmaximize\|fullscreen\|unfullscreen ID\|focused` · `deskctl window move ID --workspace N --rect X,Y,W,H` |
| Overview | `deskctl overview show\|hide\|apps` |
| Launch app | `deskctl launch org.gnome.Settings --wait` (waits, then focuses the window) |
| Wait for window | `deskctl wait-window --app ID \| --title REGEX \| --wm-class C [--gone] [--timeout S]` |
| Keys | `deskctl key super` · `deskctl key ctrl+alt+t` · `deskctl key super+Return Escape` |
| Type | `deskctl type 'text' [--enter]` |
| Pointer | `deskctl click X Y [--button right] [--double]` · `deskctl move X Y` · `deskctl drag X1 Y1 X2 Y2` · `deskctl scroll --dy 3 [--at X Y]` |
| Shell UI as text | `deskctl tree panel\|quick-settings\|calendar\|dash\|overview\|message-tray\|ui\|stage [--depth N] [--all] [--json]` |
| Settings diff | `deskctl settings snapshot [NAME]` · `deskctl settings diff [NAME] [--prefix /org/gnome/desktop/]` |
| Shell logs | `deskctl mark` · `deskctl logs [--since-mark] [--since '5 min ago'] [--all]` |
| Compare images | `deskctl diff A.png B.png [-o OUT] [--fuzz PCT]` |

Actions wait for animations to finish before returning (`--no-settle` to skip), so a screenshot
right after them shows the final state.

### Tips

- **Clicking something you saw:** take `deskctl screenshot --grid` first. It overlays labelled
  logical-coordinate lines every 100 px, so you can read coordinates reliably even after your
  image viewer rescales the picture.
- **Checking the top bar or Quick Settings?** `deskctl tree panel` is cheaper than an image and
  exact: style classes, labels, icon names, visibility and geometry. Popup menus are hidden until
  opened, so open them first (`deskctl click` on the button, or `deskctl key super+s` for
  Quick Settings), then `deskctl tree quick-settings`.
- **Keybinding changed?** Press it with `deskctl key ...`, then check the effect with `status`,
  `windows` or a screenshot.
- **Theme/colour work:** `deskctl pixel X Y` gives exact colours. `settings diff` confirms the
  keys you meant to change are the only ones that changed.
- Screenshots default to `~/.cache/deskctl/shots/` (the newest 200 are kept). Pass `-o` for files
  you want to keep or diff.
- GTK/libadwaita apps are drawn client-side, so `tree` only covers GNOME Shell's own UI (panel,
  overview, menus, notifications). Use screenshots for app windows.

## Sandbox: a disposable GNOME Shell

GNOME 50 can't reload extension JavaScript without the user logging out, and experiments on the
live session can disrupt the user. A sandbox is a separate headless `gnome-shell` with its own
session bus, dconf database and XDG dirs. Your changes there never touch the user's settings.

```bash
deskctl sandbox start --size 2560x1600 --scale 2 [--seed] [--fresh] \
    [--extension ~/src/my-ext] [--link-config gtk-4.0]
deskctl --sandbox default screenshot        # or: export DESKCTL_SANDBOX=default
deskctl --sandbox default launch org.gnome.TextEditor --wait
deskctl sandbox run -- gnome-calculator      # run any Wayland client inside it
deskctl sandbox env                         # exports, e.g. to run gsettings/dconf inside it
deskctl sandbox stop [--purge]
```

- `--seed` copies the user's dconf settings and user extensions in; without it you get stock GNOME.
- `--extension DIR` links and enables an extension you're developing. After editing its JS,
  `sandbox stop` and `start` again to reload it.
- `--link-config NAME` symlinks `~/.config/NAME` (e.g. `gtk-4.0` for `gtk.css`). **Writes there
  are real.**
- Settings persist between runs of the same sandbox name; `--fresh` wipes them.
- Change sandbox settings with `env $(deskctl sandbox env | sed 's/^export //') gsettings set ...`.
- **Isolation covers the session only.** Apps in the sandbox still use the real *system* bus, so
  toggling Wi-Fi, Bluetooth, power or users in a sandboxed Settings window changes the real machine.
- The sandbox has no systemd user session, portals or accessibility bus. Flatpak apps and anything
  needing those won't work there.

Use the sandbox for extension code, shell themes and risky settings. Use the live session to
confirm the final result in the user's real environment.
