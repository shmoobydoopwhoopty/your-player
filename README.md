# Your Player

A local-first desktop music player for Windows with album artwork front and center — plus a built-in YouTube downloader and video library. Fully offline for your own music; only the Downloader tab talks to YouTube.

> The app is rebrandable: the default name is "Your", and you can rename it from settings or first-run onboarding

## Highlights

- **Your library, your files** — point it at your music folders and it builds a persistent library with embedded tags and album art. Supports MP3, M4A/AAC, WAV, FLAC, OGG, Opus, and WebM.
- **Album artwork everywhere** — blurred backdrops, a full-screen Now Playing view, and auto-upscaling for big displays. Missing art gets a generated placeholder.
- **Built-in downloader** — search YouTube or paste a link, then grab songs as MP3 (straight into your library) or videos (into the Media tab), with a live progress queue.
- **8-band equalizer** — presets included, custom presets savable, settings persist.
- **Deep customization** — themes, accent colors, per-area color overrides, and a drag-and-drop layout editor (sidebar side, player dock, queue position).

## Features

### Library
- Import by file picker, folder scan (recursive, cancellable, with progress), or drag-and-drop
- Multiple tracked folders with add/remove management and a manual "Rescan folders" button; auto-checks folders for new music on launch
- Library, favorites, play counts, queue, volume, shuffle/repeat, and view state persist across restarts; missing files are reported, and a moved folder can be auto-relinked
- Views: Home, All Songs, Albums, Artists, Favorites, Most Listened, Playlists
- Sorting (recently added / title / artist), filter chips, and "Show more" pagination for large libraries
- Live search with a ranked suggestion dropdown and keyboard navigation
- Custom playlists plus a built-in "Liked songs" collection
- Back/forward navigation history

### Playback
- Play/pause, next/previous, shuffle, and repeat (off / all / one)
- Draggable seek bar, elapsed/total time, volume slider with mute
- **Up Next** queue: drag-to-reorder while audio keeps playing, auto-continuation in shuffle or library order, clear-queue option
- Full-screen Now Playing overlay with blurred artwork backdrop
- 8-band equalizer (60 Hz–16 kHz, ±12 dB) with 13 built-in presets and saveable custom presets
- Keyboard shortcuts (when not typing in a field):

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek back / forward 5 s |
| `↑` / `↓` | Volume up / down |
| `Esc` | Close overlays (now playing, drawers, popups) |

### Downloader (yt-dlp powered)
- Search YouTube (up to 25 results) or paste any video / Shorts / playlist URL
- Autocomplete suggestions as you type
- Embedded preview player before you commit
- **MP3** downloads (best audio, embedded thumbnail + metadata) are auto-imported into your library
- **Video** downloads (H.264, ≤1080p MP4) land in the **Media** tab
- Download queue with live progress (percent, speed, ETA), per-item and cancel-all, up to 3 concurrent downloads

### Media tab
- Your downloaded videos in a grid; play them inside the app or delete them from disk

### Appearance & layout
- 6 themes: Charcoal, OLED, Slate, Forest, Mocha, Dusk — plus 8 accent colors
- Per-area custom color pickers (accent, background, sidebar, panels, text, player bar, buttons, shadow) with text-shadow toggle
- Layout presets (Classic, Compact, Leftie, Cinema, Heads Up), sidebar/player size sliders, and a "Customize layout" edit mode with drag-and-drop snap zones
- Frameless window with custom window controls; rename the app and it propagates everywhere

## Getting started

