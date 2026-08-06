import type { CompletionDelivery } from "./agents.js";

export function createSpawnPromptGuidelines(
	completionDelivery: CompletionDelivery,
	blockingEnabled = true,
): string[] {
	const deliveryGuidance =
		completionDelivery === "auto-resume"
			? blockingEnabled
				? "With subagent_spawn completion delivery set to auto-resume, prefer one subagent_spawn for broad asynchronous research or review that covers related branches even when the final answer depends on its result; do not choose blocking parallel fan-out merely to keep delegation in the same turn."
				: "With subagent_spawn completion delivery set to auto-resume, prefer one subagent_spawn for broad asynchronous research or review that covers related branches even when the final answer depends on its result."
			: blockingEnabled
				? "With subagent_spawn completion delivery set to next-turn (the default), prefer one subagent_spawn for broad asynchronous research or review only when the current response does not depend on its result; use the blocking subagent when the final answer depends on the detached result."
				: "With subagent_spawn completion delivery set to next-turn (the default), use subagent_spawn only when the current response does not depend on its result; complete final-answer-dependent work directly because an idle root is not awakened.";
	const noLocalWorkGuidance =
		completionDelivery === "auto-resume"
			? "After subagent_spawn returns, do useful non-overlapping local work immediately. If none remains, briefly tell the user what subagent_spawn launched and end the response; auto-resume will request a synthesis turn after completion."
			: "After subagent_spawn returns, do useful non-overlapping local work immediately. If none remains, briefly tell the user what subagent_spawn launched and end the response only when the current response does not depend on its result; next-turn delivery will not wake an idle root.";
	return [
		"Do not use subagent_spawn for simple or critical-path work that the main agent can perform directly.",
		"Set subagent_spawn thinkingLevel to the lowest sufficient thinking level for the delegated task: use off or minimal for extraction, formatting, or mechanical work; low for straightforward bounded work; medium for ordinary multi-step research or implementation; high for complex debugging, design, review, or cross-file analysis; xhigh for highly ambiguous, cross-system, or high-risk analysis; and max only for the hardest tasks when quality clearly outweighs latency and cost. Omit subagent_spawn thinkingLevel only to preserve the agent or child default.",
		deliveryGuidance,
		"Use a single subagent_spawn only for a concrete bounded subtask that can run independently and has an isolation or specialization benefit such as independent review, bounded context/output, a distinct model/tool profile, or workspace isolation.",
		...(blockingEnabled
			? [
					"Use the blocking subagent instead of subagent_spawn when synchronous output is required before the main agent can continue and waiting is intentional; queued steering cannot be processed until that blocking call returns.",
					"When subagent_spawn fits the completion-delivery policy, do not choose a blocking parallel subagent merely to keep delegation in the same turn.",
				]
			: []),
		"Add another subagent_spawn only for truly independent work with safe workspace concurrency.",
		noLocalWorkGuidance,
		'Consume and synthesize available subagent_spawn completion messages; use subagent_manage with action "interrupt" or "close" for agents that are no longer needed.',
		'Completion from subagent_spawn is delivered automatically. Do not poll with subagent_manage action "list" or subagent_mailbox action "read", repeatedly check progress, or duplicate the delegated work.',
	];
}
