import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionMenuItem } from "@narumitw/pi-tui-kit";
import { formatTokenCount as formatCompactTokenCount, formatDuration } from "./accounting.js";
import { parseTokenBudget } from "./command.js";
import type { GoalCommandController } from "./commands.js";
import type { ActiveGoal, PendingQueueAction } from "./persistence.js";
import { goalQueueIdentity } from "./queue.js";
import { type GoalRuntime, goalSummary } from "./runtime.js";

export const GOAL_MENU_ACTIONS = {
	start: "开始一个目标…",
	startBudget: "带 token 预算开始…",
	pause: "暂停目标",
	resume: "恢复目标",
	reviewSafety: "审查并继续…",
	increaseBudget: "增加预算并恢复…",
	edit: "编辑目标…",
	replace: "替换目标…",
	status: "查看完整状态",
	queue: "队列…",
	settings: "设置…",
	help: "Help",
	clear: "清除目标…",
	close: "Close",
} as const;

const QUEUE_ACTIONS = {
	add: "添加目标…",
	prioritize: "优先处理目标…",
	skip: "跳过当前目标…",
	dropLast: "丢弃最后一个目标…",
	back: "Back",
} as const;

interface GoalMenuRuntimeView {
	activeGoal?: ActiveGoal;
	queuedGoals: ActiveGoal[];
	pendingQueueAction?: PendingQueueAction;
	queueFrozen: boolean;
	settings: GoalRuntime["settings"];
	recordGoalUsage?: GoalRuntime["recordGoalUsage"];
	persistGoal?: GoalRuntime["persistGoal"];
	updateStatus?: GoalRuntime["updateStatus"];
}

export interface GoalMenuState {
	title: string;
	actions: string[];
}

type ShowSettings = (ctx: ExtensionCommandContext, target?: "automatic") => Promise<void>;
type GoalMenuScreen =
	| "main"
	| "start-budget"
	| "start-custom-budget"
	| "increase-budget"
	| "safety"
	| "queue"
	| "status"
	| "help";
type GoalMenuAction =
	| "start"
	| "start-with-budget"
	| "start-with-custom-budget"
	| "submit-increase-budget"
	| "pause"
	| "resume"
	| "safety-resume"
	| "safety-settings"
	| "edit"
	| "replace"
	| "settings"
	| "clear"
	| "queue-add"
	| "queue-prioritize"
	| "queue-skip"
	| "queue-drop"
	| "back";

