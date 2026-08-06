import { checkpointGoalActiveTime, currentTokenTotal, formatTokenCount } from "./accounting.js";
import { validateObjective } from "./command.js";
import { safeGoalMenuText } from "./menu.js";
import type { ActiveGoal } from "./persistence.js";
import { buildGoalPrompt, buildObjectiveUpdatedPrompt, buildResumePrompt } from "./prompts.js";
import {
	activateQueuedGoal,
	appendGoal,
	createQueuedGoal,
	dropLastGoal as dropLastQueuedGoal,
	goalQueueIdentity,
	prioritizeGoal as prioritizeQueuedGoal,
	skipGoal as skipQueuedGoal,
} from "./queue.js";
import {
	blocksStaleGoalToolCalls,
	createGoal,
	editedGoalStatus,
	formatBudget,
	formatError,
	type GoalRuntime,
	goalSummary,
	hasPendingMessages,
	isResumableGoalStatus,
	nextGoalInstance,
	queueGoalSafetyReset,
	STATUS_KEY,
	type StatusContext,
	stoppedStatusLabel,
	transitionGoal,
} from "./runtime.js";

// User-command mutations are kept separate from Pi event wiring. Every controller
// receives exactly one per-factory GoalRuntime, preserving session isolation.
export class GoalCommandController {
	private readonly runtime: GoalRuntime;

	constructor(runtime: GoalRuntime) {
		this.runtime = runtime;
	}

	async startGoal(
		objective: string,
		tokenBudget: number | undefined,
		ctx: StatusContext,
		onActivated?: (goal: ActiveGoal) => void,
		isActivationCurrent?: (goal: ActiveGoal) => boolean,
		isRequestCurrent?: () => boolean,
	) {
		if (isRequestCurrent && !isRequestCurrent()) return;
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}

		const existingGoal =
			this.runtime.activeGoal?.status !== "complete" ? this.runtime.activeGoal : undefined;
		const existingQueuedGoals = [...this.runtime.queuedGoals];
		const existingQueueIdentity = goalQueueIdentity(
			this.runtime.activeGoal,
			this.runtime.queuedGoals,
			this.runtime.pendingQueueAction,
		);
		if (existingGoal) {
			const queuedRemovalPreview =
				existingQueuedGoals.length > 0
					? `\n\nQueued goals also removed:\n${existingQueuedGoals
							.map((goal, index) => `${index + 1}. ${safeGoalMenuText(goal.text, 4_000)}`)
							.join("\n")}`
					: "";
			const shouldReplace = await ctx.ui.confirm(
				"Replace goal?",
				`当前目标：${safeGoalMenuText(existingGoal.text, 4_000)}${queuedRemovalPreview}\n\n新目标：${safeGoalMenuText(objective, 4_000)}`,
			);
			if (!shouldReplace) {
				ctx.ui.notify(`目标已保留：${existingGoal.text}`, "info");
				return;
			}
			if (isRequestCurrent && !isRequestCurrent()) return;
			if (
				goalQueueIdentity(
					this.runtime.activeGoal,
					this.runtime.queuedGoals,
					this.runtime.pendingQueueAction,
				) !== existingQueueIdentity
			) {
				ctx.ui.notify("确认期间目标队列已更改。请重试。", "warning");
				return;
			}
		}

