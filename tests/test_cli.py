"""Unit tests for deskctl's pure logic and for invariants between CLI and extension."""
import argparse
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import re
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
loader = importlib.machinery.SourceFileLoader('deskctl', str(ROOT / 'bin' / 'deskctl'))
spec = importlib.util.spec_from_loader('deskctl', loader)
deskctl = importlib.util.module_from_spec(spec)
loader.exec_module(deskctl)

from gi.repository import Gio  # noqa: E402  (loaded by deskctl with the right version)

EXTENSION_JS = (ROOT / 'extension' / 'extension.js').read_text()
CLI_SOURCE = (ROOT / 'bin' / 'deskctl').read_text()


class KeyComboTests(unittest.TestCase):
    def test_modifiers_and_keys(self):
        self.assertEqual(deskctl.parse_combo('super+Return'), ['Super_L', 'Return'])
        self.assertEqual(deskctl.parse_combo('ctrl+alt+t'), ['Control_L', 'Alt_L', 't'])
        self.assertEqual(deskctl.parse_combo('Ctrl+Shift+Esc'), ['Control_L', 'Shift_L', 'Escape'])
        self.assertEqual(deskctl.parse_combo('super'), ['Super_L'])

    def test_letters_digits_function_keys(self):
        self.assertEqual(deskctl.parse_combo('A'), ['a'])
        self.assertEqual(deskctl.parse_combo('super+1'), ['Super_L', '1'])
        self.assertEqual(deskctl.parse_combo('f11'), ['F11'])
        self.assertEqual(deskctl.parse_combo('alt+F4'), ['Alt_L', 'F4'])

    def test_punctuation_and_plus(self):
        self.assertEqual(deskctl.parse_combo('ctrl+-'), ['Control_L', 'minus'])
        self.assertEqual(deskctl.parse_combo('ctrl++'), ['Control_L', 'plus'])
        self.assertEqual(deskctl.parse_combo('+'), ['plus'])
        self.assertEqual(deskctl.parse_combo('super+.'), ['Super_L', 'period'])

    def test_raw_keysyms_pass_through(self):
        self.assertEqual(deskctl.parse_combo('XF86AudioMute'), ['XF86AudioMute'])
        self.assertEqual(deskctl.parse_combo('Super_R'), ['Super_R'])

    def test_accelerators(self):
        self.assertEqual(deskctl.accel_to_combo('<Super>s'), ['Super_L', 's'])
        self.assertEqual(deskctl.accel_to_combo('<Primary><Alt>t'), ['Control_L', 'Alt_L', 't'])
        self.assertIsNone(deskctl.accel_to_combo(''))
        self.assertIsNone(deskctl.accel_to_combo('<Hyper>x'))

    def test_rejects_malformed(self):
        # Unknown-but-well-formed names (f36) pass through; the extension rejects them.
        for combo in ('', 'ctrl+', '+ctrl', 'ctrl++alt', 'ctrl+é', 'bad!key'):
            with self.subTest(combo=combo):
                with self.assertRaises(deskctl.DeskctlError) as caught:
                    deskctl.parse_combo(combo)
                self.assertEqual(caught.exception.status, deskctl.EXIT_USAGE)


