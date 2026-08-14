import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "skill-remote";
declare const inject: string[];
/** Public plugin configuration. */
interface Config {
  /** Unique provider name. Defaults to `remote`. */
  providerName?: string;
  /** Remote source URLs pre-registered at startup. Invalid entries are logged and skipped. */
  remotes?: string[];
  /** Skill install root. Defaults to `$DSH_HOME/skills`. */
  installRoot?: string;
}
declare const Config: z<Config>;
/** Mount the remote skill provider and the `install_skill` tool. */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, apply, inject, name };