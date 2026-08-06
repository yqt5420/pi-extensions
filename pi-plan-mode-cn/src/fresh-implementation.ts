import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImplementationPlanRetention } from "./settings.js";
import type { PlanCompletionSource, PlanModeState } from "./state.js";

type NewSessionOptions = Exclude<Parameters<ExtensionCommandContext["newSession"]>[0], undefined>;
type ReplacementContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

export interface FreshImplementationRequest {
	plan: string;
	source: PlanCompletionSource;
	retention: ImplementationPlanRetention;
	stateEntryType: string;
	isCurrent(): boolean;
}

interface FreshImplementationFromStateOptions {
	getState(): PlanModeState;
	menuIsCurrent(): boolean;
	retention: ImplementationPlanRetention;
	stateEntryType: string;
}

export type FreshImplementationResult =
	| { kind: "started" }
	| { kind: "cancelled" }
	| { kind: "partial" }
	| { kind: "rejected" }
	| { kind: "stale" };

export function formatImplementationHandoff(plan: string) {
	return `计划模式现已禁用。完整工具访问已恢复。现在请实现这份提议的计划：\n\n${plan}`;
}

export async function startFreshImplementationFromState(
	ctx: ExtensionContext,
	options: FreshImplementationFromStateOptions,
) {
	if (!isCommandContext(ctx)) {
		ctx.ui.notify(
			"全新实现需要交互式 /plan 命令。请重新打开 /plan 再试一次。",
			"warning",
		);
		return { kind: "rejected" } as const;
	}
	const initialState = options.getState();
	const savedPlan = initialState.enabled ? undefined : initialState.savedPlan;
	const plan = (initialState.enabled ? initialState.latestPlan : savedPlan?.plan)?.trim();
	const source = initialState.enabled ? initialState.latestPlanSource : savedPlan?.source;
	if (!plan || !source) {
		ctx.ui.notify("没有可实现的已完成计划。", "warning");
		return { kind: "rejected" } as const;
	}
	const wasEnabled = initialState.enabled;
	const isCurrent = () => {
		const current = options.getState();
		return (
			options.menuIsCurrent() &&
			current.enabled === wasEnabled &&
			(wasEnabled
				? current.latestPlan === plan && current.latestPlanSource === source
				: current.savedPlan === savedPlan)
		);
	};
	return startFreshImplementationSession(ctx, {
		plan,
		source,
		retention: options.retention,
		stateEntryType: options.stateEntryType,
		isCurrent,
	});
}

export async function startFreshImplementationSession(
	ctx: ExtensionCommandContext,
	request: FreshImplementationRequest,
): Promise<FreshImplementationResult> {
	if (ctx.mode === "print" || ctx.mode === "json") {
		throw new Error("全新计划实现在打印/JSON 模式下不可用。请使用 TUI 或 RPC。");
	}

	await ctx.waitForIdle();
	if (!request.isCurrent()) return { kind: "stale" };
	if (!(await preflightModel(ctx, request.isCurrent))) return { kind: "rejected" };
	if (!request.isCurrent()) return { kind: "stale" };

	const activeImplementation = {
		id: randomUUID(),
		plan: request.plan,
		source: request.source,
		startedAt: Date.now(),
		retention: request.retention,
	};
	const destinationState: PlanModeState = {
		enabled: false,
		awaitingAction: false,
		activeImplementation,
	};
	const handoff = formatImplementationHandoff(request.plan);
	const parentSession = ctx.sessionManager.getSessionFile();
	let setupError: string | undefined;
	let kickoffError: string | undefined;

	if (ctx.mode === "rpc") ctx.ui.notify("正在启动全新实现会话…", "info");

	let result: Awaited<ReturnType<ExtensionCommandContext["newSession"]>>;
	try {
		result = await ctx.newSession({
			...(parentSession ? { parentSession } : {}),
			setup: async (sessionManager) => {
				try {
					sessionManager.appendCustomEntry(request.stateEntryType, destinationState);
				} catch (error: unknown) {
					setupError = safeErrorDetail(error);
				}
			},
			withSession: async (replacementCtx) => {
				if (setupError) {
					recoverSetupFailure(replacementCtx, handoff, setupError);
					return;
				}
				try {
					await replacementCtx.sendUserMessage(handoff);
					replacementCtx.ui.notify(
						"全新实现会话已启动。只转移了已批准的计划。",
						"info",
					);
				} catch (error: unknown) {
					kickoffError = safeErrorDetail(error);
					replacementCtx.ui.notify(
						`新会话已创建，但实现未启动：${kickoffError}。发送消息继续，使用 /plan exit 清除当前计划，或恢复父规划会话。`,
						"error",
					);
				}
			},
		});
	} catch (error: unknown) {
		safeNotify(
			ctx,
			`无法启动全新实现会话：${safeErrorDetail(error)}。源计划仍可用；请重试或恢复规划会话。`,
			"error",
		);
		return { kind: "rejected" };
	}

	if (result.cancelled) {
		ctx.ui.notify("全新实现已取消。计划仍然可用。", "info");
		return { kind: "cancelled" };
	}
	return setupError || kickoffError ? { kind: "partial" } : { kind: "started" };
}

async function preflightModel(ctx: ExtensionCommandContext, isCurrent: () => boolean) {
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("无法实现计划：未选择模型。", "warning");
		return false;
	}
	let auth: Awaited<ReturnType<ExtensionCommandContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch (error: unknown) {
		if (isCurrent()) {
			ctx.ui.notify(`无法实现计划：${safeErrorDetail(error)}`, "error");
		}
		return false;
	}
	if (!isCurrent()) return false;
	if (!auth.ok) {
		ctx.ui.notify(`无法实现计划：${safeErrorDetail(auth.error)}`, "warning");
		return false;
	}
	return true;
}

function recoverSetupFailure(ctx: ReplacementContext, handoff: string, setupError: string) {
	ctx.ui.setEditorText(handoff);
	ctx.ui.notify(
		`新会话已创建，但当前计划无法保存：${setupError}。实现请求已在编辑器中；提交它以继续，或恢复父规划会话。`,
		"error",
	);
}

function safeNotify(
	ctx: ExtensionCommandContext,
	message: string,
	level: "info" | "warning" | "error",
) {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// The source context can become stale if Pi fails after replacement teardown.
	}
}

function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function";
}

function safeErrorDetail(error: unknown) {
	const detail = error instanceof Error ? error.message : String(error);
	const normalized =
		[...detail]
			.map((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
			})
			.join("")
			.replace(/\s+/gu, " ")
			.trim() || "unknown error";
	const characters = [...normalized];
	return characters.length > 500 ? `${characters.slice(0, 499).join("")}…` : normalized;
}
