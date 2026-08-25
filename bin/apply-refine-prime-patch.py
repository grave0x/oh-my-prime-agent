#!/usr/bin/env python3
"""
ompa refine-prime patcher (idempotent) — gives Prime Agent's /refine an
audited, opt-in `prime` edit kind.
"""
import os
import pathlib
import shutil
import sys

MARKER = '// [ompa] refine-prime support v1'
TARGET = pathlib.Path.home() / ".npm-global" / "lib" / "node_modules" / "prime-agent" / "dist" / "core" / "refinement" / "refinement.js"
BACKUP = TARGET.with_suffix(".js.orig-ompa")

OLD_IMPORT = 'import { join } from "node:path";'
NEW_IMPORT = 'import { copyFileSync } from "node:fs";\nimport { dirname, join, resolve, sep } from "node:path";\nimport { homedir } from "node:os";'

OLD_KINDS = '    if (!["prompt", "memory", "skill", "subagent"].includes(edit.kind)) {'
NEW_KINDS = '    if (!["prompt", "memory", "skill", "subagent", "prime"].includes(edit.kind)) {'

OLD_COMPUTED = '        const computedId = edit.id ?? (edit.action === "create" ? slug(edit.title ?? edit.kind, edit.kind) : undefined);'
NEW_COMPUTED = '        const computedId = edit.id ?? (edit.action === "create" || edit.kind === "prime" ? slug(edit.title ?? edit.path ?? edit.kind, edit.kind) : undefined);'

OLD_RECORDS = '        const records = state.entries[edit.kind];'
NEW_RECORDS = '        if (edit.kind === "prime") {\n            appliedEdits.push(applyPrimeEdit(edit, id));\n            continue;\n        }\n        const records = state.entries[edit.kind];'

OLD_SUBAGENT_BULLET = '- subagent: reusable delegation specs, including purpose, instructions, and when to invoke. Include the RLM-native call form: compose a concise task prompt and spawn with \\`handle = await rlm("sub-task")\\`; admission returns immediately with \\`rlm_child_id\\`, \\`name\\`, \\`session_dir\\`, and \\`model\\`, never the child\'s answer. Results arrive only through explicit \\`agent_message\\` replies or files; children reply with \\`await agent_message.send(message, receiver_role="parent")\\`. Use \\`await rlm.list_subagents()\\` to recover direct child handles and \\`await agent_message.send(..., receiver_role="child", receiver_name=handle.name)\\` for follow-ups. Do not invent wrappers like \\`run_subagent(...)\\`.\n'
NEW_SUBAGENT_BULLET = '- subagent: reusable delegation specs, including purpose, instructions, and when to invoke. Include the RLM-native call form: compose a concise task prompt and spawn with \\`handle = await rlm("sub-task")\\`; admission returns immediately with \\`rlm_child_id\\`, \\`name\\`, \\`session_dir\\`, and \\`model\\`, never the child\'s answer. Results arrive only through explicit \\`agent_message\\` replies or files; children reply with \\`await agent_message.send(message, receiver_role="parent")\\`. Use \\`await rlm.list_subagents()\\` to recover direct child handles and \\`await agent_message.send(..., receiver_role="child", receiver_name=handle.name)\\` for follow-ups. Do not invent wrappers like \\`run_subagent(...)\\`.\n- prime: audited write access to the prime-agent user surface (ompr.toml, resource-policy.json, extensions, souls, prompts, skills, kitty/hypr theme config, ompa plugins/themes). Only available when the gate file ~/.prime/agent/refine-prime-enabled exists. Use kind "prime", action "update" (write) or "delete", a path under an allowlisted root, content for update, and metadata.operation "write" or "delete". Never target ~/.npm-global/lib/node_modules/prime-agent or the harness state file. Each applied prime edit is atomic, backed up, and journaled.\n'

OLD_NEVER = 'Never edit source files directly. Output'
NEW_NEVER = 'Never edit files outside the allowlisted prime surface directly. Output'

