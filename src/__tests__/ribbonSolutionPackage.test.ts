import { describe, expect, it } from "vitest";
import { strToU8, strFromU8, unzipSync, zipSync } from "fflate";
import { buildRibbonSolutionPackage, parseRibbonSolution } from "@/services/ribbonSolutionPackage";
import { canonicalizeXml } from "@/services/ribbonMerge";

const publisher = '<Publisher><UniqueName>contoso</UniqueName><LocalizedNames><LocalizedName languagecode="1033" description="A &amp; B"/></LocalizedNames><CustomizationPrefix>co</CustomizationPrefix><CustomizationOptionValuePrefix>78123</CustomizationOptionValuePrefix><VendorNode Preserve="yes"/></Publisher>';
const solutionXml = `<?xml version="1.0" encoding="utf-8"?><ImportExportXml version="9.1.0.0" SolutionPackageVersion="9.1" languagecode="1033">
  <SolutionManifest><UniqueName>EditingSolution</UniqueName><LocalizedNames><LocalizedName description="Editing Solution" languagecode="1033"/></LocalizedNames><Version>1.0.0.0</Version><Managed>0</Managed>${publisher}
    <RootComponents><RootComponent type="1" schemaName="account" behavior="0"/><RootComponent type="50" id="{11111111-1111-1111-1111-111111111111}" behavior="0"/><RootComponent type="61" id="{22222222-2222-2222-2222-222222222222}" behavior="0"/></RootComponents>
    <MissingDependencies/></SolutionManifest></ImportExportXml>`;

const originalEntity = '<RibbonDiffXml><CustomActions><CustomAction Id="A.Action" Location="Home.Controls._children"><CommandUIDefinition><Button Id="A" Command="A.Cmd"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="A.Cmd"/></CommandDefinitions></RibbonDiffXml>';
const changedEntity = '<RibbonDiffXml><CustomActions><CustomAction Id="A.Action" Location="Home.Controls._children"><CommandUIDefinition><Button Id="A" Command="A.Cmd"/></CommandUIDefinition></CustomAction><CustomAction Id="B.Action" Location="Form.Controls._children"><CommandUIDefinition><Button Id="B"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="A.Cmd"/></CommandDefinitions></RibbonDiffXml>';
const originalApplication = '<RibbonDiffXml><CustomActions><CustomAction Id="Global.Action" Location="Mscrm.Tabs._children"><CommandUIDefinition><Tab Id="Global"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';

function customizationsXml(hasApplication = false): string {
	return `<?xml version="1.0" encoding="utf-8"?><ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <Entities><Entity unmodified="0"><Name>account</Name><EntityInfo><entity Name="account"><attributes><attribute PhysicalName="accountid"/></attributes></entity></EntityInfo><FormXml><forms><systemform/></forms></FormXml><SavedQueries/><RibbonDiffXml>${originalEntity.replace(/^<RibbonDiffXml>|<\/RibbonDiffXml>$/g, "")}</RibbonDiffXml></Entity>
    <Entity unmodified="0"><Name>contact</Name><EntityInfo/><RibbonDiffXml/></Entity></Entities>
    ${hasApplication ? originalApplication : ""}<WebResources><WebResource Name="test.js"/></WebResources><EntityRelationships><EntityRelationship/></EntityRelationships>
  </ImportExportXml>`;
}

function exportedZip(opts: { xml?: string; customizations?: string; entries?: Record<string, Uint8Array> } = {}): string {
	const bytes = zipSync({
		"solution.xml": strToU8(opts.xml ?? solutionXml),
		"customizations.xml": strToU8(opts.customizations ?? customizationsXml()),
		"WebResources/contoso.js": strToU8("non-ribbon source"),
		...opts.entries,
	});
	return bytesToBase64(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
	let raw = "";
	for (let i = 0; i < bytes.length; i += 32768) {
		raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
	}
	return btoa(raw);
}

function unzipBase64(b64: string): Record<string, string> {
	const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
	return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([key, value]) => [key, strFromU8(value)]));
}

