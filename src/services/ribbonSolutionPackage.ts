import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { canonicalizeXml, mergeRibbonDiffXml, parseXmlStrict, serializeXml } from "./ribbonMerge";
import type {
	RibbonSourceSnapshot,
	RibbonSolutionChanges,
	RibbonSolutionPackage,
} from "@/types/workspace";

const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const MAX_EXPORTED_ENTRIES = 4096;
const MAX_UNCOMPRESSED_TOTAL = 256 * 1024 * 1024;
const MAX_XML_BYTES = 20 * 1024 * 1024;
const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
// A previously absent application RibbonDiffXml needs an explicit scoped
// recovery payload. Omitting the node from customizations.xml is an import
// no-op and cannot clear a first-time application customization.
const EMPTY_UNMANAGED_APPLICATION_RIBBON_XML = '<RibbonDiffXml><CustomActions/><Templates><RibbonTemplates Id="Mscrm.Templates"/></Templates><CommandDefinitions/><RuleDefinitions><TabDisplayRules/><DisplayRules/><EnableRules/></RuleDefinitions><LocLabels/></RibbonDiffXml>';

type SourceDocuments = {
	manifest: Document;
	customizations: Document;
	solutionVersion: string;
	sourceEntity: Element;
	entityRibbon: Element;
	applicationRibbon: Element | null;
	entityComponent: Element;
	applicationComponents: Element[];
};

function elements(parent: ParentNode, name?: string): Element[] {
	return Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE)
		.filter(node => name === undefined || node.tagName === name);
}

function only(parent: ParentNode, name: string): Element | null {
	const result = elements(parent, name);
	if (result.length > 1) throw new Error(`Ambiguous duplicate <${name}> in exported solution.`);
	return result[0] ?? null;
}

function required(parent: ParentNode, name: string): Element {
	const result = only(parent, name);
	if (!result) throw new Error(`Exported solution is missing required <${name}>.`);
	return result;
}

function textOf(parent: ParentNode, name: string): string {
	const value = required(parent, name).textContent?.trim() ?? "";
	if (!value) throw new Error(`Exported solution has an empty <${name}>.`);
	return value;
}

function checkSolutionName(name: string): void {
	if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) {
		throw new Error("Invalid solution unique name.");
	}
}

function checkEntityName(name: string): void {
	if (!/^[a-z][a-z0-9_]{0,127}$/.test(name)) {
		throw new Error("Invalid entity logical name.");
	}
}

/** ExportSolution may display-case Entity/Name text (e.g. Lead vs logical lead).
 * Match only the XML element's logical-name text, never its localized attributes.
 * Keep ASCII casefold explicit: it must not introduce Unicode lookalike matches. */
function sameEntityLogicalName(exportedName: string | null, requestedName: string): boolean {
	return exportedName !== null && exportedName.replace(/[A-Z]/g, char => char.toLowerCase()) === requestedName;
}

function checkVersion(version: string): void {
	const match = /^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version);
	if (!match || version.split(".").some(part => Number(part) > 65535)) {
		throw new Error(`Invalid four-part solution version: ${version}.`);
	}
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc ^= bytes[i];
		for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

interface ZipMember {
	name: string;
	originalSize: number;
	crc: number;
}

/**
 * Check the entire central directory before handing bytes to a decompressor.
 * Only the two source XML files will actually be decompressed, even when the
 * exported solution contains hundreds of unrelated web resources.
 */
