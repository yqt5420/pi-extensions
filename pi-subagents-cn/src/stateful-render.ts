import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	COLLAPSED_LIST_LIMIT,
	expansionHint,
	type RenderStatus,
	recordList,
	recordValue,
	renderFallbackResult,
	safeBlock,
	safeLine,
	statusBadge,
	stringValue,
	type ToolRendererContext,
	textResult,
	toolHeader,
} from "./render-common.js";

export type StatefulRenderTool = "spawn" | "send" | "manage" | "mailbox";

export function createStatefulToolRenderer(tool: StatefulRenderTool) {
	return {
		renderCall(args: unknown, theme: Theme) {
			return renderStatefulCall(tool, recordValue(args) ?? {}, theme);
		},
		renderResult(
			result: AgentToolResult<unknown>,
			options: ToolRenderResultOptions,
			theme: Theme,
			context: ToolRendererContext<unknown>,
		) {
			return renderStatefulResult(tool, result, options, theme, context);
		},
	};
}

function renderStatefulCall(tool: StatefulRenderTool, args: Record<string, unknown>, theme: Theme) {
	if (tool === "spawn") {
		const metadata = [
			`[${safeLine(args.agentScope, "user", 64)}]`,
			"detached",
			safeLine(args.workspaceMode, "shared", 64),
		];
		if (typeof args.thinkingLevel === "string") metadata.push(`thinking:${args.thinkingLevel}`);
		return new Text(
			[
				toolHeader(theme, "subagent_spawn", args.agent, metadata),
				`  ${theme.fg("dim", safeLine(args.task, "...", 2 * 1024))}`,
			].join("\n"),
			0,
			0,
		);
	}
	if (tool === "send") {
		return new Text(
			[
				toolHeader(theme, "subagent_send", args.agentId, ["follow-up"]),
				`  ${theme.fg("dim", safeLine(args.task, "...", 2 * 1024))}`,
			].join("\n"),
			0,
			0,
		);
	}
	if (tool === "manage") {
		const metadata: string[] = [];
		if (typeof args.agentId === "string") metadata.push(`id:${safeLine(args.agentId, "", 256)}`);
		if (args.subtree === true) metadata.push("subtree");
		if (args.includeClosed === true) metadata.push("include closed");
		return new Text(toolHeader(theme, "subagent_manage", args.action, metadata), 0, 0);
	}
	const metadata = [`id:${safeLine(args.agentId, "...", 256)}`];
	if (args.action === "read") {
		metadata.push(args.acknowledge === false ? "leave unread" : "acknowledge");
	}
	const lines = [toolHeader(theme, "subagent_mailbox", args.action, metadata)];
	if (args.action === "send") {
		lines.push(`  ${theme.fg("dim", safeLine(args.message, "...", 2 * 1024))}`);
	}
	return new Text(lines.join("\n"), 0, 0);
}

function renderStatefulResult(
	tool: StatefulRenderTool,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRendererContext<unknown>,
) {
	const details = recordValue(result.details);
	const args = recordValue(context.args) ?? {};
	if (!details) return renderFallbackResult(result, options, theme, context.isError);
	if (tool === "spawn" || tool === "send") {
		const agent = recordValue(details.agent);
		if (!agent) return renderFallbackResult(result, options, theme, context.isError);
		return new Text(renderAgentResult(agent, result, options.expanded, theme), 0, 0);
	}
	if (tool === "manage") {
		return new Text(renderManageResult(args, details, result, options.expanded, theme), 0, 0);
	}
	return new Text(renderMailboxResult(args, details, options.expanded, theme), 0, 0);
}

function renderAgentResult(
	agent: Record<string, unknown>,
	result: AgentToolResult<unknown>,
	expanded: boolean,
	theme: Theme,
): string {
	const state = safeLine(agent.state, "unknown", 128);
	const lines = [
		`${statusBadge(theme, lifecycleStatus(state))} · ${theme.fg("accent", safeLine(agent.id, "agent", 256))} · ${theme.fg("toolOutput", safeLine(agent.agent, "subagent", 256))} · ${theme.fg("muted", state)}`,
	];
	const thinking = stringValue(agent.thinkingLevel);
	const unread = typeof agent.unreadMessages === "number" ? agent.unreadMessages : 0;
	if (thinking || unread > 0) {
		lines.push(
			theme.fg(
				"dim",
				[thinking && `thinking:${safeLine(thinking, "", 128)}`, unread > 0 && `unread:${unread}`]
					.filter(Boolean)
					.join(" · "),
			),
		);
	}
	if (expanded) {
		const task = safeBlock(agent.currentTask, "", 2 * 1024).trim();
		const error = safeBlock(agent.error, "", 2 * 1024).trim();
		if (task) lines.push(theme.fg("dim", `task: ${task}`));
		if (error) lines.push(theme.fg("error", `error: ${error}`));
		const content = safeBlock(textResult(result), "", 8 * 1024).trim();
		if (content) lines.push(theme.fg("toolOutput", content));
	} else lines.push(expansionHint());
	return lines.join("\n");
}

