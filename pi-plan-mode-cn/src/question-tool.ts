import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_QUESTION_TOOL_NAME = "plan_mode_question";

export type PlanModeQuestionOption = {
	label: string;
	description?: string;
};

export type PlanModeQuestion = {
	id: string;
	header: string;
	question: string;
	options: PlanModeQuestionOption[];
};

type PlanModeQuestionAnswer = {
	id: string;
	header: string;
	question: string;
	answer: string;
	wasCustom: boolean;
	optionIndex?: number;
};

type PlanModeQuestionReason =
	| "cancelled"
	| "ui_unavailable"
	| "plan_mode_inactive"
	| "invalid_input";

type PlanModeQuestionDetails = {
	cancelled: boolean;
	reason?: PlanModeQuestionReason;
	questions: PlanModeQuestion[];
	answers?: PlanModeQuestionAnswer[];
};

export const PLAN_MODE_QUESTION_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["questions"],
	properties: {
		questions: {
			type: "array",
			minItems: 1,
			maxItems: 3,
			description: "要向用户展示的问题。优先 1 个，最多不超过 3 个。",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "header", "question", "options"],
				properties: {
					id: {
						type: "string",
						description: "用于映射回答的稳定标识符（snake_case）。",
					},
					header: {
						type: "string",
						description: "在界面中显示的简短标题（不超过 12 个字符）。",
					},
					question: { type: "string", description: "向用户展示的单句提示。" },
					options: {
						type: "array",
						minItems: 2,
						maxItems: 4,
						description:
							"提供 2-4 个互斥选项。有明确默认值时，把推荐选项放在最前。",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["label", "description"],
							properties: {
								label: { type: "string", description: "面向用户的标签（1-5 个词）。" },
								description: {
									type: "string",
									description: "用一句简短的话说明选中后的影响/权衡。",
								},
							},
						},
					},
				},
			},
		},
	},
} as const;

type NormalizePlanModeQuestionParamsResult =
	| { ok: true; questions: PlanModeQuestion[] }
	| { ok: false; error: string };

export function normalizePlanModeQuestionParams(
	input: unknown,
): NormalizePlanModeQuestionParamsResult {
	if (!isRecord(input) || !Array.isArray(input.questions)) {
		return { ok: false, error: "questions must be an array" };
	}
	if (input.questions.length < 1 || input.questions.length > 3) {
		return { ok: false, error: "questions must contain 1-3 items" };
	}

	const questions: PlanModeQuestion[] = [];
	for (const [questionIndex, rawQuestion] of input.questions.entries()) {
		if (!isRecord(rawQuestion)) {
			return { ok: false, error: `问题 ${questionIndex + 1} 必须是对象` };
		}
		const id = stringField(rawQuestion.id);
		const header = stringField(rawQuestion.header);
		const question = stringField(rawQuestion.question);
		if (!id || !header || !question) {
			return {
				ok: false,
				error: `问题 ${questionIndex + 1} 需要非空的 id、header 和 question`,
			};
		}
		if (!Array.isArray(rawQuestion.options)) {
			return { ok: false, error: `问题 ${questionIndex + 1} 的 options 必须是数组` };
		}
		if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
			return { ok: false, error: `问题 ${questionIndex + 1} 的 options 必须包含 2-4 项` };
		}
		const options: PlanModeQuestionOption[] = [];
		for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
			if (!isRecord(rawOption)) {
				return {
					ok: false,
					error: `问题 ${questionIndex + 1} 的选项 ${optionIndex + 1} 必须是对象`,
				};
			}
			const label = stringField(rawOption.label);
			if (!label) {
				return {
					ok: false,
					error: `问题 ${questionIndex + 1} 的选项 ${optionIndex + 1} 需要 label`,
				};
			}
			const description = stringField(rawOption.description);
			if (!description) {
				return {
					ok: false,
					error: `问题 ${questionIndex + 1} 的选项 ${optionIndex + 1} 需要 description`,
				};
			}
			options.push({ label, description });
		}
		questions.push({ id, header, question, options });
	}
	return { ok: true, questions };
}

export async function answerPlanModeQuestions(
	questions: PlanModeQuestion[],
	ctx: ExtensionContext,
	lifecycle: { isCurrent(): boolean; isEnabled(): boolean },
) {
	const answers = await askPlanModeQuestions(
		questions,
		ctx,
		() => lifecycle.isCurrent() && lifecycle.isEnabled(),
	);
	if (!lifecycle.isCurrent()) {
		return planModeQuestionCancelled(
			questions,
			"cancelled",
			"计划模式问题已取消，因为会话已更改。",
		);
	}
	if (!lifecycle.isEnabled()) {
		return planModeQuestionCancelled(
			questions,
			"plan_mode_inactive",
			"计划模式问题已取消，因为计划模式不再处于激活状态。",
		);
	}
	if (!answers) {
		return planModeQuestionCancelled(
			questions,
			"cancelled",
			"用户取消了计划模式问题提示。",
		);
	}
	return planModeQuestionAnswered(questions, answers);
}

export async function askPlanModeQuestions(
	questions: PlanModeQuestion[],
	ctx: ExtensionContext,
	shouldContinue: () => boolean = () => true,
): Promise<PlanModeQuestionAnswer[] | undefined> {
	const answers: PlanModeQuestionAnswer[] = [];
	for (const question of questions) {
		const choices = question.options.map(formatPlanModeQuestionChoice);
		const otherChoice = `${question.options.length + 1}. 其他（自由填写）`;
		const choice = await ctx.ui.select(`${question.header}: ${question.question}`, [
			...choices,
			otherChoice,
		]);
		if (!shouldContinue() || !choice) return undefined;
		if (choice === otherChoice) {
			const customAnswer = (await ctx.ui.editor(question.question, ""))?.trim();
			if (!shouldContinue() || !customAnswer) return undefined;
			answers.push({
				id: question.id,
				header: question.header,
				question: question.question,
				answer: customAnswer,
				wasCustom: true,
			});
			continue;
		}
		const optionIndex = choices.indexOf(choice);
		const option = question.options[optionIndex];
		if (!option) return undefined;
		answers.push({
			id: question.id,
			header: question.header,
			question: question.question,
			answer: option.label,
			wasCustom: false,
			optionIndex: optionIndex + 1,
		});
	}
	return answers;
}

function formatPlanModeQuestionChoice(option: PlanModeQuestionOption, index: number) {
	return `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`;
}

export function planModeQuestionAnswered(
	questions: PlanModeQuestion[],
	answers: PlanModeQuestionAnswer[],
) {
	return {
		content: [
			{ type: "text" as const, text: formatPlanModeQuestionPayload({ cancelled: false, answers }) },
		],
		details: { cancelled: false, questions, answers } satisfies PlanModeQuestionDetails,
	};
}

export function planModeQuestionCancelled(
	questions: PlanModeQuestion[],
	reason: PlanModeQuestionReason,
	message: string,
) {
	return {
		content: [
			{
				type: "text" as const,
				text: formatPlanModeQuestionPayload({ cancelled: true, reason, message }),
			},
		],
		details: { cancelled: true, reason, questions } satisfies PlanModeQuestionDetails,
	};
}

function formatPlanModeQuestionPayload(payload: {
	cancelled: boolean;
	reason?: PlanModeQuestionReason;
	message?: string;
	answers?: PlanModeQuestionAnswer[];
}) {
	return JSON.stringify(payload, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(value: unknown) {
	return typeof value === "string" ? value.trim() : undefined;
}
