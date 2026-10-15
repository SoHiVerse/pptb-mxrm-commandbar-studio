import { canonicalizeXml } from "@/services/ribbonMerge";
import type { RibbonDelta } from "@/types/workspace";

export function parseVerifiedXml(xml: string, label: string): Document {
	if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(`${label} contains an unsupported XML declaration.`);
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	if (doc.querySelector("parsererror")) throw new Error(`${label} is not valid XML.`);
	return doc;
}

/** Formatting and XML attribute order are immaterial; meaningful node order is not. */
export function assertStoredRibbon(expected: string, actual: string, label: string): void {
	if (canonicalizeXml(expected) !== canonicalizeXml(actual)) {
		throw new Error(`${label} read-back verification did not match the complete intended unmanaged ribbon. Edits remain unsaved.`);
	}
}

/** Verify the platform compiled the requested controls and definitions, not just stored a ZIP. */
export function assertMergedRibbon(mergedXml: string, deltas: RibbonDelta[], label: string, originalUnmanagedXml?: string, verifiedUnmanagedXml?: string): void {
	const merged = parseVerifiedXml(mergedXml, `${label} merged ribbon`);
	const verifiedSource = verifiedUnmanagedXml ? parseVerifiedXml(verifiedUnmanagedXml, "Verified unmanaged source") : null;
	const byId = new Map<string, Element[]>();
	for (const node of Array.from(merged.querySelectorAll("[Id]"))) {
		const id = node.getAttribute("Id")!;
		const values = byId.get(id) ?? []; values.push(node); byId.set(id, values);
	}
	const hidden = new Set(Array.from(merged.querySelectorAll("HideCustomAction[Location]")).map((node) => node.getAttribute("Location")));
	const original = originalUnmanagedXml ? parseVerifiedXml(originalUnmanagedXml, "Original unmanaged ribbon") : null;
	const allIncomingControlIds = new Set(deltas.flatMap((delta) => Array.from(parseVerifiedXml(delta.xml, "Ribbon delta").querySelectorAll("CommandUIDefinition [Id]")).map((node) => node.getAttribute("Id"))));
	const semanticXml = (element: Element): string => {
		const copy = element.cloneNode(true) as Element;
		// These schema booleans permit both XML lexical forms. Do not normalize
		// arbitrary string parameters or action/rule order.
		for (const node of [copy, ...Array.from(copy.querySelectorAll("*"))]) {
			for (const key of ["Default", "InvertResult", "PassParams"]) {
				const value = node.getAttribute(key);
				if (value === "1") node.setAttribute(key, "true");
				if (value === "0") node.setAttribute(key, "false");
			}
		}
		return canonicalizeXml(new XMLSerializer().serializeToString(copy));
	};
	for (const delta of deltas) {
		const requested = parseVerifiedXml(delta.xml, "Ribbon delta");
		const requestedHidden = new Set(Array.from(requested.querySelectorAll("HideCustomAction[Location]")).map((node) => node.getAttribute("Location")));
		for (const id of requestedHidden) {
			if (id && byId.has(id) && !hidden.has(id)) throw new Error(`${label} compiled ribbon did not hide ${id}.`);
		}
		for (const node of Array.from(requested.querySelectorAll("CommandUIDefinition [Id], CommandDefinitions > CommandDefinition, RuleDefinitions > EnableRules > EnableRule, RuleDefinitions > DisplayRules > DisplayRule, LocLabels > LocLabel"))) {
			const id = node.getAttribute("Id");
			if (!id || requestedHidden.has(id)) continue;
			let actual = byId.get(id)?.find((candidate) => candidate.tagName === node.tagName &&
				(!["EnableRule", "DisplayRule"].includes(node.tagName) || candidate.parentElement?.parentElement?.tagName === "RuleDefinitions"));
			// Native RetrieveEntityRibbon may omit LocLabels entirely. Their fresh
			// exported definition is still mandatory; never accept an absent/stale label.
			if (!actual && node.tagName === "LocLabel") {
				actual = Array.from(verifiedSource?.querySelectorAll("RibbonDiffXml > LocLabels > LocLabel") ?? [])
					.find((candidate) => candidate.getAttribute("Id") === id);
			}
			if (!actual) throw new Error(`${label} compiled-ribbon verification did not find ${node.tagName} ${id}.`);
			// The exported source comparison verifies full content; these attributes
			// also establish that the compiled control points to the intended command.
			for (const attribute of ["Command", "FunctionName", "Library"]) {
				if (node.hasAttribute(attribute) && actual.getAttribute(attribute) !== node.getAttribute(attribute)) {
					throw new Error(`${label} compiled-ribbon verification found a different ${attribute} on ${id}.`);
				}
			}
			if (node.tagName === "CommandDefinition") {
				for (const section of ["Actions", "EnableRules", "DisplayRules"]) {
					const expectedSection = node.querySelector(`:scope > ${section}`);
					const actualSection = actual.querySelector(`:scope > ${section}`);
					if ((expectedSection ? semanticXml(expectedSection) : `<${section}/>`) !== (actualSection ? semanticXml(actualSection) : `<${section}/>`)) {
						throw new Error(`${label} compiled command ${id} has stale ${section}; verification failed.`);
					}
				}
			} else if (["EnableRule", "DisplayRule", "LocLabel"].includes(node.tagName) && semanticXml(node) !== semanticXml(actual)) {
				throw new Error(`${label} compiled ${node.tagName} ${id} has stale content; verification failed.`);
			}
		}
		for (const id of delta.unhiddenControlIds) {
			if (!byId.has(id) || hidden.has(id)) throw new Error(`${label} compiled ribbon did not restore the visibility of ${id}.`);
		}
		for (const id of [...delta.removedControlIds, ...delta.removedGroupIds, ...delta.removedTabIds]) {
			if (allIncomingControlIds.has(id) || !byId.has(id) || !original) continue; // explicit move keeps its ID
			const declaration = Array.from(original.querySelectorAll("CommandUIDefinition [Id]")).find((node) => node.getAttribute("Id") === id);
			const action = declaration?.closest("CustomAction");
			// Removing an override at Location=<controlId> may reveal the managed/OOB
			// control. An added child declaration has no such underlying placement.
			if (action && action.getAttribute("Location") !== id) {
				throw new Error(`${label} compiled ribbon still contains removed custom control ${id}.`);
			}
		}
		for (const patch of delta.elementPatches ?? []) {
			const actual = byId.get(patch.id)?.find((node) => node.tagName === patch.kind);
			if (!actual) throw new Error(`${label} compiled ribbon is missing changed ${patch.kind} ${patch.id}.`);
			for (const [key, value] of Object.entries(patch.attributes)) {
				if (actual.getAttribute(key) !== value) throw new Error(`${label} compiled ${patch.kind} ${patch.id} has a stale ${key}.`);
			}
		}
	}
}

