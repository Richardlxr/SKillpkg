# Project Skills and MCP Scope

This document is the working contract for project-scoped skills and MCP services in `skillpkg`.

## Source of Truth

Project-local skills live in:

```text
.agents/skills/<skill-name>/SKILL.md
```

`skillpkg` writes each project skill once to `.agents/skills`. Agents with different native project paths get compatibility links:

```text
.claude/skills -> .agents/skills
.cursor/skills -> .agents/skills
```

Generated project MCP config is local machine state and should stay out of git:

```text
.codex/config.toml
.mcp.json
.cursor/mcp.json
.agents/mcp_config.json
```

The reproducible team contract is `skm.mod` plus `skm.sum`.

When `skm config git auto` is active, `skillpkg` ignores downloaded or cache-linked project skills as `.agents/skills/<name>` and ignores native compatibility links as `.claude/skills` / `.cursor/skills`. Those compatibility paths are a stable cross-agent set, not based on which agents happen to be installed on the current machine, so tracked `.gitignore` files do not bounce between teammates. Project-local skills recorded as `./.agents/skills/<name>` remain trackable so teams can commit them.

## Skill Source Types

Remote Git skills are recorded in `skm.mod` as `skill <repo[#path]>` and locked in `skm.sum` by content hash. Project installs use the project scope and can be restored with `skm install`.

Project-local skills are recorded as `skill ./.agents/skills/<name>`. They are stored with `source_commit = local` and `install_mode = copy`. Commit these directories when teammates should receive the skill without downloading it from a remote source.

Traceable project symlinks are treated as dependencies. During `skm init`, if a symlinked skill can be matched to an existing managed source, `skillpkg` records the source URL in `skm.mod` and verifies the current content against `skm.sum`. If the hash differs, interactive init asks whether to accept the current copy. `skm init -y` warns and accepts the current copy. A non-TTY run without `-y` leaves the dependency in `skm.mod` but skips updating `skm.sum` from the mismatched local content.

Untraceable project symlinks are materialized into `.agents/skills/<name>` and treated as project-local skills. This keeps project setup reproducible on machines that cannot recreate the original symlink target.

## Scope Rules

Global and project scopes can coexist with the same skill name. `skillpkg` keeps both records and reports the coexistence in `skm list`, `skm info`, and `skm status`. It does not remove the opposite scope during install or sync; use explicit commands when you want to move or delete a scope.

`skm promote skill <name>` copies a project skill to global scope by default and keeps the project skill. For project-local skills, the new global record points at the global copy with a `file://` source and `source_commit = local`.

`skm promote skill <name> --remove-project` moves the skill when targeting all agents: it removes the project native install, project DB row, `skm.mod` requirement, and project `skm.sum` entry after the global copy succeeds.

`skm demote skill <name>` moves a global skill into the current project. Remote skills keep their remote source in `skm.mod`; local, linked, or tracked global skills are copied into `.agents/skills/<name>` and recorded as project-local dependencies. Demoting to all agents removes the global DB and global `skm.sum` entry; demoting to a single agent keeps the remaining global assignment.

`skm update` and `skm outdated` only operate on remote Git sources. Local, linked, and tracked skills are skipped because there is no upstream commit to compare.

`skm verify` checks every non-development install against the matching `skm.sum` entry. `symlink-dev` entries are skipped by design.

## MCP Rules

Project MCP services are recorded as `mcp <source>` in `skm.mod` and as `mcp:<source>` entries in `skm.sum`.

`skm init` adopts project MCP definitions found in supported native config files and writes them into `skm.mod` / `skm.sum`:

```text
.codex/config.toml
.mcp.json
.cursor/mcp.json
.agents/mcp_config.json
```

`skm promote mcp <name>` and `skm demote mcp <name>` move MCP assignments between scopes. Project MCP scope is only applied to agents with project MCP support: Codex, Claude Code, Cursor, and Antigravity CLI.

For Git-sourced MCP servers, `skillpkg` runs build commands without a shell where possible. Node MCP installs use `npm install --ignore-scripts`, reuse an existing JavaScript entry point before running package lifecycle scripts, and preflight common Unix-only script commands on Windows. Go MCP builds write `mcp-server.exe` on Windows and `mcp-server` elsewhere. If a source package genuinely requires a Unix-only build script, `skillpkg` reports the incompatible script and skips that MCP instead of aborting the whole `skm install` run.

Skill setup hooks follow the same rule after approval. Remote `setup_command` and setup files are opt-in: interactive installs ask before running them, non-interactive installs skip them, and trusted automation can pass `--run-scripts` or `-y`. On Windows, project setup files are resolved in this order: `setup.ps1`, `setup.cmd`, `setup.bat`, then `setup.sh` when Bash is available. Built-in setup files are executed without shell string parsing where possible, and Windows `setup_command` values are preflighted for common Unix-only commands before running.
