import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	type ConsultationCwdPolicy,
	type DelegationCwdPolicy,
	discoverAgents,
} from "./agents.js";
import { resolveConsultTools } from "./consult-policy.js";
import { renderInspectCall, renderInspectResult } from "./inspect-render.js";
import type { AgentRunInspectionDetail, AgentRunInspectionSummary } from "./registry.js";
import { boundedPrivateText, boundText, safeDisplayPath, safeTerminalLine } from "./safe-text.js";
import {
	inspectCompletionDeliverySettings,
	inspectConsultResourceSettings,
	inspectCwdPolicySettings,
	inspectDelegationWorkflowSettings,
	inspectSubagentSettings,
	resolveDelegationWorkflow,
} from "./settings.js";
import type { StatefulSubagentRuntimeStatus } from "./stateful.js";

const INSPECT_ACTIONS = [
	"list_agents",
	"get_agent",
	"list_runs",
	"get_run",
	"list_models",
	"status",
	"diagnose",
] as const;

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	default: "user",
	description: "Agent definition scope. Project scopes require a trusted project.",
});

const LimitSchema = Type.Number({ minimum: 1, maximum: 100, multipleOf: 1 });
const MAX_DETAILS_LIST_BYTES = 40 * 1024;

export const SubagentInspectParams = Type.Object(
	{
		action: StringEnum(INSPECT_ACTIONS),
		agent: Type.Optional(Type.String({ minLength: 1 })),
		agentId: Type.Optional(Type.String({ minLength: 1 })),
		agentScope: Type.Optional(AgentScopeSchema),
		limit: Type.Optional(LimitSchema),
		includeClosed: Type.Optional(Type.Boolean({ default: false })),
	},
	{ additionalProperties: false },
);

export type SubagentInspectParams = Static<typeof SubagentInspectParams>;

export interface SubagentInspectRuntime {
	getBlockingEnabled(): boolean;
	getConsultResourcePolicy(): "project-context" | "none" | "all";
	getConsultationCwdPolicy(): ConsultationCwdPolicy;
	getDelegationCwdPolicy(): DelegationCwdPolicy;
	getRuntimeStatus(): StatefulSubagentRuntimeStatus;
	listRunInspection(includeClosed?: boolean): AgentRunInspectionSummary[];
	getRunInspection(agentId: string): AgentRunInspectionDetail | undefined;
}

interface InspectToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

type ValidatedInspectOperation =
	| { action: "list_agents"; agentScope: AgentScope; limit: number }
	| { action: "get_agent"; agent: string; agentScope: AgentScope }
	| { action: "list_runs"; includeClosed: boolean; limit: number }
	| { action: "get_run"; agentId: string }
	| { action: "list_models"; limit: number }
	| { action: "status" }
	| { action: "diagnose" };

