import type { TranslationLanguage } from "./types";

export interface LanguageOption<T extends TranslationLanguage = TranslationLanguage> {
	value: T;
	/** Compact code shown in narrow popups, e.g. "EN". */
	code: string;
	/** Full label key used by the sidebar and settings. */
	labelKey: string;
}

export const TARGET_LANGUAGES: Array<LanguageOption<Exclude<TranslationLanguage, "auto">>> = [
	{ value: "en", code: "EN", labelKey: "language.english" },
	{ value: "fr", code: "FR", labelKey: "language.french" },
	{ value: "de", code: "DE", labelKey: "language.german" },
	{ value: "ja", code: "JA", labelKey: "language.japanese" },
	{ value: "ko", code: "KO", labelKey: "language.korean" },
	{ value: "fa", code: "FA", labelKey: "language.persian" },
	{ value: "zh-Hans", code: "ZH", labelKey: "language.chinese" },
	{ value: "es", code: "ES", labelKey: "language.spanish" },
	{ value: "tr", code: "TR", labelKey: "language.turkish" },
];

export const SOURCE_LANGUAGES: Array<LanguageOption<TranslationLanguage>> = [
	{ value: "auto", code: "Auto", labelKey: "language.auto" },
	...TARGET_LANGUAGES,
];
