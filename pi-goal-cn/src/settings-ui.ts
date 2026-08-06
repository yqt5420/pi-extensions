import { join } from "node:path";
import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { checkpointGoalActiveTime } from "./accounting.js";
import { abortCurrentTurn, type GoalRuntime, STATUS_KEY } from "./runtime.js";
import {
	DEFAULT_GOAL_SETTINGS,
	GOAL_SETTINGS_FILE,
	type GoalSettings,
	saveGoalSettings,
} from "./settings.js";

interface GoalSettingsUiOptions {
	settingsPath?: string;
	initialScreen?: "settings" | "automatic";
	save?: (settings: GoalSettings, settingsPath: string) => void;
	onQueueUnfrozen?: (ctx: ExtensionCommandContext) => Promise<void>;
}

interface GoalSettingsApplyOptions {
	save?: (settings: GoalSettings) => void;
}

type LimitField = "automaticTurns" | "noProgressTurns";
type LimitSelection = "unlimited" | "default" | "custom" | "off";
export async function showGoalSettings(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	options: GoalSettingsUiOptions = {},
) {
	const settingsPath = options.settingsPath ?? join(getAgentDir(), GOAL_SETTINGS_FILE);
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`请手动编辑 pi-goal 设置：${safeTerminalText(settingsPath)}`, "info");
		return;
	}
	const generation = runtime.menuGeneration;
	const isMenuCurrent = () =>
		generation === runtime.menuGeneration && !runtime.menuController.signal.aborted;
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (!isMenuCurrent()) return;
	const invalid = runtime.settingsLoadIssue?.kind === "invalid";
	const previewGoalIds = new Map<LimitField, string | null>();
	type Screen = "settings" | "automatic" | "no-progress" | "invalid";
	type Action =
		| "open-automatic"
		| "open-no-progress"
		| "choose-automatic"
		| "choose-no-progress"
		| "set-visibility"
		| "set-queue"
		| "set-rpc";
	const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
		start: invalid ? "invalid" : (options.initialScreen ?? "settings"),
		screens: {
			settings: () => ({
				kind: "settings",
				title: "Pi 目标设置",
				lines: [`用户设置 · ${safeTerminalText(settingsPath)}`],
				items: [
					{
						id: "automaticTurns",
						label: "自动工作上限",
						description: "在可见数量的模型响应后暂停自动目标工作。",
						currentValue: formatAutomaticSettingValue(
							runtime.settings.continuationLimits.automaticTurns,
						),
						action: "open-automatic",
					},
					{
						id: "noProgressTurns",
						label: "无进展保护",
						description: "在重复或空的无工具自动运行后暂停。",
						currentValue: formatNoProgressSettingValue(
							runtime.settings.continuationLimits.noProgressTurns,
						),
						action: "open-no-progress",
					},
					{
						id: "toolVisibility",
						label: "目标工具",
						description: "保持终端目标工具可见，或在第一个目标后显示。",
						currentValue: visibilityLabel(runtime.settings.toolVisibility),
						values: ["始终", "第一个目标后"],
						action: "set-visibility",
					},
					{
						id: "experimentalGoals",
						label: "有序目标队列",
						description: "启用实验性的添加、优先处理、跳过和丢弃最后一个工作流。",
						currentValue: runtime.settings.experimental.goals ? "实验" : "Off",
						values: ["Off", "实验"],
						action: "set-queue",
					},
					{
						id: "rpcEnabled",
						label: "受管运行 RPC",
						description:
							"允许受信任的已安装扩展启动和取消目标运行；这不是扩展沙箱。",
						currentValue: runtime.settings.rpc.enabled ? "开启" : "Off",
						values: ["Off", "开启"],
						action: "set-rpc",
					},
				],
			}),
			automatic: () => limitChoiceScreen(runtime, "automaticTurns", "choose-automatic"),
			"no-progress": () => limitChoiceScreen(runtime, "noProgressTurns", "choose-no-progress"),
			invalid: () => ({
				kind: "detail",
				title: "Pi 目标设置 · 只读",
				lines: [
					`设置文件无效。Pi-goal 正在使用内置默认值。请修复 ${safeTerminalText(settingsPath)} 并运行 /reload。该文件不会被覆盖。`,
					`自动工作上限：${formatAutomaticWork(runtime.settings.continuationLimits.automaticTurns)}`,
					`无进展保护：${formatNoProgressProtection(runtime.settings.continuationLimits.noProgressTurns)}`,
					`目标工具：${visibilityLabel(runtime.settings.toolVisibility)}`,
					`有序目标队列：${runtime.settings.experimental.goals ? "实验" : "关闭"}`,
					`受管运行 RPC：${runtime.settings.rpc.enabled ? "开启" : "关闭"}`,
				],
				hint: "back",
			}),
		},
		actions: {
			"open-automatic": async () => {
				previewGoalIds.set("automaticTurns", runtime.activeGoal?.id ?? null);
				return { kind: "to", screen: "automatic" };
			},
			"open-no-progress": async () => {
				previewGoalIds.set("noProgressTurns", runtime.activeGoal?.id ?? null);
				return { kind: "to", screen: "no-progress" };
			},
			"choose-automatic": async ({ itemId }) =>
				applyLimitChoice(
					runtime,
					ctx,
					options,
					settingsPath,
					"automaticTurns",
					itemId,
					previewGoalIds.get("automaticTurns") ?? null,
					isMenuCurrent,
				),
			"choose-no-progress": async ({ itemId }) =>
				applyLimitChoice(
					runtime,
					ctx,
					options,
					settingsPath,
					"noProgressTurns",
					itemId,
					previewGoalIds.get("noProgressTurns") ?? null,
					isMenuCurrent,
				),
			"set-visibility": async ({ value }) => {
				const nextVisibility = value === "始终" ? "always" : "after-first-goal";
				if (nextVisibility === runtime.settings.toolVisibility) return { kind: "stay" };
				try {
					const next = {
						...structuredClone(runtime.settings),
						toolVisibility: nextVisibility,
					} satisfies GoalSettings;
					applyGoalSettings(runtime, next, ctx, {
						save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
					});
					ctx.ui.notify(`目标工具：${value}。`, "info");
					return { kind: "stay" };
				} catch (error) {
					notifySettingsFailure(ctx, settingsPath, error);
					return { kind: "rejected" };
				}
			},
			"set-queue": async ({ value }) => {
				const enabled = value === "实验";
				if (enabled === runtime.settings.experimental.goals) return { kind: "stay" };
				const next = await nextQueueSettings(runtime, ctx, enabled);
				if (!next) return { kind: "rejected" };
				const wasFrozen = runtime.queueFrozen;
				try {
					applyGoalSettings(runtime, next, ctx, {
						save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
					});
					if (wasFrozen && !runtime.queueFrozen) {
						try {
							await options.onQueueUnfrozen?.(ctx);
						} catch (error) {
							ctx.ui.notify(
								`目标队列已启用，但自动恢复失败：${safeTerminalText(formatError(error))}。请重新打开 /goal 重试。`,
								"warning",
							);
						}
					}
					ctx.ui.notify(`有序目标队列：${enabled ? "实验" : "关闭"}。`, "info");
					return { kind: "stay" };
				} catch (error) {
					notifySettingsFailure(ctx, settingsPath, error);
					return { kind: "rejected" };
				}
			},
			"set-rpc": async ({ value }) => {
				const enabled = value === "开启";
				if (enabled === runtime.settings.rpc.enabled) return { kind: "stay" };
				try {
					const next = {
						...structuredClone(runtime.settings),
						rpc: { enabled },
					} satisfies GoalSettings;
					applyGoalSettings(runtime, next, ctx, {
						save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
					});
					ctx.ui.notify(`受管运行 RPC：${enabled ? "开启" : "关闭"}。`, "info");
					return { kind: "stay" };
				} catch (error) {
					notifySettingsFailure(ctx, settingsPath, error);
					return { kind: "rejected" };
				}
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: runtime.menuController.signal,
		isCurrent: isMenuCurrent,
	});
}

