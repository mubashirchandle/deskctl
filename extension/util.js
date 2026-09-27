import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

export const ERROR_PREFIX = 'org.gnome.Shell.Extensions.Deskctl.Error';

// Codes map to D-Bus error names; the CLI maps those to exit statuses.
export class DeskctlError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

// Workspaces are numbered from 1, matching GNOME's Super+N bindings.
export function workspaceNumber(workspace) {
    return workspace ? workspace.index() + 1 : null;
}

export function workspaceByNumber(number) {
    const manager = global.workspace_manager;
    const count = manager.get_n_workspaces();
    if (!Number.isInteger(number) || number < 1 || number > count)
        throw new DeskctlError('InvalidArgs', `Workspace must be 1..${count}, got ${number}`);
    return manager.get_workspace_by_index(number - 1);
}

export function allWindows() {
    return global.get_window_actors()
        .map(actor => actor.meta_window)
        .filter(window => window && !window.is_override_redirect());
}

export function findWindow(id) {
    const window = allWindows().find(w => w.get_id() === id);
    if (!window)
        throw new DeskctlError('NotFound', `No window with id ${id}`);
    return window;
}

// Owns every timeout and later the extension schedules so disable() can drop them.
export class Sources {
    constructor() {
        this._timeouts = new Set();
        this._laters = new Set();
    }

    timeout(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    cancelTimeout(id) {
        if (this._timeouts.delete(id))
            GLib.source_remove(id);
    }

    later(callback) {
        const laters = global.compositor.get_laters();
        const id = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laters.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._laters.add(id);
        return id;
    }

    cancelLater(id) {
        if (this._laters.delete(id))
            global.compositor.get_laters().remove(id);
    }

    sleep(ms) {
        return new Promise(resolve => this.timeout(ms, resolve));
    }

    // Resolves after the next redraw, or after a timeout when nothing repaints.
    frame(timeoutMs = 100) {
        return new Promise(resolve => {
            let later = 0;
            let timeout = 0;
            const done = () => {
                this.cancelLater(later);
                this.cancelTimeout(timeout);
                resolve();
            };
            later = this.later(done);
            timeout = this.timeout(timeoutMs, done);
            global.stage.queue_redraw();
        });
    }

    destroy() {
        for (const id of this._timeouts)
            GLib.source_remove(id);
        const laters = global.compositor.get_laters();
        for (const id of this._laters)
            laters.remove(id);
        this._timeouts.clear();
        this._laters.clear();
    }
}
