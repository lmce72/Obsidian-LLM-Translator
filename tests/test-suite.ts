import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PDFArray, PDFDocument, PDFName } from "pdf-lib";
import { TFile, TFolder, __setRequestUrl } from "obsidian";
import { PdfAnnotationWriter, pdfQuadPointsEqual } from "../src/pdfHighlight/PdfAnnotationWriter";
import { PdfHighlightService } from "../src/pdfHighlight/PdfHighlightService";
import { getHighlightColor } from "../src/pdfHighlight/colors";
import type { LocatedPdfHighlight, PdfHighlightQuad } from "../src/pdfHighlight/types";
import { normalizeSelectionTextForPdf } from "../src/pdfHighlight/normalize";
import { appendTranslationNote } from "../src/noteExport";
import { TranslationPopup } from "../src/translationPopup";
import PdfOllamaTranslatorPlugin from "../src/main";
import {
	cleanModelOutput,
	DEFAULT_TRANSLATION_PROMPT,
	migrateTranslationPrompt,
	normalizeCloudApiBaseUrl,
	TranslationCancelledError,
	TranslationTimeoutError,
	TranslatorService,
	truncateHttpErrorBody,
} from "../src/translatorService";
import { TranslationCache, buildCacheKey, normalizeCacheText } from "../src/translationCache";
import { TranslationHistory } from "../src/translationHistory";
import type { PdfOllamaTranslatorSettings, TranslationRequest } from "../src/types";

Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });

const SETTINGS: PdfOllamaTranslatorSettings = {
	selectionTranslationScope: "all",
	translationProvider: "local-llm",
	ollamaBaseUrl: "http://localhost:11434",
	model: "test-model",
	cloudApiBaseUrl: "https://api.example.com/v1",
	cloudApiKeySecretId: "test-api-key",
	cloudApiModel: "test-cloud-model",
	enablePopup: true,
	enableFloatingBall: true,
	floatingBallPosition: null,
	floatingBallSnap: null,
	noteTargetKind: "auto",
	enableContextMenu: true,
	enableTranslationCache: true,
	restrictSourceLanguages: false,
	sourceLanguage: "auto",
	targetLanguage: "zh-Hans",
	debounceMs: 0,
	requestTimeoutMs: 100,
	maxSelectionChars: 5000,
	fontSize: 13,
	lineHeight: 1.6,
	rememberPopupSize: true,
	popupWidth: 360,
	popupHeight: 220,
	showCopyButton: true,
	showRetryButton: true,
	defaultHighlightColor: "yellow",
	customPrompt: "Translate.",
	topK: 20,
	topP: 0.6,
	repeatPenalty: 1.05,
	numPredict: 4096,
	ollamaOptionsJson: "",
	cleanModelOutput: true,
	debugLogging: false,
};

const REQUEST: TranslationRequest = {
	text: "first",
	sourceLanguage: "en",
	targetLanguage: "zh-Hans",
	allowedSourceLanguages: ["en", "de", "fr", "ja", "zh-Hans"],
};

test("translation helpers validate URLs and clean bounded output", () => {
	assert.equal(normalizeCloudApiBaseUrl(" https://api.example.com/v1/// "), "https://api.example.com/v1");
	assert.equal(normalizeCloudApiBaseUrl("http://127.0.0.1:8000/v1"), "http://127.0.0.1:8000/v1");
	assert.throws(() => normalizeCloudApiBaseUrl("http://api.example.com/v1"), { name: "CloudApiBaseUrlError" });
	assert.throws(() => normalizeCloudApiBaseUrl("https://api.example.com/v1?token=secret"), { name: "CloudApiBaseUrlError" });
	assert.equal(truncateHttpErrorBody("abcdef", 4), "abc…");
	assert.equal(cleanModelOutput("<think>hidden</think>\nTranslation: \"Hello\""), "Hello");
	assert.equal(normalizeSelectionTextForPdf("A\u00a0  B\r\nC"), "A B C");
});

test("selection scope never stops automatic selection translation", async () => {
	const plugin = Object.create(PdfOllamaTranslatorPlugin.prototype) as PdfOllamaTranslatorPlugin;
	const state = plugin as unknown as Record<string, unknown>;
	const selection = { text: "selected text", rect: { left: 12, top: 8 }, document: {} };
	const events: string[] = [];
	state.settings = { ...SETTINGS, selectionTranslationScope: "never" };
	state.selectionReader = { readSelection: () => selection };
	state.popup = {
		showLoading: () => events.push("loading"),
		showResult: () => events.push("result"),
		hide: () => events.push("hidden"),
		setSelectionIsPdf: () => undefined,
		setSourceText: () => undefined,
	};
	state.translator = {
		translate: async () => ({ sourceText: selection.text, translatedText: "result", model: "mock", elapsedMs: 1 }),
	};
	state.debug = () => undefined;
	state.saveSettings = async () => undefined;
	state.syncPopupOptions = () => undefined;
	state.refreshSidebarViews = () => undefined;

	(state.scheduleSelectionTranslation as (doc: unknown) => void).call(plugin, selection.document);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(events, []);
});

test("disabling popup during a request keeps the completed result in the sidebar", async () => {
	const plugin = Object.create(PdfOllamaTranslatorPlugin.prototype) as PdfOllamaTranslatorPlugin;
	const state = plugin as unknown as Record<string, unknown>;
	const events: string[] = [];
	let finishTranslation!: (value: unknown) => void;
	state.settings = { ...SETTINGS, enablePopup: true, enableFloatingBall: false };
	state.popup = {
		showLoading: () => events.push("loading"),
		showResult: () => events.push("result"),
		hide: () => events.push("hidden"),
		setSelectionIsPdf: () => undefined,
		setSourceText: () => undefined,
	};
	state.translator = { translate: () => new Promise((resolve) => { finishTranslation = resolve; }) };
	state.isSidebarVisible = () => false;
	state.updateSidebarState = (value: { status: string }) => events.push(value.status);
	state.saveSettings = async () => undefined;
	state.syncPopupOptions = () => undefined;
	state.refreshSidebarViews = () => undefined;
	state.debug = () => undefined;
	const selection = { text: "selected text", rect: { left: 12, top: 8 }, document: {} };
	const pending = (state.translateSelection as (selection: unknown, force: boolean) => Promise<void>).call(plugin, selection, true);
	await plugin.updateSettings({ enablePopup: false });
	finishTranslation({ sourceText: selection.text, translatedText: "result text" });
	await pending;
	assert.deepEqual(events, ["loading", "loading", "hidden", "success"]);
});

