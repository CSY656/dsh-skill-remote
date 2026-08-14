# dsh-skill-remote Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `packages/skill/skill-remote/package.json` | 包清单（模板：skill-badge） |
| 新建 | `packages/skill/skill-remote/tsconfig.json` | 包编译配置 |
| 新建 | `packages/skill/skill-remote/src/url.ts` | URL 解析 |
| 新建 | `packages/skill/skill-remote/src/frontmatter.ts` | frontmatter 解析 |
| 新建 | `packages/skill/skill-remote/src/github.ts` | GitHub API 客户端 + 限额 |
| 新建 | `packages/skill/skill-remote/src/provider.ts` | RemoteSkillProvider |
| 新建 | `packages/skill/skill-remote/src/install.ts` | 安装器纯逻辑 |
| 新建 | `packages/skill/skill-remote/src/index.ts` | 插件组装 + install_skill 工具 |
| 新建 | `packages/skill/skill-remote/README.md` | 包文档 |
| 新建 | `packages/skill/skill-remote/tests/{url,frontmatter,github,provider,install,index}.spec.ts` | 单元测试 |
| 修改 | `tsconfig.host.json` | references 注册本包 |

## T1: 包骨架

**文件：** `package.json`、`tsconfig.json`、`src/index.ts`（最小占位）
**依赖：** 无
**步骤：**
1. 拷贝 skill-badge 的 package.json，改 name/description，peerDependencies 用 `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/cordis`（workspace:^，dev 同步镜像），dependencies 加 `@deepseek-ai/schemastery`、`yaml`；files 按规范 `["lib/index.js", "lib/types/**/*.d.ts"]`
2. tsconfig.json：extends 根 base；references 加 vendor/cosmokit、vendor/cordis、vendor/schemastery、`../skill`、`../../core/tools`、`../../util/home-paths`
3. 写占位 `export const name = 'skill-remote'` 的 index.ts
**验证：** 仓库根 `pnpm install` 后，`npx tsc -p packages/skill/skill-remote --noEmit` 无错误

## T2: url.ts

**文件：** `src/url.ts` + `tests/url.spec.ts`
**依赖：** T1
**步骤：**
1. 实现 `parseSkillUrl(raw)`：skills.sh / github tree / raw 三种分支（raw 分支去掉尾部含 `.` 的文件名段）
2. 校验：仅 http(s)；非法 host 抛「不支持的 host」；结构不完整抛格式错误
3. 写测试：三种 URL 各断言 owner/repo/ref/subpath/name；非法输入（file://、github.com 无 tree、空串）断言抛错
**验证：** `npx vitest run packages/skill/skill-remote/tests/url.spec.ts` 全绿

## T3: frontmatter.ts

**文件：** `src/frontmatter.ts` + `tests/frontmatter.spec.ts`
**依赖：** T1
**步骤：**
1. 实现 `parseFrontmatter(raw)`：以 `---` 开头、找闭合 `---`、yaml.parse、非 mapping 返回 undefined；返回 `{ data, body }`
2. 实现 `parseSkillMeta(data)`：提取 name/description/whenToUse + invocation policy（disable-model-invocation / user-invocable，与 filesystem 语义一致），name 用 `isSkillName` 校验，非法返回 undefined
3. 测试：合法 frontmatter、缺 name、非法 name、缺闭合、非 mapping
**验证：** `npx vitest run packages/skill/skill-remote/tests/frontmatter.spec.ts` 全绿

## T4: github.ts

