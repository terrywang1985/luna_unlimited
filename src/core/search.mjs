import path from "node:path";
import { stat } from "node:fs/promises";

import { CoreErrorCode, coreError, normalizeCoreError } from "./errors.mjs";
import { runCapturedProcess } from "./process.mjs";

export class SearchService {
  constructor({ workspace, maxCommandOutputBytes }) {
    this.workspace = workspace;
    this.maxCommandOutputBytes = maxCommandOutputBytes;
  }

  async searchFiles({ query, path: relativePath, glob, searchType, maxResults }) {
    if (glob && (glob.includes("\0") || glob.includes("\n") || path.isAbsolute(glob))) {
      throw coreError(CoreErrorCode.INVALID_ARGUMENT, "Unsafe glob pattern");
    }

    const directory = this.workspace.resolve(relativePath);
    await this.workspace.rejectSymlinks(directory);
    const info = await stat(directory).catch((error) => { throw normalizeCoreError(error, CoreErrorCode.IO_ERROR); });
    if (!info.isDirectory()) throw coreError(CoreErrorCode.PATH_NOT_DIRECTORY, "Requested search path is not a directory");
    const directoryArgument = this.workspace.relative(directory);

    const args = searchType === "filename"
      ? ["--files", "--color", "never"]
      : ["--line-number", "--no-heading", "--color", "never", "--fixed-strings", "--max-columns", "2000"];
    if (glob) args.push("-g", glob);
    args.push(
      "-g", "!.git/**",
      "-g", "!.env",
      "-g", "!.env.*",
      "-g", "!**/.env",
      "-g", "!**/.env.*",
      "-g", "!**/.npmrc",
      "-g", "!**/.pypirc"
    );
    if (searchType === "content") args.push("--", query, directoryArgument);
    else args.push(directoryArgument);

    const output = await runCapturedProcess("rg", args, {
      cwd: this.workspace.root,
      timeoutMs: 10_000,
      maxOutputBytes: this.maxCommandOutputBytes
    });
    if (output.timedOut) throw coreError(CoreErrorCode.COMMAND_TIMEOUT, "File search timed out after 10 seconds");
    if (output.exitCode !== 0 && output.exitCode !== 1) {
      throw coreError(
        CoreErrorCode.PROCESS_FAILED,
        output.stderr.trim() || `ripgrep exited with code ${output.exitCode}`
      );
    }

    let rows = output.stdout.split(/\r?\n/).filter(Boolean);
    if (searchType === "filename") {
      const needle = query.toLocaleLowerCase();
      rows = rows.filter((row) => row.toLocaleLowerCase().includes(needle));
    }
    const truncated = rows.length > maxResults || output.stdoutTruncated;
    rows = rows.slice(0, maxResults);
    const resultText = rows.length ? rows.join("\n") : "(no matches)";
    return {
      text: `${resultText}${truncated ? "\n[results truncated]" : ""}`,
      details: { query, searchType, glob: glob || null, matches: rows.length, truncated }
    };
  }
}
