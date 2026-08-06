import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type CompletionDelivery,
	type ConsultationCwdPolicy,
	type ConsultResourcePolicy,
	type DelegationCwdPolicy,
	discoverAgents,
} from "./agents.js";
import type { ManagedAgent } from "./registry.js";
import {
	type DelegationWorkflow,
	hasOwn,
	inspectCompletionDeliverySettings,
	inspectConsultResourceSettings,
	inspectCwdPolicySettings,
	inspectDelegationWorkflowSettings,
	readSubagentSettings,
	sameToolSet,
	uniqueToolNames,
	updateAgentToolsSetting,
	updateCompletionDeliverySetting,
	updateConsultResourceSetting,
	updateCwdPolicySetting,
	updateDelegationWorkflowSetting,
} from "./settings.js";
import { formatStatefulAgentLine, type StatefulSubagentRuntimeStatus } from "./stateful.js";

const SUBCOMMANDS = [
	{ value: "settings", label: "settings", description: "配置子代理用户设置" },
	{ value: "status", label: "status", description: "显示生效的子代理设置" },
	{ value: "help", label: "help", description: "显示子代理设置帮助" },
];
const TOOL_VIEWPORT_SIZE = 10;

export interface SubagentSettingsRuntime {
	getBlockingEnabled(): boolean;
	getCompletionDelivery(): CompletionDelivery;
	getConsultResourcePolicy(): ConsultResourcePolicy;
	getConsultationCwdPolicy(): ConsultationCwdPolicy;
	getDelegationCwdPolicy(): DelegationCwdPolicy;
	setCompletionDelivery(value: CompletionDelivery): void;
	setConsultResourcePolicy(value: ConsultResourcePolicy): void;
	setConsultationCwdPolicy(value: ConsultationCwdPolicy): void;
	setDelegationCwdPolicy(value: DelegationCwdPolicy): void;
	getRuntimeStatus(): StatefulSubagentRuntimeStatus;
	listAgents(includeClosed?: boolean): ManagedAgent[];
	clearAgents(): Promise<number>;
}

interface MenuOwner {
	generation: number;
	controller: AbortController;
}

interface ToolDraft {
	agentName: string;
	agentSource: string;
	allTools: string[];
	defaultTools?: string[];
	orderedTools: string[];
	selected: Set<string>;
}

export function registerSubagentConfigCommand(pi: ExtensionAPI, runtime: SubagentSettingsRuntime) {
	const owner: MenuOwner = { generation: 0, controller: new AbortController() };
	pi.on("session_start", () => {
		owner.generation += 1;
		owner.controller.abort(new DOMException("Subagent session replaced", "AbortError"));
		owner.controller = new AbortController();
	});
	pi.on("session_shutdown", () => {
		owner.generation += 1;
		owner.controller.abort(new DOMException("Subagent session shut down", "AbortError"));
	});
	registerSubagentPrimaryCommand(pi, runtime, owner);
}

