import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { isSkillName } from "@deepseek-ai/dsh-skill";
//#region src/github.ts
/**
* GitHub Contents API client with hard download safety limits.
*
* Every request is bounded by {@link HTTP_TIMEOUT_MS} and the caller's
* AbortSignal. Recursive downloads enforce the file-size, total-size,
* file-count, recursion-depth, and path-escape limits that keep a hostile or
* broken remote bundle from exhausting disk or escaping its install root.
*
* @module @deepseek-ai/dsh-skill-remote
*/
/** Single-file cap: 1 MiB. */
const MAX_FILE_SIZE = 1 << 20;
/** Whole-bundle cap: 8 MiB. */
const MAX_TOTAL_SIZE = 8 << 20;
/** Maximum files per bundle. */
const MAX_FILE_COUNT = 64;
/** Maximum directory nesting below the bundle root. */
const MAX_RECURSION_DEPTH = 4;
/** Per-request timeout. */
const HTTP_TIMEOUT_MS = 3e4;
const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "dsh-skill-remote";
const ACCEPT = "application/vnd.github+json";
function requestSignal(signal) {
	const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
	return signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
}
/**
* List a repository directory through the GitHub Contents API.
*
* @param source - the parsed remote source.
* @param subpath - repository-relative directory path.
* @param signal - caller cancellation, combined with the fixed timeout.
* @returns the parsed entry list.
* @throws {Error} on non-200 responses or rate limiting.
*/
async function listContents(source, subpath, signal) {
	const url = `${GITHUB_API_BASE}/repos/${source.owner}/${source.repo}/contents/${subpath}?ref=${encodeURIComponent(source.ref)}`;
	const response = await fetch(url, {
		headers: {
			Accept: ACCEPT,
			"User-Agent": USER_AGENT
		},
		signal: requestSignal(signal)
	});
	if (response.status === 403) throw new Error(`GitHub API denied access (rate-limited?) for ${url}`);
	if (response.status !== 200) throw new Error(`GitHub API returned ${response.status} for ${url}`);
	return parseEntries(await response.json());
}
/**
* Download one file, preferring the inline base64 payload over a second
* request to `download_url`.
*
* @param entry - the Contents API entry for a file.
* @param signal - caller cancellation, combined with the fixed timeout.
* @returns the decoded bytes.
* @throws {Error} when the file exceeds {@link MAX_FILE_SIZE} or download fails.
*/
async function fetchBlob(entry, signal) {
	if (entry.size > MAX_FILE_SIZE) throw new Error(`file ${entry.path} is too large: ${entry.size} bytes (max ${MAX_FILE_SIZE})`);
	if (entry.encoding === "base64" && entry.content !== void 0 && entry.content.length > 0) return Buffer.from(entry.content.replace(/\n/g, ""), "base64");
	if (entry.download_url === null || entry.download_url.length === 0) throw new Error(`no download_url for ${entry.path}`);
	const response = await fetch(entry.download_url, {
		headers: { "User-Agent": USER_AGENT },
		signal: requestSignal(signal)
	});
	if (response.status !== 200) throw new Error(`download failed for ${entry.path}: status ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}
/**
* Recursively download a bundle directory into `localDir`, enforcing every
* safety limit. `symlink` and `submodule` entries are skipped silently.
*
* @param source - the parsed remote source.
* @param subpath - repository-relative directory path to walk.
* @param localDir - local directory receiving the files.
* @param progress - shared download counters.
* @param depth - current nesting depth (0 at the bundle root).
* @param signal - caller cancellation, combined with the fixed timeout.
*/
async function walkAndDownload(source, subpath, localDir, progress, depth, signal) {
	signal?.throwIfAborted();
	if (depth > MAX_RECURSION_DEPTH) throw new Error(`directory nesting too deep (max ${MAX_RECURSION_DEPTH})`);
	const entries = await listContents(source, subpath, signal);
	for (const entry of entries) {
		signal?.throwIfAborted();
		if (progress.fileCount >= MAX_FILE_COUNT) throw new Error(`file count exceeds ${MAX_FILE_COUNT}`);
		if (entry.name.includes("..") || entry.name.includes("/") || entry.name.includes("\\")) throw new Error(`suspicious file name ${JSON.stringify(entry.name)}`);
		if (entry.type === "file") {
			const data = await fetchBlob(entry, signal);
			if (progress.totalBytes + data.length > MAX_TOTAL_SIZE) throw new Error(`total size exceeds ${MAX_TOTAL_SIZE} bytes`);
			await mkdir(localDir, { recursive: true });
			await writeFile(join(localDir, entry.name), data);
			progress.fileCount += 1;
			progress.totalBytes += data.length;
		} else if (entry.type === "dir") {
			await mkdir(join(localDir, entry.name), { recursive: true });
			await walkAndDownload(source, entry.path, join(localDir, entry.name), progress, depth + 1, signal);
		}
	}
}
function parseEntries(data) {
	if (!Array.isArray(data)) throw new Error("GitHub API returned a non-array contents payload");
	return data.map((entry) => {
		if (typeof entry !== "object" || entry === null) throw new Error("GitHub API returned a malformed contents entry");
		const record = entry;
		return {
			name: stringValue(record, "name"),
			path: stringValue(record, "path"),
			type: stringValue(record, "type"),
			size: typeof record.size === "number" ? record.size : 0,
			download_url: typeof record.download_url === "string" ? record.download_url : null,
			...typeof record.content === "string" ? { content: record.content } : {},
			...typeof record.encoding === "string" ? { encoding: record.encoding } : {}
		};
	});
}
function stringValue(record, key) {
	const value = record[key];
	return typeof value === "string" ? value : "";
}
//#endregion
//#region src/install.ts
/**
* Atomic remote skill installation.
*
* Downloads a complete skill bundle into a sibling staging directory and
* renames it into place only after the download validates, so a failed or
* aborted install never leaves a partial directory behind.
*
* @module @deepseek-ai/dsh-skill-remote
*/
const VALID_NAME = /^[a-z0-9][a-z0-9\-_]*$/;
/**
* Validate a skill name used as a directory name: lowercase letters, digits,
* `-` and `_`, never starting with `.`.
*
* @throws {Error} when the name is empty or contains illegal characters.
*/
function validateSkillName(name) {
	if (name.length === 0) throw new Error("skill name is empty");
	if (name.startsWith(".")) throw new Error(`skill name must not start with '.': ${JSON.stringify(name)}`);
	if (!VALID_NAME.test(name)) throw new Error(`skill name ${JSON.stringify(name)} contains illegal characters (a-z 0-9 - _ only)`);
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
async function installSkill(source, installRoot, signal) {
	validateSkillName(source.name);
	await mkdir(installRoot, { recursive: true });
	const staging = await mkdtemp(join(installRoot, `.install-${source.name}-`));
	const progress = {
		fileCount: 0,
		totalBytes: 0
	};
	try {
		await walkAndDownload(source, source.subpath, staging, progress, 0, signal);
		if (!await hasSkillManifest(staging)) throw new Error("downloaded directory has no SKILL.md — not a valid skill bundle");
		const final = join(installRoot, source.name);
		await rm(final, {
			recursive: true,
			force: true
		});
		await rename(staging, final);
		return {
			skillName: source.name,
			targetDir: final,
			fileCount: progress.fileCount,
			totalBytes: progress.totalBytes
		};
	} catch (error) {
		await rm(staging, {
			recursive: true,
			force: true
		});
		throw error;
	}
}
async function hasSkillManifest(directory) {
	try {
		return (await readdir(directory)).includes("SKILL.md");
	} catch {
		return false;
	}
}
//#endregion
//#region src/frontmatter.ts
/**
* SKILL.md YAML frontmatter parsing for remote skills.
*
* Mirrors the local `dsh-skill-filesystem` semantics (same required fields,
* same invocation-policy keys) so a skill behaves identically whether it is
* discovered remotely or read from disk.
*
* @module @deepseek-ai/dsh-skill-remote
*/
/**
* Split a SKILL.md document into its frontmatter mapping and body.
*
* @param raw - complete file text.
* @returns `{ data, body }`, or `undefined` when the document has no valid
*   frontmatter block (missing opener, missing closer, or non-mapping YAML).
*/
function parseFrontmatter(raw) {
	const firstLineEnd = raw.indexOf("\n");
	if (firstLineEnd < 0) return void 0;
	if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return void 0;
	const start = firstLineEnd + 1;
	const closing = findClosingFrontmatter(raw, start);
	if (closing === void 0) return void 0;
	let parsed;
	try {
		parsed = parse(raw.slice(start, closing.start));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	return {
		data: parsed,
		body: raw.slice(closing.bodyStart)
	};
}
/**
* Extract and validate the skill metadata a candidate needs.
*
* @param data - the frontmatter mapping.
* @returns the parsed {@link SkillMeta}, or `undefined` when the required
*   `name`/`description` fields are missing, invalid, or the invocation
*   policy keys are malformed.
*/
function parseSkillMeta(data) {
	const name = stringField(data, "name");
	const description = stringField(data, "description");
	if (name === void 0 || description === void 0) return void 0;
	if (!isSkillName(name)) return void 0;
	let invocation;
	try {
		invocation = parseInvocationPolicy(data);
	} catch {
		return;
	}
	return {
		name,
		description,
		...optionalString(data, "whenToUse"),
		invocation
	};
}
function findClosingFrontmatter(raw, start) {
	let lineStart = start;
	while (lineStart <= raw.length) {
		const nextNewline = raw.indexOf("\n", lineStart);
		const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
		if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") return {
			start: lineStart,
			bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1
		};
		if (nextNewline < 0) return void 0;
		lineStart = nextNewline + 1;
	}
}
function stringField(data, key) {
	const value = data[key];
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function optionalString(data, key) {
	const value = data[key];
	return typeof value === "string" && value.length > 0 ? { [key]: value } : {};
}
function parseInvocationPolicy(data) {
	const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
	const userInvocable = frontmatterBoolean(data, "user-invocable");
	return {
		modelInvocable: disableModelInvocation !== true,
		userInvocable: userInvocable !== false
	};
}
function frontmatterBoolean(data, key) {
	if (!Object.hasOwn(data, key)) return void 0;
	const value = data[key];
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1") return true;
	if (value === 0 || value === "0") return false;
	if (typeof value === "string") switch (value.toLowerCase()) {
		case "true":
		case "yes":
		case "on": return true;
		case "false":
		case "no":
		case "off": return false;
	}
	throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}
//#endregion
//#region src/provider.ts
/** Remote candidates rank below every shipped local root (100-600). */
const REMOTE_RANK = 900;
/**
* Provider that maps registered public GitHub skill sources into `ctx.skills`.
*/
var RemoteSkillProvider = class {
	ctx;
	name;
	remotes = /* @__PURE__ */ new Map();
	constructor(ctx, name = "remote") {
		this.ctx = ctx;
		this.name = name;
	}
	/** Register one remote source; the map key is the normalized original URL. */
	addRemote(source) {
		this.remotes.set(normalizeRemoteKey(source.original), source);
	}
	/** Remove one remote source by its original URL. */
	removeRemote(url) {
		this.remotes.delete(normalizeRemoteKey(url));
	}
	/** Drop every registered remote source (plugin teardown). */
	clearRemotes() {
		this.remotes.clear();
	}
	/** Number of registered remote sources (exposed for tests). */
	remoteCount() {
		return this.remotes.size;
	}
	/**
	* Discover candidates from every registered source. One failing source is
	* logged and skipped; the others still contribute.
	*/
	async list(options) {
		const candidates = [];
		for (const source of this.remotes.values()) {
			options.signal?.throwIfAborted();
			try {
				const entries = await listContents(source, source.subpath, options.signal);
				for (const entry of sortedEntries(entries)) {
					options.signal?.throwIfAborted();
					const file = skillFileOf(source, entry);
					if (file === void 0) continue;
					const candidate = await this.candidateFromFile(source, file, options.signal);
					if (candidate !== void 0) candidates.push(candidate);
				}
			} catch (error) {
				this.ctx.logger.warn(`skill-remote: source ${source.original} failed: ${errorMessage$1(error)}`);
			}
		}
		return candidates;
	}
	/**
	* Load one candidate's SKILL.md body over the network.
	*/
	async get(candidate, options) {
		options.signal?.throwIfAborted();
		const locator = candidate.locator;
		const parsed = await this.fetchRemoteText(locator.rawUrl, options.signal);
		if (parsed === void 0) return void 0;
		return {
			name: parsed.name,
			description: parsed.description,
			...parsed.whenToUse !== void 0 ? { whenToUse: parsed.whenToUse } : {},
			invocation: parsed.invocation,
			source: candidate.source,
			provider: this.name,
			resourceBase: {
				kind: "url",
				url: locator.rawUrl
			},
			content: parsed.body.trim()
		};
	}
	async candidateFromFile(source, entryPath, signal) {
		signal?.throwIfAborted();
		const rawUrl = rawUrlOf(source, entryPath);
		const parsed = await this.fetchRemoteText(rawUrl, signal);
		if (parsed === void 0) return void 0;
		const locator = {
			source,
			entryPath,
			rawUrl
		};
		return {
			name: parsed.name,
			description: parsed.description,
			...parsed.whenToUse !== void 0 ? { whenToUse: parsed.whenToUse } : {},
			invocation: parsed.invocation,
			provider: this.name,
			source: REMOTE_SOURCE,
			rank: REMOTE_RANK,
			locator,
			resourceBase: {
				kind: "url",
				url: rawUrl
			}
		};
	}
	async fetchRemoteText(rawUrl, signal) {
		let raw;
		try {
			const response = await fetch(rawUrl, {
				headers: { "User-Agent": "dsh-skill-remote" },
				signal: signal === void 0 ? AbortSignal.timeout(3e4) : AbortSignal.any([signal, AbortSignal.timeout(3e4)])
			});
			if (response.status !== 200) return void 0;
			raw = await response.text();
		} catch (error) {
			if (signal?.aborted === true) throw error;
			return;
		}
		signal?.throwIfAborted();
		const frontmatter = parseFrontmatter(raw);
		if (frontmatter === void 0) return void 0;
		const meta = parseSkillMeta(frontmatter.data);
		if (meta === void 0) return void 0;
		return {
			...meta,
			body: frontmatter.body
		};
	}
};
const REMOTE_SOURCE = "remote";
/**
* Map one Contents API entry to the SKILL.md file it represents:
* directories contribute `<entry>/SKILL.md`, flat `.md` files contribute
* themselves. Everything else is skipped.
*/
function skillFileOf(source, entry) {
	if (entry.type === "dir") return `${source.subpath}/${entry.name}/SKILL.md`;
	if (entry.type === "file" && entry.name.endsWith(".md")) return entry.path;
}
function sortedEntries(entries) {
	return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}
function rawUrlOf(source, entryPath) {
	return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${entryPath}`;
}
function normalizeRemoteKey(url) {
	return url.trim().toLowerCase();
}
function errorMessage$1(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/url.ts
function splitPath(url) {
	return url.pathname.split("/").filter((segment) => segment.length > 0);
}
function requireSegment(segments, index, context) {
	const segment = segments[index];
	if (segment === void 0 || segment.length === 0) throw new Error(`skill URL is malformed: ${context}`);
	return segment;
}
/**
* Parse a user-supplied skill URL into a {@link RemoteSkillSource}.
*
* @param raw - the URL string (skills.sh, github.com tree, or raw.githubusercontent.com).
* @returns the parsed source description.
* @throws {Error} when the URL is unsupported, not http(s), or malformed.
*/
function parseSkillUrl(raw) {
	const trimmed = raw.trim();
	let url;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`invalid skill URL: ${JSON.stringify(trimmed)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`skill URL must use http(s), got "${url.protocol}"`);
	const host = url.hostname.toLowerCase();
	const parts = splitPath(url);
	if (host === "skills.sh" || host === "www.skills.sh") {
		if (parts.length < 3) throw new Error("skills.sh URL must be /<owner>/<repo>/<skill-name>");
		const owner = requireSegment(parts, 0, "missing owner");
		const repo = requireSegment(parts, 1, "missing repo");
		const rest = parts.slice(2);
		return {
			owner,
			repo,
			ref: "main",
			subpath: `skills/${rest.join("/")}`,
			name: rest[rest.length - 1] ?? "",
			original: trimmed
		};
	}
	if (host === "github.com") {
		if (parts.length < 5 || parts[2] !== "tree") throw new Error("github.com URL must be /<owner>/<repo>/tree/<ref>/<subpath>");
		return {
			owner: requireSegment(parts, 0, "missing owner"),
			repo: requireSegment(parts, 1, "missing repo"),
			ref: requireSegment(parts, 3, "missing ref"),
			subpath: parts.slice(4).join("/"),
			name: parts[parts.length - 1] ?? "",
			original: trimmed
		};
	}
	if (host === "raw.githubusercontent.com") {
		if (parts.length < 4) throw new Error("raw.githubusercontent.com URL is too short (expected /<owner>/<repo>/<ref>/<subpath>[/<file>])");
		const owner = requireSegment(parts, 0, "missing owner");
		const repo = requireSegment(parts, 1, "missing repo");
		const ref = requireSegment(parts, 2, "missing ref");
		let subParts = parts.slice(3);
		if ((subParts[subParts.length - 1] ?? "").includes(".")) subParts = subParts.slice(0, -1);
		if (subParts.length === 0) throw new Error("raw URL is missing the skill subpath");
		return {
			owner,
			repo,
			ref,
			subpath: subParts.join("/"),
			name: subParts[subParts.length - 1] ?? "",
			original: trimmed
		};
	}
	throw new Error(`unsupported skill URL host "${host}" (use skills.sh, github.com, or raw.githubusercontent.com)`);
}
//#endregion
//#region src/index.ts
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
const name = "skill-remote";
const inject = ["skills", "tools"];
const Config = z.object({
	providerName: z.string().min(1).default("remote"),
	remotes: z.array(z.string()).default([]),
	installRoot: z.string()
});
/** Mount the remote skill provider and the `install_skill` tool. */
function apply(ctx, config = {}) {
	const provider = new RemoteSkillProvider(ctx, config.providerName ?? "remote");
	/** Register one parsed remote source; the disposer removes it again. */
	const registerRemote = (url) => {
		const source = parseSkillUrl(url);
		provider.addRemote(source);
		return () => {
			provider.removeRemote(url);
		};
	};
	ctx.skills.registerProvider(() => provider);
	ctx.effect(function* () {
		yield () => {
			provider.clearRemotes();
		};
	}, "skill-remote sources");
	for (const url of config.remotes ?? []) try {
		registerRemote(url);
	} catch (error) {
		ctx.logger.warn(`skill-remote: ignoring invalid remote ${JSON.stringify(url)}: ${errorMessage(error)}`);
	}
	const installRoot = config.installRoot === void 0 || config.installRoot.length === 0 ? join(resolveDshHome(), "skills") : config.installRoot;
	ctx.tools.register(defineTool({
		name: "install_skill",
		description: "Install a skill from a public skills.sh or GitHub URL into your local skills directory so the skill tool can load it. Supports https://www.skills.sh/<owner>/<repo>/<skill>, https://github.com/<owner>/<repo>/tree/<ref>/<subpath>, and raw.githubusercontent.com URLs.",
		parameters: { url: {
			type: "string",
			required: true,
			description: "skills.sh URL, github.com tree URL, or raw.githubusercontent.com URL of the skill to install"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					skill_name: {
						type: "string",
						required: true
					},
					target_dir: {
						type: "string",
						required: true
					},
					file_count: {
						type: "number",
						required: true
					},
					total_bytes: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Installed skill "${value.skill_name}" into ${value.target_dir} (${value.file_count} files, ${value.total_bytes} bytes). It is now available through the skill tool.`
			}]
		},
		async execute(args, exec) {
			const report = await installSkill(parseSkillUrl(args.url), installRoot, exec.signal);
			registerRemote(args.url);
			return {
				skill_name: report.skillName,
				target_dir: report.targetDir,
				file_count: report.fileCount,
				total_bytes: report.totalBytes
			};
		}
	}));
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
export { Config, apply, inject, name };
