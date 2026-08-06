import * as os from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	keyHint,
	type Theme,
	type ThemeColor,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { boundedPrivateText, safeTerminalLine } from "./safe-text.js";

export const COLLAPSED_LIST_LIMIT = 5;
export const COLLAPSED_ANSWER_LINES = 3;

export interface ToolRendererContext<TArgs> {
	args: TArgs;
	isError: boolean;
}

export type RenderStatus =
	| "starting"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "idle"
	| "closed"
	| "warning";

const STATUS_PRESENTATION: Record<
	RenderStatus,
	{ icon: string; label: string; color: ThemeColor }
> = {
	starting: { icon: "⏳", label: "Starting", color: "warning" },
	running: { icon: "⏳", label: "Running", color: "warning" },
	completed: { icon: "✓", label: "Completed", color: "success" },
	failed: { icon: "✗", label: "Failed", color: "error" },
	cancelled: { icon: "■", label: "Cancelled", color: "warning" },
	interrupted: { icon: "■", label: "Interrupted", color: "warning" },
	idle: { icon: "○", label: "Idle", color: "muted" },
	closed: { icon: "✓", label: "Closed", color: "muted" },
	warning: { icon: "◐", label: "Warning", color: "warning" },
};

export function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function recordList(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.flatMap((item) => {
				const record = recordValue(item);
				return record ? [record] : [];
			})
		: [];
}

export function stringValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function numberValue(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function booleanValue(value: unknown): boolean {
	return value === true;
}

export function safeLine(value: unknown, fallback = "...", maxBytes = 2 * 1024): string {
	if (typeof value !== "string" || !value.trim()) return fallback;
	return safeTerminalLine(value, maxBytes) || fallback;
}

export function safeBlock(value: unknown, fallback = "", maxBytes = 50 * 1024): string {
	if (typeof value !== "string" || !value) return fallback;
	return boundedPrivateText(value, maxBytes);
}

export function previewLines(value: unknown, maxLines = COLLAPSED_ANSWER_LINES): string {
	const text = safeBlock(value, "", 8 * 1024).trim();
	return text.split("\n").slice(0, maxLines).join("\n");
}

export function textResult(result: AgentToolResult<unknown>): string {
	return result.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();
}

export function toolHeader(
	theme: Theme,
	toolName: string,
	primary?: unknown,
	metadata: readonly string[] = [],
): string {
	let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
	if (primary !== undefined) text += theme.fg("accent", safeLine(primary));
	const safeMetadata = metadata.filter(Boolean).map((item) => safeLine(item, "", 512));
	if (safeMetadata.length > 0) text += theme.fg("muted", ` · ${safeMetadata.join(" · ")}`);
	return text.trimEnd();
}

export function statusBadge(theme: Theme, status: RenderStatus, suffix?: string): string {
	const presentation = STATUS_PRESENTATION[status];
	const label = suffix
		? `${presentation.label} · ${safeLine(suffix, "", 2 * 1024)}`
		: presentation.label;
	return `${theme.fg(presentation.color, presentation.icon)} ${theme.fg(presentation.color, label)}`;
}

export function renderFallbackResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError = false,
) {
	const status: RenderStatus = isError ? "failed" : options.isPartial ? "running" : "completed";
	const content = safeBlock(textResult(result), "(no output)", 8 * 1024);
	return new Text(`${statusBadge(theme, status)}\n${theme.fg("toolOutput", content)}`, 0, 0);
}

export function expansionHint(): string {
	return keyHint("app.tools.expand", "to expand");
}

export interface RenderActivityItem {
	type: "text" | "toolCall";
	text?: string;
	name?: string;
	args?: Record<string, unknown>;
}

export function projectRenderActivity(value: unknown): RenderActivityItem[] {
	if (!Array.isArray(value)) return [];
	const items: RenderActivityItem[] = [];
	for (const item of value) {
		const record = recordValue(item);
		if (!record) continue;
		if (record.type === "text" && typeof record.text === "string") {
			items.push({ type: "text", text: safeBlock(record.text, "", 1024) });
			continue;
		}
		if (record.type === "toolCall" && typeof record.name === "string") {
			items.push({
				type: "toolCall",
				name: safeLine(record.name, "tool", 256),
				args: recordValue(record.args) ?? {},
			});
		}
	}
	return items;
}

export function renderActivityLines(
	items: readonly RenderActivityItem[],
	theme: Theme,
	limit?: number,
	total = items.length,
): string {
	const selected = limit === undefined ? items : items.slice(-limit);
	const lines: string[] = [];
	const skipped = Math.max(0, total - selected.length);
	if (skipped > 0) lines.push(theme.fg("muted", `… ${skipped} earlier activities`));
	for (const item of selected) {
		if (item.type === "text") {
			const text = safeBlock(item.text, "", 1024).trim();
			if (text) lines.push(theme.fg("toolOutput", text));
		} else {
			lines.push(
				theme.fg("muted", "→ ") +
					formatToolActivity(item.name ?? "tool", item.args ?? {}, theme.fg.bind(theme)),
			);
		}
	}
	return lines.join("\n");
}

export function formatToolActivity(
	toolNameValue: unknown,
	argsValue: unknown,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const toolName = safeLine(toolNameValue, "tool", 256);
	const args = recordValue(argsValue) ?? {};
	const shortenPath = (value: unknown, fallback = ".") => {
		const filePath = safeLine(value, fallback, 2 * 1024);
		const home = os.homedir();
		return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
	};

	switch (toolName) {
		case "bash": {
			const command = safeLine(args.command, "...", 512);
			return themeFg("muted", "$ ") + themeFg("toolOutput", command);
		}
		case "read": {
			const filePath = shortenPath(args.file_path ?? args.path, "...");
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const filePath = shortenPath(args.file_path ?? args.path, "...");
			const content = safeBlock(args.content, "", 2 * 1024);
			const lines = content ? content.split("\n").length : 0;
			return (
				themeFg("muted", "write ") +
				themeFg("accent", filePath) +
				(lines > 1 ? themeFg("dim", ` (${lines} lines)`) : "")
			);
		}
		case "edit":
			return (
				themeFg("muted", "edit ") +
				themeFg("accent", shortenPath(args.file_path ?? args.path, "..."))
			);
		case "ls":
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(args.path));
		case "find":
			return (
				themeFg("muted", "find ") +
				themeFg("accent", safeLine(args.pattern, "*", 512)) +
				themeFg("dim", ` in ${shortenPath(args.path)}`)
			);
		case "grep":
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${safeLine(args.pattern, "", 512)}/`) +
				themeFg("dim", ` in ${shortenPath(args.path)}`)
			);
		default: {
			let serialized = "{}";
			try {
				serialized = JSON.stringify(args);
			} catch {
				serialized = "{…}";
			}
			return themeFg("accent", toolName) + themeFg("dim", ` ${safeLine(serialized, "{}", 512)}`);
		}
	}
}
