export interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

const PLAN_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "start", label: "start", description: "开始计划模式，不发送提示" },
	{ value: "show", label: "show", description: "显示已就绪、已保存或当前计划" },
	{ value: "finalize", label: "finalize", description: "请求一份完整计划" },
	{ value: "implement", label: "implement", description: "实现已完成或已保存的计划" },
	{ value: "save", label: "save", description: "保存完整计划，供稍后使用" },
	{ value: "export", label: "export", description: "将存储的计划导出为 Markdown 文件" },
	{ value: "exit", label: "exit", description: "退出计划模式或清除已保存/当前计划" },
	{ value: "off", label: "off", description: "退出计划模式或清除已保存/当前计划" },
	{
		value: "tools",
		label: "tools",
		description: "在开始本次计划工作流之前选择工具",
	},
];

export function completePlanArguments(argumentPrefix: string): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart().toLowerCase();
	if (prefix === "") return [...PLAN_COMMAND_COMPLETIONS];
	if (/\s/.test(prefix)) return null;

	const matches = PLAN_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
	return matches.length > 0 ? [...matches] : null;
}
