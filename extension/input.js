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
//
// Every key and button currently held is tracked, and each action checks
// between steps whether it has been aborted, so switching agent access off
// stops typing or a drag at once and never leaves anything pressed.
export class Input {
    constructor(sources) {
        this._sources = sources;
        this._keyboard = null;
        this._pointer = null;
        this._heldKeys = new Set();
        this._heldButtons = new Set();
        this._generation = 0;
    }

    destroy() {
        this.abort();
        // Matches ui/keyboard.js: disposing releases anything still held.
        this._keyboard?.run_dispose();
        this._pointer?.run_dispose();
        this._keyboard = null;
        this._pointer = null;
    }

    get held() {
        return {keys: this._heldKeys.size, buttons: this._heldButtons.size};
    }

    // Stops in-flight actions at their next step and releases everything held.
    abort() {
        this._generation++;
        for (const value of this._heldKeys)
            this._keyboard?.notify_keyval(now(), value, Clutter.KeyState.RELEASED);
        for (const button of this._heldButtons)
            this._pointer?.notify_button(now(), button, Clutter.ButtonState.RELEASED);
        this._heldKeys.clear();
        this._heldButtons.clear();
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

    _key(value, pressed) {
        this.keyboard.notify_keyval(now(), value,
            pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
        this._heldKeys[pressed ? 'add' : 'delete'](value);
    }

    _button(button, pressed) {
        this.pointer.notify_button(now(), button,
            pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
        this._heldButtons[pressed ? 'add' : 'delete'](button);
    }

    // Waits between steps; throws if abort() ran meanwhile.
    async _step(ms, generation, progress) {
        await this._sources.sleep(ms);
        if (generation !== this._generation) {
            throw new DeskctlError('Disabled',
                `Agent access was switched off mid-action; stopped${progress ? ` ${progress()}` : ''}`);
        }
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
        const generation = this._generation;
        let done = 0;
        const progress = () => `after ${done} of ${combos.length} combos`;
        for (const values of resolved) {
            const pressed = [];
            try {
                for (const value of values) {
                    this._key(value, true);
                    pressed.push(value);
                    await this._step(KEY_GAP_MS, generation, progress);
                }
            } finally {
                // After an abort these were already released.
                if (generation === this._generation) {
                    for (const value of pressed.reverse())
                        this._key(value, false);
                }
            }
            done++;
            await this._step(KEY_GAP_MS * 4, generation, progress);
        }
        return {combos: combos.length};
    }

    async type(text) {
        if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT)
            throw new DeskctlError('InvalidArgs', `Text must be 1..${MAX_TEXT} characters`);
        const values = [...text].map(char => SPECIAL_CHARS[char] ??
            Clutter.unicode_to_keysym(char.codePointAt(0)));
        const generation = this._generation;
        let typed = 0;
        const progress = () => `after ${typed} of ${values.length} characters`;
        for (const value of values) {
            this._key(value, true);
            typed++; // The character appears on press.
            await this._step(KEY_GAP_MS, generation, progress);
            this._key(value, false);
            await this._step(KEY_GAP_MS, generation, progress);
        }
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
        const generation = this._generation;
        if (args.x !== undefined || args.y !== undefined) {
            this._checkPoint(args.x, args.y);
            await this._moveTo(args.x, args.y, generation);
        }
        if (action === 'move')
            return this._position();

        if (action === 'scroll') {
            const steps = [
                [args.dy ?? 0, Clutter.ScrollDirection.DOWN, Clutter.ScrollDirection.UP],
                [args.dx ?? 0, Clutter.ScrollDirection.RIGHT, Clutter.ScrollDirection.LEFT],
            ];
            for (const [amount] of steps) {
                if (!Number.isInteger(amount) || Math.abs(amount) > 100)
                    throw new DeskctlError('InvalidArgs', 'Scroll steps must be integers within ±100');
            }
            for (const [amount, positive, negative] of steps) {
                for (let i = 0; i < Math.abs(amount); i++) {
                    this.pointer.notify_discrete_scroll(now(), amount > 0 ? positive : negative,
                        Clutter.ScrollSource.WHEEL);
                    await this._step(KEY_GAP_MS, generation);
                }
            }
            return this._position();
        }

        const button = BUTTONS[args.button ?? 'left'];
        if (!button)
            throw new DeskctlError('InvalidArgs', `Button must be one of ${Object.keys(BUTTONS).join(', ')}`);
        if (action === 'press') {
            this._button(button, true);
        } else if (action === 'release') {
            this._button(button, false);
        } else if (action === 'click') {
            const count = args.count ?? 1;
            if (!Number.isInteger(count) || count < 1 || count > 3)
                throw new DeskctlError('InvalidArgs', 'Click count must be 1..3');
            for (let i = 0; i < count; i++) {
                this._button(button, true);
                try {
                    await this._step(KEY_GAP_MS, generation);
                } finally {
                    if (generation === this._generation)
                        this._button(button, false);
                }
                await this._step(KEY_GAP_MS * 3, generation);
            }
        } else {
            throw new DeskctlError('InvalidArgs', `Unknown pointer action ${action}`);
        }
        return this._position();
    }

    // A new virtual pointer can drop an axis of its first absolute motion,
    // so confirm the pointer arrived and resend if it did not.
    async _moveTo(x, y, generation) {
        for (let attempt = 0; attempt < 4; attempt++) {
            this.pointer.notify_absolute_motion(now(), x, y);
            await this._step(KEY_GAP_MS, generation);
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
