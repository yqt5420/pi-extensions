import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function savedPlanBlocksNewWorkflow(ctx: ExtensionContext, hasSavedPlan: boolean) {
	if (!hasSavedPlan) return false;
	const message =
		"已有为稍后保存的计划。在开始另一个计划模式工作流之前，请先实现或清除它。";
	if (!ctx.hasUI) throw new Error(message);
	ctx.ui.notify(message, "warning");
	return true;
}

export async function preflightSavedPlanImplementation(
	ctx: ExtensionContext,
	isCurrent: () => boolean,
) {
	if (ctx.mode === "print" || ctx.mode === "json") {
		throw new Error("保存计划的实现在打印/JSON 模式下不可用。请使用 TUI 或 RPC。");
	}
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("无法实现保存的计划：未选择模型。", "warning");
		return false;
	}
	let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch (error: unknown) {
		if (!isCurrent()) return false;
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`无法实现保存的计划：${detail}`, "error");
		return false;
	}
	if (!isCurrent()) return false;
	if (!auth.ok) {
		ctx.ui.notify(`无法实现保存的计划：${auth.error}`, "warning");
		return false;
	}
	return true;
}
