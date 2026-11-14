// Emoji tab: search, recently used, categories and skin tones.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

const COLUMNS = 8;
const MAX_RECENT = 32;
const MAX_RESULTS = 160;
const SKIN_TONES = [0, 0x1F3FB, 0x1F3FC, 0x1F3FD, 0x1F3FE, 0x1F3FF];

// `group` values come from Unicode's emoji groups (group 2, skin-tone components, is dropped).
const CATEGORIES = [
    {id: 'recent', icon: 'emoji-recent-symbolic', title: 'Most recently used'},
    {id: 0, icon: 'emoji-people-symbolic', title: 'Smileys & emotion'},
    {id: 1, icon: 'emoji-body-symbolic', title: 'People'},
    {id: 3, icon: 'emoji-nature-symbolic', title: 'Animals & nature'},
    {id: 4, icon: 'emoji-food-symbolic', title: 'Food & drink'},
    {id: 5, icon: 'emoji-travel-symbolic', title: 'Travel & places'},
    {id: 6, icon: 'emoji-activities-symbolic', title: 'Activities'},
    {id: 7, icon: 'emoji-objects-symbolic', title: 'Objects'},
    {id: 8, icon: 'emoji-symbols-symbolic', title: 'Symbols'},
    {id: 9, icon: 'emoji-flags-symbolic', title: 'Flags'},
];

// Builds the emoji string, applying a skin tone where the emoji supports one.
// In the data, 0x1F3FB marks a skin-tone slot and 0 marks a slot that needs
// either the tone or a variation selector (same convention as GTK's emoji chooser).
function render(codes, tone) {
    let s = '';
    for (let code of codes) {
        if (code === 0)
            code = tone || 0xFE0F;
        else if (code === 0x1F3FB)
            code = tone;
        if (code)
            s += String.fromCodePoint(code);
    }
    return s;
}

export class EmojiData {
    constructor(extensionDir) {
        this._file = extensionDir.get_child('data').get_child('emoji.json');
        this._entries = null;
    }

    get entries() {
        if (!this._entries) {
            const [, bytes] = this._file.load_contents(null);
            this._entries = JSON.parse(new TextDecoder().decode(bytes)).map(
                ([codes, name, keywords, group]) => ({
                    codes, name, group,
                    toneable: codes.includes(0x1F3FB) || codes.includes(0),
                    nameLower: name.toLowerCase(),
                    hay: `${name} ${keywords}`.toLowerCase(),
                }));
        }
        return this._entries;
    }

    search(query) {
        const q = query.trim().toLowerCase();
        const tokens = q.split(/\s+/);
        const results = [];
        for (const e of this.entries) {
            if (!tokens.every(t => e.hay.includes(t)))
                continue;
            const words = e.nameLower.split(/[\s:]+/);
            let score = 5;
            if (e.nameLower === q)
                score = 0;
            else if (words.length <= 2 && words.includes(tokens[0]))
                score = 1;     // "heart" -> "red heart" before "heart with arrow"
            else if (words.includes(tokens[0]))
                score = 2;
            else if (e.nameLower.startsWith(q))
                score = 3;
            else if (words.some(w => w.startsWith(tokens[0])))
                score = 4;
            results.push([score, e]);
        }
        results.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length);
        return results.slice(0, MAX_RESULTS).map(r => r[1]);
    }
}

export class EmojiPage {
    constructor(data, settings, onPick) {
        this._data = data;
        this._settings = settings;
        this._onPick = onPick;
        this._cells = [];
        this._selected = 0;
        this._category = null;

        this.actor = new St.BoxLayout({
            style_class: 'wcb-page wcb-emoji-page',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        // Search box + skin tone button
        const searchRow = new St.BoxLayout({style_class: 'wcb-search-row'});
        this.entry = new St.Entry({
            style_class: 'wcb-search',
            hint_text: 'Search emoji',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'wcb-search-icon'}),
        });
        this.entry.clutter_text.connect('text-changed', () => this._refresh());
        searchRow.add_child(this.entry);

        this._toneButton = new St.Button({
            style_class: 'wcb-tone-button',
            can_focus: false,
            accessible_name: 'Skin tone',
            label: this._toneSample(this._tone()),
        });
        this._toneButton.connect('clicked', () => {
            this._toneRow.visible = !this._toneRow.visible;
        });
        searchRow.add_child(this._toneButton);
        this.actor.add_child(searchRow);

        this._toneRow = new St.BoxLayout({style_class: 'wcb-tone-row', visible: false});
        SKIN_TONES.forEach((tone, i) => {
            const b = new St.Button({
                style_class: 'wcb-emoji',
                can_focus: false,
                label: this._toneSample(tone),
            });
            b.connect('clicked', () => {
                this._settings.set_int('emoji-skin-tone', i);
                this._toneButton.label = this._toneSample(tone);
                this._toneRow.hide();
                this._refresh();
            });
            this._toneRow.add_child(b);
        });
        this.actor.add_child(this._toneRow);

        this._title = new St.Label({style_class: 'wcb-section-title'});
        this.actor.add_child(this._title);

        this._grid = new St.BoxLayout({
            style_class: 'wcb-grid',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._grid,
        });
        this.actor.add_child(this._scroll);

        this._categoryBar = new St.BoxLayout({style_class: 'wcb-category-bar', x_expand: true});
        this._categoryButtons = new Map();
        for (const cat of CATEGORIES) {
            const b = new St.Button({
                style_class: 'wcb-category',
                can_focus: false,
                x_expand: true,
                accessible_name: cat.title,
                child: new St.Icon({icon_name: cat.icon, icon_size: 16}),
            });
            b.connect('clicked', () => {
                this._category = cat.id;
                this.entry.text = '';
                this._showCategory(cat.id);
            });
            this._categoryButtons.set(cat.id, b);
            this._categoryBar.add_child(b);
        }
        this.actor.add_child(this._categoryBar);
    }

