import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentInspectParams } from "./inspect.js";
import {
	booleanValue,
	COLLAPSED_LIST_LIMIT,
	expansionHint,
	numberValue,
	recordList,
	recordValue,
	renderFallbackResult,
	safeBlock,
	safeLine,
	statusBadge,
	stringValue,
	type ToolRendererContext,
	toolHeader,
} from "./render-common.js";

export function renderInspectCall(args: Partial<SubagentInspectParams>, theme: Theme) {
	const action = safeLine(args.action, "...", 128);
	const metadata: string[] = [];
	if (args.agentScope) metadata.push(`[${args.agentScope}]`);
	if (args.agent) metadata.push(`agent:${safeLine(args.agent, "", 256)}`);
	if (args.agentId) metadata.push(`id:${safeLine(args.agentId, "", 256)}`);
	if (args.includeClosed) metadata.push("include closed");
	return new Text(toolHeader(theme, "subagent_inspect", action, metadata), 0, 0);
}

export function renderInspectResult(
	result: AgentToolResult<Record<string, unknown>>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRendererContext<SubagentInspectParams>,
) {
	const details = recordValue(result.details);
	const action = stringValue(details?.action);
	if (!details || !action) return renderFallbackResult(result, options, theme, context.isError);

	const rendered = renderAction(action, details, options.expanded, theme);
	if (!rendered) return renderFallbackResult(result, options, theme, context.isError);
	return new Text(rendered, 0, 0);
}

function renderAction(
	action: string,
	details: Record<string, unknown>,
	expanded: boolean,
	theme: Theme,
): string | undefined {
	switch (action) {
		case "list_agents":
			return renderList("agent", recordList(details.agents), details, expanded, theme, formatAgent);
		case "get_agent": {
			const agent = recordValue(details.agent);
			if (!agent) return undefined;
			const lines = [
				`${statusBadge(theme, "completed")} · ${theme.fg("toolTitle", theme.bold(safeLine(agent.name, "agent", 256)))}${theme.fg("muted", ` (${safeLine(agent.source, "unknown", 128)})`)}`,
				formatAgent(agent, theme, true),
			];
			if (!expanded) lines.push(expansionHint());
			return lines.join("\n");
		}
		case "list_runs":
			return renderList("run", recordList(details.runs), details, expanded, theme, formatRun);
		case "get_run": {
			const run = recordValue(details.run);
			if (!run) return undefined;
			const lines = [
				`${statusBadge(theme, "completed")} · run ${theme.fg("accent", safeLine(run.id, "run", 256))}`,
				formatRun(run, theme, true),
			];
			if (!expanded) lines.push(expansionHint());
			return lines.join("\n");
		}
		case "list_models":
			return renderList(
				"model",
				recordList(details.models),
				details,
				expanded,
				theme,
				formatModel,
				stringValue(details.source),
			);
		case "status":
			return renderStatus(details, expanded, theme);
		case "diagnose":
			return renderDiagnose(details, expanded, theme);
		default:
			return undefined;
	}
}

function renderList(
	label: string,
	items: Record<string, unknown>[],
	details: Record<string, unknown>,
	expanded: boolean,
	theme: Theme,
	format: (item: Record<string, unknown>, theme: Theme, expanded: boolean) => string,
	source = "",
): string {
	const returned = numberValue(details.returned, items.length);
	const omitted = numberValue(details.omitted);
	const noun = `${label}${returned === 1 ? "" : "s"}`;
	const lines = [
		`${statusBadge(theme, "completed")} · ${returned} ${noun}${source ? theme.fg("muted", ` · ${safeLine(source, "", 256)}`) : ""}`,
	];
	const selected = expanded ? items : items.slice(0, COLLAPSED_LIST_LIMIT);
	for (const item of selected) lines.push(format(item, theme, expanded));
	const hidden = Math.max(0, items.length - selected.length) + omitted;
	if (hidden > 0) lines.push(theme.fg("muted", `… ${hidden} omitted`));
	if (items.length === 0) lines.push(theme.fg("muted", `(no ${label}s)`));
	if (!expanded && (items.length > 0 || omitted > 0)) lines.push(expansionHint());
	return lines.join("\n");
}

function formatAgent(agent: Record<string, unknown>, theme: Theme, expanded: boolean): string {
	const name = safeLine(agent.name, "agent", 256);
	const source = safeLine(agent.source, "unknown", 128);
	const model = stringValue(agent.model);
	const toolCount = typeof agent.toolCount === "number" ? agent.toolCount : undefined;
	const description = safeBlock(agent.description, "", 512).trim();
	const lines = [
		`${theme.fg("muted", "• ")}${theme.fg("accent", name)} ${theme.fg("muted", source)}${model ? theme.fg("dim", ` · ${safeLine(model, "", 256)}`) : ""}${toolCount !== undefined ? theme.fg("dim", ` · ${toolCount} tools`) : ""}`,
	];
	if (description) lines.push(`  ${theme.fg("toolOutput", description)}`);
	if (expanded) {
		const path = stringValue(agent.path);
		const consultTools = stringList(agent.consultTools);
		if (path) lines.push(`  ${theme.fg("dim", `path: ${safeLine(path, "", 2 * 1024)}`)}`);
		lines.push(`  ${theme.fg("dim", `consult tools: ${consultTools.join(", ") || "none"}`)}`);
	}
	return lines.join("\n");
}

