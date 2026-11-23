import { setIcon } from "obsidian";
import { t } from "./i18n";
import type { FloatingBallPosition, FloatingBallSnap } from "./types";

/** Keep the ball fully reachable when it is dragged, snapped or resized. */
const BALL_MARGIN = 8;
/** Releasing a drag this close to an edge docks the ball to that edge. */
const EDGE_SNAP_DISTANCE = 48;
/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD = 4;
const KEYBOARD_MOVE_STEP = 15;
const POSITION_SAVE_DELAY_MS = 400;
const DEFAULT_INSET = 16;
/** Default sits above Obsidian's mobile bottom bar. */
const DEFAULT_BOTTOM_INSET = 96;
/** Ignore the synthetic click that follows a drag release. */
const CLICK_AFTER_DRAG_MS = 300;

interface DragState {
	pointerId: number;
	offsetX: number;
	offsetY: number;
	startX: number;
	startY: number;
	moved: boolean;
}

export interface FloatingBallOptions {
	position: FloatingBallPosition | null;
	snap: FloatingBallSnap | null;
	/** Click / Enter / Space: open the translation window. */
	onToggle: () => void;
	/** Called continuously while the ball moves so the window can follow. */
	onMove: (position: FloatingBallPosition) => void;
	/** Called when the position and its docked edges should be persisted. */
	onPositionChange: (position: FloatingBallPosition, snap: FloatingBallSnap) => void;
}

/**
 * A draggable, edge-snapping ball that summons the translation window.
 * The ball owns the spatial interaction; the window itself is not draggable.
 */
export class FloatingBall {
	private rootEl: HTMLButtonElement;
	private position: FloatingBallPosition | null;
	private snappedEdges: FloatingBallSnap;
	private dragState: DragState | null = null;
	private lastDragEnd = 0;
	private suppressClickUntil = 0;
	private saveTimer: number | undefined;
	private viewportObserver: ResizeObserver;
	private resizeHandler = () => {
		this.applyViewportPosition();
	};

	constructor(private options: FloatingBallOptions) {
		this.position = options.position;
		this.snappedEdges = { horizontal: null, vertical: null };
		this.rootEl = window.document.body.createEl("button", {
			cls: "pdf-ollama-translator-ball clickable-icon",
			attr: {
				type: "button",
				"aria-label": t("ball.open"),
				title: t("ball.open"),
			},
		});
		setIcon(this.rootEl, "languages");
		this.rootEl.onpointerdown = (event) => this.startDrag(event);
		this.rootEl.onpointermove = (event) => this.moveDrag(event);
		this.rootEl.onpointerup = (event) => this.finishDrag(event, true);
		this.rootEl.onpointercancel = (event) => this.finishDrag(event, false);
		this.rootEl.onlostpointercapture = (event) => this.finishDrag(event, false);
		this.rootEl.onkeydown = (event) => this.moveWithKeyboard(event);
		this.rootEl.onClickEvent((event) => {
			// Pointer taps activate from pointerup; this click is the synthetic
			// follow-up (or a keyboard activation, which has no pointerup).
			if (Date.now() < this.suppressClickUntil) {
				return;
			}
			if (Date.now() - this.lastDragEnd < CLICK_AFTER_DRAG_MS) {
				return;
			}
			event.stopPropagation();
			this.options.onToggle();
		});
		this.getWindow().addEventListener("resize", this.resizeHandler);
		this.getWindow().visualViewport?.addEventListener("resize", this.resizeHandler);
		// CDP/emulation and mobile rotation can change the layout without a
		// window resize event; clamp the ball back into view either way.
		this.viewportObserver = new ResizeObserver(() => this.resizeHandler());
		this.viewportObserver.observe(this.rootEl.ownerDocument.documentElement);
		this.snappedEdges = options.snap ?? this.inferSnap(options.position);
		if (this.snappedEdges.horizontal || this.snappedEdges.vertical) {
			this.applyViewportPosition();
		} else {
			this.applyPosition(this.position ?? this.getDefaultPosition());
		}
	}