class ArgumentTests(unittest.TestCase):
    def test_parse_rect(self):
        self.assertEqual(deskctl.parse_rect('10, 20,300,40'),
                         {'x': 10, 'y': 20, 'width': 300, 'height': 40})
        self.assertEqual(deskctl.parse_rect('-5,0,1,1')['x'], -5)
        for bad in ('1,2,3', '1,2,0,4', 'a,b,c,d', '1,2,3,-4'):
            with self.subTest(rect=bad), self.assertRaises(argparse.ArgumentTypeError):
                deskctl.parse_rect(bad)

    def test_window_ids(self):
        self.assertEqual(deskctl.parse_window_id('focused'), 'focused')
        self.assertEqual(deskctl.parse_window_id('4160228663'), 4160228663)
        with self.assertRaises(argparse.ArgumentTypeError):
            deskctl.parse_window_id('-1')

    def test_parser_accepts_documented_forms(self):
        parser = deskctl.build_parser()
        args = parser.parse_args(['screenshot', '--area', '0,0,100,50', '--grid'])
        self.assertEqual(args.grid, 100)
        args = parser.parse_args(['sandbox', 'start', '--size', '1280x800', '--scale', '2'])
        self.assertEqual((args.size, args.scale), ('1280x800', 2.0))
        args = parser.parse_args(['sandbox', 'run', '--', 'foo', '--size', 'x'])
        self.assertEqual(args.run_command, ['--', 'foo', '--size', 'x'])
        args = parser.parse_args(['--sandbox', 'box', 'window', 'move', 'focused', '--workspace', '2'])
        self.assertEqual((args.sandbox, args.id, args.workspace), ('box', 'focused', 2))
        with self.assertRaises(SystemExit), mock.patch('sys.stderr'):
            parser.parse_args(['screenshot', '--monitor', '0', '--window', 'focused'])

    def test_hold_parses_keys(self):
        args = deskctl.build_parser().parse_args(['drag', '1', '2', '3', '4', '--hold', 'ctrl+shift'])
        self.assertEqual(deskctl.parse_hold(args.hold), ['Control_L', 'Shift_L'])
        self.assertIsNone(deskctl.parse_hold(None))

class GridTests(unittest.TestCase):
    def test_lines_inside_capture(self):
        self.assertEqual(deskctl.grid_lines(0, 350, 100), [0, 100, 200, 300])
        self.assertEqual(deskctl.grid_lines(150, 200, 100), [200, 300])
        self.assertEqual(deskctl.grid_lines(10, 50, 100), [])


class SettingsDiffTests(unittest.TestCase):
    OLD = """[org/gnome/desktop/interface]
color-scheme='default'
font-name='Adwaita Sans 11'

[org/gnome/shell]
enabled-extensions=['a@x', 'b@y']
"""
    NEW = """[org/gnome/desktop/interface]
color-scheme='prefer-dark'
font-name='Adwaita Sans 11'

[org/gnome/shell]
enabled-extensions=['a@x', 'b@y']

[org/gnome/mutter]
dynamic-workspaces=false
"""

    def test_flattens_sections(self):
        flat = deskctl.parse_dconf_dump(self.OLD)
        self.assertEqual(flat['/org/gnome/desktop/interface/color-scheme'], "'default'")
        self.assertEqual(flat['/org/gnome/shell/enabled-extensions'], "['a@x', 'b@y']")

    def test_diff(self):
        diff = deskctl.diff_settings(deskctl.parse_dconf_dump(self.OLD),
                                     deskctl.parse_dconf_dump(self.NEW))
        self.assertEqual(diff['changed'], {'/org/gnome/desktop/interface/color-scheme':
                                           {'old': "'default'", 'new': "'prefer-dark'"}})
        self.assertEqual(diff['added'], {'/org/gnome/mutter/dynamic-workspaces': 'false'})
        self.assertEqual(diff['removed'], {})

    def test_format_round_trips(self):
        flat = deskctl.parse_dconf_dump(self.NEW)
        self.assertEqual(deskctl.parse_dconf_dump(deskctl.format_dconf_dump(flat)), flat)
        self.assertIn('[/]\nroot-key=1', deskctl.format_dconf_dump({'/root-key': '1'}))

    def test_values_containing_equals_and_hashes(self):
        flat = deskctl.parse_dconf_dump("[a/b]\nkey='x=y # not a comment'\n")
        self.assertEqual(flat['/a/b/key'], "'x=y # not a comment'")


