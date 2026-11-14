# Win Clipboard

Windows 11 style clipboard history (Win+V) and emoji panel (Win+.) for GNOME Shell 48–50 (Ubuntu 25.04+).

- **Super+V** opens the panel near the mouse pointer. Press it again or Esc to close.
- Stores text and images (25 unpinned items by default, as on Windows). Pinned items survive "Clear all".
- Click or press Enter to paste into the app you were using (Ctrl+V, or Ctrl+Shift+V in terminals).
- Keys: ↑/↓/Tab to move, Enter/Space to paste, Delete to remove, P to pin/unpin, → to show the item's actions, Esc to close.
- Skips anything a password manager marks as secret.
- Follows the system light/dark setting.

**Emoji (Super+. or Super+;)** opens the same panel on the emoji tab:
- Type to search, arrows to move, Enter or click to insert into the app you were using.
- Recently used emoji, ten categories along the bottom, skin tone picker (✋ button).
- Inserts through the input method when the app supports it, otherwise via a temporary paste
  (your clipboard is restored afterwards and the emoji isn't added to history).
- Ctrl+Tab switches between the Emoji and Clipboard tabs; Super+V / Super+. switch to that tab.

GNOME uses Super+V for the notification list by default. While this extension is enabled it removes that
shortcut (Super+M still opens notifications) and puts it back when the extension is disabled.

## Install
    git clone https://github.com/Sadashii/win-clipboard.git
    cd win-clipboard
    ./install.sh        # then log out and back in (Wayland can't reload the shell in place)

## Settings
    S="gsettings --schemadir ~/.local/share/gnome-shell/extensions/win-clipboard@local/schemas"
    $S set org.gnome.shell.extensions.win-clipboard max-items 50
    $S set org.gnome.shell.extensions.win-clipboard paste-on-select false
    $S set org.gnome.shell.extensions.win-clipboard persist-history false   # Windows behaviour: unpinned items cleared on reboot
    $S set org.gnome.shell.extensions.win-clipboard toggle-clipboard "['<Super>v']"
    $S set org.gnome.shell.extensions.win-clipboard toggle-emoji "['<Super>period']"

History is stored in `~/.local/share/win-clipboard/`.

Emoji data comes from GTK 4's emoji list (`data/emoji.json`).

## Debug
    journalctl -f -o cat /usr/bin/gnome-shell | grep -i win-clipboard

## License
GPL-2.0-or-later (the license GNOME Shell extensions use).