export function buildGoalMenuState(runtime: GoalMenuRuntimeView): GoalMenuState {
	const goal = runtime.activeGoal;
	const queueCount = runtime.queuedGoals.length;
	const pausedByAutomaticLimit =
		goal?.status === "paused" && goal.safetyPauseCause === "continuation_limit";
	const state = runtime.queueFrozen
		? "队列已冻结"
		: runtime.pendingQueueAction
			? "等待 Pi 安定"
			: pausedByAutomaticLimit
				? "已暂停 — 达到自动工作上限"
				: displayStatus(goal?.status);
	const automaticTurnLimit = runtime.settings.continuationLimits.automaticTurns;
	const used = goal?.automaticModelTurns ?? 0;
	const automaticResponses =
		automaticTurnLimit === null
			? `自动工作：${used} 次响应 · 无限制`
			: `Automatic work: ${used} of ${automaticTurnLimit} responses${
					used < automaticTurnLimit ? ` · ${automaticTurnLimit - used} remaining` : ""
				}`;
	const title = goal
		? [
				`目标 · ${state}`,
				safeGoalMenuText(goal.text),
				`Usage: ${
					goal.tokenBudget === undefined
						? formatDuration(goal.timeUsedSeconds)
						: `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`
				}`,
				automaticResponses,
				...(pausedByAutomaticLimit
					? ["进度已保存。继续前请审查安全限制。"]
					: []),
				...(queueCount > 0 ? [`队列：${queueCount} 个排队中`] : []),
			].join("\n")
		: [
				`目标 · ${state}`,
				"当前未设置目标",
				automaticTurnLimit === null
					? "自动工作配置为无限制。"
					: `自动工作配置为在 ${automaticTurnLimit} 次响应后暂停。`,
			].join("\n");

	if (runtime.queueFrozen || runtime.pendingQueueAction) {
		return {
			title,
			actions: [
				GOAL_MENU_ACTIONS.status,
				GOAL_MENU_ACTIONS.settings,
				GOAL_MENU_ACTIONS.help,
				GOAL_MENU_ACTIONS.clear,
				GOAL_MENU_ACTIONS.close,
			],
		};
	}

	const actions: string[] = [];
	if (!goal || goal.status === "complete") {
		actions.push(GOAL_MENU_ACTIONS.start, GOAL_MENU_ACTIONS.startBudget);
	} else if (goal.status === "active") {
		actions.push(GOAL_MENU_ACTIONS.pause);
	} else if (goal.status === "budget_limited") {
		actions.push(GOAL_MENU_ACTIONS.increaseBudget);
	} else if (pausedByAutomaticLimit) {
		actions.push(GOAL_MENU_ACTIONS.reviewSafety);
	} else {
		actions.push(GOAL_MENU_ACTIONS.resume);
	}
	if (goal && goal.status !== "complete") {
		actions.push(GOAL_MENU_ACTIONS.edit, GOAL_MENU_ACTIONS.replace);
	}
	if (goal) actions.push(GOAL_MENU_ACTIONS.status);
	if (goal && (runtime.settings.experimental.goals || queueCount > 0)) {
		actions.push(GOAL_MENU_ACTIONS.queue);
	}
	actions.push(GOAL_MENU_ACTIONS.settings, GOAL_MENU_ACTIONS.help);
	if (goal) actions.push(GOAL_MENU_ACTIONS.clear);
	actions.push(GOAL_MENU_ACTIONS.close);
	return { title, actions };
}

