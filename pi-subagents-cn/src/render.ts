import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
	getMarkdownTheme,
	type Theme,
	type ThemeColor,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentScope, SubagentThinkingLevel } from "./agents.js";
import { hasUsableAggregator, type SubagentParams } from "./params.js";
import { expansionHint, formatToolActivity, safeBlock, safeLine } from "./render-common.js";
import {
	getResultFinalOutput,
	isResultError,
	type SingleResult,
	type SubagentDetails,
} from "./runner.js";

const COLLAPSED_ITEM_COUNT = 5;

function previewTask(task: unknown, maxLength = 40): string {
	const safe = safeLine(task, "...", 2 * 1024);
	return safe.length > maxLength ? `${safe.slice(0, maxLength)}...` : safe;
}

function previewAgent(agent: unknown): string {
	return safeLine(agent, "...", 256);
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	thinkingLevel?: SubagentThinkingLevel,
	actualProvider?: string,
	actualModel?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0)
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	const safeProvider = actualProvider ? safeLine(actualProvider, "", 256) : undefined;
	const safeModel = actualModel ? safeLine(actualModel, "", 256) : undefined;
	const actual =
		safeProvider && safeModel ? `${safeProvider}/${safeModel}` : (safeModel ?? safeProvider);
	if (actual ?? model) parts.push(actual ?? safeLine(model, "", 256));
	if (thinkingLevel) parts.push(`requested-thinking:${safeLine(thinkingLevel, "", 128)}`);
	return parts.join(" ");
}

function formatResultUsageStats(result: SingleResult): string {
	return formatUsageStats(
		result.usage,
		result.model,
		result.thinkingLevel,
		result.actualProvider,
		result.actualModel,
	);
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	return formatToolActivity(toolName, args, themeFg);
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					const text = safeBlock(part.text, "", 8 * 1024).trim();
					if (text) items.push({ type: "text", text });
				} else if (part.type === "toolCall") {
					items.push({
						type: "toolCall",
						name: safeLine(part.name, "tool", 256),
						args: part.arguments,
					});
				}
			}
		}
	}
	return items;
}
function getCollapsedDisplayItems(result: SingleResult): { items: DisplayItem[]; total: number } {
	if (result.recentActivity && result.recentActivity.length > 0) {
		return {
			items: result.recentActivity,
			total: Math.max(result.recentActivity.length, result.recentActivityTotal ?? 0),
		};
	}
	const items = getDisplayItems(result.messages);
	return { items, total: items.length };
}

function sanitizeSingleResultForRender(result: SingleResult): SingleResult {
	return {
		...result,
		agent: safeLine(result.agent, "subagent", 256),
		task: safeBlock(result.task, "", 50 * 1024),
		stderr: safeBlock(result.stderr, "", 8 * 1024),
		model: result.model ? safeLine(result.model, "", 256) : undefined,
		actualProvider: result.actualProvider ? safeLine(result.actualProvider, "", 256) : undefined,
		actualModel: result.actualModel ? safeLine(result.actualModel, "", 256) : undefined,
		stopReason: result.stopReason ? safeLine(result.stopReason, "", 256) : undefined,
		errorMessage: result.errorMessage ? safeBlock(result.errorMessage, "", 8 * 1024) : undefined,
		finalOutput: result.finalOutput ? safeBlock(result.finalOutput, "", 50 * 1024) : undefined,
	};
}

function renderResultStatus(result: SingleResult, isPartial: boolean): string {
	if (isResultError(result)) {
		return result.stopReason === "aborted" || result.aborted ? "Cancelled" : "Failed";
	}
	return isPartial || result.exitCode === -1 ? "Running" : "Completed";
}

function coloredStatus(theme: Theme, status: string): string {
	const color: ThemeColor =
		status === "Failed" ? "error" : status === "Completed" ? "success" : "warning";
	return theme.fg(color, status);
}

function coloredResultStatus(theme: Theme, result: SingleResult, isPartial: boolean): string {
	return coloredStatus(theme, renderResultStatus(result, isPartial));
}

