import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";

export interface PlanLaunchTool {
	name: string;
	description: string;
	searchText: string;
	disabled: boolean;
	disabledReason?: string;
}

interface PlanLaunchMenuOptions {
	statusText: string;
	toolSummary(selectedNames: ReadonlySet<string>): string;
	getSelectedNames(): ReadonlySet<string>;
	tools: readonly PlanLaunchTool[];
	signal: AbortSignal;
	isCurrent(): boolean;
	initialScreen?: "main" | "tools";
	start(signal: AbortSignal): void;
	startWithTools(toolNames: string[], signal: AbortSignal): void;
	settings(signal: AbortSignal): Promise<boolean>;
}

export async function showPlanLaunchMenu(ctx: ExtensionContext, options: PlanLaunchMenuOptions) {
	type Screen = "main" | "tools" | "help";
	type Action = "start" | "toggle-tool" | "start-with-tools" | "settings";
	const selectedNames = new Set(options.getSelectedNames());
	let draftChanged = false;
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: options.initialScreen ?? "main",
		screens: {
			main: () => ({
				kind: "actions",
				title: "计划模式",
				lines: [options.statusText, options.toolSummary(selectedNames)],
				items: [
					{ id: "start", label: "开始计划模式", action: "start" },
					{ id: "tools", label: "选择工具后开始…", to: "tools" },
					{ id: "settings", label: "设置", action: "settings" },
					{ id: "help", label: "计划模式如何工作", to: "help" },
				],
				hint: "close",
			}),
			tools: () => ({
				kind: "multiSelect",
				title: "选择计划模式工具",
				lines: [
					"更改只在启动计划模式时生效。",
					"非内置工具由用户自行承担风险。",
				],
				enableSearch: true,
				viewportSize: 10,
				items: options.tools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					description: tool.description,
					searchText: tool.searchText,
					selected: selectedNames.has(tool.name),
					disabled: tool.disabled,
					disabledReason: tool.disabledReason,
				})),
				action: "toggle-tool",
				actions: [
					{
						id: "start-with-tools",
						label: "完成并开始计划模式",
						action: "start-with-tools",
					},
				],
				hint: "back",
			}),
			help: () => ({
				kind: "detail",
				title: "计划模式如何工作",
				lines: [
					"计划模式先用只读探索来了解项目，再进入实现。",
					"代理可以提出重要的决策问题，然后给出完整的、可立即实施的计划。",
					"在你明确选择实现完整计划之前，文件修改始终被阻止。",
				],
				hint: "back",
			}),
		},
		actions: {
			start: async ({ signal }) => {
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				options.start(signal);
				return { kind: "close" };
			},
			"toggle-tool": async ({ itemId, selected, signal }) => {
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				const tool = options.tools.find((candidate) => candidate.name === itemId);
				if (!tool || tool.disabled) return { kind: "rejected" };
				if (selected) selectedNames.add(tool.name);
				else selectedNames.delete(tool.name);
				draftChanged = true;
				return { kind: "stay" };
			},
			"start-with-tools": async ({ signal }) => {
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				options.startWithTools(Array.from(selectedNames), signal);
				return { kind: "close" };
			},
			settings: async ({ signal }) => {
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				const close = await options.settings(signal);
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				if (close) return { kind: "close" };
				if (!draftChanged) {
					selectedNames.clear();
					for (const name of options.getSelectedNames()) selectedNames.add(name);
				}
				return { kind: "stay" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}
