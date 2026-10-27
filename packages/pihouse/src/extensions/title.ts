export interface TitleDependencies {
	depth: number;
	session: () => string;
	current: () => string | undefined;
	owned: () => boolean;
	set: (name: string) => void;
	generate: (prompt: string, current: string | undefined) => Promise<string | undefined>;
	now: () => number;
}

/** One bounded, isolated decision at a time; newer input invalidates an in-flight decision. */
export function createTitleController(deps: TitleDependencies) {
	let revision = 0;
	let prompt = "";
	let lastAttempt = -Infinity;
	let pending = false;
	return {
		input(text: string) {
			revision++;
			prompt = text.slice(0, 2000);
		},
		invalidate() {
			revision++;
			prompt = "";
		},
		async settled() {
			const current = deps.current();
			if (deps.depth > 0 || !prompt.trim() || pending || (current && !deps.owned())) return;
			const now = deps.now();
			if (now - lastAttempt < 60_000) return;
			lastAttempt = now;
			pending = true;
			const started = revision;
			const session = deps.session();
			try {
				const title = await deps.generate(prompt, current);
				if (started !== revision || session !== deps.session() || deps.current() !== current) return;
				if (current && !deps.owned()) return;
				const cleaned = title
					?.split("")
					.map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
					.join("")
					.replace(/\s+/g, " ")
					.trim();
				if (cleaned && cleaned.length <= 60) deps.set(cleaned);
			} catch {
				// Provider failure leaves the user's existing name untouched.
			} finally {
				pending = false;
			}
		},
	};
}