function formatResultPolicy(result: SingleResult): string {
	if (!result.policy) return "";
	return [
		`inherited: ${result.policy.inherited.map((tool) => safeLine(tool, "", 256)).join(", ") || "none"}`,
		`overridden: ${result.policy.overridden.map((tool) => safeLine(tool, "", 256)).join(", ") || "none"}`,
		`unsupported: ${result.policy.unsupported.map((tool) => safeLine(tool, "", 256)).join(", ") || "none"}`,
	].join("\n");
}

export function renderSubagentCall(args: SubagentParams, theme: Theme) {
	const scope: AgentScope = args.agentScope ?? "user";
	if (args.chain && args.chain.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `chain (${args.chain.length} steps)`) +
			theme.fg("muted", ` [${scope}]`);
		for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
			const step = args.chain[i] as { agent?: unknown; task?: unknown } | undefined;
			// Clean up {previous} placeholder for display
			const cleanTask =
				typeof step?.task === "string" ? step.task.replace(/\{previous\}/g, "").trim() : undefined;
			text +=
				"\n  " +
				theme.fg("muted", `${i + 1}.`) +
				" " +
				theme.fg("accent", previewAgent(step?.agent)) +
				theme.fg("dim", ` ${previewTask(cleanTask)}`);
		}
		if (args.chain.length > 3)
			text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	if (args.tasks && args.tasks.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
			theme.fg("muted", ` [${scope}]`);
		for (const task of args.tasks.slice(0, 3)) {
			const item = task as { agent?: unknown; task?: unknown } | undefined;
			text += `\n  ${theme.fg("accent", previewAgent(item?.agent))}${theme.fg("dim", ` ${previewTask(item?.task)}`)}`;
		}
		if (args.tasks.length > 3)
			text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
		if (hasUsableAggregator(args.aggregator)) {
			const aggregator = args.aggregator;
			text += `\n  ${theme.fg("muted", "fan-in → ")}${theme.fg("accent", previewAgent(aggregator.agent))}${theme.fg(
				"dim",
				` ${previewTask(aggregator.task)}`,
			)}`;
		}
		return new Text(text, 0, 0);
	}
	const agentName = previewAgent(args.agent);
	const preview = previewTask(args.task, 60);
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		theme.fg("muted", ` [${scope}]`);
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