function limitChoiceScreen(
	runtime: GoalRuntime,
	field: LimitField,
	action: "choose-automatic" | "choose-no-progress",
) {
	const value = runtime.settings.continuationLimits[field];
	const goal = runtime.activeGoal;
	return {
		kind: "actions" as const,
		title: field === "automaticTurns" ? "自动工作上限" : "无进展保护",
		lines: [
			field === "automaticTurns"
				? `Current: ${formatAutomaticWork(value)}`
				: `Current: ${formatNoProgressProtection(value)}`,
			...(field === "automaticTurns"
				? [
						`为每个自动工作时段设置整数响应上限。默认：${DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns}.`,
					]
				: []),
			...(goal
				? [
						field === "automaticTurns"
							? `活动目标：已使用 ${goal.automaticModelTurns} 次自动响应`
							: `活动目标：检测到 ${goal.toolFreeRepeatCount} 次重复或空运行`,
					]
				: []),
		],
		items: limitChoices(field, value, goal?.automaticModelTurns).map((item) => ({
			id: item.value,
			label: item.label,
			description: item.description,
			action,
		})),
		hint: "back" as const,
	};
}

function limitChoices(
	field: LimitField,
	value: number | null,
	automaticTurnsUsed: number | undefined,
): Array<{ value: LimitSelection; label: string; description: string }> {
	if (field === "automaticTurns") {
		const unlimitedDescription =
			value === null
				? "没有响应次数上限。完成、手动暂停、阻塞、提供商限制和其他已配置的保护仍然适用。"
				: automaticTurnsUsed === undefined
					? `移除当前的 ${value} 次响应上限。目标工作将没有响应次数上限；其他配置ed stop conditions remain.`
					: `移除当前的 ${value} 次响应上限。活动目标已使用 ${automaticTurnsUsed} 次响应； other configured stop conditions remain.`;
		return [
			{
				value: "custom",
				label: "设置响应上限…",
				description: `为每个自动工作时段选择整数响应上限。默认：${DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns}.`,
			},
			{ value: "unlimited", label: "无限制…", description: unlimitedDescription },
		];
	}
	const defaultLimit = DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns;
	return [
		{
			value: "default",
			label: `默认重复运行 ${defaultLimit} 次后（默认）`,
			description: "在默认次数的重复或空无工具运行后暂停。",
		},
		{
			value: "custom",
			label: "设置阈值…",
			description: "选择暂停前的重复或空运行次数（整数）。",
		},
		{
			value: "off",
			label: "Off",
			description: "不基于重复或空的无工具运行暂停。",
		},
	];
}

