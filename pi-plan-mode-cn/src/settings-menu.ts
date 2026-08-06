import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { defineMenu, type RunMenuResult, runMenu } from "@narumitw/pi-tui-kit";
import { PLAN_MODE_COMPLETE_TOOL_NAME } from "./completion-tool.js";
import { retentionLabel } from "./implementation-retention.js";
import { planExportDestination } from "./plan-export.js";
import { PLAN_MODE_QUESTION_TOOL_NAME } from "./question-tool.js";
import {
	configuredImplementationPlanRetention,
	configuredPlanExportPath,
	IMPLEMENTATION_PLAN_RETENTIONS,
	PLAN_MODE_THINKING_LEVELS,
	type PlanModeSettings,
	type PlanModeSettingsLoadResult,
	type PlanModeSettingsPatch,
	planModeSettingsPath,
	readPlanModeSettings,
	type UpdatePlanModeSettingsOptions,
	updatePlanModeSettings,
} from "./settings.js";
import { canSelectToolInPlanMode } from "./tool-policy.js";
import { defaultPlanModeToolNames, toolPolicyLabel } from "./tool-selection.js";

interface SettingsMenuState {
	kind: "valid" | "invalid";
	settings: PlanModeSettings;
	notice?: string;
	reason?: string;
}

export interface PlanModeSettingsMenuOptions {
	tools: readonly ToolInfo[];
	signal: AbortSignal;
	isCurrent(): boolean;
	settingsPath?: string;
	legacySettingsPath?: string;
	readSettings?: (settingsPath?: string) => Promise<PlanModeSettingsLoadResult>;
	updateSettings?: (
		patch: PlanModeSettingsPatch,
		options?: UpdatePlanModeSettingsOptions,
	) => Promise<PlanModeSettings>;
	onSaved(settings: PlanModeSettings): void;
}

type Screen = "settings" | "tools" | "export";
type Action =
	| "set-thinking"
	| "open-tools"
	| "toggle-tool"
	| "reset-tools"
	| "set-retention"
	| "open-export"
	| "set-export";