test("provider lane cancels stale work and waits for the physical request", async () => {
	const transports: Array<{
		params: { body?: string };
		resolve: (response: { status: number; text: string; json: unknown }) => void;
	}> = [];
	__setRequestUrl((params: { body?: string }) => new Promise((resolve) => transports.push({ params, resolve })));

	const service = new TranslatorService(() => SETTINGS);
	const firstController = new AbortController();
	const first = service.translate({ ...REQUEST, signal: firstController.signal }).catch((error) => error);
	await nextTask();
	assert.equal(transports.length, 1);

	firstController.abort();
	assert.ok(await first instanceof TranslationCancelledError);
	const second = service.translate({ ...REQUEST, text: "second" }).catch((error) => error);
	const thirdPromise = service.translate({ ...REQUEST, text: "third" });
	assert.ok(await second instanceof TranslationCancelledError);
	assert.equal(transports.length, 1);

	transports[0].resolve(okOllamaResponse("obsolete"));
	await nextTask();
	assert.equal(transports.length, 2);
	assert.match(transports[1].params.body ?? "", /third/);
	transports[1].resolve(okOllamaResponse("latest"));
	assert.equal((await thirdPromise).translatedText, "latest");
});

test("timeout is reported immediately but the next request stays queued", async () => {
	const settings = { ...SETTINGS, requestTimeoutMs: 10 };
	const transports: Array<{
		resolve: (response: { status: number; text: string; json: unknown }) => void;
	}> = [];
	__setRequestUrl(() => new Promise((resolve) => transports.push({ resolve })));
	const service = new TranslatorService(() => settings);

	const timedOut = service.translate(REQUEST).catch((error) => error);
	assert.ok(await timedOut instanceof TranslationTimeoutError);
	const nextPromise = service.translate({ ...REQUEST, text: "next" });
	await nextTask();
	assert.equal(transports.length, 1);

	transports[0].resolve(okOllamaResponse("late"));
	await nextTask();
	assert.equal(transports.length, 2);
	transports[1].resolve(okOllamaResponse("next-result"));
	assert.equal((await nextPromise).translatedText, "next-result");
});

test("queued request times out without starting another transport", async () => {
	const settings = { ...SETTINGS, requestTimeoutMs: 10 };
	const transports: Array<{ resolve: (response: { status: number; text: string; json: unknown }) => void }> = [];
	__setRequestUrl(() => new Promise((resolve) => transports.push({ resolve })));
	const service = new TranslatorService(() => settings);

	assert.ok(await service.translate(REQUEST).catch((error) => error) instanceof TranslationTimeoutError);
	const queued = service.translate({ ...REQUEST, text: "queued" }).catch((error) => error);
	assert.ok(await queued instanceof TranslationTimeoutError);
	assert.equal(transports.length, 1);
	transports[0].resolve(okOllamaResponse("late"));
	await nextTask();
	assert.equal(transports.length, 1);
});

test("cloud requests resolve the key through SecretStorage", async () => {
	let authorization = "";
	__setRequestUrl((params: { headers?: Record<string, string> }) => {
		authorization = params.headers?.Authorization ?? "";
		return Promise.resolve({
			status: 200,
			text: "",
			json: { choices: [{ message: { content: "云端译文" } }] },
		});
	});
	const settings = { ...SETTINGS, translationProvider: "cloud-api" as const };
	const service = new TranslatorService(() => settings, (id) => id === "test-api-key" ? "secret-value" : null);
	assert.equal((await service.translate(REQUEST)).translatedText, "云端译文");
	assert.equal(authorization, "Bearer secret-value");
});

test("PDF writes are serialized and preserve concurrent highlights", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const first = location([quad(10, 10, 30, 20)]);
	const second = location([quad(40, 10, 60, 20)]);

	await Promise.all([
		writer.toggleHighlight(first, getHighlightColor("yellow")),
		writer.toggleHighlight(second, getHighlightColor("blue")),
	]);
	assert.equal(await vault.annotationCount(), 2);
	assert.equal(await writer.getHighlightColor(first), "yellow");
	assert.equal(await writer.getHighlightColor(second), "blue");
	assert.equal(await writer.getHighlightColor(location([...first.quads, ...second.quads])), null);
});

test("a smaller selection removes the full highlight without touching its neighbor", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const file = { path: "test.pdf" } as never;
	const selected = location([quad(15, 12, 25, 18)], file);
	const remaining = location([quad(10, 30, 30, 40)], file);
	const first = location([quad(10, 10, 30, 20), ...remaining.quads], file);
	const second = location([quad(40, 10, 60, 20)], file);
	await writer.applyHighlight(first, getHighlightColor("yellow"), "old note");
	await writer.applyHighlight(second, getHighlightColor("blue"), "second note");
	const restored = await writer.readHighlights(file);
	const firstGroup = restored.find((entry) => entry.location.quads.length === 2);
	const secondGroup = restored.find((entry) => entry.location.quads.length === 1);
	assert.ok(firstGroup);
	assert.ok(secondGroup);

	const service = Object.create(PdfHighlightService.prototype) as PdfHighlightService;
	const state = service as unknown as Record<string, any>;
	let located = selected;
	state.locator = { locate: async () => located, restoreOverlayRects: async () => undefined };
	state.writer = writer;
	state.overlay = { remove: () => undefined, renderPersisted: () => undefined };
	state.entries = new Map([
		[firstGroup.id, { key: firstGroup.id, location: firstGroup.location, color: getHighlightColor("yellow"), note: "edited note", persisted: false }],
		[secondGroup.id, { key: secondGroup.id, location: secondGroup.location, persisted: true }],
	]);
	state.pendingRemovals = new Map();
	state.noteConflicts = new Set();
	state.isFileOpen = () => true;
	const selection = { file: first.file, text: "first" } as never;

	assert.equal(await service.removeSelectionHighlight(selection), true);
	assert.equal(await vault.annotationCount(), 1);
	assert.equal(await writer.getHighlightColor(remaining), null);
	assert.equal(await writer.getHighlightColor(second), "blue");
	assert.equal(state.entries.size, 1);
	assert.ok(state.entries.has(secondGroup.id));
	located = location([quad(70, 10, 90, 20)], file);
	assert.equal(await service.removeSelectionHighlight(selection), false);
	assert.equal(await vault.annotationCount(), 1);
});