async function applyLimitChoice(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	options: GoalSettingsUiOptions,
	settingsPath: string,
	field: LimitField,
	itemId: string,
	activeGoalId: string | null,
	isCurrent: () => boolean,
) {
	if (!isCurrent() || !isLimitSelection(itemId)) return { kind: "rejected" as const };
	if ((runtime.activeGoal?.id ?? null) !== activeGoalId) {
		ctx.ui.notify(
			"打开安全设置期间活动目标已更改。未更改任何设置。",
			"warning",
		);
		return { kind: "rejected" as const };
	}
	const previous = runtime.settings.continuationLimits[field];
	const limit = await resolveLimitSelection(field, itemId, previous, ctx, isCurrent);
	if (!isCurrent()) return { kind: "rejected" as const };
	if (limit === undefined || limit === previous) return { kind: "back" as const };
	if ((runtime.activeGoal?.id ?? null) !== activeGoalId) {
		ctx.ui.notify(
			"编辑安全设置期间活动目标已更改。未更改任何设置。",
			"warning",
		);
		return { kind: "rejected" as const };
	}
	const confirmation = await confirmLowerActiveLimit(runtime, ctx, field, limit);
	if (!isCurrent() || !confirmation.apply) return { kind: "rejected" as const };
	if (confirmation.goalId !== undefined && runtime.activeGoal?.id !== confirmation.goalId) {
		ctx.ui.notify(
			"确认上限期间活动目标已更改。未更改任何设置。",
			"warning",
		);
		return { kind: "rejected" as const };
	}
	try {
		applyGoalSettings(runtime, withLimit(runtime.settings, field, limit), ctx, {
			save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
		});
		ctx.ui.notify(formatLimitSuccess(field, limit), "info");
		return { kind: "back" as const };
	} catch (error) {
		notifySettingsFailure(ctx, settingsPath, error);
		return { kind: "rejected" as const };
	}
}

