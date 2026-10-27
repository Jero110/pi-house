#!/usr/bin/env node
// books-rag CLI: ingest PDFs into the local store, publish them as the single writer, check the setup, and run
// the synthetic evaluation. Reading the library is the MCP server's job (mcp.ts); this tool never starts it.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { productionTargetBound } from "./chunks.ts";
import { AdapterError, type BooksConfig, loadConfig, parseEnv } from "./config.ts";
import { evaluateSynthetic } from "./evaluate.ts";
import { indexCorpus, loadCatalog } from "./indexing.ts";
import { ingestPdf, publishIngest } from "./ingest.ts";
import { CorpusError, readLocalPdf, sha256 } from "./locations.ts";
import { servicesFromConfig } from "./mcp.ts";
import { pdfLimits } from "./pdf.ts";
import { CorpusStore } from "./store.ts";

export interface CliIo {
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
}

export const usage = `books-rag: private PDF book library (PDF only; EPUB is not supported)

Usage: books-rag <command> [options]

Commands:
  doctor                    Check configuration, .env syntax, Ollama, Pinecone, S3 privacy and the catalog.
                            Read-only: it writes nothing and prints no secrets.
  ingest --input <path>     Extract a PDF, or every *.pdf directly inside a directory (not recursive), into the
                            local store. Non-PDF files and symlinks are rejected per file; other files continue.
  index                     Publish the local store to Pinecone and private S3 as the single writer.
  evaluate --synthetic      Run the offline synthetic pipeline evaluation against loopback fakes only.

Options:
  --env-file <path>         KEY=value file. Default: BOOKS_ENV_FILE, else ./.env when it exists.
                            Process environment variables override the file.
  -h, --help                Show this help.

MCP server (read-only, works with an empty local store): node <package>/src/mcp.ts
Originals are never modified or deleted by this tool. After a successful index you may delete them yourself.`;

const originalsNote =
	"Note: original PDFs are never deleted by books-rag. After a successful `index` you may delete them manually if you no longer need local copies.";
