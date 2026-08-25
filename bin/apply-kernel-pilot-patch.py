#!/usr/bin/env python3
"""
ompa kernel-pilot patcher (idempotent) — exposes each session's base tool
definitions on globalThis.__ompaKernelPilot[sessionId] so the kernel-pilot
plugin can hot-swap the ipython backend (stateless runner) while delegating
stateful calls to the real provisioner and RLM bridge.

Usage: apply-kernel-pilot-patch.py [--remove|--check]
"""
import os
import pathlib
import shutil
import sys

MARKER = '// [ompa] kernel-pilot v1'
ANCHOR = '        this._baseToolDefinitions = new Map(Object.entries(configuredBaseToolDefinitions).map(([name, tool]) => [name, tool]));'
INSERT = "        // [ompa] kernel-pilot v1: hot-swappable ipython backends — expose this\n        // session's base tool definitions so an extension can route stateless\n        // calls to a light runner while delegating stateful calls to the real\n        // provisioner + RLM bridge. Per-session keyed; replaced on rebuild.\n        globalThis.__ompaKernelPilot ??= {};\n        globalThis.__ompaKernelPilot[this.sessionId] = this._baseToolDefinitions;"
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
    if MARKER in src:
        print("patch already applied (marker present); nothing to do")
        return 0
    assert src.count(ANCHOR) == 1, "anchor not unique/missing"
    if not BACKUP.exists():
        shutil.copy2(TARGET, BACKUP)
        print("backup ->", BACKUP)
    src = src.replace(ANCHOR, ANCHOR + "\n" + INSERT, 1)
    tmp = TARGET.with_suffix(".js.tmp-ompa")
    tmp.write_text(src, encoding="utf-8")
    os.replace(tmp, TARGET)
    print("patched", TARGET)
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
    print("marker present:", MARKER in src)
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
