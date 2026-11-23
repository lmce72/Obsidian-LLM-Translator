import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type PdfOllamaTranslatorPlugin from "./main";
import type { TranslationLanguage, TranslationProviderId } from "./types";
import { t } from "./i18n";
import { HIGHLIGHT_COLOR_ORDER, getHighlightColor } from "./pdfHighlight/colors";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "./languageOptions";
import type { TranslationHistorySort } from "./translationHistory";

export const PDF_OLLAMA_TRANSLATOR_VIEW_TYPE = "llm-translator-sidebar";

type SidebarMode = "translate" | "history";

export class PdfOllamaTranslatorSidebarView extends ItemView {
	private sourceInputEl: HTMLTextAreaElement | null = null;
	private resultOutputEl: HTMLElement | null = null;
	private mode: SidebarMode = "translate";
	private historyQuery = "";
	private historySort: TranslationHistorySort = "time-desc";
	private historySearchEl: HTMLInputElement | null = null;
	private historyListEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: PdfOllamaTranslatorPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return PDF_OLLAMA_TRANSLATOR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "LLM Translator";
	}

	getIcon(): string {
		return "languages";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.sourceInputEl = null;
		this.resultOutputEl = null;
	}

	refresh(): void {
		this.render();
	}

	showHistory(): void {
		this.mode = "history";
		// A fresh entry starts with the full, newest-first list; the search and
		// sort state only persists across automatic refreshes while open.
		this.historyQuery = "";
		this.historySort = "time-desc";
		this.render();
	}

	showTranslator(): void {
		this.mode = "translate";
		this.render();
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		const searchHadFocus = this.historySearchEl !== null
			&& this.historySearchEl.ownerDocument.activeElement === this.historySearchEl;
		container.empty();
		container.addClass("pdf-ollama-translator-sidebar");
		this.sourceInputEl = null;
		this.resultOutputEl = null;
		if (this.mode === "history") {
			this.renderHistory(container, searchHadFocus);
			return;
		}
		this.renderTranslateView(container);
	}

	private renderTranslateView(container: HTMLElement): void {
		const headerEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__header" });
		const titleEl = headerEl.createDiv({ cls: "pdf-ollama-translator-sidebar__title" });
		const iconEl = titleEl.createSpan({ cls: "pdf-ollama-translator-sidebar__title-icon" });
		setIcon(iconEl, "languages");
		titleEl.createSpan({ text: "LLM Translator", cls: "pdf-ollama-translator-sidebar__title-text" });

		const actionsEl = headerEl.createDiv({ cls: "pdf-ollama-translator-sidebar__header-actions" });
		const historyButton = actionsEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button clickable-icon",
			attr: { title: t("history.open"), "aria-label": t("history.open") },
		});
		setIcon(historyButton, "history");
		historyButton.onClickEvent(() => this.showHistory());

		const openSettingsButton = actionsEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button clickable-icon",
			attr: { title: t("sidebar.openSettings"), "aria-label": t("sidebar.openSettings") },
		});
		setIcon(openSettingsButton, "settings");
		openSettingsButton.onClickEvent(() => this.plugin.openSettingsTab());

		this.renderServiceControls(container);
		this.renderLanguageControls(container);
		this.renderTextPanels(container);
		this.renderBottomControls(container);
	}

	private renderHistory(container: HTMLElement, searchHadFocus: boolean): void {
		const headerEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__header" });
		const backButton = headerEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button clickable-icon",
			attr: { title: t("history.back"), "aria-label": t("history.back") },
		});
		setIcon(backButton, "arrow-left");
		backButton.onClickEvent(() => this.showTranslator());

		const titleEl = headerEl.createDiv({ cls: "pdf-ollama-translator-sidebar__title" });
		const iconEl = titleEl.createSpan({
			cls: "pdf-ollama-translator-sidebar__title-icon pdf-ollama-translator-history__title-icon",
		});
		setIcon(iconEl, "history");
		titleEl.createSpan({ text: t("history.title"), cls: "pdf-ollama-translator-sidebar__title-text" });

		const toolbarEl = container.createDiv({ cls: "pdf-ollama-translator-history__toolbar" });
		const searchEl = toolbarEl.createEl("input", {
			cls: "pdf-ollama-translator-history__search",
			attr: {
				type: "search",
				placeholder: t("history.search"),
				"aria-label": t("history.search"),
			},
		});
		searchEl.value = this.historyQuery;
		searchEl.oninput = () => {
			this.historyQuery = searchEl.value;
			this.renderHistoryList();
		};
		this.historySearchEl = searchEl;

		const sortEl = toolbarEl.createEl("select", {
			cls: "pdf-ollama-translator-history__sort-select",
			attr: { title: t("history.sort"), "aria-label": t("history.sort") },
		});
		const sortOptions: Array<[TranslationHistorySort, string]> = [
			["time-desc", t("history.sortDesc")],
			["time-asc", t("history.sortAsc")],
			["source-asc", t("history.sortSourceAsc")],
			["source-desc", t("history.sortSourceDesc")],
			["translation-asc", t("history.sortTranslationAsc")],
			["translation-desc", t("history.sortTranslationDesc")],
		];
		for (const [value, label] of sortOptions) {
			sortEl.createEl("option", { value, text: label });
		}
		sortEl.value = this.historySort;
		sortEl.onchange = () => {
			this.historySort = sortEl.value as TranslationHistorySort;
			this.renderHistoryList();
		};

		const listEl = container.createDiv({ cls: "pdf-ollama-translator-history__list" });
		this.historyListEl = listEl;
		this.renderHistoryList();

		if (searchHadFocus) {
			searchEl.focus();
			searchEl.setSelectionRange(searchEl.value.length, searchEl.value.length);
		}
	}

	private renderHistoryList(): void {
		const listEl = this.historyListEl;
		if (!listEl) {
			return;
		}
		const items = this.plugin.getHistoryEntries(this.historyQuery, this.historySort);
		listEl.empty();
		if (items.length === 0) {
			listEl.createDiv({ cls: "pdf-ollama-translator-history__empty", text: t("history.empty") });
			return;
		}
		for (const item of items) {
			const rowEl = listEl.createDiv({ cls: "pdf-ollama-translator-history__item" });
			const metaEl = rowEl.createDiv({ cls: "pdf-ollama-translator-history__meta" });
			metaEl.createSpan({
				text: `${this.languageLabel(item.sourceLanguage)} → ${this.languageLabel(item.targetLanguage)}`,
			});
			metaEl.createSpan({
				cls: "pdf-ollama-translator-history__time",
				text: new Date(item.timestamp).toLocaleString(),
			});
			rowEl.createDiv({ cls: "pdf-ollama-translator-history__source", text: item.sourceText, attr: { dir: "auto" } });
			rowEl.createDiv({ cls: "pdf-ollama-translator-history__translation", text: item.translatedText, attr: { dir: "auto" } });
		}
	}

	private languageLabel(value: TranslationLanguage): string {
		const option = SOURCE_LANGUAGES.find((item) => item.value === value)
			?? TARGET_LANGUAGES.find((item) => item.value === value);
		return option ? t(option.labelKey) : value;
	}

	private renderServiceControls(container: HTMLElement): void {
		const rowEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__service-row" });
		const providerEl = rowEl.createEl("select", {
			cls: "pdf-ollama-translator-sidebar__select",
			attr: { "aria-label": t("sidebar.translationService") },
		});
		for (const option of [
			{ value: "local-llm", label: t("provider.localLlm") },
			{ value: "cloud-api", label: t("provider.cloudApi") },
			{ value: "google", label: "Google" },
			{ value: "bing", label: "Bing" },
		]) {
			providerEl.createEl("option", { text: option.label, value: option.value });
		}
		providerEl.value = this.plugin.settings.translationProvider;
		providerEl.title = providerEl.selectedOptions[0]?.text ?? "";
		providerEl.onchange = () => {
			providerEl.title = providerEl.selectedOptions[0]?.text ?? "";
			void this.plugin.updateSettings({ translationProvider: providerEl.value as TranslationProviderId });
		};

		const testButton = rowEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button clickable-icon",
			attr: { title: t("sidebar.testConnection"), "aria-label": t("sidebar.testConnection") },
		});
		setIcon(testButton, "plug-zap");
		testButton.onClickEvent(async () => {
			testButton.disabled = true;
			const result = await this.plugin.testConnection();
			testButton.disabled = false;
			new Notice(result.message);
		});

		const translateButton = rowEl.createEl("button", {
			text: t("sidebar.translateInput"),
			cls: "pdf-ollama-translator-sidebar__primary-button",
		});
		translateButton.onClickEvent(() => {
			if (!this.sourceInputEl) {
				return;
			}
			void this.plugin.translateSidebarText(this.sourceInputEl.value, this.sourceInputEl.getBoundingClientRect());
		});
	}

	private renderLanguageControls(container: HTMLElement): void {
		const rowEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__language-row" });
		const sourceEl = rowEl.createEl("select", { cls: "pdf-ollama-translator-sidebar__select" });
		for (const option of SOURCE_LANGUAGES) {
			sourceEl.createEl("option", {
				text: `${t("language.sourceShort")}: ${t(option.labelKey)}`,
				value: option.value,
			});
		}
		sourceEl.value = this.plugin.settings.sourceLanguage;
		sourceEl.onchange = () => {
			void this.plugin.updateSettings({ sourceLanguage: sourceEl.value as TranslationLanguage });
		};

		const swapButton = rowEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button clickable-icon",
			attr: { "aria-label": t("popup.swapLanguage"), title: t("popup.swapLanguage") },
		});
		setIcon(swapButton, "arrow-left-right");
		swapButton.onpointerdown = (event) => {
			if (event.pointerType === "mouse") event.preventDefault();
		};

		const targetEl = rowEl.createEl("select", { cls: "pdf-ollama-translator-sidebar__select" });
		for (const option of TARGET_LANGUAGES) {
			targetEl.createEl("option", {
				text: `${t("language.targetShort")}: ${t(option.labelKey)}`,
				value: option.value,
			});
		}
		targetEl.value = this.plugin.settings.targetLanguage;
		targetEl.onchange = () => {
			void this.plugin.updateSettings({
				targetLanguage: targetEl.value as Exclude<TranslationLanguage, "auto">,
			});
		};
		swapButton.onClickEvent(async () => {
			if (!this.sourceInputEl) return;
			const sourceText = this.sourceInputEl.value;
			const sourceRect = this.sourceInputEl.getBoundingClientRect();
			if (sourceEl.value === "auto") {
				sourceEl.value = targetEl.value;
				targetEl.value = this.plugin.settings.targetLanguage;
			} else {
				const previousSource = sourceEl.value;
				sourceEl.value = targetEl.value;
				targetEl.value = previousSource;
			}
			await this.plugin.updateSettings({
				sourceLanguage: sourceEl.value as TranslationLanguage,
				targetLanguage: targetEl.value as Exclude<TranslationLanguage, "auto">,
			});
			// Change: removed this.plugin.translateActiveSelectionFromSidebar() call here.
			// swap is a "language settings adjustment" action, not an "translate now" command.
			// After swapping, the user should explicitly trigger translation via the sidebar's
			// "Translate input" or "Use current selection" button.
			// To restore the previous behavior, uncomment the next line:
			// void this.plugin.translateActiveSelectionFromSidebar();
		});
	}

	private renderTextPanels(container: HTMLElement): void {
		const state = this.plugin.getSidebarState();

		const sourceEl = container.createEl("textarea", {
			cls: "pdf-ollama-translator-sidebar__panel pdf-ollama-translator-sidebar__source",
			attr: {
				"aria-label": t("sidebar.sourceText"),
				placeholder: t("sidebar.sourceTextPlaceholder"),
				dir: "auto",
			},
		});
		this.sourceInputEl = sourceEl;
		sourceEl.value = state.sourceText;

		const resultEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__panel pdf-ollama-translator-sidebar__panel--result", attr: { dir: "auto" } });
		this.resultOutputEl = resultEl;
		if (state.status === "loading") {
			resultEl.setText(t("sidebar.translating"));
		} else if (state.status === "error") {
			resultEl.setText(state.message || t("sidebar.translationFailed"));
			resultEl.addClass("is-error");
		} else {
			resultEl.setText(state.translatedText || t("sidebar.translation"));
			resultEl.toggleClass("is-placeholder", !state.translatedText);
			if (state.status === "success") {
				resultEl.contentEditable = "true";
				resultEl.setAttribute("role", "textbox");
				resultEl.setAttribute("aria-label", t("sidebar.translation"));
				resultEl.setAttribute("aria-multiline", "true");
				resultEl.oninput = () => this.plugin.setSidebarTranslatedText(resultEl.innerText);
			}
		}

		sourceEl.oninput = () => {
			this.plugin.setSidebarSourceText(sourceEl.value);
			resultEl.setText(t("sidebar.translation"));
			resultEl.contentEditable = "false";
			resultEl.removeClass("is-error");
			resultEl.addClass("is-placeholder");
		};
	}

	private renderBottomControls(container: HTMLElement): void {
		const controlsEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__controls" });

		this.renderHighlightControls(controlsEl);

		const quickRowEl = controlsEl.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-row pdf-ollama-translator-sidebar__quick-row",
		});
		quickRowEl.createSpan({ text: t("sidebar.autoTrans"), cls: "pdf-ollama-translator-sidebar__control-label" });
		const quickActionsEl = quickRowEl.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-actions pdf-ollama-translator-sidebar__quick-actions",
		});
		const autoToggle = quickActionsEl.createEl("input", {
			cls: "pdf-ollama-translator-sidebar__toggle",
			attr: { type: "checkbox", "aria-label": t("sidebar.autoTransLabel") },
		});
		autoToggle.checked = this.plugin.settings.autoTranslateSelection;
		autoToggle.onchange = async () => {
			await this.plugin.updateSettings({ autoTranslateSelection: autoToggle.checked });
			this.render();
		};

		quickActionsEl.createEl("button", {
			text: t("sidebar.useCurrentSelection"),
			cls: "pdf-ollama-translator-sidebar__clear-button",
		}).onClickEvent(() => void this.plugin.translateActiveSelectionFromSidebar());
		quickActionsEl.createEl("button", {
			text: t("sidebar.clear"),
			cls: "pdf-ollama-translator-sidebar__clear-button",
		}).onClickEvent(() => {
			this.plugin.clearSidebarState();
		});
		const addToNoteButton = quickActionsEl.createEl("button", {
			text: t("sidebar.addToNote"),
			cls: "pdf-ollama-translator-sidebar__copy-button",
			attr: { title: t("sidebar.addToNote"), "aria-label": t("sidebar.addToNote") },
		});
		addToNoteButton.onClickEvent(() => void this.plugin.addSidebarTranslationToNote(
			this.sourceInputEl?.value ?? "",
			this.resultOutputEl?.innerText ?? "",
		));

		const copyRowEl = controlsEl.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-row pdf-ollama-translator-sidebar__copy-row",
		});
		copyRowEl.createSpan({
			text: t("sidebar.copy"),
			cls: "pdf-ollama-translator-sidebar__control-label pdf-ollama-translator-sidebar__copy-label",
		});
		const copyActionsEl = copyRowEl.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-actions pdf-ollama-translator-sidebar__copy-actions",
		});
		for (const item of [
			{ label: t("sidebar.raw"), action: () => this.plugin.copySidebarText("raw") },
			{ label: t("sidebar.result"), action: () => this.plugin.copySidebarText("result") },
			{ label: t("sidebar.both"), action: () => this.plugin.copySidebarText("both") },
		]) {
			copyActionsEl.createEl("button", {
				text: item.label,
				cls: "pdf-ollama-translator-sidebar__copy-button",
			}).onClickEvent(() => void item.action());
		}
	}

	private renderHighlightControls(container: HTMLElement): void {
		const rowEl = container.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-row pdf-ollama-translator-sidebar__highlight-row",
		});
		rowEl.createSpan({ text: t("sidebar.highlightColor"), cls: "pdf-ollama-translator-sidebar__control-label" });
		const paletteEl = rowEl.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-actions pdf-ollama-translator-sidebar__highlight-palette",
		});

		for (const colorId of HIGHLIGHT_COLOR_ORDER) {
			const color = getHighlightColor(colorId);
			const colorLabel = t(`highlight.color.${colorId}`);
			const button = paletteEl.createEl("button", {
				cls: "pdf-ollama-translator-sidebar__highlight-swatch clickable-icon",
				attr: {
					"aria-label": colorLabel,
					"aria-pressed": String(this.plugin.settings.defaultHighlightColor === colorId),
					title: colorLabel,
				},
			});
			button.style.setProperty("--pdf-ollama-translator-highlight-color", color.css);
			button.style.backgroundColor = color.css;
			button.toggleClass("is-active", this.plugin.settings.defaultHighlightColor === colorId);
			button.onClickEvent(async () => {
				await this.plugin.updateSettings({ defaultHighlightColor: colorId });
				this.render();
			});
		}

		const clearButton = paletteEl.createEl("button", {
			text: t("sidebar.clearAllHighlights"),
			cls: "pdf-ollama-translator-sidebar__clear-button pdf-ollama-translator-sidebar__clear-highlights-button",
		});
		clearButton.onClickEvent(() => void this.plugin.clearActivePdfHighlights());
	}
}
