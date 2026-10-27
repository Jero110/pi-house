/** Synthetic PDFs only. No filesystem reads or commercial-book bytes. */
export interface FixtureText {
	readonly text: string;
	readonly x?: number;
	readonly y: number;
	readonly size?: number;
	readonly font?: "Helvetica" | "Courier";
}
export interface FixturePage {
	readonly text?: readonly FixtureText[];
	readonly image?: boolean;
	readonly oversizedImage?: boolean;
	readonly noisyImage?: boolean;
	readonly geometry?: readonly [number, number];
}
export interface FixtureOutline {
	readonly title: string;
	readonly page: number;
	readonly y?: number;
}
export interface PdfFixtureOptions {
	readonly pages: readonly FixturePage[];
	readonly title?: string;
	readonly author?: string;
	readonly outlines?: readonly FixtureOutline[];
	readonly unsafe?: boolean;
	readonly externalUrl?: string;
	readonly encrypted?: boolean;
}
function literal(text: string): string {
	return `(${text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")})`;
}

export function pdfFixture(options: PdfFixtureOptions): Uint8Array {
	const objects: string[] = [];
	const reserve = () => {
		objects.push("");
		return objects.length;
	};
	const set = (id: number, body: string) => {
		objects[id - 1] = body;
	};
	const catalog = reserve();
	const pages = reserve();
	const info = reserve();
	const helvetica = reserve();
	const courier = reserve();
	set(helvetica, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	set(courier, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
	set(
		info,
		`<< /Title ${literal(options.title ?? "Synthetic book")} /Author ${literal(options.author ?? "First Author")} >>`,
	);
	const pageIds: number[] = [];
	for (const page of options.pages) {
		const pageId = reserve();
		pageIds.push(pageId);
		const streamId = reserve();
		let commands = (page.text ?? [])
			.map(
				(item) =>
					`BT /${item.font === "Courier" ? "F2" : "F1"} ${item.size ?? 12} Tf 1 0 0 1 ${item.x ?? 30} ${item.y} Tm ${literal(item.text)} Tj ET`,
			)
			.join("\n");
		// A vector diagram is renderable even without a single embedded bitmap.
		commands += "\nq 0 0 1 RG 20 20 60 30 re S Q\n";
		let assets = "";
		if (page.image || page.oversizedImage || page.noisyImage) {
			const imageId = reserve();
			const side = page.oversizedImage ? 50000 : page.noisyImage ? 1600 : 1;
			let pixels = "abc";
			if (page.noisyImage) {
				const bytes = Buffer.alloc(side * side * 3);
				let seed = 123456789;
				for (let i = 0; i < bytes.length; i++) {
					seed ^= seed << 13;
					seed ^= seed >>> 17;
					seed ^= seed << 5;
					bytes[i] = seed & 255;
				}
				pixels = `${bytes.toString("hex")}>`;
			}
			set(
				imageId,
				`<< /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8 ${page.noisyImage ? "/Filter /ASCIIHexDecode" : ""} /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`,
			);
			assets = `/XObject << /Im1 ${imageId} 0 R >>`;
			commands += page.noisyImage ? "q 1600 0 0 1600 0 0 cm /Im1 Do Q\n" : "q 50 0 0 50 20 60 cm /Im1 Do Q\n";
		}
		set(streamId, `<< /Length ${Buffer.byteLength(commands, "latin1")} >>\nstream\n${commands}\nendstream`);
		const [width, height] = page.geometry ?? [400, 600];
		set(
			pageId,
			`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${helvetica} 0 R /F2 ${courier} 0 R >> ${assets} >> /Contents ${streamId} 0 R >>`,
		);
	}
	set(pages, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
	let outlines = "";
	if (options.outlines?.length) {
		const root = reserve();
		const ids = options.outlines.map(() => reserve());
		set(root, `<< /Type /Outlines /First ${ids[0]} 0 R /Last ${ids.at(-1)} 0 R /Count ${ids.length} >>`);
		for (const [index, outline] of options.outlines.entries()) {
			const id = ids[index];
			if (!id) throw new Error("Missing synthetic outline ID");
			set(
				id,
				`<< /Title ${literal(outline.title)} /Parent ${root} 0 R ${index ? `/Prev ${ids[index - 1]} 0 R` : ""} ${index + 1 < ids.length ? `/Next ${ids[index + 1]} 0 R` : ""} /Dest [${pageIds[outline.page - 1]} 0 R /XYZ 0 ${outline.y ?? "null"} null] >>`,
			);
		}
		outlines = `/Outlines ${root} 0 R`;
	}
	let unsafe = "";
	if (options.unsafe) {
		const action = reserve();
		set(action, '<< /S /JavaScript /JS (throw new Error("MUST NOT RUN")) >>');
		const attachment = reserve();
		set(attachment, "<< /Type /EmbeddedFile /Length 0 >>\nstream\n\nendstream");
		unsafe = `/OpenAction ${action} 0 R /Names << /EmbeddedFiles << /Names [(payload) << /Type /Filespec /EF << /F ${attachment} 0 R >> >>] >> >> /AA << /WC << /S /URI /URI ${literal(options.externalUrl ?? "http://127.0.0.1:9/never-fetch")} >> >>`;
	}
	set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R ${outlines} ${unsafe} >>`);
	let encryption = "";
	if (options.encrypted) {
		const encryptionId = reserve();
		set(
			encryptionId,
			`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${"00".repeat(32)}> /U <${"01".repeat(32)}> >>`,
		);
		encryption = `/Encrypt ${encryptionId} 0 R /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>]`;
	}
	let pdf = "%PDF-1.7\n";
	const offsets = [0];
	for (const [index, body] of objects.entries()) {
		offsets.push(Buffer.byteLength(pdf, "latin1"));
		pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
	}
	const xref = Buffer.byteLength(pdf, "latin1");
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R ${encryption} >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}

/** Four physical pages modeling the observed 171–174 boundary shape, not book content. */
export function subsectionPdf(): Uint8Array {
	return pdfFixture({
		pages: [
			{
				text: [
					{ text: "Semantic chunking", y: 400, size: 18 },
					{ text: "A coherent subsection begins here.", y: 370 },
				],
			},
			{ text: [{ text: "Its explanation continues on the following page.", y: 550 }] },
			{
				text: [
					{ text: "Handling images", y: 400, size: 18 },
					{ text: "Different topic. See Figure 3-7 on the next page.", y: 370 },
				],
			},
			{ text: [{ text: "Figure 3-7. Synthetic vector diagram", y: 100 }] },
		],
	});
}

export function structuralPdf(): Uint8Array {
	return pdfFixture({
		pages: [
			{
				text: [
					{ text: "First Author; Second Author", y: 570 },
					{ text: "Introduction", y: 530, size: 18 },
					{ text: "Introductory paragraph.", y: 500 },
					{ text: "Semantic chunking", y: 350, size: 18 },
					{ text: "A subsection starts halfway down this page.", y: 320 },
					{ text: "embedding_ vectors = [", y: 180, font: "Courier" },
					{ text: "    first_value,", y: 160, font: "Courier" },
				],
			},
			{
				text: [
					{ text: "    second_value]", y: 550, font: "Courier" },
					{ text: "Continuation with Figure 3-7 on the next page.", y: 510 },
					{ text: "Length (ms)", x: 30, y: 460 },
					{ text: "Value (MB)", x: 210, y: 460 },
					{ text: "10", x: 30, y: 440 },
					{ text: "20", x: 210, y: 440 },
					{ text: "Handling images", y: 300, size: 18 },
					{ text: "A different subsection.", y: 270 },
				],
			},
			{ text: [{ text: "Figure 3-7. Synthetic vector diagram", y: 100 }] },
		],
		outlines: [
			{ title: "Introduction", page: 1, y: 530 },
			{ title: "Semantic chunking", page: 1, y: 350 },
			{ title: "Handling images", page: 2, y: 300 },
		],
	});
}
