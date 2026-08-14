import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.ts'
import type { RemoteSkillProvider } from '../src/provider.ts'

interface FakeCtx {
  skills: { registerProvider: ReturnType<typeof vi.fn> }
  tools: { register: ReturnType<typeof vi.fn> }
  effect: ReturnType<typeof vi.fn>
  logger: { warn: ReturnType<typeof vi.fn> }
}

function fakeCtx(): { ctx: FakeCtx } {
  const ctx: FakeCtx = {
    skills: { registerProvider: vi.fn() },
    tools: { register: vi.fn() },
    effect: vi.fn(() => () => {}),
    logger: { warn: vi.fn() },
  }
  return { ctx }
}

const SKILL_MD = '---\nname: docx\ndescription: Work with docx files\n---\n\n# Instructions\n'
const INSTALL_URL = 'https://github.com/acme/tools/tree/main/skills/docx'

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function stubInstallFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = urlOf(input)
    if (url === 'https://api.github.com/repos/acme/tools/contents/skills/docx?ref=main') {
      return new Response(JSON.stringify([{
        name: 'SKILL.md',
        path: 'skills/docx/SKILL.md',
        type: 'file',
        size: 100,
        download_url: null,
        content: Buffer.from(SKILL_MD).toString('base64'),
        encoding: 'base64',
      }]), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))
}

interface InstallToolShape {
  execute: (args: { url: string }, exec: object) => Promise<Record<string, unknown>>
}

function registeredProvider(ctx: FakeCtx): RemoteSkillProvider {
  const factory = ctx.skills.registerProvider.mock.calls[0]?.[0] as () => RemoteSkillProvider
  return factory()
}

function registeredTool(ctx: FakeCtx): InstallToolShape {
  return ctx.tools.register.mock.calls[0]?.[0] as InstallToolShape
}

let roots: string[] = []

beforeEach(() => { vi.unstubAllGlobals() })
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  roots = []
})

describe('apply', () => {
  it('registers the provider, pre-registers valid remotes, and skips invalid ones with a warning', () => {
    const { ctx } = fakeCtx()
    apply(ctx as unknown as Context, {
      remotes: [
        'https://github.com/acme/tools/tree/main/skills/docx',
        'https://skills.sh/acme/tools/pdf',
        'file:///etc/passwd',
      ],
    })
    expect(ctx.skills.registerProvider).toHaveBeenCalledTimes(1)
    expect(ctx.tools.register).toHaveBeenCalledTimes(1)
    expect(registeredProvider(ctx).remoteCount()).toBe(2)
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('file:///etc/passwd'))
  })

  it('parses its Config schema with defaults', () => {
    const parsed = Config({})
    expect(parsed).toMatchObject({ providerName: 'remote', remotes: [] })
    const withRemotes = Config({ remotes: ['https://skills.sh/a/b/c'] })
    expect(withRemotes.remotes).toHaveLength(1)
  })

  it('installs through the install_skill tool and registers the source', async () => {
    stubInstallFetch()
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-remote-'))
    roots.push(root)
    const { ctx } = fakeCtx()
    apply(ctx as unknown as Context, { installRoot: root })
    const tool = registeredTool(ctx)
    const exec = { signal: new AbortController().signal } as object
    const result = await tool.execute({ url: INSTALL_URL }, exec)
    expect(result).toEqual({
      skill_name: 'docx',
      target_dir: join(root, 'docx'),
      file_count: 1,
      total_bytes: expect.any(Number) as number,
    })
    expect((await readFile(join(root, 'docx', 'SKILL.md'), 'utf8'))).toBe(SKILL_MD)
    // F6: the installed source is registered with the provider afterwards.
    expect(registeredProvider(ctx).remoteCount()).toBe(1)
  })

  it('surfaces install failures as thrown errors (isError)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-remote-'))
    roots.push(root)
    const { ctx } = fakeCtx()
    apply(ctx as unknown as Context, { installRoot: root })
    const tool = registeredTool(ctx)
    const exec = { signal: new AbortController().signal } as object
    await expect(tool.execute({ url: INSTALL_URL }, exec)).rejects.toThrow()
  })
})
