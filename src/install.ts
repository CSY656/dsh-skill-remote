/**
 * Atomic remote skill installation.
 *
 * Downloads a complete skill bundle into a sibling staging directory and
 * renames it into place only after the download validates, so a failed or
 * aborted install never leaves a partial directory behind.
 *
 * @module @deepseek-ai/dsh-skill-remote
 */

import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { walkAndDownload, type DownloadProgress } from './github.ts'
import type { RemoteSkillSource } from './url.ts'

/** Post-install summary returned to callers. */
export interface InstallReport {
  /** The installed skill's name (the bundle directory name). */
  skillName: string
  /** Absolute directory the bundle now lives in. */
  targetDir: string
  /** Number of files written. */
  fileCount: number
  /** Total bytes written. */
  totalBytes: number
}

const VALID_NAME = /^[a-z0-9][a-z0-9\-_]*$/

/**
 * Validate a skill name used as a directory name: lowercase letters, digits,
 * `-` and `_`, never starting with `.`.
 *
 * @throws {Error} when the name is empty or contains illegal characters.
 */
export function validateSkillName(name: string): void {
  if (name.length === 0) throw new Error('skill name is empty')
  if (name.startsWith('.')) throw new Error(`skill name must not start with '.': ${JSON.stringify(name)}`)
  if (!VALID_NAME.test(name)) {
    throw new Error(`skill name ${JSON.stringify(name)} contains illegal characters (a-z 0-9 - _ only)`)
  }
}

/**
 * Install a remote skill bundle atomically into `installRoot/<name>/`.
 *
 * The whole download lands in a sibling staging directory first; only a
 * bundle containing a `SKILL.md` manifest is renamed into place, replacing
 * any previous install. On any failure the staging directory is removed and
 * the error rethrown.
 *
 * @param source - the parsed remote source.
 * @param installRoot - the directory that receives `<name>/`.
 * @param signal - caller cancellation, combined with the fixed HTTP timeout.
 * @returns the {@link InstallReport}.
 */
export async function installSkill(
  source: RemoteSkillSource,
  installRoot: string,
  signal?: AbortSignal,
): Promise<InstallReport> {
  validateSkillName(source.name)
  await mkdir(installRoot, { recursive: true })
  const staging = await mkdtemp(join(installRoot, `.install-${source.name}-`))
  const progress: DownloadProgress = { fileCount: 0, totalBytes: 0 }
  try {
    await walkAndDownload(source, source.subpath, staging, progress, 0, signal)
    if (!(await hasSkillManifest(staging))) {
      throw new Error('downloaded directory has no SKILL.md — not a valid skill bundle')
    }
    const final = join(installRoot, source.name)
    await rm(final, { recursive: true, force: true })
    await rename(staging, final)
    return {
      skillName: source.name,
      targetDir: final,
      fileCount: progress.fileCount,
      totalBytes: progress.totalBytes,
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

async function hasSkillManifest(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).includes('SKILL.md')
  } catch {
    return false
  }
}