**文件：** `src/github.ts` + `tests/github.spec.ts`
**依赖：** T2
**步骤：**
1. 实现 `listContents(source, subpath, signal)`：GET `https://api.github.com/repos/{owner}/{repo}/contents/{subpath}?ref={ref}`，headers 含 User-Agent；非 200 抛含状态码错误
2. 实现 `fetchBlob(entry, signal)`：size>MAX_FILE_SIZE 抛「过大」；内联 base64 直接解码，否则走 download_url；响应非 200 抛错
3. 实现 `fetchText(entry, signal)`：fetchBlob 后 utf8 解码
4. 实现 `walkAndDownload(source, subpath, localDir, report, depth, signal)`：深度/文件数/总大小限额；条目名含 `..`、`/`、`\` 拒绝；file 写盘、dir 递归、symlink/submodule 跳过
5. 所有请求用 `AbortSignal.timeout(30_000)` 与传入 signal 组合
6. 测试（mock global fetch）：非 200、单文件超限、总大小超限、文件数超限、深度超限、路径逃逸、base64 与 download_url 两路
**验证：** `npx vitest run packages/skill/skill-remote/tests/github.spec.ts` 全绿

## T5: provider.ts

**文件：** `src/provider.ts` + `tests/provider.spec.ts`
**依赖：** T2、T3、T4
**步骤：**
1. 实现 `RemoteSkillProvider implements SkillProvider`：构造注入 ctx、control、配置的 remotes
2. `list(options)`：无源返回 `[]`；每源 listContents 枚举直接子级（目录→`<path>/SKILL.md`，文件→`*.md`）→ fetchText → parseSkillMeta → 产出候选（rank 900、source 'remote'、resourceBase url、locator=RemoteLocator）；单源 try/catch warn 继续；每步前 `signal?.throwIfAborted()`
3. `get(candidate, options)`：从 locator 取 rawUrl 直接 fetch 文本 → parseFrontmatter → SkillDefinition（未加载到返回 undefined）
4. 测试（mock fetch）：多源 list 合并、单源 404 隔离、signal 中止、get 返回正文
**验证：** `npx vitest run packages/skill/skill-remote/tests/provider.spec.ts` 全绿

## T6: install.ts

**文件：** `src/install.ts` + `tests/install.spec.ts`
**依赖：** T2、T4
**步骤：**
1. 实现 `validateSkillName(name)`：小写字母数字 `-` `_`，不以 `.` 开头
2. 实现 `installSkill(source, installRoot, signal)`：`mkdtemp` 同级 staging → walkAndDownload → 校验 staging 含 SKILL.md → 旧目录 rmtree → `rename` → 返回 InstallReport；catch 中清理 staging 后重抛
3. 测试（mock fetch + `fs.mkdtemp` 临时目录）：成功安装文件落位、缺 SKILL.md 拒绝、中途失败无 staging 残留、重装覆盖旧目录
**验证：** `npx vitest run packages/skill/skill-remote/tests/install.spec.ts` 全绿

## T7: index.ts 插件组装

**文件：** `src/index.ts` + `tests/index.spec.ts`
**依赖：** T5、T6
**步骤：**
1. 实现 `Config` schema（schemastery）：providerName 默认 'remote'、remotes 默认 []、installRoot 可选
2. `apply(ctx, config)`：`ctx.skills.registerProvider(control => new RemoteSkillProvider(...))`；解析 `config.remotes` 逐个预注册；`ctx.effect` 卸载时清空源表
3. 实现 `registerRemote(url)`：parse 后存入 Map（键为 original URL 规范化小写），返回 disposer；同名重复注册幂等替换
4. 测试（构造真实 skills registry —— 参考 skill 包测试的 ctx 构造方式，若过重则用最小 fake 对象断言调用）：remotes 解析、registerRemote 幂等、卸载清空
**验证：** `npx vitest run packages/skill/skill-remote/tests/index.spec.ts` 全绿

## T8: install_skill 工具

**文件：** `src/index.ts`（追加）
**依赖：** T7
**步骤：**
1. 用 `defineTool` 注册 `install_skill`：parameters `{ url: { type:'string', required:true } }`，output schema `{ skill_name, target_dir, file_count, total_bytes }`，render 输出人话总结
2. execute：`parseSkillUrl` → `installSkill(source, installRoot, exec.signal)` → `registerRemote(url)` → 返回报告；解析/安装失败 throw（DSH 自动转 isError）
3. installRoot 取自 `resolveDshHome(config.installRoot ?? undefined)` + `/skills`，安装前 `mkdir -p`
4. 测试：mock fetch 走通安装流程，断言目录生成 + 返回值
**验证：** `npx vitest run packages/skill/skill-remote/tests/index.spec.ts` 全绿

## T9: 根仓库注册 + README

**文件：** `tsconfig.host.json`、`README.md`
**依赖：** T8
**步骤：**
1. `tsconfig.host.json` 的 references 追加 `{ "path": "./packages/skill/skill-remote" }`（字母序位置）
2. README：服务 API、Config、工具契约、设计说明；Model Experience 段（install_skill 工具条目：What the model sees / Token effect / KV Cache effect）；Known Limitations（私有仓库不支持、发现限直接子级、无版本锁定）
**验证：** `npx tsc -p packages/skill/skill-remote --noEmit` 通过；README 结构符合包规范

## T10: 全仓验证

**依赖：** T9
**步骤：**
1. `pnpm run constraints && pnpm run typecheck && pnpm run lint`
2. `pnpm run build && pnpm run hygiene`
3. `npx vitest run packages/skill/skill-remote/tests` 全绿
**验证：** 上述命令全部零错误；`pnpm run verify-cordis-catalog`（如有牵连）通过

## 执行顺序

```
T1 → T2 → T4 → T5 → T7 → T8 → T9 → T10
       ↘    ↘
       T3   T6 → T7（T6 与 T5 可并行）
```
