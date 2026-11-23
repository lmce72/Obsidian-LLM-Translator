import { Notice, setIcon } from "obsidian";
import { t } from "./i18n";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "./languageOptions";
import type { TranslationLanguage } from "./types";

const WINDOW_MARGIN = 12;
const BALL_GAP = 10;

export interface ManualWindowOptions {
	sourceLanguage: TranslationLanguage;
	targetLanguage: Exclude<TranslationLanguage, "auto">;
	fontSize: number;
	lineHeight: number;
	onLanguageChange: (
		sourceLanguage: TranslationLanguage,
		targetLanguage: Exclude<TranslationLanguage, "auto">,
	) => void;
	onTranslate: (text: string) => void;
	onAddNote: (sourceText: string, translatedText: string) => void;
	onOpenSidebar: () => void;
	onClose: () => void;
}

/**
 * The floating ball's own window. It is deliberately independent from the
 * selection translation popup: manual input, manual translate, no auto-run,
 * and no selection/anchor state from the reader.
 */
export class ManualTranslationWindow {
	private rootEl: HTMLElement;
	private sourceSelectEl: HTMLSelectElement;
	private targetSelectEl: HTMLSelectElement;
	private inputEl: HTMLTextAreaElement;
	private resultEl: HTMLElement;
	private translateButtonEl: HTMLButtonElement;
	private copyButtonEl: HTMLButtonElement;
	private noteButtonEl: HTMLButtonElement;
	private lastResult = "";
	private lastSourceText = "";
	private loading = false;
	private anchor: DOMRect | null = null;
	private options: ManualWindowOptions;
	private resizeObserver: ResizeObserver;
	private viewportObserver: ResizeObserver;
	private resizeHandler = () => {
		if (this.isVisible() && this.anchor) {
			this.positionBeside(this.anchor);
		}
	};

	constructor(options: ManualWindowOptions) {
		this.options = options;
		this.rootEl = window.document.body.createDiv({ cls: "pdf-ollama-translator-manual" });
		this.rootEl.hide();

		const headerEl = this.rootEl.createDiv({ cls: "pdf-ollama-translator-manual__header" });
		const languageEl = headerEl.createDiv({ cls: "pdf-ollama-translator-manual__language" });
		this.sourceSelectEl = languageEl.createEl("select", {
			cls: "pdf-ollama-translator-manual__select",
			attr: { "aria-label": t("popup.sourceLanguage"), title: t("popup.sourceLanguage") },
		});
		for (const option of SOURCE_LANGUAGES) {
			const label = option.value === "auto" ? t("language.autoShort") : option.code;
			this.sourceSelectEl.createEl("option", {
				text: `${t("language.sourceShort")} ${label}`,
				value: option.value,
			});
		}
		this.sourceSelectEl.onchange = () => this.commitLanguages();

		const swapButton = languageEl.createEl("button", {
			cls: "pdf-ollama-translator-manual__icon-button clickable-icon",
			attr: { "aria-label": t("popup.swapLanguage"), title: t("popup.swapLanguage") },
		});
		setIcon(swapButton, "arrow-left-right");
		swapButton.onpointerdown = (event) => {
			if (event.pointerType === "mouse") event.preventDefault();
		};
		swapButton.onClickEvent(() => this.swapLanguages());

		this.targetSelectEl = languageEl.createEl("select", {
			cls: "pdf-ollama-translator-manual__select",
			attr: { "aria-label": t("popup.targetLanguage"), title: t("popup.targetLanguage") },
		});
		for (const option of TARGET_LANGUAGES) {
			this.targetSelectEl.createEl("option", {
				text: `${t("language.targetShort")} ${option.code}`,
				value: option.value,
			});
		}
		this.targetSelectEl.onchange = () => this.commitLanguages();

		const actionsEl = headerEl.createDiv({ cls: "pdf-ollama-translator-manual__actions" });
		this.copyButtonEl = this.createIconButton(actionsEl, "copy", t("popup.copyTranslation"), () => this.copyResult());
		this.noteButtonEl = this.createIconButton(actionsEl, "file-plus", t("sidebar.addToNote"), () => this.addNote());
		this.createIconButton(actionsEl, "panel-right", t("popup.openSidebar"), () => this.options.onOpenSidebar());
		this.createIconButton(actionsEl, "x", t("popup.close"), () => {
			// Hide first so the close button always works, then cancel the request.
			this.hide();
			this.options.onClose();
		});

		const bodyEl = this.rootEl.createDiv({ cls: "pdf-ollama-translator-manual__body" });
		this.inputEl = bodyEl.createEl("textarea", {
			cls: "pdf-ollama-translator-manual__input",
			attr: {
				dir: "auto",
				placeholder: t("popup.inputPlaceholder"),
				"aria-label": t("sidebar.sourceText"),
			},
		});
		this.inputEl.oninput = () => this.updateControls();
		this.inputEl.onkeydown = (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				this.submit();
			}
		};