function validateZipMembers(bytes: Uint8Array): Map<string, ZipMember> {
	if (bytes.byteLength < 22 || bytes.byteLength > MAX_ZIP_BYTES) {
		throw new Error("Source solution ZIP exceeds its compressed size limit or is empty.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u16 = (offset: number) => view.getUint16(offset, true);
	const u32 = (offset: number) => view.getUint32(offset, true);
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
		if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("Malformed ZIP: end-of-central-directory record is missing.");
	const count = u16(eocd + 10);
	const directorySize = u32(eocd + 12);
	const directoryStart = u32(eocd + 16);
	if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0 || u16(eocd + 8) !== count ||
		count === 0 || count > MAX_EXPORTED_ENTRIES || count === 0xffff ||
		directorySize === 0xffffffff || directoryStart === 0xffffffff ||
		directoryStart + directorySize !== eocd) {
		throw new Error("Unsupported multi-disk, ZIP64, or oversized source solution ZIP.");
	}

	let offset = directoryStart;
	let totalExpanded = 0;
	const seen = new Set<string>();
	const members = new Map<string, ZipMember>();
	for (let index = 0; index < count; index++) {
		if (offset + 46 > eocd || u32(offset) !== 0x02014b50) {
			throw new Error("Malformed ZIP central directory header.");
		}
		const flags = u16(offset + 8);
		const method = u16(offset + 10);
		const crc = u32(offset + 16);
		const compressed = u32(offset + 20);
		const expanded = u32(offset + 24);
		const nameLength = u16(offset + 28);
		const extraLength = u16(offset + 30);
		const commentLength = u16(offset + 32);
		const localOffset = u32(offset + 42);
		const end = offset + 46 + nameLength + extraLength + commentLength;
		if (end > eocd || !nameLength || ![0, 8].includes(method) || flags & 1 || flags & 0x40 ||
			compressed === 0xffffffff || expanded === 0xffffffff || localOffset === 0xffffffff ||
			u16(offset + 34) !== 0 || expanded > MAX_UNCOMPRESSED_TOTAL ||
			localOffset + 30 > directoryStart || u32(localOffset) !== 0x04034b50) {
			throw new Error("Unsupported or malformed source solution ZIP member.");
		}
		const name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength));
		const segments = name.split("/");
		if (!name || name.startsWith("/") || name.includes("\\") ||
			Array.from(name).some(char => char === ":" || char.charCodeAt(0) < 32) ||
			segments.some((segment, i) => !segment && i !== segments.length - 1 || segment === "." || segment === "..")) {
			throw new Error(`Unsafe ZIP member path (traversal/absolute path): ${name}.`);
		}
		const nameKey = name.normalize("NFC").toLowerCase();
		if (seen.has(nameKey)) throw new Error(`Duplicate ZIP entry: ${name}.`);
		seen.add(nameKey);
		const localNameLength = u16(localOffset + 26);
		const localExtraLength = u16(localOffset + 28);
		const localNameStart = localOffset + 30;
		const localDataStart = localNameStart + localNameLength + localExtraLength;
		if (localDataStart + compressed > directoryStart ||
			strFromU8(bytes.subarray(localNameStart, localNameStart + localNameLength)) !== name ||
			u16(localOffset + 8) !== method || u16(localOffset + 6) !== flags) {
			throw new Error(`Inconsistent ZIP local-file header for ${name}.`);
		}
		totalExpanded += expanded;
		if (totalExpanded > MAX_UNCOMPRESSED_TOTAL) {
			throw new Error("Source solution ZIP exceeds its declared uncompressed size limit.");
		}
		if (name === "solution.xml" || name === "customizations.xml") {
			if (expanded > MAX_XML_BYTES) throw new Error(`${name} exceeds the XML size limit.`);
			members.set(name, { name, originalSize: expanded, crc });
		}
		offset = end;
	}
	if (offset !== eocd) throw new Error("Malformed ZIP: central directory length mismatch.");
	for (const name of ["solution.xml", "customizations.xml"]) {
		if (!members.has(name)) throw new Error(`Source solution ZIP is missing ${name}.`);
	}
	return members;
}

function fromBase64(base64: string): Uint8Array {
	if (typeof base64 !== "string" || !base64 || base64.length > Math.ceil(MAX_ZIP_BYTES / 3) * 4 + 4 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
		throw new Error("Invalid or oversized source solution ZIP base64.");
	}
	let binary: string;
	try {
		binary = atob(base64);
	} catch {
		throw new Error("Invalid source solution ZIP base64.");
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 32768) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
	}
	return btoa(binary);
}

function extractExportedXml(base64: string): { solutionXml: string; customizationsXml: string } {
	const bytes = fromBase64(base64);
	const members = validateZipMembers(bytes);
	let extracted: Record<string, Uint8Array>;
	try {
		extracted = unzipSync(bytes, { filter: info => members.has(info.name) });
	} catch (error) {
		throw new Error(`Source solution ZIP decompression failed: ${String(error)}`);
	}
	for (const [name, metadata] of members) {
		const file = extracted[name];
		if (!file || file.length !== metadata.originalSize || crc32(file) !== metadata.crc) {
			throw new Error(`Malformed source solution ZIP entry checksum or size: ${name}.`);
		}
	}
	return {
		solutionXml: strFromU8(extracted["solution.xml"]),
		customizationsXml: strFromU8(extracted["customizations.xml"]),
	};
}

