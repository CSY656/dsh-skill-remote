# dsh-skill-remote Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性
- [ ] 三种远程 URL 解析为正确的 owner/repo/ref/subpath（验证：`npx vitest run packages/skill/skill-remote/tests/url.spec.ts` 全绿）
- [ ] GitHub 客户端安全限额生效——单文件/总量/文件数/深度超限与路径逃逸均被拒绝（验证：github.spec.ts 全绿）
- [ ] RemoteSkillProvider 的 list 产出候选、get 返回正文、单源失败不拖垮整体（验证：provider.spec.ts 全绿）
- [ ] 安装器原子安装——成功落位、失败无 staging 残留、缺 SKILL.md 拒绝（验证：install.spec.ts 全绿）
- [ ] `install_skill` 工具注册并可执行完整安装流程（验证：index.spec.ts 全绿）

## 集成
- [ ] remote provider 与 filesystem provider 并列出现在 catalog（验证：index.spec.ts 集成用例观察 list 合并）
- [ ] 安装完成后无需重启，catalog 快照即出现新 skill（验证：安装调用后再次 snapshot 断言新增条目）

## 编译与测试
- [ ] `pnpm run constraints` 通过
- [ ] `pnpm run typecheck` 通过
- [ ] `pnpm run lint` 通过
- [ ] `pnpm run build` 通过
- [ ] `pnpm run hygiene` 通过
- [ ] 单包全部测试通过（`npx vitest run packages/skill/skill-remote/tests`）

## 端到端场景
- [ ] 场景 1（有网环境）：`install_skill` 安装一个真实 GitHub 上的 skill → `<dshHome>/skills/<name>/` 出现完整文件 → catalog 出现该 skill → `skill` 工具可加载其正文
- [ ] 场景 2：传入非法 URL（如 `file:///etc/passwd`）→ 工具返回 isError 结构化错误，进程不崩
- [ ] 场景 3：零配置启动（无 remotes、不装任何东西）→ remote provider 不发任何网络请求，catalog 与未装本包时一致
