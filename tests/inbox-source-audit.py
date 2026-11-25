"""Read-only acceptance check against durable source metadata after activation."""
import json
import math
import sqlite3
import sys
from pathlib import Path

connection = sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + "?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
connection.execute("BEGIN")
saved = connection.execute("SELECT value FROM kv WHERE key='inbox-slack-arrivals-since'").fetchone()
cutoff = float(saved[0]) if saved else None
rows = connection.execute("SELECT s.* FROM signals s JOIN inbox_arrivals a ON a.signal_id=s.id WHERE s.source='slack-inbox'").fetchall()
if rows:
    assert cutoff is not None and math.isfinite(cutoff) and cutoff > 0, "Source admission boundary is missing"
failures = {"sourceMismatch": 0, "historical": 0, "selfAuthored": 0, "untargeted": 0}
for item in rows:
    team, owner, channel = item["conversation"].split(":")
    direct = connection.execute("SELECT 1 FROM kv WHERE key=?", (f"inbox-dm:{team}:{channel}",)).fetchone()
    source = connection.execute("SELECT at,author FROM inbox_messages WHERE source=? AND conversation=? AND external_id=?", (item["source"], item["conversation"], item["external_id"])).fetchone()
    failures["sourceMismatch"] += not source or source["at"] != item["at"] or source["author"] != item["author"]
    failures["historical"] += item["at"] <= cutoff
    failures["selfAuthored"] += item["author"] == owner
    failures["untargeted"] += not direct and f"<@{owner}>" not in item["text"]
result = {"admittedSlackMessages": len(rows), "sourceContextMessages": connection.execute("SELECT count(*) FROM inbox_messages").fetchone()[0], "violations": failures}
print(json.dumps(result))
assert not any(failures.values()), "Inbox arrivals differ from retained source chronology or admission scope"
