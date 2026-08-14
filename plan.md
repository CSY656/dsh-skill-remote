# dsh-skill-remote Plan

## 架构概览

单包插件，位于 `packages/skill/skill-remote/`（与 skill 家族同组），包名 `@deepseek-ai/dsh-skill-remote`。插件 `apply` 一次做三件事：

1. **注册 remote provider**——通过 `ctx.skills.registerProvider()` 注册 `RemoteSkillProvider`（provider 名默认 `remote`），实现 `list()`（联网枚举远程源目录直接子级的 SKILL.md，产出候选）与 `get()`（拉取 SKILL.md 正文返回完整定义）。
2. **注册安装工具**——通过 `ctx.tools.register(defineTool(...))` 注册 `install_skill` 模型工具（snake_case 对齐 `read_file` 惯例），把远程 skill 固化安装到 `<dshHome>/skills/<name>/`。
3. **远程源管理**——启动时从 `Config.remotes`（URL 字符串数组）解析并预注册远程源；安装器成功安装后也把该源注册进来（返回 disposer，fiber 卸载时清空）。

无配置时 provider 空载：零网络请求，catalog 与现状一致（满足 AC8）。

## 核心数据结构

### `SkillSource`（url.ts）

```ts
interface SkillSource {
  owner: string      // GitHub owner
  repo: string       // GitHub repo
  ref: string        // 分支或 tag，默认 'main'
  subpath: string    // 仓库内 skill 目录路径（无首尾 /）
  name: string       // subpath 最后一段，用作 skill 默认名
  original: string   // 用户原始 URL（错误信息展示）
}
```

### `RemoteLocator`（provider.ts，作为 `SkillCandidate.locator` 的不透明载荷）

```ts
interface RemoteLocator {
  source: SkillSource     // 所属远程源
  entryPath: string       // 仓库内相对路径（如 skills/foo/SKILL.md）
  rawUrl: string          // SKILL.md 的 raw.githubusercontent.com URL
}
```

### `Config`

```ts
interface Config {
  providerName?: string   // 默认 'remote'
  remotes?: string[]      // 启动时预注册的远程源 URL 列表，默认 []
  installRoot?: string    // 安装根目录，默认 resolveDshHome()/skills
}
```

### GitHub Contents API 条目（github.ts）

```ts
interface ContentEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink' | 'submodule' | string
  size: number
  download_url: string | null
  content?: string
  encoding?: string
}
```

### `InstallReport`（install.ts）

```ts
interface InstallReport {
  skillName: string
  targetDir: string
  fileCount: number
  totalBytes: number
}
```

## 模块设计

### `src/url.ts` — URL 解析

**职责**：把用户输入解析为 `SkillSource`，三种格式：
- `https://www.skills.sh/<owner>/<repo>/<skill-name>` → `ref=main`, `subpath=skills/<skill-name>`
- `https://github.com/<owner>/<repo>/tree/<ref>/<subpath>` → 拆 ref 与 subpath
- `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<subpath>/SKILL.md` → 去尾部文件名

**对外**：`parseSkillUrl(raw: string): SkillSource`（非法输入抛带原因的 `Error`）。

### `src/github.ts` — GitHub API 客户端

**职责**：封装 GitHub Contents API 的目录枚举与文件下载，内置全部安全限额。

**对外**：
- `listContents(source, subpath, signal): Promise<ContentEntry[]>` —— GET `/repos/{owner}/{repo}/contents/{subpath}?ref=...`
- `fetchBlob(entry, signal): Promise<Buffer>` —— 优先内联 base64（省一次请求），回退 `download_url`
- `fetchText(entry, signal): Promise<string>` —— SKILL.md 文本
- `walkAndDownload(source, subpath, localDir, report, depth, signal)` —— 递归下载，执行限额检查

