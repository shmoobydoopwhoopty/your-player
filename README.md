# Your Player

A desktop music player for Windows that keeps everything on your machine, with album artwork front and center, plus a YouTube downloader and video library built in. Fully offline for your own music; only the Downloader tab talks to YouTube.

> The app is rebrandable: the default name is "Your", and you can rename it from settings or the first run tour.

## Highlights

- **Your library, your files**: point it at your music folders and it builds a persistent library with embedded tags and album art. Supports MP3, M4A/AAC, WAV, FLAC, OGG, Opus, and WebM.
- **Album artwork everywhere**: blurred backdrops, a fullscreen Now Playing view, and automatic upscaling for big displays. Missing art gets a generated placeholder.
- **YouTube downloader**: search YouTube or paste a link, then grab songs as MP3 (straight into your library) or videos (into the Media tab), with a live progress queue.
- **Equalizer with 8 bands**: presets included, custom presets you can save, settings persist.
- **Deep customization**: themes, accent colors, color overrides for every area (including tab buttons, album card backgrounds and borders), opacity sliders for shadows and backgrounds, and a layout editor with drag and drop placement (tab bar docks left, right, top or bottom like the Windows taskbar, the player docks on any side, and the search bar is moveable and resizable).
- **Edit your music**: right click any song, album or artist and choose Edit to rename the artist, album or song, renumber the track, or swap the album art. Changes are written back into your music files themselves, and renaming an album to match another one by the same artist merges them.

## Features

### Library
- Import by file picker, folder scan (recursive, cancellable, with progress), or drag and drop
- Multiple tracked folders with add/remove management and a manual "Rescan folders" button; folders are checked automatically for new music on launch
- Library, favorites, playlists, play counts, queue, volume, shuffle/repeat, and view state persist across restarts **and across app updates** — every snapshot is written both to local storage and to `library.json` in the app's data folder, and the newer of the two wins on launch. Missing files are reported, and a moved folder is relinked automatically
- Views: Home, All Songs, Albums, Artists, Favorites, Most Listened, Playlists
- Albums are built from the tags in your files; anything untagged falls back to the name of the folder it lives in, so songs from different folders never get lumped into one shared album. Clicking an album in the Albums tab opens the album instead of starting playback, and album pages list songs in track-number order
- Sorting (recently added / title / artist), filter chips, and "Show more" pagination for large libraries. "Recently added" is ordered by the date each file was added to disk (not by when you last played it), so a fresh download or a newly copied album lands at the top of Home and nothing moves around while you listen
- Live search with a ranked suggestion dropdown covering songs, artists, albums and playlists. Click an artist or album in the dropdown to open its page; press Enter to see everything that matches across your library
- Artist pages gather everything you have from one artist: albums, songs, playlists that include them and favorites. Clicking an artist in the Artists tab opens their profile (it no longer sneaks a song into the player)
- Custom app logo: pick any picture from your computer for the corner logo
- Custom playlists plus a "Liked songs" collection
- Back/forward navigation history

### Playback
- Play/pause, next/previous, shuffle, and repeat (off / all / one); the Shuffle button on an album or artist page shuffles just that album or artist until you shuffle something else or turn shuffle off
- Scoped playback: playing a song from inside an album or artist page (or a playlist) keeps automatic advance, previous and the Up Next suggestions inside that collection; anything you queue manually still plays first. Starting playback elsewhere (Home, All songs, a card, pressing Play) goes back to your whole library
- Draggable seek bar, elapsed/total time, volume slider with mute
- **Up Next** queue: drag to reorder while audio keeps playing, continues on its own in shuffle or library order, and an option to clear the queue
- Song crossfade: fade gently out of one song and into the next, with a 0 to 10 second slider in settings
- "Listened to" counter next to the song in the player, counting every play or restart
- Click the artist name in the player to jump to their artist page
- Fullscreen Now Playing overlay with blurred artwork backdrop
- Equalizer with 8 bands (60 Hz to 16 kHz, ±12 dB), 13 included presets, and custom presets you can save, name and delete; picking a preset moves every band, and Reset puts them back flat
- Party mode: settings toggle that flashes the screen in shifting colors on every bass hit under 100 Hz while music plays
- Keyboard shortcuts (when not typing in a field):

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek back / forward 5 s |
| `↑` / `↓` | Volume up / down |
| `Esc` | Close overlays (now playing, drawers, popups) |