function registerSubagentPrimaryCommand(
	pi: ExtensionAPI,
	runtime: SubagentSettingsRuntime,
	owner: MenuOwner,
) {
	pi.registerCommand("subagents", {
		description: "管理当前会话子代理和用户设置",
		getArgumentCompletions(prefix: string) {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		async handler(args, ctx) {
			const subcommand = args.trim().toLowerCase();
			if (!subcommand) {
				await showSubagentManager(pi, ctx, runtime, owner);
				return;
			}
			switch (subcommand) {
				case "settings":
					await showSubagentSettings(ctx, runtime, owner);
					return;
				case "status":
					showSubagentStatus(ctx, runtime);
					return;
				case "help":
					showSubagentHelp(ctx, runtime);
					return;
				default:
					if (ctx.mode === "tui" || ctx.hasUI) {
						ctx.ui.notify(`未知的 /subagents 子命令：${subcommand}`, "warning");
					}
			}
		},
	});
}

async function showSubagentManager(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
	owner: MenuOwner,
) {
	if (ctx.mode !== "tui") {
		showSubagentStatus(ctx, runtime);
		return;
	}
	const generation = owner.generation;
	const isCurrent = () => generation === owner.generation && !owner.controller.signal.aborted;
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (!isCurrent()) return;
	let availableAgents = discoverAgents(ctx.cwd, "user", readSubagentSettings() ?? {}).agents;
	let toolDraft: ToolDraft | undefined;
	type Screen =
		| "main"
		| "workflow"
		| "agents"
		| "settings"
		| "advanced"
		| "status"
		| "help"
		| "agent-picker"
		| "tool-draft";
	type Action =
		| "set-workflow"
		| "clear-agents"
		| "set-completion"
		| "set-consult-resources"
		| "set-consultation-cwd"
		| "set-delegation-cwd"
		| "load-agent-picker"
		| "pick-agent"
		| "toggle-tool"
		| "save-tools"
		| "discard-tools"
		| "back";
	const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
		start: "main",
		screens: {
			main: () => {
				const status = runtime.getRuntimeStatus();
				const workflow = inspectDelegationWorkflowSettings();
				return {
					kind: "actions",
					title: "子代理",
					lines: formatManagerSummary(runtime, status, workflow).split("\n"),
					items: [
						{
							id: "workflow",
							label: "更改委派方式",
							description: "选择全部方式、仅异步或仅阻塞",
							to: "workflow",
						},
						{
							id: "agents",
							label: "当前代理",
							description: `${status.activeAgents} active · ${status.retainedAgents} retained`,
							to: "agents",
						},
						{
							id: "settings",
							label: "Settings",
							description: "配置目标、受信任资源和异步完成方式",
							to: "settings",
						},
						{
							id: "advanced",
							label: "高级设置",
							description: "代理权限、运行时详情和设置路径",
							to: "advanced",
						},
						{ id: "help", label: "Help", to: "help" },
					],
					hint: "close",
				};
			},
			workflow: () => {
				const snapshot = inspectDelegationWorkflowSettings();
				const active = currentWorkflow(runtime, runtime.getRuntimeStatus());
				return {
					kind: "actions",
					title: "更改委派方式",
					lines: [
						`Current: ${workflowLabel(active)}`,
						...(snapshot.value !== active
							? [`重载后配置：${workflowLabel(snapshot.value)}`]
							: []),
						...(snapshot.error
							? [
									`设置无法编辑：${safeTerminalText(snapshot.error)}`,
									`修复 ${safeTerminalText(snapshot.path)} 后重试。`,
								]
							: []),
					],
					items: snapshot.error
						? []
						: [
								{
									id: "all",
									label: "全部委派方式",
									description: "允许阻塞批次和可复用的异步代理",
									action: "set-workflow" as const,
								},
								{
									id: "async-only",
									label: "仅异步",
									description: "保持主代理响应；移除阻塞子代理",
									action: "set-workflow" as const,
								},
								{
									id: "blocking-only",
									label: "仅阻塞",
									description: "保留阻塞批次；移除可复用的异步代理",
									action: "set-workflow" as const,
								},
							],
					hint: "back",
				};
			},
			agents: () => {
				const agents = runtime.listAgents();
				const status = runtime.getRuntimeStatus();
				return {
					kind: "actions",
					title: "当前会话子代理",
					lines: agents.length ? agents.map(formatStatefulAgentLine) : [formatEmptyRuntime(status)],
					items: [
						...(agents.length > 0
							? [
									{
										id: "clear",
										label: "清除当前会话代理",
										description: "关闭并删除此会话保留的代理",
										action: "clear-agents" as const,
									},
								]
							: []),
						{ id: "back", label: "Back", action: "back" },
					],
					hint: "back",
				};
			},
			settings: () => subagentSettingsScreen(runtime),
			advanced: () => ({
				kind: "actions",
				title: "高级子代理设置",
				items: [
					{
						id: "agent-tools",
						label: "代理工具权限",
						description: "自定义每个代理的持久工具白名单",
						action: "load-agent-picker",
					},
					{
						id: "status",
						label: "运行时详情",
						description: "显示传输方式、配置来源和设置路径",
						to: "status",
					},
					{ id: "back", label: "Back", action: "back" },
				],
				hint: "back",
			}),
			status: () => ({
				kind: "detail",
				title: "子代理运行时详情",
				lines: statusLines(runtime),
				hint: "back",
			}),
			help: () => ({
				kind: "detail",
				title: "子代理帮助",
				lines: helpLines(runtime),
				hint: "back",
			}),
			"agent-picker": () => {
				const settings = readSubagentSettings() ?? {};
				const configured = settings.agents ?? {};
				return {
					kind: "actions",
					title: "子代理工具配置",
					lines: ["选择一个代理来配置其允许的工具。"],
					items: availableAgents.map((agent) => {
						const override = configured[agent.name];
						const hasOverride = override ? hasOwn(override, "tools") : false;
						const summary = hasOverride
							? override?.tools && override.tools.length > 0
								? override.tools.join(", ")
								: "none"
							: "defaults";
						return {
							id: agent.name,
							label: safeTerminalText(agent.name),
							description: safeTerminalText(`${agent.source} · tools: ${summary}`),
							action: "pick-agent" as const,
						};
					}),
					hint: "back",
				};
			},
			"tool-draft": () => ({
				kind: "multiSelect",
				title: toolDraft ? `${safeTerminalText(toolDraft.agentName)} 工具` : "代理工具",
				enableSearch: true,
				lines: toolDraft
					? [
							`Source: ${safeTerminalText(toolDraft.agentSource)}`,
							"切换草稿，然后保存更改。",
						]
					: ["未选择代理。"],
				viewportSize: TOOL_VIEWPORT_SIZE,
				items:
					toolDraft?.orderedTools.map((name) => {
						const available = toolDraft?.allTools.includes(name) ?? false;
						return {
							id: name,
							label: safeTerminalText(name),
							description: available ? "可用工具" : "已配置的工具当前未加载",
							searchText: available ? "可用工具" : "已配置不可用保留",
							selected: toolDraft?.selected.has(name) ?? false,
							disabled: !available,
							disabledReason: available
								? undefined
								: "不可用；在 JSON 中显式更改前保留",
						};
					}) ?? [],
				action: "toggle-tool",
				actions: [
					{ id: "save", label: "保存更改", action: "save-tools" },
					{ id: "discard", label: "放弃草稿", action: "discard-tools" },
				],
				hint: "back",
				doneLabel: "不保存并关闭",
			}),
		},
		actions: {
			"set-workflow": async ({ itemId }) => {
				if (!isWorkflow(itemId)) return { kind: "rejected" };
				const snapshot = inspectDelegationWorkflowSettings();
				if (snapshot.error) return { kind: "rejected" };
				const active = currentWorkflow(runtime, runtime.getRuntimeStatus());
				if (itemId === active && itemId === snapshot.value) {
					ctx.ui.notify(`委派方式已是 ${workflowLabel(itemId)}。`, "info");
					return { kind: "stay" };
				}
				const requiresReload = itemId !== active;
				if (requiresReload && blockReloadWithRetainedAgents(ctx, runtime)) {
					return { kind: "rejected" };
				}
				if (!(await showWorkflowPreview(ctx, active, itemId, requiresReload))) {
					return { kind: "rejected" };
				}
				if (requiresReload && blockReloadWithRetainedAgents(ctx, runtime)) {
					return { kind: "rejected" };
				}
				try {
					updateDelegationWorkflowSetting(itemId);
				} catch (error) {
					ctx.ui.notify(
						`委派设置未保存：${formatError(error)}。当前工作流保持不变。`,
						"error",
					);
					return { kind: "rejected" };
				}
				if (!requiresReload) {
					ctx.ui.notify(
						`已保存 ${workflowLabel(itemId)}。当前工具面已匹配。`,
						"info",
					);
					return { kind: "stay" };
				}
				ctx.ui.notify(
					`已保存 ${workflowLabel(itemId)}。正在重载子代理工具…如果工具面未刷新，请运行 /reload。`,
					"info",
				);
				await ctx.reload();
				return { kind: "close" };
			},
			"clear-agents": async () => {
				const agents = runtime.listAgents();
				if (agents.length === 0) return { kind: "stay" };
				const confirmed = await ctx.ui.confirm(
					"清除当前会话子代理？",
					`关闭并删除 ${agents.length} 个保留代理？`,
				);
				if (!confirmed) return { kind: "rejected" };
				const cleared = await runtime.clearAgents();
				ctx.ui.notify(
					`已清除 ${cleared} 个当前会话子代理。`,
					"info",
				);
				return { kind: "stay" };
			},
			"set-completion": async ({ value }) => applyCompletionSetting(value, ctx, runtime),
			"set-consult-resources": async ({ value }) =>
				applyConsultResourceSetting(value, ctx, runtime),
			"set-consultation-cwd": async ({ value }) => applyConsultationCwdSetting(value, ctx, runtime),
			"set-delegation-cwd": async ({ value }) => applyDelegationCwdSetting(value, ctx, runtime),
			"load-agent-picker": async () => {
				availableAgents = discoverAgents(ctx.cwd, "user", readSubagentSettings() ?? {}).agents;
				if (availableAgents.length === 0) {
					ctx.ui.notify("未找到代理", "warning");
					return { kind: "rejected" };
				}
				return { kind: "to", screen: "agent-picker" };
			},
			"pick-agent": async ({ itemId }) => {
				const agent = availableAgents.find((candidate) => candidate.name === itemId);
				if (!agent) return { kind: "rejected" };
				const settings = readSubagentSettings() ?? {};
				const configured = settings.agents?.[agent.name];
				const configuredTools =
					configured && hasOwn(configured, "tools") ? (configured.tools ?? []) : undefined;
				const defaults = discoverAgents(ctx.cwd, "user").agents.find(
					(candidate) => candidate.name === agent.name,
				)?.tools;
				const allTools = uniqueToolNames(pi.getAllTools().map((tool) => tool.name)).sort((a, b) =>
					a.localeCompare(b),
				);
				const selected = uniqueToolNames(configuredTools ?? defaults ?? allTools);
				const selectedSet = new Set(selected);
				toolDraft = {
					agentName: agent.name,
					agentSource: agent.source,
					allTools,
					defaultTools: defaults,
					orderedTools: [...selected, ...allTools.filter((name) => !selectedSet.has(name))],
					selected: selectedSet,
				};
				return { kind: "to", screen: "tool-draft" };
			},
			"toggle-tool": async ({ itemId, selected }) => {
				if (!toolDraft?.allTools.includes(itemId)) return { kind: "rejected" };
				if (selected) toolDraft.selected.add(itemId);
				else toolDraft.selected.delete(itemId);
				return { kind: "stay" };
			},
			"save-tools": async () => {
				if (!toolDraft) return { kind: "rejected" };
				const selected = toolDraft.orderedTools.filter((name) => toolDraft?.selected.has(name));
				const restoredDefaults =
					toolDraft.defaultTools === undefined
						? sameToolSet(selected, toolDraft.allTools)
						: sameToolSet(selected, toolDraft.defaultTools);
				try {
					updateAgentToolsSetting(toolDraft.agentName, restoredDefaults ? undefined : selected);
				} catch (error) {
					ctx.ui.notify(`代理工具设置未保存：${formatError(error)}`, "error");
					return { kind: "rejected" };
				}
				ctx.ui.notify(
					restoredDefaults
						? `${safeTerminalText(toolDraft.agentName)}：已恢复默认值`
						: `${safeTerminalText(toolDraft.agentName)}：已配置 ${selected.length} 个工具`,
					"info",
				);
				toolDraft = undefined;
				return { kind: "back" };
			},
			"discard-tools": async () => {
				toolDraft = undefined;
				return { kind: "back" };
			},
			back: async () => ({ kind: "back" }),
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: owner.controller.signal,
		isCurrent,
	});
}