function parse(xml: string): Document {
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	expect(doc.querySelector("parsererror")).toBeNull();
	return doc;
}

/** Dynamics 9.1 ExportSolution emits display-cased <Name> text for some entities. */
function exportedLead(options: { rootSchemaName?: string; extraLeadEntity?: boolean; nameText?: string } = {}): string {
	const rootSchemaName = options.rootSchemaName ?? "lead";
	const entityName = options.nameText ?? "Lead";
	const manifest = solutionXml.replace('schemaName="account" behavior="0"', `schemaName="${rootSchemaName}" behavior="2"`);
	const customizations = customizationsXml()
		.replace('<Name>account</Name>', `<Name LocalizedName="Lead" OriginalName="Lead">${entityName}</Name>`)
		.replace('<entity Name="account">', '<entity Name="lead">')
		.replace('PhysicalName="accountid"', 'PhysicalName="leadid"')
		.replace('<Name>contact</Name>', options.extraLeadEntity ? '<Name>lead</Name>' : '<Name>contact</Name>');
	return exportedZip({ xml: manifest, customizations });
}

describe("parseRibbonSolution", () => {
	it("extracts the requested entity source and original manifest from the ZIP", () => {
		const source = parseRibbonSolution(exportedZip(), "EditingSolution", "account");
		expect(source.solutionVersion).toBe("1.0.0.0");
		expect(source.solutionUniqueName).toBe("EditingSolution");
		expect(source.entityLogicalName).toBe("account");
		expect(parse(source.entityRibbonXml).querySelector('Button[Id="A"]')).not.toBeNull();
		expect(source.applicationRibbonXml).toBeNull();
		expect(source.capturedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(source.solutionXml).toContain("78123");
	});

	it("rejects managed, mismatched solution and entity source", () => {
		expect(() => parseRibbonSolution(exportedZip({ xml: solutionXml.replace('<Managed>0</Managed>', '<Managed>1</Managed>') }), "EditingSolution", "account")).toThrow(/managed/i);
		expect(() => parseRibbonSolution(exportedZip(), "WrongSolution", "account")).toThrow(/solution|mismatch/i);
		expect(() => parseRibbonSolution(exportedZip(), "EditingSolution", "lead")).toThrow(/entity|missing/i);
		expect(() => parseRibbonSolution(exportedZip({ customizations: customizationsXml().replace('<Name>account</Name>', '<Name>contact</Name>') }), "EditingSolution", "account")).toThrow(/duplicate|missing|entity/i);
	});

	it("accepts a Dynamics 9.1 lead root whose Name text is Lead with localized attributes", () => {
		const source = parseRibbonSolution(exportedLead(), "EditingSolution", "lead");
		expect(source.entityLogicalName).toBe("lead");
		expect(source.solutionUniqueName).toBe("EditingSolution");
		expect(parse(source.customizationsXml).querySelector("Entities > Entity > Name")?.textContent).toBe("Lead");
		expect(parse(source.customizationsXml).querySelector("Entities > Entity > Name")?.getAttribute("LocalizedName")).toBe("Lead");
		expect(source.entityRibbonXml).toContain('Id="A"');
	});

	it("matches only logical Name text, rejects Lead/lead duplicates and ignores misleading localized labels", () => {
		expect(() => parseRibbonSolution(exportedLead({ extraLeadEntity: true }), "EditingSolution", "lead"))
			.toThrow(/exactly one|duplicate|entity/i);
		const duplicateRoot = solutionXml.replace(
			'<RootComponent type="1" schemaName="account" behavior="0"/>',
			'<RootComponent type="1" schemaName="lead" behavior="2"/><RootComponent type="1" schemaName="LEAD" behavior="2"/>',
		);
		const source = exportedLead();
		const zipEntries = unzipBase64(source);
		expect(() => parseRibbonSolution(exportedZip({ xml: duplicateRoot, customizations: zipEntries["customizations.xml"] }), "EditingSolution", "lead"))
			.toThrow(/exactly one|duplicate|root/i);
		// A display/localized attribute is not proof of a logical entity identity.
		expect(() => parseRibbonSolution(exportedLead({ nameText: "Other" }), "EditingSolution", "lead"))
			.toThrow(/exactly one|entity/i);
		// Original/schema casing is not authoritative if ASCII casefold matches.
		expect(parseRibbonSolution(exportedLead({ rootSchemaName: "LeAd" }), "EditingSolution", "lead").entityLogicalName).toBe("lead");
	});

	it("refuses corrupt base64, malformed XML, missing entries and unsafe ZIP paths", () => {
		expect(() => parseRibbonSolution("not-base64!", "EditingSolution", "account")).toThrow();
		expect(() => parseRibbonSolution(exportedZip({ xml: "<broken>" }), "EditingSolution", "account")).toThrow(/parse|xml/i);
		expect(() => parseRibbonSolution(exportedZip({ entries: { "../unsafe.xml": strToU8("x") } }), "EditingSolution", "account")).toThrow(/zip|path|traversal/i);
		expect(() => parseRibbonSolution(exportedZip({ entries: { "SOLUTION.XML": strToU8("duplicate") } }), "EditingSolution", "account")).toThrow(/duplicate/i);
		const missing = bytesToBase64(zipSync({ "solution.xml": strToU8(solutionXml) }));
		expect(() => parseRibbonSolution(missing, "EditingSolution", "account")).toThrow(/customizations.xml/i);
	});

	it("enforces a bounded compressed archive and refuses incomplete or declared giant ZIP inputs", () => {
		expect(() => parseRibbonSolution(bytesToBase64(new Uint8Array(17 * 1024 * 1024)), "EditingSolution", "account")).toThrow(/limit|size|zip/i);
		const bytes = Uint8Array.from(atob(exportedZip()), c => c.charCodeAt(0));
		const altered = bytes.slice();
		const signature = [0x50, 0x4b, 0x01, 0x02];
		const header = altered.findIndex((_, i) => signature.every((b, j) => altered[i + j] === b));
		expect(header).toBeGreaterThan(-1);
		new DataView(altered.buffer).setUint32(header + 24, 0xffffffff, true);
		expect(() => parseRibbonSolution(bytesToBase64(altered), "EditingSolution", "account")).toThrow(/size|limit|zip/i);
	});
});

describe("buildRibbonSolutionPackage", () => {
	it("round-trips live-shaped Lead Name attributes and publisher through narrow forward and recovery ZIPs", () => {
		const snapshot = parseRibbonSolution(exportedLead(), "EditingSolution", "lead");
		const packaged = buildRibbonSolutionPackage(snapshot, { entityRibbonXml: changedEntity, solutionVersion: "1.0.0.1" });
		const forward = unzipBase64(packaged.base64);
		const recovery = unzipBase64(packaged.backupBase64);
		for (const [part, zip] of [["forward", forward], ["recovery", recovery]] as const) {
			const xml = parse(zip["customizations.xml"]);
			const name = xml.querySelector("Entities > Entity > Name");
			expect(name?.textContent, part).toBe("Lead");
			expect(name?.getAttribute("LocalizedName"), part).toBe("Lead");
			expect(name?.getAttribute("OriginalName"), part).toBe("Lead");
			expect(xml.querySelectorAll("Entities > Entity"), part).toHaveLength(1);
			expect(xml.querySelector("Entity")?.hasAttribute("Name"), part).toBe(false);
			expect(xml.querySelector("EntityInfo"), part).toBeNull();
			const manifest = parse(zip["solution.xml"]);
			const root = manifest.querySelector('SolutionManifest > RootComponents > RootComponent[type="1"]');
			expect(root?.getAttribute("schemaName"), part).toBe("lead");
			expect(root?.getAttribute("behavior"), part).toBe("2");
			expect(manifest.querySelectorAll("RootComponent"), part).toHaveLength(1);
			expect(manifest.querySelector("Publisher CustomizationOptionValuePrefix")?.textContent, part).toBe("78123");
			expect(manifest.querySelector("Publisher VendorNode")?.getAttribute("Preserve"), part).toBe("yes");
		}
		expect(parse(forward["customizations.xml"]).querySelector('Button[Id="B"]')).not.toBeNull();
		expect(parse(recovery["customizations.xml"]).querySelector('Button[Id="B"]')).toBeNull();
		expect(parse(recovery["customizations.xml"]).querySelector('Button[Id="A"]')).not.toBeNull();
		expect(parseRibbonSolution(packaged.base64, "EditingSolution", "lead").solutionVersion).toBe("1.0.0.1");
		expect(parseRibbonSolution(packaged.backupBase64, "EditingSolution", "lead").solutionVersion).toBe("1.0.0.0");
	});
	it("builds a narrow entity ribbon package while keeping original publisher XML and original A + new B", () => {
		const snapshot = parseRibbonSolution(exportedZip(), "EditingSolution", "account");
		const result = buildRibbonSolutionPackage(snapshot, { entityRibbonXml: changedEntity, solutionVersion: "1.0.0.1" });
		const files = unzipBase64(result.base64);
		const original = unzipBase64(result.backupBase64);
		expect(Object.keys(files).sort()).toEqual(["[Content_Types].xml", "customizations.xml", "solution.xml"].sort());
		expect(files["solution.xml"]).toContain("78123");
		const manifest = parse(files["solution.xml"]);
		expect(manifest.querySelector("Publisher VendorNode")?.getAttribute("Preserve")).toBe("yes");
		expect(manifest.querySelector("SolutionManifest > Version")?.textContent).toBe("1.0.0.1");
		expect(manifest.querySelectorAll('RootComponent[type="1"]')).toHaveLength(1);
		expect(manifest.querySelector('RootComponent[type="1"]')?.getAttribute("behavior")).toBe("2");
		expect(manifest.querySelectorAll('RootComponent[type="50"]')).toHaveLength(0);
		expect(manifest.querySelectorAll('RootComponent[type="61"]')).toHaveLength(0);
		const cust = parse(files["customizations.xml"]);
		expect(cust.querySelector("Entities > Entity > Name")?.textContent).toBe("account");
		expect(cust.querySelector("Entity")?.hasAttribute("Name")).toBe(false);
		expect(cust.querySelector('Entities > Entity > RibbonDiffXml Button[Id="A"]')).not.toBeNull();
		expect(cust.querySelector('Entities > Entity > RibbonDiffXml Button[Id="B"]')).not.toBeNull();
		for (const excluded of ["EntityInfo", "FormXml", "SavedQueries", "WebResources", "EntityRelationships", "systemform"]) {
			expect(cust.querySelector(excluded)).toBeNull();
		}
		expect(parse(original["customizations.xml"]).querySelector('Button[Id="B"]')).toBeNull();
		expect(parse(original["customizations.xml"]).querySelector('Button[Id="A"]')).not.toBeNull();
		expect(parse(original["solution.xml"]).querySelector("Publisher CustomizationOptionValuePrefix")?.textContent).toBe("78123");
	});

	it("emits only the original explicit application root when authorized by the exported source", () => {
		const snapshot = parseRibbonSolution(exportedZip({ customizations: customizationsXml(true) }), "EditingSolution", "account");
		const result = buildRibbonSolutionPackage(snapshot, { applicationRibbonXml: originalApplication.replace('Id="Global"', 'Id="Global.Updated"') });
		const cust = parse(unzipBase64(result.base64)["customizations.xml"]);
		const manifest = parse(unzipBase64(result.base64)["solution.xml"]);
		expect(cust.querySelector("Entities")).toBeNull();
		expect(cust.querySelector('ImportExportXml > RibbonDiffXml Tab[Id="Global.Updated"]')).not.toBeNull();
		expect(manifest.querySelectorAll("RootComponent")).toHaveLength(1);
		expect(manifest.querySelector('RootComponent')?.getAttribute("type")).toBe("50");
		expect(parse(unzipBase64(result.backupBase64)["customizations.xml"]).querySelector('Tab[Id="Global"]')).not.toBeNull();
	});

	it("permits the first application customization when the manifest explicitly declares the application root", () => {
		const snapshot = parseRibbonSolution(exportedZip(), "EditingSolution", "account");
		expect(snapshot.applicationRibbonXml).toBeNull();
		const result = buildRibbonSolutionPackage(snapshot, { applicationRibbonXml: originalApplication });
		const forward = unzipBase64(result.base64);
		const recovery = unzipBase64(result.backupBase64);
		const forwardXml = parse(forward["customizations.xml"]);
		const recoveryXml = parse(recovery["customizations.xml"]);
		expect(forwardXml.querySelector('ImportExportXml > RibbonDiffXml Tab[Id="Global"]')).not.toBeNull();
		// An omitted application RibbonDiffXml is a no-op during an import. Recovery
		// therefore needs an explicit empty definition to target the same scope.
		const backupRoot = recoveryXml.querySelector('ImportExportXml > RibbonDiffXml');
		expect(backupRoot).not.toBeNull();
		expect(canonicalizeXml(new XMLSerializer().serializeToString(backupRoot!))).toBe(canonicalizeXml(
			'<RibbonDiffXml><CustomActions/><Templates><RibbonTemplates Id="Mscrm.Templates"/></Templates><CommandDefinitions/><RuleDefinitions><TabDisplayRules/><DisplayRules/><EnableRules/></RuleDefinitions><LocLabels/></RibbonDiffXml>',
		));
		expect(recoveryXml.querySelector('ImportExportXml > RibbonDiffXml [Id="Global"]')).toBeNull();
		expect(recoveryXml.querySelector('ImportExportXml > Entities')).toBeNull();
		for (const solution of [forward["solution.xml"], recovery["solution.xml"]]) {
			const manifest = parse(solution);
			expect(manifest.querySelectorAll('RootComponent[type="50"]')).toHaveLength(1);
			expect(manifest.querySelectorAll("RootComponent")).toHaveLength(1);
			expect(manifest.querySelector('Publisher CustomizationOptionValuePrefix')?.textContent).toBe("78123");
			expect(manifest.querySelector('Publisher VendorNode')?.getAttribute("Preserve")).toBe("yes");
		}
	});

	it("rejects unauthorized app scope, conflicting snapshot identity and malformed ribbon edits", () => {
		const snapshot = parseRibbonSolution(exportedZip(), "EditingSolution", "account");
		const noAppRoot = parseRibbonSolution(exportedZip({ xml: solutionXml.replace(/<RootComponent type="50"[^>]+\/>/, "") }), "EditingSolution", "account");
		expect(() => buildRibbonSolutionPackage(noAppRoot, { applicationRibbonXml: originalApplication })).toThrow(/application|scope|source/i);
		expect(() => buildRibbonSolutionPackage({ ...snapshot, entityLogicalName: "contact" }, { entityRibbonXml: changedEntity })).toThrow(/entity|mismatch/i);
		expect(() => buildRibbonSolutionPackage(snapshot, { entityRibbonXml: '<RibbonDiffXml><broken>' })).toThrow(/xml|parse/i);
		expect(() => buildRibbonSolutionPackage(snapshot, {})).toThrow(/changes|nothing|ribbon/i);
		expect(() => buildRibbonSolutionPackage(snapshot, { entityRibbonXml: changedEntity, solutionVersion: "not-a-version" })).toThrow(/version/i);
	});

	it("generates deterministic packages for identical input", () => {
		const snapshot = parseRibbonSolution(exportedZip(), "EditingSolution", "account");
		const one = buildRibbonSolutionPackage(snapshot, { entityRibbonXml: changedEntity });
		const two = buildRibbonSolutionPackage(snapshot, { entityRibbonXml: changedEntity });
		expect(one.base64).toBe(two.base64);
		expect(one.backupBase64).toBe(two.backupBase64);
	});
});
