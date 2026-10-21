# dsh-skill-mcp-vault —— 你的技能仓库 + MCP 仓库，一个插件搞定

> dsh-ck：dsh 用于储存技能和 mcp 的仓库插件
> 仓库：<https://github.com/jiuyou-7411/dsh-ck>
> 许可证：MIT（`vendor/` 目录除外，见 [NOTICE](NOTICE)）

## 它做了什么

把「技能」和「MCP 服务」这两样东西**收进插件自己的目录**，而不是散落在 `~/.dsh/skills`
和各处零散的 profile 配置里：

```
~/.dsh/profiles/desktop/node_modules/dsh-skill-mcp-vault/
├── skills/          ← 技能仓库：一个子目录 = 一个技能（SKILL.md）
│   └── <skill-name>/SKILL.md
├── mcp/mcp.json     ← MCP 仓库：MCP 服务的清单（人可读、可手改）
└── lib/index.js     ← 宿主插件：把上面两样注册进 Harness
```

只要这个插件在 profile 里，**里面的技能会自动出现在技能目录（模型能看到、能用 `skill` 工具加载）**，
**里面的 MCP 服务会自动连上并把工具挂成 `mcp__<serverName>__<tool>`**。

## 安装 / 分发（npm）

```bash
npm run pack                                       # 产出 dsh-skill-mcp-vault-<version>.tgz + .sha256
npm run verify:pack                                # 把 tgz 装进空目录真跑一遍（22 项检查）
npm install ./dsh-skill-mcp-vault-<version>.tgz    # 别人那边：装这个包
npm publish ./dsh-skill-mcp-vault-<version>.tgz    # 发到 npm 也发这个 tgz
```

> **别直接 `npm publish` 源码目录。** `package.json` 的 `files` 一旦列了 `skills/`、`mcp/` 这种运行时会写东西的目录，
> npm 会把整个目录装进包，`.trash`（回收站）和 `.backups`（每次写入的备份）也会跟着走，而 `.npmignore`
> 对 `files` 里列出的目录**不生效**（实测过，回收站确实出现在清单里）。
> `npm run pack` 先复制一份干净暂存目录再打包，打完还会自查：出现 `.trash` / `.backups` / `node_modules` / `src`
> 就直接报错退出。`prepublishOnly` 也会拦下直接 publish，并提示正确流程。

**包里带什么**：`lib/index.js`、`lib/client.js`、`vendor/`、`locale/`、`locale-data/`、`assets/icon.svg`、
`cordis.patch.yml`、`README.md`、`mcp/mcp.json`、`skills/`（只带真实技能）。
`skills/` 是空的时不会进包（npm 不支持空目录），首次写入时插件自己 `mkdir`，不影响使用。

**发出去的包会被清洗**（每次 `pack` 自动做，并打印出来）：

| 东西 | 处理 |
| --- | --- |
| `mcp/mcp.json` | 清成 `{"version":1,"servers":[]}`。这是**你自己**的服务清单，不随包分发，否则每个装包的人都会凭空多出一堆别人的 MCP 服务 |
| `skills/` | 原样带（里面只剩 `.trash`/`.backups` 时等于空）；如果真有技能会打印清单提醒你 |
| `scripts` / `devDependencies` | 从包内 `package.json` 剥掉，装包的人不需要构建工具 |
| `.trash` / `.backups` / `node_modules` / `src` / `scripts` | 不进包，进了就报错退出 |

**依赖**：`fflate` 是普通依赖，装包时自动拉；`@deepseek-ai/dsh-client-ui-primitives` 由宿主提供，
标成 optional peer，npm 不会去公网拉它。

发版前记得先 `npm version patch|minor` 改版本号——版本号同时决定 tgz 文件名。

## 关键规则（已实测确认）

