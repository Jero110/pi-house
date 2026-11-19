if (new URLSearchParams(location.hash.slice(1)).has("pair")) history.replaceState(null, "", location.pathname);
const byId = (id) => document.getElementById(id);
const agentLabels = { pi: "pi", codex: "Codex", claude: "Claude" };
const states = {
	queued: "Queued",
	running: "Working",
	ready: "Ready",
	completed: "Completed",
	failed: "Failed",
	interrupted: "Interrupted",
};
const drafts = new Map();
const hostOrigins = new Set();
let config;
let selected = chatFromAddress();
let chat;
let chats = [];
let loadVersion = 0;
let sending = false;
let timer;
let listFingerprint;
let messageFingerprint;
let connectionFailed = false;
let eventFingerprint;
let artifactFingerprint;
let liveFingerprint;
let previewId = "";
let previewRequest;
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function timestamp(at) {
	if (!Number.isFinite(at)) return null;
	const date = new Date(at);
	if (!Number.isFinite(date.getTime())) return null;
	const node = element("time", timeFormat.format(date));
	node.dateTime = date.toISOString();
	return node;
}

function drawEvents(events = []) {
	const fingerprint = JSON.stringify(events);
	if (eventFingerprint === fingerprint) return;
	eventFingerprint = fingerprint;
	byId("activity").hidden = !events.length;
	byId("event-count").textContent = String(events.length);
	byId("event-list").replaceChildren(
		...events.map((event) => {
			const row = element("li");
			const header = element("div", undefined, "event-head");
			const label = event.type.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
			header.append(
				element(
					"strong",
					[event.actor, label].filter(Boolean).join(" · "),
					event.type === "failed" ? "event-error" : "",
				),
			);
			const time = timestamp(event.at);
			if (time) header.append(time);
			row.append(header, element("p", event.text));
			return row;
		}),
	);
}

function drawLiveActivity(events = []) {
	const latest = new Map();
	if (busy()) for (const event of events) latest.set(event.actor || "", event);
	const current = Array.from(latest.values());
	const fingerprint = JSON.stringify(current);
	if (liveFingerprint === fingerprint) return;
	liveFingerprint = fingerprint;
	byId("live-activity").hidden = !current.length;
	byId("live-list").replaceChildren(
		...current.map((event) => {
			const row = element("li");
			if (event.actor) row.append(element("strong", event.actor));
			row.append(element("span", event.text));
			const time = timestamp(event.at);
			if (time) row.append(time);
			return row;
		}),
	);
}
function fileSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function clearPreview() {
	previewRequest?.abort();
	previewRequest = undefined;
	previewId = "";
	byId("artifact-preview").hidden = true;
	byId("preview-body").replaceChildren();
	byId("download-artifact").removeAttribute("href");
}

async function previewArtifact(file) {
	clearPreview();
	previewId = file.id;
	for (const button of byId("artifact-list").children)
		button.setAttribute("aria-pressed", String(button.dataset.file === file.id));
	const path = `/api/chats/${encodeURIComponent(chat.id)}/artifacts/${encodeURIComponent(file.id)}`;
	const link = byId("download-artifact");
	link.href = path;
	link.download = file.name;
	byId("artifact-preview").hidden = false;
	byId("preview-title").textContent = file.name;
	const body = byId("preview-body");
	const url = `${path}?preview=1`;
	if (file.type === "image") {
		const img = element("img");
		img.alt = file.name;
		img.addEventListener("error", () => {
			if (body.contains(img)) body.textContent = "Image preview unavailable. Download the original to open it.";
		});
		img.src = url;
		body.replaceChildren(img);
		return;
	}
	if (file.type !== "text") {
		body.textContent = "Download this file to open it.";
		return;
	}
	const request = new AbortController();
	previewRequest = request;
	body.textContent = "Loading preview…";
	try {
		const response = await fetch(url, {
			credentials: "same-origin",
			mode: "same-origin",
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
		});
		if (response.status === 401) {
			location.replace("/");
			return;
		}
		if (!response.ok || response.headers.get("Content-Type")?.split(";")[0].trim() !== "text/plain")
			throw new Error("Preview unavailable");
		const text = await response.text();
		if (!request.signal.aborted) body.replaceChildren(element("pre", text));
	} catch {
		if (!request.signal.aborted) body.textContent = "Text preview unavailable. Download the original to open it.";
	}
}

