---
name: start
description: Use QFactory to find, understand, adapt or run a workflow for the user’s task. Retrieves the current instructions from its read-only MCP.
---

Call the QFactory MCP `instructions` tool at `https://qfactory.io/api/mcp` with mode `start`, step `prepare`, your actual agent and operating system, and `installedCore: null` when unknown. Read and follow the returned current instructions before recommending or installing a workflow.

If this session cannot call MCP, read `https://qfactory.io/qfactory-skill.md` and `https://qfactory.io/llms.txt` as the documented HTTP fallback. Follow the same revision and catalog verification rules. State which route actually worked; do not claim an MCP connection from an HTTP fetch.
