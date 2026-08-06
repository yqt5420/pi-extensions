import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";

interface SavedPlanMenuOptions {
	statusText: string;
	implementationOutcome(): string;
	getExportDestination: PlanExportDestinationProvider;
	signal: AbortSignal;
	isCurrent(): boolean;
	show(): void;
	implementHere(): void | Promise<void>;
	implementFresh(signal: AbortSignal): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	settings(signal: AbortSignal): Promise<boolean>;
	clear(): void;
}

export async function showSavedPlanMenu(ctx: ExtensionContext, options: SavedPlanMenuOptions) {
	if (!ctx.hasUI) {
		throw new Error(
			`${options.statusText} 使用 /plan show、/plan implement、/plan export 或 /plan exit。`,
		);
	}
	type Screen = "saved" | "export";
	type Action = "show" | "implement-here" | "implement-fresh" | "export" | "settings" | "clear";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "saved",
		screens: {
			saved: () => ({
				kind: "actions",
				title: "已保存的计划",
				lines: [
					options.statusText,
					"「在此实现」会保留本次规划对话。",
					"「全新开始」只把已批准的计划转到新会话。",
					options.implementationOutcome(),
				],
				items: [
					{ id: "show", label: "显示已保存的计划", action: "show" },
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
					{ id: "settings", label: "设置", action: "settings" },
					{ id: "clear", label: "清除已保存的计划", action: "clear" },
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
			settings: async ({ signal }) => {
				const close = await options.settings(signal);
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				return close ? { kind: "close" } : { kind: "stay" };
			},
			clear: async () => {
				options.clear();
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