	getRect(): DOMRect {
		return this.rootEl.getBoundingClientRect();
	}

	/** Re-clamp after a viewport change that did not fire a resize event. */
	ensureVisible(): void {
		this.applyViewportPosition();
	}

	getDocument(): Document {
		return this.rootEl.ownerDocument;
	}

	destroy(): void {
		this.getWindow().removeEventListener("resize", this.resizeHandler);
		this.getWindow().visualViewport?.removeEventListener("resize", this.resizeHandler);
		this.viewportObserver.disconnect();
		this.getWindow().clearTimeout(this.saveTimer);
		this.rootEl.remove();
	}

	private getWindow(): Window {
		return this.rootEl.ownerDocument.defaultView ?? window;
	}

	private getDefaultPosition(): FloatingBallPosition {
		const window = this.getWindow();
		const rect = this.rootEl.getBoundingClientRect();
		const size = rect.width || 48;
		return {
			x: window.innerWidth - size - DEFAULT_INSET,
			y: window.innerHeight - size - DEFAULT_BOTTOM_INSET,
		};
	}

	private getCurrentPosition(): FloatingBallPosition {
		const rect = this.rootEl.getBoundingClientRect();
		return { x: rect.left, y: rect.top };
	}

	/** Discover a docked edge from a position saved before snap state existed. */
	private inferSnap(position: FloatingBallPosition | null): FloatingBallSnap {
		if (!position) {
			return { horizontal: null, vertical: null };
		}
		const window = this.getWindow();
		const rect = this.rootEl.getBoundingClientRect();
		const size = rect.width || 48;
		const maxLeft = Math.max(BALL_MARGIN, window.innerWidth - size - BALL_MARGIN);
		const maxTop = Math.max(BALL_MARGIN, window.innerHeight - size - BALL_MARGIN);
		return {
			horizontal: position.x <= BALL_MARGIN + 2
				? "left"
				: position.x >= maxLeft - 2 ? "right" : null,
			vertical: position.y <= BALL_MARGIN + 2
				? "top"
				: position.y >= maxTop - 2 ? "bottom" : null,
		};
	}

	/**
	 * Recompute a docked edge from the current viewport. This is what keeps the
	 * ball on the edge when the window shrinks and is expanded again.
	 */
	private applyViewportPosition(): void {
		const window = this.getWindow();
		const rect = this.rootEl.getBoundingClientRect();
		const size = rect.width || 48;
		const base = this.position ?? this.getDefaultPosition();
		const left = this.snappedEdges.horizontal === "right"
			? window.innerWidth - size - BALL_MARGIN
			: this.snappedEdges.horizontal === "left"
				? BALL_MARGIN
				: base.x;
		const top = this.snappedEdges.vertical === "bottom"
			? window.innerHeight - size - BALL_MARGIN
			: this.snappedEdges.vertical === "top"
				? BALL_MARGIN
				: base.y;
		this.applyPosition({ x: left, y: top });
	}

	/** Clamp a desired top-left position so the whole ball stays on screen. */
	private applyPosition(position: FloatingBallPosition): FloatingBallPosition {
		const window = this.getWindow();
		const rect = this.rootEl.getBoundingClientRect();
		const size = rect.width || 48;
		const maxLeft = Math.max(BALL_MARGIN, window.innerWidth - size - BALL_MARGIN);
		const maxTop = Math.max(BALL_MARGIN, window.innerHeight - size - BALL_MARGIN);
		const left = clamp(position.x, BALL_MARGIN, maxLeft);
		const top = clamp(position.y, BALL_MARGIN, maxTop);
		this.rootEl.style.left = `${Math.round(left)}px`;
		this.rootEl.style.top = `${Math.round(top)}px`;
		this.position = { x: Math.round(left), y: Math.round(top) };
		return this.position;
	}

