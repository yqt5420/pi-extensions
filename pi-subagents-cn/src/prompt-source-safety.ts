import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type PiPromptFileName = "SYSTEM.md" | "APPEND_SYSTEM.md";

/**
 * Prevent Pi's synchronous prompt loader from opening a selected directory, FIFO, socket, device,
 * or unreadable source. Candidate order mirrors core only as a preflight guard; core still resolves
 * and loads the prompt after this check.
 */
export function assertPiPromptSourcesAreReadableFiles(
	cwd: string,
	agentDir: string,
	projectTrusted: boolean,
	fileNames: readonly PiPromptFileName[],
): void {
	for (const fileName of fileNames) {
		const candidates = [
			...(projectTrusted ? [path.join(cwd, CONFIG_DIR_NAME, fileName)] : []),
			path.join(agentDir, fileName),
		];
		for (const candidate of candidates) {
			const status = promptSourceStatus(candidate);
			if (status === "missing") continue;
			if (status === "invalid") {
				throw new Error(`Pi ${fileName} prompt source must be a readable regular file`);
			}
			break;
		}
	}
}

function promptSourceStatus(filePath: string): "missing" | "regular" | "invalid" {
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		return fs.fstatSync(descriptor).isFile() ? "regular" : "invalid";
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? (error as { code?: unknown }).code
				: undefined;
		return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "invalid";
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}