function renderManageResult(
	args: Record<string, unknown>,
	details: Record<string, unknown>,
	result: AgentToolResult<unknown>,
	expanded: boolean,
	theme: Theme,
): string {
	const action = safeLine(args.action, "action", 128);
	const agents = recordList(details.agents);
	const primary = recordValue(details.agent);
	if (action === "list") {
		const lines = [
			`${statusBadge(theme, "completed")} · list · ${agents.length} agent${agents.length === 1 ? "" : "s"}`,
		];
		const selected = expanded ? agents : agents.slice(0, COLLAPSED_LIST_LIMIT);
		for (const agent of selected) lines.push(formatAgentLine(agent, theme, expanded));
		if (agents.length === 0) lines.push(theme.fg("muted", "(no retained agents)"));
		if (agents.length > selected.length)
			lines.push(theme.fg("muted", `… ${agents.length - selected.length} omitted`));
		if (!expanded && agents.length > 0) lines.push(expansionHint());
		return lines.join("\n");
	}

	const subtree = args.subtree === true;
	const affected = subtree ? agents.length : agents.length > 0 ? agents.length : primary ? 1 : 0;
	const status: RenderStatus = action === "interrupt" ? "interrupted" : "closed";
	const lines = [
		`${statusBadge(theme, status)} · ${affected} agent${affected === 1 ? "" : "s"}${subtree ? theme.fg("muted", " · subtree") : ""}`,
	];
	const selected = agents.length > 0 ? agents : !subtree && primary ? [primary] : [];
	for (const agent of expanded ? selected : selected.slice(0, COLLAPSED_LIST_LIMIT)) {
		lines.push(formatAgentLine(agent, theme, expanded));
	}
	if (selected.length === 0) {
		const content = safeBlock(textResult(result), "(no output)", 8 * 1024);
		lines.push(theme.fg("toolOutput", content));
	}
	if (!expanded && selected.length > 0) lines.push(expansionHint());
	return lines.join("\n");
}

function renderMailboxResult(
	args: Record<string, unknown>,
	details: Record<string, unknown>,
	expanded: boolean,
	theme: Theme,
): string {
	const action = safeLine(args.action, "action", 64);
	if (action === "send") {
		const message = recordValue(details.message);
		if (!message) return `${statusBadge(theme, "completed")} · 排队消息`;
		const lines = [
			`${theme.fg("success", "✓")} ${theme.fg("success", "Queued")} · ${theme.fg("accent", safeLine(message.id, "message", 256))} · ${theme.fg("muted", `to ${safeLine(message.recipientId, safeLine(args.agentId), 256)}`)}`,
		];
		if (expanded) {
			lines.push(theme.fg("toolOutput", safeBlock(message.content, "(empty message)", 2 * 1024)));
		} else lines.push(expansionHint());
		return lines.join("\n");
	}

	const messages = recordList(details.messages);
	const acknowledged = args.acknowledge === false ? "left unread" : "acknowledged";
	const lines = [
		`${statusBadge(theme, "completed")} · ${messages.length} message${messages.length === 1 ? "" : "s"} · ${acknowledged}`,
	];
	const selected = expanded ? messages : messages.slice(0, COLLAPSED_LIST_LIMIT);
	for (const message of selected) {
		const content = expanded
			? safeBlock(message.content, "(empty message)", 2 * 1024)
			: safeLine(message.content, "(empty message)", 512);
		lines.push(
			`${theme.fg("muted", "• ")}${theme.fg("accent", safeLine(message.id, "message", 256))} ${theme.fg("muted", `from ${safeLine(message.senderId, "unknown", 256)}: `)}${theme.fg("toolOutput", content)}`,
		);
	}
	if (messages.length === 0) lines.push(theme.fg("muted", "(no unread messages)"));
	if (messages.length > selected.length)
		lines.push(theme.fg("muted", `… ${messages.length - selected.length} omitted`));
	if (!expanded && messages.length > 0) lines.push(expansionHint());
	return lines.join("\n");
}

function formatAgentLine(agent: Record<string, unknown>, theme: Theme, expanded: boolean): string {
	const unread = typeof agent.unreadMessages === "number" ? agent.unreadMessages : 0;
	const lines = [
		`${theme.fg("muted", "• ")}${theme.fg("accent", safeLine(agent.id, "agent", 256))} ${theme.fg("toolOutput", safeLine(agent.agent, "subagent", 256))} ${theme.fg("muted", safeLine(agent.state, "unknown", 128))}${unread > 0 ? theme.fg("warning", ` · unread:${unread}`) : ""}`,
	];
	if (expanded) {
		const task = safeBlock(agent.currentTask, "", 2 * 1024).trim();
		const error = safeBlock(agent.error, "", 2 * 1024).trim();
		if (task) lines.push(`  ${theme.fg("dim", `task: ${task}`)}`);
		if (error) lines.push(`  ${theme.fg("error", `error: ${error}`)}`);
	}
	return lines.join("\n");
}

function lifecycleStatus(state: string): RenderStatus {
	switch (state) {
		case "starting":
			return "starting";
		case "running":
			return "running";
		case "idle":
			return "idle";
		case "failed":
			return "failed";
		case "interrupted":
			return "interrupted";
		case "closed":
			return "closed";
		default:
			return "completed";
	}
}