test("a larger selection removes every intersecting highlight", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const first = location([quad(10, 10, 30, 20)]);
	const second = location([quad(40, 10, 60, 20)]);
	const outside = location([quad(70, 10, 90, 20)]);
	await writer.applyHighlight(first, getHighlightColor("yellow"), "first");
	await writer.applyHighlight(second, getHighlightColor("blue"), "second");
	await writer.applyHighlight(outside, getHighlightColor("red"), "outside");
	const broad = location([quad(5, 5, 65, 25)]);

	assert.equal((await writer.removeHighlight(broad, "intersecting")).count, 2);
	assert.equal(await vault.annotationCount(), 1);
	assert.equal(await writer.getHighlightColor(outside), "red");
});

test("Turkish uses its language code in translation requests and PDF normalization", async () => {
	let requestUrl = "";
	__setRequestUrl((params: { url: string }) => {
		requestUrl = params.url;
		return Promise.resolve({ status: 200, text: "", json: [[['hello']]] });
	});
	const service = new TranslatorService(() => ({ ...SETTINGS, translationProvider: "google" }));
	const result = await service.translate({ ...REQUEST, text: "Merhaba", sourceLanguage: "tr", targetLanguage: "en" });
	assert.equal(result.translatedText, "hello");
	assert.equal(new URL(requestUrl).searchParams.get("sl"), "tr");
	assert.equal(normalizeSelectionTextForPdf("İ-\nş"), "İş");
});

test("partial multi-line highlights are repaired before toggling off", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const firstQuad = quad(10, 10, 30, 20);
	const secondQuad = quad(10, 30, 35, 40);
	const yellow = getHighlightColor("yellow");

	await writer.applyHighlight(location([firstQuad]), yellow, "note");
	const repaired = await writer.toggleHighlight(location([firstQuad, secondQuad]), yellow);
	assert.equal(repaired.action, "updated");
	assert.equal(repaired.note, "note");
	assert.equal(await vault.annotationCount(), 2);

	const removed = await writer.toggleHighlight(location([firstQuad, secondQuad]), yellow);
	assert.equal(removed.action, "removed");
	assert.equal(await vault.annotationCount(), 0);
});

test("persisted highlight geometry matches within the PDF annotation tolerance", () => {
	assert.equal(pdfQuadPointsEqual(
		[10, 20, 30, 20, 10, 10, 30, 10],
		[11.4, 20, 30, 20, 10, 10, 30, 10],
	), true);
	assert.equal(pdfQuadPointsEqual(
		[10, 20, 30, 20, 10, 10, 30, 10],
		[11.6, 20, 30, 20, 10, 10, 30, 10],
	), false);
});

test("persisted highlight notes can be restored and cleared", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const file = { path: "test.pdf" } as never;
	const selected = location([quad(20, 30, 60, 45)], file);
	const note = "中文批注 😀";

	await writer.applyHighlight(selected, getHighlightColor("purple"), note);
	const restored = await writer.readHighlights(file);
	assert.equal(restored.length, 1);
	assert.equal(restored[0].note, note);
	assert.deepEqual(restored[0].color, getHighlightColor("purple").pdfRgb);
	assert.equal(restored[0].overlayRects[0].pageNumber, 1);
	assert.equal(restored[0].overlayRects[0].leftRatio, 0.2);
	assert.equal(restored[0].overlayRects[0].topRatio, 0.55);

	assert.equal(await writer.removeAllHighlights(file), 1);
	assert.equal(await vault.annotationCount(), 0);
});

test("blank plugin highlights remain restorable without a native Contents value", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const file = { path: "test.pdf" } as never;
	await writer.applyHighlight(location([quad(15, 25, 55, 40)], file), getHighlightColor("yellow"), "");

	const restored = await writer.readHighlights(file);
	assert.equal(restored.length, 1);
	assert.equal(restored[0].note, "");
});

