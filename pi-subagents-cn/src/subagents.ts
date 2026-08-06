/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type ConsultationCwdPolicy,
	type ConsultResourcePolicy,
	type DelegationCwdPolicy,
	discoverAgentCatalog,
	formatAgentCatalog,
	type SubagentSettings,
} from "./agents.js";
import { registerSubagentConfigCommand } from "./config-ui.js";
import { registerSubagentConsult } from "./consult.js";
import { executeSubagent } from "./execution.js";
import { registerSubagentInspect } from "./inspect.js";
import { SubagentParams } from "./params.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import type { SubagentDetails } from "./runner.js";
import {
	consumeSubagentSettingsNotice,
	DEFAULT_CONSULT_RESOURCE_POLICY,
	DEFAULT_CONSULTATION_CWD_POLICY,
	DEFAULT_DELEGATION_CWD_POLICY,
	inspectSubagentSettings,
	readSubagentSettings,
} from "./settings.js";
import { registerStatefulSubagents } from "./stateful.js";

export default function (pi: ExtensionAPI) {
	const settings = readSubagentSettings();
	let currentSettings: SubagentSettings | undefined = settings;
	let currentCatalog = "";
	const blockingEnabled = settings?.blocking?.enabled !== false;
	const refreshBlockingCatalog = blockingEnabled
		? registerBlockingSubagent(pi, () => currentSettings)
		: () => undefined;
	let refreshStatefulCatalog: (catalog: string) => void = () => undefined;
	let refreshConsultCatalog: (catalog: string) => void = () => undefined;

	pi.on("session_start", (_event, ctx) => {
		// Preserve a one-shot migration notice from extension load while refreshing
		// validation against settings that may have changed before this session.
		const loadNotice = consumeSubagentSettingsNotice();
		const refreshedSettings = readSubagentSettings();
		const refreshedNotice = consumeSubagentSettingsNotice();
		if (!inspectSubagentSettings().error) currentSettings = refreshedSettings;
		const notice = [
			...new Set([loadNotice, refreshedNotice].filter((value) => value !== undefined)),
		].join("\n");
		if (notice) ctx.ui.notify(notice, "warning");

		currentCatalog = formatAgentCatalog(
			discoverAgentCatalog(ctx.cwd, ctx.isProjectTrusted(), refreshedSettings),
		).text;
		refreshBlockingCatalog(currentCatalog);
		refreshStatefulCatalog(currentCatalog);
		refreshConsultCatalog(currentCatalog);
	});

	const statefulRuntime = registerStatefulSubagents(pi, {
		blockingEnabled,
		settings: settings?.stateful,
		getSettings: () => currentSettings,
	});
	refreshStatefulCatalog = statefulRuntime.setAgentCatalog;
	const getBlockingEnabled = () => blockingEnabled;
	const getConsultResourcePolicy = () =>
		currentSettings?.consult?.resources ?? DEFAULT_CONSULT_RESOURCE_POLICY;
	const getConsultationCwdPolicy = () =>
		currentSettings?.cwdPolicy?.consultation ?? DEFAULT_CONSULTATION_CWD_POLICY;
	const getDelegationCwdPolicy = () =>
		currentSettings?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY;
	registerSubagentInspect(pi, {
		...statefulRuntime,
		getBlockingEnabled,
		getConsultResourcePolicy,
		getConsultationCwdPolicy,
		getDelegationCwdPolicy,
	});
	if (blockingEnabled) {
		refreshConsultCatalog = registerSubagentConsult(pi, {
			getSettings: () => currentSettings,
		});
	}
	registerSubagentConfigCommand(pi, {
		...statefulRuntime,
		getBlockingEnabled,
		getConsultResourcePolicy,
		getConsultationCwdPolicy,
		getDelegationCwdPolicy,
		setConsultResourcePolicy(value: ConsultResourcePolicy) {
			currentSettings = {
				...(currentSettings ?? {}),
				consult: { ...(currentSettings?.consult ?? {}), resources: value },
			};
			refreshConsultCatalog(currentCatalog);
		},
		setConsultationCwdPolicy(value: ConsultationCwdPolicy) {
			currentSettings = {
				...(currentSettings ?? {}),
				cwdPolicy: { ...(currentSettings?.cwdPolicy ?? {}), consultation: value },
			};
			refreshConsultCatalog(currentCatalog);
		},
		setDelegationCwdPolicy(value: DelegationCwdPolicy) {
			currentSettings = {
				...(currentSettings ?? {}),
				cwdPolicy: { ...(currentSettings?.cwdPolicy ?? {}), delegation: value },
			};
			refreshBlockingCatalog(currentCatalog);
			statefulRuntime.refreshSettingsGuidance();
		},
	});
}

