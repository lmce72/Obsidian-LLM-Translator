import { TFolder, TFile, normalizePath, type App } from "obsidian";
import { t } from "./i18n";
import { getHighlightColor } from "./pdfHighlight/colors";
import type { HighlightColorId, NoteTargetKind, PdfTextSelection } from "./types";

export interface TranslationNoteSnapshot {
	sourceText: string;
	translatedText: string;
	file?: TFile;
	pageHint?: number;
	selection?: PdfTextSelection;
	highlightColor?: HighlightColorId;
}

export interface TranslationNoteTarget {
	kind: NoteTargetKind;
	path: string;
}

export async function appendTranslationNote(
	app: App,
	snapshot: TranslationNoteSnapshot,
	target: TranslationNoteTarget,
	confirmCreate: (path: string) => Promise<boolean>,
): Promise<string | null> {
	if (!snapshot.sourceText.trim() || !snapshot.translatedText.trim()) {
		throw new Error(t("note.emptyTranslation"));
	}
	const sourceFile = snapshot.file ?? app.workspace.getActiveFile();
	if (!sourceFile) {
		throw new Error(t("note.sourceRequired"));
	}

	const isSingleNote = target.kind === "note";
	let path: string;
	if (isSingleNote) {
		if (!target.path.trim()) {
			throw new Error(t("note.invalidTarget"));
		}
		path = normalizePath(target.path);
	} else if (target.kind === "folder") {
		const folderPath = target.path.trim();
		const folder = folderPath ? app.vault.getAbstractFileByPath(folderPath) : null;
		if (!(folder instanceof TFolder)) {
			throw new Error(t("note.invalidTarget"));
		}
		path = normalizePath(`${folderPath}/${sourceFile.name}-Translation-Note.md`);
	} else {
		path = normalizePath(`${sourceFile.parent?.path ?? ""}/${sourceFile.name}-Translation-Note.md`);
	}
	const marker = `<!-- llm-translator-source: ${encodeURIComponent(sourceFile.path)} -->`;
	const borderColor = getHighlightColor(snapshot.highlightColor ?? "blue").css;
	const sourceHref = escapeHtml(`${sourceFile.path}${snapshot.pageHint ? `#page=${snapshot.pageHint}` : ""}`);
	const source = `${t("note.source")}: <a class="internal-link" href="${sourceHref}">${escapeHtml(sourceFile.name)}</a>`
		+ (snapshot.pageHint ? ` · ${t("note.page", { page: snapshot.pageHint })}` : "");
	const entry = [
		`<table style="width:100%;border:2px solid ${borderColor};border-collapse:collapse">`,
		`<tr><td style="padding:8px">${toHtml(snapshot.sourceText)}</td></tr>`,
		`<tr><td style="padding:8px;border-top:1px solid rgba(128,128,128,.35)">${toHtml(snapshot.translatedText)}</td></tr>`,
		`<tr><td style="padding:8px;border-top:1px solid rgba(128,128,128,.35);text-align:right"><small>${source}</small></td></tr>`,
		"</table>",
	].join("\n");
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing) {
		if (!(existing instanceof TFile) || existing.extension.toLowerCase() !== "md") {
			throw new Error(t("note.invalidTarget"));
		}
		await app.vault.process(existing, (content) => {
			if (!isSingleNote && !content.startsWith(`${marker}\n`)) {
				throw new Error(t("note.pathConflict"));
			}
			return `${content}${content ? "\n\n" : ""}${entry}\n`;
		});
		return path;
	}
	if (isSingleNote) throw new Error(t("note.invalidTarget"));
	if (!await confirmCreate(path)) return null;
	await app.vault.create(path, `${marker}\n\n${entry}\n`);
	return path;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function toHtml(text: string): string {
	return escapeHtml(text).replace(/\r\n?|\n/g, "<br>");
}
