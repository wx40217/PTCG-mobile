package com.ptcgmobile.app;

import android.content.Context;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Objects;
import org.json.JSONObject;

/** One durable transaction contains both match and result ledger; never shares image-cache files. */
@CapacitorPlugin(name = "SoloSave")
public class SoloSavePlugin extends Plugin {
    private SaveDatabase helper;
    private static final int CHUNK_CHARS = 32768;
    private static class SaveDatabase extends SQLiteOpenHelper {
        SaveDatabase(Context context) { super(context, "ptcg-solo-v1.sqlite", null, 2); }
        @Override public void onConfigure(SQLiteDatabase db) { db.execSQL("PRAGMA synchronous=FULL"); }
        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE streams (name TEXT PRIMARY KEY, parts INTEGER NOT NULL, chars INTEGER NOT NULL)");
            db.execSQL("CREATE TABLE chunks (stream TEXT NOT NULL, part INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(stream,part))");
        }
        @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            if (oldVersion != 1 || newVersion != 2) throw new IllegalStateException("Unsupported solo database version");
            onCreate(db);
            // SQLiteOpenHelper wraps migration in a transaction. Never SELECT the old large TEXT.
            for (String stream : new String[] {"current", "previous", "ledger"}) {
                int scalarLength;
                try (Cursor size = db.rawQuery("SELECT length(" + stream + ") FROM save WHERE id=1", null)) {
                    if (!size.moveToFirst() || size.isNull(0)) continue;
                    scalarLength = size.getInt(0);
                }
                int part = 0;
                long chars = 0;
                // SQLite substr counts code points, so it cannot split a surrogate pair.
                for (int offset = 1; offset <= scalarLength; offset += CHUNK_CHARS) {
                    try (Cursor fragment = db.rawQuery("SELECT substr(" + stream + ",?,?) FROM save WHERE id=1",
                            new String[] {Integer.toString(offset), Integer.toString(CHUNK_CHARS)})) {
                        if (!fragment.moveToFirst() || fragment.isNull(0)) throw new IllegalStateException("Incomplete old save");
                        String text = fragment.getString(0);
                        putChunk(db, stream, part++, text);
                        chars += text.length();
                    }
                }
                putManifest(db, stream, part, chars);
            }
            db.execSQL("DROP TABLE save");
        }
    }
    @Override public void load() { helper = new SaveDatabase(getContext()); }
    private static void putChunk(SQLiteDatabase db, String stream, int part, String text) {
        ContentValues values = new ContentValues();
        values.put("stream", stream); values.put("part", part); values.put("content", text);
        db.insertOrThrow("chunks", null, values);
    }
    private static void putManifest(SQLiteDatabase db, String stream, int parts, long chars) {
        ContentValues values = new ContentValues();
        values.put("name", stream); values.put("parts", parts); values.put("chars", chars);
        db.insertOrThrow("streams", null, values);
    }
    private static void removeStream(SQLiteDatabase db, String stream) {
        db.delete("chunks", "stream=?", new String[] {stream});
        db.delete("streams", "name=?", new String[] {stream});
    }
    private static void putStream(SQLiteDatabase db, String stream, String text) {
        removeStream(db, stream);
        int part = 0;
        for (int offset = 0; offset < text.length();) {
            int end = Math.min(offset + CHUNK_CHARS, text.length());
            if (end < text.length() && Character.isHighSurrogate(text.charAt(end - 1)) && Character.isLowSurrogate(text.charAt(end))) end--;
            putChunk(db, stream, part++, text.substring(offset, end));
            offset = end;
        }
        putManifest(db, stream, part, text.length());
    }
    private static void copyStream(SQLiteDatabase db, String from, String to) {
        removeStream(db, to);
        db.execSQL("INSERT INTO chunks(stream,part,content) SELECT ?,part,content FROM chunks WHERE stream=?", new Object[] {to, from});
        db.execSQL("INSERT INTO streams(name,parts,chars) SELECT ?,parts,chars FROM streams WHERE name=?", new Object[] {to, from});
    }
    private String stream(SQLiteDatabase db, String name) {
        int expectedParts;
        long expectedChars;
        try (Cursor manifest = db.rawQuery("SELECT parts,chars FROM streams WHERE name=?", new String[] {name})) {
            if (!manifest.moveToFirst()) {
                try (Cursor orphan = db.rawQuery("SELECT part FROM chunks WHERE stream=? LIMIT 1", new String[] {name})) {
                    if (orphan.moveToFirst()) throw new IllegalStateException("Orphan save chunks");
                }
                return null;
            }
            expectedParts = manifest.getInt(0); expectedChars = manifest.getLong(1);
            if (expectedParts < 0 || expectedChars < 0) throw new IllegalStateException("Invalid save manifest");
        }
        StringBuilder text = new StringBuilder();
        int part = 0;
        try (Cursor chunks = db.rawQuery("SELECT part,content FROM chunks WHERE stream=? ORDER BY part", new String[] {name})) {
            while (chunks.moveToNext()) {
                if (chunks.getInt(0) != part++ || chunks.isNull(1)) throw new IllegalStateException("Incomplete save chunks");
                text.append(chunks.getString(1));
            }
        }
        if (part != expectedParts || text.length() != expectedChars) throw new IllegalStateException("Truncated save stream");
        return text.toString();
    }
    private String[] row(SQLiteDatabase db) {
        return new String[] {stream(db, "current"), stream(db, "previous"), stream(db, "ledger")};
    }
    @PluginMethod public synchronized void read(PluginCall call) {
        SQLiteDatabase db = null;
        try {
            db = helper.getReadableDatabase();
            // Activity recreation may create a second helper while an old bridge call finishes.
            // Hold one DB snapshot across all streams, not one implicit snapshot per Cursor.
            db.beginTransaction();
            String[] values;
            try { values = row(db); db.setTransactionSuccessful(); }
            finally { db.endTransaction(); }
            JSObject result = new JSObject();
            result.put("current", values[0] == null ? JSONObject.NULL : values[0]);
            result.put("previous", values[1] == null ? JSONObject.NULL : values[1]);
            result.put("ledger", values[2] == null ? JSONObject.NULL : values[2]);
            call.resolve(result);
        } catch (Exception error) { call.reject("无法读取单人存档，原档案已保留。", error); }
    }
    @PluginMethod public synchronized void commit(PluginCall call) {
        String next = call.getString("next");
        String expected = call.getString("expected");
        String ledger = call.getString("ledger");
        if (next == null || next.isEmpty() || ledger == null) { call.reject("缺少完整存档。"); return; }
        SQLiteDatabase db = null;
        boolean committed = false;
        try {
            db = helper.getWritableDatabase();
            db.beginTransaction();
            String oldCurrent = stream(db, "current");
            if (!Objects.equals(oldCurrent, expected)) throw new IllegalStateException("存档已被另一会话更新，请重新读取。");
            if (!Boolean.TRUE.equals(call.getBoolean("preservePrevious", false))) copyStream(db, "current", "previous");
            putStream(db, "current", next);
            putStream(db, "ledger", ledger);
            db.setTransactionSuccessful();
            committed = true;
        } catch (Exception error) {
            call.reject("单人存档写入失败；会话已暂停，原档案已保留。", error);
        } finally {
            if (db != null && db.inTransaction()) {
                try { db.endTransaction(); }
                catch (Exception error) { committed = false; call.reject("单人存档提交失败，请重新读取。", error); }
            }
        }
        if (committed) call.resolve();
    }
}
