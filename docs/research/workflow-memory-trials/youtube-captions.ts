// Node 22+ dependency-free caption probe. Usage: node --experimental-strip-types youtube-captions.ts VIDEO_ID
const videoId = process.argv[2] ?? "jfKfPfyJRdk";
const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
const html = await (await fetch(watchUrl, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
const marker = "ytInitialPlayerResponse = ";
const start = html.indexOf(marker);
if (start < 0) throw new Error(`No ytInitialPlayerResponse found; watch response length=${html.length}`);
const jsonStart = start + marker.length;
let depth = 0;
let quoted = false;
let escaped = false;
let end = -1;
for (let i = jsonStart; i < html.length; i++) {
	const c = html.charAt(i);
	if (quoted) {
		if (escaped) escaped = false;
		else if (c === "\\") escaped = true;
		else if (c === '"') quoted = false;
		continue;
	}
	if (c === '"') quoted = true;
	else if (c === "{") depth++;
	else if (c === "}" && --depth === 0) {
		end = i + 1;
		break;
	}
}
if (end < 0) throw new Error("Unterminated player response JSON");
const player = JSON.parse(html.slice(jsonStart, end)) as {
	videoDetails?: { title?: string; lengthSeconds?: string };
	captions?: {
		playerCaptionsTracklistRenderer?: {
			captionTracks?: Array<{ baseUrl: string; languageCode: string; name?: { simpleText?: string } }>;
		};
	};
};
const track =
	player.captions?.playerCaptionsTracklistRenderer?.captionTracks?.find((t) => t.languageCode.startsWith("en")) ??
	player.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0];
if (!track)
	throw new Error(
		`No caption track. title=${player.videoDetails?.title ?? "unknown"}; playerResponse=${JSON.stringify(player.captions ?? null)}`,
	);
const captionUrl = new URL(track.baseUrl);
captionUrl.searchParams.set("fmt", "json3");
const response = await fetch(captionUrl);
const body = await response.text();
if (!response.ok) throw new Error(`Timedtext HTTP ${response.status}: ${body.slice(0, 500)}`);
let text: string;
if (body.trimStart().startsWith("{")) {
	const data = JSON.parse(body) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
	text = (data.events ?? [])
		.flatMap((event) => event.segs ?? [])
		.map((segment) => segment.utf8 ?? "")
		.join("")
		.replace(/\s+/g, " ")
		.trim();
} else {
	text = body
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}
console.log(
	JSON.stringify(
		{
			videoId,
			title: player.videoDetails?.title,
			durationSeconds: player.videoDetails?.lengthSeconds,
			language: track.languageCode,
			chars: text.length,
			first200: text.slice(0, 200),
			captionUrl: captionUrl.origin + captionUrl.pathname,
		},
		null,
		2,
	),
);