function drawArtifacts(files = []) {
	const fingerprint = JSON.stringify(files);
	if (artifactFingerprint === fingerprint) return;
	artifactFingerprint = fingerprint;
	const valid = files.filter((file) => file.id && file.id !== "." && file.id !== "..");
	byId("open-artifacts").hidden = !valid.length;
	byId("artifact-count").textContent = String(valid.length);
	const focusId = document.activeElement?.dataset.file;
	const buttons = valid.map((file) => {
		const button = element("button", undefined, "artifact-file");
		button.type = "button";
		button.dataset.file = file.id;
		button.setAttribute("aria-pressed", String(previewId === file.id));
		const label = file.type === "text" ? "Text" : file.type === "image" ? "Image" : "File";
		const versions = valid.filter((other) => other.name === file.name);
		const info = [label, fileSize(file.size)];
		if (versions.length > 1) info.push(`Version ${versions.indexOf(file) + 1} of ${versions.length}`);
		button.append(element("strong", file.name), element("small", info.join(" · ")));
		button.addEventListener("click", () => {
			void previewArtifact(file);
		});
		return button;
	});
	byId("artifact-list").replaceChildren(...buttons);
	buttons.find((button) => button.dataset.file === focusId)?.focus();
	if (!valid.some((file) => file.id === previewId)) clearPreview();
	if (!valid.length && byId("artifacts-dialog").open) byId("artifacts-dialog").close();
}

function chatFromAddress() {
	return new URLSearchParams(location.hash.slice(1)).get("chat") || "";
}

function element(tag, text, className) {
	const node = document.createElement(tag);
	if (text !== undefined) node.textContent = text;
	if (className) node.className = className;
	return node;
}

function notice(id, text = "") {
	const node = byId(id);
	if (node.textContent !== text) node.textContent = text;
	node.hidden = !text;
}

function busy() {
	return chat?.status === "running" || chat?.status === "queued";
}

function controls() {
	const waiting = selected && !chat;
	const lock = sending || !config || waiting;
	byId("project").disabled = !!(lock || selected);
	byId("agent").disabled = !!(lock || selected);
	byId("host").disabled = sending || !hostOrigins.size;
	byId("new-chat").disabled = sending;
	const available = !lock && byId("project").value && byId("agent").value;
	const input = byId("message");
	input.disabled = sending;
	byId("send").disabled = !!(!available || busy() || !input.value.trim());
	let status = "Ready to send";
	if (!config) status = "Connecting…";
	else if (sending) status = "Sending…";
	else if (waiting) status = "Loading chat…";
	else if (connectionFailed) status = "Reconnecting…";
	else if (!available) status = "Configure a project and an agent on this host to begin.";
	else if (chat?.status === "queued") status = "Queued on this host…";
	else if (busy()) status = `${agentLabels[chat.agent] || chat.agent} is working…`;
	if (byId("composer-status").textContent !== status) byId("composer-status").textContent = status;
}

async function api(path, body) {
	const response = await fetch(path, {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		mode: "same-origin",
		redirect: "error",
		cache: "no-store",
		signal: AbortSignal.timeout(20000),
		...(body && {
			headers: { "Content-Type": "application/json", "X-Pih-Request": "chat" },
			body: JSON.stringify(body),
		}),
	});
	if (response.status === 401) {
		location.replace("/");
		throw new Error("Pair this browser again.");
	}
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		const error = new Error(typeof data.error === "string" ? data.error : `Request failed (HTTP ${response.status}).`);
		error.status = response.status;
		throw error;
	}
	return response.json();
}

