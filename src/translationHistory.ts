import type { TranslationLanguage } from "./types";

/**
 * Translation history.
 *
 * The on-disk file (history.json) is a plain object map keyed by the source
 * text, e.g.:
 *   { "Hello": { "translation": "你好", "sourceLanguage": "en",
 *                "targetLanguage": "zh-Hans", "time": 1760000000000 } }
 * The same source text updates its entry and moves it to the top by time.
 */

export interface TranslationHistoryRecord {
	sourceText: string;
	translatedText: string;
	sourceLanguage: TranslationLanguage;
	targetLanguage: Exclude<TranslationLanguage, "auto">;
	timestamp: number;
}

export interface TranslationHistoryAdapter {
	read(path: string): Promise<string | null>;
	write(path: string, data: string): Promise<void>;
}

interface StoredEntry {
	translation: string;
	sourceLanguage: TranslationLanguage;
	targetLanguage: Exclude<TranslationLanguage, "auto">;
	time: number;
}

const MAX_ENTRIES = 2000;
const LANGUAGE_VALUES = new Set<string>(["auto", "en", "de", "fr", "tr", "ja", "zh-Hans", "fa", "es", "ko"]);
const TARGET_VALUES = new Set<string>([...LANGUAGE_VALUES].filter((value) => value !== "auto"));

export class TranslationHistory {
	private entries = new Map<string, StoredEntry>();
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		private adapter: TranslationHistoryAdapter,
		private filePath: string,
	) {}

	/** Missing or corrupted files are tolerated and yield an empty history. */
	async load(): Promise<void> {
		try {
			const raw = await this.adapter.read(this.filePath);
			if (!raw) {
				return;
			}
			const parsed = JSON.parse(raw) as unknown;
			if (!parsed || typeof parsed !== "object") {
				return;
			}
			for (const [sourceText, value] of Object.entries(parsed as Record<string, unknown>)) {
				const entry = parseEntry(value);
				if (entry) {
					this.entries.set(sourceText, entry);
				}
			}
		} catch {
			// Corrupted file or read error: start with an empty history.
		}
	}

	record(
		sourceText: string,
		translatedText: string,
		sourceLanguage: TranslationLanguage,
		targetLanguage: Exclude<TranslationLanguage, "auto">,
		time: number = Date.now(),
	): void {
		const source = sourceText.trim();
		const translation = translatedText.trim();
		if (!source || !translation) {
			return;
		}
		this.entries.set(source, { translation, sourceLanguage, targetLanguage, time });
		this.prune();
		this.persist();
	}

	/** Newest-first by default; query matches the source or translation. */
	getItems(query = "", sort: "asc" | "desc" = "desc"): TranslationHistoryRecord[] {
		const needle = query.trim().toLowerCase();
		const items: TranslationHistoryRecord[] = [];
		for (const [sourceText, entry] of this.entries) {
			if (needle
				&& !sourceText.toLowerCase().includes(needle)
				&& !entry.translation.toLowerCase().includes(needle)) {
				continue;
			}
			items.push({
				sourceText,
				translatedText: entry.translation,
				sourceLanguage: entry.sourceLanguage,
				targetLanguage: entry.targetLanguage,
				timestamp: entry.time,
			});
		}
		items.sort((a, b) => sort === "asc" ? a.timestamp - b.timestamp : b.timestamp - a.timestamp);
		return items;
	}

	flush(): Promise<void> {
		return this.writeQueue;
	}

	get size(): number {
		return this.entries.size;
	}

	private prune(): void {
		if (this.entries.size <= MAX_ENTRIES) {
			return;
		}
		const oldest = [...this.entries.entries()].sort((a, b) => a[1].time - b[1].time);
		for (let index = 0; index < oldest.length - MAX_ENTRIES; index += 1) {
			this.entries.delete(oldest[index][0]);
		}
	}

	private persist(): void {
		this.writeQueue = this.writeQueue
			.catch(() => undefined)
			.then(() => this.adapter.write(this.filePath, JSON.stringify(Object.fromEntries(this.entries), null, 2)));
		this.writeQueue.catch(() => undefined);
	}
}

function parseEntry(value: unknown): StoredEntry | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const { translation, sourceLanguage, targetLanguage, time } = value as Record<string, unknown>;
	if (typeof translation !== "string" || !translation.trim()) {
		return null;
	}
	if (typeof sourceLanguage !== "string" || !LANGUAGE_VALUES.has(sourceLanguage)) {
		return null;
	}
	if (typeof targetLanguage !== "string" || !TARGET_VALUES.has(targetLanguage)) {
		return null;
	}
	if (typeof time !== "number" || !Number.isFinite(time)) {
		return null;
	}
	return {
		translation,
		sourceLanguage: sourceLanguage as TranslationLanguage,
		targetLanguage: targetLanguage as Exclude<TranslationLanguage, "auto">,
		time,
	};
}
