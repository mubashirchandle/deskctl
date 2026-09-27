import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {DeskctlError} from './util.js';

const MAX_COMBOS = 32;
const MAX_COMBO_KEYS = 6;
const MAX_TEXT = 10000;
const KEY_GAP_MS = 12;
const BUTTONS = {
    left: Clutter.BUTTON_PRIMARY,
    middle: Clutter.BUTTON_MIDDLE,
    right: Clutter.BUTTON_SECONDARY,
};
const SPECIAL_CHARS = {
    '\n': Clutter.KEY_Return,
    '\t': Clutter.KEY_Tab,
};

function now() {
    return GLib.get_monotonic_time();
}

function keyval(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name))
        throw new DeskctlError('InvalidArgs', `Invalid keysym name ${JSON.stringify(name)}`);
    const value = Clutter[`KEY_${name}`];
    if (!Number.isInteger(value))
        throw new DeskctlError('InvalidArgs', `Unknown keysym ${name}`);
    return value;
}

// Virtual devices go through the same input path as hardware, so compositor
// keybindings (overlay key, custom shortcuts) fire exactly as for a user.
export class Input {
    constructor(sources) {
        this._sources = sources;
        this._keyboard = null;
        this._pointer = null;
    }

    destroy() {
        // Matches ui/keyboard.js: disposing releases anything still held.
        this._keyboard?.run_dispose();
        this._pointer?.run_dispose();
        this._keyboard = null;
        this._pointer = null;
    }

    _device(type) {
        return Clutter.get_default_backend().get_default_seat().create_virtual_device(type);
    }

    get keyboard() {
        this._keyboard ??= this._device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        return this._keyboard;
    }

    get pointer() {
        this._pointer ??= this._device(Clutter.InputDeviceType.POINTER_DEVICE);
        return this._pointer;
    }

    async _tap(value) {
        this.keyboard.notify_keyval(now(), value, Clutter.KeyState.PRESSED);
        await this._sources.sleep(KEY_GAP_MS);
        this.keyboard.notify_keyval(now(), value, Clutter.KeyState.RELEASED);
        await this._sources.sleep(KEY_GAP_MS);
    }

    async keys(combos) {
        if (!Array.isArray(combos) || combos.length === 0 || combos.length > MAX_COMBOS)
            throw new DeskctlError('InvalidArgs', `Send 1..${MAX_COMBOS} key combos`);
        // Validate everything before pressing anything.
        const resolved = combos.map(combo => {
            if (!Array.isArray(combo) || combo.length === 0 || combo.length > MAX_COMBO_KEYS)
                throw new DeskctlError('InvalidArgs', `A combo has 1..${MAX_COMBO_KEYS} keys`);
            return combo.map(keyval);
        });
        for (const values of resolved) {
            const pressed = [];
            try {
                for (const value of values) {
                    this.keyboard.notify_keyval(now(), value, Clutter.KeyState.PRESSED);
                    pressed.push(value);
                    await this._sources.sleep(KEY_GAP_MS);
                }
            } finally {
                for (const value of pressed.reverse())
                    this.keyboard.notify_keyval(now(), value, Clutter.KeyState.RELEASED);
            }
            await this._sources.sleep(KEY_GAP_MS * 4);
        }
        return {combos: combos.length};
    }

    async type(text) {
        if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT)
            throw new DeskctlError('InvalidArgs', `Text must be 1..${MAX_TEXT} characters`);
        const values = [...text].map(char => SPECIAL_CHARS[char] ??
            Clutter.unicode_to_keysym(char.codePointAt(0)));
        for (const value of values)
            await this._tap(value);
        return {characters: values.length};
    }

    _checkPoint(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y) ||
            x < 0 || y < 0 || x >= global.stage.width || y >= global.stage.height) {
            throw new DeskctlError('InvalidArgs',
                `Point ${x},${y} is outside the stage ${global.stage.width}x${global.stage.height}`);
        }
    }

    async pointerAction(action, args) {
        if (args.x !== undefined || args.y !== undefined) {
            this._checkPoint(args.x, args.y);
            await this._moveTo(args.x, args.y);
        }
        if (action === 'move')
            return this._position();

        if (action === 'scroll') {
            const steps = [
                [args.dy ?? 0, Clutter.ScrollDirection.DOWN, Clutter.ScrollDirection.UP],
                [args.dx ?? 0, Clutter.ScrollDirection.RIGHT, Clutter.ScrollDirection.LEFT],
            ];
            for (const [amount, positive, negative] of steps) {
                if (!Number.isInteger(amount) || Math.abs(amount) > 100)
                    throw new DeskctlError('InvalidArgs', 'Scroll steps must be integers within ±100');
                for (let i = 0; i < Math.abs(amount); i++) {
                    this.pointer.notify_discrete_scroll(now(), amount > 0 ? positive : negative,
                        Clutter.ScrollSource.WHEEL);
                    await this._sources.sleep(KEY_GAP_MS);
                }
            }
            return this._position();
        }

        const button = BUTTONS[args.button ?? 'left'];
        if (!button)
            throw new DeskctlError('InvalidArgs', `Button must be one of ${Object.keys(BUTTONS).join(', ')}`);
        const press = () => this.pointer.notify_button(now(), button, Clutter.ButtonState.PRESSED);
        const release = () => this.pointer.notify_button(now(), button, Clutter.ButtonState.RELEASED);
        if (action === 'press') {
            press();
        } else if (action === 'release') {
            release();
        } else if (action === 'click') {
            const count = args.count ?? 1;
            if (!Number.isInteger(count) || count < 1 || count > 3)
                throw new DeskctlError('InvalidArgs', 'Click count must be 1..3');
            for (let i = 0; i < count; i++) {
                press();
                await this._sources.sleep(KEY_GAP_MS);
                release();
                await this._sources.sleep(KEY_GAP_MS * 3);
            }
        } else {
            throw new DeskctlError('InvalidArgs', `Unknown pointer action ${action}`);
        }
        return this._position();
    }

    // A new virtual pointer can drop an axis of its first absolute motion,
    // so confirm the pointer arrived and resend if it did not.
    async _moveTo(x, y) {
        for (let attempt = 0; attempt < 4; attempt++) {
            this.pointer.notify_absolute_motion(now(), x, y);
            await this._sources.sleep(KEY_GAP_MS);
            const [px, py] = global.get_pointer();
            if (Math.abs(px - x) <= 1 && Math.abs(py - y) <= 1)
                return;
        }
        throw new DeskctlError('Failed', `Pointer did not reach ${x},${y}`);
    }

    _position() {
        const [x, y] = global.get_pointer();
        return {pointer: {x, y}};
    }
}
