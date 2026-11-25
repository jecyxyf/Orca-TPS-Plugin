import { DatabaseSync } from 'node:sqlite';

export function openReadonlyDatabase(filename, busyMs = 100) {
  const db = new DatabaseSync(filename, { readOnly: true, enableExtensionLoading: false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=' + busyMs);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function withTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = operation();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