### Downloader (powered by yt-dlp)
- Search YouTube (up to 25 results) or paste any video / Shorts / playlist URL
- Autocomplete suggestions as you type
- Embedded preview player before you commit, and you can sign in to YouTube from the app so age gated or restricted videos play properly
- Look up any artist or album straight from the right click menu in your library
- **MP3** downloads (best audio, embedded thumbnail and metadata) are imported into your library automatically
- **Video** downloads (H.264, ≤1080p MP4) land in the **Media** tab
- Download queue with live progress (percent, speed, ETA), cancel one or all, up to 3 downloads at once
- A download pill with live progress follows you around the app while anything is downloading, with a “Downloading…” notice the moment a download starts
- Sign in to YouTube from Settings → YouTube account so age gated or members-only videos can download (cookies stay on your PC)
- Right-click any song or video and choose **Trim** to save a section as a new copy — the original is never touched (uses ffmpeg, same as the downloader)

### Media tab
- Your downloaded videos in a grid; play, trim or delete them (right-click a video for the menu)

### Appearance & layout
- 10 themes: Charcoal, OLED, Slate, Forest, Mocha, Dusk plus four gradient surfaces (Aurora, Sunset, Deep Sea, Nebula), and 14 accent colors including six gradients (Sunset, Aurora, Orchid, Ocean, Ember, Neon). Accent-tinted buttons, player controls and progress bars carry the gradient through the app
- Save any look as a named custom theme (theme + accent + every color and slider), then re-apply or delete it from the theme panel
- Color pickers for every area (accent, background, tab bar, panels, text, player, buttons, tab buttons, album and artist cards, card borders, shadow), and an opacity slider for **every** surface — sidebar, top bar, player, album and artist cards, menus and panels, the Home spotlight and the drag-and-drop overlay — plus drop-shadow strength. Sliders start from the alpha each theme actually uses and only override it once you move them, so they work with or without a custom color; the card border color also frames the Home now-playing picture
- Layout presets (Classic, Compact, Leftie, Cinema, Heads Up), size sliders, and a "Customize layout" edit mode with drag and drop snap zones. The tab bar docks on any side like the Windows taskbar, the player docks on any side, and the search bar can move and resize
- Player bar under your control: set the progress bar's thickness (2–12px) and move it to the top or bottom edge of the player, and rearrange or hide the player's own parts — song info, transport controls, and the volume/EQ/queue block — with the move and hide buttons in Settings → Layout
- Home page layout editor: drag the now-playing hero, Up next card and song list onto any of 9 snap points (3×3 grid — top/middle/bottom × left/center/right); sections scale to their cell and the classic side-by-side look stays the default
- Sharper blown-up album art: the now-playing full-screen view upscales in multiple passes with an unsharp-mask sharpen between passes, targets your screen size, and still works when a track has no large embedded artwork
- Frameless window with custom window controls; rename the app and it propagates everywhere

## Getting started