function registerBlockingSubagent(
	pi: ExtensionAPI,
	getSettings: () => SubagentSettings | undefined,
): (catalog: string) => void {
	let catalog = "";
	const baseDescription = () =>
		[
			"Run specialized subagents as a blocking operation with isolated contexts.",
			"The call blocks the main agent until every worker and optional aggregator finishes, so queued steering waits.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Parallel mode may include an aggregator fan-in step that receives all task outputs. Use subagent_consult instead for one synchronous child that must be executor-constrained to read-only tools.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, pass agentScope: "both" (or "project") as a top-level argument for that call.`,
			`Working-directory target policy: ${getSettings()?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY}. This controls launch targets and protected project resources, not filesystem access or sandboxing.`,
		].join(" ");
	const definition: ToolDefinition<typeof SubagentParams, SubagentDetails> = {
		name: "subagent",
		label: "阻塞子代理",
		description: appendAgentCatalog(baseDescription(), catalog),
		promptSnippet:
			"Run blocking isolated subagents only when their outputs are required before the main agent can continue.",
		promptGuidelines: [
			"Use subagent only when delegation fits; the main agent should decide how many subagents to spawn from task shape instead of waiting for the user to specify a count.",
			"Use no subagent for simple answers, quick targeted edits, latency-sensitive one-step work, tasks requiring frequent user back-and-forth, or critical-path work the main agent can perform directly.",
			"Use the blocking subagent tool only when delegated outputs are required before the main agent's next action and waiting is intentional; the main agent cannot process queued steering until the call returns.",
			"Use a blocking subagent single, parallel, chain, or fan-in call only when synchronous context or output isolation is worth making the main agent unavailable while it runs.",
			"If a blocking parallel subagent call is genuinely required, keep tasks independent, stay within the hard max 8, and avoid write-heavy implementation touching the same files or shared state.",
			"For parallel subagent calls, omit the aggregator key entirely unless a fan-in step is required; do not send null, empty strings, or an empty object for unused optional fields.",
			'Do not use subagent with project-local agents unless the user explicitly wants project agents or sets agentScope to "project" or "both"; keep confirmation enabled for untrusted repositories.',
			"When using subagent, write self-contained tasks with file paths, context, expected output, and whether the subagent may edit files.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return executeSubagent(toolCallId, params, signal, onUpdate, ctx, getSettings());
		},

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme);
		},
	};
	pi.registerTool<typeof SubagentParams, SubagentDetails>(definition);
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		if ((event.details as (SubagentDetails & { isError?: boolean }) | undefined)?.isError)
			return { isError: true };
	});
	return (nextCatalog: string) => {
		catalog = nextCatalog;
		definition.description = appendAgentCatalog(baseDescription(), catalog);
		pi.registerTool<typeof SubagentParams, SubagentDetails>(definition);
	};
}

function appendAgentCatalog(baseDescription: string, catalog: string): string {
	return catalog ? `${baseDescription}\n\n${catalog}` : baseDescription;
}

export { parsePositiveInteger } from "./execution.js";
export { formatTokens, formatUsageStats } from "./render.js";
export { buildPiArgs } from "./runner.js";
export {
	DEFAULT_CONSULT_RESOURCE_POLICY,
	DEFAULT_CONSULTATION_CWD_POLICY,
	DEFAULT_DELEGATION_CWD_POLICY,
	inspectCompletionDeliverySettings,
	inspectConsultResourceSettings,
	inspectCwdPolicySettings,
	inspectDelegationWorkflowSettings,
	inspectSubagentSettings,
	normalizeAgentSettings,
	normalizeSubagentSettings,
	readSubagentSettings,
	resolveSubagentThinkingLevel,
	sameToolSet,
	saveSubagentConfig,
	subagentSettingsFilePath,
	uniqueToolNames,
	updateAgentToolsSetting,
	updateCompletionDeliverySetting,
	updateConsultResourceSetting,
	updateCwdPolicySetting,
	updateDelegationWorkflowSetting,
} from "./settings.js";
