# pi-notify-agent

![pi-notify-agent preview](./assets/preview.png)

Cross-platform desktop notifications + sound alerts for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

When a pi run takes longer than a configurable threshold, this package notifies you when the agent:

- finishes successfully
- stops with an error / provider failure / connection-like failure

## Features

- **Windows:** native toast + system beep
- **macOS:** agent outcomes via `osascript`; break reminders use a separate signed `Pi Break Reminder` app
- **Linux:** `notify-send` + sound fallback (`canberra-gtk-play` / `paplay` when available)
- **Terminal fallback:** Kitty `OSC 99`, otherwise `OSC 777`, plus terminal bell when needed
- **Attention mode:** emits `BEL` so supporting terminals can flash taskbar, tab, dock, or urgency state
- **Noise reduction:** default threshold is **3000ms**
- **pi commands:** `/notify-test`, `/notify-test error`, `/notify-status`
- **CLI flags:** configure threshold and on/off behavior without editing code

### macOS notification styles

After the first break reminder, open **System Settings → Notifications → Pi Break Reminder** and select **Alerts**. Keep the AppleScript notification sender on **Banners** so agent completion notifications still disappear automatically.

## Install

### From a local folder

```bash
pi install ./pi-notify-agent
```

### From GitHub

```bash
pi install https://github.com/AlyusLabs/pi-notify-agent
```

### From npm

```bash
pi install npm:pi-notify-agent
```

After installing, reload pi:

```text
/reload
```

## Quick test

```text
/notify-test
/notify-test error
/notify-status
```

## Default behavior

By default the package:

- waits until the run lasts at least **3000ms**
- sends notifications for **success**
- sends notifications for **error**
- plays **sound** together with the notification
- emits **BEL attention** together with the notification
- ignores **aborted** runs

## CLI flags

The extension registers these pi flags:

- `--notify-min-ms <number>`
- `--notify-success <on|off>`
- `--notify-error <on|off>`
- `--notify-sound <on|off>`
- `--notify-attention <on|off>`

### Examples

```bash
# Only notify for long runs (5 seconds)
pi --notify-min-ms 5000

# Disable success notifications
pi --notify-success off

# Keep desktop notifications but disable sound
pi --notify-sound off

# Keep notifications but disable terminal attention bell
pi --notify-attention off

# Only notify on errors
pi --notify-success off --notify-error on
```

## Development

Run the extension directly without installing:

```bash
pi -e ./extensions/index.ts
```

Or load the package from its folder:

```bash
pi install .
```

## Package structure

```text
pi-notify-agent/
  extensions/
    index.ts
  package.json
  README.md
  LICENSE
```

## Publishing

### 1. Create a Git repo

```bash
git init
git add .
git commit -m "feat: initial pi notification package"
```

### 2. Push to GitHub

```bash
git remote add origin https://github.com/AlyusLabs/pi-notify-agent.git
git push -u origin main
```

Users can then install with:

```bash
pi install https://github.com/AlyusLabs/pi-notify-agent
```

### 3. Publish to npm

If the package name is already taken, rename the `name` field in `package.json` first.

```bash
npm login
npm publish --access public
```

Then users can install with:

```bash
pi install npm:pi-notify-agent
```

## Taskbar flash / dock bounce / attention

The new `notify-attention` mode uses the terminal bell (`BEL`, `\a`). That is the most cross-platform way to request attention from a terminal window.

Whether this becomes a flashing taskbar icon, a bouncing dock icon, a tab badge, or just a beep depends on the terminal emulator settings.

Common setups:

- **Windows Terminal:** configure `bellStyle` to include `window` and/or `taskbar`
- **kitty:** enable `window_alert_on_bell yes` (and on macOS optionally `macos_dock_badge_on_bell yes`)
- **xterm:** enable urgent-on-bell behavior (`bellIsUrgent`)
- **rxvt-unicode / urxvt:** enable `urgentOnBell`
- **iTerm2:** enable bell/dock-bounce style behavior in profile settings or triggers

This is more portable than trying to directly manipulate the OS taskbar/dock from the extension.

## Notes

- Linux desktop notifications require a GUI session and usually `notify-send`.
- Linux sound playback depends on what is installed on the machine.
- On headless / SSH-only environments the package falls back to terminal notifications / bell.
- Attention behavior is terminal-dependent; `BEL` is the portable trigger, but the visual effect depends on terminal config.
- If you want different sounds for success vs error, add that in `extensions/index.ts`.

## License

MIT