function formatRun(run: Record<string, unknown>, theme: Theme, expanded: boolean): string {
	const id = safeLine(run.id, "run", 256);
	const agent = safeLine(run.agent, "agent", 256);
	const state = safeLine(run.state, "unknown", 128);
	const unread = numberValue(run.unreadMessages);
	const lines = [
		`${theme.fg("muted", "• ")}${theme.fg("accent", id)} ${theme.fg("toolOutput", agent)} ${theme.fg("muted", state)}${unread > 0 ? theme.fg("warning", ` · unread:${unread}`) : ""}`,
	];
	if (expanded) {
		const thinking = stringValue(run.thinkingLevel);
		const task = safeBlock(run.currentTask, "", 2 * 1024).trim();
		const error = safeBlock(run.error, "", 2 * 1024).trim();
		lines.push(
			`  ${theme.fg("dim", `${numberValue(run.historyCount)} history · ${thinking ? `thinking:${safeLine(thinking, "", 128)} · ` : ""}${numberValue(run.children)} children`)}`,
		);
		if (task) lines.push(`  ${theme.fg("dim", `task: ${task}`)}`);
		if (error) lines.push(`  ${theme.fg("error", `error: ${error}`)}`);
	}
	return lines.join("\n");
}

function formatModel(model: Record<string, unknown>, theme: Theme, expanded: boolean): string {
	const identity = `${safeLine(model.provider, "provider", 256)}/${safeLine(model.id, "model", 256)}`;
	const current = booleanValue(model.current) ? theme.fg("success", " · current") : "";
	const reasoning = booleanValue(model.reasoning) ? theme.fg("dim", " · reasoning") : "";
	const lines = [`${theme.fg("muted", "• ")}${theme.fg("accent", identity)}${current}${reasoning}`];
	if (expanded) {
		const name = stringValue(model.name);
		const thinking = stringValue(model.thinkingLevel);
		if (name) lines.push(`  ${theme.fg("toolOutput", safeLine(name, "", 512))}`);
		lines.push(
			`  ${theme.fg("dim", `context:${numberValue(model.contextWindow)} · max:${numberValue(model.maxTokens)}${thinking ? ` · thinking:${safeLine(thinking, "", 128)}` : ""}`)}`,
		);
	}
	return lines.join("\n");
}

function renderStatus(
	details: Record<string, unknown>,
	expanded: boolean,
	theme: Theme,
): string | undefined {
	const status = recordValue(details.status);
	const stateful = recordValue(status?.stateful);
	if (!status || !stateful) return undefined;
	const lines = [
		`${statusBadge(theme, "completed")} · runtime status`,
		`${theme.fg("muted", "workflow: ")}${theme.fg("accent", safeLine(status.workflow, "unknown", 128))} · ${numberValue(stateful.activeAgents)} active · ${numberValue(stateful.retainedAgents)} retained`,
		`${theme.fg("muted", "stateful: ")}${stateful.initialized === true ? "initialized" : "not initialized"} · resources: ${safeLine(status.consultResources, "unknown", 128)}`,
	];
	if (expanded) {
		const delivery = stringValue(stateful.completionDelivery);
		const transport = stringValue(stateful.transport);
		if (transport || delivery) {
			lines.push(
				theme.fg(
					"dim",
					[
						transport && `transport:${safeLine(transport)}`,
						delivery && `delivery:${safeLine(delivery)}`,
					]
						.filter(Boolean)
						.join(" · "),
				),
			);
		}
	} else lines.push(expansionHint());
	return lines.join("\n");
}

function renderDiagnose(details: Record<string, unknown>, expanded: boolean, theme: Theme): string {
	const checks = recordList(details.checks);
	const hasFail = checks.some((check) => check.status === "fail");
	const hasWarning = checks.some((check) => check.status === "warning");
	const overall = hasFail ? "failed" : hasWarning ? "warnings" : "passed";
	const status = hasFail ? "failed" : hasWarning ? "warning" : "completed";
	const lines = [`${statusBadge(theme, status)} · Diagnostics ${overall}`];
	const selected = expanded ? checks : checks.slice(0, COLLAPSED_LIST_LIMIT);
	for (const check of selected) {
		const checkStatus = safeLine(check.status, "unknown", 64);
		const color =
			checkStatus === "fail" ? "error" : checkStatus === "warning" ? "warning" : "success";
		lines.push(
			`${theme.fg(color, checkStatus.toUpperCase())} ${theme.fg("accent", safeLine(check.name, "check", 256))} · ${theme.fg("toolOutput", safeBlock(check.message, "", 2 * 1024))}`,
		);
	}
	if (checks.length === 0) lines.push(theme.fg("muted", "(no diagnostic checks)"));
	if (!expanded && checks.length > 0) lines.push(expansionHint());
	return lines.join("\n");
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.flatMap((item) => (typeof item === "string" ? [safeLine(item, "", 256)] : []))
		: [];
}
