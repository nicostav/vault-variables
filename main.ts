import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	Platform,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";

interface VVSettings {
	variables: Record<string, string>;
	/** Display order of variable names (object key order is unreliable for numeric-like names). */
	order: string[];
	/** Highlight {{name}} placeholders that have no value defined. */
	highlightMissing: boolean;
}

const DEFAULT_SETTINGS: VVSettings = {
	variables: {},
	order: [],
	highlightMissing: true,
};

// {{name}} with optional inner whitespace. Names: letters, digits, _ . -
const PLACEHOLDER_SOURCE = "\\{\\{\\s*([A-Za-z0-9_.-]+)\\s*\\}\\}";

export default class VaultVariablesPlugin extends Plugin {
	settings: VVSettings = { variables: {}, order: [], highlightMissing: true };

	async onload() {
		await this.loadSettings();

		this.registerMarkdownPostProcessor((el) => {
			// Code blocks first (own handling + copy button)...
			el.querySelectorAll("pre > code").forEach((code) => {
				this.processCodeBlock(code as HTMLElement);
			});
			// ...then everything else in the document (paragraphs, lists,
			// tables, headings, callouts, inline code). Code blocks are skipped.
			// Deferred and skipped inside the editor: Live Preview renders some
			// elements (tables, embeds, ...) through post-processors too, and
			// those must keep showing the raw {{name}}.
			this.whenOutsideEditor(el, () => this.substituteInTextNodes(el, true));
		});

		this.addRibbonIcon("braces", "Edit vault variables", () => {
			new VariablesModal(this.app, this).open();
		});

		this.addCommand({
			id: "edit-variables",
			name: "Edit variables",
			callback: () => new VariablesModal(this.app, this).open(),
		});

		this.addSettingTab(new VVSettingTab(this.app, this));
		this.registerEditorSuggest(new VariableSuggest(this.app, this));
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<VVSettings> | null;
		const variables =
			data?.variables && typeof data.variables === "object"
				? data.variables
				: {};
		this.settings = {
			variables: { ...DEFAULT_SETTINGS.variables, ...variables },
			order: Array.isArray(data?.order)
				? data.order.filter((n: unknown): n is string => typeof n === "string")
				: [],
			highlightMissing:
				typeof data?.highlightMissing === "boolean"
					? data.highlightMissing
					: DEFAULT_SETTINGS.highlightMissing,
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Save and re-render all open Reading views. */
	async setVariables(vars: Record<string, string>, order?: string[]) {
		this.settings.variables = vars;
		if (order) this.settings.order = order;
		await this.saveSettings();
		this.refreshViews();
	}

	/** [name, value] pairs in the user's chosen order. */
	getOrderedVariables(): [string, string][] {
		const vars = this.settings.variables;
		const seen = new Set<string>();
		const out: [string, string][] = [];
		for (const name of this.settings.order) {
			if (Object.prototype.hasOwnProperty.call(vars, name) && !seen.has(name)) {
				seen.add(name);
				out.push([name, vars[name]]);
			}
		}
		for (const name of Object.keys(vars)) {
			if (!seen.has(name)) out.push([name, vars[name]]);
		}
		return out;
	}

	refreshViews() {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.getMode() === "preview") {
				view.previewMode.rerender(true);
			}
		});
	}

	/** Replace known placeholders in plain text. Unknown ones stay as-is. */
	substitute(text: string): string {
		const re = new RegExp(PLACEHOLDER_SOURCE, "g");
		return text.replace(re, (whole, name: string) => {
			const v = this.settings.variables[name];
			return v !== undefined ? v : whole;
		});
	}

	/**
	 * Run fn once `el` is attached to the DOM, unless it sits inside the
	 * CodeMirror editor (Live Preview / Source mode). At post-processor time
	 * the element is usually still detached, so retry for a few frames.
	 */
	private whenOutsideEditor(el: HTMLElement, fn: () => void, attempt = 0) {
		window.requestAnimationFrame(() => {
			if (el.isConnected) {
				if (!el.closest(".cm-editor, .markdown-source-view")) fn();
				return;
			}
			if (attempt < 30) this.whenOutsideEditor(el, fn, attempt + 1);
		});
	}

	private processCodeBlock(code: HTMLElement) {
		if (code.dataset.vvProcessed === "1") return;

		const original = code.textContent ?? "";
		if (!new RegExp(PLACEHOLDER_SOURCE).test(original)) return;

		code.dataset.vvProcessed = "1";
		const expected = this.substitute(original);

		// Preferred: replace inside individual text nodes to keep syntax highlighting.
		this.substituteInTextNodes(code, false);

		// If a placeholder was split across highlight spans, the result differs
		// from the expected text. Fall back to plain text (loses highlighting).
		if ((code.textContent ?? "") !== expected) {
			code.textContent = expected;
		}

		this.hookNativeCopyButton(code, original);
	}

	private substituteInTextNodes(root: HTMLElement, skipCodeBlocks: boolean) {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) => {
				const parent = node.parentElement;
				if (!parent) return NodeFilter.FILTER_REJECT;
				// Never re-process our own output (a value could contain "{{x}}").
				if (parent.closest(".vv-value, .vv-missing")) {
					return NodeFilter.FILTER_REJECT;
				}
				if (parent.closest("script, style, textarea")) {
					return NodeFilter.FILTER_REJECT;
				}
				if (skipCodeBlocks && parent.closest("pre")) {
					return NodeFilter.FILTER_REJECT;
				}
				return NodeFilter.FILTER_ACCEPT;
			},
		});
		const nodes: Text[] = [];
		let n: Node | null;
		while ((n = walker.nextNode())) nodes.push(n as Text);

		for (const node of nodes) {
			const text = node.textContent ?? "";
			if (!new RegExp(PLACEHOLDER_SOURCE).test(text)) continue;

			const re = new RegExp(PLACEHOLDER_SOURCE, "g");
			const frag = createFragment();
			let last = 0;
			let m: RegExpExecArray | null;
			while ((m = re.exec(text))) {
				if (m.index > last) {
					frag.appendChild(document.createTextNode(text.slice(last, m.index)));
				}
				const value = this.settings.variables[m[1]];
				if (value === undefined && !this.settings.highlightMissing) {
					// Unknown variable, highlighting off: leave it as plain text.
					frag.appendChild(document.createTextNode(m[0]));
				} else {
					const span = createSpan();
					if (value !== undefined) {
						span.className = "vv-value";
						span.textContent = value;
					} else {
						span.className = "vv-missing";
						span.textContent = m[0];
					}
					frag.appendChild(span);
				}
				last = m.index + m[0].length;
			}
			if (last < text.length) {
				frag.appendChild(document.createTextNode(text.slice(last)));
			}
			node.parentNode?.replaceChild(frag, node);
		}
	}

	/**
	 * Obsidian's built-in copy button copies the raw source (with {{...}}).
	 * Intercept clicks on it in the capture phase and copy the substituted
	 * text instead. No extra button is added.
	 */
	private hookNativeCopyButton(code: HTMLElement, original: string) {
		const pre = code.parentElement;
		if (!pre || pre.dataset.vvCopyHooked === "1") return;
		pre.dataset.vvCopyHooked = "1";

		pre.addEventListener(
			"click",
			(ev) => {
				const target = ev.target as HTMLElement | null;
				if (!target?.closest(".copy-code-button")) return;
				ev.preventDefault();
				ev.stopImmediatePropagation();
				// Computed at click time so it always uses current values.
				navigator.clipboard
					.writeText(this.substitute(original).replace(/(\r?\n)+$/, ""))
					.then(() => new Notice("Copied with variables substituted"))
					.catch(() => new Notice("Copy failed"));
			},
			true
		);
	}
}

