import type { Diagnostic, ErrorCode } from "./contracts.ts";

export const diagnosticRangeLimit = 32;
interface Group {
	first: Diagnostic;
	count: number;
	pages: Set<number>;
}
/** One slot is reserved for an explicit per-code truncation summary. Coverage
 * must be tracked separately: diagnostic compression never removes text gaps. */
export class DiagnosticCollector {
	private readonly groups = new Map<string, Group>();
	private readonly truncated = new Map<ErrorCode, number>();
	private readonly limit: number;
	constructor(limit = 500) {
		this.limit = limit;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Invalid diagnostic cap");
	}
	add(value: Diagnostic): void {
		const key = JSON.stringify([value.code, value.message]);
		let group = this.groups.get(key);
		if (!group) {
			if (this.groups.size >= this.limit - 1) {
				this.truncated.set(value.code, (this.truncated.get(value.code) ?? 0) + 1);
				return;
			}
			group = { first: value, count: 0, pages: new Set() };
			this.groups.set(key, group);
		}
		group.count++;
		if (value.location) group.pages.add(value.location.pageNumber);
	}
	finish(): Diagnostic[] {
		const result = [...this.groups.values()].map(({ first, count, pages }): Diagnostic => {
			const ranges: [number, number][] = [];
			for (const page of [...pages].sort((a, b) => a - b)) {
				const last = ranges.at(-1);
				if (last && last[1] + 1 === page) last[1] = page;
				else ranges.push([page, page]);
			}
			const shown = ranges.slice(0, diagnosticRangeLimit);
			const omitted = pages.size - shown.reduce((n, [start, end]) => n + end - start + 1, 0);
			return {
				...first,
				occurrences: count,
				...(pages.size ? { pageCount: pages.size, pageRanges: shown, omittedPageCount: omitted } : {}),
			};
		});
		if (this.truncated.size)
			result.push({
				code: "extraction_failed",
				message: `Diagnostics truncated: ${[...this.truncated].map(([code, count]) => `${count} more of code ${code}`).join("; ")}`,
				occurrences: [...this.truncated.values()].reduce((a, b) => a + b, 0),
				source: null,
				location: null,
			});
		return result;
	}
}
