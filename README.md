# skillpkg

> A local-first manager for AI Agent Skills and MCP services. Discover skills already on your machine, bring them under one manager, and sync them into Codex, Claude Code, Cursor, Antigravity, and Antigravity CLI.

English | [简体中文](README_zh.md)

## Project Status

`skillpkg` is currently in public testing. The npm package has **not** been published yet, so please install it from source for now.

The package-management model is still being refined. Commands, defaults, and edge-case behavior may change while the project stabilizes. Bug reports, compatibility notes, and feature ideas are very welcome through [GitHub Issues](https://github.com/Richardlxr/SKillpkg/issues).

## What It Does

- Finds existing local Agent Skills across supported tools.
- Adopts unmanaged skills into a single `~/.skillpkg` store.
- Lets you choose which skills and MCP services are injected into each agent.
- Supports both global machine-level setup and project-scoped reproducible setup.
- Tracks project dependencies with `skm.mod` and integrity data with `skm.sum`.

## Installation

Install from source until the npm package is published:

```bash
git clone https://github.com/Richardlxr/SKillpkg.git skillpkg
cd skillpkg
npm install
npm run build
npm link
```

Confirm the command is available:

```bash
skm --version
skm agents list
```

## First Run

The most important first workflow is not installing a new skill. It is adopting the skills already scattered across your local agent directories.

```bash
# 1. See which agents are detected on this machine
skm agents list

# 2. Scan native agent skill directories and show unmanaged skills
skm list

# 3. Adopt all unmanaged local skills into skm
skm track

# 4. Pick which skills/MCPs should be injected into which agents
skm assign

# 5. Verify scope, integrity, and agent injection state
skm status
```

You can run that as a post-install guided flow:

```bash
skm agents list && skm list && skm track && skm assign
```

This does three things:

- **Discovers existing skills on the device** by scanning every detected agent's global/project skills directory.
- **Adopts them into skm management** by copying unmanaged skills into `~/.skillpkg/skills/<scope>/<name>` and removing the original native agent directories so they do not keep drifting.
- **Injects them into selected agents** through `skm assign`, which applies the selected targets immediately.

> Note: `skm track` only adopts skills; it does not automatically inject them into any agent. Run `skm list` first to review `untracked` skills, then use `skm assign` to choose target agents.

## Common Workflows

### Adopt Existing Skills, Then Send Them Only to Codex and Claude Code

```bash
skm list
skm track
skm assign
```

In `skm assign`, choose a skill and check `Codex (OpenAI)` plus `Claude Code`. skm immediately injects the skill into checked agents and removes it from unchecked agents.

### Install a New Skill Directly Into a Target Agent

```bash
# GitHub shorthand
skm install owner/repo --agent codex

# Any Git URL
skm install https://github.com/team/workflow-skill.git --agent claude-code

# Monorepo subdirectory
skm install https://github.com/team/workflow-skill#skills/reviewer --agent cursor

# Select all skills found in the repo
skm install owner/repo -y --agent all
```

When a repository contains multiple skills, interactive install first asks for an optional name/path keyword. Leave it blank to show every skill, or type a keyword such as `reviewer` to narrow the checkbox list before selecting.

Supported agent ids:

```text
antigravity
antigravity-cli
claude-code
codex
cursor
```

### Inject Project-Scoped Skills

Inside a Git repository or a directory containing `skm.mod`, `skm install <source>` defaults to **project scope** and saves Git sources to `skm.mod` / `skm.sum` so teammates can reproduce the project setup. Project skills are written once to `.agents/skills/`; Claude Code and Cursor receive compatibility symlinks at `.claude/skills/` and `.cursor/skills/`.

Project-local skills that already live under `.agents/skills/<name>` are first-class project dependencies. `skm init` records them as `skill ./.agents/skills/<name>` and locks their content in `skm.sum`, so they can be committed and shared without a download source. See [Project Skills and MCP Scope](docs/project-scope.md) for the detailed scope rules.

```bash
# Inject only into this project's Codex config
skm install owner/repo --scope project --agent codex

# Temporary local project injection without saving to skm.mod
skm install owner/repo --scope project --no-save

# Uninstall a current-project skill and remove its skm.mod entry
skm uninstall reviewer

# In a project directory, uninstall a global skill explicitly
skm uninstall reviewer --scope global

# Restore skills/MCPs declared in skm.mod
skm install

# Re-apply project-managed state to one agent
skm agents sync --scope project --agent claude-code
```

### Interactive Selection

When a command can select multiple items, `skm` uses checkbox prompts: press `Space` to toggle items and `Enter` to confirm. Multi-select prompts include an `All` option when more than one item is visible. Large choice sets, such as multi-skill repositories, MCP monorepos, and assignable skills/MCP services, first ask for a search term so you can narrow by name, path, source, or scope before selecting.

### Choose Git Tracking for Project Skills

Project-scoped installs can be local-only or committed for a team. Configure the default once:

```bash
# Add a skillpkg-managed .gitignore block for installed project skill paths and MCP config
skm config git auto

# Leave project skills trackable by git while still ignoring generated MCP config
skm config git track

# Ask during project installs
skm config git ask
```

When gitignore mode is active, skm manages a `.gitignore` block like this. Skill entries are per installed skill under `.agents/skills`, not the whole skills directory. Native compatibility paths are written as a stable cross-agent set, even if a given teammate does not have that agent installed locally. Generated project MCP config stays ignored even when project skills are trackable because it can contain machine-local paths and secrets:

```gitignore
# === skillpkg managed (auto-generated, do not edit manually) ===
.agents/skills/reviewer
.claude/skills
.cursor/skills
.mcp.json
.codex/config.toml
.cursor/mcp.json
.agents/mcp_config.json
# === end skillpkg managed ===
```

### Re-Sync Managed Skills to Specific Agents

```bash
# Sync global managed skills/MCPs to every detected agent
skm agents sync --scope global --agent all

# Sync only to Codex
skm agents sync --scope global --agent codex

# Interactively adjust target agents for each skill/MCP
skm assign
```

## Core Concepts

### Managed vs. Untracked

- **Managed** means the skill is recorded in skm's database. It can be controlled by `assign`, `sync`, `status`, `verify`, and `update`.
- **Untracked** means the skill exists in an agent's native skills directory but has not yet been adopted by skm. `skm list` shows it, and `skm track` adopts it.

### Global Scope vs. Project Scope

- **Global scope** targets the whole machine and writes to user-level agent skills/MCP configuration.
- **Project scope** targets the current repository and writes to local agent directories or project MCP configuration.
- `skm install <source>` defaults to project scope inside a Git repository or a directory with `skm.mod`; outside a project it defaults to global scope.
- If a project skill has the same name as a global skill, `skillpkg` keeps both scopes and labels the coexistence in `list`, `info`, and `status`. Use explicit promote, demote, or uninstall commands when you want to move or remove one scope.

### Promote and Demote Scope

```bash
# Copy a current-project skill into global scope and keep the project copy
skm promote skill reviewer

# Move a project skill to global scope
skm promote skill reviewer --remove-project

# Move a global skill into the current project
skm demote skill reviewer

# Move project/global MCP assignments between scopes
skm promote mcp playwright
skm demote mcp playwright
```

For skills, promote copies by default because a good local project skill may also be useful globally. Demote records remote skills by source, but local or tracked global skills are copied into `.agents/skills/<name>` and saved as project-local dependencies. MCP promote/demote moves agent assignments to avoid duplicate server definitions.

### Injection Model

`skillpkg` separates adoption/installation from agent injection:

- `skm install <source> --agent codex` installs a new skill and injects it immediately.
- `skm track` adopts skills that already exist on the machine.
- `skm assign` interactively chooses which agents should receive each skill/MCP.
- `skm agents sync` re-applies managed state to a target scope and agent.
- `skm status` shows each skill's scope, integrity, and agent injection state.

## Install Source Formats

`skm install` accepts GitHub shorthand, host-qualified paths, full HTTPS URLs, scp-style SSH URLs, and local directories:

```bash
skm install owner/repo
skm install github.com/owner/repo
skm install gitlab.com/example-org/workflow-skill
skm install https://gitlab.com/example-org/workflow-skill.git
skm install git@gitlab.com:example-org/workflow-skill.git
skm install ../local-skill
```

Versions, refs, commits, and monorepo subdirectories:

```bash
skm install owner/repo@v1.0.0
skm install owner/repo#skills/reviewer
skm install https://github.com/team/workflow-skill#skills/reviewer@v1.0.0
skm install https://gitlab.com/example-org/workflow-skill.git#v1.0.0
```

When a repository contains multiple `SKILL.md` files, `skm install` opens a searchable terminal picker. Type part of a skill name or path to filter the list, leave the search blank to show everything, or choose `Select all ... shown` to install every currently visible match.

## Search, Preview, and Security Review

```bash
# Search GitHub skills
skm search "web scraping"
skm search "web scraping" --json

# Preview repo contents and potential risks before installing
skm preview owner/repo

# Show installed and discovered skills
skm list
skm list --json
```

## Local Development

```bash
# Link the current SKILL.md directory for live development
skm link

# Link a specific directory
skm link ../my-skill-dev

# Link into the current project scope
skm link ../my-skill-dev --scope project --agent codex

# Use a copy instead of a live symlink
skm link ../my-skill-dev --mode copy
```

Install modes:

- `copy`: copy the skill directory.
- `symlink-cache`: default project mode; link to the skm cache.
- `symlink-dev`: default `skm link` mode for live development.

## MCP Service Management

```bash
# List MCPs from both skm management and native agent configs
skm mcp list

# Check MCP availability
skm mcp status

# Auto-build and deploy an MCP from a Git source
skm mcp add https://github.com/modelcontextprotocol/servers#src/memory --agent codex

# Install a project-scoped MCP
skm mcp add https://github.com/jgraph/drawio-mcp#mcp-tool-server --scope project --agent codex

# If a Git MCP repository contains multiple server projects, search and select one or many
skm mcp add https://github.com/team/mcp-servers --scope project

# Interactively choose which agents receive an MCP
skm assign

# Re-apply managed MCP state
skm mcp sync --scope global --agent all
```

MCPs are recorded with `scope`, `project_path`, and target agents, so they can be promoted, demoted, synced, or reassigned later.

Project-scoped MCP installs are saved to `skm.mod` by default and locked in `skm.sum` as `mcp:<source>` entries. Agent MCP config files such as `.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`, and `.agents/mcp_config.json` are generated locally and should not be committed.

For MCP monorepos, the installer uses the same searchable picker as skill installation and includes `Select all ... shown` so you can install every visible MCP project in one pass. Each selected MCP is tracked separately with its own source fragment.

## `SKILL.md` and `skm.mod`

### `SKILL.md`

`SKILL.md` is the Agent Skills entrypoint. Metadata lives in YAML frontmatter:

```yaml
---
name: my-skill
version: "1.0.0"
description: My skill
mcp:
  - wps-office
setup_command: "python scripts/setup.py"
---

# My Skill

Instructions the agent reads.
```

### `skm.mod`

`skm.mod` declares project dependencies in a Go modules-style format:

```text
module my-project-skills

skill github.com/owner/helpers v1.0.0
skill https://github.com/team/workflow-skill#skills/reviewer

mcp @playwright/mcp
mcp https://github.com/jgraph/drawio-mcp#mcp-tool-server

replace github.com/original/skill => github.com/my-fork/skill
replace github.com/remote/skill => ../local-dev-copy
```

Running `skm install` without arguments reads the current directory's `skm.mod` and installs into project scope by default.

## Integrity, Updates, and Maintenance

`skm outdated` and `skm update` compare remote Git sources only. Project-local, linked, and tracked skills are verified by hash but skipped for update because they do not have an upstream commit to pull.

```bash
# Check for updates
skm outdated

# Update one or all skills
skm update
skm update my-skill

# Verify SHA-256 integrity
skm verify

# Clean orphaned lockfile entries
skm tidy

# Migrate legacy project skill directories into .agents/skills
skm tidy --unify

# Show dependency tree
skm tree

# Clean global Git cache
skm cache clean
```

Global integrity is recorded in `~/.skillpkg/skm.sum`; project integrity is recorded in `<project>/skm.sum`. Project skill and MCP sources are saved to `<project>/skm.mod` by default, and project removals remove them from `skm.mod` by default; use `--no-save` for temporary local project injection or removal. Use `skm config git auto|track|ask` to choose whether project skill outputs are gitignored, tracked, or decided per install; generated project MCP config stays gitignored.

## Supported Agents

On Windows, `~` resolves to `%USERPROFILE%`.

Google is transitioning Gemini CLI users to Antigravity CLI, so skm no longer supports `gemini-cli`. Use `antigravity-cli` for Google CLI workflows.

| Agent | Agent id | Skills directory | MCP config |
|---|---|---|---|
| Antigravity 2.0 / Editor | `antigravity` | `~/.gemini/antigravity/skills/`, `.agents/skills/` | `~/.gemini/antigravity/mcp_config.json` |
| Antigravity CLI | `antigravity-cli` | `~/.gemini/antigravity-cli/skills/`, `.agents/skills/` | `~/.gemini/antigravity-cli/mcp_config.json`, `.agents/mcp_config.json` |
| Claude Code | `claude-code` | `~/.claude/skills/`, `.agents/skills/` + `.claude/skills/` symlink | `~/.claude.json`, `.mcp.json` |
| Codex (OpenAI) | `codex` | `$CODEX_HOME/skills/` or `~/.codex/skills/` (also scans legacy `~/.agents/skills/`), `.agents/skills/` | `$CODEX_HOME/config.toml` or `~/.codex/config.toml`, `.codex/config.toml` |
| Cursor | `cursor` | `~/.cursor/skills/`, `.agents/skills/` + `.cursor/skills/` symlink | `~/.cursor/mcp.json`, `.cursor/mcp.json` |

### Official Path References

The table above tracks each agent's native documentation where public docs are available:

- Codex: [Skills in Codex](https://developers.openai.com/codex/skills)
- Claude Code: [Agent Skills](https://docs.claude.com/en/docs/claude-code/skills) and [MCP](https://docs.claude.com/en/docs/claude-code/mcp)
- Cursor: [Skills](https://cursor.com/docs/context/skills) and [MCP](https://docs.cursor.com/en/context/mcp)
- Google transition: [Transitioning Gemini CLI to Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) and Antigravity CLI [migration guide](https://antigravity.google/docs/gcli-migration)
- Antigravity: [Skills](https://antigravity.google/docs/skills), [MCP](https://antigravity.google/docs/mcp), and [CLI features](https://antigravity.google/docs/cli-features)

## Command Reference

```text
skm agents list        Detect local agents
skm list               List managed and untracked skills
skm track [name]       Adopt unmanaged native skills into skm without assigning agents
skm assign             Assign skills/MCPs to selected agents
skm status             Show scope, integrity, and agent injection state

skm install <source>   Install a skill from Git or a local path (--no-save for local-only project use)
skm install            Install skills/MCPs from skm.mod into project scope
skm uninstall <name>   Remove a skill (current-project skill wins by default)
skm info <name>        Show detailed information for one skill
skm update [name]      Update one or all skills
skm outdated           Check whether skills are behind remote

skm search <query>     Search GitHub skills
skm preview <source>   Preview and security review before install
skm init [name]        Initialize SKILL.md and skm.mod
skm link [path]        Link a local skill for development

skm agents sync        Re-sync managed skills and MCPs
skm agents config <n>  Show detailed config for one agent

skm mcp add <name>     Install or configure an MCP
skm mcp rm <name>      Remove an MCP
skm mcp sync           Re-sync managed MCPs
skm mcp list           List MCPs
skm mcp status         Check MCP availability

skm promote skill <n>  Promote a project skill to global scope
skm demote skill <n>   Demote a global skill into the current project
skm promote mcp <n>    Promote a project MCP to global scope
skm demote mcp <n>     Demote a global MCP into the current project

skm tree               Show dependency tree
skm verify             Verify integrity
skm tidy [--unify]     Clean lockfiles and optionally unify project skill dirs
skm history <name>     Show replacement history
skm cache clean        Clean cache
skm config git <mode>  Set git handling: auto, track, or ask
```

## Environment Variables

| Variable | Description |
|---|---|
| `SKILLPKG_HOME_DIR` | Override the home directory used for agent path discovery, mainly for tests or isolated environments |
| `SKILLPKG_DATA_DIR` | Custom skm data directory, default `~/.skillpkg` |
| `SKILLPKG_DEBUG` | Set to `1` for verbose logs |

## License

MIT
