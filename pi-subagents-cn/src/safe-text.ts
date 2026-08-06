import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MAX_LINES, getAgentDir } from "@earendil-works/pi-coding-agent";
import { redactPrivateText } from "./context.js";
import { DEFAULT_MAX_OUTPUT_BYTES, TRUNCATION_MARKER, truncateUtf8 } from "./limits.js";

export const DEFAULT_MAX_OUTPUT_LINES = DEFAULT_MAX_LINES;

export function safeTerminalText(value: string): string {
	return (
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls while preserving newlines.
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "?")
			.replace(/\r/gu, "")
	);
}

export function safeTerminalLine(value: string, maxBytes = 2 * 1024): string {
	const singleLine = safeTerminalText(redactPrivateText(value)).replace(/\s+/gu, " ").trim();
	return truncateUtf8(singleLine, maxBytes).text.replace(/\s+/gu, " ").trim();
}

export function boundText(
	value: string,
	maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
	maxLines = DEFAULT_MAX_OUTPUT_LINES,
): { text: string; truncated: boolean } {
	const safe = safeTerminalText(value);
	const lines = safe.split("\n");
	const lineBounded =
		lines.length > maxLines
			? `${lines.slice(0, Math.max(0, maxLines - 1)).join("\n")}${TRUNCATION_MARKER}`
			: safe;
	const bounded = truncateUtf8(lineBounded, maxBytes);
	return { text: bounded.text, truncated: lines.length > maxLines || bounded.truncated };
}

export function boundedPrivateText(value: string, maxBytes: number): string {
	return boundText(redactPrivateText(value), maxBytes).text;
}

export function safeDisplayPath(value: string, workspace: string): string {
	if (value.startsWith("built-in:")) return safeTerminalLine(value);
	const resolved = path.resolve(value);
	const agentDir = path.resolve(getAgentDir());
	const relativeAgent = path.relative(agentDir, resolved);
	if (
		relativeAgent === "" ||
		(!relativeAgent.startsWith("..") && !path.isAbsolute(relativeAgent))
	) {
		return relativeAgent ? `~/${safeTerminalLine(relativeAgent)}` : "~";
	}
	const resolvedWorkspace = path.resolve(workspace);
	const relativeWorkspace = path.relative(resolvedWorkspace, resolved);
	if (
		relativeWorkspace === "" ||
		(!relativeWorkspace.startsWith("..") && !path.isAbsolute(relativeWorkspace))
	) {
		return relativeWorkspace ? safeTerminalLine(relativeWorkspace) : ".";
	}
	const home = path.resolve(os.homedir());
	const relativeHome = path.relative(home, resolved);
	if (relativeHome === "" || (!relativeHome.startsWith("..") && !path.isAbsolute(relativeHome))) {
		return relativeHome ? `~/${safeTerminalLine(relativeHome)}` : "~";
	}
	return safeTerminalLine(resolved);
}
