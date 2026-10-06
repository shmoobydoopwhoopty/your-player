package com.yourplayer.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;

import kotlin.Unit;
import kotlin.jvm.functions.Function3;

/**
 * TreeNative — the Android equivalent of the Electron main process for Your Player.
 *
 * - Serves the app-private music library (getExternalFilesDir/Music) the same way the
 *   desktop build serves the user's music folder.
 * - Imports audio via the system file/folder pickers (copies into the library).
 * - Runs YouTube search + downloads through the bundled yt-dlp (youtubedl-android).
 *   Audio downloads land in "<library>/Your Player Downloads", videos in
 *   "<library>/Your Player Downloads/Your Media" — mirroring the desktop layout.
 */
@CapacitorPlugin(name = "TreeNative")
public class TreeNativePlugin extends Plugin {

    private static final Set<String> AUDIO_EXT = new HashSet<>(Arrays.asList(
            ".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".webm"));
    private static final Set<String> VIDEO_EXT = new HashSet<>(Arrays.asList(
            ".mp4", ".webm", ".mkv"));
    private static final Pattern OUTPUT_PATH_RE =
            Pattern.compile("\\.(mp3|m4a|mp4|webm|mkv|opus|ogg|wav|flac)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern SPEED_RE = Pattern.compile("\\bat\\s+([0-9.]+\\s*[KMG]?i?B/s)");
    private static final Pattern PLAIN_YT_URL_RE = Pattern.compile(
            "^(https?://)?(www\\.|m\\.|music\\.)?(youtube\\.com/|youtu\\.be/)", Pattern.CASE_INSENSITIVE);
    private static final Pattern SANITIZE_RE = Pattern.compile("[\\\\/:*?\"<>|\\u0000-\\u001f]");

    private static final int SCAN_FILE_LIMIT = 5000;
    private static final int SCAN_ENTRY_LIMIT = 30000;

    private final ExecutorService exec = Executors.newFixedThreadPool(4);
    private final ExecutorService downloadExec = Executors.newFixedThreadPool(3);
    private final ExecutorService initExec = Executors.newSingleThreadExecutor();

    private final Map<String, Job> jobs = new LinkedHashMap<>();
    private final Object jobsLock = new Object();
    private final AtomicLong jobCounter = new AtomicLong(0);
    private long lastProgressNotify = 0;

    private final AtomicBoolean scanCanceled = new AtomicBoolean(false);
    private final AtomicBoolean ytdlpStarted = new AtomicBoolean(false);
    private final CountDownLatch ytdlpLatch = new CountDownLatch(1);
    private volatile String ytdlpState = "starting";
    private volatile String ytdlpError = "";

    private File musicDir;
    private File downloadsRoot;
    private File mediaRoot;

    private static class Job {
        String id;
        String url;
        String kind;
        String title;
        String channel;
        String status = "downloading";
        String stage = "Starting…";
        String error = "";
        String speed = "";
        String eta = "";
        String filePath = "";
        double percent = 0;
        long startedAt;
        long finishedAt;
    }

    // ── Lifecycle / directories ────────────────────────────────────────────────

    @Override
    public void load() {
        ensureDirs();
    }

    private void ensureDirs() {
        if (musicDir == null) {
            Context ctx = getContext();
            File base = ctx.getExternalFilesDir("Music");
            if (base == null) base = new File(ctx.getFilesDir(), "Music");
            musicDir = base;
downloadsRoot = new File(musicDir, "Your Player Downloads");
mediaRoot = new File(downloadsRoot, "Your Media");
        }
        if (!musicDir.exists()) musicDir.mkdirs();
        if (!downloadsRoot.exists()) downloadsRoot.mkdirs();
        if (!mediaRoot.exists()) mediaRoot.mkdirs();
    }

    private void startYtDlpInit() {
        if (!ytdlpStarted.compareAndSet(false, true)) return;
        initExec.execute(() -> {
            try {
                YoutubeDL.getInstance().init(getContext());
                // Refresh the bundled yt-dlp against the latest stable release; if the
                // update fails (offline etc.) the bundled binary still works.
                try {
                    YoutubeDL.getInstance().updateYoutubeDL(getContext(), YoutubeDL.UpdateChannel.STABLE.INSTANCE);
                } catch (Exception ignored) {
                }
                ytdlpState = "ready";
            } catch (Throwable t) {
                ytdlpState = "failed";
                ytdlpError = String.valueOf(t.getMessage() != null ? t.getMessage() : t);
            } finally {
                ytdlpLatch.countDown();
            }
        });
    }

    private void awaitYtDlp() throws Exception {
        if (!ytdlpLatch.await(240, TimeUnit.SECONDS)) {
            throw new Exception("yt-dlp is still initializing — try again in a moment");
        }
        if (!"ready".equals(ytdlpState)) {
            throw new Exception("yt-dlp failed to initialize" + (ytdlpError.isEmpty() ? "" : (": " + ytdlpError)));
        }
    }

    // ── File records ───────────────────────────────────────────────────────────

    private static JSObject recordFrom(File file) {
        JSObject record = new JSObject();
        record.put("path", file.getAbsolutePath());
        record.put("name", file.getName());
        record.put("size", file.length());
        record.put("lastModified", file.lastModified());
        return record;
    }

    private static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        return dot >= 0 ? name.substring(dot).toLowerCase(Locale.US) : "";
    }

    private static String sanitizeFileName(String name) {
        String cleaned = SANITIZE_RE.matcher(name == null ? "" : name).replaceAll(" ").trim();
        if (cleaned.isEmpty()) cleaned = "audio-" + System.currentTimeMillis();
        return cleaned;
    }

    private static File uniqueDestination(File target) {
        if (!target.exists()) return target;
        String name = target.getName();
        String base = name;
        String ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            base = name.substring(0, dot);
            ext = name.substring(dot);
        }
        for (int i = 2; i < 1000; i++) {
            File candidate = new File(target.getParentFile(), base + " (" + i + ")" + ext);
            if (!candidate.exists()) return candidate;
        }
        return new File(target.getParentFile(), base + " (" + System.currentTimeMillis() + ")" + ext);
    }

    private File copyUriIntoMusicDir(Uri uri) throws Exception {
        String displayName = null;
        try (android.database.Cursor cursor = getContext().getContentResolver().query(
                uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                displayName = cursor.getString(0);
            }
        } catch (Exception ignored) {
        }
        if (displayName == null || displayName.isEmpty()) displayName = "audio-" + System.currentTimeMillis() + ".m4a";
        String ext = extensionOf(displayName);
        File target = new File(musicDir, sanitizeFileName(displayName));
        try (InputStream in = getContext().getContentResolver().openInputStream(uri);
             OutputStream out = new FileOutputStream(target)) {
            if (in == null) throw new Exception("Could not open the selected file");
            byte[] buffer = new byte[1 << 16];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        } catch (Exception e) {
            target.delete();
            throw e;
        }
        return target;
    }

    // ── Import: pick audio files ───────────────────────────────────────────────

    @PluginMethod
    public void pickAudioFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("audio/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "audio/mpeg", "audio/mp4", "audio/aac", "audio/x-wav", "audio/wav",
                "audio/flac", "audio/ogg", "application/ogg", "audio/opus"});
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, intent, "onAudioPicked");
    }

    @ActivityCallback
    private void onAudioPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSArray files = new JSArray();
        if (result != null && result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            Intent data = result.getData();
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                    Uri uri = data.getClipData().getItemAt(i).getUri();
                    if (uri != null) uris.add(uri);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            for (Uri uri : uris) {
                try {
                    File dest = copyUriIntoMusicDir(uri);
                    if (dest != null && dest.isFile()) files.put(recordFrom(dest));
                } catch (Exception ignored) {
                }
            }
        }
        JSObject out = new JSObject();
        out.put("files", files);
        call.resolve(out);
    }

    // ── Import: pick a folder and copy every audio file inside ─────────────────

    @PluginMethod
    public void pickMusicFolder(PluginCall call) {
        scanCanceled.set(false);
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        startActivityForResult(call, intent, "onFolderPicked");
    }

    @ActivityCallback
    private void onFolderPicked(final PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject out = new JSObject();
        if (result == null || result.getResultCode() != Activity.RESULT_OK
                || result.getData() == null || result.getData().getData() == null) {
            out.put("canceled", true);
            out.put("total", 0);
            out.put("truncated", false);
            call.resolve(out);
            return;
        }
        final Uri treeUri = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) {
        }
        exec.execute(() -> runFolderScan(call, treeUri));
    }

    private void runFolderScan(final PluginCall call, Uri treeUri) {
        ensureDirs();
        int total = 0;
        int scannedEntries = 0;
        boolean truncated = false;
        JSArray batch = new JSArray();
        try {
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), treeUri);
            if (root == null || !root.canRead()) throw new Exception("That folder could not be opened");
            List<DocumentFile> pending = new ArrayList<>();
            pending.add(root);
            int scannedFolders = 0;
            while (!pending.isEmpty() && total < SCAN_FILE_LIMIT && scannedEntries < SCAN_ENTRY_LIMIT) {
                if (scanCanceled.get()) break;
                DocumentFile dir = pending.remove(pending.size() - 1);
                scannedFolders++;
                String dirName = dir.getName() == null ? "selected folder" : dir.getName();
                notifyFolderProgress(dirName, total, scannedFolders, scannedEntries);
                DocumentFile[] children = dir.listFiles();
                for (DocumentFile child : children) {
                    if (scanCanceled.get() || total >= SCAN_FILE_LIMIT || scannedEntries >= SCAN_ENTRY_LIMIT) {
                        truncated = total >= SCAN_FILE_LIMIT || scannedEntries >= SCAN_ENTRY_LIMIT;
                        break;
                    }
                    scannedEntries++;
                    if (child.isDirectory()) {
                        pending.add(child);
                    } else {
                        String name = child.getName() == null ? "" : child.getName();
                        if (!AUDIO_EXT.contains(extensionOf(name))) continue;
                        try {
                            File dest = copyUriIntoMusicDir(child.getUri());
                            if (dest.isFile()) {
                                batch.put(recordFrom(dest));
                                total++;
                                if (batch.length() >= 20) {
                                    notifyFolderBatch(batch);
                                    batch = new JSArray();
                                }
                            }
                        } catch (Exception ignored) {
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        if (batch.length() > 0) notifyFolderBatch(batch);
        JSObject summary = new JSObject();
        summary.put("done", true);
        summary.put("total", total);
        summary.put("truncated", truncated);
        summary.put("canceled", scanCanceled.get());
        summary.put("folder", musicDir.getAbsolutePath());
        JSObject end = new JSObject();
        end.put("summary", summary);
        notifyListeners("folderBatch", end);

        JSObject out = new JSObject();
        out.put("canceled", false);
        out.put("folder", musicDir.getAbsolutePath());
        out.put("total", total);
        out.put("truncated", truncated);
        call.resolve(out);
    }

    @PluginMethod
    public void cancelScan(PluginCall call) {
        scanCanceled.set(true);
        call.resolve();
    }

    private void notifyFolderBatch(JSArray files) {
        JSObject payload = new JSObject();
        payload.put("files", files);
        notifyListeners("folderBatch", payload);
    }

    private void notifyFolderProgress(String currentFolder, int found, int scannedFolders, int scannedEntries) {
        JSObject payload = new JSObject();
        payload.put("currentFolder", currentFolder);
        payload.put("preScanned", found);
        payload.put("total", found);
        payload.put("scannedFolders", scannedFolders);
        payload.put("scannedEntries", scannedEntries);
        notifyListeners("folderProgress", payload);
    }

    // ── Library file bridge ────────────────────────────────────────────────────

    @PluginMethod
    public void statFiles(PluginCall call) {
        JSArray files = new JSArray();
        JSArray paths = call.getArray("paths");
        if (paths != null) {
            for (int i = 0; i < paths.length(); i++) {
                try {
                    String path = paths.getString(i);
                    if (path == null || path.isEmpty()) continue;
                    File file = new File(path);
                    if (!file.isFile()) continue;
                    if (!AUDIO_EXT.contains(extensionOf(file.getName()))) continue;
                    files.put(recordFrom(file));
                } catch (Exception ignored) {
                }
            }
        }
        JSObject out = new JSObject();
        out.put("files", files);
        call.resolve(out);
    }

    @PluginMethod
    public void refreshFiles(final PluginCall call) {
        exec.execute(() -> {
            ensureDirs();
            List<File> found = new ArrayList<>();
            List<File> pending = new ArrayList<>();
            pending.add(musicDir);
            int scannedFolders = 0;
            int scannedEntries = 0;
            boolean truncated = false;
            JSArray batch = new JSArray();
            while (!pending.isEmpty() && found.size() < SCAN_FILE_LIMIT && scannedEntries < SCAN_ENTRY_LIMIT) {
                File dir = pending.remove(pending.size() - 1);
                scannedFolders++;
                File[] children = dir.listFiles();
                if (children == null) continue;
                for (File child : children) {
                    if (found.size() >= SCAN_FILE_LIMIT || scannedEntries >= SCAN_ENTRY_LIMIT) {
                        truncated = true;
                        break;
                    }
                    scannedEntries++;
                    if (child.isDirectory()) pending.add(child);
                    else if (child.isFile() && AUDIO_EXT.contains(extensionOf(child.getName()))) {
                        found.add(child);
                        batch.put(recordFrom(child));
                        if (batch.length() >= 100) {
                            notifyFolderBatch(batch);
                            batch = new JSArray();
                        }
                    }
                }
                if (found.size() % 250 == 0) {
                    notifyFolderProgress(musicDir.getName(), found.size(), scannedFolders, scannedEntries);
                }
            }
            if (batch.length() > 0) notifyFolderBatch(batch);
            JSArray folders = new JSArray();
            folders.put(musicDir.getAbsolutePath());
            JSObject done = new JSObject();
            done.put("folders", folders);
            notifyListeners("folderDone", done);
            JSObject out = new JSObject();
            out.put("folders", folders);
            out.put("total", found.size());
            out.put("truncated", truncated);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void readBytes(PluginCall call) {
        String path = call.getString("path", "");
        double startD = call.getDouble("start", 0d);
        double endD = call.getDouble("end", 0d);
        long start = Math.max(0, (long) startD);
        long end = Math.max(start, (long) endD);
        if (end - start > 32L * 1024 * 1024) {
            call.reject("Requested read is too large");
            return;
        }
        File file = new File(path);
        if (!file.isFile()) {
            call.reject("File not found: " + path);
            return;
        }
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            long size = raf.length();
            long from = Math.min(start, size);
            long to = Math.min(end, size);
            byte[] bytes = new byte[(int) Math.max(0, to - from)];
            raf.seek(from);
            raf.readFully(bytes);
            JSObject out = new JSObject();
            out.put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            out.put("length", bytes.length);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Could not read file: " + e.getMessage());
        }
    }

    // ── Downloader: search ─────────────────────────────────────────────

    @PluginMethod
    public void search(final PluginCall call) {
        final String query = call.getString("query", "");
        exec.execute(() -> {
            try {
                awaitYtDlp();
                String target = query.trim();
                if (target.isEmpty()) {
                    JSObject empty = new JSObject();
                    empty.put("results", new JSArray());
                    call.resolve(empty);
                    return;
                }
                boolean plainUrl = PLAIN_YT_URL_RE.matcher(target).find();
                YoutubeDLRequest request = new YoutubeDLRequest(
                        plainUrl ? target : ("ytsearch25:" + target));
                request.addOption("--no-warnings");
                request.addOption("--flat-playlist");
                request.addOption("--skip-download");
                request.addOption("--dump-json");
                YoutubeDLResponse response = YoutubeDL.getInstance().execute(request, null,
                        (Function3<Float, Long, String, Unit>) null);
                JSArray results = new JSArray();
                for (String line : response.getOut().split("\r?\n")) {
                    line = line.trim();
                    if (line.isEmpty()) continue;
                    try {
                        mapEntry(new JSONObject(line), results);
                    } catch (Exception ignored) {
                    }
                }
                JSObject out = new JSObject();
                out.put("results", results);
                call.resolve(out);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage() != null ? e.getMessage() : e));
            }
        });
    }

    private static void mapEntry(JSONObject entry, JSArray out) {
        if (entry == null) return;
        String type = entry.optString("_type", "");
        if ("playlist".equals(type) || "multi_video".equals(type)) {
            JSONArray entries = entry.optJSONArray("entries");
            if (entries != null) {
                for (int i = 0; i < entries.length(); i++) {
                    try {
                        mapEntry(entries.optJSONObject(i), out);
                    } catch (Exception ignored) {
                    }
                }
            }
            return;
        }
        String id = entry.optString("id", "");
        if (id.isEmpty()) return;
        String thumbnail = entry.optString("thumbnail", "");
        if (thumbnail.isEmpty()) {
            JSONArray thumbs = entry.optJSONArray("thumbnails");
            if (thumbs != null && thumbs.length() > 0) {
                JSONObject last = thumbs.optJSONObject(thumbs.length() - 1);
                if (last != null) thumbnail = last.optString("url", "");
            }
        }
        String channel = entry.optString("channel", "");
        if (channel.isEmpty()) channel = entry.optString("uploader", "");
        if (channel.isEmpty()) channel = entry.optString("uploader_id", "");
        if (channel.startsWith("http")) channel = "";
        String url = entry.optString("webpage_url", "");
        if (url.isEmpty()) url = entry.optString("url", "");
        if (url.isEmpty() || !url.startsWith("http")) url = "https://www.youtube.com/watch?v=" + id;

        JSObject item = new JSObject();
        item.put("id", id);
        item.put("url", url);
        item.put("title", entry.optString("title", "Untitled"));
        item.put("channel", channel);
        if (entry.has("duration") && !entry.isNull("duration")) {
            try {
                double duration = entry.optDouble("duration");
                if (!Double.isNaN(duration) && !Double.isInfinite(duration)) item.put("duration", duration);
            } catch (Exception ignored) {
            }
        }
        if (entry.has("view_count") && !entry.isNull("view_count")) {
            try {
                double views = entry.optDouble("view_count");
                if (!Double.isNaN(views) && !Double.isInfinite(views)) item.put("views", views);
            } catch (Exception ignored) {
            }
        }
        boolean live = entry.optBoolean("is_live", false)
                || "is_live".equals(entry.optString("live_status", ""));
        item.put("isLive", live);
        item.put("thumbnail", thumbnail);
        out.put(item);
    }

    // ── Downloader: downloads ──────────────────────────────────────────

    @PluginMethod
    public void startDownload(final PluginCall call) {
        final String url = call.getString("url", "").trim();
        if (url.isEmpty()) {
            call.reject("A video link is required.");
            return;
        }
        final String kind = "video".equals(call.getString("kind")) ? "video" : "audio";
        final Job job = new Job();
        job.id = "dl-" + jobCounter.incrementAndGet();
        job.url = url;
        job.kind = kind;
        String title = call.getString("title", "");
        job.title = title == null || title.trim().isEmpty() ? url : title.trim();
        String channel = call.getString("channel", "");
        job.channel = channel == null ? "" : channel;
        job.startedAt = System.currentTimeMillis();
        synchronized (jobsLock) {
            jobs.put(job.id, job);
        }
        notifyProgress(true);
        downloadExec.execute(() -> runDownload(job, call));
    }

    private void runDownload(final Job job, final PluginCall call) {
        try {
            awaitYtDlp();
            ensureDirs();
            File outputDir = "video".equals(job.kind) ? mediaRoot : downloadsRoot;
            YoutubeDLRequest request = new YoutubeDLRequest(job.url);
            request.addOption("--no-warnings");
            request.addOption("--no-playlist");
            request.addOption("--no-mtime");
            request.addOption("--newline");
            if ("video".equals(job.kind)) {
                // Progressive H.264/AAC MP4 so the merged file always plays in the WebView.
                request.addOption("-f", "b[ext=mp4][height<=1080]/b[height<=1080]/b");
                request.addOption("-o", new File(outputDir, "%(title)s [%(id)s].%(ext)s").getAbsolutePath());
            } else {
                // Best AAC audio — no ffmpeg needed, plays everywhere, and the
                // "Artist - Title" filename gives the app its metadata.
                request.addOption("-f", "ba[ext=m4a]/ba[acodec^=mp4a]/ba/b");
                request.addOption("-o", new File(outputDir, "%(uploader)s - %(title)s.%(ext)s").getAbsolutePath());
            }
            Function3<Float, Long, String, Unit> callback = new Function3<Float, Long, String, Unit>() {
                @Override
                public Unit invoke(Float progress, Long eta, String line) {
                    onJobProgress(job, progress, eta, line);
                    return Unit.INSTANCE;
                }
            };
            YoutubeDL.getInstance().execute(request, job.id, callback);
            job.status = "done";
            job.percent = 100;
            job.stage = "";
            job.finishedAt = System.currentTimeMillis();
            job.filePath = newestOutput(outputDir, job.startedAt);
        } catch (YoutubeDL.CanceledException canceled) {
            job.status = "canceled";
            job.stage = "";
            job.percent = job.percent;
            job.finishedAt = System.currentTimeMillis();
        } catch (Throwable t) {
            if (!"canceled".equals(job.status)) {
                job.status = "error";
                String message = t.getMessage() != null ? t.getMessage() : String.valueOf(t);
                job.error = message.length() > 400 ? message.substring(0, 400) : message;
            }
            job.stage = "";
            job.finishedAt = System.currentTimeMillis();
        }
        notifyProgress(true);
        JSObject out = new JSObject();
        out.put("id", job.id);
        out.put("kind", job.kind);
        out.put("status", job.status);
        out.put("title", job.title);
        out.put("filePath", job.filePath);
        out.put("error", job.error);
        if ("done".equals(job.status) && "audio".equals(job.kind) && !job.filePath.isEmpty()) {
            File file = new File(job.filePath);
            if (file.isFile()) out.put("file", recordFrom(file));
        }
        call.resolve(out);
    }

    private void onJobProgress(Job job, Float progress, Long eta, String line) {
        if (job == null || line == null) return;
        if (!"downloading".equals(job.status)) return;
        if (line.contains("[download]")) {
            job.stage = "Downloading";
            if (progress != null) {
                float p = progress;
                job.percent = Math.max(0, Math.min(100, p));
            }
            if (eta != null) job.eta = formatEta(eta);
            Matcher speed = SPEED_RE.matcher(line);
            if (speed.find()) job.speed = speed.group(1);
            notifyProgress(false);
        }
    }

    private static String formatEta(long seconds) {
        if (seconds < 0) seconds = 0;
        long s = seconds % 60;
        long m = (seconds / 60) % 60;
        long h = seconds / 3600;
        if (h > 0) return String.format(Locale.US, "%d:%02d:%02d", h, m, s);
        return String.format(Locale.US, "%d:%02d", m, s);
    }

    private static String newestOutput(File dir, long sinceMs) {
        File[] children = dir.listFiles();
        if (children == null) return "";
        File newest = null;
        long newestTime = 0;
        for (File child : children) {
            if (!child.isFile()) continue;
            if (!OUTPUT_PATH_RE.matcher(child.getName()).find()) continue;
            if (child.lastModified() >= sinceMs - 5000 && child.lastModified() > newestTime) {
                newest = child;
                newestTime = child.lastModified();
            }
        }
        return newest == null ? "" : newest.getAbsolutePath();
    }

    private JSArray jobsArray() {
        JSArray array = new JSArray();
        synchronized (jobsLock) {
            for (Job job : jobs.values()) {
                JSObject item = new JSObject();
                item.put("id", job.id);
                item.put("url", job.url);
                item.put("kind", job.kind);
                item.put("title", job.title);
                item.put("channel", job.channel);
                item.put("status", job.status);
                item.put("stage", job.stage);
                item.put("percent", job.percent);
                item.put("received", 0);
                item.put("speed", job.speed);
                item.put("eta", job.eta);
                item.put("error", job.error);
                item.put("startedAt", job.startedAt);
                item.put("finishedAt", job.finishedAt);
                array.put(item);
            }
        }
        return array;
    }

    private void notifyProgress(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastProgressNotify < 250) return;
        lastProgressNotify = now;
        JSObject payload = new JSObject();
        payload.put("jobs", jobsArray());
        notifyListeners("treeProgress", payload);
    }

    @PluginMethod
    public void activeDownloads(PluginCall call) {
        JSObject out = new JSObject();
        out.put("jobs", jobsArray());
        call.resolve(out);
    }

    @PluginMethod
    public void cancelDownloads(PluginCall call) {
        String id = call.getString("id");
        synchronized (jobsLock) {
            for (Job job : jobs.values()) {
                if (job.status.equals("downloading") && (id == null || id.isEmpty() || job.id.equals(id))) {
                    job.status = "canceled";
                    job.stage = "";
                    job.finishedAt = System.currentTimeMillis();
                    try {
                        YoutubeDL.getInstance().destroyProcessById(job.id);
                    } catch (Exception ignored) {
                    }
                }
            }
        }
        notifyProgress(true);
        call.resolve();
    }

    // ── Your Media ─────────────────────────────────────────────────────────────

    @PluginMethod
    public void listMedia(PluginCall call) {
        ensureDirs();
        JSArray media = new JSArray();
        File[] children = mediaRoot.listFiles();
        if (children != null) {
            Arrays.sort(children, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            for (File child : children) {
                if (!child.isFile()) continue;
                if (!VIDEO_EXT.contains(extensionOf(child.getName()))) continue;
                String base = child.getName();
                int dot = base.lastIndexOf('.');
                if (dot > 0) base = base.substring(0, dot);
                JSObject item = new JSObject();
                item.put("id", base);
                item.put("title", base);
                item.put("path", child.getAbsolutePath());
                item.put("filename", child.getName());
                item.put("kind", "video");
                item.put("size", child.length());
                item.put("addedAt", child.lastModified());
                item.put("url", "");
                media.put(item);
            }
        }
        JSObject out = new JSObject();
        out.put("media", media);
        call.resolve(out);
    }

    @PluginMethod
    public void deleteMedia(PluginCall call) {
        String path = call.getString("path", "");
        File file = new File(path);
        File parent = file.getParentFile();
        boolean inside = parent != null && parent.getAbsolutePath().equals(mediaRoot.getAbsolutePath());
        if (!inside) {
            call.reject("This item is not inside the Your Media folder.");
            return;
        }
        boolean deleted = file.delete();
        if (!deleted) {
            call.reject("Could not delete that video");
            return;
        }
        call.resolve();
    }

    // ── Downloader init ────────────────────────────────────────────────────────

    @PluginMethod
    public void initDownloader(PluginCall call) {
        ensureDirs();
        startYtDlpInit();
        JSObject out = new JSObject();
        out.put("root", downloadsRoot.getAbsolutePath());
        out.put("media", mediaRoot.getAbsolutePath());
        out.put("state", ytdlpState);
        call.resolve(out);
    }
}