export async function showGoalManager(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	showSettings: ShowSettings,
): Promise<void> {
	if (ctx.mode !== "tui") {
		commands.showGoal(ctx);
		return;
	}
	const owner = runtime as GoalRuntime;
	const generation = owner.menuGeneration;
	const ownerSignal = owner.menuController?.signal;
	const isMenuCurrent = () =>
		owner.menuController === undefined ||
		(generation === owner.menuGeneration && !owner.menuController.signal.aborted);
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (!isMenuCurrent()) return;
	let displayedGoal: ActiveGoal | undefined;
	let startBudgetQueueIdentity = currentGoalQueueIdentity(runtime);
	let displayedBudgetGoal: ActiveGoal | undefined;
	let displayedBudgetValue: number | undefined;
	let displayedBudgetUsage: number | undefined;
	let displayedBudgetStatus: ActiveGoal["status"] | undefined;
	let displayedQueueHead: ActiveGoal | undefined;
	let displayedQueueFirst: ActiveGoal | undefined;
	let displayedQueueLast: ActiveGoal | undefined;
	const menu = defineMenu<undefined, GoalMenuScreen, GoalMenuAction, ExtensionCommandContext>({
		start: "main",
		screens: {
			main: () => {
				refreshGoalMenuState(runtime, ctx);
				const state = buildGoalMenuState(runtime);
				displayedGoal = runtime.activeGoal;
				startBudgetQueueIdentity = currentGoalQueueIdentity(runtime);
				return {
					kind: "actions",
					title: "Goal",
					lines: state.title.split("\n").slice(1),
					items: state.actions.map(goalMainMenuItem),
					hint: "close",
				};
			},
			"start-budget": () => {
				return {
					kind: "actions",
					title: "选择 token 预算",
					lines: tokenBudgetGuidance(runtime.settings.continuationLimits.automaticTurns),
					items: [
						{
							id: "25k",
							label: "25k — 较低 token 上限",
							description: "将累计 token 上限设为 25k。",
							action: "start-with-budget",
						},
						{
							id: "100k",
							label: "100k — 推荐",
							description: "将累计 token 上限设为 100k。",
							action: "start-with-budget",
						},
						{
							id: "300k",
							label: "300k — 较高 token 上限",
							description: "将累计 token 上限设为 300k。",
							action: "start-with-budget",
						},
						{
							id: "custom",
							label: "设置自定义预算…",
							description: "输入精确的累计 token 上限。",
							to: "start-custom-budget",
						},
						{ id: "back", label: "Back", action: "back" },
					],
					hint: "back",
				};
			},
			"start-custom-budget": () => ({
				kind: "input",
				title: "自定义 token 预算",
				lines: customTokenBudgetGuidance(runtime.settings.continuationLimits.automaticTurns),
				placeholder: "100k",
				action: "start-with-custom-budget",
				hint: "back",
			}),
			"increase-budget": () => {
				const goal = runtime.activeGoal;
				displayedBudgetGoal = goal;
				displayedBudgetValue = goal?.tokenBudget;
				displayedBudgetUsage = goal?.tokensUsed;
				displayedBudgetStatus = goal?.status;
				if (goal && goal.tokensUsed >= Number.MAX_SAFE_INTEGER) {
					return {
						kind: "detail",
						title: "无法增加 token 预算",
						lines: [
							`当前用量：${formatBudgetDecisionValue(goal.tokensUsed)}`,
							"没有更大的安全整数 token 预算可用。进度仍然保存；准备好时选择「返回」并清除或替换目标。",
						],
						hint: "back",
					};
				}
				return {
					kind: "input",
					title: "增加 token 预算",
					lines: goal
						? increaseTokenBudgetGuidance(goal, runtime.settings.continuationLimits.automaticTurns)
						: ["预算受限的目标已不可用。返回目标菜单。"],
					placeholder: goal ? suggestedIncreasedBudget(goal) : "300k",
					action: "submit-increase-budget",
					hint: "back",
				};
			},
			safety: () => {
				const goal = runtime.activeGoal;
				displayedGoal = goal;
				const limit = runtime.settings.continuationLimits.automaticTurns;
				const used = goal?.automaticModelTurns ?? 0;
				const queueCount = runtime.queuedGoals.length;
				return {
					kind: "actions",
					title: "自动工作已暂停",
					lines: goal
						? [
								automaticPauseSummary(used, limit),
								`${safeGoalMenuText(goal.text)} 已保留。`,
								`已保留 ${formatInteger(goal.tokensUsed)} 个累计 token 和 ${formatDuration(goal.timeUsedSeconds)} 的活动时间。`,
								`目标、用量和 ${queueCount} 个排队目标已保留。`,
								limit === null
									? "Continuing resets the counter to 0 and resumes with 无限制 automatic work."
									: `继续将计数器重置为 0，并允许最多 ${limit} 次更多自动模型响应。`,
							]
						: ["已暂停的目标已不可用。返回目标菜单。"],
					items: goal
						? [
								{
									id: "continue",
									label:
										limit === null
											? "Continue — 无限制"
											: `继续 — 最多 ${limit} 次更多响应`,
									action: "safety-resume" as const,
								},
								{
									id: "settings",
									label: "更改自动工作上限…",
									action: "safety-settings" as const,
								},
								{ id: "back", label: "Back", action: "back" as const },
							]
						: [{ id: "back", label: "Back", action: "back" as const }],
					hint: "back",
				};
			},
			queue: () => {
				displayedQueueHead = runtime.activeGoal;
				displayedQueueFirst = runtime.queuedGoals[0];
				displayedQueueLast = runtime.queuedGoals.at(-1) ?? runtime.activeGoal;
				return {
					kind: "actions",
					title: "目标队列",
					lines: [
						`共 ${runtime.queuedGoals.length + (runtime.activeGoal ? 1 : 0)} 个`,
						...(runtime.activeGoal
							? [`当前：${safeGoalMenuText(runtime.activeGoal.text)}`]
							: []),
					],
					items: [
						{ id: "add", label: QUEUE_ACTIONS.add, action: "queue-add" },
						{ id: "prioritize", label: QUEUE_ACTIONS.prioritize, action: "queue-prioritize" },
						...(runtime.queuedGoals.length > 0
							? [
									{ id: "skip", label: QUEUE_ACTIONS.skip, action: "queue-skip" as const },
									{
										id: "drop-last",
										label: QUEUE_ACTIONS.dropLast,
										action: "queue-drop" as const,
									},
								]
							: []),
						{ id: "back", label: QUEUE_ACTIONS.back, action: "back" },
					],
					hint: "back",
				};
			},
			status: () => ({
				kind: "detail",
				title: "目标状态",
				lines: runtime.activeGoal
					? goalSummary(
							runtime.activeGoal,
							runtime.queuedGoals,
							runtime.settings.experimental.goals,
							runtime.queueFrozen,
							runtime.pendingQueueAction,
							runtime.settings.continuationLimits.automaticTurns,
						).split("\n")
					: ["当前未设置目标。"],
				hint: "back",
			}),
			help: () => ({
				kind: "detail",
				title: "目标帮助",
				lines: goalHelp().split("\n").slice(1),
				hint: "back",
			}),
		},
		actions: {
			start: async () => {
				await startFromMenu(commands, ctx);
				return { kind: "close" };
			},
			"start-with-budget": async ({ itemId, signal }) => {
				const budget = parseTokenBudget(itemId);
				if (budget === undefined) return { kind: "rejected" };
				return startBudgetedGoal(
					runtime,
					commands,
					ctx,
					budget,
					runtime.settings.continuationLimits.automaticTurns,
					startBudgetQueueIdentity,
					signal,
					isMenuCurrent,
					"stay",
				);
			},
			"start-with-custom-budget": async ({ value, signal }) => {
				const budget = parseTokenBudget(value ?? "");
				if (budget === undefined) {
					ctx.ui.notify(
						"请输入正 token 数量，例如 25k、300k 或 1.5m。",
						"warning",
					);
					return { kind: "rejected" };
				}
				return startBudgetedGoal(
					runtime,
					commands,
					ctx,
					budget,
					runtime.settings.continuationLimits.automaticTurns,
					startBudgetQueueIdentity,
					signal,
					isMenuCurrent,
					"back",
				);
			},
			"submit-increase-budget": async ({ value, signal }) => {
				const goal = displayedBudgetGoal;
				const budget = parseTokenBudget(value ?? "");
				if (budget === undefined) {
					ctx.ui.notify(
						"请输入正 token 数量，例如 300k、1.5m 或 300000。",
						"warning",
					);
					return { kind: "rejected" };
				}
				if (
					!goal ||
					!requireCurrentBudgetPreview(
						runtime,
						goal,
						displayedBudgetValue,
						displayedBudgetUsage,
						displayedBudgetStatus,
						ctx,
					)
				) {
					return { kind: "close" };
				}
				if (budget <= goal.tokensUsed) {
					ctx.ui.notify(
						`请输入大于当前用量（${formatCompactTokenCount(goal.tokensUsed)}）的新的累计总数。`,
						"warning",
					);
					return { kind: "rejected" };
				}
				const confirmed = await ctx.ui.confirm(
					"增加目标预算？",
					increaseBudgetPreview(goal, budget, runtime.settings.continuationLimits.automaticTurns),
				);
				if (signal.aborted || !isMenuCurrent()) return { kind: "close" };
				if (!confirmed) return { kind: "rejected" };
				if (
					!requireCurrentBudgetPreview(
						runtime,
						goal,
						displayedBudgetValue,
						displayedBudgetUsage,
						displayedBudgetStatus,
						ctx,
					)
				) {
					return { kind: "close" };
				}
				await commands.editGoal(goal.text, budget, ctx);
				return { kind: "close" };
			},
			pause: async () => {
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
					return { kind: "stay" };
				}
				commands.pauseGoal(ctx);
				return { kind: "close" };
			},
			resume: async () => {
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
					return { kind: "stay" };
				}
				await commands.resumeGoal(ctx);
				return { kind: "close" };
			},
			"safety-resume": async () => {
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
					return { kind: "stay" };
				}
				await commands.resumeGoal(ctx);
				return { kind: "close" };
			},
			"safety-settings": async () => {
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
					return { kind: "stay" };
				}
				const expectedGoal = displayedGoal;
				await showSettings(ctx, "automatic");
				if (!isMenuCurrent()) return { kind: "close" };
				if (!requireCurrentMenuGoal(runtime, expectedGoal, ctx)) return { kind: "stay" };
				return { kind: "stay" };
			},
			edit: async () => {
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
					return { kind: "stay" };
				}
				await editFromMenu(runtime, commands, ctx);
				return { kind: "close" };
			},
			replace: async () => {
				await startFromMenu(commands, ctx);
				return { kind: "close" };
			},
			settings: async () => {
				await showSettings(ctx);
				return { kind: "stay" };
			},
			clear: async () => {
				const previewedQueue = goalQueueIdentity(
					runtime.activeGoal,
					runtime.queuedGoals,
					runtime.pendingQueueAction,
				);
				if (!(await confirmClear(runtime, ctx))) return { kind: "stay" };
				if (
					goalQueueIdentity(runtime.activeGoal, runtime.queuedGoals, runtime.pendingQueueAction) !==
					previewedQueue
				) {
					ctx.ui.notify(
						"打开对话框期间目标队列已更改。请重新打开 /goal 再试一次。",
						"warning",
					);
					return { kind: "stay" };
				}
				commands.clearGoal(ctx);
				return { kind: "close" };
			},
			"queue-add": async () => {
				const objective = (await ctx.ui.editor("添加目标到队列", ""))?.trim();
				if (objective) await commands.addGoal(objective, undefined, ctx);
				return { kind: "close" };
			},
			"queue-prioritize": async () => {
				const goal = displayedQueueHead;
				if (!goal) return { kind: "stay" };
				const objective = (await ctx.ui.editor("优先处理目标", ""))?.trim();
				if (!objective || !requireCurrentQueueHead(runtime, goal, ctx)) return { kind: "stay" };
				const confirmed = await ctx.ui.confirm(
					"优先处理目标？",
					`新优先目标：\n${safeGoalMenuText(objective, 4_000)}\n\n当前目标移至队列：\n${safeGoalMenuText(goal.text, 4_000)}`,
				);
				if (confirmed && requireCurrentQueueHead(runtime, goal, ctx)) {
					await commands.prioritizeGoal(objective, undefined, ctx);
				}
				return { kind: "close" };
			},
			"queue-skip": async () => {
				const goal = displayedQueueHead;
				if (!goal) return { kind: "stay" };
				const next = displayedQueueFirst;
				const nextEffect = !next
					? "没有剩余目标"
					: next.status === "queued"
						? `开始下一个目标：\n${safeGoalMenuText(next.text, 4_000)}`
						: `下一个目标仍为 ${displayStatus(next.status).toLowerCase()}：\n${safeGoalMenuText(next.text, 4_000)}`;
				const confirmed = await ctx.ui.confirm(
					"跳过当前目标？",
					`移除当前目标：\n${safeGoalMenuText(goal.text, 4_000)}\n\n${nextEffect}`,
				);
				if (confirmed && requireCurrentQueueSelection(runtime, goal, next, "first", ctx)) {
					await commands.skipGoal(ctx);
				}
				return { kind: "close" };
			},
			"queue-drop": async () => {
				const goal = displayedQueueHead;
				const last = displayedQueueLast;
				if (!goal || !last) return { kind: "stay" };
				const confirmed = await ctx.ui.confirm(
					"丢弃最后一个目标？",
					`从队列移除：\n${safeGoalMenuText(last.text, 4_000)}`,
				);
				if (confirmed && requireCurrentQueueSelection(runtime, goal, last, "last", ctx)) {
					commands.dropLastGoal(ctx);
				}
				return { kind: "close" };
			},
			back: async () => ({ kind: "back" }),
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: ownerSignal,
		isCurrent: isMenuCurrent,
	});
}