test("translation note creation asks once and later appends to the same source note", async () => {
	const { app, files } = noteApp();
	const source = new TFile("Papers/paper.pdf");
	const snapshot = { sourceText: "Hello", translatedText: "你好", file: source, pageHint: 2 };
	const target = "Papers/paper.pdf-Translation-Note.md";
	let confirmations = 0;
	assert.equal(await appendTranslationNote(app as never, snapshot, { kind: "auto", path: "" }, async (path) => {
		assert.equal(path, target);
		confirmations++;
		return true;
	}), target);
	assert.equal(await appendTranslationNote(app as never, { ...snapshot, sourceText: "World", translatedText: "世界" }, { kind: "auto", path: "" }, async () => {
		throw new Error("confirmation must not reopen");
	}), target);
	assert.equal(confirmations, 1);
	assert.equal(files.size, 1);
	const content = files.get(target) ?? "";
	assert.equal((content.match(/<table /g) ?? []).length, 2);
	assert.equal((content.match(/<tr>/g) ?? []).length, 6);
	assert.match(content, /border:2px solid #5aa9ff[\s\S]*?<td style="padding:8px">Hello<\/td>[\s\S]*?<td[^>]*>你好<\/td>/);
	assert.match(content, /<small>Source: <a class="internal-link" href="Papers\/paper\.pdf#page=2">paper\.pdf<\/a> · Page 2<\/small>/);
	assert.doesNotMatch(content, /\*\*Original\*\*|\*\*Translation\*\*|\n---\n/);
});

test("folder target keeps one translation note per source file in that folder", async () => {
	const folder = "Translations";
	const target = "Translations/paper.pdf-Translation-Note.md";
	const { app, files } = noteApp({}, new TFile("Papers/paper.pdf"), [folder]);
	let confirmed = "";
	assert.equal(await appendTranslationNote(app as never, {
		sourceText: "Hello", translatedText: "你好", file: new TFile("Papers/paper.pdf"),
	}, { kind: "folder", path: folder }, async (path) => {
		confirmed = path;
		return true;
	}), target);
	assert.equal(confirmed, target);
	assert.match(files.get(target) ?? "", /<!-- llm-translator-source: Papers%2Fpaper\.pdf -->/);
	await appendTranslationNote(app as never, {
		sourceText: "World", translatedText: "世界", file: new TFile("Papers/paper.pdf"),
	}, { kind: "folder", path: folder }, async () => {
		throw new Error("existing folder note must not ask to create");
	});
	assert.equal((files.get(target)?.match(/<table /g) ?? []).length, 2);
});

test("custom Markdown target collects translations from different source files", async () => {
	const target = "Notes/Translations.md";
	const { app, files } = noteApp({ [target]: "# My notes\n" }, new TFile("Papers/two.pdf"));
	for (const [name, file] of [["one.pdf", new TFile("Papers/one.pdf")], ["two.pdf", undefined]] as const) {
		await appendTranslationNote(app as never, {
			sourceText: name,
			translatedText: `译文 ${name}`,
			file,
		}, { kind: "note", path: target }, async () => { throw new Error("custom target must not create a file"); });
	}
	assert.equal(files.size, 1);
	assert.match(files.get(target) ?? "", /# My notes[\s\S]*?href="Papers\/one\.pdf"[\s\S]*?href="Papers\/two\.pdf"/);
});

test("translation note table escapes snapshots and uses a matched highlight color", async () => {
	const target = "Notes/Translations.md";
	const { app, files } = noteApp({ [target]: "" });
	await appendTranslationNote(app as never, {
		sourceText: "<script>alert('x')</script>\nA & B",
		translatedText: "<b>译文</b>",
		file: new TFile('Papers/a & "b".pdf'),
		highlightColor: "red",
	}, { kind: "note", path: target }, async () => true);
	const content = files.get(target) ?? "";
	assert.match(content, /border:2px solid #ff6b6b/);
	assert.match(content, /&#60;script&#62;alert\(&#39;x&#39;\)&#60;\/script&#62;<br>A &#38; B/);
	assert.match(content, /href="Papers\/a &#38; &#34;b&#34;\.pdf"/);
	assert.doesNotMatch(content, /<script>|<b>译文<\/b>/);
});

test("default note name collision leaves the unrelated file untouched", async () => {
	const target = "Papers/paper.pdf-Translation-Note.md";
	const { app, files } = noteApp({ [target]: "User notes\n" });
	await assert.rejects(appendTranslationNote(app as never, {
		sourceText: "Hello", translatedText: "你好", file: new TFile("Papers/paper.pdf"),
	}, { kind: "auto", path: "" }, async () => true), /different file/);
	assert.equal(files.get(target), "User notes\n");
});

test("annotation interaction and style regression guards stay enabled", async () => {
	const [overlay, service, main, styles] = await Promise.all([
		readProjectFile("src/pdfHighlight/HighlightOverlay.ts"),
		readProjectFile("src/pdfHighlight/PdfHighlightService.ts"),
		readProjectFile("src/main.ts"),
		readProjectFile("styles.css"),
	]);

	assert.match(service, /this\.renderPersistedHighlight\(highlight\)/);
	assert.match(overlay, /event\.stopImmediatePropagation\(\)/);
	assert.doesNotMatch(overlay, /style\.(?:background|pointerEvents|cursor)\s*=/);
	assert.doesNotMatch(overlay, /instanceof (Document|Node|Element)/);
	assert.match(main, /isHighlightNoteTarget\(doc\.activeElement\)/);
	assert.doesNotMatch(main, /target instanceof Element/);
	assert.doesNotMatch(styles, /\.commentPopup|\.annotationCommentButton/);
	assert.match(styles, /\.pdf-ollama-translator-highlight-note-editor[\s\S]*?resize: both/);
	assert.match(styles, /\.pdf-ollama-translator-highlight-overlay\s*{[^}]*background: transparent[^}]*pointer-events: none/);
	assert.doesNotMatch(styles, /!important|:has\(/);
});

test("sidebar adapts to narrow panes without overflowing", async () => {
	const [sidebar, styles] = await Promise.all([
		readProjectFile("src/sidebarView.ts"),
		readProjectFile("styles.css"),
	]);

	assert.equal((sidebar.match(/pdf-ollama-translator-sidebar__control-row/g) ?? []).length, 3);
	assert.equal((sidebar.match(/pdf-ollama-translator-sidebar__control-actions/g) ?? []).length, 3);
	// Forcing the right split to 368px is what pushed the sidebar past the window edge.
	assert.doesNotMatch(styles, /min-width:\s*368px/);
	assert.doesNotMatch(sidebar, /pdf-ollama-translator-sidebar-(?:leaf|split)/);
	assert.match(styles, /\.pdf-ollama-translator-sidebar\s*{[^}]*min-width:\s*0/);
	assert.match(styles, /container:\s*translator-sidebar\s*\/\s*inline-size/);
	assert.match(styles, /@container translator-sidebar \(inline-size < 340px\)/);
	assert.match(styles, /\.pdf-ollama-translator-sidebar__control-actions\s*{[^}]*flex-wrap:\s*wrap/);
	assert.match(styles, /\.pdf-ollama-translator-sidebar__control-row\s*{[^}]*grid-template-columns: minmax\(56px, 80px\) minmax\(0, 1fr\)/);
	assert.doesNotMatch(styles, /\.pdf-ollama-translator-sidebar__(?:highlight-palette|quick-actions|copy-actions)\s*{[^}]*gap:/);
	assert.doesNotMatch(styles, /\.pdf-ollama-translator-sidebar__quick-row\s*{[\s\S]*?justify-content: space-between/);
	assert.doesNotMatch(styles, /\.pdf-ollama-translator-sidebar__copy-row\s*{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
	// "Add to note" moved to the end of the row above the copy row.
	const quickRow = sidebar.indexOf("pdf-ollama-translator-sidebar__quick-row");
	const addToNote = sidebar.indexOf("sidebar.addToNote");
	const copyRow = sidebar.indexOf("pdf-ollama-translator-sidebar__copy-row");
	assert.ok(quickRow >= 0 && addToNote > quickRow && addToNote < copyRow);
});

test("floating ball opens an independent manual input window", async () => {
	const [ball, manual, popup, main, sidebar, styles, manifest] = await Promise.all([
		readProjectFile("src/floatingBall.ts"),
		readProjectFile("src/manualTranslationWindow.ts"),
		readProjectFile("src/translationPopup.ts"),
		readProjectFile("src/main.ts"),
		readProjectFile("src/sidebarView.ts"),
		readProjectFile("styles.css"),
		readProjectFile("manifest.json"),
	]);

	assert.match(ball, /setIcon\(this\.rootEl, "languages"\)/);
	assert.match(ball, /setPointerCapture\(event\.pointerId\)/);
	assert.match(ball, /releasePointerCapture\(event\.pointerId\)/);
	assert.match(ball, /EDGE_SNAP_DISTANCE/);
	assert.match(ball, /this\.options\.onToggle\(\)/);
	assert.match(ball, /this\.options\.onPositionChange\(next, \{ \.\.\.this\.snappedEdges \}\)/);
	assert.match(ball, /visualViewport\?\.addEventListener\("resize"/);
	assert.match(ball, /viewportObserver\.observe\(this\.rootEl\.ownerDocument\.documentElement\)/);
	assert.match(ball, /ensureVisible\(\): void/);
	assert.match(main, /this\.floatingBall\?\.ensureVisible\(\)/);
	assert.match(manual, /viewportObserver\.observe\(this\.rootEl\.ownerDocument\.documentElement\)/);

	// The ball opens its own manual window, not the selection popup.
	assert.match(manual, /class ManualTranslationWindow/);
	assert.match(manual, /createEl\("textarea"/);
	assert.match(manual, /inputEl\.oninput = \(\) => this\.updateControls\(\)/);
	assert.match(manual, /this\.hide\(\);\s*this\.options\.onClose\(\)/);
	assert.match(manual, /onTranslate: \(text: string\)/);
	assert.match(main, /new ManualTranslationWindow\(/);
	assert.match(main, /toggleManualWindow/);
	assert.match(main, /translateManualText/);
	assert.match(main, /cancelManualRequest/);
	assert.doesNotMatch(main, /getPopupAnchor/);
	assert.doesNotMatch(popup, /setAnchor|reopen|floatingMode|onOpenSidebar/);
	assert.match(main, /showPopup = fromPopup \|\| !this\.isSidebarVisible\(\)/);
	assert.match(sidebar, /language\.sourceShort/);
	assert.match(manual, /language\.targetShort/);

	// History entry points and the docked-edge resize fix.
	assert.match(main, /history\.json/);
	assert.match(main, /showSidebarHistory/);
	assert.match(main, /floatingBallSnap/);
	assert.match(sidebar, /history\.title/);
	assert.match(sidebar, /arrow-left/);
	assert.match(sidebar, /historyQuery/);
	assert.match(sidebar, /history__sort-select/);
	assert.match(sidebar, /sortSourceAsc/);
	assert.match(styles, /\.pdf-ollama-translator-sidebar__title-icon\s*{[^}]*align-items:\s*center/);
	assert.match(styles, /\.pdf-ollama-translator-sidebar__title-icon\s*{[^}]*border:\s*1px solid var\(--interactive-accent\)/);
	assert.match(styles, /\.pdf-ollama-translator-sidebar__title-icon svg\s*{[^}]*width:\s*18px/);
	assert.match(manual, /history\.open/);
	assert.match(ball, /snappedEdges/);
	assert.match(ball, /applyViewportPosition/);

	assert.match(popup, /setSourceText\(text: string\)/);
	assert.match(popup, /popup\.copySource/);
	assert.match(popup, /popup\.copyTranslation/);
	assert.match(popup, /closeButton\.onpointerup/);
	assert.match(main, /hidePopup\(true\)/);
	assert.match(main, /new FloatingBall\(/);
	assert.match(main, /setFloatingBallPosition/);
	assert.match(main, /rightSplit\.expand\(\)/);
	assert.match(main, /revealLeaf\(leaf\)/);
	assert.match(main, /selectionTranslationScope: Platform\.isMobile \? "never" : "all"/);
	assert.match(styles, /button\.pdf-ollama-translator-ball\s*{[^}]*border-radius:\s*50%/);
	assert.match(styles, /button\.pdf-ollama-translator-ball\s*{[^}]*background-color:\s*var\(--interactive-accent\)/);
	assert.match(styles, /button\.pdf-ollama-translator-ball\s*{[^}]*linear-gradient/);
	assert.match(styles, /button\.pdf-ollama-translator-ball\s*{[^}]*touch-action:\s*none/);
	assert.match(styles, /\.is-mobile button\.pdf-ollama-translator-ball\s*{[^}]*touch-action:\s*none/);
	assert.match(styles, /--translator-ball-size:\s*clamp\(34px, calc\(3vmin \+ 0\.75vmax\), 40px\)/);
	assert.match(styles, /width:\s*calc\(var\(--translator-ball-size\) \* 0\.4\)/);
	assert.equal((JSON.parse(manifest) as { isDesktopOnly?: boolean }).isDesktopOnly, false);
});

test("pdf context menu stays non-destructive and PDF++ compatible", async () => {
	const [contextMenu, main] = await Promise.all([
		readProjectFile("src/pdfContextMenu.ts"),
		readProjectFile("src/main.ts"),
	]);

	const section = (from: string, to: string): string => {
		const start = contextMenu.indexOf(from);
		const end = contextMenu.indexOf(to);
		assert.ok(start >= 0 && end > start, `could not slice ${from}..${to}`);
		return contextMenu.slice(start, end);
	};

	// Assertions about forbidden calls must ignore prose, or a comment explaining
	// why we avoid an API would fail the very check that guards it.
	const stripComments = (source: string): string =>
		source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const contextMenuCode = stripComments(contextMenu);

	// The old implementation intercepted contextmenu on the parent document in
	// the capture phase and stopped propagation, which erased every other
	// plugin's menu items.
	assert.doesNotMatch(main, /registerDomEvent\(\s*activeDocument\s*,\s*"contextmenu"/);
	assert.doesNotMatch(main, /handleContextMenu/);
	assert.doesNotMatch(contextMenuCode, /stopPropagation|stopImmediatePropagation/);
	assert.doesNotMatch(contextMenuCode, /activeDocument/);

	// Markdown keeps using the official event; PDF goes through `pdf-menu`.
	assert.match(main, /this\.app\.workspace\.on\("editor-menu"/);
	assert.match(contextMenu, /PDF_MENU_EVENT = "pdf-menu"/);
	assert.match(contextMenu, /PDF_PLUS_ID = "pdf-plus"/);

	// PDF++ detection must consult both the enabled set and the live instance;
	// a stubbed-out check would silently make us fight PDF++ for the menu.
	const detection = section("isPdfPlusEnabled(): boolean", "private scheduleRescan");
	assert.match(detection, /enabledPlugins\?\.has\(PDF_PLUS_ID\)/);
	assert.match(detection, /plugins\?\.\[PDF_PLUS_ID\]/);

	// When PDF++ owns the menu we must not install a competing interceptor.
	const rescan = section("private rescanPdfTargets", "private collectPdfTargets");
	assert.match(rescan, /this\.isPdfPlusEnabled\(\)/);
	assert.match(rescan, /this\.detachAll\(\)/);

	// Obsidian's built-in PDF handler calls stopPropagation(), so a bubble-phase
	// listener would never fire and the fallback menu would never appear. Both
	// registration and removal must pass the capture flag.
	assert.match(contextMenu, /addEventListener\("contextmenu", handler, true\)/);
	assert.match(contextMenu, /removeEventListener\("contextmenu", entry\.handler, true\)/);

	// The fallback must cover PDF views that are not inside an iframe, otherwise
	// builds that render PDF.js straight into the leaf get no menu at all.
	const collect = section("private collectPdfTargets", "private isPdfLeaf");
	assert.match(collect, /querySelectorAll\("iframe"\)/);
	assert.match(collect, /targets\.push\(container\)/);

	// Deciding a leaf is a PDF must not rely on generic classes: matching `.page`
	// in a Markdown view would attach the interceptor there and suppress its
	// native menu — the exact bug this file exists to prevent.
	assert.doesNotMatch(section("const PDF_VIEWER_MARKERS", "const PDF_PAGE_MARKERS"), /\.page|\.textLayer/);
	assert.match(section("private isPdfLeaf", "private readFrameDocument"), /viewType === "pdf"/);

	// The fallback interceptor must only broadcast: it adds no items itself (so
	// our own broadcast cannot duplicate them), backs off when another handler
	// already claimed the right-click, and re-checks PDF++ because enabling a
	// plugin emits no layout event.
	const interceptor = section("private handlePdfContextMenu", "private broadcastPdfMenu");
	assert.doesNotMatch(interceptor, /menu\.addItem\(/);
	assert.match(interceptor, /evt\.defaultPrevented/);
	assert.match(interceptor, /this\.isPdfPlusEnabled\(\)/);
	assert.match(interceptor, /this\.broadcastPdfMenu\(menu/);
	// Suppress the built-in menu with preventDefault only, and only once we
	// actually have items to show.
	assert.match(interceptor, /if \(!added\)[\s\S]*?evt\.preventDefault\(\)/);
	// This plugin's own highlight UI sits inside the page layer; right-clicking it
	// must keep the native menu so copy/paste still works in the note editor.
	assert.match(interceptor, /HIGHLIGHT_UI_MARKERS/);
	assert.match(contextMenu, /HIGHLIGHT_UI_MARKERS =[\s\S]*?highlight-note-editor/);

	// Captured geometry describing different text must not be reused, or a later
	// highlight would land on the wrong words.
	const capturedCode = stripComments(
		main.slice(main.indexOf("async translateCapturedSelection"), main.indexOf("private getViewportCenterRect")),
	);
	assert.ok(capturedCode.length > 0, "could not slice translateCapturedSelection");
	assert.doesNotMatch(capturedCode, /\.\.\.\(captured/);
	assert.doesNotMatch(capturedCode, /overlayRects|pageHint/);

	// Items come solely from the `pdf-menu` listener, registered exactly once.
	assert.equal((contextMenu.match(/menu\.addItem\(/g) ?? []).length, 2);
	assert.match(section("onPdfMenu(menu: Menu", "private scheduleRescan"), /menu\.addItem\(/);
	assert.equal((contextMenu.match(/workspace\.on\(\s*PDF_MENU_EVENT/g) ?? []).length, 1);
	assert.match(contextMenu, /private menuEventRef: EventRef \| null/);

	// A third-party listener that throws must not cost us the menu, and item
	// counting must not depend on Menu's private `items` field.
	const broadcast = section("private broadcastPdfMenu", "private pruneDetachedTargets");
	assert.match(broadcast, /catch \(error\)/);
	assert.doesNotMatch(contextMenu, /\bmenu\.items\b|\{ items\?/);

	// Realm hazard: the PDF iframe is a separate JS realm.
	assert.doesNotMatch(contextMenu, /instanceof (?:Document|Node|Element)/);
});

test("build metadata describes one release version", async () => {
	const [packageJson, manifest, packageLock, versions] = await Promise.all([
		readProjectJson("package.json"),
		readProjectJson("manifest.json"),
		readProjectJson("package-lock.json"),
		readProjectJson("versions.json"),
	]);
	assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
	assert.equal(manifest.version, packageJson.version);
	assert.equal(packageLock.version, packageJson.version);
	assert.equal(packageLock.packages[""].version, packageJson.version);
	assert.equal(versions[packageJson.version], manifest.minAppVersion);
});

test("stored prompt follows the default prompt after the Turkish update", async () => {
	const legacyPrompt = "Translate English, German, French, Japanese, or Simplified Chinese into the selected target language."
		+ " Preserve terminology, numbers, formulas, citations, and paragraph breaks. Output only the translation.";
	const main = await readProjectFile("src/main.ts");

	assert.match(DEFAULT_TRANSLATION_PROMPT, /\{sourceLanguage\}.*\{targetLanguage\}/);
	assert.equal(migrateTranslationPrompt(legacyPrompt), DEFAULT_TRANSLATION_PROMPT);
	assert.equal(migrateTranslationPrompt(`  ${legacyPrompt.replace(/ /g, "   ")}\n`), DEFAULT_TRANSLATION_PROMPT);
	assert.equal(migrateTranslationPrompt("Keep it short."), "Keep it short.");
	assert.equal(migrateTranslationPrompt("  "), "  ");
	assert.match(main, /const customPrompt = migrateTranslationPrompt\(storedPrompt\)/);
});

test("note target row centers its label against the controls", async () => {
	const [settings, styles] = await Promise.all([
		readProjectFile("src/settings.ts"),
		readProjectFile("styles.css"),
	]);

	assert.match(settings, /\.setName\(t\("settings\.noteTarget"\)\)[\s\S]*?\.setClass\("pdf-ollama-translator-setting--centered"\)/);
	assert.match(styles, /\.pdf-ollama-translator-settings \.setting-item\.pdf-ollama-translator-setting--centered\s*{[^}]*align-items: center/);
});

test("cache keys isolate model and prompt configuration", () => {
	const original = buildCacheKey("en", "fa", "Hello!", SETTINGS);
	assert.notEqual(original, buildCacheKey("en", "fa", "Hello!", { ...SETTINGS, model: "new-model", customPrompt: "Formal tone." }));
});

test("cache normalization preserves punctuation", () => {
	assert.equal(normalizeCacheText("  Hello?  "), "Hello?");
	assert.notEqual(normalizeCacheText("Hello?"), normalizeCacheText("Hello!"));
});

test("translation cache misses before load, hits after set, and persists to disk", async () => {
	const adapter = new MemoryCacheAdapter();
	const cache = new TranslationCache(adapter, "cache.json");

	// Not loaded yet: safe miss, never throws.
	assert.equal(cache.get("en||zh-Hans||hello"), null);

	await cache.load();
	assert.equal(cache.get("en||zh-Hans||hello"), null);

	cache.set("en||zh-Hans||hello", { translatedText: "你好", model: "test-model", timestamp: 1, version: 1 });
	assert.equal(cache.get("en||zh-Hans||hello")?.translatedText, "你好");

	await cache.flush();
	const parsed = JSON.parse(adapter.files.get("cache.json")!) as Record<string, { translatedText: string; model: string }>;
	assert.equal(parsed["en||zh-Hans||hello"].translatedText, "你好");
	assert.equal(parsed["en||zh-Hans||hello"].model, "test-model");
});

test("translation cache tolerates corrupted files and serializes concurrent writes", async () => {
	// Corrupted file: load must not throw, cache starts empty.
	const badAdapter = new MemoryCacheAdapter();
	badAdapter.files.set("cache.json", "not-json{{{");
	const badCache = new TranslationCache(badAdapter, "cache.json");
	await badCache.load();
	assert.equal(badCache.get("en||zh-Hans||hello"), null);

	// Concurrent writes: all entries present, last write wins per key.
	const adapter = new MemoryCacheAdapter();
	const cache = new TranslationCache(adapter, "cache.json");
	await cache.load();
	cache.set("en||zh-Hans||a", { translatedText: "A", model: "m", timestamp: 1, version: 1 });
	cache.set("en||zh-Hans||b", { translatedText: "B", model: "m", timestamp: 1, version: 1 });
	cache.set("en||zh-Hans||a", { translatedText: "A2", model: "m", timestamp: 1, version: 1 });
	await cache.flush();
	const parsed = JSON.parse(adapter.files.get("cache.json")!) as Record<string, { translatedText: string }>;
	assert.equal(parsed["en||zh-Hans||a"].translatedText, "A2");
	assert.equal(parsed["en||zh-Hans||b"].translatedText, "B");
});

class MemoryVault {
	private constructor(private bytes: ArrayBuffer) {}

	static async create(): Promise<MemoryVault> {
		const pdf = await PDFDocument.create();
		pdf.addPage([100, 100]);
		return new MemoryVault(toArrayBuffer(await pdf.save()));
	}

	async readBinary(): Promise<ArrayBuffer> {
		return this.bytes.slice(0);
	}

	async modifyBinary(_file: unknown, bytes: ArrayBuffer): Promise<void> {
		await nextTask();
		this.bytes = bytes.slice(0);
	}

	async annotationCount(): Promise<number> {
		const pdf = await PDFDocument.load(this.bytes);
		return pdf.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.size() ?? 0;
	}
}

function noteApp(
	initial: Record<string, string> = {},
	activeFile: TFile | null = null,
	folders: string[] = [],
): { app: object; files: Map<string, string> } {
	const files = new Map(Object.entries(initial));
	return {
		files,
		app: {
			workspace: { getActiveFile: () => activeFile },
			vault: {
				getAbstractFileByPath: (path: string) => folders.includes(path)
					? new TFolder(path)
					: files.has(path) ? new TFile(path) : null,
				create: async (path: string, content: string) => {
					if (files.has(path)) throw new Error("already exists");
					files.set(path, content);
					return new TFile(path);
				},
				process: async (file: TFile, change: (content: string) => string) => {
					const next = change(files.get(file.path) ?? "");
					files.set(file.path, next);
					return next;
				},
			},
		},
	};
}

class MemoryCacheAdapter {
	files = new Map<string, string>();

	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}
}

function quad(left: number, bottom: number, right: number, top: number): PdfHighlightQuad {
	return {
		pageIndex: 0,
		rect: [left, bottom, right, top],
		quadPoints: [left, top, right, top, left, bottom, right, bottom],
	};
}

function location(quads: PdfHighlightQuad[], file = { path: "test.pdf" } as never): LocatedPdfHighlight {
	return {
		file,
		normalizedText: "test",
		quads,
	};
}

function okOllamaResponse(content: string): { status: number; text: string; json: unknown } {
	return { status: 200, text: "", json: { message: { content } } };
}

function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const result = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(result).set(bytes);
	return result;
}

function readProjectFile(filePath: string): Promise<string> {
	return readFile(resolve(process.cwd(), filePath), "utf8");
}

async function readProjectJson(filePath: string): Promise<Record<string, any>> {
	return JSON.parse(await readProjectFile(filePath));
}


test("LLM request prompt follows the selected Spanish and Korean languages", async () => {
	let prompt = "";
	__setRequestUrl(async (params: { body: string }) => {
		prompt = JSON.parse(params.body).messages[0].content;
		return { status: 200, json: { message: { content: "안녕하세요" } } };
	});
	const service = new TranslatorService(() => ({ ...SETTINGS, customPrompt: DEFAULT_TRANSLATION_PROMPT }));
	await service.translate({ text: "Hola", sourceLanguage: "es", targetLanguage: "ko", allowedSourceLanguages: ["es", "ko"] });
	assert.match(prompt, /Translate from Spanish to Korean/);
	assert.doesNotMatch(prompt, /\{sourceLanguage\}|\{targetLanguage\}/);
});

test("automatic Persian translation preserves custom prompt and resolves language placeholders", async () => {
	let prompt = "";
	__setRequestUrl(async (params: { body: string }) => {
		prompt = JSON.parse(params.body).messages[0].content;
		return { status: 200, json: { message: { content: "سلام" } } };
	});
	const service = new TranslatorService(() => ({ ...SETTINGS, customPrompt: "Formal tone for {targetLanguage}." }));
	await service.translate({ text: "Hello", sourceLanguage: "auto", targetLanguage: "fa", allowedSourceLanguages: ["fa"] });
	assert.match(prompt, /Formal tone for Persian \(Farsi\)/);
	assert.match(prompt, /Source language: auto-detected language/);
});

test("translation history is a searchable, time-sorted source map", async () => {
	const files = new Map<string, string>();
	const adapter = {
		read: async (path: string) => files.get(path) ?? null,
		write: async (path: string, data: string) => {
			files.set(path, data);
		},
	};
	const history = new TranslationHistory(adapter, "history.json");
	await history.load();
	history.record("Hello", "你好", "en", "zh-Hans", 1000);
	history.record("World", "世界", "en", "zh-Hans", 2000);
	history.record("Hello", "您好", "en", "zh-Hans", 3000);

	assert.deepEqual(
		history.getItems("", "time-desc").map((item) => [item.sourceText, item.translatedText, item.timestamp]),
		[["Hello", "您好", 3000], ["World", "世界", 2000]],
	);
	assert.deepEqual(history.getItems("世界", "time-asc").map((item) => item.sourceText), ["World"]);
	assert.deepEqual(history.getItems("hello", "time-asc").map((item) => item.sourceText), ["Hello"]);


	const sortable = new TranslationHistory(adapter, "sort.json");
	sortable.record("Charlie", "Zulu", "en", "zh-Hans", 4000);
	sortable.record("Alpha", "Yankee", "en", "zh-Hans", 3000);
	sortable.record("Bravo", "Xray", "en", "zh-Hans", 2000);
	assert.deepEqual(sortable.getItems("", "source-asc").map((item) => item.sourceText), ["Alpha", "Bravo", "Charlie"]);
	assert.deepEqual(sortable.getItems("", "source-desc").map((item) => item.sourceText), ["Charlie", "Bravo", "Alpha"]);
	assert.deepEqual(sortable.getItems("", "translation-asc").map((item) => item.translatedText), ["Xray", "Yankee", "Zulu"]);
	assert.deepEqual(sortable.getItems("", "translation-desc").map((item) => item.translatedText), ["Zulu", "Yankee", "Xray"]);

	await history.flush();
	const stored = JSON.parse(files.get("history.json") ?? "{}") as Record<string, { translation: string }>;
	assert.equal(stored.Hello.translation, "您好");

	const reloaded = new TranslationHistory(adapter, "history.json");
	await reloaded.load();
	assert.equal(reloaded.size, 2);
	assert.equal(reloaded.getItems("", "time-desc")[0].sourceText, "Hello");

	files.set("broken.json", "{not json");
	const broken = new TranslationHistory(adapter, "broken.json");
	await broken.load();
	assert.equal(broken.size, 0);
});

test("manual translate pointerup and click trigger one deferred action", async () => {
	const popup = Object.create(TranslationPopup.prototype) as unknown as Record<string, any>;
	const button: Record<string, any> = { onClickEvent(handler: unknown) { this.click = handler; } };
	let calls = 0;
	popup.manualActionsOnly = true;
	popup.languageEl = { empty() {}, createEl: () => button };
	popup.options = { onTranslate: () => calls++ };
	popup.renderLanguageControls();
	const event = { button: 0, preventDefault() {}, stopPropagation() {} };
	button.onpointerdown(event);
	button.onpointerup(event);
	button.click(event);
	assert.equal(calls, 0);
	await nextTask();
	assert.equal(calls, 1);
});