export function applyGoalSettings(
	runtime: GoalRuntime,
	next: GoalSettings,
	ctx: ExtensionCommandContext,
	options: GoalSettingsApplyOptions = {},
) {
	const snapshot = runtime.snapshotSettingsApplicationState();
	let fileSaved = false;
	try {
		runtime.settings = structuredClone(next);
		applyToolVisibility(runtime, snapshot.settings, next, ctx);
		options.save?.(next);
		fileSaved = options.save !== undefined;
		applyQueueSetting(runtime, ctx);
		const activeGoalId = runtime.activeGoal?.id;
		const abortOwnedRun = activeGoalId !== undefined && runtime.agentRunGoalId === activeGoalId;
		const pausedByAutomaticLimit = runtime.enforceAutomaticTurnLimit(ctx, abortOwnedRun);
		if (!pausedByAutomaticLimit) runtime.enforceNoProgressLimit(ctx, abortOwnedRun);
		if (runtime.activeGoal && !runtime.queueFrozen) {
			runtime.updateStatus(ctx, runtime.activeGoal);
		}
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		try {
			runtime.restoreSettingsApplicationState(snapshot);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		if (fileSaved) {
			try {
				options.save?.(snapshot.settings);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			try {
				restorePersistedRuntime(runtime, ctx);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[error, ...rollbackErrors],
				`pi-goal settings application failed and rollback was incomplete: ${formatError(error)}`,
			);
		}
		throw error;
	}
}

export function parseGoalLimit(value: string): number | undefined {
	const normalized = value.trim();
	if (!/^\d+$/u.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatGoalLimit(value: number | null) {
	return value === null ? "无限制" : String(value);
}

async function resolveLimitSelection(
	field: LimitField,
	selection: LimitSelection,
	previous: number | null,
	ctx: ExtensionCommandContext,
	isCurrent: () => boolean,
): Promise<number | null | undefined> {
	if (selection === "off") return null;
	if (selection === "unlimited") {
		if (previous === null) return null;
		const confirmed = await ctx.ui.confirm(
			"允许无限制自动工作？",
			"工具循环可以在没有响应次数上限的情况下继续，可能消耗大量 token 和提供商费用。完成、手动暂停、阻塞、提供商限制和无进展保护仍然适用。",
		);
		return isCurrent() && confirmed ? null : undefined;
	}
	if (selection === "default") {
		return DEFAULT_GOAL_SETTINGS.continuationLimits[field];
	}
	while (true) {
		const raw =
			field === "automaticTurns"
				? await ctx.ui.editor(
						`自动工作响应上限（大于 0 的整数）· 默认：${DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns}`,
						String(previous ?? DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns),
					)
				: await ctx.ui.input(
						"重复运行阈值（大于 0 的整数）",
						previous === null ? "正整数" : String(previous),
					);
		if (!isCurrent() || raw === undefined) return undefined;
		const parsed = parseGoalLimit(raw);
		if (parsed !== undefined) return parsed;
		ctx.ui.notify(
			`请输入大于 0 的整数。如果不需要上限，请在上一个屏幕选择 ${field === "automaticTurns" ? "无限制" : "关闭"}。`,
			"warning",
		);
	}
}

async function nextQueueSettings(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	enabled: boolean,
) {
	if (runtime.settings.experimental.goals === enabled) return undefined;
	if (enabled && !runtime.settings.experimental.goals) {
		const confirmed = await ctx.ui.confirm(
			"启用实验性目标队列？",
			"队列行为和持久化状态可能在不同版本间变化。现有的单目标行为仍然可用。",
		);
		if (!confirmed) return undefined;
	}
	if (
		!enabled &&
		(runtime.queuedGoals.length > 0 || runtime.pendingQueueAction !== undefined) &&
		!(await ctx.ui.confirm(
			"冻结有序目标队列？",
			`禁用实验会保留 ${retainedGoalCount(runtime)} 个目标，但会冻结自动工作，直到重新启用该设置。不会删除任何目标数据。`,
		))
	) {
		return undefined;
	}
	return {
		...structuredClone(runtime.settings),
		experimental: { goals: enabled },
	} satisfies GoalSettings;
}

function applyToolVisibility(
	runtime: GoalRuntime,
	previous: GoalSettings,
	next: GoalSettings,
	ctx: ExtensionCommandContext,
) {
	runtime.toolPolicy.applyVisibilityChange(
		previous.toolVisibility,
		next.toolVisibility,
		runtime.activeGoal !== undefined,
		ctx,
	);
}

function applyQueueSetting(runtime: GoalRuntime, ctx: ExtensionCommandContext) {
	const hasQueueState = runtime.queuedGoals.length > 0 || runtime.pendingQueueAction !== undefined;
	const shouldFreeze = !runtime.settings.experimental.goals && hasQueueState;
	// Keep the freeze guard until the aborted Goal-owned run reaches agent_settled.
	// Releasing it earlier lets the old agent_end pause newly resumed work.
	if (runtime.queueFrozen && !shouldFreeze && runtime.queueFreezeAwaitingSettle) return;
	if (runtime.queueFrozen === shouldFreeze) return;
	const activeGoal = runtime.activeGoal?.status === "active" ? runtime.activeGoal : undefined;
	const goalOwnedRun = activeGoal && runtime.agentRunGoalId === activeGoal.id;
	if (shouldFreeze && activeGoal) {
		if (goalOwnedRun) runtime.recordGoalUsage(activeGoal, ctx, false);
		else {
			const now = Date.now();
			checkpointGoalActiveTime(activeGoal, now, false);
			activeGoal.updatedAt = now;
		}
	}
	runtime.queueFrozen = shouldFreeze;
	if (runtime.activeGoal) runtime.persistGoal(runtime.activeGoal);
	if (shouldFreeze) ctx.ui.setStatus(STATUS_KEY, "queue off");
	else if (runtime.activeGoal) runtime.updateStatus(ctx, runtime.activeGoal);
	else ctx.ui.setStatus(STATUS_KEY, undefined);
	if (!shouldFreeze) return;

	runtime.cancelContinuationWork();
	runtime.clearGoalRecovery();
	runtime.clearBudgetWrapUp();
	if (goalOwnedRun) {
		runtime.blockStaleGoalToolCalls();
		runtime.guardAbortGoalId = activeGoal.id;
		runtime.queueFreezeAwaitingSettle = true;
		runtime.clearAgentRun();
		abortCurrentTurn(ctx);
	}
}

function restorePersistedRuntime(runtime: GoalRuntime, ctx: ExtensionCommandContext) {
	if (runtime.activeGoal) {
		runtime.persistGoal(runtime.activeGoal);
		if (runtime.queueFrozen) ctx.ui.setStatus(STATUS_KEY, "queue off");
		else runtime.updateStatus(ctx, runtime.activeGoal);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

async function confirmLowerActiveLimit(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	field: LimitField,
	limit: number | null,
) {
	const goal = runtime.activeGoal;
	if (goal?.status !== "active" || limit === null) return { apply: true };
	const used = field === "automaticTurns" ? goal.automaticModelTurns : goal.toolFreeRepeatCount;
	if (used < limit) return { apply: true };
	return {
		apply: await ctx.ui.confirm(
			"立即应用上限并暂停？",
			`活动目标已使用 ${used}。将此上限设为 ${limit} 将立即暂停它，不会删除进度。`,
		),
		goalId: goal.id,
	};
}

function withLimit(settings: GoalSettings, field: LimitField, value: number | null): GoalSettings {
	return {
		...structuredClone(settings),
		continuationLimits: { ...settings.continuationLimits, [field]: value },
	};
}

function formatAutomaticSettingValue(value: number | null) {
	return value === null ? "无限制" : `${value} 次响应`;
}

function formatNoProgressSettingValue(value: number | null) {
	if (value === null) return "Off";
	return `${value} ${value === 1 ? "run" : "runs"}`;
}

function formatAutomaticWork(value: number | null) {
	return value === null ? "无限制" : `最多 ${value} 次响应`;
}

function formatNoProgressProtection(value: number | null) {
	if (value === null) return "Off";
	return `重复 ${value} 次后（${value === 1 ? "次运行" : "次运行"}）`;
}

function formatLimitSuccess(field: LimitField, value: number | null) {
	return field === "automaticTurns"
		? `自动工作上限：${formatAutomaticWork(value)}。`
		: `无进展保护：${formatNoProgressProtection(value)}。`;
}

function isLimitSelection(value: string): value is LimitSelection {
	return value === "unlimited" || value === "default" || value === "custom" || value === "off";
}

function visibilityLabel(value: GoalSettings["toolVisibility"]) {
	return value === "always" ? "始终" : "第一个目标后";
}

function retainedGoalCount(runtime: GoalRuntime) {
	return (
		(runtime.activeGoal ? 1 : 0) +
		runtime.queuedGoals.length +
		(runtime.pendingQueueAction?.kind === "prioritize" ? 1 : 0)
	);
}

function notifySettingsFailure(ctx: ExtensionCommandContext, settingsPath: string, error: unknown) {
	const path = safeTerminalText(settingsPath);
	const detail = safeTerminalText(formatError(error));
	ctx.ui.notify(
		error instanceof AggregateError
			? `无法应用目标设置，且回滚不完整。请检查 ${path}，运行 /reload，并在重试前验证生效设置：${detail}`
			: `无法保存目标设置；保留原值。请检查 ${path} 并重试：${detail}`,
		"error",
	);
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