PRIME_BLOCK = '\n// ---- // [ompa] refine-prime support v1 --------------------\nconst OMPA_PRIME_GATE = join(homedir(), ".prime", "agent", "refine-prime-enabled");\nconst OMPA_PRIME_JOURNAL = join(homedir(), ".local", "state", "ompa", "refine-prime.jsonl");\nfunction ompaPrimeAllowRoots() {\n    const h = homedir();\n    return [\n        join(h, ".prime", "oh-my-prime-agent"),\n        join(h, ".prime", "agent", "extensions"),\n        join(h, ".prime", "agent", "souls"),\n        join(h, ".prime", "agent", "prompts"),\n        join(h, ".agents", "skills"),\n        join(h, ".config", "kitty"),\n        join(h, ".config", "hypr"),\n        join(h, ".prime", "agent", "resource-policy.json"),\n    ];\n}\nfunction ompaPrimeDeny() {\n    const h = homedir();\n    return [\n        join(h, ".npm-global", "lib", "node_modules", "prime-agent"),\n        join(h, ".prime", "agent", "harness"),\n    ];\n}\nfunction ompaPrimeAllowed(path) {\n    const target = resolve(path);\n    const normalized = target.endsWith(sep) ? target.slice(0, -sep.length) : target;\n    for (const deny of ompaPrimeDeny()) {\n        if (normalized === deny || normalized.startsWith(deny + sep)) {\n            return { allowed: false, reason: `path is deny-listed (${deny})` };\n        }\n    }\n    for (const root of ompaPrimeAllowRoots()) {\n        if (normalized === root || normalized.startsWith(root + sep)) {\n            return { allowed: true, path: normalized };\n        }\n    }\n    return { allowed: false, reason: `path is outside the ompa prime allowlist (${normalized})` };\n}\nfunction ompaPrimeJournal(entry) {\n    try {\n        mkdirSync(dirname(OMPA_PRIME_JOURNAL), { recursive: true });\n        appendFileSync(OMPA_PRIME_JOURNAL, JSON.stringify(entry) + "\\n", "utf8");\n    } catch { /* journaling must never break a refinement */ }\n}\nfunction ompaPrimeBackup(path) {\n    try {\n        const bak = `${path}.bak-refine`;\n        if (existsSync(path)) {\n            copyFileSync(path, bak);\n            return bak;\n        }\n    } catch { /* backup is best-effort */ }\n    return undefined;\n}\nfunction validatePrimeEdit(edit, _computedId) {\n    const op = edit.metadata?.operation ?? (edit.action === "delete" ? "delete" : "write");\n    if (!["write", "delete"].includes(op)) {\n        return `prime operation ${String(op)} is not supported`;\n    }\n    if (edit.action === "delete" && op !== "delete") {\n        return "prime delete action requires metadata.operation delete";\n    }\n    if (!edit.path || typeof edit.path !== "string") {\n        return "prime edit requires path";\n    }\n    const check = ompaPrimeAllowed(edit.path);\n    if (!check.allowed) {\n        return check.reason;\n    }\n    if (op === "write" && typeof edit.content !== "string") {\n        return "prime write requires string content";\n    }\n    return undefined;\n}\nfunction applyPrimeEdit(edit, id) {\n    if (!existsSync(OMPA_PRIME_GATE)) {\n        return { ...edit, id, applied: false, error: `prime modifications are disabled (missing ${OMPA_PRIME_GATE}); enable with: ompa refine-prime enable` };\n    }\n    const check = ompaPrimeAllowed(edit.path ?? "");\n    if (!check.allowed) {\n        return { ...edit, id, applied: false, error: check.reason };\n    }\n    const op = edit.metadata?.operation ?? (edit.action === "delete" ? "delete" : "write");\n    const path = check.path;\n    try {\n        const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;\n        const backup = before !== undefined ? ompaPrimeBackup(path) : undefined;\n        if (op === "delete") {\n            if (!existsSync(path)) {\n                return { ...edit, id, applied: false, error: "prime path not found" };\n            }\n            unlinkSync(path);\n        } else {\n            mkdirSync(dirname(path), { recursive: true });\n            const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;\n            writeFileSync(tmp, edit.content ?? "", "utf8");\n            renameSync(tmp, path);\n        }\n        const after = existsSync(path) ? readFileSync(path, "utf8") : undefined;\n        ompaPrimeJournal({\n            ts: new Date().toISOString(),\n            id,\n            operation: op,\n            path,\n            backup,\n            beforeBytes: before !== undefined ? before.length : undefined,\n            afterBytes: after !== undefined ? after.length : undefined,\n            reason: edit.reason ?? "",\n        });\n        return { ...edit, id, applied: true, before: { path }, after: { path, operation: op } };\n    } catch (error) {\n        return { ...edit, id, applied: false, error: error instanceof Error ? error.message : String(error) };\n    }\n}\n// ---- end // [ompa] refine-prime support v1 --------------------\n'


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
    if not BACKUP.exists():
        shutil.copy2(TARGET, BACKUP)
        print("backup ->", BACKUP)
    anchors = [OLD_IMPORT, OLD_KINDS, OLD_COMPUTED, OLD_RECORDS, OLD_SUBAGENT_BULLET, OLD_NEVER]
    for a in anchors:
        assert src.count(a) == 1, "anchor not unique/missing: " + a[:60]

    src = src.replace(OLD_IMPORT, NEW_IMPORT)
    src = src.replace(OLD_KINDS, NEW_KINDS)
    src = src.replace(OLD_COMPUTED, NEW_COMPUTED)
    src = src.replace(OLD_RECORDS, NEW_RECORDS)
    src = src.replace(OLD_SUBAGENT_BULLET, NEW_SUBAGENT_BULLET)
    src = src.replace(OLD_NEVER, NEW_NEVER)

    header_anchor = "function validateEdit(edit, computedId) {"
    assert src.count(header_anchor) == 1
    src = src.replace(header_anchor, PRIME_BLOCK + "\n" + header_anchor)

    branch_anchor = '    if (edit.kind === "prompt" && (edit.id === "base_system_prompt" || computedId === "base_system_prompt")) {'
    assert src.count(branch_anchor) == 1
    prime_branch = '    if (edit.kind === "prime") {\n        return validatePrimeEdit(edit, computedId);\n    }\n'
    src = src.replace(branch_anchor, prime_branch + branch_anchor)

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
