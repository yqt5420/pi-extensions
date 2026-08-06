import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";

interface MenuLifecycle {
	signal: AbortSignal;
	isCurrent(): boolean;
}

const IMPLEMENTATION_CONTEXT_LINES = [
	"「在此实现」会保留本次规划对话。",
	"「全新开始」只把已批准的计划转到新会话。",
] as const;

interface PlanMenuOptions extends MenuLifecycle {
	statusText: string;
	hasReadyPlan: boolean;
	implementationOutcome(): string;
	getExportDestination: PlanExportDestinationProvider;
	show(): void;
	finalize(): void;
	implementHere(): void | Promise<void>;
	implementFresh(signal: AbortSignal): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	save(): void;
	stay(): void;
	exit(): void;
}

export async function showPlanModeMenu(ctx: ExtensionContext, options: PlanMenuOptions) {
	type Screen = "main" | "export";
	type Action =
		| "show"
		| "finalize"
		| "implement-here"
		| "implement-fresh"
		| "export"
		| "save"
		| "stay"
		| "exit";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "main",
		screens: {
			main: () => ({
				kind: "actions",
				title: "计划模式",
				lines: [
					options.statusText,
					...(options.hasReadyPlan
						? [...IMPLEMENTATION_CONTEXT_LINES, options.implementationOutcome()]
						: []),
				],
				items: options.hasReadyPlan
					? [
							{ id: "show", label: "显示最新方案", action: "show" },
							{
								id: "implement-here",
								label: "在此实现",
								description: "保留规划对话，在当前会话继续。",
								action: "implement-here",
							},
							{
								id: "implement-fresh",
								label: "全新开始并实现",
								description: "打开新的关联会话，只转移已批准的计划。",
								action: "implement-fresh",
								busyLabel: "正在启动全新实现会话…",
							},
							{ id: "export", label: "导出计划…", to: "export" },
							{ id: "save", label: "稍后保存", action: "save" },
							{ id: "stay", label: "留在计划模式", action: "stay" },
							{ id: "exit", label: "放弃计划并退出", action: "exit" },
						]
					: [
							{ id: "finalize", label: "请求最终计划", action: "finalize" },
							{ id: "stay", label: "留在计划模式", action: "stay" },
							{ id: "exit", label: "退出计划模式", action: "exit" },
						],
				hint: "close",
			}),
			export: () => planExportInputScreen(options.getExportDestination),
		},
		actions: {
			show: async () => {
				options.show();
				return { kind: "close" };
			},
			finalize: async () => {
				options.finalize();
				return { kind: "close" };
			},
			"implement-here": async () => {
				await options.implementHere();
				return { kind: "close" };
			},
			"implement-fresh": async ({ signal }) => {
				await options.implementFresh(signal);
				return { kind: "close" };
			},
			export: async ({ value, signal }) =>
				(await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			save: async () => {
				options.save();
				return { kind: "close" };
			},
			stay: async () => {
				options.stay();
				return { kind: "close" };
			},
			exit: async () => {
				options.exit();
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}

interface ReadyPlanMenuOptions extends MenuLifecycle {
	implementationOutcome(): string;
	getExportDestination: PlanExportDestinationProvider;
	implementHere(): void | Promise<void>;
	implementFresh(signal: AbortSignal): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	save(): void;
	stay(): void;
	exit(): void;
}

export async function showReadyPlanMenu(ctx: ExtensionContext, options: ReadyPlanMenuOptions) {
	type Screen = "ready" | "export";
	type Action = "implement-here" | "implement-fresh" | "export" | "save" | "stay" | "exit";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "ready",
		screens: {
			ready: () => ({
				kind: "actions",
				title: "方案已就绪，接下来做什么？",
				lines: [...IMPLEMENTATION_CONTEXT_LINES, options.implementationOutcome()],
				items: [
					{
						id: "implement-here",
						label: "在此实现",
						description: "保留规划对话，在当前会话继续。",
						action: "implement-here",
					},
					{
						id: "implement-fresh",
						label: "全新开始并实现",
						description: "打开新的关联会话，只转移已批准的计划。",
						action: "implement-fresh",
						busyLabel: "正在启动全新实现会话…",
					},
					{ id: "export", label: "导出计划…", to: "export" },
					{ id: "save", label: "稍后保存", action: "save" },
					{ id: "stay", label: "留在计划模式", action: "stay" },
					{ id: "exit", label: "放弃计划并退出", action: "exit" },
				],
				hint: "close",
			}),
			export: () => planExportInputScreen(options.getExportDestination),
		},
		actions: {
			"implement-here": async () => {
				await options.implementHere();
				return { kind: "close" };
			},
			"implement-fresh": async ({ signal }) => {
				await options.implementFresh(signal);
				return { kind: "close" };
			},
			export: async ({ value, signal }) =>
				(await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			save: async () => {
				options.save();
				return { kind: "close" };
			},
			stay: async () => {
				options.stay();
				return { kind: "close" };
			},
			exit: async () => {
				options.exit();
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}
