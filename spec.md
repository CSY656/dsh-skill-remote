# dsh-skill-remote Spec

## 背景

DSH 的 skill 能力族（`packages/skill/`）通过 `ctx.skills.registerProvider()` 支持多来源 provider，且 `SkillResourceBase` 类型已预留 `{kind:'url'}` 形态，文档把「remote registries」列为 provider 示例——但仓库只 ship 了两个 provider：本地文件系统（`dsh-skill-filesystem`）和内置 badge（`dsh-skill-badge`）。用户想用 skills.sh 或 GitHub 上的现成 skill，只能手动 clone/下载再放进本地 skills 目录。

CsyCode ch11 已实现完整的远程安装逻辑（`skills/install.py`：三种 URL 解析、GitHub Contents API 递归拉取、安全限额、原子安装），其行为可移植为 DSH 的 remote provider + 安装器。

## 目标

- **G1**：提供远程 skill provider，注册到 `ctx.skills`，能发现、加载 skills.sh 与 GitHub 仓库中的 skill，与本地 provider 并列出现在 catalog 中。
- **G2**：提供安装器（模型可见工具），把远程 skill 固化安装到本地 skills 目录，安装后由 filesystem provider 自然接管，无需重启即可被 `skill` 工具加载。
- **G3**：安全有界——所有下载受大小/数量/深度/路径安全限制；安装失败原子回滚，不残留残缺目录。
- **G4**：无配置可用——直连 GitHub 公共 API，cordis.yml 零配置即可工作。

## 功能需求

- **F1: URL 解析**——解析三种远程来源 URL：`skills.sh`、`github.com tree`、`raw.githubusercontent.com`，得到 owner/repo/ref/subpath 结构化描述；非法 URL 给出明确错误。
- **F2: 远程发现（provider `list`）**——对 provider 已注册的每个远程源，联网枚举其目录下的 SKILL.md，产出候选（name + description，解析 frontmatter）。
- **F3: 按需加载（provider `get`）**——拉取候选对应 SKILL.md 正文，返回完整 skill 定义；`resourceBase` 为 url 形态；缓存策略按 provider 契约（registry 不缓存完整定义）。
- **F4: 安装器工具**——模型可见工具接收 URL，把远程 skill 递归下载到 `<dshHome>/skills/<name>/`；先暂存到同级临时目录，全部成功并校验含 SKILL.md 后原子 rename；失败清理 staging 不残留。
- **F5: 安全限额**——单文件 ≤1 MiB、总大小 ≤8 MiB、文件数 ≤64、递归深度 ≤4、文件名路径逃逸防护（拒绝含 `..`/`/`/`\` 的条目名）、skill 名称校验（小写字母数字连字符下划线）。
- **F6: 远程源注册**——安装器成功安装后，把该源注册给 remote provider（disposer 生命周期内有效），并可选通过 cordis.yml 配置 `remotes` 列表在启动时预注册（无配置则空载，不产生任何请求）。
- **F7: 安装后立即可见**——安装完成触发 skill catalog 失效/通知，下一次 catalog 快照与 `skill` 工具调用即能看到并加载新 skill，无需重启进程。

## 非功能需求

- **N1: 失败隔离**——单个远程源的发现/加载失败（网络错误、404、限流）只影响该源，不拖垮其他 provider 与整体 catalog；错误信息可读。
- **N2: 超时有界**——所有 HTTP 请求 30 秒超时；慢源不阻塞 discovery（遵守 provider 契约的 `signal` 中止）。
- **N3: 并发安全**——并发安装不同 skill 互不干扰（各自独立 staging）；重复安装同名 skill 以最后一次完整写入为准，目录不出现半写状态。
- **N4: 不破坏既有行为**——无远程源注册、无配置时，provider 空载零请求，catalog 与现状完全一致。
- **N5: 凭据不落盘**——仅使用 GitHub 公共 API，不读取、不存储任何 token。
- **N6: 包规范合规**——通过 `pnpm run constraints` / `typecheck` / `lint` / `build` / `hygiene`，README 含 Model Experience 与 Known Limitations 段。

## 不做的事

- 不做 OAuth / 私有仓库认证（仅公共仓库）。
- 不做远程源的自动更新/版本管理/锁版本（每次按需拉取最新）。
- 不做 GitHub 之外的 git host（GitLab/Gitee）。
- 不做 symlink/submodule 条目的下载（跳过）。
- 不做远程 skill 的本地缓存持久化（安装是唯一的固化方式）。
- 不做 provider 侧的递归嵌套目录发现（对齐本地 provider 的「不支持递归 `**/SKILL.md`」约定，只枚举源目录直接子级）。

## 验收标准

- **AC1（F1）**：三种 URL 各解析出一个正确 SkillSource（owner/repo/ref/subpath）；非法 URL 抛带原因的明确错误。
- **AC2（F2）**：注册一个指向含 SKILL.md 的 GitHub 目录的远程源，`ctx.skills.snapshot()` 中出现该 skill 的 name/description。
- **AC3（F3）**：`ctx.skills.get(name)` 返回该 skill 的正文，`resourceBase` 为 url 形态。
- **AC4（F4）**：调用安装工具后，`<dshHome>/skills/<name>/` 下出现全部文件且含 SKILL.md；失败场景下无 staging 残留。
- **AC5（F5）**：超过 1 MiB 的单文件或超过 64 个文件的目录被拒绝并返回明确错误。
- **AC6（F7）**：安装完成后，不重启进程，下一次 catalog 快照中出现新 skill，`skill` 工具可加载其正文。
- **AC7（N1）**：对一个不存在的 repo 注册远程源，snapshot 仍返回其他 provider 的 skill，整体 catalog 不失败。
- **AC8（N4）**：零配置启动时 remote provider 不发起任何网络请求，catalog 与安装本包之前一致。