| 事实 | 结论 |
| --- | --- |
| `dsh-plugin-manager` 把「链接安装（local dir）」视为**已存在的依赖**并拒绝再次安装 | 插件装一次就够，**往仓库里加技能/MCP 不需要重装插件** |
| 技能是自己实现的 `SkillProvider`，每次 `list()` 都读磁盘，命中的文件变大时自动 `invalidate()` 并重读 | **新增/修改 `skills/` 里的东西立即生效**，`/skill` 目录会自动刷新 |
| MCP 由 `@deepseek-ai/dsh-mcp-client` 这一行提供，**客户端只接受随安装就静态声明的服务器** | **新增 MCP 服务必须重新加载那一行**（插件会自动触发，见下） |
| 面板是 `lib/client.js`（每次刷新窗口重载），而 Node 侧是 `lib/index.js`（**只在应用启动时加载**） | 改了接口/路由后必须**完全退出 DSH NEXT 再打开**，只刷新窗口会出现 `unknown route POST xxx` |

## 怎么加技能

**方式 A：直接放文件（推荐，人工用）**
```bash
SKILLS=~/.dsh/profiles/desktop/node_modules/dsh-skill-mcp-vault/skills
mkdir -p "$SKILLS/my-skill"
$EDITOR "$SKILLS/my-skill/SKILL.md"
```
`SKILL.md` 必须有 YAML frontmatter：
```markdown
---
name: my-skill            # 小写+连字符，全局唯一
description: 一句话说明它什么时候该被用（模型靠这句决定加载）
whenToUse: 可选，更具体的使用场景
---

正文：写清楚步骤、命令、判断标准。
```
保存后下一次对话（或同一个会话的下一次 `skill` 调用）就能看到。**不需要重启、不需要重装。**

**方式 B：让 AI 装（agent 用 `skill_vault` 工具）**
```
skill_vault(action="add_skill", name="my-skill", description="...", body="...")
skill_vault(action="add_skill", name="my-skill", source="https://raw.githubusercontent.com/.../SKILL.md")
skill_vault(action="add_skill", name="my-skill", source="/abs/path/to/dir-or-SKILL.md")
```

**方式 C：从你电脑上已有的技能导入**
```
skill_vault(action="import_skill", source="/path/to/skill-dir")   # 复制进仓库，原目录不动
```

## 怎么加 MCP

用工具加（**会写进 `mcp/mcp.json` 并自动热重载那一行**）：
```
mcp_vault(action="add",
  serverName="fs",
  transport="stdio",
  command="npx",
  args=["-y","@modelcontextprotocol/server-filesystem","C:/data"])

mcp_vault(action="add",
  serverName="remote",
  transport="streamable-http",
  url="https://example.com/mcp",
  headers={"Authorization":"Bearer xxx"},
  failOnStartupError=true)
```
随后用 `mcp_vault(action="list")` 看状态；连不上的服务会在自己那一行显示失败，**不影响其它服务**。

也可以手改 `mcp/mcp.json`，然后让 AI 执行 `mcp_vault(action="reload")`，或重启 DSH。

`mcp/mcp.json` 格式：
```json
{
  "version": 1,
  "servers": [
    { "serverName": "fs", "transport": "stdio", "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/data"],
      "env": {}, "cwd": "", "enabled": true },
    { "serverName": "remote", "transport": "streamable-http",
      "url": "https://example.com/mcp", "headers": {}, "failOnStartupError": false,
      "enabled": true }
  ]
}
```

## 面板结构（只有两个标签）

侧边栏「仓库」→ 面板只有 **技能** 和 **MCP** 两个标签；「全局」不是第三个标签，而是每个标签里的**来源分类**：
每个来源一行（名称、启用/接入数、路径、总开关），展开是条目。

### 技能

| 来源 | 目录 |
| --- | --- |
| 仓库 | 本插件 `skills/` |
| DSH | `~/.dsh/skills` |
| 公共 Agent | `~/.agents/skills` |
| Claude Code | `~/.claude/skills` |
| Codex | `~/.codex/skills` |
| Windsurf | `~/.codeium/windsurf/skills` |
| Trae / Trae 国内版 | `~/.trae/skills`、`~/.trae-cn/skills` |
| OpenClaw / WorkBuddy | `~/.openclaw/skills`、`~/.workbuddy/skills` |

