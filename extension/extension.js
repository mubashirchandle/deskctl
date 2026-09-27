import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Activity} from './activity.js';
import * as Capture from './capture.js';
import {Input} from './input.js';
import {AgentAccessIndicator} from './quickSettings.js';
import {
    DeskctlError, ERROR_PREFIX, Sources,
    allWindows, findWindow, workspaceByNumber, workspaceNumber,
} from './util.js';

const OBJECT_PATH = '/org/gnome/Shell/Extensions/Deskctl';

// Every method returns one JSON string. There is no method that changes the
// "enabled" key and no method that evaluates code, runs commands or opens paths.
const XML = `<node><interface name="org.gnome.Shell.Extensions.Deskctl1">
  <method name="GetState"><arg direction="out" type="s"/></method>
  <method name="ListWindows"><arg direction="out" type="s"/></method>
  <method name="Screenshot">
    <arg direction="in" type="a{sv}" name="options"/>
    <arg direction="in" type="h" name="fd"/>
    <arg direction="out" type="s"/>
  </method>
  <method name="PickColor">
    <arg direction="in" type="i" name="x"/>
    <arg direction="in" type="i" name="y"/>
    <arg direction="out" type="s"/>
  </method>
  <method name="SwitchWorkspace">
    <arg direction="in" type="i" name="number"/>
    <arg direction="out" type="s"/>
  </method>
  <method name="ActivateWorkspaceId">
    <arg direction="in" type="s" name="id"/>
    <arg direction="out" type="s"/>
  </method>
  <method name="WindowAction">
    <arg direction="in" type="t" name="id"/>
    <arg direction="in" type="s" name="action"/>
    <arg direction="in" type="a{sv}" name="args"/>
    <arg direction="out" type="s"/>
  </method>
  <method name="Overview">
    <arg direction="in" type="s" name="action"/>
    <arg direction="out" type="s"/>
  </method>
  <method name="Settle">
    <arg direction="in" type="u" name="timeout_ms"/>
    <arg direction="out" type="s"/>
  </method>
  <method name="LaunchApp">
    <arg direction="in" type="s" name="app_id"/>
    <arg direction="in" type="b" name="new_window"/>
    <arg direction="out" type="s"/>
  </method>
  <method name="Keys">
    <arg direction="in" type="aas" name="combos"/>
    <arg direction="out" type="s"/>
  </method>
  <method name="TypeText">
    <arg direction="in" type="s" name="text"/>
    <arg direction="out" type="s"/>
  </method>
  <method name="Pointer">
    <arg direction="in" type="s" name="action"/>
    <arg direction="in" type="a{sv}" name="args"/>
    <arg direction="out" type="s"/>
  </method>
  <method name="ShellTree">
    <arg direction="in" type="s" name="root"/>
    <arg direction="in" type="u" name="depth"/>
    <arg direction="in" type="b" name="include_hidden"/>
    <arg direction="out" type="s"/>
  </method>
</interface></node>`;

const WINDOW_TYPES = Object.fromEntries(
    Object.entries(Meta.WindowType).map(([name, value]) => [value, name.toLowerCase()]));
const MAX_SETTLE_MS = 10000;
const QUIET_MS = 60;
const MAX_QUIET_WAIT_MS = 750;

// Programs between an agent and the D-Bus call; the first ancestor not in
// this set (claude, codex, a terminal...) is what the user wants to see.
const INTERMEDIARIES = new Set([
    'deskctl', 'python3', 'python', 'bash', 'sh', 'dash', 'zsh', 'fish', 'env',
    'timeout', 'xargs', 'nohup', 'setsid', 'uv', 'uvx', 'node',
]);

function readProc(pid, file) {
    const [, bytes] = GLib.file_get_contents(`/proc/${pid}/${file}`);
    return new TextDecoder().decode(bytes);
}

function programName(pid) {
    // Some programs rewrite argv[0] as a title ("claude bg-pty-host").
    const argv0 = readProc(pid, 'cmdline').split('\0')[0].split(' ')[0];
    return GLib.path_get_basename(argv0 || readProc(pid, 'comm').trim());
}

function parentPid(pid) {
    const stat = readProc(pid, 'stat');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
}

