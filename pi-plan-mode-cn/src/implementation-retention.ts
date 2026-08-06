import {
	injectActiveImplementationContext,
	isEmptyAssistantMessage,
	messageContainsExactPlanModeImplementationHandoff,
	messageContainsInactivePlanModeArtifact,
	messageContainsLegacyPlanModeContextArtifact,
	messageContainsPlanModeImplementationContextArtifact,
	messageContainsPlanModeImplementationHandoff,
	stripPlanModeCompletionCallsFromMessage,
	stripProposedPlanBlocksFromMessage,
} from "./message-transform.js";
import type { ImplementationPlanRetention } from "./settings.js";
import type { ActiveImplementationPlan, PlanModeState } from "./state.js";

export function retentionLabel(retention: ImplementationPlanRetention) {
	return {
		keep: "保持计划激活",
		"clear-on-start": "仅在交接时使用计划",
		"clear-after-first-run": "首次实现运行后清除",
	}[retention];
}

export function implementationRetentionPreview(retention: ImplementationPlanRetention) {
	return {
		keep: "实现之后：保持计划激活，直到 /plan exit。",
		"clear-on-start":
			"实现之后：仅在实现交接时使用计划，然后清除。",
		"clear-after-first-run": "实现之后：首次实现运行结束后清除。",
	}[retention];
}

export interface ImplementationContextResult {
	messages: unknown[];
	clearActiveImplementationId?: string;
}

export interface ImplementationRetentionCoordinator {
	restore(activeImplementation: ActiveImplementationPlan | undefined): void;
	transformContext(messages: unknown[], state: PlanModeState): ImplementationContextResult;
	implementationSettled(
		activeImplementation: ActiveImplementationPlan | undefined,
	): string | undefined;
	reset(): void;
}

export function createImplementationRetentionCoordinator(): ImplementationRetentionCoordinator {
	let implementationWithDeliveredContext: string | undefined;
	let restoredImplementationAwaitingContext: string | undefined;

	return {
		restore(activeImplementation) {
			restoredImplementationAwaitingContext =
				activeImplementation && activeImplementation.retention !== "keep"
					? activeImplementation.id
					: undefined;
		},
		transformContext(messages, state) {
			const messagesWithoutPlanContext = messages.filter(
				(message) =>
					!messageContainsLegacyPlanModeContextArtifact(message) &&
					!messageContainsPlanModeImplementationContextArtifact(message),
			);
			if (state.enabled) {
				return {
					messages: messagesWithoutPlanContext.filter(
						(message) => !messageContainsPlanModeImplementationHandoff(message),
					),
				};
			}

			const activeImplementation = state.activeImplementation;
			const inactiveMessages = activeImplementation
				? messagesWithoutPlanContext
				: messagesWithoutPlanContext.filter(
						(message) => !messageContainsPlanModeImplementationHandoff(message),
					);
			const filteredMessages = inactiveMessages
				.filter((message) => !messageContainsInactivePlanModeArtifact(message))
				.map(stripProposedPlanBlocksFromMessage)
				.map(stripPlanModeCompletionCallsFromMessage)
				.filter((message) => !isEmptyAssistantMessage(message));
			if (!activeImplementation) return { messages: filteredMessages };

			const contextualMessages = injectActiveImplementationContext(
				filteredMessages,
				activeImplementation,
			);
			// A busy /plan implement queues its handoff behind an older run. Do not arm cleanup
			// until that exact handoff reaches context; a restored session has no older run to drain.
			const deliveredCurrentHandoff =
				restoredImplementationAwaitingContext === activeImplementation.id ||
				filteredMessages.some((message) =>
					messageContainsExactPlanModeImplementationHandoff(message, activeImplementation.plan),
				);
			if (!deliveredCurrentHandoff) return { messages: contextualMessages };
			restoredImplementationAwaitingContext = undefined;

			if (activeImplementation.retention === "clear-after-first-run") {
				implementationWithDeliveredContext = activeImplementation.id;
			}
			return {
				messages: contextualMessages,
				clearActiveImplementationId:
					activeImplementation.retention === "clear-on-start" ? activeImplementation.id : undefined,
			};
		},
		implementationSettled(activeImplementation) {
			if (
				activeImplementation?.retention !== "clear-after-first-run" ||
				implementationWithDeliveredContext !== activeImplementation.id
			) {
				return undefined;
			}
			implementationWithDeliveredContext = undefined;
			return activeImplementation.id;
		},
		reset() {
			implementationWithDeliveredContext = undefined;
			restoredImplementationAwaitingContext = undefined;
		},
	};
}