		const controlsEl = bodyEl.createDiv({ cls: "pdf-ollama-translator-manual__controls" });
		this.translateButtonEl = controlsEl.createEl("button", {
			cls: "pdf-ollama-translator-manual__translate-button",
			text: t("sidebar.translateInput"),
			attr: { type: "button" },
		});
		this.translateButtonEl.onClickEvent(() => this.submit());

		this.resultEl = bodyEl.createDiv({ cls: "pdf-ollama-translator-manual__result", attr: { dir: "auto" } });
		this.resultEl.setText(t("sidebar.translation"));
		this.resultEl.addClass("is-placeholder");

		this.updateOptions(options);
		this.getWindow().addEventListener("resize", this.resizeHandler);
		this.getWindow().visualViewport?.addEventListener("resize", this.resizeHandler);
		this.resizeObserver = new ResizeObserver(() => this.resizeHandler());
		this.resizeObserver.observe(this.rootEl);
		this.viewportObserver = new ResizeObserver(() => this.resizeHandler());
		this.viewportObserver.observe(this.rootEl.ownerDocument.documentElement);
	}

	updateOptions(options: ManualWindowOptions): void {
		this.options = options;
		this.rootEl.style.setProperty("--pdf-ollama-translator-font-size", `${options.fontSize}px`);
		this.rootEl.style.setProperty("--pdf-ollama-translator-line-height", String(options.lineHeight));
		this.sourceSelectEl.value = options.sourceLanguage;
		this.targetSelectEl.value = options.targetLanguage;
		this.updateControls();
	}

	show(anchor: DOMRect, document: Document = activeDocument): void {
		this.moveTo(document);
		this.anchor = anchor;
		this.rootEl.show();
		this.positionBeside(anchor);
		this.inputEl.focus();
	}

	hide(): void {
		this.rootEl.hide();
	}

	isVisible(): boolean {
		return this.rootEl.style.display !== "none";
	}

	setAnchor(anchor: DOMRect): void {
		this.anchor = anchor;
		if (this.isVisible()) {
			this.positionBeside(anchor);
		}
	}

	showLoading(): void {
		this.loading = true;
		this.lastResult = "";
		this.lastSourceText = "";
		this.resultEl.setText(t("sidebar.translating"));
		this.resultEl.removeClass("is-error");
		this.resultEl.addClass("is-placeholder");
		this.updateControls();
	}

	showResult(sourceText: string, translatedText: string): void {
		this.loading = false;
		this.lastSourceText = sourceText;
		this.lastResult = translatedText;
		this.resultEl.setText(translatedText);
		this.resultEl.removeClass("is-placeholder");
		this.resultEl.removeClass("is-error");
		this.updateControls();
	}

	showError(message: string): void {
		this.loading = false;
		this.lastSourceText = "";
		this.lastResult = "";
		this.resultEl.setText(message);
		this.resultEl.removeClass("is-placeholder");
		this.resultEl.addClass("is-error");
		this.updateControls();
	}

	destroy(): void {
		this.resizeObserver.disconnect();
		this.viewportObserver.disconnect();
		this.getWindow().removeEventListener("resize", this.resizeHandler);
		this.getWindow().visualViewport?.removeEventListener("resize", this.resizeHandler);
		this.rootEl.remove();
	}

	private createIconButton(
		container: HTMLElement,
		icon: string,
		label: string,
		handler: () => void,
	): HTMLButtonElement {
		const button = container.createEl("button", {
			cls: "pdf-ollama-translator-manual__icon-button clickable-icon",
			attr: { "aria-label": label, title: label, type: "button" },
		});
		button.onpointerdown = (event) => {
			if (event.pointerType === "mouse") event.preventDefault();
		};
		setIcon(button, icon);
		button.onClickEvent(handler);
		return button;
	}

	private updateControls(): void {
		const hasText = this.inputEl.value.trim().length > 0;
		this.translateButtonEl.disabled = this.loading || !hasText;
		const hasResult = Boolean(this.lastResult);
		this.copyButtonEl.disabled = !hasResult;
		this.noteButtonEl.disabled = !hasResult;
	}

	private submit(): void {
		const text = this.inputEl.value.trim();
		if (!text) {
			new Notice(t("notice.enterTextFirst"));
			return;
		}
		this.options.onTranslate(text);
	}

	private copyResult(): void {
		if (!this.lastResult) {
			return;
		}
		void navigator.clipboard.writeText(this.lastResult).then(
			() => new Notice(t("notice.copied")),
			(error: unknown) => {
				console.error("[LLM Translator] Copy failed.", error);
				new Notice(t("notice.copyFailed"));
			},
		);
	}

	private addNote(): void {
		if (!this.lastResult) {
			return;
		}
		this.options.onAddNote(this.lastSourceText || this.inputEl.value, this.lastResult);
	}

	private commitLanguages(): void {
		this.options.onLanguageChange(
			this.sourceSelectEl.value as TranslationLanguage,
			this.targetSelectEl.value as Exclude<TranslationLanguage, "auto">,
		);
	}

	private swapLanguages(): void {
		const target = this.targetSelectEl.value;
		if (this.sourceSelectEl.value === "auto") {
			this.sourceSelectEl.value = target;
		} else {
			const source = this.sourceSelectEl.value;
			this.sourceSelectEl.value = target;
			this.targetSelectEl.value = source;
		}
		// Swapping is a settings change; it never spends tokens on its own.
		this.commitLanguages();
	}

	private moveTo(document: Document): void {
		if (this.rootEl.ownerDocument !== document) {
			this.hide();
			document.body.appendChild(this.rootEl);
		}
	}

	private getWindow(): Window {
		return this.rootEl.ownerDocument.defaultView ?? window;
	}

	private positionBeside(anchor: DOMRect): void {
		const window = this.getWindow();
		const rect = this.rootEl.getBoundingClientRect();
		const centerX = anchor.left + anchor.width / 2;
		let left = centerX > window.innerWidth / 2
			? anchor.left - rect.width - BALL_GAP
			: anchor.right + BALL_GAP;
		let top = anchor.bottom - rect.height;

		// Not enough room beside the ball (phones): open above it instead.
		if (left < WINDOW_MARGIN || left + rect.width > window.innerWidth - WINDOW_MARGIN) {
			left = centerX - rect.width / 2;
			top = anchor.top - rect.height - BALL_GAP;
			if (top < WINDOW_MARGIN) {
				top = anchor.bottom + BALL_GAP;
			}
		}

		const maxLeft = Math.max(WINDOW_MARGIN, window.innerWidth - rect.width - WINDOW_MARGIN);
		const maxTop = Math.max(WINDOW_MARGIN, window.innerHeight - rect.height - WINDOW_MARGIN);
		this.rootEl.style.left = `${Math.round(clamp(left, WINDOW_MARGIN, maxLeft))}px`;
		this.rootEl.style.top = `${Math.round(clamp(top, WINDOW_MARGIN, maxTop))}px`;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
