/** Optional local FTS is deliberately disabled for hosted-corpus v1.
 * Problem: lexical-only candidates cannot bypass hosted provenance/relevance.
 * Example: a shared identifier in an unrelated subsection boosts overlap without
 * proving support. Solution: retain dense-only ranking until a measured comparison
 * shows exact-identifier gains without abstention regressions. search.test.ts
 * records this ambiguity; T8 measures retrieval without a local cache. An empty
 * second machine must not have different evidence rules from the writer.
 * No FTS database is created implicitly and no local original is needed. */
export const lexicalPolicy = Object.freeze({
	enabled: false,
	reason:
		"No evaluated exact-identifier ranking gain without abstention regression; local FTS remains optional and disabled",
});
