# Your Player for Android

The same single-file app (`index.html`) wrapped in a native Android shell (Capacitor),
with a Java plugin (`TreeNativePlugin.java`) that reproduces the Electron backend:

| Desktop (Electron) | Android (TreeNativePlugin) |
| --- | --- |
| Reads your music folder | App-private library: `Android/data/com.yourplayer.app/files/Music` |
| yt-dlp + ffmpeg from PATH | yt-dlp + Python **bundled in the APK** (youtubedl-android 0.18.1, auto-updates to latest stable) |
| `afterglowDesktop` IPC bridge | `www/tree-mobile.js` shim over the `TreeNative` plugin |

## Install on your phone

1. Copy the built APK (e.g. `release/Your-Player-android.apk`) to your phone (USB, Drive, etc.).
2. Tap it → allow "Install unknown apps" for that app → Install.
   (It's a self-signed debug build — that's expected for sideloading.)
3. Open **Your Player**. On first search/download it unpacks its bundled yt-dlp
   (takes a few seconds), then auto-updates it to the newest release.

## How your library works on the phone

- The phone library starts empty — it does **not** sync your PC library.
- **Add music** (top right) opens the Android file picker; picked songs are copied
  into the app's own library.
- The folder button opens a folder picker and imports every audio file inside it.
- **Downloader** downloads land in the app's library:
  - audio → `.../files/Music/Your Player Downloads` (named `Artist - Title.m4a`,
    so title/artist fill in automatically)
  - video → `.../files/Music/Your Player Downloads/Your Media` → plays in the
    **Media** tab, exactly like the desktop app.

## Rebuilding after UI changes

```bash
npm run android:build   # syncs index.html -> www -> APK
```
Output: `android/app/build/outputs/apk/debug/app-debug.apk`

The build needs JDK 21 (portable copy in `vendor/`) and the Android SDK in
`%LOCALAPPDATA%\Android\Sdk` (path pinned in `android/local.properties`).

## Notes & limits

- Downloads run in the background **while the app is on screen**; Android may pause
  them if you leave the app (a foreground service is a future upgrade).
- Videos download as progressive MP4 (≤1080p, no ffmpeg needed) — same playback
  compatibility as the desktop H.264 setting.
- The mini YouTube preview requires YouTube's embed, which is region-dependent.