function goalMainMenuItem(label: string): ActionMenuItem<GoalMenuScreen, GoalMenuAction> {
	if (label === GOAL_MENU_ACTIONS.status) return { id: "status", label, to: "status" as const };
	if (label === GOAL_MENU_ACTIONS.startBudget) {
		return { id: "start-budget", label, to: "start-budget" as const };
	}
	if (label === GOAL_MENU_ACTIONS.increaseBudget) {
		return { id: "increase-budget", label, to: "increase-budget" as const };
	}
	if (label === GOAL_MENU_ACTIONS.reviewSafety) {
		return { id: "review-safety", label, to: "safety" as const };
	}
	if (label === GOAL_MENU_ACTIONS.queue) return { id: "queue", label, to: "queue" as const };
	if (label === GOAL_MENU_ACTIONS.help) return { id: "help", label, to: "help" as const };
	if (label === GOAL_MENU_ACTIONS.close) return { id: "close", label, close: true as const };
	const actions = new Map<string, GoalMenuAction>([
		[GOAL_MENU_ACTIONS.start, "start"],
		[GOAL_MENU_ACTIONS.pause, "pause"],
		[GOAL_MENU_ACTIONS.resume, "resume"],
		[GOAL_MENU_ACTIONS.edit, "edit"],
		[GOAL_MENU_ACTIONS.replace, "replace"],
		[GOAL_MENU_ACTIONS.settings, "settings"],
		[GOAL_MENU_ACTIONS.clear, "clear"],
	]);
	return { id: actions.get(label) ?? label, label, action: actions.get(label) ?? "settings" };
}

