import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const PULSE_MS = 2000;
const HISTORY = 5;

export function ago(microseconds) {
    const seconds = Math.max(0, Math.round((GLib.get_monotonic_time() - microseconds) / 1e6));
    if (seconds < 60)
        return `${seconds}s ago`;
    if (seconds < 3600)
        return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
}

// Shared by the panel indicator and the Quick Settings toggle: an agent is
// "active" while input is being injected and for a moment after any call.
export const Activity = GObject.registerClass({
    Signals: {'changed': {}},
}, class DeskctlActivity extends GObject.Object {
    _init(sources) {
        super._init();
        this._sources = sources;
        this._busy = 0;
        this._pulse = 0;
        this.history = [];
    }

    get last() {
        return this.history[0] ?? null;
    }

    get active() {
        return this._busy > 0 || this._pulse !== 0;
    }

    record(action, caller) {
        this.history.unshift({action, caller, time: GLib.get_monotonic_time()});
        this.history.length = Math.min(this.history.length, HISTORY);
        this._sources.cancelTimeout(this._pulse);
        this._pulse = this._sources.timeout(PULSE_MS, () => {
            this._pulse = 0;
            this.emit('changed');
        });
        this.emit('changed');
    }

    async hold(promise) {
        this._busy++;
        this.emit('changed');
        try {
            return await promise;
        } finally {
            this._busy--;
            this.emit('changed');
        }
    }

    describeHistory() {
        return this.history.map(({action, caller, time}) => `${action} · ${caller} · ${ago(time)}`);
    }

    destroy() {
        this._sources.cancelTimeout(this._pulse);
        this._pulse = 0;
    }
});