interface VarRow {
	name: string;
	value: string;
}

/** Shared editor UI used by both the modal and the settings tab. */
function renderVariablesEditor(
	container: HTMLElement,
	plugin: VaultVariablesPlugin
) {
	container.empty();

	// Local rows so empty/new rows can exist before they have a name.
	const rows: VarRow[] = plugin
		.getOrderedVariables()
		.map(([name, value]) => ({ name, value }));
	let filter = "";
	let dragging: VarRow | null = null;

	const commit = async () => {
		const vars: Record<string, string> = {};
		const order: string[] = [];
		for (const r of rows) {
			const key = r.name.trim();
			if (!key) continue;
			if (!Object.prototype.hasOwnProperty.call(vars, key)) order.push(key);
			vars[key] = r.value;
		}
		await plugin.setVariables(vars, order);
	};

	const moveRow = (row: VarRow, target: VarRow, after: boolean) => {
		rows.splice(rows.indexOf(row), 1);
		const to = rows.indexOf(target);
		rows.splice(after ? to + 1 : to, 0, row);
	};

	const shiftRow = (row: VarRow, delta: number) => {
		const i = rows.indexOf(row);
		const j = i + delta;
		if (j < 0 || j >= rows.length) return;
		[rows[i], rows[j]] = [rows[j], rows[i]];
	};

	const matches = (r: VarRow) =>
		!filter ||
		r.name.toLowerCase().includes(filter) ||
		r.value.toLowerCase().includes(filter);

	container.createEl("p", {
		text: "Use {{name}} anywhere in a note: text, lists, tables, inline code and code blocks. Values are substituted in Reading view only; the editor keeps showing {{name}}. Type {{ in the editor to pick a variable. The copy button on code blocks copies the substituted text.",
		cls: "setting-item-description",
	});

	const search = container.createEl("input", {
		type: "search",
		placeholder: "Search variables...",
		cls: "vv-search",
	});
	search.addEventListener("input", () => {
		filter = search.value.trim().toLowerCase();
		renderRows();
	});

	const duplicateWarning = container.createDiv({ cls: "vv-duplicate-warning" });

	const list = container.createDiv({ cls: "vv-rows" });

	// Rebuilt by renderRows(); used to update duplicate markers without a
	// full re-render (which would steal focus from the input being typed in).
	let nameInputs: { row: VarRow; input: HTMLInputElement }[] = [];

	const duplicateNames = (): Set<string> => {
		const counts = new Map<string, number>();
		for (const r of rows) {
			const key = r.name.trim();
			if (!key) continue;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const dupes = new Set<string>();
		for (const [name, count] of counts) if (count > 1) dupes.add(name);
		return dupes;
	};

	const updateDuplicateIndicators = () => {
		const dupes = duplicateNames();
		for (const { row, input } of nameInputs) {
			input.toggleClass("vv-duplicate", dupes.has(row.name.trim()));
		}
		duplicateWarning.setText(
			dupes.size > 0
				? `Duplicate variable name${dupes.size > 1 ? "s" : ""}: ${[...dupes].join(", ")}. Only one value will be saved.`
				: ""
		);
	};

	const renderRows = () => {
		list.empty();
		nameInputs = [];

		const visible = rows.filter(matches);
		if (rows.length > 0 && visible.length === 0) {
			list.createDiv({
				text: "No matching variables.",
				cls: "setting-item-description",
			});
		}

		// Reordering is only unambiguous when the full list is shown.
		const reorderable = !filter;

		visible.forEach((row) => {
			const line = list.createDiv({ cls: "vv-row" });

			if (Platform.isMobile) {
				// Drag and drop is unreliable on mobile: use arrow buttons.
				const up = line.createEl("button", { text: "↑", cls: "vv-move" });
				up.disabled = !reorderable;
				up.addEventListener("click", () => {
					void (async () => {
						shiftRow(row, -1);
						await commit();
						renderRows();
					})();
				});
				const down = line.createEl("button", { text: "↓", cls: "vv-move" });
				down.disabled = !reorderable;
				down.addEventListener("click", () => {
					void (async () => {
						shiftRow(row, 1);
						await commit();
						renderRows();
					})();
				});
			} else {
				const handle = line.createSpan({
					text: "⠇",
					cls: "vv-handle",
					attr: { "aria-label": reorderable ? "Drag to reorder" : "Clear the search to reorder" },
				});
				if (reorderable) {
					handle.draggable = true;
				} else {
					handle.addClass("vv-handle-disabled");
				}

				handle.addEventListener("dragstart", (ev) => {
					dragging = row;
					ev.dataTransfer?.setData("text/plain", row.name);
					ev.dataTransfer?.setDragImage(line, 10, 10);
					line.addClass("vv-dragging");
				});
				handle.addEventListener("dragend", () => {
					dragging = null;
					list
						.querySelectorAll(".vv-dragging, .vv-drop-before, .vv-drop-after")
						.forEach((el) =>
							el.removeClasses(["vv-dragging", "vv-drop-before", "vv-drop-after"])
						);
				});

				const dropAfter = (ev: DragEvent) => {
					const rect = line.getBoundingClientRect();
					return ev.clientY > rect.top + rect.height / 2;
				};
				line.addEventListener("dragover", (ev) => {
					if (!dragging || dragging === row) return;
					ev.preventDefault();
					const after = dropAfter(ev);
					line.toggleClass("vv-drop-after", after);
					line.toggleClass("vv-drop-before", !after);
				});
				line.addEventListener("dragleave", () => {
					line.removeClasses(["vv-drop-before", "vv-drop-after"]);
				});
				line.addEventListener("drop", (ev) => {
					if (!dragging || dragging === row) return;
					ev.preventDefault();
					moveRow(dragging, row, dropAfter(ev));
					dragging = null;
					void (async () => {
						await commit();
						renderRows();
					})();
				});
			}

			const nameInput = line.createEl("input", {
				type: "text",
				placeholder: "name (e.g. ip)",
			});
			nameInput.value = row.name;
			nameInputs.push({ row, input: nameInput });
			nameInput.addEventListener("input", () => {
				row.name = nameInput.value;
				updateDuplicateIndicators();
			});
			nameInput.addEventListener("change", () => void commit());

			const valueInput = line.createEl("input", {
				type: "text",
				placeholder: "value",
			});
			valueInput.value = row.value;
			valueInput.addEventListener("input", () => (row.value = valueInput.value));
			valueInput.addEventListener("change", () => void commit());

			const del = line.createEl("button", { text: "Delete" });
			del.addEventListener("click", () => {
				rows.splice(rows.indexOf(row), 1);
				void (async () => {
					await commit();
					renderRows();
				})();
			});
		});

		updateDuplicateIndicators();
	};

	renderRows();

	const add = container.createEl("button", { text: "Add variable" });
	add.addEventListener("click", () => {
		// Clear the search so the new empty row is visible.
		filter = "";
		search.value = "";
		rows.push({ name: "", value: "" });
		renderRows();
		list.querySelector<HTMLInputElement>(".vv-row:last-child input")?.focus();
	});
}

class VariablesModal extends Modal {
	constructor(app: App, private plugin: VaultVariablesPlugin) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Vault variables");
		this.contentEl.addClass("vv-editor");
		renderVariablesEditor(this.contentEl, this.plugin);
	}

	onClose() {
		this.contentEl.empty();
	}
}

