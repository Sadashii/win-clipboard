// Sending text / paste keystrokes to the window the user was in.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CB} from './history.js';

const TERMINALS = ['terminal', 'ptyxis', 'kitty', 'alacritty', 'ghostty', 'foot', 'konsole',
    'tilix', 'terminator', 'wezterm', 'xterm', 'urxvt', 'blackbox', 'contour', 'warp'];

export class Inserter {
    constructor(history, watcher) {
        this._history = history;
        this._watcher = watcher;
        this._sources = new Set();
        this._vdev = null;
    }

    // Runs `fn` every `ms` until it returns false; tracked so disable() can cancel it.
    _repeat(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (fn())
                return GLib.SOURCE_CONTINUE;
            this._sources.delete(id);
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
    }

    _later(ms, fn) {
        this._repeat(ms, () => {
            fn();
            return false;
        });
    }

    _refocus(win) {
        if (win && global.display.focus_window !== win)
            win.activate(global.get_current_time());
    }

    // Presses Ctrl+V (Ctrl+Shift+V in terminals) in `win`.
    paste(win) {
        if (!win)
            return;
        this._refocus(win);
        this._later(90, () => this._sendPasteKeys(win));
    }

    // Types `text` into `win`: through the input method when the app supports it,
    // otherwise via the clipboard, restoring the previous clipboard afterwards.
    insertText(text, win) {
        if (!win)
            return;
        this._refocus(win);
        let waited = 0;
        this._repeat(30, () => {
            if (Main.inputMethod.currentFocus) {
                Main.inputMethod.commit(text);
                return false;
            }
            waited += 30;
            if (waited < 300)
                return true;
            this._insertViaClipboard(text, win);
            return false;
        });
    }

    _insertViaClipboard(text, win) {
        const clipboard = St.Clipboard.get_default();
        clipboard.get_text(CB, (_c, previous) => {
            this._watcher.suppress(1500);
            clipboard.set_text(CB, text);
            this._later(40, () => {
                this._sendPasteKeys(win);
                this._later(400, () => {
                    this._watcher.suppress(500);
                    if (previous !== null)
                        clipboard.set_text(CB, previous);
                    else if (this._history.items[0])
                        this._history.copyToClipboard(this._history.items[0]);
                });
            });
        });
    }

    _sendPasteKeys(win) {
        if (!this._vdev) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._vdev = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        let wmClass = '';
        try {
            wmClass = `${win.get_wm_class() ?? ''} ${win.get_wm_class_instance() ?? ''}`.toLowerCase();
        } catch {}
        const keys = TERMINALS.some(t => wmClass.includes(t))
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];

        let t = GLib.get_monotonic_time();
        for (const k of keys)
            this._vdev.notify_keyval(t++, k, Clutter.KeyState.PRESSED);
        for (const k of [...keys].reverse())
            this._vdev.notify_keyval(t++, k, Clutter.KeyState.RELEASED);
    }

    destroy() {
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        this._vdev = null;
    }
}