class TreeRenderTests(unittest.TestCase):
    def test_outline(self):
        tree = {'type': 'StBoxLayout', 'name': 'panelRight', 'rect': [0, 0, 100, 32], 'children': [
            {'type': 'StLabel', 'style_class': 'clock foo', 'text': 'Mon 9:00', 'rect': [1, 2, 3, 4]},
            {'type': 'StIcon', 'icon': 'x-symbolic', 'visible': False},
            {'type': 'StWidget', 'rect': [0, 0, 1, 1], 'reactive': True, 'children_omitted': 3},
        ]}
        self.assertEqual(deskctl.render_tree(tree), [
            'StBoxLayout#panelRight [0,0 100x32]',
            '  StLabel .clock.foo "Mon 9:00" [1,2 3x4]',
            '  StIcon icon=x-symbolic HIDDEN',
            '  StWidget [0,0 1x1] reactive (+3 children)',
        ])


class ErrorMappingTests(unittest.TestCase):
    def translate(self, name, message='boom', sandbox=None, locked=False):
        target = deskctl.Target.__new__(deskctl.Target)
        target.sandbox, target.label = sandbox, 'live'
        target.bus = mock.Mock()
        target.bus.call_sync.return_value.unpack.return_value = (locked,)
        return target._translate(Gio.DBusError.new_for_dbus_error(name, message))

    def test_extension_errors(self):
        cases = {'Disabled': 4, 'Locked': 5, 'NotFound': 6, 'InvalidArgs': 2, 'Failed': 1}
        for code, status in cases.items():
            with self.subTest(code=code):
                error = self.translate(deskctl.ERROR_PREFIX + code, 'details here')
                self.assertEqual(error.status, status)
                self.assertEqual(str(error), 'details here')

    def test_missing_extension(self):
        error = self.translate('org.freedesktop.DBus.Error.UnknownObject')
        self.assertEqual(error.status, deskctl.EXIT_UNAVAILABLE)
        self.assertIn('gnome-extensions enable deskctl@local', str(error))

    def test_locked_screen_is_not_a_missing_extension(self):
        # GNOME unloads user extensions on the lock screen, so the object vanishes.
        error = self.translate('org.freedesktop.DBus.Error.UnknownObject', locked=True)
        self.assertEqual(error.status, deskctl.EXIT_LOCKED)
        self.assertIn('locked', str(error))


class SandboxIsolationTests(unittest.TestCase):
    """A sandbox must never inherit a variable that routes writes to the real session."""

    def test_env_is_built_from_scratch(self):
        leaky = {
            'HOME': '/home/u', 'PATH': '/usr/bin', 'LANG': 'C.UTF-8',
            'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/1000/bus',
            'XDG_CONFIG_HOME': '/home/u/.config', 'XDG_DATA_HOME': '/home/u/.local/share',
            'XDG_RUNTIME_DIR': '/run/user/1000', 'WAYLAND_DISPLAY': 'wayland-0', 'DISPLAY': ':0',
            'DCONF_PROFILE': '/etc/evil', 'GSETTINGS_BACKEND': 'memory',
        }
        with mock.patch.dict(os.environ, leaky, clear=True):
            sandbox = deskctl.Sandbox('iso')
            env = sandbox.base_env()
        self.assertEqual(env['DBUS_SESSION_BUS_ADDRESS'], f'unix:path={sandbox.runtime / "bus"}')
        for key in ('XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'):
            self.assertTrue(env[key].startswith(str(sandbox.home)), key)
        self.assertTrue(env['XDG_RUNTIME_DIR'].endswith('deskctl-sandbox-iso'))
        for key in ('WAYLAND_DISPLAY', 'DISPLAY', 'DCONF_PROFILE', 'GSETTINGS_BACKEND'):
            self.assertNotIn(key, env)
        self.assertEqual(env['HOME'], '/home/u')

    def test_client_env_points_at_sandbox_display(self):
        env = deskctl.Sandbox('iso').client_env()
        self.assertEqual(env['WAYLAND_DISPLAY'], 'deskctl-iso')
        self.assertEqual(env['DESKCTL_CACHE_DIR'], str(deskctl.CACHE_DIR))

    def test_every_spawned_process_gets_an_explicit_env(self):
        # The dbus-daemon once inherited the real XDG_CONFIG_HOME, so its
        # activated dconf-service wrote into the user's real settings.
        calls = re.findall(r'subprocess\.Popen\((.*?)\)\n', CLI_SOURCE, re.S)
        self.assertGreaterEqual(len(calls), 5)
        for call in calls:
            self.assertRegex(call, r'\benv=', call[:60])

    def test_names_are_validated(self):
        for name in ('../x', 'a b', '', 'x' * 33):
            with self.subTest(name=name), self.assertRaises(deskctl.DeskctlError):
                deskctl.Sandbox(name)