	private startDrag(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const rect = this.rootEl.getBoundingClientRect();
		this.dragState = {
			pointerId: event.pointerId,
			offsetX: event.clientX - rect.left,
			offsetY: event.clientY - rect.top,
			startX: event.clientX,
			startY: event.clientY,
			moved: false,
		};
		this.rootEl.setPointerCapture(event.pointerId);
		this.rootEl.addClass("is-dragging");
	}

	private moveDrag(event: PointerEvent): void {
		const state = this.dragState;
		if (!state || event.pointerId !== state.pointerId) {
			return;
		}
		if (!state.moved) {
			const dx = event.clientX - state.startX;
			const dy = event.clientY - state.startY;
			if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
				return;
			}
			state.moved = true;
		}
		const next = this.applyPosition({
			x: event.clientX - state.offsetX,
			y: event.clientY - state.offsetY,
		});
		this.options.onMove(next);
	}

	private finishDrag(event: PointerEvent, allowToggle: boolean): void {
		const state = this.dragState;
		if (!state || event.pointerId !== state.pointerId) {
			return;
		}
		this.dragState = null;
		this.rootEl.removeClass("is-dragging");
		if (this.rootEl.hasPointerCapture(event.pointerId)) {
			this.rootEl.releasePointerCapture(event.pointerId);
		}
		if (!state.moved) {
			// Touch taps can suppress the compatibility click; activate here.
			if (allowToggle) {
				this.suppressClickUntil = Date.now() + 500;
				this.options.onToggle();
			}
			return;
		}
		this.lastDragEnd = Date.now();
		const next = this.applyPosition(this.snapToEdges());
		this.options.onMove(next);
		this.options.onPositionChange(next, { ...this.snappedEdges });
	}

	/** Dock the ball to any viewport edge it was released close to. */
	private snapToEdges(): FloatingBallPosition {
		const window = this.getWindow();
		const rect = this.rootEl.getBoundingClientRect();
		const maxLeft = Math.max(BALL_MARGIN, window.innerWidth - rect.width - BALL_MARGIN);
		const maxTop = Math.max(BALL_MARGIN, window.innerHeight - rect.height - BALL_MARGIN);
		let left = rect.left;
		let top = rect.top;
		let horizontal: FloatingBallSnap["horizontal"] = null;
		let vertical: FloatingBallSnap["vertical"] = null;

		if (left <= BALL_MARGIN + EDGE_SNAP_DISTANCE) {
			left = BALL_MARGIN;
			horizontal = "left";
		} else if (left >= maxLeft - EDGE_SNAP_DISTANCE) {
			left = maxLeft;
			horizontal = "right";
		}
		if (top <= BALL_MARGIN + EDGE_SNAP_DISTANCE) {
			top = BALL_MARGIN;
			vertical = "top";
		} else if (top >= maxTop - EDGE_SNAP_DISTANCE) {
			top = maxTop;
			vertical = "bottom";
		}
		this.snappedEdges = { horizontal, vertical };
		return { x: left, y: top };
	}

	private moveWithKeyboard(event: KeyboardEvent): void {
		const step = event.shiftKey ? KEYBOARD_MOVE_STEP * 4 : KEYBOARD_MOVE_STEP;
		let dx = 0;
		let dy = 0;
		switch (event.key) {
			case "ArrowLeft": dx = -step; break;
			case "ArrowRight": dx = step; break;
			case "ArrowUp": dy = -step; break;
			case "ArrowDown": dy = step; break;
			default: return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (dx !== 0) {
			this.snappedEdges = { ...this.snappedEdges, horizontal: null };
		}
		if (dy !== 0) {
			this.snappedEdges = { ...this.snappedEdges, vertical: null };
		}
		const current = this.getCurrentPosition();
		const next = this.applyPosition({ x: current.x + dx, y: current.y + dy });
		this.options.onMove(next);
		this.getWindow().clearTimeout(this.saveTimer);
		this.saveTimer = this.getWindow().setTimeout(
			() => this.options.onPositionChange(next, { ...this.snappedEdges }),
			POSITION_SAVE_DELAY_MS,
		);
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
