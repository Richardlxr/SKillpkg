# skillpkg

> 本地优先的 AI Agent Skills 与 MCP 服务管理器：扫描本机已有 skills，纳入统一管理，再同步注入到 Codex、Claude Code、Cursor、Antigravity 和 Antigravity CLI。

[English](README.md) | 简体中文

## 项目状态

`skillpkg` 目前处于公开测试阶段，**尚未发布到 npm**。在 npm 包正式发布前，请先通过源码安装和本地链接使用。

当前包管理模型仍在打磨中，命令、默认行为和边界场景处理可能继续调整。欢迎大家通过 [GitHub Issues](https://github.com/Richardlxr/SKillpkg/issues) 反馈 bug、兼容性问题和功能建议。

## 它能做什么

- 扫描不同 Agent 目录中已经存在的本机 skills。
- 把未托管 skills 纳入统一的 `~/.skillpkg` 存储。
- 让你选择每个 skill/MCP 服务应该注入到哪些 Agent。
- 同时支持全局机器级配置和项目级可复现配置。
- 使用 `skm.mod` 记录项目依赖，使用 `skm.sum` 记录完整性信息。

## 安装

在 npm 包正式发布前，请从源码安装：

```bash
git clone https://github.com/Richardlxr/SKillpkg.git skillpkg
cd skillpkg
npm install
npm run build
npm link
```

安装完成后确认命令可用：

```bash
skm --version
skm agents list
```

## 第一次运行

如果你刚安装好 `skillpkg`，最重要的路径不是先去找新 skill，而是先把这台机器上已经散落在各个 Agent 目录里的 skill 纳入统一管理。

```bash
# 1. 看看当前机器上检测到了哪些 Agent
skm agents list

# 2. 扫描各 Agent 原生 skills 目录，查看哪些还没有被 skm 管理
skm list

# 3. 一键纳管所有未托管的本机 skills
skm track

# 4. 选择哪些 skill/MCP 要注入到哪些 Agent，选择后立即生效
skm assign

# 5. 检查最终状态：scope、完整性、Agent 注入情况
skm status
```

也可以直接跑成一个安装后的半自动向导：

```bash
skm agents list && skm list && skm track && skm assign
```

这条路径会完成三件事：

- **检索设备上的已有 skills**：扫描所有已检测到 Agent 的 global/project skills 目录。
- **纳入 skm 管理**：未托管 skill 会被复制到 `~/.skillpkg/skills/<scope>/<name>`，原来的 Agent 原生目录会被移除，避免继续漂移。
- **注入到指定 Agent**：`skm assign` 会用交互式复选框选择目标 Agent，并立刻安装或移除对应注入。

> 提醒：`skm track` 只负责纳管，不会自动注入任何 Agent。第一次运行前建议先用 `skm list` 看一眼 `untracked` 列表，然后用 `skm assign` 选择目标 Agent。

## 常用工作流

### 把已有 skill 纳管后只分发给 Codex 和 Claude Code

```bash
skm list
skm track
skm assign
```

在 `skm assign` 中选择目标 skill，再勾选 `Codex (OpenAI)` 和 `Claude Code`。选择完成后，skm 会立刻把该 skill 注入被勾选的 Agent，并从未勾选的 Agent 中移除。

### 安装一个新 skill，并直接注入指定 Agent

```bash
# GitHub 简写
skm install owner/repo --agent codex

# 任意 Git 地址
skm install https://github.com/team/workflow-skill.git --agent claude-code

# monorepo 子目录
skm install https://github.com/team/workflow-skill#skills/reviewer --agent cursor

# 自动选择仓库里的所有 skills
skm install owner/repo -y --agent all
```

当仓库里包含多个 skills 时，交互式安装会先询问一个可选的 name/path 关键词。直接回车会展示全部 skills；输入 `reviewer` 之类的关键词后，再从过滤后的复选列表里选择要安装的项。

支持的 Agent id：

```text
antigravity
antigravity-cli
claude-code
codex
cursor
```

### 在当前项目里注入项目级 skill

在 Git 仓库或包含 `skm.mod` 的目录里，`skm install <source>` 默认安装到 **project scope**，并把 Git 来源保存到 `skm.mod` / `skm.sum`，方便团队复现。项目级 skill 只真实写入 `.agents/skills/`；Claude Code 和 Cursor 会分别通过 `.claude/skills/`、`.cursor/skills/` 兼容 symlink 读取同一份内容。

```bash
# 只给当前项目的 Codex 注入
skm install owner/repo --scope project --agent codex

# 临时本地注入，不写入 skm.mod
skm install owner/repo --scope project --no-save

# 卸载当前项目声明的 skill，并同步移除 skm.mod 条目
skm uninstall reviewer

# 在项目目录中卸载全局 skill，需要显式指定
skm uninstall reviewer --scope global

# 从 skm.mod 恢复当前项目声明的 skills/MCP
skm install

# 把项目级托管状态重新应用到某个 Agent
skm agents sync --scope project --agent claude-code
```

### 选择项目级 skills 的 Git 跟踪方式

项目级安装既可以只作为本地工具，也可以提交到仓库给团队共享。可以先设置默认偏好：

```bash
# 自动添加 skillpkg 托管的已安装项目 skill 路径与 MCP 配置 .gitignore 区块
skm config git auto

# 让项目级 skills 可以被 git 跟踪
skm config git track

# 每次项目级安装时询问
skm config git ask
```

启用 gitignore 模式时，skm 会维护类似下面的 `.gitignore` 区块。skill 条目按已安装的具体 skill 生成，不会忽略整个 skills 目录：

```gitignore
# === skillpkg managed (auto-generated, do not edit manually) ===
.agents/skills/reviewer
.claude/skills/reviewer
.cursor/skills/reviewer
.mcp.json
.codex/config.toml
.cursor/mcp.json
.agents/mcp_config.json
# === end skillpkg managed ===
```

### 已经托管的 skill，重新同步到某些 Agent

```bash
# 把 global scope 下的托管 skills/MCP 同步到所有检测到的 Agent
skm agents sync --scope global --agent all

# 只同步到 Codex
skm agents sync --scope global --agent codex

# 交互式调整每个 skill/MCP 的目标 Agent
skm assign
```

## 核心概念

### Managed 与 Untracked

- **Managed**：已经记录在 skm 数据库里的 skill。可以被 `assign`、`sync`、`status`、`verify`、`update` 管理。
- **Untracked**：存在于某个 Agent 原生 skills 目录里，但还没有进入 skm 数据库。`skm list` 会显示它们，`skm track` 可以一键接管。

### Global Scope 与 Project Scope

- **Global scope**：面向整台机器，写入各 Agent 的用户级 skills/MCP 配置。
- **Project scope**：面向当前仓库，写入当前项目下的 Agent 目录或项目 MCP 配置。
- 在 Git 仓库或包含 `skm.mod` 的目录内运行 `skm install <source>` 时，默认是 project scope；在项目外默认是 global scope。
- 如果项目级 skill 与全局 skill 同名，项目级记录会覆盖当前项目里的全局注入，避免 Agent 同时看到两份同名 skill。

### 注入模型

`skillpkg` 把“安装/纳管”和“注入到 Agent”拆开：

- `skm install <source> --agent codex`：安装新 skill 并立即注入目标 Agent。
- `skm track`：接管本机已经存在但未托管的 skill。
- `skm assign`：交互式选择某个 skill/MCP 应该出现在哪些 Agent 里。
- `skm agents sync`：把托管状态重新应用到指定 scope 和 Agent。
- `skm status`：查看每个 skill 的 scope、完整性与 Agent 注入状态。

## 安装来源格式

`skm install` 支持 GitHub 简写、带 host 的路径、完整 HTTPS URL、scp 风格 SSH URL 和本地目录：

```bash
skm install owner/repo
skm install github.com/owner/repo
skm install gitlab.com/example-org/workflow-skill
skm install https://gitlab.com/example-org/workflow-skill.git
skm install git@gitlab.com:example-org/workflow-skill.git
skm install ../local-skill
```

版本、分支、commit 与 monorepo 子目录：

```bash
skm install owner/repo@v1.0.0
skm install owner/repo#skills/reviewer
skm install https://github.com/team/workflow-skill#skills/reviewer@v1.0.0
skm install https://gitlab.com/example-org/workflow-skill.git#v1.0.0
```

## 查找、预览与安全审查

```bash
# 搜索 GitHub 上的 skills
skm search "web scraping"
skm search "web scraping" --json

# 安装前预览仓库内容与潜在风险
skm preview owner/repo

# 查看已安装或已扫描到的 skills
skm list
skm list --json
```

## 本地开发

```bash
# 链接当前目录的 SKILL.md 用于实时开发
skm link

# 链接指定目录
skm link ../my-skill-dev

# 链接到当前项目 scope
skm link ../my-skill-dev --scope project --agent codex

# 使用副本，而不是实时符号链接
skm link ../my-skill-dev --mode copy
```

安装模式：

- `copy`：复制 skill 目录。
- `symlink-cache`：项目级默认模式，链接到 skm 缓存。
- `symlink-dev`：`skm link` 默认模式，适合开发中实时修改。

## MCP 服务管理

```bash
# 列出 MCP，包括 skm 托管项和 Agent 原生配置中发现的项
skm mcp list

# 检查 MCP 可用性
skm mcp status

# 从 Git 源自动构建并部署 MCP
skm mcp add https://github.com/modelcontextprotocol/servers#src/memory --agent codex

# 为当前项目安装项目级 MCP
skm mcp add https://github.com/jgraph/drawio-mcp#mcp-tool-server --scope project --agent codex

# 交互式选择 MCP 应注入哪些 Agent
skm assign

# 重新应用 MCP 托管状态
skm mcp sync --scope global --agent all
```

MCP 会和 skill 一样记录 `scope`、`project_path` 与目标 Agent，可以后续提升、降级、同步或重新分配。

## `SKILL.md` 与 `skm.mod`

### `SKILL.md`

`SKILL.md` 是 Agent Skills 标准入口，元数据写在 YAML frontmatter 中：

```yaml
---
name: my-skill
version: "1.0.0"
description: 我的技能
mcp:
  - wps-office
setup_command: "python scripts/setup.py"
---

# My Skill

这里写给 Agent 读取的技能说明。
```

### `skm.mod`

`skm.mod` 用来声明项目依赖，风格类似 Go modules：

```text
module my-project-skills

skill github.com/owner/helpers v1.0.0
skill https://github.com/team/workflow-skill#skills/reviewer

mcp @playwright/mcp
mcp https://github.com/jgraph/drawio-mcp#mcp-tool-server

replace github.com/original/skill => github.com/my-fork/skill
replace github.com/remote/skill => ../local-dev-copy
```

不带参数运行 `skm install` 会读取当前目录的 `skm.mod`，并默认安装到 project scope。

## 完整性、更新与维护

```bash
# 检查更新
skm outdated

# 更新一个或所有 skill
skm update
skm update my-skill

# 验证 SHA-256 完整性
skm verify

# 清理孤立锁文件条目
skm tidy

# 将旧项目级 skill 目录迁移到 .agents/skills
skm tidy --unify

# 查看依赖树
skm tree

# 清理全局 Git 缓存
skm cache clean
```

全局完整性记录在 `~/.skillpkg/skm.sum`，项目级完整性记录在 `<project>/skm.sum`。项目级 Git 来源默认保存到 `<project>/skm.mod`，项目级卸载默认从 `skm.mod` 移除；如果只是临时给本机项目注入或卸载，可以加 `--no-save`。可以用 `skm config git auto|track|ask` 设置项目级安装产物是自动写入 `.gitignore`、交给 git 跟踪，还是每次询问。

## 支持的 Agent

在 Windows 上，文档里的 `~` 会解析为 `%USERPROFILE%`。

Google 正在把 Gemini CLI 用户迁移到 Antigravity CLI，因此 skm 不再支持 `gemini-cli`。Google CLI 工作流请使用 `antigravity-cli`。

| Agent | Agent id | Skills 目录 | MCP 配置 |
|---|---|---|---|
| Antigravity 2.0 / Editor | `antigravity` | `~/.gemini/antigravity/skills/`, `.agents/skills/` | `~/.gemini/antigravity/mcp_config.json` |
| Antigravity CLI | `antigravity-cli` | `~/.gemini/antigravity-cli/skills/`, `.agents/skills/` | `~/.gemini/antigravity-cli/mcp_config.json`, `.agents/mcp_config.json` |
| Claude Code | `claude-code` | `~/.claude/skills/`, `.agents/skills/` + `.claude/skills/` symlink | `~/.claude.json`, `.mcp.json` |
| Codex (OpenAI) | `codex` | `~/.agents/skills/`, `.agents/skills/` | `~/.codex/config.toml`, `.codex/config.toml` |
| Cursor | `cursor` | `~/.cursor/skills/`, `.agents/skills/` + `.cursor/skills/` symlink | `~/.cursor/mcp.json`, `.cursor/mcp.json` |

### 官方路径来源

上表会尽量跟随各 Agent 的公开官方文档：

- Codex：[Skills in Codex](https://developers.openai.com/codex/skills)
- Claude Code：[Agent Skills](https://docs.claude.com/en/docs/claude-code/skills) 与 [MCP](https://docs.claude.com/en/docs/claude-code/mcp)
- Cursor：[Skills](https://cursor.com/docs/context/skills) 与 [MCP](https://docs.cursor.com/en/context/mcp)
- Google 迁移公告：[Transitioning Gemini CLI to Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) 与 Antigravity CLI [migration guide](https://antigravity.google/docs/gcli-migration)
- Antigravity：[Skills](https://antigravity.google/docs/skills)、[MCP](https://antigravity.google/docs/mcp) 与 [CLI features](https://antigravity.google/docs/cli-features)

## 命令速查

```text
skm agents list        检测本机 Agent
skm list               列出 managed 与 untracked skills
skm track [name]       将未托管的原生 skill 纳入 skm 管理，不自动注入 Agent
skm assign             交互式把 skill/MCP 分配到指定 Agent
skm status             查看 scope、完整性与 Agent 注入状态

skm install <source>   从 Git 源或本地路径安装 skill（--no-save 可仅本地项目使用）
skm install            从 skm.mod 安装 skill/MCP 到项目级
skm uninstall <name>   卸载 skill（默认优先卸载当前项目同名 skill）
skm info <name>        查看某个 skill 的详细信息
skm update [name]      更新一个或所有 skill
skm outdated           检查 skill 是否落后于远端

skm search <query>     搜索 GitHub skills
skm preview <source>   安装前预览与安全审查
skm init [name]        初始化 SKILL.md 与 skm.mod
skm link [path]        链接本地 skill 用于开发

skm agents sync        重新同步托管的 skill 和 MCP
skm agents config <n>  查看某个 Agent 的详细配置

skm mcp add <name>     安装或配置 MCP
skm mcp rm <name>      移除 MCP
skm mcp sync           重新同步托管 MCP
skm mcp list           列出 MCP
skm mcp status         检查 MCP 可用性

skm promote skill <n>  将项目级 skill 提升为全局级
skm demote skill <n>   将全局级 skill 降到当前项目
skm promote mcp <n>    将项目级 MCP 提升为全局级

skm tree               显示依赖树
skm verify             验证完整性
skm tidy [--unify]     清理锁文件，并可迁移项目级 skill 目录
skm history <name>     查看替换历史
skm cache clean        清理缓存
skm config git <mode>  设置 git 处理方式：auto、track 或 ask
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `SKILLPKG_HOME_DIR` | 覆盖 Agent 用户目录查找时使用的 home 路径，主要用于测试或隔离环境 |
| `SKILLPKG_DATA_DIR` | 自定义 skm 数据目录，默认 `~/.skillpkg` |
| `SKILLPKG_DEBUG` | 设为 `1` 启用详细日志 |

## License

MIT
