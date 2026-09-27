# Testing deskctl

## Automated

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
tests/smoke.sh
```

`test_cli.py` covers:

- key-combo parsing
- argument parsing
- coordinate grids
- dconf dump parsing and diffing
- tree rendering
- D-Bus error to exit-status mapping
- sandbox environment isolation
- invariants between the extension and the CLI:
  - every D-Bus method has a handler, and the CLI calls only real methods
  - only the indicator writes the kill switch
  - the extension has no command, eval or file-open surface

`smoke.sh` starts a fresh `smoke` sandbox (1600×1000 at 1.25×) and runs 23 checks:

- screenshots at logical and full resolution
- workspaces and exact restore
- app launch, typing and diffing
- the overlay key
- the panel tree
- pointer accuracy
- the kill switch
- the shell log

Its last check confirms your real dconf database is byte-for-byte unchanged. That can fail
spuriously if something in your live session (an automatic light/dark theme switcher, for example) writes
a setting while the test runs; re-run it if so.

## Extension changes

GNOME 50 only loads extension JavaScript at login, so test in the sandbox first:

```bash
deskctl sandbox stop; deskctl sandbox start --size 2560x1600 --scale 2
tests/smoke.sh
deskctl --sandbox default logs --all | grep -iE 'deskctl|JS ERROR'
```

Then log out and back in to load the new code into the live session.

## Live session checklist

Run these after installing and logging in again:

```bash
gnome-extensions info deskctl@local        # State: ACTIVE
deskctl status                             # enabled: true; monitors and stage match your display
deskctl screenshot                         # open the PNG: your desktop at logical size
deskctl screenshot --full-res              # physical pixels
deskctl screenshot --window focused --grid # focused window with coordinate lines
deskctl workspace                          # note the active workspace
deskctl screenshot --workspace 2           # captures workspace 2, returns you to where you were
deskctl key super; deskctl key Escape      # overview opens, then closes
deskctl tree panel | head                  # your panel, as text
journalctl --user -b _COMM=gnome-shell | grep -i deskctl   # no errors
```

Then check the indicator:

1. The eye in the top bar turns red during the screenshot commands.
2. Its menu shows the last action and the calling process.
3. Turning **Allow agent access** off makes `deskctl screenshot` exit with status 4, while
   `deskctl status` still reports `"enabled": false`.
4. Turning it back on restores access.

## Troubleshooting

| Symptom | Action |
|---|---|
| Exit 3, "extension is not active" | Log out and back in after the first install, then `gnome-extensions enable deskctl@local` |
| `gnome-extensions info` shows ERROR | `journalctl --user -b _COMM=gnome-shell \| grep -A5 deskctl` |
| Exit 4 | Agent access is switched off in the top-bar menu (intended) |
| Sandbox start times out | Read `~/.cache/deskctl/sandbox/NAME/shell.log` |
| `--scale` rejected | That size doesn't support the scale; the error lists the supported ones |
| Screenshot of a window on another workspace fails | Use `--workspace N` (switches, captures and restores) |