export function registerSubagentInspect(pi: ExtensionAPI, runtime: SubagentInspectRuntime): void {
	pi.registerTool({
		name: "subagent_inspect",
		label: "检查子代理",
		description:
			"Inspect available subagent definitions, models, retained runs, runtime status, and diagnostics without changing subagent or workspace state. This tool never starts a child, sends or acknowledges messages, interrupts or closes runs, changes settings, or modifies files.",
		promptSnippet: "Inspect subagent metadata and runtime state without changing it",
		parameters: SubagentInspectParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<InspectToolResult> {
			return executeSubagentInspect(validateInspectParams(params), ctx, runtime);
		},
		renderCall(args, theme) {
			return renderInspectCall(args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderInspectResult(result, options, theme, context);
		},
	});
}

export function validateInspectParams(params: unknown): ValidatedInspectOperation {
	const values = parameterRecord(params);
	const rawAction = values.action;
	if (
		typeof rawAction !== "string" ||
		!INSPECT_ACTIONS.includes(rawAction as (typeof INSPECT_ACTIONS)[number])
	) {
		throw new Error(`subagent_inspect action must be one of: ${INSPECT_ACTIONS.join(", ")}`);
	}
	const action = rawAction as (typeof INSPECT_ACTIONS)[number];
	const allowed: Record<(typeof INSPECT_ACTIONS)[number], readonly string[]> = {
		list_agents: ["action", "agentScope", "limit"],
		get_agent: ["action", "agent", "agentScope"],
		list_runs: ["action", "includeClosed", "limit"],
		get_run: ["action", "agentId"],
		list_models: ["action", "limit"],
		status: ["action"],
		diagnose: ["action"],
	};
	const unexpected = Object.keys(values).find(
		(key) => values[key] !== undefined && !allowed[action].includes(key),
	);
	if (unexpected)
		throw new Error(`subagent_inspect action "${action}" does not accept ${unexpected}`);

	if (action === "list_agents" || action === "get_agent") {
		const agentScope = optionalAgentScope(values.agentScope);
		if (action === "get_agent") {
			return { action, agent: requiredString(values.agent, action, "agent"), agentScope };
		}
		return { action, agentScope, limit: optionalLimit(values.limit, 32) };
	}
	if (action === "list_runs") {
		if (values.includeClosed !== undefined && typeof values.includeClosed !== "boolean") {
			throw new Error('subagent_inspect action "list_runs" requires includeClosed to be boolean');
		}
		return {
			action,
			includeClosed: values.includeClosed === true,
			limit: optionalLimit(values.limit, 50),
		};
	}
	if (action === "get_run") {
		return { action, agentId: requiredString(values.agentId, action, "agentId") };
	}
	if (action === "list_models") {
		return { action, limit: optionalLimit(values.limit, 50) };
	}
	return { action };
}

async function executeSubagentInspect(
	operation: ValidatedInspectOperation,
	ctx: ExtensionContext,
	runtime: SubagentInspectRuntime,
): Promise<InspectToolResult> {
	if (operation.action === "list_agents" || operation.action === "get_agent") {
		assertTrustedScope(operation.agentScope, ctx);
		const settings = inspectSubagentSettings().settings;
		const discovery = discoverAgents(ctx.cwd, operation.agentScope, settings);
		const agents = [...discovery.agents].sort((left, right) =>
			left.name === right.name
				? left.source.localeCompare(right.source)
				: left.name.localeCompare(right.name),
		);
		if (operation.action === "list_agents") {
			const selected = boundedProjection(agents, operation.limit, (agent) =>
				projectAgent(agent, ctx, false),
			);
			return inspectResult({
				action: operation.action,
				agents: selected.items,
				returned: selected.items.length,
				omitted: selected.omitted + (discovery.omittedAgentDefinitions ?? 0),
				discoveryIncomplete: discovery.metadataDiscoveryIncomplete === true,
			});
		}
		const agent = agents.find((candidate) => candidate.name === operation.agent);
		if (!agent) {
			throw new Error(`未知的子代理定义：${boundedPrivateText(operation.agent, 256)}`);
		}
		return inspectResult({ action: operation.action, agent: projectAgent(agent, ctx) });
	}

	if (operation.action === "list_runs") {
		const runs = runtime.listRunInspection(operation.includeClosed);
		const selected = boundedProjection(runs, operation.limit, projectRunSummary);
		return inspectResult({
			action: operation.action,
			runs: selected.items,
			returned: selected.items.length,
			omitted: selected.omitted,
		});
	}
	if (operation.action === "get_run") {
		const run = runtime.getRunInspection(operation.agentId);
		if (!run) {
			throw new Error(`未知的保留运行：${boundedPrivateText(operation.agentId, 256)}`);
		}
		return inspectResult({ action: operation.action, run: projectRun(run, ctx) });
	}
	if (operation.action === "list_models") {
		return inspectResult({ action: operation.action, ...projectModels(ctx, operation.limit) });
	}
	if (operation.action === "status") {
		return inspectResult({ action: operation.action, status: projectStatus(runtime) });
	}

	const settings = inspectSubagentSettings();
	const userDiscovery = discoverAgents(ctx.cwd, "user", settings.settings);
	const modelCount = availableModelCount(ctx);
	const runtimeStatus = runtime.getRuntimeStatus();
	const checks = [
		{
			name: "settings",
			status: settings.error ? "fail" : "pass",
			message: settings.error
				? boundedPrivateText(settings.error, 2 * 1024)
				: "设置有效或不存在。",
		},
		{
			name: "agent-discovery",
			status:
				userDiscovery.metadataDiscoveryIncomplete ||
				(userDiscovery.omittedAgentDefinitions ?? 0) > 0
					? "warning"
					: "pass",
			message: `${userDiscovery.agents.length} user-scope definitions available.`,
		},
		{
			name: "models",
			status: modelCount > 0 ? "pass" : "fail",
			message: `${modelCount} session-usable models available.`,
		},
		{
			name: "runtime",
			status: runtimeStatus.enabled && !runtimeStatus.initialized ? "warning" : "pass",
			message: runtimeStatus.initialized
				? "Stateful runtime initialized."
				: "Stateful runtime not initialized.",
		},
		{
			name: "consultation",
			status: runtime.getBlockingEnabled() && modelCount > 0 ? "pass" : "fail",
			message: runtime.getBlockingEnabled()
				? modelCount > 0
					? "Read-only consultation is supported."
					: "Consultation has no available model."
				: "Blocking delegation is disabled, so consultation is not registered.",
		},
	] as const;
	return inspectResult({
		action: operation.action,
		checks,
		ok: checks.every((check) => check.status !== "fail"),
	});
}

function projectAgent(
	agent: AgentConfig,
	ctx: ExtensionContext,
	includeTools = true,
): Record<string, unknown> {
	const tools = agent.tools === undefined ? undefined : projectToolNames(agent.tools);
	return {
		name: boundedPrivateText(agent.name, 256),
		description: boundedPrivateText(agent.description, 256),
		source: agent.source,
		scope: agent.source === "project" ? "project" : "user",
		path:
			agent.source === "project"
				? safeTerminalLine(
						path.posix.join(CONFIG_DIR_NAME, "agents", path.basename(agent.filePath)),
					)
				: safeDisplayPath(agent.filePath, ctx.cwd),
		model: agent.model ? boundedPrivateText(agent.model, 256) : undefined,
		thinkingLevel: agent.thinkingLevel,
		...(includeTools
			? { tools, toolCount: agent.tools?.length }
			: { toolCount: agent.tools?.length }),
		consultTools: resolveConsultTools(agent.tools),
	};
}

function projectRunSummary(run: AgentRunInspectionSummary): Record<string, unknown> {
	return {
		id: boundedPrivateText(run.id, 256),
		agent: boundedPrivateText(run.agent, 256),
		state: run.state,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		historyCount: run.historyCount,
		unreadMessages: run.unreadMessages,
	};
}

function projectRun(run: AgentRunInspectionDetail, ctx: ExtensionContext): Record<string, unknown> {
	return {
		...projectRunSummary(run),
		cwd: safeDisplayPath(run.cwd, ctx.cwd),
		workspaceMode: run.workspaceMode ?? "shared",
		thinkingLevel: run.thinkingLevel,
		currentTask: run.currentTask ? boundedPrivateText(run.currentTask, 2 * 1024) : undefined,
		error: run.error ? boundedPrivateText(run.error, 2 * 1024) : undefined,
		target: run.target
			? {
					cwd: safeDisplayPath(run.target.cwd, ctx.cwd),
					boundary: run.target.boundary,
					trust: {
						kind: run.target.trust.kind,
						projectTrusted: run.target.trust.projectTrusted,
						sourcePath: run.target.trust.sourcePath
							? safeDisplayPath(run.target.trust.sourcePath, ctx.cwd)
							: undefined,
						warning: run.target.trust.warning
							? boundedPrivateText(run.target.trust.warning, 512)
							: undefined,
					},
				}
			: undefined,
		policy: run.policy
			? {
					inherited: projectToolNames(run.policy.inherited),
					overridden: projectToolNames(run.policy.overridden),
					unsupported: projectToolNames(run.policy.unsupported),
				}
			: undefined,
	};
}

function projectModels(ctx: ExtensionContext, limit: number): Record<string, unknown> {
	const scoped = ctx.scopedModels ?? [];
	const candidates =
		scoped.length > 0
			? scoped
			: ctx.modelRegistry.getAvailable().map((model) => ({ model, thinkingLevel: undefined }));
	const selected = boundedProjection(candidates, limit, ({ model, thinkingLevel }) => ({
		provider: boundedPrivateText(model.provider, 256),
		id: boundedPrivateText(model.id, 256),
		name: boundedPrivateText(model.name, 256),
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		thinkingLevel,
		current: ctx.model?.provider === model.provider && ctx.model?.id === model.id,
	}));
	return {
		models: selected.items,
		returned: selected.items.length,
		omitted: selected.omitted,
		source: scoped.length > 0 ? "session scope" : "available snapshot",
	};
}

function projectStatus(runtime: SubagentInspectRuntime): Record<string, unknown> {
	const stateful = runtime.getRuntimeStatus();
	const workflow = resolveDelegationWorkflow(runtime.getBlockingEnabled(), stateful.enabled);
	const configured = inspectDelegationWorkflowSettings();
	const resources = inspectConsultResourceSettings();
	const cwdPolicy = inspectCwdPolicySettings();
	const completion = inspectCompletionDeliverySettings();
	return {
		workflow,
		configuredWorkflow: configured.value,
		configuredWorkflowSource: configured.source,
		stateful,
		configuredCompletionDelivery: completion.value,
		configuredCompletionDeliverySource: completion.source,
		consultResources: runtime.getConsultResourcePolicy(),
		consultationCwdPolicy: runtime.getConsultationCwdPolicy(),
		configuredConsultationCwdPolicy: cwdPolicy.consultation.value,
		consultationCwdPolicySource: cwdPolicy.consultation.source,
		delegationCwdPolicy: runtime.getDelegationCwdPolicy(),
		configuredDelegationCwdPolicy: cwdPolicy.delegation.value,
		delegationCwdPolicySource: cwdPolicy.delegation.source,
		configuredConsultResources: resources.value,
		consultResourcesSource: resources.source,
		settingsPath: safeDisplayPath(resources.path, process.cwd()),
		settingsError:
			configured.error || resources.error || cwdPolicy.error || completion.error
				? boundedPrivateText(
						configured.error ?? resources.error ?? cwdPolicy.error ?? completion.error ?? "",
						2 * 1024,
					)
				: undefined,
	};
}

function availableModelCount(ctx: ExtensionContext): number {
	return (ctx.scopedModels?.length ?? 0) > 0
		? ctx.scopedModels.length
		: ctx.modelRegistry.getAvailable().length;
}

function projectToolNames(tools: readonly string[]): string[] {
	return tools.slice(0, 100).map((tool) => boundedPrivateText(tool, 256));
}

function boundedProjection<T, TProjected>(
	values: readonly T[],
	limit: number,
	project: (value: T) => TProjected,
): { items: TProjected[]; omitted: number } {
	const items: TProjected[] = [];
	for (const value of values.slice(0, limit)) {
		const next = project(value);
		if (Buffer.byteLength(JSON.stringify([...items, next]), "utf8") > MAX_DETAILS_LIST_BYTES) break;
		items.push(next);
	}
	return { items, omitted: Math.max(0, values.length - items.length) };
}

function inspectResult(details: Record<string, unknown>): InspectToolResult {
	const rendered = boundText(JSON.stringify(details, null, 2));
	return {
		content: [{ type: "text", text: rendered.text }],
		details: { ...details, ...(rendered.truncated ? { truncated: true } : {}) },
	};
}

function assertTrustedScope(scope: AgentScope, ctx: ExtensionContext): void {
	if ((scope === "project" || scope === "both") && !ctx.isProjectTrusted()) {
		throw new Error("Project-local subagent definitions require a trusted project");
	}
}

function parameterRecord(params: unknown): Record<string, unknown> {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new Error("subagent_inspect parameters must be an object");
	}
	return params as Record<string, unknown>;
}

function optionalAgentScope(value: unknown): AgentScope {
	if (value === undefined) return "user";
	if (value === "user" || value === "project" || value === "both") return value;
	throw new Error("subagent_inspect agentScope must be user, project, or both");
}

function requiredString(value: unknown, action: string, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`subagent_inspect action "${action}" requires ${field}`);
	}
	return value;
}

function optionalLimit(value: unknown, defaultValue: number): number {
	if (value === undefined) return defaultValue;
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
		throw new Error("subagent_inspect limit must be an integer between 1 and 100");
	}
	return value as number;
}
