# Changelog

## 0.6.1

### Added

- Separate Copy source and Copy translation icon buttons in the selection popup, each labeled for its direction.

### Fixed

- The selection popup Close button now activates on pointerup as well as click, and an explicit close is no longer undone by the still-selected text being translated again. Reselecting after an outside click still translates normally.

## 0.6.0

### Added

- A draggable, edge-snapping floating ball with an accent-tinted badge icon. Clicking it opens an independent manual translation window (source/target selects, swap, textarea, manual Translate button, result, copy, add-to-note, history and sidebar shortcuts). The ball keeps its docked edge when the window shrinks and is expanded again.
- Translation history stored in a standalone `history.json` object map (source text → translation, source/target language, time). The sidebar and the ball window each have a History button; the sidebar switches to a history view with an `arrow-left` back button, search, and sorting by time, source first letter or translation first letter in both directions.
- Selection translation scope: All views (including plugin views), Documents only (PDF and Markdown), or Never. This replaces the auto-translate toggle and the PDF-only scope; the setting includes an explanatory description and the sidebar exposes the same three-way select.
- Translation note location can be a folder (one note per source file) or a single note, selected from settings.

### Changed

- Selection translation now reads selections from generic plugin views under the All views scope (verified with RSS Dashboard articles). PDF highlight actions are hidden for non-PDF selections.
- The sidebar adapts to narrow panes with container queries and wrapping; "Add to note" moved to the end of the selection-scope row.
- Language selectors label the source and target direction; the translate and history headers share an accent-bordered title badge.
- The floating ball size scales with the viewport and the icon is smaller.

### Fixed

- Tablet icons collapsing to zero width because Obsidian's `.is-tablet button:not(.clickable-icon)` padding was applied to custom icon buttons.
- Touch taps on the ball and icon buttons being swallowed by `pointerdown` cancellation.
- The mobile right sidebar opening without mounting its leaf (now uses `workspace.revealLeaf`).
- The floating ball remaining off-screen after a viewport change, and losing its docked edge after shrinking and re-expanding.
- The close button becoming unreachable when a popup header overflowed at narrow widths.