class AccessibilityTests(unittest.TestCase):
    WINDOW = {'rect': {'x': 460, 'y': 108, 'width': 360, 'height': 616},
              'client_rect': {'x': 435, 'y': 83, 'width': 410, 'height': 666},
              'buffer_rect': {'x': 435, 'y': 83, 'width': 410, 'height': 666}}

    def test_origin_uses_the_rectangle_matching_the_frame(self):
        # GTK4 counts from the frame; toolkits drawing shadows count from the buffer.
        self.assertEqual(deskctl.a11y_origin((0, 0, 360, 616), self.WINDOW), (460, 108))
        self.assertEqual(deskctl.a11y_origin((0, 0, 410, 666), self.WINDOW), (435, 83))
        self.assertEqual(deskctl.a11y_origin((25, 25, 360, 616), self.WINDOW), (435, 83))
        self.assertEqual(deskctl.a11y_origin((0, 0, 100, 100), self.WINDOW), (460, 108))

    TREE = {'role': 'frame', 'name': 'App', 'children': [
        {'role': 'toggle button', 'name': 'Main Menu', 'rect': [10, 10, 30, 30]},
        {'role': 'button', 'name': 'Close', 'rect': [50, 10, 30, 30]},
        {'role': 'text', 'name': '', 'text': 'hello', 'rect': [0, 50, 100, 20]},
        {'role': 'toggle button', 'name': '', 'description': 'Snapping\nToggle snapping (%)'},
        {'role': 'spin button', 'name': '', 'text': '67.0', 'description': 'Width of selection'},
        {'role': 'dialog', 'name': 'About', 'children': [
            {'role': 'button', 'name': 'Close', 'rect': [60, 60, 30, 30]}]},
    ]}

    def test_matching(self):
        match = deskctl.a11y_matches
        names = lambda found: [n['name'] for n in found]  # noqa: E731
        self.assertEqual(names(match(self.TREE, 'main menu')), ['Main Menu'])
        self.assertEqual(names(match(self.TREE, 'Main', regex=True)), ['Main Menu'])
        self.assertEqual(names(match(self.TREE, None, 'Toggle-Button')), ['Main Menu', ''])
        self.assertEqual(len(match(self.TREE, 'close')), 2)
        self.assertEqual(match(self.TREE, 'hello')[0]['role'], 'text')
        self.assertEqual(match(self.TREE, 'mai'), [])
        self.assertEqual(len(match(self.TREE, 'snapping')), 1)
        self.assertEqual(match(self.TREE, 'toggle snapping (%)'), [])
        self.assertEqual(match(self.TREE, 'width of selection')[0]['text'], '67.0')
        self.assertEqual(match(self.TREE, '67.0')[0]['role'], 'spin button')
        # The window itself is never a match, whatever its title.
        self.assertEqual(match(self.TREE, 'app'), [])

    def test_nested_same_named_matches_give_way_to_the_inner_control(self):
        row = {'role': 'switch', 'name': 'Week Day', 'rect': [0, 0, 500, 50], 'children': [
            {'role': 'switch', 'name': 'Week Day', 'rect': [450, 10, 40, 20]}]}
        button = {'role': 'button', 'name': 'x', 'children': [
            {'role': 'toggle button', 'name': 'x', 'rect': [1, 1, 5, 5]}]}
        tree = {'role': 'frame', 'name': 'W', 'children': [row, button]}
        self.assertEqual([n['rect'] for n in deskctl.a11y_matches(tree, 'week day')],
                         [[450, 10, 40, 20]])
        self.assertEqual([n['role'] for n in deskctl.a11y_matches(tree, 'x')], ['toggle button'])
        self.assertEqual([n['role'] for n in deskctl.a11y_matches(tree, 'x', 'button')], ['button'])

    def test_open_dialog_or_popover_scopes_matching(self):
        scope = deskctl.a11y_scope(self.TREE)
        self.assertEqual(scope['name'], 'About')
        self.assertEqual([n['rect'] for n in deskctl.a11y_matches(scope, 'close')], [[60, 60, 30, 30]])
        popover = {'role': 'panel', 'name': '', 'states': ['popup'], 'children': [
            {'role': 'button', 'name': 'Rename'}]}
        with_popover = {**self.TREE, 'children': self.TREE['children'] + [popover]}
        self.assertIs(deskctl.a11y_scope(with_popover), popover)
        no_dialog = {**self.TREE, 'children': self.TREE['children'][:5]}
        self.assertIs(deskctl.a11y_scope(no_dialog), no_dialog)
        chooser = {'role': 'file chooser', 'name': 'Save', 'children': [
            {'role': 'button', 'name': 'Save'},
            {'role': 'file chooser', 'name': 'File Chooser Widget', 'children': []}]}
        self.assertIs(deskctl.a11y_scope(chooser), chooser)

    def test_outline(self):
        lines = deskctl.render_a11y({'role': 'frame', 'name': 'App', 'rect': [0, 0, 9, 9], 'children': [
            {'role': 'check box', 'name': 'Wrap', 'rect': [1, 2, 3, 4], 'states': ['checked']},
            {'role': 'password text', 'name': '', 'text': '(hidden)'},
            {'role': 'menu item', 'name': 'Help', 'rect': [5, 6, 7, 8], 'approx': True,
             'description': 'x' * 100}]})
        self.assertEqual(lines[:3], ['frame "App" [0,0 9x9]',
                                     '  check box "Wrap" [1,2 3x4] checked',
                                     '  password text text="(hidden)"'])
        self.assertEqual(lines[3], '  menu item "Help" [~5,6 7x8] desc="' + 'x' * 80 + '…"')

    def test_sandbox_apps_get_a_private_accessibility_bus(self):
        sandbox = deskctl.Sandbox('iso')
        address = sandbox.base_env()['AT_SPI_BUS_ADDRESS']
        self.assertEqual(address, f'unix:path={sandbox.runtime / "a11y-bus"}')
        self.assertEqual(sandbox.client_env()['AT_SPI_BUS_ADDRESS'], address)

