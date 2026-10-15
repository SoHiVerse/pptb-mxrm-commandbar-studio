import { useEffect, useRef } from "react";
import { useUIStore } from "@/store/uiStore";
import { useRibbonStore } from "@/store/ribbonStore";
import { useSelectionStore } from "@/store/selectionStore";

export function useKeyboardShortcuts() {
	const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
	const openBulkPublish = useUIStore((s) => s.openBulkPublish);
	const announce = useUIStore((s) => s.announce);
	const undo = useRibbonStore((s) => s.undo);
	const redo = useRibbonStore((s) => s.redo);
	const past = useRibbonStore((s) => s.past);
	const future = useRibbonStore((s) => s.future);
	const selectedButtonId = useSelectionStore((s) => s.selectedButtonId);
	const selectedGroupId = useSelectionStore((s) => s.selectedGroupId);
	const selectedTabId = useSelectionStore((s) => s.tabId);
	const activeLocation = useSelectionStore((s) => s.location);
	const duplicateButton = useRibbonStore((s) => s.duplicateButton);
	const deleteButton = useRibbonStore((s) => s.deleteButton);
	const moveButton = useRibbonStore((s) => s.moveButton);
	const ribbons = useRibbonStore((s) => s.ribbons);
	const selectButtonInContext = useSelectionStore((s) => s.selectButtonInContext);
	const selectGroup = useSelectionStore((s) => s.selectGroup);

	const cutBufferRef = useRef<{
		location: typeof activeLocation;
		tabId: string;
		groupId: string;
		buttonId: string;
	} | null>(null);

	useEffect(() => {
		const isEditableTarget = (target: HTMLElement) =>
			target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

		const handler = (e: KeyboardEvent) => {
			if (useRibbonStore.getState().workspaceReadOnly) return;
			const isMac = navigator.platform.toUpperCase().includes("MAC");
			const ctrl = isMac ? e.metaKey : e.ctrlKey;
			const target = e.target as HTMLElement;

			// Command palette: Ctrl+K / Cmd+K
			if (ctrl && e.key === "k") {
				e.preventDefault();
				setCommandPaletteOpen(true);
				announce("Command palette opened");
				return;
			}

			// Save / Publish: Ctrl+S / Cmd+S
			if (ctrl && e.key === "s") {
				e.preventDefault();
				openBulkPublish();
				announce("Bulk publish dialog opened");
				return;
			}

			// Undo: Ctrl+Z / Cmd+Z
			if (ctrl && e.key === "z" && !e.shiftKey && past.length > 0) {
				e.preventDefault();
				undo();
				announce("Undo");
				return;
			}

			// Redo: Ctrl+Shift+Z / Cmd+Shift+Z or Ctrl+Y
			if ((ctrl && e.key === "y") || (ctrl && e.shiftKey && e.key === "z")) {
				e.preventDefault();
				if (future.length > 0) {
					redo();
					announce("Redo");
				}
				return;
			}

			// Duplicate: Ctrl+D / Cmd+D
			if (ctrl && e.key === "d") {
				if (selectedButtonId && selectedGroupId && selectedTabId && activeLocation) {
					e.preventDefault();
					duplicateButton(activeLocation, selectedTabId, selectedGroupId, selectedButtonId);
					announce("Button duplicated");
				}
				return;
			}

			// Cut button: Ctrl+X / Cmd+X
			if (ctrl && e.key.toLowerCase() === "x") {
				if (
					!isEditableTarget(target) &&
					selectedButtonId &&
					selectedGroupId &&
					selectedTabId &&
					activeLocation
				) {
					e.preventDefault();
					cutBufferRef.current = {
						location: activeLocation,
						tabId: selectedTabId,
						groupId: selectedGroupId,
						buttonId: selectedButtonId,
					};
					announce("Button cut. Focus a destination group, then press paste.");
				}
				return;
			}

			// Paste cut button into focused/selected group: Ctrl+V / Cmd+V
			if (ctrl && e.key.toLowerCase() === "v") {
				const cut = cutBufferRef.current;
				if (
					!isEditableTarget(target) &&
					cut &&
					selectedGroupId &&
					selectedTabId &&
					activeLocation
				) {
					e.preventDefault();
					moveButton(
						{
							groupId: cut.groupId,
							buttonId: cut.buttonId,
							tabId: cut.tabId,
							location: cut.location,
						},
						{
							groupId: selectedGroupId,
							tabId: selectedTabId,
							location: activeLocation,
						},
					);
					requestAnimationFrame(() => {
						selectButtonInContext(activeLocation, selectedTabId, selectedGroupId, cut.buttonId);
						const targetTile = document.querySelector<HTMLButtonElement>(
							`[data-ribbon-btn-id="${cut.buttonId}"]`,
						);
						targetTile?.focus();
					});
					cutBufferRef.current = null;
					announce("Button pasted to destination group.");
				}
				return;
			}

			// Delete: Delete / Backspace (when canvas focused and button selected)
			if (
				(e.key === "Delete" || e.key === "Backspace") &&
				selectedButtonId &&
				selectedGroupId &&
				selectedTabId &&
				activeLocation
			) {
				if (!isEditableTarget(target)) {
					const activeTab = ribbons[activeLocation].tabs.find((t) => t.id === selectedTabId);
					const orderedButtons =
						activeTab?.groups.flatMap((group) =>
							group.buttons.map((button) => ({ groupId: group.id, buttonId: button.id })),
						) ?? [];
					const deletedIndex = orderedButtons.findIndex((btn) => btn.buttonId === selectedButtonId);
					const nextTarget =
						orderedButtons[deletedIndex + 1] ?? orderedButtons[deletedIndex - 1] ?? null;
					const fallbackGroupId = selectedGroupId;

					e.preventDefault();
					deleteButton(activeLocation, selectedTabId, selectedGroupId, selectedButtonId);
					requestAnimationFrame(() => {
						if (nextTarget) {
							selectButtonInContext(
								activeLocation,
								selectedTabId,
								nextTarget.groupId,
								nextTarget.buttonId,
							);
							const nextTile = document.querySelector<HTMLButtonElement>(
								`[data-ribbon-btn-id="${nextTarget.buttonId}"]`,
							);
							nextTile?.focus();
							return;
						}

						if (fallbackGroupId) {
							selectGroup(fallbackGroupId);
							const addButton = document.querySelector<HTMLButtonElement>(
								`[data-add-btn-group-id="${fallbackGroupId}"]`,
							);
							addButton?.focus();
						}
					});
					announce("Button deleted");
				}
			}

			// Escape: close command palette
			if (e.key === "Escape") {
				setCommandPaletteOpen(false);
			}
		};

		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [
		setCommandPaletteOpen,
		openBulkPublish,
		announce,
		undo,
		redo,
		past.length,
		future.length,
		selectedButtonId,
		selectedGroupId,
		selectedTabId,
		activeLocation,
		duplicateButton,
		deleteButton,
		moveButton,
		ribbons,
		selectButtonInContext,
		selectGroup,
	]);
}
