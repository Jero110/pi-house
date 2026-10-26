// The pihouse mark as a pixel grid: a gray roof over a white π. `r` is the roof, `w` the π, `-` is empty.
// logo.ts draws two rows of this grid per terminal line.
const COLORS: Record<string, string> = { r: "#8b8b92", w: "#f4f4f5" };

const ART = [
	"-------r-------",
	"------r-r------",
	"-----r---r-----",
	"----r-----r----",
	"---r-------r---",
	"--r---------r--",
	"---------------",
	"---wwwwwwwww---",
	"-----w---w-----",
	"-----w---w-----",
	"-----w---w-----",
	"-----w---ww----",
];

export const LOGO_PIXELS: ReadonlyArray<ReadonlyArray<string | null>> = ART.map((row) =>
	[...row].map((c) => COLORS[c] ?? null),
);