### Installing
Grab the newest Windows installer from the [releases page](https://github.com/shmoobydoopwhoopty/your-player/releases/latest): the asset is named like `Your.Player.Setup.1.0.8.exe` (GitHub renames spaces to dots in download links). Installed apps update themselves from the same releases page; new installers appear here with each release.

### Prerequisites
- [Node.js](https://nodejs.org) 18+
- **For the Downloader tab only:** [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org)
  - Install e.g. `winget install yt-dlp` and `winget install Gyan.FFmpeg`; both just need to be on your PATH
  - Everything else (library, playback, equalizer) works without them

### Run in development
```bash
npm install
npm start
```

### Build an installer / portable exe
```bash
npm run dist              # NSIS installer + portable exe  → release/
npm run dist:installer    # installer only
npm run dist:portable     # portable exe only
```

### Releases and updates

The app ships with an updater pointed at this project's GitHub releases:

- Installed apps check `releases/latest/download/manifest.json` shortly after launch and every 30 minutes.
- When a newer version is published, a red dot appears on the settings button, and Settings → Update can download, verify (SHA-256), and install it, and the app relaunches to finish.
- You can change the update source any time in Settings → Update source.
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

## Updates (the app updates itself)

The app can update itself, no reinstall needed:

1. **Publish an update channel:** after bumping the version in `package.json`, run:
   ```bash
   npm run publish:update        # writes release/update-channel/ (app files + manifest.json)
   ```
2. **Host the folder** on any static HTTP(S) server (the manifest and files just sit side by side).
3. **Point installs at it:** Settings → Update source → `<url>/manifest.json`. To skip that step, bake the URL into `DEFAULT_UPDATE_URL` in `electron/updater.cjs`.

Installed apps check the channel at launch and every 30 minutes. When a newer version is published, a **red dot** appears on the settings button and Settings → Update offers **Download & install update**: files are verified with SHA-256, staged in userData, swapped into the install folder with backups, and the app relaunches. Old versions are kept under `userData/updates/backups/`.

Notes: updates from inside the app apply to installed (NSIS) builds; the portable exe will tell you to grab the new installer instead. Updates are restricted to `index.html`, `package.json`, and `electron/*.cjs`, and any pending apply also finishes automatically on the next launch.

The installer (`npm run dist:installer` → `installer/`) is a standard NSIS setup with a full uninstaller (Windows Apps & Features → Uninstall).

## Where your data lives

| What | Where |
| --- | --- |
| Library, playlists, settings, EQ | Browser localStorage inside Electron's userData folder |
| Album artwork cache | IndexedDB inside Electron's userData folder |
| Downloads folder (songs) | `Music\Your Player Downloads` by default, changeable in settings |
| Downloaded videos | `<downloads folder>\Your Media` |
| Crash log | `userData\your-player-crash.log` |

Removing a tracked folder from settings removes its tracks from the library but never deletes files from disk.

## Project structure

```
index.html              # The entire app UI: styles, markup, and renderer logic
electron/
  main.cjs              # Window creation, file scanning, IPC file access allowlist
  preload.cjs           # Secure bridge (window.afterglowDesktop) between UI and main
  downloader.cjs        # yt-dlp/ffmpeg search + download queue manager
  updater.cjs           # GitHub release update check, download, verify, apply
scripts/
  copy-installer.js     # Copies the built installer into installer/
  publish-update.js     # Builds the update channel (manifest + files) for a release
release/                # Build output
```

### Architecture notes
- The renderer is sandboxed (`contextIsolation`, `sandbox`, no node integration). Audio and metadata are read through an IPC allowlist, so only files registered via import/scan/download are readable.
- Tag parsing runs in a pool of 4 web workers over partial file reads, so imports stay fast even for big libraries. MP3 reads ID3v2.2/2.3/2.4 (plain and syncsafe frame sizes, extended headers, unsynchronised tags, APIC artwork), M4A/MP4 walks the real atom tree (metadata is read from the start and end of the file separately, so a trailing `moov` still works), and FLAC, OGG/Opus and WAV read their Vorbis comments, picture blocks and RIFF INFO tags. Titles, artists, albums and track numbers all come from your files.
- The Downloader shells out to `yt-dlp` for search/download and `ffmpeg` for MP3 conversion and video merging; progress is streamed to the UI over IPC.
