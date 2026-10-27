import { pdfFixture } from "./fixtures.ts";

/** Authored synthetic evidence, never copied from a book. Queries/labels are not
 * available to the fake embedding function or the candidate server. */
export const topics = [
	["embedding_vectors", "preserves source identifiers and citation coordinates"],
	["retry_budget", "bounds transient failures and request attempts"],
	["generation_marker", "isolates completed publications and immutable versions"],
	["private_canary", "checks anonymous refusal before authenticated storage"],
	["table_header", "retains column units and uncertain cell relationships"],
	["source_digest", "detects changed originals and rejects stale evidence"],
	["query_prefix", "separates query representations from document representations"],
	["figure_link", "resolves explicit captions across physical page boundaries"],
	["unicode_boundary", "preserves scalar offsets through normalized mappings"],
	["queue_limit", "bounds waiting requests and rejects excess concurrency"],
	["namespace_filter", "restricts vector operations to dedicated library records"],
	["continuation_cursor", "returns bounded literal text without losing citations"],
] as const;

const spanishQuestions = [
	"¿Cómo preserva embedding_vectors los identificadores y las coordenadas de citas? Figura 1-1.",
	"¿Cómo limita retry_budget los fallos transitorios y los intentos? Figura 1-2.",
	"¿Cómo aísla generation_marker las publicaciones completas y las versiones inmutables?",
	"¿Cómo comprueba private_canary el rechazo anónimo antes del almacenamiento autenticado?",
	"¿Cómo conserva table_header las unidades y las relaciones inciertas entre celdas?",
	"¿Cómo detecta source_digest los originales cambiados y rechaza la evidencia obsoleta?",
	"¿Cómo separa query_prefix las representaciones de consultas y documentos?",
	"¿Cómo resuelve figure_link los pies explícitos entre páginas físicas?",
	"¿Cómo preserva unicode_boundary los desplazamientos escalares mediante mapeos normalizados?",
	"¿Cómo limita queue_limit las solicitudes en espera y rechaza la concurrencia excesiva?",
	"¿Cómo restringe namespace_filter las operaciones vectoriales a los registros de la biblioteca?",
	"¿Cómo devuelve continuation_cursor texto literal acotado sin perder citas?",
];
export const answerableCases = topics.flatMap(([identifier, statement], index) => {
	const evidence = `${identifier} ${statement}.${index < 2 ? ` See Figure 1-${index + 1}.` : ""}`;
	// Authored 12pt rows at y=610/550 on an 800pt PDF page.
	const span = { page: index + 1, topCoordinates: [178, 238] };
	return [
		{
			id: `${identifier}-exact`,
			span,
			query: evidence,
			page: index + 1,
			evidence,
			figure: index < 2 ? `Figure 1-${index + 1}` : null,
			spanish: null,
		},
		{
			id: `${identifier}-english`,
			span,
			query: `How does ${identifier} ${statement.replace(/^(\w+)s\b/u, "$1")}?${index < 2 ? ` Figure 1-${index + 1}.` : ""}`,
			page: index + 1,
			evidence,
			figure: index < 2 ? `Figure 1-${index + 1}` : null,
			spanish: spanishQuestions[index] ?? null,
		},
	];
});
export const unrelatedCases = [
	"When do lunar eclipses occur?",
	"How are sourdough pancakes cooked?",
	"Where do emperor penguins nest?",
	"Who painted Renaissance frescoes?",
	"What causes volcanic basalt?",
	"How does a violin resonate?",
	"When did ancient Rome fall?",
	"Which orchids tolerate frost?",
	"How are mortgage rates calculated?",
	"Why do marathon runners hydrate?",
];
export function evaluationPdf(): Uint8Array {
	return pdfFixture({
		title: "Synthetic pipeline evaluation v1",
		pages: topics.map(([identifier, statement], index) => ({
			geometry: [1000, 800] as const,
			text: [
				...(index > 0 && index <= 2 ? [{ text: `Figure 1-${index}. Synthetic vector diagram.`, y: 750 }] : []),
				{ text: identifier, y: 650, size: 18 },
				{ text: `${identifier} ${statement}.${index < 2 ? ` See Figure 1-${index + 1}.` : ""}`, y: 610 },
				{ text: `${identifier} ${statement}.${index < 2 ? ` See Figure 1-${index + 1}.` : ""}`, y: 550 },
			],
		})),
	});
}
