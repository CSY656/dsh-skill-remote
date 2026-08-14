# dsh-skill-remote

Remote skill source for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): discover and install skills from `skills.sh` and public GitHub repositories, directly from your agent.

- A **remote skill provider** (`ctx.skills`): candidates discovered from `skills.sh` / `github.com` URLs appear in the session skill catalog beside local skills; bodies load on demand.
- An **`install_skill` tool** for the model: downloads a skill bundle atomically into `$DSH_HOME/skills/<name>/`, where the built-in filesystem provider takes it over — no restart needed.

Zero configuration: with no remotes configured and no installs, the plugin performs no network I/O.

## Install

Requires the DeepSeek Harness `next` line (`dsh` ≥ 0.1.0-rc.6, which ships `dsh-skill` 0.1.0-rc.6). From GitHub (sources; pnpm builds via `prepare`):

```sh
dsh plugin --profile default add github:you/dsh-skill-remote
```

pnpm ≥ 10 asks you to allow the build — add the printed package key to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-skill-remote: true
```

Then re-run the `add`. (Treat the allowance as permission to run this package's build on your machine; pin a commit if you prefer: `github:you/dsh-skill-remote#<sha>`.)

From npm (prebuilt, no build permission needed):

```sh
dsh plugin --profile default add dsh-skill-remote
```

## Usage

Say to the agent:

> Install the skill at https://github.com/anthropics/skills/tree/main/skills/docx

The model calls `install_skill`, and the skill becomes available through the `skill` tool immediately. You can also pre-register read-only remote sources:

```yaml
# profile cordis.patch.yml
- update:
    - id: skill-remote
      config:
        remotes:
          - https://github.com/anthropics/skills/tree/main/skills/docx
```

Supported URL shapes: `https://www.skills.sh/<owner>/<repo>/<skill>`, `https://github.com/<owner>/<repo>/tree/<ref>/<subpath>`, `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<subpath>/<file>`.

## Safety limits (hard-coded)

| Limit | Value |
|---|---|
| Single file | 1 MiB |
| Whole bundle | 8 MiB |
| File count | 64 |
| Recursion depth | 4 |
| Request timeout | 30 s |
| Path escape (`..`, `/`, `\` in entry names) | rejected |
| Symlinks / submodules | skipped |

Installs are atomic: the bundle downloads into a sibling staging directory and is renamed into place only after it validates (`SKILL.md` present); any failure removes the staging directory. Public repositories only — no token is read, stored, or sent.

## Configuration

```ts
interface Config {
  providerName?: string   // default 'remote'
  remotes?: string[]      // URLs pre-registered at startup
  installRoot?: string    // default $DSH_HOME/skills
}
```

## Known limitations

- **Public repositories only** — no OAuth/private repos; unauthenticated GitHub API rate limits (60 req/h per IP) apply.
- **Direct-children discovery only** — like the built-in filesystem provider, remote sources are not scanned recursively.
- **No version pinning** — every load fetches the current ref tip; installation is the only persistence.

## Contributing to the ecosystem

- The repository is tagged with the `dsh-plugin` topic — [browse other plugins](https://github.com/topics/dsh-plugin) and add yours.
- Found a bug or want a feature? Open an issue or PR; tests run with `pnpm install && pnpm test`.
- The behavior ported here comes from [CsyCode](https://github.com/you/csycode) chapter 11's remote skill installer.

## License

MIT
