(() => {
	const dialog = document.createElement("dialog");
	dialog.id = "factory-dialog";
	dialog.setAttribute("aria-labelledby", "factory-title");
	// This template is static. Workflow definitions and worker output are assigned as text or form values.
	dialog.innerHTML = `
<header class="factory-head"><h2 id="factory-title">Factory</h2><form method="dialog"><button type="submit" class="icon-button" aria-label="Close factory">×</button></form></header>
<div class="factory-layout">
	<aside class="factory-library" aria-label="Workflow library">
		<label for="factory-project">Project</label><select id="factory-project"></select>
		<h3>Workflows</h3><button id="factory-new" type="button">+ New workflow</button>
		<nav id="factory-list" aria-label="Project workflows"></nav>
	</aside>
	<div class="factory-work">
		<p id="factory-status" role="status" aria-live="polite"></p>
		<h3 id="factory-heading">New workflow</h3>
		<form id="factory-editor"><fieldset id="factory-fields"><legend class="visually-hidden">Workflow draft</legend>
			<label for="factory-name">Name</label><input id="factory-name" required maxlength="100" autocomplete="off">
			<label for="factory-agent">Agent</label><select id="factory-agent" required></select>
			<label for="factory-instructions">Instructions</label><textarea id="factory-instructions" required maxlength="6000" rows="4"></textarea>
			<h4>Test cases</h4><p class="factory-help">A case passes when the response contains the expected text, matching capitalization.</p>
			<div id="factory-cases"></div>
			<div class="factory-actions"><button id="factory-add" type="button">Add case</button><button class="factory-primary" id="factory-save" type="submit">Save draft</button></div>
		</fieldset></form>
		<section id="factory-validation" hidden><h4>Evaluate and publish</h4><p id="factory-eval-info"></p>
			<div class="factory-actions"><button id="factory-evaluate" type="button">Evaluate saved draft</button><button id="factory-publish" type="button">Publish</button><button id="factory-reload" type="button" hidden>Reload saved draft</button></div>
			<div id="factory-results"></div>
		</section>
		<form id="factory-production" hidden><h4 id="factory-run-label">Run published workflow</h4>
			<label for="factory-input">Run input</label><textarea id="factory-input" required maxlength="6000" rows="3"></textarea>
			<button class="factory-primary" id="factory-run" type="submit">Run workflow</button><span id="factory-output"></span>
		</form>
		<details id="factory-history" hidden><summary>Version and run history</summary><div id="factory-records"></div></details>
	</div>
</div>`;
	document.body.append(dialog);
	const el = (name) => document.getElementById(`factory-${name}`);
	const openButton = document.getElementById("open-factory");
	const localDrafts = new Map();
	const runInputs = new Map();
	const pending = new Map();
	const utf8 = new TextEncoder();
	let project = "";
	let id = null;
	let detail;
	let list = [];
	let editBase;
	let dirty = false;
	let pendingAction = false;
	let loading = false;
	let loadFailed = false;
	let page = 0;
	let timer;
	function node(tag, text) {
		const el = document.createElement(tag);
		if (text !== undefined) el.textContent = text;
		return el;
	}
	function key() {
		return JSON.stringify([project, id]);
	}
	function selectCases() {
		return [...el("cases").children];
	}
	function formDefinition() {
		return {
			name: el("name").value,
			instructions: el("instructions").value,
			agent: el("agent").value,
			cases: selectCases().map((row) => ({
				input: row.querySelector("[data-input]").value,
				expected: row.querySelector("[data-expected]").value,
			})),
		};
	}
	function stash() {
		if (!project || loading || loadFailed) return;
		if (dirty) localDrafts.set(key(), { base: editBase, values: formDefinition() });
		runInputs.set(key(), el("input").value);
	}
	function inform(text) {
		el("status").textContent = text;
	}
	function caseRow(value) {
		const row = node("fieldset");
		row.className = "factory-case";
		row.append(node("legend"));
		for (const [field, label, max] of [
			["input", "Input", 3000],
			["expected", "Expected text", 1000],
		]) {
			const wrapper = node("label", label);
			const input = node("textarea");
			input.dataset[field] = "";
			input.maxLength = max;
			input.rows = 2;
			input.required = true;
			input.value = value[field];
			wrapper.append(input);
			row.append(wrapper);
		}
		const remove = node("button", "Remove case");
		remove.type = "button";
		remove.addEventListener("click", () => {
			row.remove();
			changed();
		});
		row.append(remove);
		el("cases").append(row);
	}
	function syncButtons() {
		const blocked = pendingAction || loading || loadFailed || !project;
		const cases = selectCases();
		el("fields").disabled = blocked;
		for (let i = 0; i < cases.length; i++) {
			cases[i].querySelector("legend").textContent = `Case ${i + 1}`;
			const remove = cases[i].querySelector("button");
			remove.disabled = cases.length === 1;
			remove.setAttribute("aria-label", `Remove case ${i + 1}`);
		}
		el("add").disabled = cases.length >= 8;
		el("new").disabled = pendingAction || loading || !project;
		el("project").disabled = pendingAction;
		for (const button of el("list").querySelectorAll("button")) button.disabled = pendingAction;
		const evaluation = detail?.evaluations.find((e) => e.revision === detail.head);
		el("save").disabled = blocked || (id && !dirty) || (id && editBase !== detail?.head);
		el("evaluate").disabled = blocked || dirty || evaluation?.status === "running";
		el("publish").disabled = blocked || dirty || evaluation?.status !== "passed" || detail?.published === detail?.head;
		el("reload").hidden = !detail || !dirty;
		el("reload").disabled = blocked;
		el("run").disabled = blocked || !detail?.published;
		el("input").disabled = blocked;
		if (detail)
			el("eval-info").textContent = dirty
				? editBase === detail.head
					? "Save your edits before evaluating them."
					: "The saved workflow changed. Copy any edits you need, then reload the saved draft."
				: `Saved v${detail.head} · ${evaluation ? `Evaluation ${evaluation.status}` : "Awaiting evaluation"}`;
	}
	function changed() {
		dirty = true;
		stash();
		syncButtons();
	}
	function linkToChat(chatId, text) {
		const link = node("a", text);
		link.href = `#${new URLSearchParams({ chat: chatId })}`;
		link.addEventListener("click", (e) => {
			if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
			e.preventDefault();
			dialog.close();
			navigate(chatId);
		});
		return link;
	}
	function drawList() {
		el("list").replaceChildren();
		if (!list.length) {
			el("list").append(node("p", "No saved workflows."));
			return;
		}
		for (const flow of list) {
			const button = node("button");
			button.type = "button";
			button.append(
				node("strong", flow.name),
				node("small", flow.published ? `Published v${flow.published}` : `Draft v${flow.head}`),
			);
			if (flow.id === id) button.setAttribute("aria-current", "true");
			button.addEventListener("click", () => {
				if (flow.id !== id) void choose(flow.id);
			});
			el("list").append(button);
		}
	}
	function editor() {
		const draft = localDrafts.get(key());
		const saved = detail?.revisions.find((r) => r.revision === detail.head);
		const values = draft?.values ?? saved;
		editBase = draft ? draft.base : detail?.head;
		dirty = Boolean(draft);
		el("heading").textContent = detail ? detail.name : "New workflow";
		el("name").value = values?.name ?? "";
		el("instructions").value = values?.instructions ?? "";
		const agents = [...document.getElementById("agent").options]
			.filter((a) => !a.dataset.archived)
			.map((a) => new Option(a.text, a.value));
		if (values?.agent && !agents.some((a) => a.value === values.agent))
			agents.push(new Option(values.agent, values.agent));
		el("agent").replaceChildren(...agents);
		el("agent").value = values?.agent ?? (agents.some((a) => a.value === "codex") ? "codex" : (agents[0]?.value ?? ""));
		el("cases").replaceChildren();
		for (const c of values?.cases ?? [{ input: "", expected: "" }]) caseRow(c);
		el("input").value = runInputs.get(key()) ?? "";
		el("output").replaceChildren();
		el("history").open = false;
	}
	function records() {
		el("validation").hidden = !detail;
		el("production").hidden = !detail?.published;
		el("history").hidden = !detail;
		if (!detail) return;
		const current = detail.evaluations.find((e) => e.revision === detail.head);
		el("run-label").textContent = `Run published v${detail.published}`;
		el("results").replaceChildren();
		if (current)
			current.cases.forEach((result, i) => {
				const item = node("details");
				item.append(
					node("summary", `Case ${i + 1} · ${result.status}`),
					node("strong", "Input"),
					node("pre", result.input),
					node("strong", "Expected text"),
					node("pre", result.expected),
				);
				if (result.actual !== undefined) item.append(node("strong", "Actual response"), node("pre", result.actual));
				if (result.chatId) item.append(linkToChat(result.chatId, "Open test chat"));
				el("results").append(item);
			});
		const history = el("records");
		history.replaceChildren();
		for (const revision of detail.revisions) {
			const version = node("details");
			const at = new Date(revision.createdAt).toLocaleString();
			version.append(
				node("summary", `v${revision.revision} · ${revision.name} · ${at}`),
				node("p", `Agent: ${revision.agent}`),
				node("pre", revision.instructions),
			);
			for (const c of revision.cases)
				version.append(node("p", `Test input: ${c.input}`), node("p", `Expected text: ${c.expected}`));
			for (const e of detail.evaluations.filter((e) => e.revision === revision.revision)) {
				version.append(node("p", `Evaluation ${e.status} · ${new Date(e.createdAt).toLocaleString()}`));
				for (const [i, c] of e.cases.entries()) version.append(linkToChat(c.chatId, `Case ${i + 1} · ${c.status}`));
			}
			for (const p of detail.publications.filter((p) => p.revision === revision.revision))
				version.append(node("p", `Published ${new Date(p.createdAt).toLocaleString()}`));
			for (const r of detail.runs.filter((r) => r.revision === revision.revision))
				version.append(linkToChat(r.chatId, `Run · ${new Date(r.createdAt).toLocaleString()}`));
			history.append(version);
		}
	}
	function getDetail() {
		return api(`/api/factory?${new URLSearchParams({ project, id })}`);
	}
	function poll() {
		clearTimeout(timer);
		if (!dialog.open || !detail?.evaluations.some((e) => e.status === "running")) return;
		const version = page;
		timer = setTimeout(async () => {
			if (!dialog.open || version !== page || pendingAction) return;
			try {
				const next = await getDetail();
				if (version !== page || !dialog.open || pendingAction) return;
				const oldHead = detail.head;
				detail = next;
				if (next.head !== oldHead && !dirty) editor();
				records();
				syncButtons();
			} catch {
				if (version === page) inform("Could not refresh the evaluation. Retrying.");
			}
			if (version === page) poll();
		}, 1800);
	}
	async function choose(nextId, nextProject = project, reloadList = false) {
		stash();
		const version = ++page;
		clearTimeout(timer);
		project = nextProject;
		id = nextId;
		detail = undefined;
		loading = true;
		loadFailed = false;
		if (reloadList) list = [];
		el("fields").disabled = true;
		records();
		drawList();
		syncButtons();
		inform("Loading workflows…");
		try {
			if (!project) throw new Error("Configure a project to use Factory.");
			if (reloadList) {
				const result = await api(`/api/factory?${new URLSearchParams({ project })}`);
				if (version !== page) return;
				list = result;
				if (id && !list.some((r) => r.id === id)) id = null;
				if (!id && !localDrafts.has(key())) id = list[0]?.id ?? null;
			}
			if (id) {
				const next = await getDetail();
				if (version !== page) return;
				detail = next;
			}
			editor();
			records();
			drawList();
			inform("");
		} catch (error) {
			if (version !== page) return;
			loadFailed = true;
			inform(error.message);
			return;
		} finally {
			if (version === page) {
				loading = false;
				syncButtons();
				poll();
			}
		}
	}
	function bytes(value, limit, name) {
		if (utf8.encode(value).length > limit) throw new Error(`${name} exceeds ${limit} UTF-8 bytes.`);
	}
	async function mutate(action) {
		if (!project || pendingAction || loading || loadFailed) return;
		const version = page;
		pendingAction = true;
		clearTimeout(timer);
		syncButtons();
		try {
			const base = { project, id };
			let body;
			let retryKey;
			if (action === "save") {
				const definition = formDefinition();
				bytes(definition.name, 100, "Name");
				bytes(definition.instructions, 6000, "Instructions");
				for (const c of definition.cases) {
					bytes(c.input, 3000, "Case input");
					bytes(c.expected, 1000, "Expected text");
				}
				body = { ...base, ...definition, ...(id && { baseRevision: editBase }) };
			} else {
				const revision = action === "run" ? detail.published : detail.head;
				body = { ...base, revision };
				if (action === "run") {
					body.input = el("input").value;
					bytes(body.input, 6000, "Run input");
				}
				if (action === "run" || action === "evaluate") {
					retryKey = JSON.stringify([action, project, id, revision, body.input]);
					if (!pending.has(retryKey)) pending.set(retryKey, crypto.randomUUID());
					body.requestId = pending.get(retryKey);
				}
			}
			inform(action === "run" ? "Starting run…" : "Saving request…");
			const result = await api(`/api/factory/${action}`, body);
			if (retryKey) pending.delete(retryKey);
			if (version !== page) return;
			if (action === "run") {
				el("output").replaceChildren(linkToChat(result.chatId, "Open output chat"));
				inform(`Started a run of v${result.revision}.`);
				try {
					const next = await getDetail();
					if (version === page) {
						detail = next;
						records();
					}
				} catch {
					/* The output chat already exists. */
				}
			} else {
				if (action === "save") {
					localDrafts.delete(key());
					id = result.id;
					detail = result;
					editor();
				} else detail = result;
				list = [detail, ...list.filter((r) => r.id !== detail.id)];
				drawList();
				records();
				inform(
					action === "save"
						? `Saved v${detail.head}.`
						: action === "publish"
							? `Published v${detail.published}.`
							: "Evaluation submitted.",
				);
			}
		} catch (error) {
			if (version === page) inform(error.status ? error.message : error.message || "Request failed. Try again.");
		} finally {
			pendingAction = false;
			syncButtons();
			poll();
		}
	}
	el("editor").addEventListener("input", changed);
	el("editor").addEventListener("submit", (e) => {
		e.preventDefault();
		void mutate("save");
	});
	el("production").addEventListener("submit", (e) => {
		e.preventDefault();
		void mutate("run");
	});
	el("add").addEventListener("click", () => {
		if (selectCases().length < 8) {
			caseRow({ input: "", expected: "" });
			changed();
			selectCases().at(-1).querySelector("textarea").focus();
		}
	});
	el("evaluate").addEventListener("click", () => void mutate("evaluate"));
	el("publish").addEventListener("click", () => void mutate("publish"));
	el("reload").addEventListener("click", () => {
		dirty = false;
		localDrafts.delete(key());
		void choose(id);
	});
	el("new").addEventListener("click", () => void choose(null));
	el("project").addEventListener("change", () => void choose(null, el("project").value, true));
	function openFactory() {
		if (dialog.open) return;
		closeNav();
		const options = [...document.getElementById("memory-project").options];
		el("project").replaceChildren(...options.map((o) => new Option(o.text, o.value)));
		const current = document.getElementById("project").value;
		const next = options.some((o) => o.value === current) ? current : (options[0]?.value ?? "");
		el("project").value = next;
		dialog.showModal();
		void choose(next === project ? id : null, next, true);
	}
	openButton.addEventListener("click", openFactory);
	function fromAddress() {
		if (location.hash === "#factory" && config) openFactory();
	}
	window.addEventListener("hashchange", fromAddress);
	const configured = new MutationObserver(() => {
		if (config) {
			configured.disconnect();
			fromAddress();
		}
	});
	configured.observe(document.getElementById("header-host"), { childList: true });
	fromAddress();
	dialog.addEventListener("close", () => {
		if (location.hash === "#factory") history.replaceState(null, "", location.pathname + location.search);
		stash();
		clearTimeout(timer);
	});
})();
