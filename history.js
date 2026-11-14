// Clipboard history storage and clipboard watching.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

export const CB = St.ClipboardType.CLIPBOARD;
const MAX_TEXT_LENGTH = 4 * 1024 * 1024;   // Windows' limit is 4 MB per item
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];
const TEXT_MIMES = ['UTF8_STRING', 'STRING', 'TEXT'];

function readBootId() {
    try {
        const [, data] = GLib.file_get_contents('/proc/sys/kernel/random/boot_id');
        return new TextDecoder().decode(data).trim();
    } catch {
        return '';
    }
}

export class History {
    constructor(settings) {
        this._settings = settings;
        this.dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'win-clipboard']);
        GLib.mkdir_with_parents(this.dir, 0o700);
        this._file = GLib.build_filenamev([this.dir, 'history.json']);
        this.items = [];
        this._load();
    }

    _load() {
        let state = {};
        try {
            const [, data] = GLib.file_get_contents(this._file);
            state = JSON.parse(new TextDecoder().decode(data));
        } catch {}
        this.items = Array.isArray(state.items) ? state.items : [];
        const bootId = readBootId();
        // Windows behaviour: unpinned history is wiped on restart (opt-in here).
        if (!this._settings.get_boolean('persist-history') && state.bootId !== bootId)
            this.items = this.items.filter(i => i.pinned);
        this._bootId = bootId;
        this.items = this.items.filter(i =>
            i.type === 'text' || GLib.file_test(this.imagePath(i), GLib.FileTest.EXISTS));
        this._collectGarbage();
        this._save();
    }

    _save() {
        try {
            GLib.file_set_contents(this._file,
                JSON.stringify({bootId: this._bootId, items: this.items}));
        } catch (e) {
            console.error(`win-clipboard: could not save history: ${e.message}`);
        }
    }

    imagePath(item) {
        return GLib.build_filenamev([this.dir, item.file]);
    }

    _newId() {
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }

    _promote(predicate, makeItem) {
        const idx = this.items.findIndex(predicate);
        const item = idx >= 0 ? this.items.splice(idx, 1)[0] : makeItem();
        this.items.unshift(item);
        this._trim();
        this._save();
    }

    addText(text) {
        this._promote(i => i.type === 'text' && i.text === text,
            () => ({id: this._newId(), type: 'text', text, pinned: false}));
    }

    addImage(bytes, mime) {
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        const file = `${hash}.${mime.split('/')[1] ?? 'png'}`;
        const path = GLib.build_filenamev([this.dir, file]);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            GLib.file_set_contents(path, bytes.get_data());
        this._promote(i => i.type === 'image' && i.file === file,
            () => ({id: this._newId(), type: 'image', file, mime, pinned: false}));
    }

    remove(id) {
        this.items = this.items.filter(i => i.id !== id);
        this._collectGarbage();
        this._save();
    }

    togglePin(id) {
        const item = this.items.find(i => i.id === id);
        if (item)
            item.pinned = !item.pinned;
        this._save();
    }

    clearUnpinned() {
        this.items = this.items.filter(i => i.pinned);
        this._collectGarbage();
        this._save();
    }

    // Puts a history item back on the system clipboard.
    copyToClipboard(item) {
        const clipboard = St.Clipboard.get_default();
        if (item.type === 'text') {
            clipboard.set_text(CB, item.text);
            return;
        }
        try {
            const [, data] = GLib.file_get_contents(this.imagePath(item));
            clipboard.set_content(CB, item.mime ?? 'image/png', new GLib.Bytes(data));
        } catch (e) {
            console.error(`win-clipboard: could not load image: ${e.message}`);
        }
    }

    _trim() {
        const max = this._settings.get_int('max-items');
        let unpinned = this.items.filter(i => !i.pinned).length;
        for (let i = this.items.length - 1; i >= 0 && unpinned > max; i--) {
            if (!this.items[i].pinned) {
                this.items.splice(i, 1);
                unpinned--;
            }
        }
        this._collectGarbage();
    }

    _collectGarbage() {
        const keep = new Set(this.items.filter(i => i.type === 'image').map(i => i.file));
        try {
            const dir = Gio.File.new_for_path(this.dir);
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const name = info.get_name();
                if (name !== 'history.json' && !keep.has(name))
                    dir.get_child(name).delete(null);
            }
            en.close(null);
        } catch {}
    }
}

export class ClipboardWatcher {
    constructor(history, onChange) {
        this._history = history;
        this._onChange = onChange;
        this._suppressUntil = 0;
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (_sel, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._read();
        });
    }

    // Ignore clipboard changes for a moment (used when typing emoji via the clipboard).
    suppress(ms) {
        this._suppressUntil = GLib.get_monotonic_time() + ms * 1000;
    }

    _read() {
        if (GLib.get_monotonic_time() < this._suppressUntil)
            return;
        const mimes = this._clipboard.get_mimetypes(CB) ?? [];
        if (mimes.length === 0)
            return;
        // Password managers (KeePassXC, Bitwarden, ...) mark secrets with this hint.
        if (mimes.includes('x-kde-passwordManagerHint'))
            return;

        const hasText = mimes.some(m => m.startsWith('text/plain') || TEXT_MIMES.includes(m));
        const image = IMAGE_MIMES.find(m => mimes.includes(m));

        if (hasText) {
            this._clipboard.get_text(CB, (_c, text) => {
                if (!this._history || !text || !text.trim() || text.length > MAX_TEXT_LENGTH)
                    return;
                this._history.addText(text);
                this._onChange();
            });
        } else if (image) {
            this._clipboard.get_content(CB, image, (_c, bytes) => {
                if (!this._history || !bytes || bytes.get_size() === 0 ||
                    bytes.get_size() > MAX_IMAGE_BYTES)
                    return;
                this._history.addImage(bytes, image);
                this._onChange();
            });
        }
    }

    destroy() {
        this._selection.disconnect(this._ownerId);
        this._history = null;
    }
}
