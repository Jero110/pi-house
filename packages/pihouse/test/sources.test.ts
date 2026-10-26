import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { type FetchResponse, fetchSource, type SourceDeps, stripHtml, vttToText } from "../src/workflow/sources.ts";

const NOW = new Date("2026-10-26T12:00:00Z");
const reply = (body: string, status = 200): FetchResponse => ({ ok: status < 400, status, text: async () => body });

const PLAYER = "https://www.youtube.com/youtubei/v1/player";

function player(
	tracks: unknown[],
	audioTracks: unknown[] = [],
	playability: unknown = { status: "OK" },
): FetchResponse {
	return reply(
		JSON.stringify({
			playabilityStatus: playability,
			videoDetails: { title: "A talk", author: "Someone", lengthSeconds: "125" },
			captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks, audioTracks } },
		}),
	);
}

const CAPTCHA = "<html><form id='captcha-form'>Unusual traffic</form></html>";
const VTT =
	"WEBVTT\n\n00:00.000 --> 00:02.000\nhello there\n\n00:02.000 --> 00:04.000\nhello there\nhow are <c>you</c>\n";

function deps(over: Partial<SourceDeps> & { pages?: Record<string, FetchResponse> }): SourceDeps & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		now: () => NOW,
		fetch: async (url) => {
			calls.push(`fetch ${url}`);
			const hit = Object.entries(over.pages ?? {}).find(([prefix]) => url.startsWith(prefix));
			if (!hit) throw new Error("no network in tests");
			return hit[1];
		},
		which: over.which ?? (() => false),
		exec:
			over.exec ??
			(async (bin) => {
				throw new Error(`unexpected exec ${bin}`);
			}),
	};
}

const YT = "https://www.youtube.com/watch?v=abc123";

test("youtube link with captions uses the player endpoint and picks the default track", async () => {
	const d = deps({
		pages: {
			[PLAYER]: player(
				[
					{ baseUrl: "https://tt.example/bn?lang=bn&fmt=srv3", languageCode: "bn", kind: "asr" },
					{ baseUrl: "https://tt.example/en?lang=en&fmt=srv3", languageCode: "en" },
				],
				[{ captionTrackIndices: [0, 1], defaultCaptionTrackIndex: 1 }],
			),
			"https://tt.example/en": reply(
				JSON.stringify({
					events: [{ segs: [{ utf8: "Hello " }, { utf8: "world\n" }] }, {}, { segs: [{ utf8: "again" }] }],
				}),
			),
		},
	});
	const r = await fetchSource(YT, d);
	assert.ok(r.ok);
	assert.equal(r.text, "Hello world again");
	assert.deepEqual(r.meta, {
		kind: "youtube",
		url: YT,
		title: "A talk",
		author: "Someone",
		durationSec: 125,
		language: "en",
		method: "captions-fetch",
		fetchedAt: NOW.toISOString(),
	});
	assert.ok(d.calls.includes("fetch https://tt.example/en?lang=en&fmt=json3"));
});

test("without a default track the original audio (id ending .4) picks the caption track", async () => {
	const d = deps({
		pages: {
			[PLAYER]: player(
				[
					{ baseUrl: "https://tt.example/dub", languageCode: "hi" },
					{ baseUrl: "https://tt.example/orig", languageCode: "en" },
				],
				[
					{ audioTrackId: "hi.10", captionTrackIndices: [0] },
					{ audioTrackId: "en.4", captionTrackIndices: [1] },
				],
			),
			"https://tt.example/orig": reply(JSON.stringify({ events: [{ segs: [{ utf8: "original" }] }] })),
		},
	});
	const r = await fetchSource(YT, d);
	assert.ok(r.ok);
	assert.equal(r.text, "original");
	assert.equal(r.meta.language, "en");
});

test("a live stream (UNPLAYABLE) falls through to yt-dlp subtitles", async () => {
	const d = deps({
		pages: { [PLAYER]: player([], [], { status: "UNPLAYABLE", reason: "This live event will begin soon" }) },
		which: (bin) => bin === "yt-dlp",
		exec: async (_bin, a) => {
			const out = a[a.indexOf("-o") + 1] ?? "";
			writeFileSync(`${out.replace("%(id)s", "abc123")}.en.vtt`, VTT);
			return { stdout: "A talk\n125\n" };
		},
	});
	const r = await fetchSource("https://youtu.be/abc123", d);
	assert.ok(r.ok);
	assert.equal(r.text, "hello there how are you");
	assert.equal(r.meta.method, "yt-dlp");
});

test("a CAPTCHA answer instead of JSON is reported and falls through", async () => {
	const d = deps({ pages: { [PLAYER]: reply(CAPTCHA) } });
	const r = await fetchSource(YT, d);
	assert.ok(!r.ok);
	assert.match(r.message, /did not answer JSON/);
});