function refreshGoalMenuState(runtime: GoalMenuRuntimeView, ctx: ExtensionCommandContext) {
	const goal = runtime.activeGoal;
	if (!goal || runtime.queueFrozen) return;
	runtime.recordGoalUsage?.(goal, ctx);
	runtime.persistGoal?.(goal);
	runtime.updateStatus?.(ctx, goal);
}

export function safeGoalMenuText(value: string, maxCharacters = 120) {
	const sanitized = [...value]
		.map((character) => (isTerminalControl(character) ? " " : character))
		.join("")
		.replace(/\s+/gu, " ")
		.trim();
	const characters = [...sanitized];
	return characters.length <= maxCharacters
		? sanitized
		: `${characters.slice(0, maxCharacters).join("")}…`;
}

async function startFromMenu(commands: GoalCommandController, ctx: ExtensionCommandContext) {
	const objective = (await ctx.ui.editor("目标目标", ""))?.trim();
	if (!objective) return;
	await commands.startGoal(objective, undefined, ctx);
}

async function startBudgetedGoal(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	budget: number,
	automaticLimit: number | null,
	expectedQueueIdentity: string,
	signal: AbortSignal,
	isMenuCurrent: () => boolean,
	cancelTransition: "stay" | "back",
) {
	if (!requireCurrentStartBudgetQueue(runtime, expectedQueueIdentity, ctx)) {
		return { kind: "rejected" as const };
	}
	const objective = (
		await ctx.ui.editor(
			`目标目标 · Token 预算 ${formatCompactTokenCount(budget)} · ${automaticLimit === null ? "自动无限制" : `自动上限 ${automaticLimit}`}`,
			"",
		)
	)?.trim();
	if (signal.aborted || !isMenuCurrent()) return { kind: "close" as const };
	if (!objective) return { kind: cancelTransition } as const;
	if (!requireCurrentStartBudgetQueue(runtime, expectedQueueIdentity, ctx)) {
		return { kind: "rejected" as const };
	}
	await commands.startGoal(
		objective,
		budget,
		ctx,
		undefined,
		() => !signal.aborted && isMenuCurrent(),
		() => !signal.aborted && isMenuCurrent(),
	);
	return { kind: "close" as const };
}