function applyConfig(value) {
	config = value;
	const hosts = byId("host");
	hosts.replaceChildren(new Option(value.host, ""));
	byId("sidebar-host").textContent = value.host;
	byId("header-host").textContent = value.host;
	for (const peer of value.peers || []) {
		let url;
		try {
			url = new URL(peer.url);
		} catch {
			continue;
		}
		if (url.protocol !== "https:" || !url.hostname.endsWith(".ts.net") || url.username || url.password) continue;
		if (url.origin === location.origin || hostOrigins.has(url.origin)) continue;
		hostOrigins.add(url.origin);
		hosts.add(new Option(peer.label, url.origin));
	}
	byId("project").replaceChildren(...value.projects.map((name) => new Option(name, name)));
	byId("agent").replaceChildren(...value.agents.map((name) => new Option(agentLabels[name] || name, name)));
	if (value.agents.includes("codex")) byId("agent").value = "codex";
}

function selectContext(id, value) {
	const select = byId(id);
	if (value && !Array.from(select.options).some((option) => option.value === value)) {
		// A saved chat can refer to a project that has since been removed from host configuration.
		const option = new Option(value, value);
		option.dataset.archived = "true";
		select.add(option);
	}
	select.value = value;
}

function drawList() {
	const fingerprint = JSON.stringify([selected, chats]);
	if (fingerprint === listFingerprint) return;
	listFingerprint = fingerprint;
	const nav = byId("recents");
	const focus = nav.contains(document.activeElement) ? document.activeElement.dataset.chat : null;
	const items = chats.map((item) => {
		const button = element("button", undefined, "recent");
		button.type = "button";
		button.dataset.chat = item.id;
		if (item.id === selected) button.setAttribute("aria-current", "page");
		button.append(element("strong", item.title || "Untitled chat"));
		const details = [agentLabels[item.agent] || item.agent, item.project];
		if (["running", "queued", "failed", "interrupted"].includes(item.status)) details.push(states[item.status]);
		button.append(element("small", details.join(" · ")));
		button.addEventListener("click", () => navigate(item.id));
		return button;
	});
	nav.replaceChildren(...(items.length ? items : [element("p", "Your chats will appear here.", "empty-list")]));
	if (focus) items.find((button) => button.dataset.chat === focus)?.focus();
}

function openArtifacts(files = []) {
	const dialog = byId("artifacts-dialog");
	dialog.showModal();
	byId("close-artifacts").focus();
	if (files.length === 1) void previewArtifact(files[0]);
	else if (files.length > 1) {
		// The host can capture the same name on several turns; let the reader choose the version.
		clearPreview();
		Array.from(byId("artifact-list").children)
			.find((button) => button.dataset.file === files[0].id)
			?.focus();
	} else byId("artifact-list").firstElementChild?.click();
}

