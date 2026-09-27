import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// The Quick Settings toggle is always available; this only affects the icon.
const VISIBILITY = [
    ['always', 'Always', 'Shown at all times, crossed out while access is off'],
    ['enabled', 'When access is allowed', 'Hidden while agent access is switched off'],
    ['active', 'While an agent is using it', 'Appears during captures and input, then hides'],
];

export default class DeskctlPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const access = new Adw.PreferencesGroup({
            title: 'Agent Access',
            description: 'Lets local AI agents capture the screen, manage windows and ' +
                'workspaces, and send input through the deskctl command. Also available ' +
                'as a Quick Settings toggle.',
        });
        const allow = new Adw.SwitchRow({title: 'Allow agent access'});
        settings.bind('enabled', allow, 'active', Gio.SettingsBindFlags.DEFAULT);
        access.add(allow);
        page.add(access);

        const panel = new Adw.PreferencesGroup({
            title: 'Top Bar',
            description: 'The eye icon next to Wi-Fi and battery turns red while an agent ' +
                'is working.',
        });
        const show = new Adw.ComboRow({
            title: 'Show icon',
            model: Gtk.StringList.new(VISIBILITY.map(([, label]) => label)),
        });
        const sync = () => {
            const index = VISIBILITY.findIndex(([value]) =>
                value === settings.get_string('indicator-visibility'));
            show.selected = Math.max(index, 0);
            show.subtitle = VISIBILITY[show.selected][2];
        };
        sync();
        show.connect('notify::selected', () => {
            settings.set_string('indicator-visibility', VISIBILITY[show.selected][0]);
            show.subtitle = VISIBILITY[show.selected][2];
        });
        settings.connect('changed::indicator-visibility', sync);
        panel.add(show);
        page.add(panel);

        window.add(page);
    }
}