export async function showPlanModeSettings(
	ctx: ExtensionContext,
	options: PlanModeSettingsMenuOptions,
): Promise<RunMenuResult> {
	const settingsPath = options.settingsPath ?? planModeSettingsPath();
	const readSettings = options.readSettings ?? readPlanModeSettings;
	const updateSettings = options.updateSettings ?? updatePlanModeSettings;
	const tools = options.tools.filter(
		(tool) =>
			tool.name !== PLAN_MODE_QUESTION_TOOL_NAME && tool.name !== PLAN_MODE_COMPLETE_TOOL_NAME,
	);

	const loadState = async (): Promise<SettingsMenuState> => {
		const loaded = await readSettings(options.settingsPath);
		if (loaded.kind === "invalid") {
			return {
				kind: "invalid",
				settings: { thinkingLevel: "inherit" },
				notice: loaded.notice,
				reason: loaded.reason,
			};
		}
		return {
			kind: "valid",
			settings: loaded.kind === "loaded" ? loaded.settings : { thinkingLevel: "inherit" },
			notice: loaded.notice,
		};
	};

	const menu = defineMenu<SettingsMenuState, Screen, Action, ExtensionContext>({
		start: "settings",
		screens: {
			settings: ({ state }) =>
				state.kind === "invalid"
					? invalidScreen(settingsPath, state)
					: {
							kind: "settings",
							title: "计划模式设置",
							lines: settingsLines(settingsPath, state.notice),
							items: [
								{
									id: "thinkingLevel",
									label: "计划思考级别",
									description: "设置下一次计划工作流启动时的思考级别。",
									currentValue: state.settings.thinkingLevel,
									values: PLAN_MODE_THINKING_LEVELS,
									action: "set-thinking",
								},
								{
									id: "defaultPlanTools",
									label: "计划工具",
									description:
										"选择持久默认工具；启动时的选择仍会为当次会话覆盖它们。",
									currentValue: defaultToolsValue(state.settings.defaultPlanTools),
									action: "open-tools",
								},
								{
									id: "implementationPlanRetention",
									label: "实现之后",
									description: "选择已批准的计划在实现期间继续起指导作用多久。",
									currentValue: retentionLabel(
										configuredImplementationPlanRetention(state.settings),
									),
									values: IMPLEMENTATION_PLAN_RETENTIONS.map(retentionLabel),
									action: "set-retention",
								},
								{
									id: "defaultPlanExportPath",
									label: "导出目标",
									description: "设置导出时未指定路径所用的目标位置。",
									currentValue: safeTerminalText(configuredPlanExportPath(state.settings)),
									action: "open-export",
								},
							],
						},
			tools: ({ state }) => ({
				kind: "multiSelect",
				title: "默认计划模式工具",
				lines: [
					"更改会在之后的计划工作流启动时生效；必需的计划工具保持启用。",
					"非内置工具由用户自行承担风险。",
				],
				enableSearch: true,
				viewportSize: 10,
				items: defaultToolItems(tools, state.settings.defaultPlanTools),
				action: "toggle-tool",
				actions: [
					{
						id: "reset-tools",
						label: "使用自动安全内置工具",
						action: "reset-tools",
					},
				],
				hint: "back",
			}),
			export: ({ state }) => {
				const configured = configuredPlanExportPath(state.settings);
				const destination = planExportDestination(configured, ctx.cwd);
				return {
					kind: "input",
					title: "导出目标",
					lines: [
						`已配置：${destination.configuredPath}`,
						`在此解析为：${destination.resolvedPath}`,
						"提交空值可重置为 PLAN.md。更改影响下一次导出。",
					],
					placeholder: configured,
					action: "set-export",
					hint: "back",
				};
			},
		},
		actions: {
			"set-thinking": async ({ ctx: actionCtx, value, signal }) => {
				if (
					!PLAN_MODE_THINKING_LEVELS.includes(value as (typeof PLAN_MODE_THINKING_LEVELS)[number])
				) {
					return { kind: "rejected" };
				}
				return savePatch(
					actionCtx,
					{ thinkingLevel: value as PlanModeSettings["thinkingLevel"] },
					signal,
					`计划模式思考级别：${value}。适用于下一次计划工作流。`,
				);
			},
			"open-tools": async () => ({ kind: "to", screen: "tools" }),
			"set-retention": async ({ ctx: actionCtx, value, signal }) => {
				const implementationPlanRetention = retentionFromLabel(value);
				if (!implementationPlanRetention) return { kind: "rejected" };
				return savePatch(
					actionCtx,
					{ implementationPlanRetention },
					signal,
					`实现之后：${retentionLabel(implementationPlanRetention)}。适用于下一次实现操作。`,
				);
			},
			"open-export": async () => ({ kind: "to", screen: "export" }),
			"set-export": async ({ ctx: actionCtx, value, signal }) => {
				const defaultPlanExportPath = value?.trim() || null;
				const result = await savePatch(
					actionCtx,
					{ defaultPlanExportPath },
					signal,
					defaultPlanExportPath
						? `默认计划导出目标：${safeTerminalText(defaultPlanExportPath)}。`
						: "默认计划导出目标已重置为 PLAN.md。",
				);
				return result.kind === "stay" ? { kind: "to", screen: "settings" } : result;
			},
			"toggle-tool": async ({ ctx: actionCtx, state, itemId, selected, signal }) => {
				const tool = tools.find((candidate) => candidate.name === itemId);
				if (!tool || !canSelectToolInPlanMode(tool)) return { kind: "rejected" };
				const names = explicitToolNames(tools, state.settings.defaultPlanTools);
				const next = selected
					? Array.from(new Set([...names, tool.name]))
					: names.filter((name) => name !== tool.name);
				return savePatch(
					actionCtx,
					{ defaultPlanTools: next },
					signal,
					`默认计划模式工具：${next.length === 0 ? "仅必需工具" : `已选 ${next.length} 个`}。`,
				);
			},
			"reset-tools": async ({ ctx: actionCtx, state, signal }) => {
				if (state.settings.defaultPlanTools === undefined) return { kind: "stay" };
				return savePatch(
					actionCtx,
					{ defaultPlanTools: null },
					signal,
					"默认计划模式工具：自动安全内置工具。",
				);
			},
		},
	});

	return runMenu(ctx, menu, {
		getState: loadState,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});

	async function savePatch(
		actionCtx: ExtensionContext,
		patch: PlanModeSettingsPatch,
		signal: AbortSignal,
		successMessage: string,
	) {
		if (signal.aborted || !options.isCurrent()) return { kind: "rejected" as const };
		try {
			const saved = await updateSettings(patch, {
				settingsPath: options.settingsPath,
				legacySettingsPath: options.legacySettingsPath,
				signal,
			});
			if (options.isCurrent()) options.onSaved(saved);
			if (signal.aborted || !options.isCurrent()) return { kind: "rejected" as const };
			actionCtx.ui.notify(successMessage, "info");
			return { kind: "stay" as const };
		} catch (error) {
			if (!signal.aborted && options.isCurrent()) {
				actionCtx.ui.notify(
					`无法保存计划模式设置，保留原值：${safeTerminalText(formatError(error))}`,
					"error",
				);
			}
			return { kind: "rejected" as const };
		}
	}
}

