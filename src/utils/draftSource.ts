import type { RibbonSourceSnapshot } from "@/types/workspace";

const PUBLISHER_IDENTITY_FIELDS = ["UniqueName", "CustomizationPrefix", "CustomizationOptionValuePrefix"] as const;

/** Publication retains the whole manifest in memory; a browser draft does not need its contact details. */
export function draftPublisherIdentity(xml: string): string {
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	if (doc.querySelector("parsererror")) throw new Error("The saved publisher metadata is invalid XML.");
	return JSON.stringify(PUBLISHER_IDENTITY_FIELDS.map((name) => doc.querySelector(`SolutionManifest > Publisher > ${name}`)?.textContent ?? ""));
}

/** Retain only the ribbon source and identity needed to reject stale drafts, not unrelated solution data. */
export function minimizeDraftSource(source: RibbonSourceSnapshot): RibbonSourceSnapshot {
	const sourceDoc = new DOMParser().parseFromString(source.solutionXml, "application/xml");
	if (sourceDoc.querySelector("parsererror")) throw new Error("The source manifest is invalid XML.");
	const doc = new DOMParser().parseFromString("<ImportExportXml><SolutionManifest><Publisher/></SolutionManifest></ImportExportXml>", "application/xml");
	const publisher = doc.querySelector("Publisher")!;
	for (const name of PUBLISHER_IDENTITY_FIELDS) {
		const element = sourceDoc.querySelector(`SolutionManifest > Publisher > ${name}`);
		if (element) publisher.appendChild(doc.importNode(element, true));
	}
	return { ...source, solutionXml: new XMLSerializer().serializeToString(doc), customizationsXml: "<ImportExportXml/>" };
}