function tokenBudgetGuidance(automaticLimit: number | null) {
	return [
		"Set the maximum cumulative token usage for this goal.",
		"The final model call may exceed the limit; this is not a dollar-cost cap.",
		automaticBudgetGuidance(automaticLimit),
	];
}

function customTokenBudgetGuidance(automaticLimit: number | null) {
	return [
		"Enter the maximum cumulative token usage for this goal.",
		"Examples: 25k, 300k, 1.5m, or 300000.",
		"The final model call may exceed this value; this is not a dollar-cost cap.",
		automaticBudgetGuidance(automaticLimit),
	];
}

function automaticBudgetGuidance(automaticLimit: number | null) {
	return automaticLimit === null
		? "Automatic work has no response-count cap."
		: `自动工作也将在 ${automaticLimit} 次响应后暂停。`;
}

function increaseTokenBudgetGuidance(goal: ActiveGoal, automaticLimit: number | null) {
	return [
		`当前预算：${formatBudgetDecisionValue(goal.tokenBudget ?? 0)}`,
		`当前用量：${formatBudgetDecisionValue(goal.tokensUsed)}`,
		`请输入大于 ${formatBudgetDecisionValue(goal.tokensUsed)} 的新的累计总数。`,
		"Examples: 300k, 1.5m, or 300000.",
		"The final model call may exceed the limit; this is not a dollar-cost cap.",
		automaticBudgetGuidance(automaticLimit),
	];
}

