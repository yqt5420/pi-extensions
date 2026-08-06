import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanModeState } from "./state.js";

const STATUS_KEY = "plan-mode";
const PLAN_WIDGET_KEY = "plan-mode-plan";

export function updatePlanModeUi(
	ctx: ExtensionContext,
	state: PlanModeState,
	toolSummary: () => string,
) {
	ctx.ui.setStatus(STATUS_KEY, formatStatus(state));
	if (state.enabled && state.latestPlan) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, [
			"方案已就绪",
			"使用 /plan 实现、保存、修订或退出计划模式。",
		]);
	} else if (state.enabled) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, [
			"计划模式：规划中",
			toolSummary(),
			"决策就绪时用 plan_mode_complete 收尾。",
		]);
	} else if (state.savedPlan) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, [
			"计划已保存，稍后使用",
			"使用 /plan 显示、实现或清除它。",
		]);
	} else if (state.activeImplementation) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, [
			"实现计划进行中",
			"使用 /plan 显示、替换或清除它。",
		]);
	} else {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
	}
}

export function clearPlanModeUi(ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
}

export function showStoredPlan(pi: ExtensionAPI, ctx: ExtensionContext, state: PlanModeState) {
	const readyPlan = state.enabled ? state.latestPlan?.trim() : undefined;
	const savedPlan = state.savedPlan?.plan.trim();
	if (savedPlan && (ctx.mode === "print" || ctx.mode === "json")) {
		throw new Error("保存计划的显示在打印/JSON 模式下不可用。请使用 TUI 或 RPC。");
	}
	const activePlan = state.activeImplementation?.plan.trim();
	const plan = readyPlan ?? savedPlan ?? activePlan;
	if (!plan) {
		ctx.ui.notify(
			"没有可用的已完成计划。规划完成后使用 /plan finalize。",
			"info",
		);
		return;
	}
	const title = readyPlan
		? "Proposed Plan"
		: savedPlan
			? "已保存的计划"
			: "当前实现计划";
	showPlanModePlan(pi, ctx, title, plan);
}

export function showPlanModePlan(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	title: string,
	plan: string,
) {
	try {
		pi.sendMessage(
			{
				customType: "proposed-plan",
				content: `**${title}**\n\n${plan}`,
				display: true,
			},
			{ triggerTurn: false },
		);
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`无法显示已完成的计划：${detail}`, "error");
	}
}

export function planModeStatusText(state: PlanModeState, toolSummary: () => string) {
	if (state.enabled) {
		if (state.latestPlan) {
			return `计划模式已激活，提议的计划已就绪。${toolSummary()}`;
		}
		return `计划模式已激活。${toolSummary()} 探索、提问，决策就绪后用 plan_mode_complete 收尾。`;
	}
	if (state.savedPlan) return "有一个计划已保存，供稍后使用。";
	if (state.activeImplementation) return "有一个实现计划正在进行中。";
	return "计划模式已关闭。";
}

function formatStatus(state: PlanModeState) {
	if (state.enabled) {
		if (state.awaitingAction || state.latestPlan) return "plan ready";
		return "plan active";
	}
	if (state.savedPlan) return "plan saved";
	if (state.activeImplementation) return "plan implementing";
	return undefined;
}