		// Unlock lazy visibility only for a real activation. In always mode, a
		// missing tool means another policy or allowlist intentionally removed it.
		if (isRequestCurrent && !isRequestCurrent()) return;
		const goalToolVisibilityBeforeActivation = this.runtime.toolPolicy.snapshot();
		try {
			this.runtime.toolPolicy.prepareActivation(this.runtime.settings.toolVisibility, ctx);
		} catch (error) {
			ctx.ui.notify(`无法启动 /goal：${formatError(error)}`, "error");
			if (existingGoal?.status === "active") this.runtime.pauseGoalForUnavailableTools(ctx);
			return;
		}

		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		this.runtime.queuedGoals = [];
		this.runtime.pendingQueueAction = undefined;
		this.runtime.activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
		const startedGoal = this.runtime.activeGoal;
		onActivated?.(startedGoal);
		this.runtime.persistGoal(startedGoal);
		if (
			this.runtime.activeGoal?.id !== startedGoal.id ||
			this.runtime.activeGoal.status !== "active"
		) {
			return;
		}
		this.runtime.updateStatus(ctx, startedGoal);
		const sent = await this.runtime.sendOwnedGoalPrompt(
			ctx,
			startedGoal.id,
			buildGoalPrompt(startedGoal),
			true,
			() => (isRequestCurrent?.() ?? true) && (isActivationCurrent?.(startedGoal) ?? true),
		);
		if (isActivationCurrent && !isActivationCurrent(startedGoal)) return;
		if (!sent) {
			let rolledBackStartedGoal = false;
			if (this.runtime.activeGoal?.id === startedGoal.id) {
				rolledBackStartedGoal = true;
				if (existingGoal) {
					this.runtime.queuedGoals = existingQueuedGoals;
					this.runtime.recordGoalUsage(existingGoal, ctx);
					if (existingGoal.status === "active") {
						this.runtime.stopActiveGoal(ctx, {
							kind: "activation_rollback",
							expectedGoalId: startedGoal.id,
							restoreGoal: existingGoal,
							abortTurn: true,
						});
					} else {
						this.runtime.activeGoal = existingGoal;
						if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
							this.runtime.blockStaleGoalToolCalls();
						} else {
							this.runtime.clearStaleGoalToolCallBlock();
						}
						this.runtime.persistGoal(this.runtime.activeGoal);
						this.runtime.updateStatus(ctx, this.runtime.activeGoal);
					}
				} else {
					this.runtime.clearActiveGoal(ctx);
				}
			}
			if (rolledBackStartedGoal) {
				this.runtime.toolPolicy.restore(goalToolVisibilityBeforeActivation);
			}
			return;
		}
		if (
			this.runtime.activeGoal?.id !== startedGoal.id ||
			this.runtime.activeGoal.status !== "active"
		) {
			return;
		}
		const automaticLimit = this.runtime.settings.continuationLimits.automaticTurns;
		ctx.ui.notify(
			`${existingGoal ? "Goal replaced" : "Goal started"}: ${objective}. ${
				startedGoal.tokenBudget === undefined
					? ""
					: `Token budget: ${formatTokenCount(startedGoal.tokenBudget)} cumulative; the final model call may exceed it. `
			}${
				automaticLimit === null
					? "Automatic work is Unlimited; tool loops may consume substantial tokens and provider cost. Open /goal to monitor."
					: `Automatic work pauses after ${automaticLimit} responses; open /goal to monitor progress.`
			}`,
			automaticLimit === null ? "warning" : "info",
		);
	}

	async addGoal(objective: string, tokenBudget: number | undefined, ctx: StatusContext) {
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}
		if (!this.runtime.activeGoal) {
			await this.startGoal(objective, tokenBudget, ctx);
			return;
		}
		this.runtime.queuedGoals = appendGoal(
			this.runtime.queuedGoals,
			createQueuedGoal(objective, tokenBudget),
		);
		this.runtime.persistGoal(this.runtime.activeGoal);
		ctx.ui.notify(
			`目标已添加到第 ${this.runtime.queuedGoals.length + 1} 位：${objective}`,
			"info",
		);
	}

	async prioritizeGoal(objective: string, tokenBudget: number | undefined, ctx: StatusContext) {
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}
		if (!this.runtime.activeGoal) {
			await this.startGoal(objective, tokenBudget, ctx);
			return;
		}
		this.runtime.cancelContinuationWork();
		this.runtime.pendingQueueAction = { kind: "prioritize", objective, tokenBudget };
		this.runtime.persistGoal(this.runtime.activeGoal);
		if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) {
			ctx.ui.notify(`优先目标已排队，等待 Pi 安定：${objective}`, "info");
			return;
		}
		await this.dispatchPendingQueueActionIfSettled(ctx);
	}

	dropLastGoal(ctx: StatusContext) {
		const currentGoal = this.runtime.activeGoal;
		if (!currentGoal) {
			ctx.ui.notify("没有可丢弃的目标。", "info");
			return;
		}
		const result = dropLastQueuedGoal(currentGoal, this.runtime.queuedGoals);
		if (!result.goal) {
			this.runtime.clearActiveGoal(ctx);
			ctx.ui.notify(`目标已丢弃：${result.removed?.text ?? currentGoal.text}`, "warning");
			return;
		}
		this.runtime.queuedGoals = result.queue;
		this.runtime.persistGoal(result.goal);
		ctx.ui.notify(`目标已丢弃：${result.removed?.text ?? "未知目标"}`, "warning");
	}

	async skipGoal(ctx: StatusContext) {
		const currentGoal = this.runtime.activeGoal;
		if (!currentGoal) {
			ctx.ui.notify("没有可跳过的目标。", "info");
			return;
		}
		if (this.runtime.queuedGoals.length === 0) {
			this.runtime.clearActiveGoal(ctx);
			ctx.ui.notify(`目标已跳过：${currentGoal.text}。没有剩余目标。`, "warning");
			return;
		}
		if (currentGoal.status === "active") this.runtime.recordGoalUsage(currentGoal, ctx);
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		this.runtime.pendingQueueAction = {
			kind: "advance",
			goalId: currentGoal.id,
			reason: "skip",
			completedText: currentGoal.text,
		};
		this.runtime.persistGoal(currentGoal);
		ctx.ui.notify(`目标跳过已排队，等待 Pi 安定：${currentGoal.text}`, "info");
		if (ctx.isIdle?.() === true && !hasPendingMessages(ctx)) {
			await this.dispatchPendingQueueActionIfSettled(ctx);
		}
	}

	async resumeQueueAfterUnfreeze(ctx: StatusContext) {
		if (this.runtime.queueFreezeAwaitingSettle) return false;
		this.runtime.queueFrozen = false;
		this.runtime.queueFreezeAwaitingSettle = false;
		this.runtime.guardAbortGoalId = undefined;
		this.runtime.clearStaleGoalToolCallBlock();
		if (this.runtime.activeGoal) {
			if (
				this.runtime.activeGoal.status === "active" &&
				this.runtime.activeGoal.activeStartedAt === undefined
			) {
				const now = Date.now();
				checkpointGoalActiveTime(this.runtime.activeGoal, now, true);
				this.runtime.activeGoal.updatedAt = now;
			}
			this.runtime.persistGoal(this.runtime.activeGoal);
			this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		if (this.runtime.pendingQueueAction) {
			return this.dispatchPendingQueueActionIfSettled(ctx);
		}
		const goal = this.runtime.activeGoal;
		if (goal?.status !== "active") return false;
		this.runtime.requestContinuation(goal);
		return this.runtime.dispatchContinuationIfSettled(ctx);
	}

	async dispatchPendingQueueActionIfSettled(ctx: StatusContext) {
		const pending = this.runtime.pendingQueueAction;
		if (!pending || this.runtime.queueFrozen) return false;
		if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;
		if (pending.kind === "prioritize") {
			this.runtime.pendingQueueAction = undefined;
			return this.activatePrioritizedGoal(
				pending.objective,
				pending.tokenBudget,
				ctx,
				pending.displacedUsageFinalized === true,
			);
		}
		if (
			!this.runtime.activeGoal ||
			this.runtime.activeGoal.id !== pending.goalId ||
			(this.runtime.activeGoal.status !== "complete" && pending.reason === "complete")
		) {
			this.runtime.pendingQueueAction = undefined;
			if (this.runtime.activeGoal) this.runtime.persistGoal(this.runtime.activeGoal);
			return false;
		}

		const previousText = pending.completedText;
		const reason = pending.reason;
		this.runtime.pendingQueueAction = undefined;
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		const next = skipQueuedGoal(this.runtime.queuedGoals);
		this.runtime.queuedGoals = next.queue;
		this.runtime.activeGoal = next.goal
			? activateQueuedGoal(next.goal, currentTokenTotal(ctx))
			: undefined;
		if (!this.runtime.activeGoal) {
			this.runtime.clearActiveGoal(ctx);
			ctx.ui.notify(
				reason === "complete"
					? `目标已完成：${previousText}。没有剩余目标。`
					: `目标已跳过：${previousText}。没有剩余目标。`,
				"info",
			);
			return true;
		}

		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		if (this.runtime.activeGoal.status !== "active") {
			if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
				this.runtime.blockStaleGoalToolCalls();
			}
			ctx.ui.notify(
				`${reason === "complete" ? "目标已完成" : "目标已跳过"}：${previousText}。下一个目标仍为 ${this.runtime.activeGoal.status}：${this.runtime.activeGoal.text}`,
				"info",
			);
			return true;
		}

		try {
			this.runtime.toolPolicy.prepareActivation(this.runtime.settings.toolVisibility, ctx);
		} catch (error) {
			this.runtime.stopActiveGoal(ctx, {
				kind: "activation_rollback",
				expectedGoalId: this.runtime.activeGoal.id,
				restoreGoal: this.runtime.activeGoal,
				abortTurn: false,
			});
			ctx.ui.notify(`无法启动下一个 /goal：${formatError(error)}`, "error");
			return false;
		}
		const activatedGoal = this.runtime.activeGoal;
		const sent = await this.runtime.sendOwnedGoalPrompt(
			ctx,
			activatedGoal.id,
			buildGoalPrompt(activatedGoal),
			false, // Queue reactivation preserves its persisted safety epoch.
		);
		if (!sent && this.runtime.activeGoal?.id === activatedGoal.id) {
			this.runtime.stopActiveGoal(ctx, {
				kind: "activation_rollback",
				expectedGoalId: activatedGoal.id,
				restoreGoal: activatedGoal,
				abortTurn: false,
			});
			ctx.ui.notify(
				`下一个目标在提示词交付失败后暂停：${activatedGoal.text}`,
				"warning",
			);
			return false;
		}
		ctx.ui.notify(
			`${reason === "complete" ? "目标已完成" : "目标已跳过"}：${previousText}。已开始下一个目标：${activatedGoal.text}`,
			"info",
		);
		return true;
	}

	notifyFrozenQueue(ctx: StatusContext) {
		ctx.ui.notify(
			"实验性目标队列已冻结。请在 pi-goal.json 中重新启用 experimental.goals 并运行 /reload，或使用 /goal clear。",
			"warning",
		);
	}

	pauseGoal(ctx: StatusContext) {
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("没有活动目标。", "info");
			return;
		}
		if (this.runtime.activeGoal.status !== "active") {
			ctx.ui.notify(
				`目标状态为 ${this.runtime.activeGoal.status}；只有活动目标可以暂停。`,
				"warning",
			);
			return;
		}
		const stoppedGoal = this.runtime.stopActiveGoal(ctx, {
			kind: "explicit_pause",
			expectedGoalId: this.runtime.activeGoal.id,
		});
		if (stoppedGoal) ctx.ui.notify(`目标已暂停：${stoppedGoal.text}`, "info");
	}

	async resumeGoal(ctx: StatusContext) {
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("没有活动目标。", "info");
			return;
		}
		if (!isResumableGoalStatus(this.runtime.activeGoal.status)) {
			ctx.ui.notify(
				`目标状态为 ${this.runtime.activeGoal.status}；只有已暂停、被阻止、用量受限或预算受限的目标可以恢复。`,
				"warning",
			);
			return;
		}
		if (
			this.runtime.activeGoal.tokenBudget !== undefined &&
			this.runtime.activeGoal.tokensUsed >= this.runtime.activeGoal.tokenBudget
		) {
			ctx.ui.notify(
				`目标 token 预算仍已用完：${formatBudget(this.runtime.activeGoal)}`,
				"warning",
			);
			return;
		}
		const goalToolVisibilityBeforeActivation = this.runtime.toolPolicy.snapshot();
		try {
			this.runtime.toolPolicy.prepareActivation(this.runtime.settings.toolVisibility, ctx);
		} catch (error) {
			ctx.ui.notify(`无法恢复 /goal：${formatError(error)}`, "error");
			return;
		}
		const stoppedGoal = this.runtime.activeGoal;
		const stoppedStatus = stoppedGoal.status;
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		this.runtime.activeGoal = queueGoalSafetyReset(
			transitionGoal(nextGoalInstance(this.runtime.activeGoal), "active"),
		);
		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		if (this.runtime.activeGoal.status !== "active") {
			ctx.ui.notify(
				`目标 token 预算仍已用完：${formatBudget(this.runtime.activeGoal)}`,
				"warning",
			);
			return;
		}
		const resumedGoal = this.runtime.activeGoal;
		const sent = await this.runtime.sendOwnedGoalPrompt(
			ctx,
			resumedGoal.id,
			buildResumePrompt(resumedGoal, stoppedStatus),
		);
		if (!sent) {
			if (
				this.runtime.activeGoal?.id === resumedGoal.id &&
				this.runtime.activeGoal.status === "active"
			) {
				this.runtime.activeGoal = stoppedGoal;
				this.runtime.persistGoal(this.runtime.activeGoal);
				this.runtime.updateStatus(ctx, this.runtime.activeGoal);
				if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
					this.runtime.blockStaleGoalToolCalls();
				}
				this.runtime.toolPolicy.restore(goalToolVisibilityBeforeActivation);
			}
			return;
		}
		const automaticLimit = this.runtime.settings.continuationLimits.automaticTurns;
		ctx.ui.notify(
			`Goal resumed from ${stoppedStatusLabel(stoppedStatus)}: ${resumedGoal.text}. ${
				automaticLimit === null
					? "Automatic work remains Unlimited; goal progress and cumulative usage are preserved."
					: `The automatic-work counter will reset to 0 of ${automaticLimit} when the resumed prompt starts; goal progress and cumulative usage are preserved.`
			}`,
			automaticLimit === null ? "warning" : "info",
		);
	}

	clearGoal(ctx: StatusContext) {
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("没有活动目标。", "info");
			this.runtime.cancelContinuationWork();
			this.runtime.clearGoalRecovery();
			this.runtime.clearBudgetWrapUp();
			this.runtime.clearStaleGoalToolCallBlock();
			this.runtime.clearPersistedGoal(ctx.cwd);
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const stoppedGoal = this.runtime.activeGoal.text;
		this.runtime.clearActiveGoal(ctx);
		ctx.ui.notify(`目标已清除：${stoppedGoal}`, "warning");
	}

	async editGoal(objective: string, tokenBudget: number | undefined, ctx: StatusContext) {
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("没有活动目标。使用 /goal <目标> 开始一个。", "warning");
			return;
		}

		this.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
		const previousGoal = { ...this.runtime.activeGoal };
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		const previousStatus = this.runtime.activeGoal.status;
		const rotatedGoal = nextGoalInstance(this.runtime.activeGoal);
		const transitionedGoal = transitionGoal(
			{
				...rotatedGoal,
				text: objective,
				tokenBudget: tokenBudget ?? this.runtime.activeGoal.tokenBudget,
			},
			editedGoalStatus(previousStatus),
		);
		const nextGoal =
			transitionedGoal.status === "active"
				? queueGoalSafetyReset(transitionedGoal)
				: transitionedGoal;
		const goalToolVisibilityBeforeActivation =
			nextGoal.status === "active" ? this.runtime.toolPolicy.snapshot() : undefined;
		if (nextGoal.status === "active") {
			try {
				this.runtime.toolPolicy.prepareActivation(this.runtime.settings.toolVisibility, ctx);
			} catch (error) {
				ctx.ui.notify(`无法重新激活 /goal：${formatError(error)}`, "error");
				if (this.runtime.activeGoal?.status === "active") {
					this.runtime.pauseGoalForUnavailableTools(ctx);
				}
				return;
			}
		}
		this.runtime.activeGoal = nextGoal;
		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		const editedGoal = this.runtime.activeGoal;
		if (!editedGoal) return;
		if (editedGoal.status === "active") {
			this.runtime.clearStaleGoalToolCallBlock();
			const sent = await this.runtime.sendOwnedGoalPrompt(
				ctx,
				editedGoal.id,
				buildObjectiveUpdatedPrompt(editedGoal),
			);
			if (!sent) {
				if (this.runtime.activeGoal?.id === editedGoal.id) {
					if (previousStatus === "active") {
						this.runtime.stopActiveGoal(ctx, {
							kind: "activation_rollback",
							expectedGoalId: editedGoal.id,
							restoreGoal: previousGoal,
							abortTurn: true,
						});
					} else {
						this.runtime.activeGoal = previousGoal;
						if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
							this.runtime.blockStaleGoalToolCalls();
						} else {
							this.runtime.clearStaleGoalToolCallBlock();
						}
						this.runtime.persistGoal(this.runtime.activeGoal);
						this.runtime.updateStatus(ctx, this.runtime.activeGoal);
					}
					if (goalToolVisibilityBeforeActivation) {
						this.runtime.toolPolicy.restore(goalToolVisibilityBeforeActivation);
					}
				}
				return;
			}
		} else if (blocksStaleGoalToolCalls(editedGoal.status)) {
			this.runtime.blockStaleGoalToolCalls();
		} else {
			this.runtime.clearStaleGoalToolCallBlock();
		}
		ctx.ui.notify(`目标已更新：${objective}`, "info");
	}

	showGoal(ctx: StatusContext) {
		if (!this.runtime.activeGoal) {
			const message = "Usage: /goal <objective>\n当前未设置目标。";
			ctx.ui.setStatus(STATUS_KEY, undefined);
			this.reportGoalStatus(ctx, message);
			return;
		}
		if (!this.runtime.queueFrozen) {
			this.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
			this.runtime.persistGoal(this.runtime.activeGoal);
			this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		}
		this.reportGoalStatus(
			ctx,
			goalSummary(
				this.runtime.activeGoal,
				this.runtime.queuedGoals,
				this.runtime.settings.experimental.goals,
				this.runtime.queueFrozen,
				this.runtime.pendingQueueAction,
				this.runtime.settings.continuationLimits.automaticTurns,
			),
		);
	}

	private reportGoalStatus(ctx: StatusContext, message: string) {
		if (ctx.mode === "print" || ctx.mode === "json") {
			throw new Error(
				`/goal status 在 ${ctx.mode} 模式下不可用，因为 Pi 不暴露扩展命令输出put channel. Use TUI or RPC mode.`,
			);
		}
		ctx.ui.notify(message, "info");
	}

	private async activatePrioritizedGoal(
		objective: string,
		tokenBudget: number | undefined,
		ctx: StatusContext,
		displacedUsageFinalized = false,
	) {
		const currentGoal = this.runtime.activeGoal;
		if (!currentGoal) {
			await this.startGoal(objective, tokenBudget, ctx);
			return true;
		}
		if (currentGoal.status === "active" && !displacedUsageFinalized) {
			this.runtime.recordGoalUsage(currentGoal, ctx);
		}
		const previousGoal = { ...currentGoal };
		const previousQueue = [...this.runtime.queuedGoals];
		const visibilityBeforeActivation = this.runtime.toolPolicy.snapshot();
		try {
			this.runtime.toolPolicy.prepareActivation(this.runtime.settings.toolVisibility, ctx);
		} catch (error) {
			ctx.ui.notify(`无法优先处理 /goal：${formatError(error)}`, "error");
			if (currentGoal.status === "complete") {
				// Completion already committed, so retain the priority intent for a
				// later /reload after the tool policy is restored.
				this.runtime.pendingQueueAction = {
					kind: "prioritize",
					objective,
					tokenBudget,
					...(displacedUsageFinalized ? { displacedUsageFinalized: true } : {}),
				};
				this.runtime.persistGoal(currentGoal);
			} else {
				// Roll back an activation that never started. An active displaced goal
				// cannot continue safely without its terminal tools, so make it resumable.
				this.runtime.pendingQueueAction = undefined;
				if (currentGoal.status === "active") {
					this.runtime.pauseGoalForUnavailableTools(ctx, true, !displacedUsageFinalized);
				} else {
					this.runtime.persistGoal(currentGoal);
				}
			}
			return false;
		}

		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		const prioritized = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
		const next =
			currentGoal.status === "complete"
				? { goal: prioritized, queue: [...this.runtime.queuedGoals] }
				: prioritizeQueuedGoal(currentGoal, this.runtime.queuedGoals, prioritized);
		this.runtime.activeGoal = next.goal;
		this.runtime.queuedGoals = next.queue;
		this.runtime.pendingQueueAction = undefined;
		if (!this.runtime.activeGoal) return false;
		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		const sent = await this.runtime.sendOwnedGoalPrompt(
			ctx,
			this.runtime.activeGoal.id,
			buildGoalPrompt(this.runtime.activeGoal),
		);
		if (!sent && this.runtime.activeGoal.id === prioritized.id) {
			this.runtime.queuedGoals = previousQueue;
			if (previousGoal.status === "active") {
				this.runtime.stopActiveGoal(ctx, {
					kind: "activation_rollback",
					expectedGoalId: prioritized.id,
					restoreGoal: previousGoal,
					abortTurn: true,
				});
			} else {
				this.runtime.activeGoal = previousGoal;
				if (previousGoal.status === "complete") {
					this.runtime.pendingQueueAction = { kind: "prioritize", objective, tokenBudget };
				} else if (blocksStaleGoalToolCalls(previousGoal.status)) {
					this.runtime.blockStaleGoalToolCalls();
				}
				this.runtime.persistGoal(this.runtime.activeGoal);
				this.runtime.updateStatus(ctx, this.runtime.activeGoal);
			}
			this.runtime.toolPolicy.restore(visibilityBeforeActivation);
			return false;
		}
		ctx.ui.notify(`目标已优先处理：${objective}`, "info");
		return true;
	}
}
