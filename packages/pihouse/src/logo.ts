// The pihouse lighthouse in the terminal: two pixels per cell with half blocks, in the image's own colors.
import { LOGO_PIXELS } from "./logo-pixels.ts";

const RESET = "\x1b[0m";

function rgb(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const fg = (hex: string) => `\x1b[38;2;${rgb(hex).join(";")}m`;
const bg = (hex: string) => `\x1b[48;2;${rgb(hex).join(";")}m`;

/** One string per terminal line; every line has the same visible width (the grid's width). */
export function logoLines(pixels: ReadonlyArray<ReadonlyArray<string | null>> = LOGO_PIXELS): string[] {
	const width = Math.max(0, ...pixels.map((r) => r.length));
	const lines: string[] = [];
	for (let y = 0; y < pixels.length; y += 2) {
		let line = "";
		for (let x = 0; x < width; x++) {
			const top = pixels[y]?.[x] ?? null;
			const bottom = pixels[y + 1]?.[x] ?? null;
			if (top && bottom) line += `${fg(top)}${bg(bottom)}▀${RESET}`;
			else if (top) line += `${fg(top)}▀${RESET}`;
			else if (bottom) line += `${fg(bottom)}▄${RESET}`;
			else line += " ";
		}
		lines.push(line);
	}
	return lines;
}

/** The logo's width in cells. */
export const LOGO_WIDTH = Math.max(0, ...LOGO_PIXELS.map((r) => r.length));