    _tone() {
        return SKIN_TONES[this._settings.get_int('emoji-skin-tone')] ?? 0;
    }

    _toneSample(tone) {
        return render([0x270B, 0x1F3FB], tone); // raised hand
    }

    reset() {
        this.entry.text = '';
        this._toneRow.hide();
        const hasRecent = this._settings.get_strv('recent-emoji').length > 0;
        this._showCategory(hasRecent ? 'recent' : 0);
    }

    focus() {
        this.entry.grab_key_focus();
    }

    _refresh() {
        const query = this.entry.text.trim();
        if (query) {
            const tone = this._tone();
            const results = this._data.search(query).map(e =>
                ({text: render(e.codes, e.toneable ? tone : 0), name: e.name}));
            this._setActiveCategory(null);
            this._fill(results.length ? 'Search results' : 'No emoji found', results);
        } else {
            this._showCategory(this._category ?? 0);
        }
    }

    _showCategory(id) {
        this._category = id;
        this._setActiveCategory(id);
        const cat = CATEGORIES.find(c => c.id === id);
        let items;
        if (id === 'recent') {
            items = this._settings.get_strv('recent-emoji').map(text => ({text, name: text}));
        } else {
            const tone = this._tone();
            items = this._data.entries.filter(e => e.group === id)
                .map(e => ({text: render(e.codes, e.toneable ? tone : 0), name: e.name}));
        }
        this._fill(cat.title, items);
        this._scroll.vadjustment.value = 0;
    }

    _setActiveCategory(id) {
        for (const [catId, b] of this._categoryButtons) {
            if (catId === id)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
    }

    _fill(title, items) {
        this._title.text = title;
        this._grid.destroy_all_children();
        this._cells = [];
        let row = null;
        items.forEach((item, i) => {
            if (i % COLUMNS === 0) {
                row = new St.BoxLayout({style_class: 'wcb-grid-row'});
                this._grid.add_child(row);
            }
            const cell = new St.Button({
                style_class: 'wcb-emoji',
                can_focus: false,
                label: item.text,
                accessible_name: item.name,
                track_hover: true,
            });
            cell.connect('clicked', () => this._pick(item.text));
            cell.connect('notify::hover', () => {
                if (cell.hover)
                    this._select(i, false);
            });
            row.add_child(cell);
            this._cells.push(cell);
        });
        this._selected = 0;
        this._select(0, false);
    }

    _select(index, scroll = true) {
        this._cells[this._selected]?.remove_style_pseudo_class('selected');
        this._selected = Math.max(0, Math.min(index, this._cells.length - 1));
        const cell = this._cells[this._selected];
        if (!cell)
            return;
        cell.add_style_pseudo_class('selected');
        if (scroll)
            ensureActorVisibleInScrollView(this._scroll, cell);
    }

    _pick(text) {
        const recent = [text, ...this._settings.get_strv('recent-emoji').filter(e => e !== text)];
        this._settings.set_strv('recent-emoji', recent.slice(0, MAX_RECENT));
        this._onPick(text);
    }

    // Keys typed while the search box has focus; returns true if handled.
    handleKey(key) {
        const count = this._cells.length;
        switch (key) {
        case Clutter.KEY_Left:
            this._select(this._selected - 1);
            return true;
        case Clutter.KEY_Right:
            this._select(this._selected + 1);
            return true;
        case Clutter.KEY_Up:
            if (this._selected >= COLUMNS)
                this._select(this._selected - COLUMNS);
            return true;
        case Clutter.KEY_Down:
            if (this._selected + COLUMNS < count)
                this._select(this._selected + COLUMNS);
            else if (Math.floor(this._selected / COLUMNS) < Math.floor((count - 1) / COLUMNS))
                this._select(count - 1);
            return true;
        case Clutter.KEY_Page_Up:
            this._select(this._selected - COLUMNS * 5);
            return true;
        case Clutter.KEY_Page_Down:
            this._select(this._selected + COLUMNS * 5);
            return true;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter: {
            const cell = this._cells[this._selected];
            if (cell)
                this._pick(cell.label);
            return true;
        }
        }
        return false;
    }

    destroy() {
        this.actor.destroy();
    }
}

