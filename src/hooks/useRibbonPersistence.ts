import { useEffect } from "react";
import { getBaselineWorkspace, getEditableWorkspace, useRibbonStore } from "@/store/ribbonStore";
import { useRuntimeLogStore } from "@/store/runtimeLogStore";
import type { RibbonDraft, RibbonWorkspace } from "@/types/workspace";
import { minimizeDraftSource } from "@/utils/draftSource";

/** Encode, rather than replace, path characters so different organizations cannot share a draft. */
function buildKey(orgUrl: string, entityLogicalName: string, solutionUniqueName: string, userId = ""): string {
	return `cbs:ribbon:v2:${[orgUrl.replace(/\/+$/, ""), userId, solutionUniqueName, entityLogicalName].map(encodeURIComponent).join(":")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspace(value: unknown): value is RibbonWorkspace {
	if (!isRecord(value) || !isRecord(value.ribbons)) return false;
	if (!["commands", "displayRules", "enableRules", "locLabels"].every((key) => Array.isArray(value[key]))) return false;
	return ["HomepageGrid", "SubGrid", "Form", "Application"].every((key) => {
		const ribbon = (value.ribbons as Record<string, unknown>)[key];
		return isRecord(ribbon) && ribbon.location === key && typeof ribbon.entityLogicalName === "string" && Array.isArray(ribbon.tabs);
	});
}

/** Legacy drafts lack source/baseline identity and are deliberately not silently restored. */
export function loadPersistedRibbonData(
	orgUrl: string,
	entityLogicalName: string,
	solutionUniqueName = "",
	userId = "",
): RibbonDraft | null {
	if (!orgUrl || !entityLogicalName || !solutionUniqueName) return null;
	try {
		const raw = localStorage.getItem(buildKey(orgUrl, entityLogicalName, solutionUniqueName, userId));
		if (!raw || raw.length > 16 * 1024 * 1024) return null;
		const draft: unknown = JSON.parse(raw);
		if (!isRecord(draft) || draft.version !== 2 || !isWorkspace(draft.current) || !isWorkspace(draft.baseline) ||
			!isRecord(draft.sourceSnapshot) || typeof draft.savedAt !== "string") return null;
		const source = draft.sourceSnapshot;
		if ((source.userId ?? "") !== userId) return null;
		if (source.organizationUrl !== orgUrl.replace(/\/+$/, "") || source.solutionUniqueName !== solutionUniqueName ||
			source.entityLogicalName !== entityLogicalName || typeof source.entityRibbonXml !== "string" ||
			typeof source.solutionXml !== "string" || typeof source.customizationsXml !== "string" ||
			(source.applicationRibbonXml !== null && typeof source.applicationRibbonXml !== "string")) return null;
		return draft as unknown as RibbonDraft;
	} catch {
		return null;
	}
}

/** Call for this exact identity only after verified publication or an explicit discard. */
export function clearPersistedRibbonData(orgUrl: string, entityLogicalName: string, solutionUniqueName = "", userId = ""): void {
	if (!orgUrl || !entityLogicalName || !solutionUniqueName) return;
	try {
		localStorage.removeItem(buildKey(orgUrl, entityLogicalName, solutionUniqueName, userId));
	} catch (error) {
		useRuntimeLogStore.getState().logWarn("persistence", `Could not remove the saved draft: ${String(error)}`);
	}
}

/** Source-bound persistence: selecting a new entity never redirects the previous entity's state. */
export function useRibbonPersistence(): void {
	useEffect(() => useRibbonStore.subscribe((state, previous) => {
		const source = state.sourceSnapshot;
		if (!source?.organizationUrl) return;
		const key = buildKey(source.organizationUrl, source.entityLogicalName, source.solutionUniqueName, source.userId);
		if (state.mutationsSincePublish === 0) {
			// Undoing back to the same baseline can discard that draft. Loading a new
			// baseline or receiving publish completion must not delete another saved draft.
			if (previous.mutationsSincePublish > 0 && state.baseline === previous.baseline && source === previous.sourceSnapshot) {
				clearPersistedRibbonData(source.organizationUrl, source.entityLogicalName, source.solutionUniqueName, source.userId);
			}
			return;
		}
		const current = getEditableWorkspace(state);
		if (current.ribbons.Form.entityLogicalName !== source.entityLogicalName) return;
		const draft: RibbonDraft = {
			version: 2, current, baseline: getBaselineWorkspace(state), sourceSnapshot: minimizeDraftSource(source), savedAt: new Date().toISOString(),
		};
		try {
			localStorage.setItem(key, JSON.stringify(draft));
		} catch (error) {
			useRuntimeLogStore.getState().logWarn("persistence", `Draft could not be saved locally. Keep this window open and download the changes before leaving: ${String(error)}`);
		}
	}), []);
}
