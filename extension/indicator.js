import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const PULSE_MS = 2000;

function ago(microseconds) {
    const seconds = Math.max(0, Math.round((GLib.get_monotonic_time() - microseconds) / 1e6));
    if (seconds < 60)
        return `${seconds}s ago`;
    if (seconds < 3600)
        return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
}

// Always visible so the kill switch is one click away; dim when idle, red
// while an agent is capturing or injecting input.
export const Indicator = GObject.registerClass(
class DeskctlIndicator extends PanelMenu.Button {
    _init(settings, sources) {
        super._init(0.0, 'Deskctl', false);
        this._settings = settings;
        this._sources = sources;
        this._busy = 0;
        this._pulse = 0;
        this._last = null;
        this.add_style_class_name('deskctl-indicator');

        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._switch = new PopupMenu.PopupSwitchMenuItem('Allow agent access',
            this._settings.get_boolean('enabled'));
        this._switch.connect('toggled', (_item, state) =>
            this._settings.set_boolean('enabled', state));
        this.menu.addMenuItem(this._switch);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._lastItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._lastItem);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._syncLast();
        });

        this._settingsId = this._settings.connect('changed::enabled', () => this._sync());
        this._sync();
        this._syncLast();
    }

    // Records what ran and briefly highlights the icon.
    activity(action, caller) {
        this._last = {action, caller, time: GLib.get_monotonic_time()};
        this._sources.cancelTimeout(this._pulse);
        this._pulse = this._sources.timeout(PULSE_MS, () => {
            this._pulse = 0;
            this._sync();
        });
        this._sync();
        if (this.menu.isOpen)
            this._syncLast();
    }

    // Keeps the icon highlighted for the whole duration of input injection.
    async hold(promise) {
        this._busy++;
        this._sync();
        try {
            return await promise;
        } finally {
            this._busy--;
            this._sync();
        }
    }

    _sync() {
        const enabled = this._settings.get_boolean('enabled');
        this._switch.setToggleState(enabled);
        this._icon.icon_name = enabled ? 'view-reveal-symbolic' : 'view-conceal-symbolic';
        const active = enabled && (this._busy > 0 || this._pulse !== 0);
        this[active ? 'add_style_class_name' : 'remove_style_class_name']('deskctl-active');
        this[enabled ? 'remove_style_class_name' : 'add_style_class_name']('deskctl-disabled');
    }

    _syncLast() {
        if (!this._last) {
            this._lastItem.label.text = 'No agent activity yet';
            return;
        }
        const {action, caller, time} = this._last;
        this._lastItem.label.text = `Last: ${action} · ${caller} · ${ago(time)}`;
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        this._sources.cancelTimeout(this._pulse);
        super.destroy();
    }
});
