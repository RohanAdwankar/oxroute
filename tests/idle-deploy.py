"""Exercise failed deployment recovery without touching shared services."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/when-idle.sh"


class DeploymentRecovery(unittest.TestCase):
    def test_failures_are_not_retried(self):
        for fail_restart in (False, True):
            with self.subTest(fail_restart=fail_restart), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                state, commands, release = [root / name for name in ("state", "commands", "release")]
                for path in (state, commands, release / "bin", release / "web/.next"):
                    path.mkdir(parents=True)
                daemon = release / "bin/oxrouted"
                daemon.write_bytes(b"fixture binary")
                daemon.chmod(0o755)
                (release / "web/.next/BUILD_ID").write_text("fixture")
                binary, web = root / "binary", root / "web"
                binary.symlink_to(daemon)
                web.symlink_to(release / "web")
                pending = state / "pending-deployment.json"
                pending.write_text(json.dumps({
                    "release": str(release), "repository": str(root),
                    "commit": "fixture", "version": "fixture",
                    "binarySha256": hashlib.sha256(daemon.read_bytes()).hexdigest(),
                    "agentId": "fixture", "tasks": [{"id": "task-fixture", "text": "Fixture"}],
                }))
                with sqlite3.connect(root / "database") as database:
                    database.execute("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)")
                script = SCRIPT.read_text()
                for before, after in [
                    ('binary=$HOME/.local/bin/oxrouted', f'binary={binary}'),
                    ('web=$HOME/.local/share/oxroute/web', f'web={web}'),
                    ('database=$HOME/.local/state/oxroute/oxroute.sqlite3', f'database={root}/database'),
                    ('sleep 2', 'sleep 0'),
                ]:
                    script = script.replace(before, after)
                (root / "script").write_text(script)
                mocks = {
                    "git": 'case "$*" in *rev-parse*) echo fixture;; esac',
                    "systemctl": '''
echo "$*" >> "$FIXTURE_ROOT/services"
if [[ "$1" == start ]]; then
  count=$(cat "$FIXTURE_ROOT/starts" 2>/dev/null || echo 0)
  count=$((count+1)); echo "$count" > "$FIXTURE_ROOT/starts"
  rm -f "$FIXTURE_ROOT/ready"
  if [[ "$count" == 2 && "$FAIL_RESTART" == 1 ]]; then exit 1; fi
fi
''',
                    "node": 'exit 1',
                    "curl": '''
case "$*" in
  *api/state*) echo '{"agents":[]}';;
  *api/health*) touch "$FIXTURE_ROOT/ready";;
  *api/version*) echo '{"version":"fixture"}';;
  *api/tasks/*) test -f "$FIXTURE_ROOT/ready" || exit 7
    echo updated >> "$FIXTURE_ROOT/task-updates";;
esac
''',
                }
                for name, body in mocks.items():
                    path = commands / name
                    path.write_text("#!/usr/bin/env bash\nset -e\n" + body + "\n")
                    path.chmod(0o755)
                env = dict(os.environ, PATH=str(commands) + ":" + os.environ["PATH"],
                           OXROUTE_DEPLOY_STATE=str(state), FIXTURE_ROOT=str(root),
                           FAIL_RESTART=str(int(fail_restart)))
                result = subprocess.run(["bash", str(root / "script")], env=env,
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertFalse(pending.exists(), "A failed release must leave the retry queue: " + result.stderr)
                self.assertTrue((state / "failed-deployment.json").exists())
                if not fail_restart:
                    self.assertTrue((root / "task-updates").exists(), result.stderr)
                calls = (root / "services").read_text()
                subprocess.run(["bash", str(root / "script")], env=env, check=True)
                self.assertEqual((root / "services").read_text(), calls,
                                 "The next timer tick must not restart services again")
                self.assertFalse(list(state.glob("deploy-backup.*")))


if __name__ == "__main__":
    unittest.main()