function parseSourceDocuments(
	solutionXml: string,
	customizationsXml: string,
	expectedSolution: string,
	expectedEntity: string,
): SourceDocuments {
	checkSolutionName(expectedSolution);
	checkEntityName(expectedEntity);
	const manifest = parseXmlStrict(solutionXml, "ImportExportXml");
	const customizations = parseXmlStrict(customizationsXml, "ImportExportXml");
	const definition = required(manifest.documentElement, "SolutionManifest");
	if (textOf(definition, "UniqueName") !== expectedSolution) {
		throw new Error("Source solution unique name mismatch.");
	}
	const managed = textOf(definition, "Managed");
	if (managed !== "0" && managed.toLowerCase() !== "false") {
		throw new Error("Managed solutions are not editable; select an unmanaged solution.");
	}
	const version = textOf(definition, "Version");
	checkVersion(version);
	const publisher = required(definition, "Publisher");
	textOf(publisher, "UniqueName");
	textOf(publisher, "CustomizationPrefix");
	textOf(publisher, "CustomizationOptionValuePrefix");

	const roots = required(definition, "RootComponents");
	const components = elements(roots);
	if (components.some(component => component.tagName !== "RootComponent")) {
		throw new Error("Unsupported RootComponents manifest entry.");
	}
	const entityComponents = components.filter(component => component.getAttribute("type") === "1" &&
		sameEntityLogicalName(component.getAttribute("schemaName"), expectedEntity));
	if (entityComponents.length !== 1) {
		throw new Error(`Source solution must contain exactly one entity root component for ${expectedEntity}.`);
	}
	const applicationComponents = components.filter(component => component.getAttribute("type") === "50");
	const applicationIds = applicationComponents.map(component => component.getAttribute("id") ?? "");
	if (applicationIds.some(id => !/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(id)) ||
		new Set(applicationIds.map(id => id.toLowerCase().replace(/[{}]/g, ""))).size !== applicationIds.length) {
		throw new Error("Invalid or duplicate application-ribbon root component ID.");
	}
	const entities = required(customizations.documentElement, "Entities");
	const matchedEntities = elements(entities, "Entity")
		.filter(entity => sameEntityLogicalName(textOf(entity, "Name"), expectedEntity));
	if (matchedEntities.length !== 1) {
		throw new Error(`Source customizations must contain exactly one ${expectedEntity} entity.`);
	}
	const sourceEntity = matchedEntities[0];
	const entityRibbon = required(sourceEntity, "RibbonDiffXml");
	mergeRibbonDiffXml(serializeXml(entityRibbon), []); // Validate unique declarations before retaining source.
	const applicationRibbon = only(customizations.documentElement, "RibbonDiffXml");
	if (applicationRibbon) mergeRibbonDiffXml(serializeXml(applicationRibbon), []);
	return {
		manifest,
		customizations,
		solutionVersion: version,
		sourceEntity,
		entityRibbon,
		applicationRibbon,
		entityComponent: entityComponents[0],
		applicationComponents,
	};
}

/** Extract the selected unmanaged solution's original ribbons and publisher identity. */
export function parseRibbonSolution(
	base64: string,
	solutionUniqueName: string,
	entityLogicalName: string,
): RibbonSourceSnapshot {
	const { solutionXml, customizationsXml } = extractExportedXml(base64);
	const documents = parseSourceDocuments(solutionXml, customizationsXml, solutionUniqueName, entityLogicalName);
	return {
		solutionUniqueName,
		entityLogicalName,
		solutionVersion: documents.solutionVersion,
		solutionXml,
		customizationsXml,
		entityRibbonXml: serializeXml(documents.entityRibbon),
		applicationRibbonXml: documents.applicationRibbon ? serializeXml(documents.applicationRibbon) : null,
		capturedAt: new Date().toISOString(),
	};
}

function replaceChildText(parent: Element, tag: string, value: string): void {
	const node = required(parent, tag);
	node.textContent = value;
}

function createNarrowManifest(source: SourceDocuments, entity: boolean, application: boolean, version: string): string {
	const doc = source.manifest.cloneNode(true) as Document;
	const manifest = required(doc.documentElement, "SolutionManifest");
	replaceChildText(manifest, "Version", version);
	const roots = required(manifest, "RootComponents");
	while (roots.firstChild) roots.removeChild(roots.firstChild);
	if (entity) {
		const component = doc.importNode(source.entityComponent, true) as Element;
		component.setAttribute("behavior", "2");
		roots.appendChild(component);
	}
	if (application) {
		for (const original of source.applicationComponents) roots.appendChild(doc.importNode(original, true));
	}
	const deps = only(manifest, "MissingDependencies");
	if (deps) while (deps.firstChild) deps.removeChild(deps.firstChild);
	return serializeXml(doc);
}