function agentName(pid) {
    let current = pid;
    for (let depth = 0; depth < 12 && current > 1; depth++) {
        const name = programName(current);
        // Versioned binaries (Claude Code runs as e.g. "2.1.283") say nothing.
        if (!INTERMEDIARIES.has(name) && !/^\d+(\.\d+)+$/.test(name))
            return name;
        current = parentPid(current);
    }
    return programName(pid);
}

function unpackOptions(options) {
    return Object.fromEntries(Object.entries(options).map(
        ([key, value]) => [key, value instanceof GLib.Variant ? value.recursiveUnpack() : value]));
}

function windowInfo(window, tracker, focus) {
    const rect = window.get_frame_rect();
    const info = {
        id: window.get_id(),
        title: window.get_title() ?? '',
        app_id: tracker.get_window_app(window)?.get_id() ?? null,
        wm_class: window.get_wm_class() ?? null,
        pid: window.get_pid(),
        type: WINDOW_TYPES[window.get_window_type()] ?? 'unknown',
        workspace: window.is_on_all_workspaces() ? 'all' : workspaceNumber(window.get_workspace()),
        monitor: window.get_monitor(),
        rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
        focused: window === focus,
        minimized: window.minimized,
        maximized: window.is_maximized(),
        fullscreen: window.is_fullscreen(),
    };
    if (window.is_above())
        info.above = true;
    if (window.is_skip_taskbar())
        info.skip_taskbar = true;
    return info;
}

class Service {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._sources = new Sources();
        this._input = new Input(this._sources);
        this._tracker = Shell.WindowTracker.get_default();
        this._callers = new Map();
        this._paintWatches = new Set();
        // Dynamic workspaces renumber as empty ones vanish; these opaque ids
        // follow the Meta.Workspace object so callers can restore exactly.
        this._workspaceIds = new WeakMap();
        this._nextWorkspaceId = 0;

        this._activity = new Activity(this._sources);
        this._indicator = new AgentAccessIndicator(extension, this._settings, this._activity);

