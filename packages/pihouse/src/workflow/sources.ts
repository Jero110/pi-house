// Turns a source the user names in /workflow ask (a YouTube link, a video or audio file, a web link) into text. No
// model reads anything here and nothing is installed: the tools are looked up on PATH and the caller decides what to do
// when none works. See docs/decisions/ADR-001-workflow-memory.md, D7.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

export type Method = "captions-fetch" | "yt-dlp" | "whisper" | "fetch";
export type SourceKind = "youtube" | "file" | "web";

export interface SourceMeta {
	kind: SourceKind;
	/** The link for youtube and web sources. */
	url?: string;
	/** The file for file sources. */
	path?: string;
	title?: string;
	/** The channel, for youtube sources. */
	author?: string;
	durationSec?: number;
	language?: string;
	method: Method;
	fetchedAt: string;
}

export type SourceResult =
	| { ok: true; meta: SourceMeta; text: string }
	| { ok: false; tried: Method[]; message: string; fallback: "agent" };

export interface FetchResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export interface SourceDeps {
	fetch(
		url: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string },
	): Promise<FetchResponse>;
	which(bin: string): boolean;
	exec(bin: string, args: string[]): Promise<{ stdout: string }>;
	now?: () => Date;
	/** Preferred subtitle language (default "en"). */
	language?: string;
}

export const MAX_WEB_CHARS = 200_000;
const AUDIO_VIDEO = /\.(mp4|mkv|mov|webm|avi|m4v|mp3|m4a|wav|flac|ogg|opus|aac)$/i;
const execFileAsync = promisify(execFile);

export function defaultDeps(): SourceDeps {
	return {
		fetch: (url, init) => globalThis.fetch(url, init),
		which: (bin) => (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, bin))),
		exec: async (bin, args) => {
			const { stdout } = await execFileAsync(bin, args, { maxBuffer: 64 * 1024 * 1024 });
			return { stdout };
		},
	};
}

export function isYouTubeLink(input: string): boolean {
	try {
		const u = new URL(input);
		const host = u.hostname.replace(/^(www|m)\./, "");
		if (host === "youtu.be") return u.pathname.length > 1;
		return host === "youtube.com" && (u.pathname === "/watch" || u.pathname.startsWith("/shorts/"));
	} catch {
		return false;
	}
}

export function stripHtml(html: string): { title?: string; text: string } {
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
	const text = decodeEntities(
		html
			.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/\s+/g, " ")
		.trim();
	return { title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() || undefined : undefined, text };
}

function decodeEntities(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/**
 * Problem: auto-generated WebVTT repeats every line in the next cue as the words roll, so the plain text would say
 * everything two or three times. Example: "hello there" / "hello there how are you". Solution: drop the header,
 * timestamps and tags, then drop a line equal to the previous one.
 */
export function vttToText(vtt: string): string {
	const lines: string[] = [];
	for (const raw of vtt.split(/\r?\n/)) {
		const line = raw.replace(/<[^>]+>/g, "").trim();
		if (!line || /^(WEBVTT|NOTE|Kind:|Language:)/.test(line) || line.includes("-->") || /^\d+$/.test(line)) continue;
		if (lines[lines.length - 1] !== line) lines.push(line);
	}
	return decodeEntities(lines.join(" ")).replace(/\s+/g, " ").trim();
}

interface CaptionTrack {
	baseUrl: string;
	languageCode: string;
	kind?: string;
}
interface AudioTrack {
	captionTrackIndices?: number[];
	defaultCaptionTrackIndex?: number;
	audioTrackId?: string;
}
interface PlayerResponse {
	playabilityStatus?: { status?: string; reason?: string };
	videoDetails?: { title?: string; author?: string; lengthSeconds?: string };
	captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[]; audioTracks?: AudioTrack[] } };
}

// The YouTube Android app's own client. The watch page answers a CAPTCHA to servers; this endpoint answers JSON with
// no key. The official Data API is not an option: captions.download needs OAuth and edit rights on the video.
const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const ANDROID_VERSION = "20.10.38";
const ANDROID_UA = `com.google.android.youtube/${ANDROID_VERSION} (Linux; U; Android 14)`;

function videoId(link: string): string | undefined {
	const u = new URL(link);
	if (u.hostname.replace(/^(www|m)\./, "") === "youtu.be") return u.pathname.split("/")[1] || undefined;
	if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || undefined;
	return u.searchParams.get("v") ?? undefined;
}

/**
 * Problem: the first track is often the wrong one. Example: an English video whose list starts with a Bengali
 * auto-translation. Solution: trust the default of the first audio track; else the original audio (its id ends in
 * ".4", dubbed ones in ".10"); else the first audio track; else a manual track, else the first track.
 */
