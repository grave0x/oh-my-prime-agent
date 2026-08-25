#!/usr/bin/env python3
"""
ompa kernel-pilot patcher (idempotent) - makes hot-swappable ipython backends
possible by (a) setting globalThis.__ompaKernelPilotLive at module import and
(b) exposing each session's base tool definitions at
globalThis.__ompaKernelPilot[sessionId] inside _buildRuntime. The kernel-pilot
plugin registers its ipython router only when the live marker is present, so a
reload in an old process (cached module) stays additive and never breaks the
built-in ipython tool.

Usage: apply-kernel-pilot-patch.py [--remove|--check]
"""
import os
import pathlib
import shutil
import sys

MARKER_A = '// [ompa] kernel-pilot live-marker'
MARKER_B = '// [ompa] kernel-pilot v1'
ANCHOR_A = 'export class AgentSession {'
INSERT_A = '// [ompa] kernel-pilot live-marker: set once at module import. Extensions load\n// BEFORE _buildRuntime runs (resourceLoader.reload() precedes it), so this flag\n// is how a plugin tells a patched process from an old cached-module process.\nglobalThis.__ompaKernelPilotLive = true;\n\nexport class AgentSession {'
ANCHOR_B = '        this._baseToolDefinitions = new Map(Object.entries(configuredBaseToolDefinitions).map(([name, tool]) => [name, tool]));'
INSERT_B = "        // [ompa] kernel-pilot v1: hot-swappable ipython backends — expose this\n        // session's base tool definitions so an extension can route stateless\n        // calls to a light runner while delegating stateful calls to the real\n        // provisioner + RLM bridge. Per-session keyed; replaced on rebuild.\n        globalThis.__ompaKernelPilot ??= {};\n        globalThis.__ompaKernelPilot[this.sessionId] = this._baseToolDefinitions;"
DEFAULT_TARGET = pathlib.Path.home() / ".npm-global" / "lib" / "node_modules" / "prime-agent" / "dist" / "core" / "agent-session.js"
TARGET = pathlib.Path(os.environ.get("OMPA_KERNEL_PILOT_JS", str(DEFAULT_TARGET)))
BACKUP = TARGET.with_suffix(".js.orig-ompa")


def read():
    if not TARGET.exists():
        print("target not found:", TARGET)
        sys.exit(1)
    return TARGET.read_text(encoding="utf-8")


def apply():
    src = read()
    changed = 0
    if MARKER_A not in src:
        assert src.count(ANCHOR_A) == 1, "anchor A not unique/missing"
        src = src.replace(ANCHOR_A, INSERT_A, 1)
        changed += 1
    if MARKER_B not in src:
        assert src.count(ANCHOR_B) == 1, "anchor B not unique/missing"
        src = src.replace(ANCHOR_B, ANCHOR_B + "\n" + INSERT_B, 1)
        changed += 1
    if changed == 0:
        print("patch already applied (both markers present); nothing to do")
        return 0
    if not BACKUP.exists():
        shutil.copy2(TARGET, BACKUP)
        print("backup ->", BACKUP)
    tmp = TARGET.with_suffix(".js.tmp-ompa")
    tmp.write_text(src, encoding="utf-8")
    os.replace(tmp, TARGET)
    print("patched", TARGET, "(insertions:", str(changed) + ")")
    return 0


def remove():
    if not BACKUP.exists():
        print("no original backup to restore")
        return 1
    shutil.copy2(BACKUP, TARGET)
    print("restored", TARGET, "from", BACKUP)
    return 0


def check():
    src = read()
    print("live-marker present:", MARKER_A in src)
    print("exposure present:", MARKER_B in src)
    print("backup exists:", BACKUP.exists())
    print("target:", TARGET)
    print("target bytes:", TARGET.stat().st_size)
    return 0


def main():
    if "--remove" in sys.argv:
        sys.exit(remove())
    if "--check" in sys.argv:
        sys.exit(check())
    sys.exit(apply())


if __name__ == "__main__":
    main()