统计条：技能总数 / 已启用 / 已停用 / 诊断异常；筛选：来源、状态、搜索。
开关**直接改写该技能 SKILL.md 的 `user-invocable` / `disable-model-invocation`**（与上游策略一致，任何加载器都认），
改前备份到仓库的 `skills/.backups`。批量开关走来源卡片上的总开关。
新建 / 导入 / 同步只作用在仓库，避免改坏别的 Agent 目录。

### 发现技能 → 插件 skills 仓库

「技能」页的「发现技能」里有四个子页签：GitHub 仓库、ClawHub、skills.sh、**插件 skills 仓库**。
最后一个专门管本插件自带的技能（`skills/`），也就是**随插件一起分发**的那部分：

| 操作 | 做什么 | 走哪个接口 |
| --- | --- | --- |
| 列表 / 搜索 | 读取插件 `skills/` 里的技能 | `GET /dsh-skill-mcp-vault/api/skills` |
| 全部状态 | 区分「已在本机」「未安装」，数据来自本机来源扫描 | `GET /api/dsh-skills-manager/state` |
| 刷新 | 重新读取插件里的技能 | `GET /dsh-skill-mcp-vault/api/skills` |
| 创建技能 / 导入技能 | 工具栏两个图标，**不另开弹窗**，直接调起「技能」页已有的创建 / 导入弹窗，目标范围预设为「插件 skills 仓库」 | `POST /dsh-skill-mcp-vault/api/skill`、`POST /dsh-skill-mcp-vault/api/upload` |
| 安装到… | 把插件技能复制一份到全局 DSH skills、Shared Agent 或已登记工作区（等同安装），插件里的原件保留 | `POST /api/dsh-skills-manager/import`（source 指向插件技能目录） |
| 批量安装 | 勾选多个技能后点「安装所选」，逐个装到同一目标 | 同上 |
| 全选 | 工具栏左侧复选框，只对当前筛选出来的行生效；全选后可直接「安装所选」或「导出 ZIP」 | — |
| 导出 ZIP | 把技能（含子目录）打成 zip 写进系统下载目录，顶层目录就是技能名，解压后能直接再导入；导完自动在文件管理器里定位到该 zip | `POST /dsh-skill-mcp-vault/api/export`、`POST /dsh-skill-mcp-vault/api/reveal`（`GET /dsh-skill-mcp-vault/api/skill/zip?name=` 可直接取二进制） |
| 删除 | 移入插件回收站 `skills/.trash` | `DELETE /dsh-skill-mcp-vault/api/skill` |

把技能**存进插件**走的是同一套弹窗：创建 / 导入弹窗的目标选择器里多了一个范围 **「插件 skills 仓库」**，
选中它技能就写进插件包的 `skills/`，随插件一起分发。

| 入口 | 选中「插件 skills 仓库」时走哪个接口 |
| --- | --- |
| 创建技能（技能页工具栏，或插件仓库页签的 ＋） | `POST /dsh-skill-mcp-vault/api/skill` |
| 导入技能（技能页工具栏，或插件仓库页签的导入图标） | `POST /dsh-skill-mcp-vault/api/upload`（zip 或文件清单，落临时目录后逐个导入） |

「安装到…」和「导入时选插件仓库」是**方向相反**的两件事，别混：

- **安装到…**：插件 → 本机。装完本机目录里有这个技能，卸载插件不影响已安装的副本。
- **导入 → 插件 skills 仓库**：本机 → 插件。存完技能进了插件包，跟着插件一起分发，但重装/更新插件可能被覆盖。

这样别人装上这个插件，打开这个页签就能看到插件自带的技能并装到自己目录；反过来你也能把
本地调好的技能存进插件，跟着插件一起分发。

