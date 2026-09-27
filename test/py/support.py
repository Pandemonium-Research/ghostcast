"""Set up a throwaway project for the post-production modules, which read project.json on import.

Import this before any module from py/. It writes test/vectors/config.json as the project's
project.json in a temporary directory, points GHOSTCAST_PROJECT at it, and puts py/ on the path.
"""
import atexit
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
VECTORS = REPO / "test" / "vectors"

_project = Path(tempfile.mkdtemp(prefix="ghostcast-test-"))
atexit.register(shutil.rmtree, _project, ignore_errors=True)
_config = json.loads((VECTORS / "config.json").read_text(encoding="utf-8"))
_config.pop("about", None)
(_project / "project.json").write_text(json.dumps(_config), encoding="utf-8")
os.environ["GHOSTCAST_PROJECT"] = str(_project)
sys.path.insert(0, str(REPO / "py"))


def vectors(name):
    return json.loads((VECTORS / f"{name}.json").read_text(encoding="utf-8"))


def assert_close(case, got, want, places=6):
    """Compare numbers, or sequences of numbers, to `places` decimals."""
    if isinstance(want, (list, tuple)):
        case.assertEqual(len(got), len(want), f"{got} vs {want}")
        for g, w in zip(got, want):
            assert_close(case, g, w, places)
    else:
        case.assertAlmostEqual(float(got), float(want), places=places, msg=f"{got} vs {want}")
