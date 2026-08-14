/**
 * Remote skills.sh/GitHub skill provider and installer.
 *
 * This plugin contributes two things to a deployment:
 *
 * - a `ctx.skills` provider (default name `remote`) that discovers and loads
 *   skills from registered public GitHub sources, ranking below every local
 *   provider; and
 * - the model-facing `install_skill` tool, which downloads a remote skill
 *   bundle atomically into the local skills directory so the filesystem
 *   provider takes it over without a restart.
 *
 * With no `remotes` configured and no installs, the plugin performs no
 * network I/O at all.
 *
 * @module @deepseek-ai/dsh-skill-remote
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSkill } from './install.ts'
import { RemoteSkillProvider } from './provider.ts'
import { parseSkillUrl } from './url.ts'

export const name = 'skill-remote'
export const inject = ['skills', 'tools']

/** Public plugin configuration. */
export interface Config {
  /** Unique provider name. Defaults to `remote`. */
  providerName?: string
  /** Remote source URLs pre-registered at startup. Invalid entries are logged and skipped. */
  remotes?: string[]
  /** Skill install root. Defaults to `$DSH_HOME/skills`. */
  installRoot?: string
}

export const Config: Schema<Config> = z.object({
  providerName: z.string().min(1).default('remote'),
  remotes: z.array(z.string()).default([]),
  installRoot: z.string(),
})

/** Mount the remote skill provider and the `install_skill` tool. */
export function apply(ctx: Context, config: Config = {}): void {
  const provider = new RemoteSkillProvider(ctx, config.providerName ?? 'remote')

  /** Register one parsed remote source; the disposer removes it again. */
  const registerRemote = (url: string): (() => void) => {
    const source = parseSkillUrl(url)
    provider.addRemote(source)
    return () => { provider.removeRemote(url) }
  }

  ctx.skills.registerProvider(() => provider)
  ctx.effect(function* () {
    yield () => { provider.clearRemotes() }
  }, 'skill-remote sources')

  for (const url of config.remotes ?? []) {
    try {
      registerRemote(url)
    } catch (error) {
      ctx.logger.warn(`skill-remote: ignoring invalid remote ${JSON.stringify(url)}: ${errorMessage(error)}`)
    }
  }

  const installRoot = config.installRoot === undefined || config.installRoot.length === 0
    ? join(resolveDshHome(), 'skills')
    : config.installRoot

  ctx.tools.register(defineTool({
    name: 'install_skill',
    description: 'Install a skill from a public skills.sh or GitHub URL into your local skills directory so the skill tool can load it. Supports https://www.skills.sh/<owner>/<repo>/<skill>, https://github.com/<owner>/<repo>/tree/<ref>/<subpath>, and raw.githubusercontent.com URLs.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'skills.sh URL, github.com tree URL, or raw.githubusercontent.com URL of the skill to install',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill_name: { type: 'string', required: true },
          target_dir: { type: 'string', required: true },
          file_count: { type: 'number', required: true },
          total_bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Installed skill "${value.skill_name}" into ${value.target_dir} `
          + `(${value.file_count} files, ${value.total_bytes} bytes). `
          + 'It is now available through the skill tool.',
      }],
    },
    async execute(args, exec) {
      const source = parseSkillUrl(args.url)
      const report = await installSkill(source, installRoot, exec.signal)
      registerRemote(args.url)
      return {
        skill_name: report.skillName,
        target_dir: report.targetDir,
        file_count: report.fileCount,
        total_bytes: report.totalBytes,
      }
    },
  }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
