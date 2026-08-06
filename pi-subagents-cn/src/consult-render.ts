import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	getMarkdownTheme,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { ConsultDetails, SubagentConsultParams } from "./consult.js";
import { formatUsageStats } from "./render.js";
import {
	COLLAPSED_ANSWER_LINES,
	COLLAPSED_LIST_LIMIT,
	expansionHint,
	previewLines,
	projectRenderActivity,
	type RenderStatus,
	recordValue,
	renderActivityLines,
	renderFallbackResult,
	safeBlock,
	safeLine,
	statusBadge,
	stringValue,
	type ToolRendererContext,
	textResult,
	toolHeader,
} from "./render-common.js";

export function renderConsultCall(args: Partial<SubagentConsultParams>, theme: Theme) {
	const scope = args.agentScope ?? "user";
	const text = [
		toolHeader(theme, "subagent_consult", args.agent, [`[${scope}]`, "read-only"]),
		`  ${theme.fg("dim", safeLine(args.task, "...", 2 * 1024))}`,
	].join("\n");
	return new Text(text, 0, 0);
}

export function renderConsultResult(
	result: AgentToolResult<ConsultDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRendererContext<SubagentConsultParams>,
) {
	const details = recordValue(result.details);
	if (!details || !recordValue(details.policy)) {
		return renderFallbackResult(result, options, theme, context.isError);
	}

	const progress = recordValue(details.progress);
	const child = recordValue(details.child);
	const status = consultStatus(details, progress, options, context.isError);
	const agent = safeLine(details.agent, safeLine(context.args?.agent, "subagent"), 256);
	const source = safeLine(details.agentSource, "unknown", 128);
	const usage = recordValue(progress?.usage ?? child?.usage);
	const usageText = formatUnknownUsage(
		usage,
		stringValue(details.model) || undefined,
		stringValue(details.thinkingLevel) || undefined,
		stringValue(progress?.actualProvider ?? child?.actualProvider) || undefined,
		stringValue(progress?.actualModel ?? child?.actualModel) || undefined,
	);
	const effectiveTools = stringList(recordValue(details.policy)?.effectiveTools);
	const activity = projectRenderActivity(progress?.recentActivity);
	const activityTotal = Math.max(
		activity.length,
		typeof progress?.recentActivityTotal === "number" ? progress.recentActivityTotal : 0,
	);
	const answer = safeBlock(textResult(result), "", 50 * 1024).trim();

	if (options.expanded) {
		const container = new Container();
		container.addChild(
			new Text(
				`${statusBadge(theme, status)} · ${theme.fg("toolTitle", theme.bold(agent))}${theme.fg("muted", ` (${source})`)}`,
				0,
				0,
			),
		);
		if (usageText) container.addChild(new Text(theme.fg("dim", usageText), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(
			new Text(theme.fg("dim", safeBlock(context.args?.task, "(unavailable)", 50 * 1024)), 0, 0),
		);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Policy ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", policySummary(details.policy)), 0, 0));
		if (activity.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Activity ───"), 0, 0));
			container.addChild(
				new Text(renderActivityLines(activity, theme, undefined, activityTotal), 0, 0),
			);
		}
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Answer ───"), 0, 0));
		if (answer) container.addChild(new Markdown(answer, 0, 0, getMarkdownTheme()));
		else
			container.addChild(
				new Text(
					theme.fg("muted", options.isPartial ? "(waiting for output)" : "(no output)"),
					0,
					0,
				),
			);
		return container;
	}

	const lines = [
		`${statusBadge(theme, status)} · ${theme.fg("toolTitle", theme.bold(agent))}${theme.fg("muted", ` (${source})`)}`,
	];
	if (usageText) lines.push(theme.fg("dim", usageText));
	if (effectiveTools.length > 0 && options.isPartial) {
		lines.push(theme.fg("dim", `tools: ${effectiveTools.join(", ")}`));
	}
	if (activity.length > 0) {
		lines.push(renderActivityLines(activity, theme, COLLAPSED_LIST_LIMIT, activityTotal));
	} else if (options.isPartial) {
		lines.push(
			theme.fg("muted", status === "starting" ? "(starting child)" : "(waiting for activity)"),
		);
	} else if (answer) {
		lines.push(theme.fg("toolOutput", previewLines(answer, COLLAPSED_ANSWER_LINES)));
	} else {
		const error = safeBlock(child?.error, "", 2 * 1024).trim();
		lines.push(theme.fg(status === "failed" ? "error" : "muted", error || "(no output)"));
	}
	if (!options.isPartial) lines.push(expansionHint());
	return new Text(lines.filter(Boolean).join("\n"), 0, 0);
}

function consultStatus(
	details: Record<string, unknown>,
	progress: Record<string, unknown> | undefined,
	options: ToolRenderResultOptions,
	isError: boolean,
): RenderStatus {
	if (details.cancelled === true) return "cancelled";
	if (isError || details.isError === true) {
		const child = recordValue(details.child);
		return child?.aborted === true && child?.timedOut !== true ? "cancelled" : "failed";
	}
	if (options.isPartial) return progress?.phase === "starting" ? "starting" : "running";
	return "completed";
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.flatMap((item) => (typeof item === "string" ? [safeLine(item, "", 256)] : []))
		: [];
}

function policySummary(value: unknown): string {
	const policy = recordValue(value);
	if (!policy) return "(unavailable)";
	const resources = recordValue(policy.effectiveResources);
	const tools = stringList(policy.effectiveTools);
	return [
		`tools: ${tools.length > 0 ? tools.join(", ") : "none"}`,
		`resources: ${safeLine(resources?.policy ?? policy.requestedResources, "unknown", 256)}`,
		`extensions: ${safeLine(policy.extensions, "unknown", 128)}`,
		`session persistence: ${safeLine(policy.sessionPersistence, "unknown", 128)}`,
		`retained agent: ${policy.retainedAgent === false ? "no" : "unknown"}`,
	].join("\n");
}

function formatUnknownUsage(
	value: Record<string, unknown> | undefined,
	model?: string,
	thinkingLevel?: string,
	actualProvider?: string,
	actualModel?: string,
): string {
	const usage = value ?? {};
	return formatUsageStats(
		{
			input: safeNumber(usage.input),
			output: safeNumber(usage.output),
			cacheRead: safeNumber(usage.cacheRead),
			cacheWrite: safeNumber(usage.cacheWrite),
			cost: safeNumber(usage.cost),
			contextTokens: safeNumber(usage.contextTokens),
			turns: safeNumber(usage.turns),
		},
		model,
		thinkingLevel as never,
		actualProvider,
		actualModel,
	);
}

function safeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