### Prerequisites
- [Node.js](https://nodejs.org) 18+
- **For the Downloader tab only:** [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org)
  - Install e.g. `winget install yt-dlp` and `winget install Gyan.FFmpeg`, or set the `TREE_PLAYER_TOOLS_DIR` environment variable to a folder containing `yt-dlp.exe` and `ffmpeg.exe`
  - Everything else (library, playback, equalizer) works without them

### Run in development
```bash
npm install
npm start
```

### Build an installer / portable exe
```bash
npm run dist              # NSIS installer + portable exe  → release/
npm run dist:installer    # installer onlynpm run dist:portable    # portable exe only
```

### Releases & self-updating

The app ships with a built-in updater pointed at this project's GitHub releases:

- Installed apps check `releases/latest/download/manifest.json` shortly after launch and every 30 minutes.
- When a newer version is published, a red dot appears on the settings button, and Settings → Update can download, verify (SHA-256), and install it — the app relaunches to finish.
- The update source can be overridden per-user in Settings → Update source, or via the `TREE_PLAYER_UPDATE_URL` environment variable.
- Updates replace only `index.html`, `package.json`, and `electron/*.cjs`; the previous versions are backed up to `userData/updates/backups/`.

To ship an update:

```bash
# 1. Make your changes, bump "version" in package.json
npm run dist:installer                                  # 2. build the new installer
node scripts/publish-update.js --github <owner>/<repo> --notes "What changed"
# 3. Attach everything in release/update-channel/ (manifest.json included)
#    plus the new installer to a GitHub release, e.g.:
gh release create v1.0.5 release/update-channel/* "installer/Your Player Setup 1.0.5.exe" \
  --title "Your Player 1.0.5" --notes "What changed"
```

The NSIS installer creates a standard Windows uninstaller (Settings → Apps → "Your Player").

### First run
A short onboarding tour helps you name the app, pick a downloads folder, and add your music folders. You can skip it and change everything later in settings (gear icon).

## Updates (self-updating app)

The app can update itself — no reinstall needed:

1. **Publish an update channel:** after bumping the version in `package.json`, run:
   ```bash
   npm run publish:update        # writes release/update-channel/ (app files + manifest.json)
   ```
2. **Host the folder** on any static HTTP(S) server (the manifest and files just sit side by side).
3. **Point installs at it:** Settings → Update source → `<url>/manifest.json`. For zero-config installs, bake the URL into `DEFAULT_UPDATE_URL` in `electron/updater.cjs` (or set the `TREE_PLAYER_UPDATE_URL` environment variable).

Installed apps check the channel at launch and every 30 minutes. When a newer version is published, a **red dot** appears on the settings button and Settings → Update offers **Download & install update** — files are SHA-256-verified, staged in userData, swapped into the install folder with backups, and the app relaunches. Old versions are kept under `userData/updates/backups/`.

Notes: self-updates apply to installed (NSIS) builds — the portable exe will tell you to grab the new installer instead. Updates are restricted to `index.html`, `package.json`, and `electron/*.cjs`, and any pending apply also finishes automatically on the next launch.

The installer (`npm run dist:installer` → `installer/`) is a standard NSIS setup with a full uninstaller (Windows Apps & Features → Uninstall).

## Where your data lives

| What | Where |
| --- | --- |
| Library, playlists, settings, EQ | Browser localStorage inside Electron's userData folder |
| Album artwork cache | IndexedDB (`tree-player-artwork-v2`) |
| Downloads folder (songs) | `Music\Tree Player Downloads` by default — changeable in settings |
| Downloaded videos | `<downloads folder>\Your Media` |
| Crash log | `userData\your-player-crash.log` |

Removing a tracked folder from settings removes its tracks from the library but never deletes files from disk.

## Project structure

```
index.html              # The entire app UI: styles, markup, and renderer logic
electron/
  main.cjs              # Window creation, file scanning, IPC, file-access allowlist
  preload.cjs           # Secure bridge (window.afterglowDesktop) between UI and main
  downloader.cjs        # yt-dlp/ffmpeg search + download queue manager
  updater.cjs           # GitHub-release update check, download, verify, apply
scripts/
  sync-mobile.js        # Copies the UI into www/ for the Android (Capacitor) port
  copy-installer.js     # Post-build installer helper
  publish-update.js     # Builds the self-update channel (manifest + files) for a release
android/, www/          # Experimental Capacitor Android port (not covered here)
release/                # Build output
```

### Architecture notes
- The renderer is sandboxed (`contextIsolation`, `sandbox`, no node integration). Audio and metadata are read through an IPC allowlist — only files registered via import/scan/download are readable.
- Tag parsing (ID3v2 for MP3, MP4 atoms for M4A/AAC) runs in a pool of 4 web workers over partial file reads (first 6 MB), so imports stay fast even for big libraries.
- The Downloader shells out to `yt-dlp` for search/download and `ffmpeg` for MP3 conversion and video merging; progress is streamed to the UI over IPC.