**依赖**：`url.ts`。**限额常量**：`MAX_FILE_SIZE = 1 MiB`、`MAX_TOTAL_SIZE = 8 MiB`、`MAX_FILE_COUNT = 64`、`MAX_RECURSION_DEPTH = 4`、`HTTP_TIMEOUT = 30s`；路径逃逸防护（条目名含 `..`/`/`/`\` 即拒绝）；symlink/submodule 跳过。

### `src/frontmatter.ts` — SKILL.md frontmatter 解析

**职责**：与 `skill-filesystem` 行为对齐的轻量解析（name/description/whenToUse/invocation policy + body）。

**对外**：`parseFrontmatter(raw): { data; body } | undefined`；skill 名校验用 `@deepseek-ai/dsh-skill` 的 `isSkillName`。

### `src/provider.ts` — RemoteSkillProvider

**职责**：实现 `SkillProvider` 契约。
- `list(options)`：遍历已注册源；每源 `listContents` 枚举直接子级——目录条目取 `<entry>/SKILL.md`，文件条目取 `*.md`；逐个 `fetchText` + frontmatter 解析产出候选。**单源失败 catch + 打 warning 后继续**（AC7）；`options.signal` 中止时立即抛。候选 `rank: 900`（高于本地 100–600，本地同名优先）、`source: 'remote'`、`resourceBase: { kind: 'url', url: rawUrl }`。
- `get(candidate, options)`：按 locator 的 `rawUrl` 拉取 SKILL.md 正文，返回 `SkillDefinition`（`resourceBase` 同 url 形态）。

### `src/install.ts` — 安装器

**职责**：纯逻辑，不碰 Cordis。

- `installSkill(source, installRoot, signal)`：校验 skill 名 → 在 `installRoot` 下建临时 staging 目录（同文件系统保证 rename 原子）→ `walkAndDownload` → 校验含 SKILL.md → 删旧目录 → `rename` → 返回 `InstallReport`。任何失败清理 staging 后重抛。

### `src/index.ts` — 插件组装

**职责**：`name='skill-remote'`、`inject=['skills','tools']`、`Config` schema（schemastery）；apply 内：注册 provider、注册 `install_skill` 工具、解析 `Config.remotes` 预注册源。

- **`install_skill` 工具**：参数 `{ url: string(必填) }`，output schema `{ skill_name, target_dir, file_count, total_bytes }`；执行：parse → install → 成功后 `registerRemote(url)` → 返回报告；render 输出人话总结。
- **`registerRemote(url)`**：解析并登记远程源（重复解析失败直接抛），返回 disposer；内部维护 `Map<normalizedUrl, { source, disposer }>`。
- 卸载：fiber effect 清空源注册（`ctx.effect`）。

## 文件组织

```
packages/skill/skill-remote/
├── package.json          # 拷贝 skill-badge 模板；peer/deps: cordis, dsh-skill, dsh-tools, dsh-home-paths; dep: schemastery, yaml
├── tsconfig.json         # 参考 skill-badge；references: vendor/cosmokit, vendor/cordis, vendor/schemastery, ../skill, ../../core/tools, ../../util/home-paths
├── README.md             # 含 Model Experience 与 Known Limitations 段
└── src/
    ├── index.ts          # 插件组装 + install_skill 工具 + registerRemote
    ├── url.ts            # parseSkillUrl
    ├── github.ts         # GitHub API 客户端 + 限额 + walkAndDownload
    ├── frontmatter.ts    # frontmatter 解析
    ├── provider.ts       # RemoteSkillProvider
    └── install.ts        # installSkill（纯逻辑）
tests/
    ├── url.spec.ts       # 三种 URL + 非法输入
    ├── github.spec.ts    # mock fetch：限额、base64/raw 回退、路径逃逸
    ├── provider.spec.ts  # mock fetch：list/get、单源失败隔离、signal 中止
    └── install.spec.ts   # tmp 目录：成功安装、失败无残留、manifest 校验
```

根仓库改动：`tsconfig.host.json` 的 `references` 增加本包。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 包位置/形态 | `packages/skill/skill-remote` 单包插件 | 与 skill 家族同组；职责内聚，无独立演进的 service/provider 角色 |
| HTTP 客户端 | Node 全局 `fetch` + `AbortSignal.timeout(30_000)` | Node ≥22 内置；无额外依赖；30s 满足 N2 有界超时 |
| 工具命名 | `install_skill`（snake_case） | 对齐 DSH 既有 `read_file`/`web_search` 等模型工具惯例 |
| remote 候选 rank | 固定 `900` | 本地 provider 用 100–600；数值大=低优先，远程同名让位本地 |
| 发现范围 | 只枚举源目录直接子级 | 对齐本地 provider「不支持递归 `**/SKILL.md`」约定（spec 不做的事） |
| 安装后可见性 | 依赖 filesystem provider 的 chokidar watcher 自动发现，安装器另调 `control.invalidate()` 兜底 | watcher 已覆盖外部写入；invalidate 保证不依赖 watcher 时序 |
| frontmatter 解析 | 包内独立轻量实现 | filesystem 的解析器不导出；复制会引入不必要耦合 |
| 远程源注册存储 | `Map`，键为规范化 URL 字符串 | F6 要求运行时注册 + 可卸载，Map+disposer 最简 |
| GitHub API 认证 | 不传 token，仅公共 API | 满足 N5 凭据不落盘；私有仓库明确不做 |
| 安装器写目录 | 用 node fs 直接写 `resolveDshHome()/skills` | 安装目标是主机用户目录（trustedHost），与 filesystem provider 的 bundled 路径同一信任模型 |
