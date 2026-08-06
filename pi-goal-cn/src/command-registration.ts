import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeGoalArguments, parseCommand } from "./command.js";
import type { GoalCommandController } from "./commands.js";
import { showGoalManager } from "./menu.js";
import type { GoalRuntime } from "./runtime.js";
import { showGoalSettings } from "./settings-ui.js";

interface GoalCommandRegistrationOptions {
	settingsPath?: string;
}

export function registerGoalCommand(
	pi: ExtensionAPI,
	runtime: GoalRuntime,
	commands: GoalCommandController,
	options: GoalCommandRegistrationOptions = {},
) {
	pi.registerCommand("goal", {
		description: "运行目标直到完成：/goal [--tokens 100k] <要完成的目标>",
		getArgumentCompletions: (prefix) =>
			completeGoalArguments(prefix, {
				experimentalGoals: runtime.settings.experimental.goals,
			}),
		handler: async (args, ctx) => {
			const result = parseCommand(args, {
				experimentalGoals: runtime.settings.experimental.goals,
			});
			if (typeof result === "string") {
				ctx.ui.notify(result, "warning");
				return;
			}
			if (result.kind === "show" && args.trim() === "") {
				await showGoalManager(runtime, commands, ctx, (menuCtx, target) =>
					showGoalSettings(runtime, menuCtx, {
						settingsPath: options.settingsPath,
						initialScreen: target,
						onQueueUnfrozen: async (settingsCtx) => {
							await commands.resumeQueueAfterUnfreeze(settingsCtx);
						},
					}),
				);
				return;
			}
			if (runtime.queueFrozen) {
				if (result.kind === "show") commands.showGoal(ctx);
				else if (result.kind === "clear") commands.clearGoal(ctx);
				else commands.notifyFrozenQueue(ctx);
				return;
			}
			if (runtime.pendingQueueAction && result.kind !== "show" && result.kind !== "clear") {
				ctx.ui.notify(
					"排队的目标更改正在等待 Pi 安定。完成后重试。",
					"warning",
				);
				return;
			}

			switch (result.kind) {
				case "show":
					commands.showGoal(ctx);
					return;
				case "pause":
					commands.pauseGoal(ctx);
					return;
				case "resume":
					await commands.resumeGoal(ctx);
					return;
				case "clear":
					commands.clearGoal(ctx);
					return;
				case "edit":
					await commands.editGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "add":
					await commands.addGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "prioritize":
					await commands.prioritizeGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "drop-last":
					commands.dropLastGoal(ctx);
					return;
				case "skip":
					await commands.skipGoal(ctx);
					return;
				case "start":
					await commands.startGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
			}
		},
	});
}