async function showSubagentSettings(
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
	owner: MenuOwner,
) {
	const snapshot = inspectConsultResourceSettings();
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`用户设置适用于本次及未来会话。请手动编辑设置：${safeTerminalText(snapshot.path)}`,
				"info",
			);
		}
		return;
	}
	const generation = owner.generation;
	const isCurrent = () => generation === owner.generation && !owner.controller.signal.aborted;
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (!isCurrent()) return;
	type SettingsAction =
		| "set-completion"
		| "set-consult-resources"
		| "set-consultation-cwd"
		| "set-delegation-cwd";
	const menu = defineMenu<undefined, "settings", SettingsAction, ExtensionCommandContext>({
		start: "settings",
		screens: { settings: () => subagentSettingsScreen(runtime) },
		actions: {
			"set-completion": async ({ value }) => applyCompletionSetting(value, ctx, runtime),
			"set-consult-resources": async ({ value }) =>
				applyConsultResourceSetting(value, ctx, runtime),
			"set-consultation-cwd": async ({ value }) => applyConsultationCwdSetting(value, ctx, runtime),
			"set-delegation-cwd": async ({ value }) => applyDelegationCwdSetting(value, ctx, runtime),
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: owner.controller.signal,
		isCurrent,
	});
}

function subagentSettingsScreen(runtime: SubagentSettingsRuntime) {
	const completion = inspectCompletionDeliverySettings();
	const consult = inspectConsultResourceSettings();
	const cwdPolicy = inspectCwdPolicySettings();
	const error = completion.error ?? consult.error ?? cwdPolicy.error;
	return {
		kind: "settings" as const,
		title: error ? "子代理用户设置 · 只读" : "子代理用户设置",
		lines: [
			"立即生效并适用于未来会话",
			"目标和信任设置控制启动资源，不控制文件系统访问或沙箱。",
			"使用 Pi /trust 管理文件夹信任；更改后重启 Pi。",
			safeTerminalText(consult.path),
			...(error ? [`设置无法编辑：${safeTerminalText(error)}`] : []),
		],
		items: error
			? []
			: [
					{
						id: "consultationCwd",
						label: "只读咨询目标",
						description:
							"不受信任的外部目标不继承任何目标/项目资源；代理和包只读提示保持不变。",
						currentValue: consultationCwdLabel(runtime.getConsultationCwdPolicy()),
						values: ["任意位置 · 不受信任的目标不继承任何内容", "仅当前工作区"],
						action: "set-consultation-cwd" as const,
					},
					{
						id: "delegationCwd",
						label: "常规委派目标",
						description:
							"控制启动目录，而非绝对路径、shell 命令或操作系统权限。",
						currentValue: delegationCwdLabel(runtime.getDelegationCwdPolicy()),
						values: [
							"当前或已保存的受信任文件夹",
							"仅当前工作区",
							"任意位置 · 正常 Pi 权限",
						],
						action: "set-delegation-cwd" as const,
					},
					{
						id: "consultResources",
						label: "受信任目标的咨询资源",
						description:
							"选择咨询继承哪些受信任的上下文、系统、技能和提示资源。",
						currentValue: consultResourceLabel(runtime.getConsultResourcePolicy()),
						values: ["仅项目上下文", "不继承资源", "所有受信任资源"],
						action: "set-consult-resources" as const,
					},
					{
						id: "completionDelivery",
						label: "异步工作完成时",
						description:
							"等待你的下一轮，或在主代理安定后请求一个综合轮次。",
						currentValue: completionLabel(runtime.getCompletionDelivery()),
						values: ["等到我的下一轮", "完成后自动恢复"],
						action: "set-completion" as const,
					},
				],
	};
}

function applyCompletionSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getCompletionDelivery();
	const next: CompletionDelivery =
		value === "完成后自动恢复" ? "auto-resume" : "next-turn";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateCompletionDeliverySetting(next);
		runtime.setCompletionDelivery(next);
		ctx.ui.notify(`已保存并应用：${completionLabel(next)}。`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`子代理设置未保存：${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function applyConsultResourceSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getConsultResourcePolicy();
	const next: ConsultResourcePolicy =
		value === "不继承资源"
			? "none"
			: value === "所有受信任资源"
				? "all"
				: "project-context";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateConsultResourceSetting(next);
		runtime.setConsultResourcePolicy(next);
		ctx.ui.notify(`已保存并应用：${consultResourceLabel(next)}。`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`子代理设置未保存：${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function applyConsultationCwdSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getConsultationCwdPolicy();
	const next: ConsultationCwdPolicy =
		value === "仅当前工作区" ? "current-workspace" : "anywhere";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateCwdPolicySetting("consultation", next);
		runtime.setConsultationCwdPolicy(next);
		ctx.ui.notify(`已保存并应用：${consultationCwdLabel(next)}。`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`子代理设置未保存：${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function applyDelegationCwdSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getDelegationCwdPolicy();
	const next: DelegationCwdPolicy =
		value === "仅当前工作区"
			? "current-workspace"
			: value === "任意位置 · 正常 Pi 权限"
				? "anywhere"
				: "trusted-targets";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateCwdPolicySetting("delegation", next);
		runtime.setDelegationCwdPolicy(next);
		ctx.ui.notify(`已保存并应用：${delegationCwdLabel(next)}。`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`子代理设置未保存：${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function blockReloadWithRetainedAgents(
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
): boolean {
	const status = runtime.getRuntimeStatus();
	if (status.retainedAgents === 0) return false;
	ctx.ui.notify(
		`无法在 ${status.retainedAgents} 个分离子代理保留（${status.activeAgents} 活跃）时重载。请打开「当前代理」，在确认其工作可安全丢弃后清除它们，再更改委派方式。`,
		"warning",
	);
	return true;
}

async function showWorkflowPreview(
	ctx: ExtensionCommandContext,
	current: DelegationWorkflow,
	next: DelegationWorkflow,
	requiresReload: boolean,
): Promise<boolean> {
	const changes = workflowEffects(current, next);
	return ctx.ui.confirm(
		requiresReload ? "保存委派更改并重载？" : "保存委派更改？",
		[
			`当前：${workflowLabel(current)}`,
			`新：${workflowLabel(next)}`,
			"",
			"效果：",
			...(changes.length > 0 ? changes : ["保持当前已注册的工具"]).map(
				(effect) => `- ${effect}`,
			),
			`- ${requiresReload ? "重载扩展以应用此工具面" : "无需重载，因为活动工具已匹配"}`,
		].join("\n"),
	);
}

function showSubagentStatus(ctx: ExtensionCommandContext, runtime: SubagentSettingsRuntime) {
	if (ctx.mode !== "tui" && !ctx.hasUI) return;
	const snapshot = inspectCompletionDeliverySettings();
	ctx.ui.notify(
		formatStatus(runtime.getRuntimeStatus(), snapshot, runtime),
		snapshot.error ? "warning" : "info",
	);
}

function showSubagentHelp(ctx: ExtensionCommandContext, runtime: SubagentSettingsRuntime) {
	if (ctx.mode !== "tui" && !ctx.hasUI) return;
	ctx.ui.notify(helpLines(runtime).join("\n"), "info");
}

function statusLines(runtime: SubagentSettingsRuntime): string[] {
	const snapshot = inspectCompletionDeliverySettings();
	return formatStatus(runtime.getRuntimeStatus(), snapshot, runtime).split("\n");
}

function helpLines(runtime: SubagentSettingsRuntime): string[] {
	const snapshot = inspectCompletionDeliverySettings();
	const cwdPolicy = inspectCwdPolicySettings();
	return [
		"/subagents — 选择委派工作流、管理当前代理并配置代理工具",
		"/subagents settings — 配置目标位置、受信任资源和异步完成方式",
		"/subagents status — 显示当前会话和用户设置值",
		"/subagents help — 显示此帮助",
		"目标策略控制启动目录和资源，不控制文件系统访问或沙箱。",
		"使用 Pi /trust 管理已保存的文件夹信任，更改后重启 Pi。",
		`运行时咨询目标：${consultationCwdLabel(runtime.getConsultationCwdPolicy())}`,
		`已配置咨询目标：${consultationCwdLabel(cwdPolicy.consultation.value)}（${cwdPolicy.consultation.source}）`,
		`运行时委派目标：${delegationCwdLabel(runtime.getDelegationCwdPolicy())}`,
		`已配置委派目标：${delegationCwdLabel(cwdPolicy.delegation.value)}（${cwdPolicy.delegation.source}）`,
		`用户设置：${safeTerminalText(snapshot.path)}`,
	];
}

function formatManagerSummary(
	runtime: SubagentSettingsRuntime,
	status: StatefulSubagentRuntimeStatus,
	configured: ReturnType<typeof inspectDelegationWorkflowSettings>,
): string {
	const current = currentWorkflow(runtime, status);
	const cwdPolicy = inspectCwdPolicySettings();
	const consult = inspectConsultResourceSettings();
	return [
		`委派方式：${workflowLabel(current)}`,
		`Completion: ${completionLabel(status.completionDelivery)}`,
		`咨询目标：${consultationCwdLabel(runtime.getConsultationCwdPolicy())}`,
		`委派目标：${delegationCwdLabel(runtime.getDelegationCwdPolicy())}`,
		`咨询资源：${consultResourceLabel(runtime.getConsultResourcePolicy())}`,
		`已配置咨询目标：${consultationCwdLabel(cwdPolicy.consultation.value)} · ${cwdPolicy.consultation.source}`,
		`已配置委派目标：${delegationCwdLabel(cwdPolicy.delegation.value)} · ${cwdPolicy.delegation.source}`,
		`已配置咨询资源：${consultResourceLabel(consult.value)} · ${consult.source}`,
		`设置：${safeTerminalText(cwdPolicy.path)}`,
		`代理：${status.activeAgents} 活跃 · ${status.retainedAgents} 保留`,
		...(configured.value !== current
			? [`重载后配置：${workflowLabel(configured.value)}`]
			: []),
		...(configured.error ? ["设置需要修复；打开高级设置查看详情。"] : []),
	].join("\n");
}

function formatStatus(
	status: StatefulSubagentRuntimeStatus,
	snapshot: ReturnType<typeof inspectCompletionDeliverySettings>,
	runtime?: SubagentSettingsRuntime,
): string {
	const configuredWorkflow = inspectDelegationWorkflowSettings();
	const consult = inspectConsultResourceSettings();
	const cwdPolicy = inspectCwdPolicySettings();
	const current = runtime ? currentWorkflow(runtime, status) : configuredWorkflow.value;
	return [
		"当前会话",
		`  委派方式：${workflowLabel(current)}`,
		`  异步运行时：${status.initialized ? "已初始化" : status.enabled ? "未初始化" : "已禁用"}`,
		`  传输方式：${status.transport}`,
		`  完成方式：${completionLabel(status.completionDelivery)}`,
		`  咨询目标：${consultationCwdLabel(runtime?.getConsultationCwdPolicy() ?? cwdPolicy.consultation.value)}`,
		`  委派目标：${delegationCwdLabel(runtime?.getDelegationCwdPolicy() ?? cwdPolicy.delegation.value)}`,
		`  咨询资源：${consultResourceLabel(runtime?.getConsultResourcePolicy() ?? consult.value)}`,
		`  代理：${status.activeAgents} 活跃，${status.retainedAgents} 保留`,
		"用户设置",
		`  委派来源：${configuredWorkflow.source}`,
		`  已配置委派：${workflowLabel(configuredWorkflow.value)}`,
		`  完成来源：${snapshot.source}`,
		`  已配置完成：${completionLabel(snapshot.value)}`,
		`  已配置咨询目标：${consultationCwdLabel(cwdPolicy.consultation.value)}`,
		`  咨询目标来源：${cwdPolicy.consultation.source}`,
		`  已配置委派目标：${delegationCwdLabel(cwdPolicy.delegation.value)}`,
		`  委派目标来源：${cwdPolicy.delegation.source}`,
		`  已配置咨询资源：${consultResourceLabel(consult.value)}`,
		`  咨询资源来源：${consult.source}`,
		`  路径：${safeTerminalText(snapshot.path)}`,
		configuredWorkflow.error || snapshot.error || cwdPolicy.error
			? `  警告：${safeTerminalText(configuredWorkflow.error ?? snapshot.error ?? cwdPolicy.error ?? "无效设置")}`
			: "  警告：无",
		configuredWorkflow.value !== current
			? "已配置的委派方式与本会话不同。运行 /reload 以应用。"
			: "手动更改文件需要 /reload。",
	].join("\n");
}

function formatEmptyRuntime(status: StatefulSubagentRuntimeStatus): string {
	if (!status.enabled) return "用户设置中已禁用有状态子代理。";
	if (!status.initialized) return "有状态子代理未为此会话初始化。";
	return "没有当前会话子代理。";
}

function currentWorkflow(
	runtime: SubagentSettingsRuntime,
	status: StatefulSubagentRuntimeStatus,
): DelegationWorkflow {
	const blocking = runtime.getBlockingEnabled();
	if (blocking && status.enabled) return "all";
	if (status.enabled) return "async-only";
	if (blocking) return "blocking-only";
	return "disabled";
}

function isWorkflow(value: string): value is Exclude<DelegationWorkflow, "disabled"> {
	return value === "all" || value === "async-only" || value === "blocking-only";
}

function workflowLabel(value: DelegationWorkflow): string {
	switch (value) {
		case "all":
			return "全部委派方式";
		case "async-only":
			return "仅异步";
		case "blocking-only":
			return "仅阻塞";
		case "disabled":
			return "委派已禁用";
	}
}

function completionLabel(value: CompletionDelivery): string {
	return value === "auto-resume" ? "完成后自动恢复" : "等到我的下一轮";
}

function consultationCwdLabel(value: ConsultationCwdPolicy): string {
	return value === "current-workspace"
		? "仅当前工作区"
		: "任意位置 · 不受信任的目标不继承任何内容";
}

function delegationCwdLabel(value: DelegationCwdPolicy): string {
	switch (value) {
		case "trusted-targets":
			return "当前或已保存的受信任文件夹";
		case "current-workspace":
			return "仅当前工作区";
		case "anywhere":
			return "任意位置 · 正常 Pi 权限";
	}
}

function consultResourceLabel(value: ConsultResourcePolicy): string {
	switch (value) {
		case "project-context":
			return "仅项目上下文";
		case "none":
			return "不继承资源";
		case "all":
			return "所有受信任资源";
	}
}

function workflowEffects(current: DelegationWorkflow, next: DelegationWorkflow): string[] {
	const blockingEnabled = (value: DelegationWorkflow) =>
		value === "all" || value === "blocking-only";
	const asyncEnabled = (value: DelegationWorkflow) => value === "all" || value === "async-only";
	const effects: string[] = [];
	if (blockingEnabled(current) !== blockingEnabled(next)) {
		effects.push(
			blockingEnabled(next)
				? "添加阻塞 `subagent` 和只读 `subagent_consult`"
				: "移除阻塞 `subagent` 和只读 `subagent_consult`",
		);
	}
	if (asyncEnabled(current) !== asyncEnabled(next)) {
		effects.push(
			asyncEnabled(next)
				? "添加可复用的异步生命周期工具"
				: "移除可复用的异步生命周期工具",
		);
	}
	return effects;
}

function safeTerminalText(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}

function formatError(error: unknown): string {
	return safeTerminalText(error instanceof Error ? error.message : String(error));
}