function settingsLines(settingsPath: string, notice: string | undefined) {
	return [
		`用户设置 · ${safeTerminalText(settingsPath)}`,
		"计划默认值适用于下一次工作流；交接和导出选择适用于它们的下一次操作。",
		...(notice ? [safeTerminalText(notice)] : []),
	];
}

function invalidScreen(settingsPath: string, state: SettingsMenuState) {
	return {
		kind: "detail" as const,
		title: "计划模式设置 · 只读",
		lines: [
			`设置文件无效。请先修复 ${safeTerminalText(settingsPath)} 再保存。`,
			safeTerminalText(state.reason ?? "设置文件无效。"),
			...(state.notice ? [safeTerminalText(state.notice)] : []),
		],
		hint: "back" as const,
	};
}

function retentionFromLabel(value: string | undefined) {
	return IMPLEMENTATION_PLAN_RETENTIONS.find((retention) => retentionLabel(retention) === value);
}

function defaultToolsValue(configured: string[] | undefined) {
	if (configured === undefined) return "自动安全内置工具";
	if (configured.length === 0) return "仅必需工具";
	return `已选 ${configured.length} 个`;
}

function defaultToolItems(tools: readonly ToolInfo[], configured: string[] | undefined) {
	const selected = new Set(explicitToolNames(tools, configured));
	const availableNames = new Set(tools.map((tool) => tool.name));
	const items = tools.map((tool) => {
		const selectable = canSelectToolInPlanMode(tool);
		const policy = toolPolicyLabel(tool);
		const description = tool.description ?? "无可用描述";
		return {
			id: tool.name,
			label: tool.name,
			description: `${policy} · ${description}`,
			searchText: `${policy} ${description}`,
			selected: selected.has(tool.name),
			disabled: !selectable,
			disabledReason: selectable ? undefined : "被计划模式策略阻止",
		};
	});
	for (const name of configured ?? []) {
		if (availableNames.has(name)) continue;
		items.push({
			id: name,
			label: name,
			description: "不可用 · 保留在设置中，但当前会话不可用",
			searchText: "不可用 保留设置",
			selected: true,
			disabled: true,
			disabledReason: "当前会话不可用；重置默认值可移除不可用名称",
		});
	}
	return items;
}

function explicitToolNames(tools: readonly ToolInfo[], configured: string[] | undefined) {
	return configured === undefined
		? defaultPlanModeToolNames([...tools], undefined)
		: [...configured];
}

function safeTerminalText(value: string) {
	return [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
		})
		.join("")
		.trim();
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