function suggestedIncreasedBudget(goal: ActiveGoal) {
	const floor = Math.max(goal.tokensUsed, goal.tokenBudget ?? 0);
	for (const suggestion of [25_000, 100_000, 300_000, 500_000, 1_000_000]) {
		if (suggestion > floor) return formatCompactTokenCount(suggestion);
	}
	return formatCompactTokenCount(
		Math.min(Number.MAX_SAFE_INTEGER, Math.max(Math.floor(floor) + 1, Math.ceil(floor * 2))),
	);
}

function formatBudgetDecisionValue(value: number) {
	const compact = formatCompactTokenCount(value);
	if (value < 1_000 || value % 1_000 === 0) return compact;
	return `${compact} (${formatInteger(value)} tokens)`;
}

function increaseBudgetPreview(goal: ActiveGoal, budget: number, automaticLimit: number | null) {
	return [
		`Goal: ${safeGoalMenuText(goal.text, 4_000)}`,
		`Budget: ${formatCompactTokenCount(goal.tokenBudget ?? 0)} → ${formatCompactTokenCount(budget)}`,
		`当前用量：${formatCompactTokenCount(goal.tokensUsed)}`,
		automaticLimit === null
			? "Automatic work: 无限制 after resume"
			: `自动工作：恢复后最多 ${automaticLimit} 次更多响应`,
		"The goal will resume immediately.",
	].join("\n");
}