class InvariantTests(unittest.TestCase):
    def test_every_dbus_method_has_a_handler(self):
        methods = re.findall(r'<method name="(\w+)">', EXTENSION_JS)
        self.assertGreater(len(methods), 10)
        for method in methods:
            self.assertIn(f'{method}Async(', EXTENSION_JS, method)

    def test_cli_calls_only_existing_methods(self):
        methods = set(re.findall(r'<method name="(\w+)">', EXTENSION_JS))
        called = set(re.findall(r"call\('(\w+)'", CLI_SOURCE))
        self.assertTrue(called)
        self.assertLessEqual(called, methods)

    def test_only_user_interfaces_write_the_kill_switch(self):
        # The D-Bus API must offer no way to re-enable itself: only the Quick
        # Settings toggle and the preferences window may.
        writers = {'quickSettings.js', 'prefs.js'}
        write = re.compile(r"set_boolean\('enabled'|bind\('enabled'")
        for path in (ROOT / 'extension').glob('*.js'):
            found = bool(write.search(path.read_text()))
            self.assertEqual(found, path.name in writers, path.name)
        self.assertNotIn('org.gnome.shell.extensions.deskctl', CLI_SOURCE)

    def test_no_code_evaluation_surface(self):
        for path in (ROOT / 'extension').glob('*.js'):
            source = path.read_text()
            for banned in ('eval(', 'new Function', 'spawn_command_line', 'Gio.Subprocess',
                           'GLib.spawn', 'Gio.File.new_for_path'):
                self.assertNotIn(banned, source, f'{path.name}: {banned}')


if __name__ == '__main__':
    unittest.main()