interface VarSuggestion {
	name: string;
	value: string;
}

/** Autocomplete popup: typing "{{" lists variables, filtered by what follows. */
class VariableSuggest extends EditorSuggest<VarSuggestion> {
	constructor(app: App, private plugin: VaultVariablesPlugin) {
		super(app);
	}

	private filter(query: string): VarSuggestion[] {
		const q = query.trim().toLowerCase();
		// Keeps the order set in the variables editor.
		const all = this.plugin
			.getOrderedVariables()
			.map(([name, value]) => ({ name, value }));
		if (!q) return all;

		// Match on names only, so the popup stays silent for unrelated
		// {{...}} syntax (e.g. core Templates' {{date}}). Prefix matches first.
		const starts = all.filter((v) => v.name.toLowerCase().startsWith(q));
		const contains = all.filter(
			(v) =>
				!v.name.toLowerCase().startsWith(q) && v.name.toLowerCase().includes(q)
		);
		return [...starts, ...contains];
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		_file: TFile | null
	): EditorSuggestTriggerInfo | null {
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const m = /\{\{\s*([A-Za-z0-9_.-]*)$/.exec(before);
		if (!m) return null;
		if (this.filter(m[1]).length === 0) return null;
		return {
			start: { line: cursor.line, ch: m.index },
			end: cursor,
			query: m[1],
		};
	}

	getSuggestions(ctx: EditorSuggestContext): VarSuggestion[] {
		return this.filter(ctx.query);
	}

	renderSuggestion(s: VarSuggestion, el: HTMLElement): void {
		el.createDiv({ text: s.name, cls: "vv-suggest-name" });
		el.createDiv({ text: s.value || "(empty)", cls: "vv-suggest-value" });
	}

	selectSuggestion(s: VarSuggestion): void {
		const ctx = this.context;
		if (!ctx) return;
		const { editor, start, end } = ctx;

		// Obsidian auto-closes brackets, so "{{" is usually followed by "}}"
		// already. Swallow those closers to avoid ending up with "}}}}".
		const after = editor.getLine(end.line).slice(end.ch);
		const closer = /^\s*\}\}?/.exec(after);
		const replaceEnd: EditorPosition = {
			line: end.line,
			ch: end.ch + (closer ? closer[0].length : 0),
		};

		const text = `{{${s.name}}}`;
		editor.replaceRange(text, start, replaceEnd);
		editor.setCursor({ line: start.line, ch: start.ch + text.length });
	}
}

class VVSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: VaultVariablesPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("vv-editor");
		new Setting(containerEl).setName("Variables").setHeading();

		new Setting(containerEl)
			.setName("Highlight undefined variables")
			.setDesc(
				"Mark {{name}} placeholders that have no value defined with a red background in Reading view."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.highlightMissing)
					.onChange(async (value) => {
						this.plugin.settings.highlightMissing = value;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);

		const holder = containerEl.createDiv();
		renderVariablesEditor(holder, this.plugin);
	}
}
