import assert from "node:assert/strict";
import test from "node:test";
import type { Diagnostic } from "../src/contracts.ts";
import { DiagnosticCollector } from "../src/diagnostics.ts";

function notice(page: number, message = "Raster figure content is not OCR-extracted"): Diagnostic {
	return {
		code: "unsupported_asset",
		message,
		source: null,
		location: {
			kind: "pdf",
			printedLabel: null,
			coordinateSystem: "pdf-points-top-left",
			pageNumber: page,
			pageWidth: 400,
			pageHeight: 600,
			bounds: null,
		},
	};
}
test("700 repeated page notes become one compact count/range without losing pages", () => {
	const collector = new DiagnosticCollector();
	for (let page = 1; page <= 700; page++) collector.add(notice(page));
	const result = collector.finish();
	assert.equal(result.length, 1);
	assert.equal(result[0]?.occurrences, 700);
	assert.equal(result[0]?.pageCount, 700);
	assert.deepEqual(result[0]?.pageRanges, [[1, 700]]);
	assert.equal(result[0]?.omittedPageCount, 0);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024);
});
test("sparse page ranges are bounded and report the exact omitted page count", () => {
	const collector = new DiagnosticCollector();
	for (let page = 2; page <= 1000; page += 2) collector.add(notice(page));
	const result = collector.finish()[0];
	assert.equal(result?.pageRanges?.length, 32);
	assert.equal(result?.occurrences, 500);
	assert.equal(result?.pageCount, 500);
	assert.equal(result?.omittedPageCount, 468);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024);
});
test("distinct-entry overflow is counted by code in a reserved summary, not thrown", () => {
	const collector = new DiagnosticCollector();
	for (let page = 1; page <= 600; page++) collector.add(notice(page, `Distinct note ${page}`));
	collector.add({ ...notice(601, "Another note"), code: "scanned_page" });
	const result = collector.finish();
	assert.equal(result.length, 500);
	assert.match(
		result.at(-1)?.message ?? "",
		/Diagnostics truncated: 101 more of code unsupported_asset; 1 more of code scanned_page/,
	);
	assert.equal(result.at(-1)?.occurrences, 102);
});