test("the request is the Android client POST with the video id", async () => {
	let seen: { method?: string; body?: string } = {};
	const d = deps({ pages: { [PLAYER]: player([]) } });
	const inner = d.fetch;
	d.fetch = async (url, init) => {
		if (url.startsWith(PLAYER)) seen = { method: init?.method, body: init?.body };
		return inner(url, init);
	};
	await fetchSource(YT, d);
	assert.equal(seen.method, "POST");
	assert.equal(JSON.parse(seen.body ?? "{}").videoId, "abc123");
});

test("no captions and no tools: clear message naming yt-dlp and the agent fallback", async () => {
	const d = deps({ pages: { [PLAYER]: player([]) } });
	const r = await fetchSource(YT, d);
	assert.ok(!r.ok);
	assert.deepEqual(r.tried, ["captions-fetch", "yt-dlp", "whisper"]);
	assert.equal(r.fallback, "agent");
	assert.match(r.message, /no caption track/);
	assert.match(r.message, /yt-dlp is not on PATH/);
	assert.match(r.message, /Install yt-dlp \(or whisper and ffmpeg\)/);
	assert.match(r.message, /cheap agent/);
});

test("a network error is reported, not thrown", async () => {
	const r = await fetchSource(YT, deps({}));
	assert.ok(!r.ok);
	assert.match(r.message, /no network in tests/);
});

test("whisper runs on audio from yt-dlp when both and ffmpeg exist", async () => {
	const runs: string[] = [];
	const d = deps({
		pages: { [PLAYER]: reply(CAPTCHA) },
		which: () => true,
		exec: async (bin, a) => {
			runs.push(bin);
			if (bin === "yt-dlp" && a.includes("--skip-download")) return { stdout: "" };
			if (bin === "yt-dlp") {
				writeFileSync(a[a.indexOf("-o") + 1]?.replace("%(ext)s", "mp3") ?? "", "x");
				return { stdout: "" };
			}
			writeFileSync(join(a[a.indexOf("--output_dir") + 1] ?? "", `${basename(a[0] ?? "")}.txt`), " spoken  words\n");
			return { stdout: "" };
		},
	});
	const r = await fetchSource(YT, d);
	assert.ok(r.ok);
	assert.equal(r.text, "spoken words");
	assert.equal(r.meta.method, "whisper");
	assert.deepEqual(runs, ["yt-dlp", "yt-dlp", "whisper"]);
});

test("a video file without whisper names the missing tools", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-src-test-"));
	const file = join(dir, "clip.mp4");
	writeFileSync(file, "x");
	const r = await fetchSource(file, deps({ which: (bin) => bin === "ffmpeg" }));
	assert.ok(!r.ok);
	assert.match(r.message, /whisper is not on PATH/);
	assert.match(r.message, /Install whisper and ffmpeg/);
	assert.equal(r.fallback, "agent");
});

test("a video file is transcribed with whisper", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-src-test-"));
	const file = join(dir, "clip.mp4");
	writeFileSync(file, "x");
	const d = deps({
		which: () => true,
		exec: async (_bin, a) => {
			writeFileSync(join(a[a.indexOf("--output_dir") + 1] ?? "", "clip.txt"), "from the file");
			return { stdout: "" };
		},
	});
	const r = await fetchSource(file, d);
	assert.ok(r.ok);
	assert.equal(r.text, "from the file");
	assert.equal(r.meta.kind, "file");
	assert.equal(r.meta.path, file);
});

test("a plain web link is stripped to text with its title", async () => {
	const html =
		"<html><head><title>Hi &amp; bye</title><style>p{}</style></head><body><script>var a=1</script><p>One &lt;two&gt;</p><!-- c --><p>three</p></body></html>";
	const r = await fetchSource("https://example.com/post", deps({ pages: { "https://example.com/post": reply(html) } }));
	assert.ok(r.ok);
	assert.equal(r.text, "Hi & bye One <two> three");
	assert.equal(r.meta.title, "Hi & bye");
	assert.equal(r.meta.kind, "web");
	assert.equal(r.meta.method, "fetch");
});

test("a failing web link and an unknown input give the agent fallback", async () => {
	const bad = await fetchSource(
		"https://example.com/x",
		deps({ pages: { "https://example.com/x": reply("no", 404) } }),
	);
	assert.ok(!bad.ok);
	assert.match(bad.message, /HTTP 404/);
	const odd = await fetchSource("just words", deps({}));
	assert.ok(!odd.ok);
	assert.deepEqual(odd.tried, []);
});

test("helpers: vttToText drops rolling duplicates, stripHtml caps nothing it should keep", () => {
	assert.equal(vttToText(VTT), "hello there how are you");
	assert.equal(stripHtml("<b>a</b>  b").text, "a b");
});