async function editFromMenu(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
) {
	const goal = runtime.activeGoal;
	if (!goal) return;
	const objective = (await ctx.ui.editor("编辑目标目标", goal.text))?.trim();
	if (!objective || objective === goal.text) return;
	if (!requireCurrentMenuGoal(runtime, goal, ctx)) return;
	if (goal.status === "active") {
		const confirmed = await ctx.ui.confirm(
			"应用目标编辑？",
			`当前目标：\n${safeGoalMenuText(goal.text, 4_000)}\n\n更新后的目标：\n${safeGoalMenuText(objective, 4_000)}\n\n应用此编辑将启动一个新的受保护目标实例。`,
		);
		if (!confirmed || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
	}
	await commands.editGoal(objective, undefined, ctx);
}

async function confirmClear(runtime: GoalMenuRuntimeView, ctx: ExtensionCommandContext) {
	const goals = [runtime.activeGoal, ...runtime.queuedGoals].filter(
		(goal): goal is ActiveGoal => goal !== undefined,
	);
	const pendingPriority =
		runtime.pendingQueueAction?.kind === "prioritize"
			? runtime.pendingQueueAction.objective
			: undefined;
	const summaries = [
		...goals.map((goal) => safeGoalMenuText(goal.text, 4_000)),
		...(pendingPriority ? [`待处理优先：${safeGoalMenuText(pendingPriority, 4_000)}`] : []),
	];
	if (summaries.length === 0) return false;
	return ctx.ui.confirm(
		summaries.length > 1 ? "清除目标队列？" : "清除目标？",
		`Remove ${summaries.length === 1 ? "this goal" : `all ${summaries.length} goals`}:\n\n${summaries
			.map((summary, index) => `${index + 1}. ${summary}`)
			.join("\n")}\n\nThis cannot be undone.`,
	);
}

function currentGoalQueueIdentity(runtime: GoalMenuRuntimeView) {
	return goalQueueIdentity(runtime.activeGoal, runtime.queuedGoals, runtime.pendingQueueAction);
}

function requireCurrentStartBudgetQueue(
	runtime: GoalMenuRuntimeView,
	expectedIdentity: string,
	ctx: ExtensionCommandContext,
) {
	if (currentGoalQueueIdentity(runtime) === expectedIdentity) {
		return true;
	}
	ctx.ui.notify(
		"打开 token 预算流程期间目标队列已更改。请重新打开 /goal 再试一次。",
		"warning",
	);
	return false;
}

function requireCurrentBudgetPreview(
	runtime: GoalMenuRuntimeView,
	expectedGoal: ActiveGoal,
	expectedBudget: number | undefined,
	expectedUsage: number | undefined,
	expectedStatus: ActiveGoal["status"] | undefined,
	ctx: ExtensionCommandContext,
) {
	const current = runtime.activeGoal;
	if (
		current?.id === expectedGoal.id &&
		current.tokenBudget === expectedBudget &&
		current.tokensUsed === expectedUsage &&
		current.status === expectedStatus
	) {
		return true;
	}
	ctx.ui.notify(
		"打开预算对话框期间目标或其用量已更改。请重新打开 /goal 再试一次。",
		"warning",
	);
	return false;
}

function requireCurrentQueueHead(
	runtime: GoalMenuRuntimeView,
	expectedGoal: ActiveGoal,
	ctx: ExtensionCommandContext,
) {
	if (runtime.activeGoal?.id === expectedGoal.id) return true;
	ctx.ui.notify(
		"打开对话框期间目标队列已更改。请重新打开 /goal 再试一次。",
		"warning",
	);
	return false;
}

function requireCurrentQueueSelection(
	runtime: GoalMenuRuntimeView,
	expectedGoal: ActiveGoal,
	expectedQueuedGoal: ActiveGoal | undefined,
	position: "first" | "last",
	ctx: ExtensionCommandContext,
) {
	const currentQueuedGoal =
		position === "first"
			? runtime.queuedGoals[0]
			: (runtime.queuedGoals.at(-1) ?? runtime.activeGoal);
	if (
		runtime.activeGoal?.id === expectedGoal.id &&
		currentQueuedGoal?.id === expectedQueuedGoal?.id
	) {
		return true;
	}
	ctx.ui.notify(
		"打开对话框期间目标队列已更改。请重新打开 /goal 再试一次。",
		"warning",
	);
	return false;
}

function requireCurrentMenuGoal(
	runtime: GoalMenuRuntimeView,
	expected: ActiveGoal,
	ctx: ExtensionCommandContext,
) {
	if (runtime.activeGoal?.id === expected.id) return true;
	ctx.ui.notify(
		"打开对话框期间活动目标已更改。请重新打开 /goal 再试一次。",
		"warning",
	);
	return false;
}

function displayStatus(status?: ActiveGoal["status"]) {
	if (!status) return "无目标";
	if (status === "usage_limited") return "用量受限";
	if (status === "budget_limited") return "预算受限";
	return status[0]?.toUpperCase() + status.slice(1);
}

function formatTokenCount(tokens: number) {
	return String(tokens);
}

function formatInteger(value: number) {
	return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function automaticPauseSummary(used: number, limit: number | null) {
	if (limit === null) {
		return `目标在其之前的安全限制下于 ${used} 次响应后暂停。当前限制：无限制。`;
	}
	if (used < limit) {
		return `目标在其之前的安全限制下于 ${used} 次响应后暂停。当前自动工作限制：${limit}。`;
	}
	return `目标已达到其 ${used}/${limit} 安全限制。`;
}

function isTerminalControl(character: string) {
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function goalHelp() {
	return [
		"目标菜单",
		"使用菜单进行引导式状态查看、编辑、队列管理、设置和确认。",
		"直接路由仍可用于确定性工作流：",
		"/goal <objective>",
		"/goal status | pause | resume | edit | clear",
		"/goal --tokens 100k <objective>",
		"按 Esc 取消当前菜单或输入，不更改目标状态。",
	].join("\n");
}