## 全局 MCP（面板第三个标签）

「全局 MCP」按来源列出本机**其它 Agent 已经配置好的** MCP 服务，和「技能」面板的来源分组同一个形态：

| 来源 | 读取的文件 |
| --- | --- |
| DSH | `~/.dsh/profiles/*/cordis.yml` 里的 `@deepseek-ai/dsh-mcp-client` 行 |
| Claude Code | `~/.claude.json`、`~/.claude/settings.json` 的 `mcpServers` |
| Cursor | `~/.cursor/mcp.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| Codex | `~/.codex/config.toml` 的 `[mcp_servers.*]` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Trae / Trae 国内版 | `~/.trae/mcp.json`、`~/.trae-cn/mcp.json` |
| OpenClaw / WorkBuddy / 公共 Agent | `~/.openclaw/mcp.json`、`~/.workbuddy/mcp.json`、`~/.agents/mcp.json` |

每一行显示来源名、`已接入/总数`、配置路径和总开关；展开后是单个服务，各自有开关。
接入 = 写进本插件的 `mcp/mcp.json` 并立刻连上（只重建那一行，不中断会话）；停用 = 从目录里移除。

### 插件 MCP 仓库（列表第一张卡片）

`mcp/mcp.json` 就是**插件自带的 MCP 仓库**，`package.json` 的 `files` 里有 `mcp`，所以它随插件一起分发：
别人装了本插件，这些服务就在他的列表里，打开开关就能用。

| 操作 | 做什么 | 走哪个接口 |
| --- | --- | --- |
| 新增 MCP 服务 | 填名称 + 启动命令（HTTP 端点则填 URL），直接写进插件仓库 | `POST /dsh-skill-mcp-vault/api/mcp` |
| 贴地址自动识别 | 弹窗第一行填 GitHub 仓库地址，点「自动识别」把启动命令猜出来填进表单（只填不存） | `POST /dsh-skill-mcp-vault/api/mcp/inspect` |
| 导入 MCP 配置 | 选一个 JSON 文件导进来，认得插件格式 `{version,servers:[]}`、服务器数组，以及 Claude/Cursor 的 `{mcpServers:{...}}`；同名覆盖 | `POST /dsh-skill-mcp-vault/api/mcp/import` |
| 导出（卡片 / 单行） | 导出成和 `mcp/mcp.json` 同构的 JSON 到系统下载目录，导完自动定位到文件 | `POST /dsh-skill-mcp-vault/api/mcp/export` + `POST /dsh-skill-mcp-vault/api/reveal` |
| 删除（单行） | 从插件仓库移除该服务，不影响其它 Agent 的配置文件 | `DELETE /dsh-skill-mcp-vault/api/mcp` |

仓库为空时这张卡片仍然显示，不会因为「没有服务」就消失掉导入入口。

**状态文字分两种意思**（别混）：

| 显示 | 意思 |
| --- | --- |
| 已连接 · N 个工具 | 进程起来了、MCP 握手成功、N 个工具已注册到模型 |
| 未连上 | 这一行已启用，但没握手成功。多半是这条命令**不是 MCP 服务**（一次性 CLI 跑完就退出），或参数里的路径/token 还是占位符 |
| 未加载 | 宿主还没为它建好 MCP 行，点工具栏「重载 MCP 行」 |
| 已停用 | `mcp/mcp.json` 里 `enabled: false`，不会启动 |

**不需要「安装到绝对路径」**：`npx` / `uvx` / `docker` 都从 PATH 找，Windows 下 `cross-spawn` 也会自动补 `.cmd`。
只有命令里带**相对路径**（`node build/index.js`）时才需要「工作目录」——新增弹窗里有这个可选字段，
填绝对目录即可。命令里的**参数**（比如要分析的目标路径）该用绝对路径。

**「自动识别」是怎么猜的**（只读 GitHub，结果一律先填进表单让你确认）：

1. 仓库里直接给了 `mcpServers` 配置（README 代码块里贴的）→ 直接照抄，可信度高；
2. README 代码块里的启动命令：`npx -y <包>`、`uvx <包>`、`docker run …` 依次优先，`node`/`python` 只当兜底；
   反斜杠续行的多行命令会先接起来；`npx xxx setup/install` 这类安装器命令会降权并提示；
3. 都没有就看 `package.json` 的 `name`，按 `npx -y <name>` 试（MCP 服务大多发在 npm 上）；
4. 地址指向具体 `.json`（`/blob/.../x.json` 或 `raw.githubusercontent.com/...`）时，直接当配置解析。

参数里带 `<your-token>` / `your_token` 这类占位符时仍会填进去，但会在下面提示「记得替换」。

**把别的来源的 MCP 存进插件**：展开下面任意一张来源卡片（Codex、Claude、Cursor…），
点那一行右边的开关（或整张卡片标题右边的总开关），服务就被复制进 `mcp/mcp.json`，
行状态从「未存入」变成「已存入插件」。插件仓库里的行则是「已启用 / 已停用」，语义是启停而不是归属。

**导入时字段很宽容**：除了插件自己的 `{version,servers:[]}`，也吃服务器数组、Claude/Cursor 的
`{mcpServers:{名字:{...}}}`，以及 `mcpServers` 里直接写 URL 字符串的写法。字段名会先归一：

| 认得的别名 | 归一到 |
| --- | --- |
| `command` / `cmd` / `exec` / `bin` | `command` |
| `args` / `arguments`（数组或空格分隔的字符串） | `args` |
| `url` / `serverUrl` / `endpoint` / `baseUrl` / `address` | `url` |
| `transport` / `type` / `protocol`（`stdio` / `sse` / `http`） | `transport` |

服务名里出现点号、空格、中文等非法字符时会换成 `-` 并截到 32 位，而不是整条被拒。

**分发**：`mcp/mcp.json` 就在插件包里，`package.json` 的 `files` 已经包含 `mcp`，所以打包/安装插件时它一起走。
对方装上插件、打开 MCP 页，就能在「插件 MCP 仓库」里看到这些服务，`enabled` 状态也一起带过去
（想默认可用就把它打开再分发）。要单独发给别人，用卡片上的「导出」给他一个 `.mcp.json`，他那边「导入」即可。

AI 侧对应三个动作：

```
mcp_vault(action="scan_globals")                 # 列出全部来源与服务
mcp_vault(action="adopt_global", serverName="node_repl")
mcp_vault(action="toggle_global_source", sourceId="codex", enabled=true)
```

> 技能不在这里重复造：全局技能由已安装的 `@michengai/dsh-skills-manager` 负责（设置 → 技能），
> 本插件的「技能」标签只管仓库自己 `skills/` 目录里的那一批。

## 给 AI 用的工具

| 工具 | 作用 |
| --- | --- |
| `skill_vault` | `list` / `get` / `add_skill` / `import_skill` / `remove_skill` / `sync_user_skills` / `info` |
| `mcp_vault` | `list` / `add` / `remove` / `enable` / `disable` / `reload` / `info` |

- `sync_user_skills`：把 `~/.dsh/skills` 里已有的技能**复制**进仓库（源目录保留），一次搬完。
- `reload`：改完 `mcp/mcp.json` 后让宿主重载 MCP 行；**正在跑的会话不会因此中断**。

## 权限与安全

- 工具调用受当前会话的权限预设限制；只读会话里写操作会被拒绝。
- 写入 `skills/` 与 `mcp/mcp.json` 前会先备份（`*.bak-<时间戳>`）。
- 从 URL 拉技能只允许 `http(s)`，建议指向你自己的仓库；拉到的东西是**文本**，不会执行。

## 卸载

`plugin_manager` 的 `remove_bundle`（或面板里禁用）。仓库目录会随包一起删除；
需要保留就先 `cp -r` 出来。
