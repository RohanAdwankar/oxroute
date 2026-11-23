"""Real SQLite snapshot/rollback checks, including uncheckpointed WAL and FTS."""
import gzip
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zlib

spec = importlib.util.spec_from_file_location('database_backup', Path(__file__).resolve().parents[1] / 'deploy/database-backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class DatabaseBackup(unittest.TestCase):
    def test_human_decisions_survive_review_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            database, archive = (Path(directory) / name for name in ('live.sqlite3', 'snapshot.gz'))
            original = {'snapshot': {'files': ['saved evidence']}, 'approvedAt': 1, 'feedback': []}
            with sqlite3.connect(database) as live:
                live.execute('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)')
                live.execute('INSERT INTO kv VALUES (?,?)', ('review:proposal', json.dumps(original)))
                live.commit()
                backup.backup(database, archive)
                feedback = [{'reason': 'Revise the prepared configuration.', 'headCommit': 'saved revision'}]
                for approval in (None, 2):
                    changed = {'snapshot': {'files': []}, 'approvedAt': approval, 'feedback': feedback}
                    live.execute('UPDATE kv SET value=?', (json.dumps(changed),))
                    live.commit()
                    backup.restore_reviews(database, archive)
                    restored = json.loads(live.execute('SELECT value FROM kv').fetchone()[0])
                    self.assertEqual(restored, {**original, 'approvedAt': approval, 'feedback': feedback})

    def test_compressed_snapshot_and_selective_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            database, archive = (Path(directory) / name for name in ('live.sqlite3', 'snapshot.gz'))
            with sqlite3.connect(database) as live:
                live.executescript('''PRAGMA journal_mode=WAL;
                    CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB);
                    CREATE TABLE tasks (id TEXT, status TEXT);
                    CREATE VIRTUAL TABLE search USING fts5(text);
                    INSERT INTO kv VALUES ('review:original', 'evidence'), ('setting', 'old');
                    INSERT INTO tasks VALUES ('item', 'done');
                    INSERT INTO search VALUES ('searchable evidence');''')
                payload = b'\x00\xff' + 'Unicode and\nnewlines λ'.encode() * 100000
                live.execute('INSERT INTO kv VALUES (?,?)', ('binary', payload))
                live.commit()
                backup.backup(database, archive)
                self.assertLess(archive.stat().st_size, database.stat().st_size + Path(str(database) + '-wal').stat().st_size)
                restored_path = Path(directory) / 'restored.sqlite3'
                restored_path.write_bytes(gzip.decompress(archive.read_bytes()))
                with sqlite3.connect(restored_path) as restored:
                    self.assertEqual(restored.execute("SELECT value FROM kv WHERE key='binary'").fetchone()[0], payload)
                    self.assertEqual(restored.execute("SELECT text FROM search WHERE search MATCH 'evidence'").fetchall(), [('searchable evidence',)])
                live.executescript("DELETE FROM kv WHERE key LIKE 'review:%'; UPDATE kv SET value='new' WHERE key='setting'; UPDATE tasks SET status='complete';")
                backup.restore_reviews(database, archive)
                self.assertEqual(live.execute("SELECT value FROM kv WHERE key='review:original'").fetchone()[0], 'evidence')
                self.assertEqual(live.execute("SELECT value FROM kv WHERE key='setting'").fetchone()[0], 'new')
                self.assertEqual(live.execute('SELECT status FROM tasks').fetchone()[0], 'complete')
                live.execute("UPDATE kv SET value='current review' WHERE key='review:original'")
                live.commit()
                reviews = backup.reviews_path(archive)
                damaged = bytearray(reviews.read_bytes()); damaged[-9] ^= 1; reviews.write_bytes(damaged)
                with self.assertRaises((OSError, EOFError, RuntimeError, zlib.error)):
                    backup.restore_reviews(database, archive)
                self.assertEqual(live.execute("SELECT value FROM kv WHERE key='review:original'").fetchone()[0], 'current review')
                self.assertEqual(live.execute('SELECT status FROM tasks').fetchone()[0], 'complete')


if __name__ == '__main__':
    unittest.main()