export function pickTrack(tracks: CaptionTrack[], audioTracks: AudioTrack[] = []): CaptionTrack | undefined {
	const first = audioTracks[0];
	const original = audioTracks.find((a) => a.audioTrackId?.endsWith(".4"));
	const index =
		first?.defaultCaptionTrackIndex ?? original?.captionTrackIndices?.[0] ?? first?.captionTrackIndices?.[0];
	return (index === undefined ? undefined : tracks[index]) ?? tracks.find((t) => t.kind !== "asr") ?? tracks[0];
}

function json3ToText(body: string): string {
	const data = JSON.parse(body) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
	return (data.events ?? [])
		.filter((e) => e.segs)
		.map((e) => (e.segs ?? []).map((s) => s.utf8 ?? "").join(""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

type Attempt =
	| { ok: true; meta: Omit<SourceMeta, "kind" | "url" | "path" | "fetchedAt">; text: string }
	| { ok: false; why: string };

async function viaCaptions(url: string, deps: SourceDeps, language: string): Promise<Attempt> {
	try {
		const id = videoId(url);
		if (!id) return { ok: false, why: "no video id in the link" };
		const page = await deps.fetch(INNERTUBE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", "User-Agent": ANDROID_UA },
			body: JSON.stringify({
				context: {
					client: { clientName: "ANDROID", clientVersion: ANDROID_VERSION, androidSdkVersion: 34, hl: language },
				},
				videoId: id,
			}),
		});
		const raw = await page.text();
		if (!page.ok) return { ok: false, why: `player endpoint answered HTTP ${page.status}` };
		let player: PlayerResponse;
		try {
			player = JSON.parse(raw) as PlayerResponse;
		} catch {
			return { ok: false, why: "player endpoint did not answer JSON" };
		}
		const status = player.playabilityStatus?.status;
		if (status !== "OK") {
			const reason = player.playabilityStatus?.reason;
			return { ok: false, why: `video is not playable (${status ?? "no status"}${reason ? `: ${reason}` : ""})` };
		}
		const renderer = player.captions?.playerCaptionsTracklistRenderer;
		const track = pickTrack(renderer?.captionTracks ?? [], renderer?.audioTracks);
		if (!track) return { ok: false, why: "the video has no caption track" };
		const captionUrl = new URL(track.baseUrl);
		captionUrl.searchParams.set("fmt", "json3");
		const res = await deps.fetch(captionUrl.toString(), { headers: { "User-Agent": ANDROID_UA } });
		const captions = await res.text();
		if (!res.ok) return { ok: false, why: `caption download answered HTTP ${res.status}` };
		const text = json3ToText(captions);
		if (!text) return { ok: false, why: "the caption track was empty" };
		const seconds = Number(player.videoDetails?.lengthSeconds);
		return {
			ok: true,
			text,
			meta: {
				method: "captions-fetch",
				title: player.videoDetails?.title,
				author: player.videoDetails?.author,
				durationSec: Number.isFinite(seconds) ? seconds : undefined,
				language: track.languageCode,
			},
		};
	} catch (e) {
		return { ok: false, why: `network or parse error: ${(e as Error).message}` };
	}
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-source-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function viaYtDlp(url: string, deps: SourceDeps, language: string): Promise<Attempt> {
	if (!deps.which("yt-dlp")) return { ok: false, why: "yt-dlp is not on PATH" };
	return withTmp(async (dir) => {
		try {
			const { stdout } = await deps.exec("yt-dlp", [
				"--skip-download",
				"--write-subs",
				"--write-auto-subs",
				"--sub-format",
				"vtt",
				"--sub-langs",
				`${language}.*,en.*`,
				"-o",
				join(dir, "%(id)s"),
				"--print",
				"title",
				"--print",
				"duration",
				url,
			]);
			const files = readdirSync(dir).filter((f) => f.endsWith(".vtt"));
			const file = files.find((f) => f.includes(`.${language}`)) ?? files[0];
			if (!file) return { ok: false, why: "yt-dlp found no subtitles for the video" };
			const text = vttToText(readFileSync(join(dir, file), "utf8"));
			if (!text) return { ok: false, why: "the subtitles yt-dlp wrote were empty" };
			const [title, duration] = stdout.split("\n").map((l) => l.trim());
			const seconds = Number(duration);
			return {
				ok: true,
				text,
				meta: {
					method: "yt-dlp",
					title: title || undefined,
					durationSec: duration && Number.isFinite(seconds) ? seconds : undefined,
					language: /\.([\w-]+)\.vtt$/.exec(file)?.[1],
				},
			};
		} catch (e) {
			return { ok: false, why: `yt-dlp failed: ${(e as Error).message}` };
		}
	});
}

function missing(deps: SourceDeps, bins: string[]): string | undefined {
	const gone = bins.filter((b) => !deps.which(b));
	return gone.length ? `${gone.join(" and ")} ${gone.length > 1 ? "are" : "is"} not on PATH` : undefined;
}

async function runWhisper(audio: string, dir: string, deps: SourceDeps): Promise<Attempt> {
	try {
		await deps.exec("whisper", [audio, "--output_format", "txt", "--output_dir", dir]);
		const file = readdirSync(dir).find((f) => f.endsWith(".txt"));
		const text = file ? readFileSync(join(dir, file), "utf8").replace(/\s+/g, " ").trim() : "";
		if (!text) return { ok: false, why: "whisper produced no text" };
		return { ok: true, text, meta: { method: "whisper" } };
	} catch (e) {
		return { ok: false, why: `whisper failed: ${(e as Error).message}` };
	}
}

async function viaWhisperUrl(url: string, deps: SourceDeps): Promise<Attempt> {
	const gone = missing(deps, ["whisper", "ffmpeg", "yt-dlp"]);
	if (gone) return { ok: false, why: `${gone} (needed to transcribe the audio)` };
	return withTmp(async (dir) => {
		try {
			await deps.exec("yt-dlp", ["-x", "--audio-format", "mp3", "-o", join(dir, "audio.%(ext)s"), url]);
		} catch (e) {
			return { ok: false, why: `yt-dlp could not download the audio: ${(e as Error).message}` };
		}
		const audio = readdirSync(dir).find((f) => f.startsWith("audio."));
		if (!audio) return { ok: false, why: "yt-dlp wrote no audio file" };
		return runWhisper(join(dir, audio), dir, deps);
	});
}

async function viaWhisperFile(path: string, deps: SourceDeps): Promise<Attempt> {
	const gone = missing(deps, ["whisper", "ffmpeg"]);
	if (gone) return { ok: false, why: `${gone} (needed to transcribe a media file)` };
	return withTmp((dir) => runWhisper(path, dir, deps));
}

async function viaFetch(url: string, deps: SourceDeps): Promise<Attempt> {
	try {
		const res = await deps.fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
		const body = await res.text();
		if (!res.ok) return { ok: false, why: `the page answered HTTP ${res.status}` };
		const { title, text } = stripHtml(body);
		if (!text) return { ok: false, why: "the page has no readable text" };
		return { ok: true, text: text.slice(0, MAX_WEB_CHARS), meta: { method: "fetch", title } };
	} catch (e) {
		return { ok: false, why: `network error: ${(e as Error).message}` };
	}
}

export async function fetchSource(input: string, deps: SourceDeps = defaultDeps()): Promise<SourceResult> {
	const source = input.trim();
	const language = deps.language ?? "en";
	const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
	let kind: SourceKind;
	let attempts: Array<[Method, () => Promise<Attempt>]>;
	if (isYouTubeLink(source)) {
		kind = "youtube";
		attempts = [
			["captions-fetch", () => viaCaptions(source, deps, language)],
			["yt-dlp", () => viaYtDlp(source, deps, language)],
			["whisper", () => viaWhisperUrl(source, deps)],
		];
	} else if (/^https?:\/\//i.test(source)) {
		kind = "web";
		attempts = [["fetch", () => viaFetch(source, deps)]];
	} else if (AUDIO_VIDEO.test(source)) {
		kind = "file";
		attempts = existsSync(source)
			? [["whisper", () => viaWhisperFile(source, deps)]]
			: [["whisper", async () => ({ ok: false, why: "the file does not exist" })]];
	} else {
		return {
			ok: false,
			tried: [],
			fallback: "agent",
			message: `Could not get a transcript of ${source}: it is not a YouTube link, a web link or a video or audio file.`,
		};
	}
	const tried: Method[] = [];
	const reasons: string[] = [];
	for (const [method, run] of attempts) {
		tried.push(method);
		const got = await run();
		if (got.ok) {
			const where = kind === "file" ? { path: source } : { url: source };
			return { ok: true, meta: { kind, ...where, ...got.meta, fetchedAt }, text: got.text };
		}
		reasons.push(`${method}: ${got.why}`);
	}
	const install =
		kind === "youtube"
			? "Install yt-dlp (or whisper and ffmpeg) to transcribe it here"
			: kind === "file"
				? "Install whisper and ffmpeg to transcribe it here"
				: "Check the link";
	return {
		ok: false,
		tried,
		fallback: "agent",
		message: `Could not get a transcript of ${source}: ${reasons.join("; ")}. ${install}, or I can ask a cheap agent to read it.`,
	};
}