/** ImportJob completion is not success: inspect the actual result XML first. */
export function inspectImportJob(value: unknown): { complete: boolean } {
	if (typeof value !== "object" || value === null) throw new Error("Import job returned an invalid result.");
	const record = value as Record<string, unknown>;
	const nested = typeof record.data === "object" && record.data !== null ? record.data as Record<string, unknown> : undefined;
	const error = record.error ?? nested?.error;
	if (error) throw new Error(`Solution import failed: ${typeof error === "string" ? error : JSON.stringify(error)}`);
	const data = typeof record.data === "string" ? record.data : typeof nested?.data === "string" ? nested.data : undefined;
	let successObserved = false;
	if (data) {
		const doc = parseVerifiedXml(data, "Import job result");
		for (const node of Array.from(doc.querySelectorAll("*"))) {
			const result = (node.getAttribute("result") ?? "").toLowerCase();
			if (result === "success") successObserved = true;
			const errorCode = node.getAttribute("errorcode") ?? node.getAttribute("errorCode");
			if (["failure", "failed", "error"].includes(result) || (errorCode && !/^(?:0|0x0+)$/i.test(errorCode))) {
				const message = node.getAttribute("errortext") || node.getAttribute("errorText") || node.querySelector("errortext, ErrorText")?.textContent || `error ${errorCode ?? result}`;
				throw new Error(`Solution import failed: ${message}`);
			}
		}
	}
	if (typeof record.statuscode === "number" && [31, 32].includes(record.statuscode)) throw new Error(`Solution import failed or was cancelled (status ${record.statuscode}).`);
	const progress = record.progress ?? nested?.progress;
	const completed = typeof progress === "object" && progress !== null && (progress as { completed?: unknown }).completed === true;
	const terminal = completed || (typeof progress === "number" && progress >= 100) || Boolean(record.completedon || nested?.completedon);
	if (terminal && !successObserved) throw new Error("Import job finished without a positive success result. Its outcome is uncertain; publication was not attempted.");
	return { complete: terminal && successObserved };
}
