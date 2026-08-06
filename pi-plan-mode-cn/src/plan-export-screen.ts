import type { PlanExportDestination } from "./plan-export.js";

export type PlanExportDestinationProvider = () => PlanExportDestination;

export function planExportInputScreen(getDestination: PlanExportDestinationProvider) {
	const destination = getDestination();
	return {
		kind: "input" as const,
		title: "导出计划",
		lines: [
			"已有路径绝不会被覆盖。",
			`默认：${destination.configuredPath}`,
			`解析为：${destination.resolvedPath}`,
		],
		placeholder: destination.configuredPath,
		action: "export" as const,
		hint: "back" as const,
	};
}
