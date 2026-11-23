// Win Clipboard — a Windows 11 style clipboard history (Super+V) and
// emoji panel (Super+.) for GNOME Shell.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {History, ClipboardWatcher} from './history.js';
import {Inserter} from './input.js';
import {EmojiData, EmojiPage} from './emoji.js';

const SHELL_KEYBINDINGS = 'org.gnome.shell.keybindings';
const TAKEOVER_KEY = 'toggle-message-tray'; // GNOME binds Super+V to the notification list
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 460;
const PREVIEW_LINES = 4;
const SUPER = Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK;

const TABS = [
    {id: 'emoji', icon: 'face-smile-symbolic', title: 'Emoji'},
    {id: 'clipboard', icon: 'edit-paste-symbolic', title: 'Clipboard history'},
];

class ClipboardPage {
    constructor(history, scale, onActivate) {
        this._history = history;
        this._scale = scale;
        this._onActivate = onActivate;
        this._selected = 0;
        this._cards = [];
        this._expandedId = null;

        this.actor = new St.BoxLayout({
            style_class: 'wcb-page',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        const header = new St.BoxLayout({style_class: 'wcb-header'});
        header.add_child(new St.Label({
            text: 'Clipboard history',
            style_class: 'wcb-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._clearButton = new St.Button({
            label: 'Clear all',
            style_class: 'wcb-clear',
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clearButton.connect('clicked', () => {
            this._history.clearUnpinned();
            this._selected = 0;
            this.rebuild();
        });
        header.add_child(this._clearButton);
        this.actor.add_child(header);

        // Search box. Typing anywhere on the page starts a search (except Space
        // and P, which keep their shortcuts while the box is empty); Ctrl+F or a
        // click focuses it, Esc clears it.
        const searchRow = new St.BoxLayout({style_class: 'wcb-search-row'});
        this.entry = new St.Entry({
            style_class: 'wcb-search',
            hint_text: 'Search clipboard',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'wcb-search-icon'}),
        });
        this.entry.clutter_text.connect('text-changed', () => {
            this._terms = this.entry.text.toLowerCase().split(/\s+/).filter(Boolean);
            this._selected = 0;
            this._expandedId = null;
            this.rebuild();
            this._scroll.vadjustment.value = 0;
        });
        this.entry.clutter_text.connect('key-press-event', (_a, event) =>
            this._handleSearchKey(event.get_key_symbol())
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);
        searchRow.add_child(this.entry);
        this.actor.add_child(searchRow);
        this._terms = [];
        this._lowerCache = new WeakMap();

        this._list = new St.BoxLayout({
            style_class: 'wcb-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'wcb-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._list,
        });
        this.actor.add_child(this._scroll);
    }

    reset() {
        this.entry.text = '';
        this._selected = 0;
        this._expandedId = null;
        this.rebuild();
        this._scroll.vadjustment.value = 0;
    }

    get searching() {
        return this._terms.length > 0;
    }

    get searchFocused() {
        return global.stage.key_focus === this.entry.clutter_text;
    }

    focusSearch(initialText = null) {
        this.entry.grab_key_focus();
        if (initialText !== null)
            this.entry.text = this.entry.text + initialText;
        this.entry.clutter_text.set_cursor_position(-1);
        this.entry.clutter_text.set_selection_bound(-1);
    }

    // Esc: clears the search first. Returns true if there was one to clear.
    clearSearch() {
        if (!this.entry.text)
            return false;
        this.entry.text = '';
        return true;
    }

    _lower(item) {
        let lower = this._lowerCache.get(item);
        if (lower === undefined) {
            lower = item.text.toLowerCase();
            this._lowerCache.set(item, lower);
        }
        return lower;
    }

    _matches(item) {
        if (item.type !== 'text')
            return false;
        const lower = this._lower(item);
        return this._terms.every(t => lower.includes(t));
    }

    rebuild() {
        const all = this._history.items;
        const items = this.searching ? all.filter(i => this._matches(i)) : all;
        this._list.destroy_all_children();
        this._cards = [];
        this._clearButton.reactive = all.some(i => !i.pinned);
        this._clearButton.opacity = this._clearButton.reactive ? 255 : 110;

        if (items.length === 0) {
            const empty = new St.Label({
                text: this.searching
                    ? `Nothing in your clipboard history matches “${this.entry.text.trim()}”.`
                    : 'You\'ll see your clipboard history here once you\'ve copied something.',
                style_class: 'wcb-empty',
                x_expand: true,
            });
            empty.clutter_text.line_wrap = true;
            this._list.add_child(empty);
        }

        items.forEach((item, index) => {
            const card = this._makeCard(item, index);
            this._cards.push(card);
            this._list.add_child(card);
        });

        this._selected = Math.max(0, Math.min(this._selected, this._cards.length - 1));
        this._updateSelection(false);
    }

    _makeCard(item, index) {
        const card = new St.BoxLayout({
            style_class: 'wcb-card',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        card.connect('notify::hover', () => {
            if (card.hover) {
                this._selected = index;
                this._updateSelection(false);
            }
        });

        const content = new St.Button({
            style_class: 'wcb-content',
            can_focus: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        content.connect('clicked', () => this._onActivate(item));

        if (item.type === 'text') {
            const label = new St.Label({
                text: this._previewText(item.text),
                style_class: 'wcb-text',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            content.set_child(label);
        } else {
            content.set_child(this._makeImage(item));
        }
        card.add_child(content);

        const actions = new St.BoxLayout({
            style_class: 'wcb-actions',
            y_align: Clutter.ActorAlign.START,
        });
        const expanded = this._expandedId === item.id;
        if (expanded) {
            actions.add_child(this._actionButton(
                'view-pin-symbolic',
                item.pinned ? 'Unpin' : 'Pin',
                () => {
                    this._history.togglePin(item.id);
                    this._expandedId = null;
                    this.rebuild();
                }, item.pinned));
            actions.add_child(this._actionButton('user-trash-symbolic', 'Delete', () => {
                this._history.remove(item.id);
                this._expandedId = null;
                this.rebuild();
            }));
        } else if (item.pinned) {
            actions.add_child(new St.Icon({
                icon_name: 'view-pin-symbolic',
                style_class: 'wcb-pinned-indicator',
            }));
        }
        const more = this._actionButton('view-more-horizontal-symbolic', 'See more', () => {
            this._expandedId = expanded ? null : item.id;
            this.rebuild();
        });
        more.add_style_class_name('wcb-more');
        if (expanded)
            more.add_style_pseudo_class('checked');
        actions.add_child(more);
        card.add_child(actions);

        card._wcbMore = more;
        card._wcbItem = item;
        return card;
    }

    _actionButton(iconName, tooltip, callback, active = false) {
        const button = new St.Button({
            style_class: 'wcb-action',
            can_focus: false,
            accessible_name: tooltip,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        if (active)
            button.add_style_pseudo_class('active');
        button.connect('clicked', callback);
        return button;
    }

    _makeImage(item) {
        const path = this._history.imagePath(item);
        const maxW = (PANEL_WIDTH - 90) * this._scale;
        const maxH = 120 * this._scale;
        let w = maxW, h = maxH;
        try {
            const [, iw, ih] = GdkPixbuf.Pixbuf.get_file_info(path);
            if (iw > 0 && ih > 0) {
                const ratio = Math.min(maxW / iw, maxH / ih, this._scale);
                w = Math.max(1, Math.round(iw * ratio));
                h = Math.max(1, Math.round(ih * ratio));
            }
        } catch {}
        const uri = Gio.File.new_for_path(path).get_uri();
        return new St.Widget({
            style_class: 'wcb-image',
            width: w,
            height: h,
            x_align: Clutter.ActorAlign.START,
            style: `background-image: url("${uri}"); background-size: contain;`,
        });
    }

    _previewText(text) {
        let lines = text.replace(/\t/g, '    ').replace(/\r\n?/g, '\n').trim().split('\n');
        let prefix = '';
        let matchLine = -1, matchCol = 0;
        // When searching, start the preview at the first match so it's visible.
        if (this.searching) {
            const term = this._terms[0];
            matchLine = lines.findIndex(l => l.toLowerCase().includes(term));
            if (matchLine >= PREVIEW_LINES) {
                lines = lines.slice(matchLine);
                prefix = '…\n';
                matchLine = 0;
            }
            if (matchLine >= 0)
                matchCol = lines[matchLine].toLowerCase().indexOf(term);
        }
        let preview = lines.slice(0, PREVIEW_LINES)
            .map((l, i) => {
                if (l.length <= 220)
                    return l;
                const start = i === matchLine && matchCol > 180 ? matchCol - 60 : 0;
                return `${start > 0 ? '…' : ''}${l.slice(start, start + 220)}…`;
            })
            .join('\n');
        if (lines.length > PREVIEW_LINES)
            preview += '\n…';
        return prefix + preview;
    }

    _move(delta, wrap = true) {
        const count = this._cards.length;
        if (!count)
            return;
        let next = this._selected + delta;
        next = wrap ? (next + count) % count : Math.max(0, Math.min(next, count - 1));
        this._selected = next;
        this._updateSelection();
    }

    // Keys typed while the search box has focus; returns true if handled.
    _handleSearchKey(key) {
        const item = this._cards[this._selected]?._wcbItem;
        switch (key) {
        case Clutter.KEY_Down:
        case Clutter.KEY_Tab:
            this._move(1);
            return true;
        case Clutter.KEY_Up:
        case Clutter.KEY_ISO_Left_Tab:
            this._move(-1);
            return true;
        case Clutter.KEY_Page_Down:
            this._move(5, false);
            return true;
        case Clutter.KEY_Page_Up:
            this._move(-5, false);
            return true;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (item)
                this._onActivate(item);
            return true;
        }
        return false;
    }

    // Key presses reaching the panel (search box not focused).
    handleKeyEvent(event) {
        if (this.searchFocused)
            return false;
        const key = event.get_key_symbol();
        const state = event.get_state();
        const modifiers = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK | SUPER;

        if ((state & Clutter.ModifierType.CONTROL_MASK) && (key === Clutter.KEY_f || key === Clutter.KEY_F)) {
            this.focusSearch();
            return true;
        }
        if (!(state & modifiers) && this.handleKey(key))
            return true;

        // Any other printable character starts a search.
        let ch = event.get_key_unicode();
        if (typeof ch === 'number')
            ch = ch ? String.fromCodePoint(ch) : '';
        if (!(state & modifiers) && ch && !/[\x00-\x1f\x7f]/.test(ch)) {
            this.focusSearch(ch);
            return true;
        }
        return false;
    }

    _updateSelection(scroll = true) {
        this._cards.forEach((card, i) => {
            const selected = i === this._selected;
            if (selected)
                card.add_style_pseudo_class('selected');
            else
                card.remove_style_pseudo_class('selected');
            // Like Windows, the "…" button only shows on the hovered/selected card.
            card._wcbMore.opacity =
                selected || card._wcbItem.id === this._expandedId ? 255 : 0;
        });
        const card = this._cards[this._selected];
        if (scroll && card)
            ensureActorVisibleInScrollView(this._scroll, card);
    }

    // Returns true if the key was handled.
    handleKey(key) {
        const count = this._cards.length;
        const item = this._cards[this._selected]?._wcbItem;

        switch (key) {
        case Clutter.KEY_Down:
        case Clutter.KEY_Tab:
            if (count) {
                this._selected = (this._selected + 1) % count;
                this._updateSelection();
            }
            return true;
        case Clutter.KEY_Up:
        case Clutter.KEY_ISO_Left_Tab:
            if (count) {
                this._selected = (this._selected - 1 + count) % count;
                this._updateSelection();
            }
            return true;
        case Clutter.KEY_Home:
            this._selected = 0;
            this._updateSelection();
            return true;
        case Clutter.KEY_End:
            this._selected = Math.max(0, count - 1);
            this._updateSelection();
            return true;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_space:
            if (item)
                this._onActivate(item);
            return true;
        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
            if (item) {
                this._history.remove(item.id);
                this.rebuild();
                this._updateSelection();
            }
            return true;
        case Clutter.KEY_Right:
        case Clutter.KEY_Menu:
            if (item) {
                this._expandedId = item.id;
                this.rebuild();
            }
            return true;
        case Clutter.KEY_Left:
            if (this._expandedId) {
                this._expandedId = null;
                this.rebuild();
            }
            return true;
        case Clutter.KEY_p:
        case Clutter.KEY_P:
            if (item) {
                this._history.togglePin(item.id);
                this.rebuild();
            }
            return true;
        }
        return false;
    }

    // Escape first collapses an open "…" menu.
    collapse() {
        if (!this._expandedId)
            return false;
        this._expandedId = null;
        this.rebuild();
        return true;
    }
}

class Popup {
    constructor({history, settings, emojiData, inserter}) {
        this._history = history;
        this._settings = settings;
        this._emojiData = emojiData;
        this._inserter = inserter;
        this._backdrop = null;
        this._tab = null;
    }

    get isOpen() {
        return this._backdrop !== null;
    }

    // Opens on `tab`; switches tab if open on another one; closes if already on it.
    toggle(tab) {
        if (!this.isOpen)
            this.open(tab);
        else if (this._tab !== tab)
            this._showTab(tab);
        else
            this.close();
    }

    open(tab) {
        this._prevWindow = global.display.focus_window;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._scale = scale;

        this._backdrop = new St.Widget({
            reactive: true,
            x: 0, y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        this._backdrop.connect('button-press-event', (_a, event) => {
            if (!this._isInsidePanel(event))
                this.close();
            return Clutter.EVENT_PROPAGATE;
        });

        const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const dark = interfaceSettings.get_string('color-scheme') === 'prefer-dark';

        this._panel = new St.BoxLayout({
            style_class: `wcb-panel ${dark ? 'wcb-dark' : 'wcb-light'}`,
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            can_focus: true,
            width: PANEL_WIDTH * scale,
            height: PANEL_HEIGHT * scale,
        });
        this._panel.connect('captured-event', this._onCapturedEvent.bind(this));
        this._panel.connect('key-press-event', (_a, event) =>
            this._tab === 'clipboard' && this._clipboardPage.handleKeyEvent(event)
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);
        this._backdrop.add_child(this._panel);

        // Tab bar
        const tabBar = new St.BoxLayout({style_class: 'wcb-tabs'});
        this._tabButtons = new Map();
        for (const t of TABS) {
            const b = new St.Button({
                style_class: 'wcb-tab',
                can_focus: false,
                accessible_name: t.title,
                child: new St.Icon({icon_name: t.icon, icon_size: 16}),
            });
            b.connect('clicked', () => this._showTab(t.id));
            this._tabButtons.set(t.id, b);
            tabBar.add_child(b);
        }
        this._panel.add_child(tabBar);

        this._clipboardPage = new ClipboardPage(this._history, scale, item => this._activateItem(item));
        this._emojiPage = new EmojiPage(this._emojiData, this._settings, text => this._pickEmoji(text));
        this._emojiPage.entry.clutter_text.connect('key-press-event', (_a, event) =>
            this._emojiPage.handleKey(event.get_key_symbol())
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);
        this._panel.add_child(this._clipboardPage.actor);
        this._panel.add_child(this._emojiPage.actor);

        Main.layoutManager.uiGroup.add_child(this._backdrop);
        this._clipboardPage.reset();
        this._emojiPage.reset();
        this._position();

        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        this._showTab(tab);

        this._panel.opacity = 0;
        this._panel.translation_y = 8 * scale;
        this._panel.ease({
            opacity: 255,
            translation_y: 0,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close() {
        if (!this._backdrop)
            return;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._backdrop.destroy();
        this._backdrop = null;
        this._panel = null;
        this._clipboardPage = null;
        this._emojiPage = null;
        this._tabButtons = null;
        this._tab = null;
    }

    refresh() {
        if (this.isOpen)
            this._clipboardPage.rebuild();
    }

    _showTab(tab) {
        this._tab = tab;
        for (const [id, b] of this._tabButtons) {
            if (id === tab)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
        this._clipboardPage.actor.visible = tab === 'clipboard';
        this._emojiPage.actor.visible = tab === 'emoji';
        if (tab === 'emoji')
            this._emojiPage.focus();
        else if (this._clipboardPage.searching)
            this._clipboardPage.focusSearch();
        else
            this._panel.grab_key_focus();
    }

    _isInsidePanel(event) {
        const [x, y] = event.get_coords();
        const [px, py] = this._panel.get_transformed_position();
        const [pw, ph] = this._panel.get_transformed_size();
        return x >= px && x <= px + pw && y >= py && y <= py + ph;
    }

    _position() {
        const width = PANEL_WIDTH * this._scale;
        const height = PANEL_HEIGHT * this._scale;
        const [px, py] = global.get_pointer();
        const monitor = global.display.get_current_monitor();
        const wa = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const gap = 12 * this._scale;

        let x = px - width / 2;
        let y = py + gap;
        if (y + height > wa.y + wa.height)
            y = py - height - gap;
        x = Math.max(wa.x + gap, Math.min(x, wa.x + wa.width - width - gap));
        y = Math.max(wa.y + gap, Math.min(y, wa.y + wa.height - height - gap));
        this._panel.set_position(Math.round(x), Math.round(y));
    }

    // Keys that work on every tab, handled before the focused widget sees them.
    _onCapturedEvent(_actor, event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        const key = event.get_key_symbol();
        const state = event.get_state();

        if (state & SUPER) {
            if (key === Clutter.KEY_v || key === Clutter.KEY_V) {
                this.toggle('clipboard');
                return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_period || key === Clutter.KEY_semicolon) {
                this.toggle('emoji');
                return Clutter.EVENT_STOP;
            }
        }
        if ((state & Clutter.ModifierType.CONTROL_MASK) &&
            (key === Clutter.KEY_Tab || key === Clutter.KEY_ISO_Left_Tab ||
             key === Clutter.KEY_Page_Down || key === Clutter.KEY_Page_Up)) {
            this._showTab(this._tab === 'emoji' ? 'clipboard' : 'emoji');
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Escape) {
            if (this._tab === 'clipboard' && this._clipboardPage.collapse())
                return Clutter.EVENT_STOP;
            if (this._tab === 'clipboard' &&
                (this._clipboardPage.clearSearch() || this._clipboardPage.searchFocused)) {
                // Back to the list so the single-key shortcuts work again.
                this._panel.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            if (this._tab === 'emoji' && this._emojiPage.entry.text) {
                this._emojiPage.entry.text = '';
                return Clutter.EVENT_STOP;
            }
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _activateItem(item) {
        this._history.copyToClipboard(item);
        const target = this._prevWindow;
        this.close();
        if (this._settings.get_boolean('paste-on-select') && target)
            this._inserter.paste(target);
    }

    _pickEmoji(text) {
        const target = this._prevWindow;
        this.close();
        if (target)
            this._inserter.insertText(text, target);
        else
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    destroy() {
        this.close();
    }
}

export default class WinClipboardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._history = new History(this._settings);
        this._watcher = new ClipboardWatcher(this._history, () => this._popup?.refresh());
        this._inserter = new Inserter(this._history, this._watcher);
        this._popup = new Popup({
            history: this._history,
            settings: this._settings,
            emojiData: new EmojiData(this.dir),
            inserter: this._inserter,
        });

        this._takeOverShellBinding();
        const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        Main.wm.addKeybinding('toggle-clipboard', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes,
            () => this._popup.toggle('clipboard'));
        Main.wm.addKeybinding('toggle-emoji', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes,
            () => this._popup.toggle('emoji'));
    }

    disable() {
        Main.wm.removeKeybinding('toggle-clipboard');
        Main.wm.removeKeybinding('toggle-emoji');
        this._restoreShellBinding();
        this._popup?.destroy();
        this._inserter?.destroy();
        this._watcher?.destroy();
        this._popup = null;
        this._inserter = null;
        this._watcher = null;
        this._history = null;
        this._settings = null;
    }

    // GNOME ships Super+V for the notification list; free it while we're enabled.
    _takeOverShellBinding() {
        const shell = new Gio.Settings({schema_id: SHELL_KEYBINDINGS});
        const ours = this._settings.get_strv('toggle-clipboard').map(s => s.toLowerCase());
        const current = shell.get_strv(TAKEOVER_KEY);
        const taken = current.filter(b => ours.includes(b.toLowerCase()));
        if (taken.length === 0)
            return;
        shell.set_strv(TAKEOVER_KEY, current.filter(b => !taken.includes(b)));
        const saved = new Set([...this._settings.get_strv('removed-shell-bindings'), ...taken]);
        this._settings.set_strv('removed-shell-bindings', [...saved]);
    }

    _restoreShellBinding() {
        const removed = this._settings.get_strv('removed-shell-bindings');
        if (removed.length === 0)
            return;
        const shell = new Gio.Settings({schema_id: SHELL_KEYBINDINGS});
        const current = shell.get_strv(TAKEOVER_KEY);
        shell.set_strv(TAKEOVER_KEY, [...removed.filter(b => !current.includes(b)), ...current]);
        this._settings.set_strv('removed-shell-bindings', []);
    }
}