function richParagraph(text, files) {
	const paragraph = element("p");
	const tokens = /(`{1,3})([^`\n]+)\1|\[([^[\]\n]{1,256})\]\(([^()\n]{1,4096})\)/g;
	let end = 0;
	for (const token of text.matchAll(tokens)) {
		paragraph.append(text.slice(end, token.index));
		end = token.index + token[0].length;
		if (token[1]) {
			paragraph.append(element("code", token[2]));
			continue;
		}
		// Only the final filename is a lookup key. The host supplies the preview identity and bytes.
		const rawName = token[4].replace(/^<|>$/g, "").split(/[?#]/, 1)[0].split("/").pop();
		let name = rawName;
		try {
			name = decodeURIComponent(rawName);
		} catch {
			/* Keep malformed escapes literal. */
		}
		const captures = files.filter((file) => file.name === name && file.id && file.id !== "." && file.id !== "..");
		if (!captures.length) {
			paragraph.append(token[0]);
			continue;
		}
		const chip = element("button", name, "artifact-chip");
		chip.type = "button";
		chip.setAttribute("aria-haspopup", "dialog");
		chip.addEventListener("click", () => openArtifacts(captures));
		paragraph.append(chip);
	}
	paragraph.append(text.slice(end));
	return paragraph;
}

function messageBlock(message) {
	const reportedRole = message.kind === "error" ? "error" : message.role;
	const role = ["user", "assistant", "system", "error"].includes(reportedRole) ? reportedRole : "system";
	const article = element("article", undefined, `message ${role}`);
	const author =
		role === "assistant"
			? agentLabels[chat.agent] || chat.agent
			: role === "user"
				? "You"
				: role === "error"
					? "Error"
					: "Host";
	const header = element("div", undefined, "message-head");
	header.append(
		element("h2", message.actor && role === "error" ? `${message.actor} · Error` : message.actor || author),
	);
	const time = timestamp(message.at);
	if (time) header.append(time);
	article.append(header);
	if (role !== "assistant") {
		article.append(element("p", message.text));
		return article;
	}
	let content = article;
	if (message.kind === "plan") {
		const details = element("details", undefined, "planner-notes");
		details.append(element("summary", "Prepared the plan"));
		article.append(details);
		content = details;
	}
	// Code stays literal. Outside a fence only a host-captured file can open a preview.
	const chunks = message.text.split(/^[ \t]*```[\w.+-]*[ \t]*\r?$/m);
	for (const [index, chunk] of chunks.entries()) {
		if (index % 2) {
			const pre = element("pre");
			pre.append(element("code", chunk.replace(/^\n|\n$/g, "")));
			content.append(pre);
		} else if (chunk.trim()) content.append(richParagraph(chunk.trim(), chat.artifacts || []));
	}
	return article;
}

function drawChat(value) {
	chat = value;
	byId("welcome").hidden = true;
	byId("conversation").hidden = false;
	const title = value.title || "Untitled chat";
	byId("chat-title").textContent = title;
	document.title = `${title} · pi-house`;
	const status = states[value.status] || value.status;
	if (byId("chat-state").textContent !== status) byId("chat-state").textContent = status;
	byId("chat-state").dataset.state = value.status;
	const time = timestamp(value.updatedAt);
	const updated = byId("updated-time");
	if (time && updated.firstElementChild?.dateTime !== time.dateTime) updated.replaceChildren("Updated ", time);
	if (!time) updated.replaceChildren();
	drawEvents(value.events);
	drawLiveActivity(value.events);
	drawArtifacts(value.artifacts);
	selectContext("project", value.project);
	selectContext("agent", value.agent);
	const fingerprint = JSON.stringify([value.id, value.messages, artifactFingerprint]);
	if (fingerprint !== messageFingerprint) {
		const area = byId("scroll-area");
		const atEnd = !messageFingerprint || area.scrollHeight - area.scrollTop - area.clientHeight < 70;
		byId("messages").replaceChildren(...value.messages.map(messageBlock));
		messageFingerprint = fingerprint;
		if (atEnd) area.scrollTop = area.scrollHeight;
	}
	controls();
}

function closeNav() {
	if (byId("nav-dialog").open) byId("nav-dialog").close();
}

function displaySelection(id) {
	if (byId("message").value) drafts.set(selected, byId("message").value);
	else drafts.delete(selected);
	selected = id;
	chat = undefined;
	messageFingerprint = undefined;
	byId("activity").open = false;
	byId("updated-time").replaceChildren();
	drawEvents([]);
	drawLiveActivity([]);
	byId("routing").open = false;
	drawArtifacts([]);
	clearPreview();
	loadVersion++;
	clearTimeout(timer);
	byId("message").value = drafts.get(id) || "";
	byId("messages").replaceChildren();
	byId("welcome").hidden = !!id;
	byId("conversation").hidden = !id;
	byId("chat-title").textContent = id ? "Loading chat…" : "";
	byId("chat-state").textContent = "";
	document.title = "Fleet chat · pi-house";
	if (!id) {
		for (const option of document.querySelectorAll("option[data-archived]")) option.remove();
		if (config) {
			byId("project").value = config.projects[0] || "";
			byId("agent").value = config.agents.includes("codex") ? "codex" : config.agents[0] || "";
		}
	}
	notice("error");
	drawList();
	controls();
	closeNav();
}

function navigate(id) {
	if (sending) return;
	if (id !== selected) {
		const hash = id ? `#${new URLSearchParams({ chat: id })}` : "";
		history.pushState(null, "", location.pathname + location.search + hash);
		displaySelection(id);
		void refresh();
	} else closeNav();
	if (!id) byId("message").focus();
}

async function refresh() {
	clearTimeout(timer);
	if (sending) return;
	const version = ++loadVersion;
	try {
		if (!config) {
			const value = await api("/api/config");
			if (version !== loadVersion) return;
			applyConfig(value);
		}
		const [list, detail] = await Promise.all([
			api("/api/chats"),
			selected ? api(`/api/chats/${encodeURIComponent(selected)}`) : null,
		]);
		if (version !== loadVersion) return;
		chats = list;
		drawList();
		connectionFailed = false;
		notice("connection");
		if (detail) drawChat(detail);
	} catch (error) {
		if (version !== loadVersion) return;
		if (selected && error.status === 404) {
			history.replaceState(null, "", location.pathname + location.search);
			displaySelection("");
			notice("error", "This chat is no longer available on this host.");
			void refresh();
			return;
		}
		connectionFailed = true;
		notice("connection", "Couldn’t refresh this host. Reconnecting automatically…");
	} finally {
		if (version === loadVersion) {
			controls();
			timer = setTimeout(refresh, busy() || connectionFailed ? 2500 : 8000);
		}
	}
}

byId("composer").addEventListener("submit", async (event) => {
	event.preventDefault();
	if (byId("send").disabled || sending) return;
	const message = byId("message").value.trim();
	const id = selected;
	const project = byId("project").value;
	const agent = byId("agent").value;
	sending = true;
	clearTimeout(timer);
	loadVersion++;
	notice("error");
	controls();
	try {
		byId("routing").open = false;
		const detail = id
			? await api(`/api/chats/${encodeURIComponent(id)}/messages`, { message })
			: await api("/api/chats", { project, agent, message });
		drafts.delete(id);
		if (selected !== id) return;
		byId("message").value = "";
		if (!id) {
			selected = detail.id;
			history.replaceState(
				null,
				"",
				`${location.pathname}${location.search}#${new URLSearchParams({ chat: selected })}`,
			);
		}
		drawChat(detail);
		// A subsequent list refresh supplies the lightweight, server-sorted summaries.
		chats = [detail, ...chats.filter((entry) => entry.id !== detail.id)];
		drawList();
		byId("scroll-area").scrollTop = byId("scroll-area").scrollHeight;
	} catch (error) {
		if (selected === id) {
			notice(
				"error",
				error.status ? error.message : "Delivery could not be confirmed. Check recent chats before sending again.",
			);
		}
	} finally {
		sending = false;
		controls();
		void refresh();
	}
});

byId("message").addEventListener("input", controls);
byId("message").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
		event.preventDefault();
		if (!byId("send").disabled) byId("composer").requestSubmit();
	}
});
byId("new-chat").addEventListener("click", () => navigate(""));
byId("host").addEventListener("change", (event) => {
	const origin = event.target.value;
	event.target.value = "";
	if (hostOrigins.has(origin)) location.assign(origin);
});
byId("open-nav").addEventListener("click", () => {
	const dialog = byId("nav-dialog");
	dialog.append(byId("sidebar"));
	dialog.showModal();
	byId("close-nav").focus();
});
byId("open-artifacts").addEventListener("click", () => openArtifacts());
byId("artifacts-dialog").addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		event.preventDefault();
		byId("artifacts-dialog").close();
	}
});
byId("routing").addEventListener("keydown", (event) => {
	if (event.key === "Escape" && byId("routing").open) {
		event.preventDefault();
		byId("routing").open = false;
		byId("routing").querySelector("summary").focus();
	}
});
byId("artifacts-dialog").addEventListener("close", () => {
	clearPreview();
	for (const button of byId("artifact-list").children) button.setAttribute("aria-pressed", "false");
});
byId("close-nav").addEventListener("click", closeNav);
byId("nav-dialog").addEventListener("close", () => byId("sidebar-slot").append(byId("sidebar")));
byId("nav-dialog").addEventListener("click", (event) => {
	if (event.target === byId("nav-dialog")) closeNav();
});
matchMedia("(max-width:720px)").addEventListener("change", (event) => {
	if (!event.matches) closeNav();
});
window.addEventListener("hashchange", () => {
	const id = chatFromAddress();
	if (id !== selected) {
		displaySelection(id);
		void refresh();
	}
});
window.addEventListener("online", refresh);
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) void refresh();
});
if (selected) {
	byId("welcome").hidden = true;
	byId("conversation").hidden = false;
	byId("chat-title").textContent = "Loading chat…";
}
void refresh();