const requiredKeys = [
	"BOOKS_DATA_DIR",
	"PINE_CONE_API",
	"PINECONE_INDEX_NAME",
	"PINECONE_HOST",
	"PINECONE_NAMESPACE",
	"S3_ENDPOINT",
	"S3_REGION",
	"S3_BUCKET",
	"S3_ACCESS_KEY_ID",
	"S3_SECRET_ACCESS_KEY",
	"S3_LIBRARY_PREFIX",
	"S3_BUCKET_PRIVATE_CONFIRMED",
];
const secretKeys = ["PINE_CONE_API", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
/** Production chunking, part of every version's identity so a later change makes a new version. */
const chunkOptions = { targetBound: productionTargetBound };
const ingestConfigurationHash = sha256(`books-rag-ingest-v1:${JSON.stringify(chunkOptions)}`);

function describe(error: unknown): string {
	if (error instanceof AdapterError || error instanceof CorpusError) return error.message;
	return "unexpected failure (details withheld in case they contain secrets)";
}

interface Environment {
	readonly values: Record<string, string | undefined>;
	readonly file: string | null;
}
function environment(io: CliIo, explicit: string | undefined): Environment {
	const chosen = explicit ?? io.env.BOOKS_ENV_FILE;
	const fallback = join(io.cwd, ".env");
	const file = chosen ? resolve(io.cwd, chosen) : existsSync(fallback) ? fallback : null;
	return { values: { ...io.env }, file };
}
/** .env values first, process environment on top, as loadConfig merges them. */
function merged(environmentInfo: Environment): Record<string, string | undefined> {
	return {
		...(environmentInfo.file ? parseEnv(readFileSync(environmentInfo.file, "utf8")) : {}),
		...environmentInfo.values,
	};
}

type Status = "ok" | "warn" | "fail" | "skip" | "info";
async function doctor(io: CliIo, info: Environment): Promise<number> {
	const lines: string[] = [];
	const secrets: string[] = [];
	let failed = false;
	const report = (status: Status, name: string, detail: string) => {
		if (status === "fail") failed = true;
		lines.push(`[${status.toUpperCase().padEnd(4)}] ${name}: ${detail}`);
	};
	let values: Record<string, string | undefined> = { ...info.values };
	if (!info.file) report("info", "env file", "none found; using the process environment only");
	else {
		try {
			const parsed = parseEnv(readFileSync(info.file, "utf8"));
			values = { ...parsed, ...info.values };
			report("ok", "env file", `${basename(info.file)} syntax valid (${Object.keys(parsed).length} keys)`);
		} catch (error) {
			report(
				"fail",
				"env file",
				`${describe(error)}. Use KEY=value lines (no colons, no spaces around =); values are never printed.`,
			);
		}
	}
	for (const key of secretKeys) if (values[key]) secrets.push(values[key]);
	const missing = requiredKeys.filter((key) => !values[key]?.trim());
	let config: BooksConfig | null = null;
	if (missing.length)
		report("fail", "configuration", `missing ${missing.join(", ")}. Set them in the env file or environment.`);
	else {
		try {
			config = loadConfig({ env: values });
			report("ok", "configuration", "all required settings present and well-formed");
		} catch (error) {
			report("fail", "configuration", describe(error));
		}
	}
	const clients = config ? servicesFromConfig(config, values as NodeJS.ProcessEnv, { retries: 0 }) : null;
	if (clients) {
		try {
			const identity = await clients.embeddings.doctor();
			report("ok", "ollama", `reachable; pinned model ${identity.model} digest verified`);
		} catch (error) {
			report(
				"fail",
				"ollama",
				`${describe(error)}. Start Ollama and pull the pinned model, or set OLLAMA_URL (loopback only).`,
			);
		}
		try {
			await clients.pinecone.doctor();
			report("ok", "pinecone", "index described (read-only): ready serverless dense cosine 768 at the configured host");
		} catch (error) {
			report("fail", "pinecone", `${describe(error)}. Check PINECONE_INDEX_NAME, PINECONE_HOST and the key.`);
		}
		try {
			const state = await loadCatalog(clients.objects);
			report("ok", "s3 privacy", "unauthenticated GET of the probe key was refused (read-only check)");
			if (!state.catalog)
				report(
					"warn",
					"catalog",
					"not found. The writer machine must run `ingest` then `index` before readers can search.",
				);
			else if (state.incomplete)
				report(
					"warn",
					"catalog",
					"found, but a publication is pending or incomplete; readers use only the committed generation",
				);
			else report("ok", "catalog", `${state.catalog.versions.length} book(s) committed`);
		} catch (error) {
			report(
				"fail",
				"s3 privacy/catalog",
				`${describe(error)}. If the probe object does not exist yet, the writer must run \`index\` once to create it; doctor never writes.`,
			);
		}
		const dir = values.BOOKS_DATA_DIR ?? "";
		report(
			"info",
			"local store",
			existsSync(dir)
				? "present (needed only on the writer machine)"
				: "absent (fine for a read-only machine; `ingest` creates it on the writer)",
		);
	} else report("skip", "ollama/pinecone/s3", "skipped until configuration is complete");
	let text = lines.join("\n");
	for (const secret of secrets) if (secret.length >= 3) text = text.replaceAll(secret, "[redacted]");
	io.stdout(`${text}\n${failed ? "doctor: problems found" : "doctor: ready"}\n`);
	return failed ? 1 : 0;
}

interface Candidate {
	readonly path: string;
	readonly problem: string | null;
}
function candidates(input: string): readonly Candidate[] {
	const stat = lstatSync(input);
	const classify = (path: string, kind: "file" | "dir" | "link" | "other"): Candidate => ({
		path,
		problem:
			kind === "link"
				? "rejected: symlinks are not followed"
				: kind !== "file"
					? "rejected: not a regular file"
					: /\.pdf$/iu.test(path)
						? null
						: "rejected: unsupported_format (only .pdf is supported; EPUB is deferred)",
	});
	const kindOf = (s: { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean }) =>
		s.isSymbolicLink() ? "link" : s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";
	if (!stat.isDirectory()) return [classify(input, kindOf(stat))];
	return readdirSync(input, { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.filter((entry) => !entry.name.startsWith("."))
		.map((entry) =>
			entry.isDirectory()
				? { path: join(input, entry.name), problem: "skipped: subdirectories are not traversed" }
				: classify(join(input, entry.name), kindOf(entry)),
		);
}

async function ingest(io: CliIo, info: Environment, input: string | undefined): Promise<number> {
	if (!input) {
		io.stderr("ingest requires --input <pdf-or-directory>\n");
		return 2;
	}
	const values = merged(info);
	const directory = values.BOOKS_DATA_DIR;
	if (!directory?.trim()) {
		io.stderr("Missing BOOKS_DATA_DIR (private local store directory outside the checkout)\n");
		return 1;
	}
	let list: readonly Candidate[];
	try {
		list = candidates(resolve(io.cwd, input));
	} catch {
		io.stderr(`Cannot read input: ${basename(input)}\n`);
		return 1;
	}
	let store: CorpusStore;
	try {
		store = new CorpusStore({ directory });
	} catch (error) {
		io.stderr(`Cannot open the local store: ${describe(error)}\n`);
		return 1;
	}
	const counts = { ingested: 0, alreadyPresent: 0, rejected: 0, failed: 0, skipped: 0 };
	for (const item of list) {
		const name = basename(item.path);
		if (item.problem) {
			io.stdout(`${name}: ${item.problem}\n`);
			if (item.problem.startsWith("skipped")) counts.skipped++;
			else counts.rejected++;
			continue;
		}
		try {
			const hash = sha256(readLocalPdf(item.path, pdfLimits.inputBytes));
			const existing = store.listVersions().find((v) => v.sourceHash === hash);
			const prepared = await ingestPdf({
				store,
				input: item.path,
				bookId: existing?.bookId ?? store.newBookId(),
				indexConfigurationHash: ingestConfigurationHash,
			});
			const { imported } = await publishIngest(prepared, store, chunkOptions);
			const { coverage } = prepared.source;
			counts[imported ? "ingested" : "alreadyPresent"]++;
			io.stdout(
				`${name}: ${imported ? "ingested" : "already ingested"} (${prepared.source.pageCount} PDF pages, extraction ${coverage.status}${coverage.gaps.length ? `, ${coverage.gaps.length} gap page(s)` : ""})\n`,
			);
		} catch (error) {
			counts.failed++;
			io.stdout(`${name}: failed: ${describe(error)}\n`);
		}
	}
	io.stdout(
		`Summary: ${counts.ingested} ingested, ${counts.alreadyPresent} already present, ${counts.rejected} rejected, ${counts.skipped} skipped, ${counts.failed} failed.\n`,
	);
	if (counts.ingested + counts.alreadyPresent > 0)
		io.stdout("Next: run `books-rag index` to publish (single writer).\n");
	io.stdout(`${originalsNote}\n`);
	return counts.rejected || counts.failed || !list.length ? 1 : 0;
}

async function index(io: CliIo, info: Environment): Promise<number> {
	let config: BooksConfig;
	const values = merged(info);
	try {
		config = loadConfig({ env: values });
	} catch (error) {
		io.stderr(`Configuration: ${describe(error)}. Run \`doctor\` for the full list.\n`);
		return 1;
	}
	try {
		const store = new CorpusStore({ directory: config.dataDirectory });
		if (!store.listVersions().length) {
			io.stderr("The local store has no ingested books; run `ingest --input <path>` first.\n");
			return 1;
		}
		const { objects, pinecone, embeddings } = servicesFromConfig(config, values as NodeJS.ProcessEnv);
		const catalog = await indexCorpus({ store, objects, pinecone, embeddings, writerId: store.libraryId });
		const passages = catalog.versions.reduce((n, v) => n + Object.keys(v.passages).length, 0);
		const figures = catalog.versions.reduce((n, v) => n + v.figures.length, 0);
		io.stdout(
			`Indexed ${catalog.versions.length} book(s), ${passages} passage(s), ${figures} figure(s). Catalog commit ${catalog.commit}.\n`,
		);
		io.stdout(`${originalsNote}\n`);
		return 0;
	} catch (error) {
		io.stderr(`index failed: ${describe(error)}\n`);
		return 1;
	}
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
	let parsed: ReturnType<typeof parseCli>;
	try {
		parsed = parseCli(argv);
	} catch (error) {
		io.stderr(`${error instanceof Error ? error.message : "Invalid arguments"}\n\n${usage}\n`);
		return 2;
	}
	const { values, positionals } = parsed;
	const command = positionals[0];
	if (values.help || !command) {
		io.stdout(`${usage}\n`);
		return values.help || !argv.length ? 0 : 2;
	}
	if (positionals.length > 1) {
		io.stderr(`Unexpected argument: ${positionals[1]}\n`);
		return 2;
	}
	const info = environment(io, values["env-file"]);
	try {
		if (command === "doctor") return await doctor(io, info);
		if (command === "ingest") return await ingest(io, info, values.input);
		if (command === "index") return await index(io, info);
		if (command === "evaluate") {
			if (!values.synthetic) {
				io.stderr("evaluate requires --synthetic (the live evaluation is not part of this CLI)\n");
				return 2;
			}
			const result = await evaluateSynthetic();
			io.stdout(`${JSON.stringify(result, null, 2)}\n`);
			return result.passed ? 0 : 1;
		}
	} catch (error) {
		io.stderr(`${command} failed: ${describe(error)}\n`);
		return 1;
	}
	io.stderr(`Unknown command: ${command}\n\n${usage}\n`);
	return 2;
}
function parseCli(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			help: { type: "boolean", short: "h" },
			input: { type: "string" },
			synthetic: { type: "boolean" },
			"env-file": { type: "string" },
		},
	});
}

if (import.meta.main)
	process.exitCode = await runCli(process.argv.slice(2), {
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		env: process.env,
		cwd: process.cwd(),
	});