        this._dbus = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
    }

    destroy() {
        this._dbus.unexport();
        this._dbus = null;
        this._input.destroy();
        this._paintWatches.forEach(id => global.stage.disconnect(id));
        this._paintWatches.clear();
        this._indicator.destroy();
        this._indicator = null;
        this._activity.destroy();
        this._sources.destroy();
        this._settings = null;
    }

    async _caller(invocation) {
        const sender = invocation.get_sender();
        if (this._callers.has(sender))
            return this._callers.get(sender);
        let label = sender;
        try {
            const reply = await invocation.get_connection().call(
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'GetConnectionUnixProcessID', new GLib.Variant('(s)', [sender]),
                null, Gio.DBusCallFlags.NONE, 1000, null);
            label = agentName(reply.deepUnpack()[0]);
        } catch {
            // Identity is informational; an unknown caller is still reported.
        }
        if (this._callers.size > 64)
            this._callers.clear();
        this._callers.set(sender, label);
        return label;
    }

    // Common path for every method: gate, record, run, reply with JSON or a
    // named error the CLI can map to an exit status.
    async _run(invocation, name, handler, {gated = true, activity = true, hold = false} = {}) {
        try {
            if (gated) {
                if (Main.sessionMode.isLocked)
                    throw new DeskctlError('Locked', 'The session is locked');
                if (!this._settings.get_boolean('enabled')) {
                    throw new DeskctlError('Disabled',
                        'Agent access is switched off in the top-bar Deskctl menu');
                }
            }
            if (activity)
                this._activity.record(name, await this._caller(invocation));
            const result = await (hold ? this._activity.hold(handler()) : handler());
            invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(result)]));
        } catch (error) {
            if (error instanceof DeskctlError) {
                invocation.return_dbus_error(`${ERROR_PREFIX}.${error.code}`, error.message);
            } else {
                logError(error, `Deskctl ${name}`);
                invocation.return_dbus_error(`${ERROR_PREFIX}.Failed`, `${error.message}`);
            }
        }
    }

    _workspaceId(workspace) {
        if (!this._workspaceIds.has(workspace))
            this._workspaceIds.set(workspace, `ws${++this._nextWorkspaceId}`);
        return this._workspaceIds.get(workspace);
    }

    _state() {
        const manager = global.workspace_manager;
        const active = manager.get_active_workspace();
        const focus = global.display.get_focus_window();
        const [px, py] = global.get_pointer();
        const primary = Main.layoutManager.primaryIndex;
        const workspaces = [];
        for (let i = 0; i < manager.get_n_workspaces(); i++) {
            const workspace = manager.get_workspace_by_index(i);
            const windows = workspace.list_windows().filter(w =>
                !w.is_on_all_workspaces() && w.get_window_type() === Meta.WindowType.NORMAL);
            workspaces.push({
                number: i + 1,
                id: this._workspaceId(workspace),
                windows: windows.length,
                active: workspace === active,
            });
        }
        return {
            extension_version: this._extension.metadata.version,
            shell_version: Config.PACKAGE_VERSION,
            enabled: this._settings.get_boolean('enabled'),
            indicator: {
                visibility: this._settings.get_string('indicator-visibility'),
                visible: this._indicator.iconVisible,
                agent_active: this._activity.active,
            },
            locked: Main.sessionMode.isLocked,
            session_mode: Main.sessionMode.currentMode,
            stage: {width: global.stage.width, height: global.stage.height},
            monitors: Main.layoutManager.monitors.map(m => ({
                index: m.index,
                x: m.x, y: m.y, width: m.width, height: m.height,
                scale: global.display.get_monitor_scale(m.index),
                primary: m.index === primary,
            })),
            workspace: {
                active: workspaceNumber(active),
                active_id: this._workspaceId(active),
                count: manager.get_n_workspaces(),
            },
            workspaces,
            focus: focus ? windowInfo(focus, this._tracker, focus) : null,
            overview: {
                visible: Main.overview.visible,
                animating: Main.overview.animationInProgress,
                apps: Main.overview.dash.showAppsButton.checked,
            },
            pointer: {x: px, y: py},
            animations: St.Settings.get().enable_animations,
        };
    }

    // True while something the user would see is still moving.
    _busy() {
        const wm = Main.wm;
        return Main.overview.animationInProgress ||
            Boolean(wm._workspaceAnimation?._switchData) ||
            [wm._mapping, wm._minimizing, wm._unminimizing, wm._destroying, wm._resizing]
                .some(set => set?.size > 0);
    }

    async _settle(timeoutMs) {
        const start = GLib.get_monotonic_time();
        const deadline = start + Math.min(timeoutMs, MAX_SETTLE_MS) * 1000;
        await this._sources.frame();
        while (this._busy()) {
            if (GLib.get_monotonic_time() >= deadline)
                return {settled: false, waited_ms: Math.round((GLib.get_monotonic_time() - start) / 1000)};
            await this._sources.sleep(20);
        }
        await this._sources.frame();
        await this._sources.frame();
        const quiet = await this._quiet(QUIET_MS, Math.min(MAX_QUIET_WAIT_MS,
            Math.max(0, (deadline - GLib.get_monotonic_time()) / 1000)));
        return {
            settled: quiet,
            waited_ms: Math.round((GLib.get_monotonic_time() - start) / 1000),
        };
    }

    // Menus and other UI animations have no common "busy" flag, but they all
    // repaint the stage every frame: wait for a short stretch with no paints.
    async _quiet(quietMs, capMs) {
        let lastPaint = GLib.get_monotonic_time();
        const id = global.stage.connect('after-paint', () => {
            lastPaint = GLib.get_monotonic_time();
        });
        this._paintWatches.add(id);
        try {
            const deadline = GLib.get_monotonic_time() + capMs * 1000;
            while (GLib.get_monotonic_time() - lastPaint < quietMs * 1000) {
                if (GLib.get_monotonic_time() >= deadline)
                    return false;
                await this._sources.sleep(15);
            }
            return true;
        } finally {
            if (this._paintWatches.delete(id))
                global.stage.disconnect(id);
        }
    }

    GetStateAsync(_params, invocation) {
        return this._run(invocation, 'state', () => this._state(), {gated: false, activity: false});
    }

    ListWindowsAsync(_params, invocation) {
        return this._run(invocation, 'windows', () => {
            const focus = global.display.get_focus_window();
            const windows = global.display.sort_windows_by_stacking(allWindows());
            return windows.map(w => windowInfo(w, this._tracker, focus));
        });
    }

    ScreenshotAsync([options, fdIndex], invocation, fdList) {
        return this._run(invocation, 'screenshot', () => {
            if (!fdList || fdIndex >= fdList.get_length())
                throw new DeskctlError('InvalidArgs', 'Screenshot needs a writable file descriptor');
            return Capture.screenshot(unpackOptions(options), fdList.get(fdIndex));
        });
    }

    PickColorAsync([x, y], invocation) {
        return this._run(invocation, 'pick color', () => Capture.pickColor(x, y));
    }

    SwitchWorkspaceAsync([number], invocation) {
        return this._run(invocation, 'switch workspace', () => {
            const workspace = workspaceByNumber(number);
            workspace.activate(global.get_current_time());
            return {workspace: number};
        });
    }

    ActivateWorkspaceIdAsync([id], invocation) {
        return this._run(invocation, 'switch workspace', () => {
            const manager = global.workspace_manager;
            for (let i = 0; i < manager.get_n_workspaces(); i++) {
                const workspace = manager.get_workspace_by_index(i);
                if (this._workspaceIds.get(workspace) === id) {
                    workspace.activate(global.get_current_time());
                    return {workspace: i + 1, id};
                }
            }
            throw new DeskctlError('NotFound', `Workspace ${id} no longer exists`);
        });
    }

    WindowActionAsync([id, action, args], invocation) {
        return this._run(invocation, `window ${action}`, () => {
            const window = findWindow(id);
            const time = global.get_current_time();
            const options = unpackOptions(args);
            const actions = {
                focus: () => Main.activateWindow(window, time),
                close: () => window.delete(time),
                minimize: () => window.minimize(),
                unminimize: () => window.unminimize(),
                maximize: () => window.maximize(),
                unmaximize: () => window.unmaximize(),
                fullscreen: () => window.make_fullscreen(),
                unfullscreen: () => window.unmake_fullscreen(),
                'move-workspace': () => {
                    const workspace = workspaceByNumber(options.workspace);
                    window.change_workspace(workspace);
                },
                'move-resize': () => {
                    const {x, y, width, height} = options;
                    if (![x, y, width, height].every(Number.isInteger) || width <= 0 || height <= 0)
                        throw new DeskctlError('InvalidArgs', 'move-resize needs x, y, width, height');
                    if (window.is_maximized())
                        window.unmaximize();
                    if (window.is_fullscreen())
                        window.unmake_fullscreen();
                    window.move_resize_frame(true, x, y, width, height);
                },
            };
            if (!actions[action])
                throw new DeskctlError('InvalidArgs', `Unknown window action ${action}`);
            actions[action]();
            return {window: id, action};
        });
    }

    OverviewAsync([action], invocation) {
        return this._run(invocation, `overview ${action}`, () => {
            if (action === 'show')
                Main.overview.show();
            else if (action === 'hide')
                Main.overview.hide();
            else if (action === 'apps')
                Main.overview.showApps();
            else
                throw new DeskctlError('InvalidArgs', 'Overview action must be show, hide or apps');
            return {action};
        });
    }

    SettleAsync([timeoutMs], invocation) {
        return this._run(invocation, 'settle', () => this._settle(timeoutMs), {activity: false});
    }

    LaunchAppAsync([appId, newWindow], invocation) {
        return this._run(invocation, `launch ${appId}`, () => {
            const id = appId.endsWith('.desktop') ? appId : `${appId}.desktop`;
            const app = Shell.AppSystem.get_default().lookup_app(id);
            if (!app)
                throw new DeskctlError('NotFound', `No installed application ${id}`);
            if (newWindow && app.can_open_new_window())
                app.open_new_window(-1);
            else
                app.activate();
            return {app_id: id, running_windows: app.get_n_windows()};
        });
    }

    KeysAsync([combos], invocation) {
        return this._run(invocation, 'keys', () => this._input.keys(combos), {hold: true});
    }

    TypeTextAsync([text], invocation) {
        return this._run(invocation, 'type', () => this._input.type(text), {hold: true});
    }

    PointerAsync([action, args], invocation) {
        return this._run(invocation, `pointer ${action}`,
            () => this._input.pointerAction(action, unpackOptions(args)), {hold: true});
    }

    ShellTreeAsync([root, depth, includeHidden], invocation) {
        return this._run(invocation, `tree ${root}`,
            () => Capture.shellTree(root, Math.min(depth, 64), includeHidden));
    }
}

export default class DeskctlExtension extends Extension {
    enable() {
        this._service = new Service(this);
    }

    disable() {
        this._service?.destroy();
        this._service = null;
    }
}
