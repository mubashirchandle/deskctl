import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const ICON_ON = 'view-reveal-symbolic';
const ICON_OFF = 'view-conceal-symbolic';

// The kill switch, next to Wi-Fi and Dark Style. Expanding it shows recent
// agent activity and a link to the preferences.
const AgentAccessToggle = GObject.registerClass(
class DeskctlAgentAccessToggle extends QuickMenuToggle {
    _init(extension, settings, activity) {
        super._init({
            title: 'Agents',
            iconName: ICON_ON,
            toggleMode: true,
            menuButtonAccessibleName: 'Open Agent Access menu',
        });
        this._settings = settings;
        this._activity = activity;
        this._settings.bind('enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);

        this._recent = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._recent);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = this.menu.addAction('Settings', () => {
            extension.openPreferences();
            Main.panel.statusArea.quickSettings.menu.close(PopupAnimation.FADE);
        });
        // Registered like the built-in toggles so the shell hides it when locked.
        settingsItem.visible = Main.sessionMode.allowSettings;
        this.menu._settingsActions[extension.uuid] = settingsItem;

        this.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this._syncRecent(); // Refresh the "12s ago" times.
        }, this);
        this._settings.connectObject('changed::enabled', () => this._sync(), this);
        this._activity.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const enabled = this._settings.get_boolean('enabled');
        this.iconName = enabled ? ICON_ON : ICON_OFF;
        if (!enabled)
            this.subtitle = 'Off';
        else
            this.subtitle = this._activity.active ? 'In use' : 'Idle';
        this.menu.setHeader(this.iconName, 'Agent Access',
            enabled ? 'Agents may use the desktop' : 'Agents are refused');
        if (this.menu.isOpen)
            this._syncRecent();
    }

    _syncRecent() {
        this._recent.removeAll();
        const history = this._activity.describeHistory();
        if (history.length === 0) {
            this._recent.addMenuItem(new PopupMenu.PopupMenuItem('No agent activity yet',
                {reactive: false}));
            return;
        }
        for (const line of history)
            this._recent.addMenuItem(new PopupMenu.PopupMenuItem(line, {reactive: false}));
    }
});

// The eye icon in the system status area, grouped with Wi-Fi, volume and
// battery. The indicator-visibility setting decides when it shows; the toggle
// above stays reachable regardless.
export const AgentAccessIndicator = GObject.registerClass(
class DeskctlAgentAccessIndicator extends SystemIndicator {
    _init(extension, settings, activity) {
        super._init();
        this._settings = settings;
        this._activity = activity;
        this._indicator = this._addIndicator();
        this.quickSettingsItems.push(new AgentAccessToggle(extension, settings, activity));

        this._settings.connectObject(
            'changed::enabled', () => this._sync(),
            'changed::indicator-visibility', () => this._sync(),
            this);
        this._activity.connectObject('changed', () => this._sync(), this);
        this._sync();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this);
    }

    _sync() {
        const enabled = this._settings.get_boolean('enabled');
        const active = enabled && this._activity.active;
        this._indicator.icon_name = enabled ? ICON_ON : ICON_OFF;
        this._indicator[active ? 'add_style_class_name' : 'remove_style_class_name']('deskctl-active');

        const mode = this._settings.get_string('indicator-visibility');
        this._indicator.visible = mode === 'always' ||
            (mode === 'enabled' && enabled) ||
            (mode === 'active' && active);
    }

    get iconVisible() {
        return this._indicator.visible;
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});
