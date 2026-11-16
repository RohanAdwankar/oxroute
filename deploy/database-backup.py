"""Compressed SQLite snapshots and review-only deployment rollback."""
import gzip
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

HEADROOM = 1024**3
CHUNK = 8 * 1024**2


def room(path):
    if shutil.disk_usage(path).free < HEADROOM:
        raise RuntimeError('Backup would consume deployment disk headroom; services preserved')


def digest(stream):
    result = hashlib.sha256()
    while block := stream.read(CHUNK):
        result.update(block)
    return result.digest()


def reviews_path(archive):
    return archive.with_name('reviews.jsonl.gz')


def backup(database, archive):
    # SQLite's online backup includes committed WAL pages and virtual indexes.
    with tempfile.TemporaryDirectory(dir=archive.parent) as temporary:
        snapshot = Path(temporary) / 'snapshot.sqlite3'
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as source, sqlite3.connect(snapshot) as saved:
            source.execute('BEGIN')
            source.execute('SELECT count(*) FROM sqlite_schema').fetchone()
            source.backup(saved, pages=256, progress=lambda *_: room(archive.parent))
            if saved.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                raise RuntimeError('Database snapshot failed integrity validation')
            # Keep selective rollback streamable, preserving newer user data.
            with gzip.open(reviews_path(archive), 'wt', compresslevel=1) as reviews:
                for key, value in saved.execute("SELECT key,value FROM kv WHERE key GLOB 'review:*'"):
                    reviews.write(json.dumps([key, value]) + '\n')
                    room(archive.parent)
        with snapshot.open('rb') as source, gzip.open(archive, 'wb', compresslevel=1) as destination:
            while block := source.read(CHUNK):
                room(archive.parent)
                destination.write(block)
        with snapshot.open('rb') as original, gzip.open(archive, 'rb') as restored:
            if digest(original) != digest(restored):
                raise RuntimeError('Compressed database restore verification failed')
        size = snapshot.stat().st_size
    room(archive.parent)
    print(f'Compressed and restore-verified {size / 1024**2:.1f} MiB to {archive.stat().st_size / 1024**2:.1f} MiB')


def restore_reviews(database, archive):
    # One transaction also rolls back all writes if gzip detects corruption.
    with sqlite3.connect(database) as current, gzip.open(reviews_path(archive), 'rt') as reviews:
        current.executemany('INSERT OR REPLACE INTO kv (key,value) VALUES (?,?)', (json.loads(line) for line in reviews))


if __name__ == '__main__':
    action, database, archive = sys.argv[1:]
    {'backup': backup, 'restore-reviews': restore_reviews}[action](Path(database).resolve(), Path(archive).resolve())