function createNarrowCustomizations(
	source: SourceDocuments,
	entityRibbonXml: string | undefined,
	applicationRibbonXml: string | undefined,
): string {
	const doc = source.customizations;
	const root = doc.documentElement.cloneNode(false) as Element;
	if (entityRibbonXml !== undefined) {
		const entities = doc.createElement("Entities");
		const entity = doc.createElement("Entity");
		// The server-exported child <Name> is mandatory. Copy only non-routing attributes.
		for (const attribute of Array.from(source.sourceEntity.attributes)) {
			if (attribute.name !== "Name") entity.setAttribute(attribute.name, attribute.value);
		}
		entity.setAttribute("unmodified", "0");
		// Copy the *child* Name element, not the Entity's Name attribute. Native
		// Dynamics 9.1 exports may spell its text "Lead" and carry LocalizedName /
		// OriginalName attributes; both are valid and must survive a narrow import.
		const name = doc.importNode(required(source.sourceEntity, "Name"), true);
		entity.appendChild(name);
		entity.appendChild(doc.importNode(parseXmlStrict(entityRibbonXml, "RibbonDiffXml").documentElement, true));
		entities.appendChild(entity);
		root.appendChild(entities);
	}
	if (applicationRibbonXml !== undefined) {
		root.appendChild(doc.importNode(parseXmlStrict(applicationRibbonXml, "RibbonDiffXml").documentElement, true));
	}
	return serializeXml(root);
}

function pack(solutionXml: string, customizationsXml: string): string {
	const bytes = zipSync({
		"solution.xml": strToU8(solutionXml),
		"customizations.xml": strToU8(customizationsXml),
		"[Content_Types].xml": strToU8(CONTENT_TYPES_XML),
	}, { level: 6, mtime: new Date(1980, 0, 1, 0, 0, 0, 0) });
	if (bytes.length > MAX_ZIP_BYTES) throw new Error("Ribbon package exceeds the compressed ZIP size limit.");
	return toBase64(bytes);
}

/** Build complete forward and pre-change recovery imports with narrow ribbon-only payloads. */
export function buildRibbonSolutionPackage(
	snapshot: RibbonSourceSnapshot,
	changes: RibbonSolutionChanges,
): RibbonSolutionPackage {
	if (!snapshot || !changes || typeof changes !== "object") {
		throw new Error("Ribbon source snapshot and changes are required.");
	}
	const hasEntity = changes.entityRibbonXml !== undefined;
	const hasApplication = changes.applicationRibbonXml !== undefined;
	if (!hasEntity && !hasApplication) throw new Error("No ribbon changes were selected for the solution package.");
	const documents = parseSourceDocuments(snapshot.solutionXml, snapshot.customizationsXml,
		snapshot.solutionUniqueName, snapshot.entityLogicalName);
	if (documents.solutionVersion !== snapshot.solutionVersion ||
		canonicalizeXml(snapshot.entityRibbonXml) !== canonicalizeXml(serializeXml(documents.entityRibbon)) ||
		(snapshot.applicationRibbonXml === null) !== (documents.applicationRibbon === null) ||
		(documents.applicationRibbon !== null && canonicalizeXml(snapshot.applicationRibbonXml!) !== canonicalizeXml(serializeXml(documents.applicationRibbon)))) {
		throw new Error("Ribbon snapshot source identity or XML mismatch; fetch a fresh export.");
	}
	if (hasApplication && !documents.applicationComponents.length) {
		throw new Error("Application ribbon edits require an explicit application root component in the exported solution.");
	}
	const version = changes.solutionVersion ?? snapshot.solutionVersion;
	checkVersion(version);
	if (hasEntity) mergeRibbonDiffXml(changes.entityRibbonXml!, []);
	if (hasApplication) mergeRibbonDiffXml(changes.applicationRibbonXml!, []);

	const originalEntity = hasEntity ? snapshot.entityRibbonXml : undefined;
	// An application root may exist in the solution manifest before any authored
	// RibbonDiffXml exists. Recovery must actively import an empty definition;
	// omitting this node leaves newly imported application changes untouched.
	const originalApplication = hasApplication
		? (snapshot.applicationRibbonXml ?? EMPTY_UNMANAGED_APPLICATION_RIBBON_XML)
		: undefined;
	const originalManifest = createNarrowManifest(documents, hasEntity, hasApplication, snapshot.solutionVersion);
	const forwardManifest = createNarrowManifest(documents, hasEntity, hasApplication, version);
	const backupCustomizations = createNarrowCustomizations(documents, originalEntity, originalApplication);
	const forwardCustomizations = createNarrowCustomizations(documents, changes.entityRibbonXml, changes.applicationRibbonXml);
	return {
		base64: pack(forwardManifest, forwardCustomizations),
		backupBase64: pack(originalManifest, backupCustomizations),
		...(hasEntity ? { entityRibbonXml: changes.entityRibbonXml } : {}),
		...(hasApplication ? { applicationRibbonXml: changes.applicationRibbonXml } : {}),
	};
}