export function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
) {
	const rawDetails = result.details as SubagentDetails | undefined;
	if (!rawDetails || rawDetails.results.length === 0) {
		const text = result.content[0];
		return new Text(
			text?.type === "text" ? safeBlock(text.text, "(no output)", 8 * 1024) : "(no output)",
			0,
			0,
		);
	}
	const details: SubagentDetails = {
		...rawDetails,
		results: rawDetails.results.map(sanitizeSingleResultForRender),
		aggregator: rawDetails.aggregator
			? sanitizeSingleResultForRender(rawDetails.aggregator)
			: undefined,
	};

	const mdTheme = getMarkdownTheme();

	const renderDisplayItems = (items: DisplayItem[], limit?: number, total = items.length) => {
		const toShow = limit ? items.slice(-limit) : items;
		const skipped = Math.max(0, total - toShow.length);
		let text = "";
		if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
		for (const item of toShow) {
			if (item.type === "text") {
				const safeText = safeBlock(item.text, "", 8 * 1024);
				const preview = expanded ? safeText : safeText.split("\n").slice(0, 3).join("\n");
				text += `${theme.fg("toolOutput", preview)}\n`;
			} else {
				text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
			}
		}
		return text.trimEnd();
	};

	if (details.mode === "single" && details.results.length === 1) {
		const r = details.results[0];
		const isError = isResultError(r);
		const icon = isError
			? theme.fg("error", "✗")
			: isPartial
				? theme.fg("warning", "⏳")
				: theme.fg("success", "✓");
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getResultFinalOutput(r);

		if (expanded) {
			const container = new Container();
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${safeLine(r.agentSource, "unknown", 128)})`)} · ${coloredResultStatus(theme, r, isPartial)}`;
			if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			container.addChild(new Text(header, 0, 0));
			if (isError && r.errorMessage)
				container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
			const policy = formatResultPolicy(r);
			if (policy) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Policy ───"), 0, 0));
				container.addChild(new Text(theme.fg("dim", policy), 0, 0));
			}
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			if (displayItems.length === 0 && !finalOutput) {
				container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
			} else {
				for (const item of displayItems) {
					if (item.type === "toolCall")
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") +
									formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
				}
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}
			}
			const usageStr = formatResultUsageStats(r);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			return container;
		}

		const collapsed = getCollapsedDisplayItems(r);
		let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${safeLine(r.agentSource, "unknown", 128)})`)} · ${coloredResultStatus(theme, r, isPartial)}`;
		if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
		if (collapsed.items.length > 0) {
			text += `\n${renderDisplayItems(collapsed.items, COLLAPSED_ITEM_COUNT, collapsed.total)}`;
			if (collapsed.total > COLLAPSED_ITEM_COUNT) text += `\n${expansionHint()}`;
		} else if (finalOutput.trim()) {
			const outputLines = finalOutput.trim().split("\n");
			text += `\n${theme.fg("toolOutput", outputLines.slice(0, 3).join("\n"))}`;
			if (outputLines.length > 3) text += `\n${expansionHint()}`;
		} else if (!isError || !r.errorMessage) {
			text += `\n${theme.fg("muted", isPartial && !isError ? "(running...)" : "(no output)")}`;
		}
		const usageStr = formatResultUsageStats(r);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
		return new Text(text, 0, 0);
	}

	const aggregateUsage = (results: SingleResult[]) => {
		const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		for (const r of results) {
			total.input += r.usage.input;
			total.output += r.usage.output;
			total.cacheRead += r.usage.cacheRead;
			total.cacheWrite += r.usage.cacheWrite;
			total.cost += r.usage.cost;
			total.turns += r.usage.turns;
		}
		return total;
	};

	if (details.mode === "chain") {
		const currentResult = details.results.at(-1);
		const currentIsRunning =
			isPartial && currentResult !== undefined && !isResultError(currentResult);
		const successCount = details.results.filter(
			(result) => !isResultError(result) && (!currentIsRunning || result !== currentResult),
		).length;
		const icon = currentIsRunning
			? theme.fg("warning", "⏳")
			: successCount === details.results.length
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
		const overallStatus = currentIsRunning
			? "Running"
			: successCount === details.results.length
				? "Completed"
				: "Failed";

		if (expanded) {
			const container = new Container();
			container.addChild(
				new Text(
					icon +
						" " +
						theme.fg("toolTitle", theme.bold("chain ")) +
						theme.fg("accent", `${successCount}/${details.results.length} steps`) +
						` · ${coloredStatus(theme, overallStatus)}`,
					0,
					0,
				),
			);

			for (const r of details.results) {
				const rFailed = isResultError(r);
				const rIcon = rFailed
					? theme.fg("error", "✗")
					: currentIsRunning && r === currentResult
						? theme.fg("warning", "⏳")
						: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getResultFinalOutput(r);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon} ${coloredResultStatus(theme, r, currentIsRunning && r === currentResult)}`,
						0,
						0,
					),
				);
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				const policy = formatResultPolicy(r);
				if (policy)
					container.addChild(
						new Text(theme.fg("muted", "Policy:\n") + theme.fg("dim", policy), 0, 0),
					);
				if (rFailed && r.errorMessage)
					container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));

				// Show tool calls
				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") +
									formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
					}
				}

				// Show final output as markdown
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const stepUsage = formatResultUsageStats(r);
				if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
			}

			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			return container;
		}

		// Collapsed view
		let text =
			icon +
			" " +
			theme.fg("toolTitle", theme.bold("chain ")) +
			theme.fg("accent", `${successCount}/${details.results.length} steps`) +
			` · ${coloredStatus(theme, overallStatus)}`;
		for (const r of details.results) {
			const rFailed = isResultError(r);
			const rIcon = rFailed
				? theme.fg("error", "✗")
				: currentIsRunning && r === currentResult
					? theme.fg("warning", "⏳")
					: theme.fg("success", "✓");
			const collapsed = getCollapsedDisplayItems(r);
			const finalOutput = getResultFinalOutput(r).trim();
			text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon} ${coloredResultStatus(theme, r, currentIsRunning && r === currentResult)}`;
			if (rFailed && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
			if (collapsed.items.length > 0)
				text += `\n${renderDisplayItems(collapsed.items, 5, collapsed.total)}`;
			else if (currentIsRunning && r === currentResult)
				text += `\n${theme.fg("muted", "(running...)")}`;
			else if (finalOutput)
				text += `\n${theme.fg("toolOutput", finalOutput.split("\n").slice(0, 3).join("\n"))}`;
			else if (!rFailed || !r.errorMessage) text += `\n${theme.fg("muted", "(no output)")}`;
		}
		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
		text += `\n${expansionHint()}`;
		return new Text(text, 0, 0);
	}

	if (details.mode === "parallel") {
		const resultIsRunning = (result: SingleResult) =>
			result.exitCode === -1 && !isResultError(result);
		const running = details.results.filter(resultIsRunning).length;
		const successCount = details.results.filter(
			(result) => result.exitCode !== -1 && !isResultError(result),
		).length;
		const failCount = details.results.filter(isResultError).length;
		const aggregator = details.aggregator;
		const aggregatorFailed = aggregator ? isResultError(aggregator) : false;
		const aggregatorRunning = aggregator
			? !aggregatorFailed && (isPartial || aggregator.exitCode === -1)
			: false;
		const pendingSuccessfulSettlement =
			isPartial && !aggregator && running === 0 && failCount === 0;
		const isRunning = running > 0 || aggregatorRunning || pendingSuccessfulSettlement;
		const icon = isRunning
			? theme.fg("warning", "⏳")
			: failCount > 0 || aggregatorFailed
				? theme.fg("warning", "◐")
				: theme.fg("success", "✓");
		const status = isRunning
			? aggregatorRunning
				? `${successCount + failCount}/${details.results.length} done, fan-in running`
				: running > 0
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount + failCount}/${details.results.length} done, running`
			: aggregator
				? `${successCount}/${details.results.length} tasks + fan-in`
				: `${successCount}/${details.results.length} tasks`;
		const overallStatus = isRunning
			? "Running"
			: failCount > 0 || aggregatorFailed
				? "Failed"
				: "Completed";

		if (expanded && !isRunning) {
			const container = new Container();
			container.addChild(
				new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)} · ${coloredStatus(theme, overallStatus)}`,
					0,
					0,
				),
			);

			for (const r of details.results) {
				const rFailed = isResultError(r);
				const rIcon = rFailed
					? theme.fg("error", "✗")
					: resultIsRunning(r)
						? theme.fg("warning", "⏳")
						: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getResultFinalOutput(r);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon} ${coloredResultStatus(theme, r, resultIsRunning(r))}`,
						0,
						0,
					),
				);
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				const policy = formatResultPolicy(r);
				if (policy)
					container.addChild(
						new Text(theme.fg("muted", "Policy:\n") + theme.fg("dim", policy), 0, 0),
					);
				if (rFailed && r.errorMessage)
					container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));

				// Show tool calls
				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") +
									formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
					}
				}

				// Show final output as markdown
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const taskUsage = formatResultUsageStats(r);
				if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
			}

			if (aggregator) {
				const rIcon = aggregatorFailed
					? theme.fg("error", "✗")
					: aggregatorRunning
						? theme.fg("warning", "⏳")
						: theme.fg("success", "✓");
				const displayItems = getDisplayItems(aggregator.messages);
				const finalOutput = getResultFinalOutput(aggregator);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						`${theme.fg("muted", "─── fan-in → ") + theme.fg("accent", aggregator.agent)} ${rIcon} ${coloredResultStatus(theme, aggregator, aggregatorRunning)}`,
						0,
						0,
					),
				);
				container.addChild(
					new Text(theme.fg("muted", "Task: ") + theme.fg("dim", aggregator.task), 0, 0),
				);
				const aggregatorPolicy = formatResultPolicy(aggregator);
				if (aggregatorPolicy)
					container.addChild(
						new Text(theme.fg("muted", "Policy:\n") + theme.fg("dim", aggregatorPolicy), 0, 0),
					);
				if (aggregatorFailed && aggregator.errorMessage)
					container.addChild(
						new Text(theme.fg("error", `Error: ${aggregator.errorMessage}`), 0, 0),
					);
				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") +
									formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
					}
				}
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}
				const fanInUsage = formatResultUsageStats(aggregator);
				if (fanInUsage) container.addChild(new Text(theme.fg("dim", fanInUsage), 0, 0));
			}

			const usageResults = aggregator ? [...details.results, aggregator] : details.results;
			const usageStr = formatUsageStats(aggregateUsage(usageResults));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			return container;
		}

		// Collapsed view (or still running)
		let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)} · ${coloredStatus(theme, overallStatus)}`;
		for (const r of details.results) {
			const rFailed = isResultError(r);
			const rRunning = resultIsRunning(r);
			const rIcon = rFailed
				? theme.fg("error", "✗")
				: rRunning
					? theme.fg("warning", "⏳")
					: theme.fg("success", "✓");
			const collapsed = getCollapsedDisplayItems(r);
			const finalOutput = getResultFinalOutput(r).trim();
			text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon} ${coloredResultStatus(theme, r, rRunning)}`;
			if (rFailed && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
			if (collapsed.items.length > 0)
				text += `\n${renderDisplayItems(collapsed.items, 5, collapsed.total)}`;
			else if (rRunning) text += `\n${theme.fg("muted", "(running...)")}`;
			else if (finalOutput)
				text += `\n${theme.fg("toolOutput", finalOutput.split("\n").slice(0, 3).join("\n"))}`;
			else if (!rFailed || !r.errorMessage) text += `\n${theme.fg("muted", "(no output)")}`;
		}
		if (aggregator) {
			const rIcon = aggregatorFailed
				? theme.fg("error", "✗")
				: aggregatorRunning
					? theme.fg("warning", "⏳")
					: theme.fg("success", "✓");
			const collapsed = getCollapsedDisplayItems(aggregator);
			const finalOutput = getResultFinalOutput(aggregator).trim();
			text += `\n\n${theme.fg("muted", "─── fan-in → ")}${theme.fg("accent", aggregator.agent)} ${rIcon} ${coloredResultStatus(theme, aggregator, aggregatorRunning)}`;
			if (aggregatorFailed && aggregator.errorMessage)
				text += `\n${theme.fg("error", `Error: ${aggregator.errorMessage}`)}`;
			if (collapsed.items.length > 0)
				text += `\n${renderDisplayItems(collapsed.items, 5, collapsed.total)}`;
			else if (aggregatorRunning) text += `\n${theme.fg("muted", "(running...)")}`;
			else if (finalOutput)
				text += `\n${theme.fg("toolOutput", finalOutput.split("\n").slice(0, 3).join("\n"))}`;
			else if (!aggregatorFailed || !aggregator.errorMessage)
				text += `\n${theme.fg("muted", "(no output)")}`;
		}
		if (!isRunning) {
			const usageResults = aggregator ? [...details.results, aggregator] : details.results;
			const usageStr = formatUsageStats(aggregateUsage(usageResults));
			if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
		}
		if (!expanded) text += `\n${expansionHint()}`;
		return new Text(text, 0, 0);
	}

	const text = result.content[0];
	return new Text(
		text?.type === "text" ? safeBlock(text.text, "(no output)", 8 * 1024) : "(no output)",
		0,
		0,
	);
}
