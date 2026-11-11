// Undo for the last delete. Deleting a session, task or subject (or resetting a
// subject's time) removes the rows right away and keeps a copy here, in memory,
// so the page can offer "Undo" for a few seconds. Only the latest delete can be
// undone, and the copy is gone when inmo closes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};

type Row = Vec<(String, SqlValue)>;

pub struct Deleted {
    pub id: u64,
    // (table, rows), restored in this order: subjects before what belongs to them.
    tables: Vec<(&'static str, Vec<Row>)>,
    // Seconds to add back to subjects' totals (a deleted session, a reset).
    add_totals: Vec<(String, i64)>,
}

#[derive(Default)]
pub struct Trash(pub Mutex<Option<Deleted>>);

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl Deleted {
    pub fn new() -> Deleted {
        Deleted { id: NEXT_ID.fetch_add(1, Ordering::Relaxed), tables: vec![], add_totals: vec![] }
    }

    // Copies the rows `DELETE FROM table WHERE <filter>` is about to remove.
    pub fn keep(&mut self, tx: &Transaction, table: &'static str, filter: &str, arg: &dyn rusqlite::ToSql) -> rusqlite::Result<()> {
        let mut stmt = tx.prepare(&format!("SELECT * FROM {table} WHERE {filter}"))?;
        let names: Vec<String> = stmt.column_names().map(|s| s.to_string()).collect();
        let rows = stmt
            .query_map([arg], |r| {
                (0..names.len()).map(|i| Ok((names[i].clone(), r.get::<_, SqlValue>(i)?))).collect::<rusqlite::Result<Row>>()
            })?
            .collect::<rusqlite::Result<Vec<Row>>>()?;
        if !rows.is_empty() {
            self.tables.push((table, rows));
        }
        Ok(())
    }

    pub fn add_back(&mut self, course_id: &str, secs: i64) {
        if secs > 0 {
            self.add_totals.push((course_id.to_string(), secs));
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tables.is_empty() && self.add_totals.is_empty()
    }

    fn restore(&self, conn: &mut Connection) -> Result<(), String> {
        let tx = conn.transaction().map_err(crate::db::err)?;
        for (table, rows) in &self.tables {
            for row in rows {
                let cols: Vec<&str> = row.iter().map(|(c, _)| c.as_str()).collect();
                let marks = vec!["?"; cols.len()].join(", ");
                let sql = format!("INSERT INTO {table} ({}) VALUES ({marks})", cols.join(", "));
                tx.execute(&sql, params_from_iter(row.iter().map(|(_, v)| v)))
                    .map_err(|e| format!("Couldn't undo: {e}"))?;
            }
        }
        for (course_id, secs) in &self.add_totals {
            let changed = tx
                .execute("UPDATE courses SET total_seconds = total_seconds + ? WHERE id = ?", params![secs, course_id])
                .map_err(crate::db::err)?;
            if changed == 0 {
                return Err("Couldn't undo: that subject has been deleted since.".into());
            }
        }
        // Sessions and tasks put back must still belong to a subject.
        for (table, rows) in &self.tables {
            if *table == "courses" {
                continue;
            }
            for row in rows {
                if let Some((_, SqlValue::Text(id))) = row.iter().find(|(c, _)| c == "course_id") {
                    let exists = tx
                        .query_row("SELECT 1 FROM courses WHERE id = ?", [id], |_| Ok(()))
                        .optional()
                        .map_err(crate::db::err)?
                        .is_some();
                    if !exists {
                        return Err("Couldn't undo: that subject has been deleted since.".into());
                    }
                }
            }
        }
        tx.commit().map_err(crate::db::err)
    }
}

impl Trash {
    // Remembers a delete, replacing the previous one. Returns its undo id.
    pub fn put(&self, deleted: Deleted) -> Option<u64> {
        if deleted.is_empty() {
            return None;
        }
        let id = deleted.id;
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(deleted);
        }
        Some(id)
    }

    // Puts back the delete with this id, if it's still the latest one.
    pub fn undo(&self, conn: &mut Connection, id: u64) -> Result<(), String> {
        let mut slot = self.0.lock().map_err(crate::db::err)?;
        match slot.as_ref() {
            Some(d) if d.id == id => {
                d.restore(conn)?;
                *slot = None;
                Ok(())
            }
            _ => Err("That can no longer be undone.".into()),
        }
    }
}
