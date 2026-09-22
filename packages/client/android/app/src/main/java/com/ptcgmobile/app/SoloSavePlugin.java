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
    private static class SaveDatabase extends SQLiteOpenHelper {
        SaveDatabase(Context context) { super(context, "ptcg-solo-v1.sqlite", null, 1); }
        @Override public void onConfigure(SQLiteDatabase db) { db.execSQL("PRAGMA synchronous=FULL"); }
        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE save (id INTEGER PRIMARY KEY CHECK(id=1), current TEXT NOT NULL, previous TEXT, ledger TEXT NOT NULL)");
        }
        @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            throw new IllegalStateException("Unsupported solo database version");
        }
    }
    @Override public void load() { helper = new SaveDatabase(getContext()); }
    private String[] row(SQLiteDatabase db) {
        try (Cursor cursor = db.rawQuery("SELECT current, previous, ledger FROM save WHERE id=1", null)) {
            return cursor.moveToFirst() ? new String[] {cursor.getString(0), cursor.getString(1), cursor.getString(2)} : new String[] {null, null, null};
        }
    }
    @PluginMethod public synchronized void read(PluginCall call) {
        try {
            String[] values = row(helper.getReadableDatabase());
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
            String[] old = row(db);
            if (!Objects.equals(old[0], expected)) throw new IllegalStateException("存档已被另一会话更新，请重新读取。");
            ContentValues values = new ContentValues();
            values.put("id", 1);
            values.put("current", next);
            values.put("ledger", ledger);
            values.put("previous", Boolean.TRUE.equals(call.getBoolean("preservePrevious", false)) ? old[1] : old[0]);
            db.delete("save", "id=1", null);
            db.insertOrThrow("save", null, values);
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
