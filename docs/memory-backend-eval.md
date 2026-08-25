# Memory backend eval — M2 decision

Context: souls vault needs durable memory, injected per turn, local-first,
thin. SPEC.md deferred the backend choice; this closes it.

## Candidates

| Backend | Fit for souls? | Why / why not |
|---------|---------------|---------------|
| **own (JSONL vault)** — current impl | ✅ | ~200 LOC, zero deps, file-sync native, full control of injection format. Meets every requirement today. |
| **mem0ai/mem0** (63k★) | ⚠️ | Great search/recall but adds a vector DB + API surface. Overkill for a per-soul fact file; becomes a second system to install, tune, and keep alive. |
| **MemPalace/mempalace** (58k★) | ⚠️ | Benchmarked, but ChromaDB dependency + server-ish model. Same objection as mem0. |
| **DeusData/codebase-memory-mcp** (40k★) | ❌ | Code intelligence (AST/Cypher), not agent memory. Different problem. |

## Requirement check (own vault)

- durable across sessions ✅ (file on disk)
- injected per turn ✅ (before_agent_start)
- tiny + no deps ✅ (node:fs only)
- queryable ✅ (/recall, keyword scoring)
- cap/rotation ✅ (500 facts)
- sync-friendly ✅ (JSONL append; git/rsync-safe)

## Decision

**Keep own (JSONL) as the vault.** Revisit ONLY if a real product requirement
appears (e.g. semantic recall over 10k+ facts, or cross-soul shared memory)
— at that point adopt mem0 as an MCP server behind the same Fact interface,
so the swap is contained.

## Migration path if revisited

Fact interface is the seam: `remember/recall/forget` already abstract the
store. Point them at an MCP-backed adapter; vault file stays as cache.

## Non-goals (refused)

- No vector DB in the default install (breaks thinness, SPEC §will-NOT).
- No server daemon for memory (sitter mode is the only daemon, M3).
- No automatic cross-soul memory sharing (privacy by default; rooms in
  global-chat are the opt-in channel).
