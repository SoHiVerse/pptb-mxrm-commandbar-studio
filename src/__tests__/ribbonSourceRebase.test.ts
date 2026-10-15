import { describe, expect, it } from "vitest";
import { generateRibbonDelta } from "@/services/xmlGenerator";
import { mergeRibbonDiffXml } from "@/services/ribbonMerge";
import { parseRibbonXml } from "@/services/xmlParser";
import { rebasePendingWorkspace, rebaseWorkspaceSource } from "@/services/ribbonSourceRebase";
import type { RibbonDefinition } from "@/types/ribbon";
import type { RibbonWorkspace } from "@/types/workspace";

const TAB = "contoso.HomepageGrid.account.Tab";
const GROUP = "contoso.HomepageGrid.account.Group";
const BUTTON = "contoso.HomepageGrid.account.Button";
const COMMAND = "contoso.account.Command";
const RULE = "contoso.account.Rule";
const LABEL = `${BUTTON}.LabelText`;

function originalUnmanaged(): string {
	return `<RibbonDiffXml>
  <CustomActions><CustomAction Id="contoso.Button.CustomAction" Location="${GROUP}.Controls._children" Sequence="10">
    <CommandUIDefinition><Button Id="${BUTTON}" LabelText="Original" Command="${COMMAND}" TemplateAlias="o1" Sequence="10" VendorButton="keep"/></CommandUIDefinition>
  </CustomAction></CustomActions>
  <CommandDefinitions><CommandDefinition Id="${COMMAND}" VendorCommand="keep">
    <EnableRules><EnableRule Id="${RULE}"/></EnableRules><DisplayRules/>
    <Actions><Url Address="https://example.test/A" WinMode="1"/></Actions>
  </CommandDefinition></CommandDefinitions>
  <RuleDefinitions><EnableRules><EnableRule Id="${RULE}" VendorRule="keep"><CustomRule Library="$webresource:contoso_/rules.js" FunctionName="Contoso.Allow" Default="1"/></EnableRule></EnableRules><DisplayRules/></RuleDefinitions>
  <LocLabels/>
</RibbonDiffXml>`;
}

/** Representative retrieved merged/full ribbon response derived from an imported layer. */
function compiledEntityFrom(unmanagedXml: string): string {
	const source = new DOMParser().parseFromString(unmanagedXml, "application/xml");
	const control = source.querySelector(`CustomActions > CustomAction > CommandUIDefinition > Button[Id="${BUTTON}"]`);
	if (!control) throw new Error("Fixture is missing the compiled control");
	const full = new DOMParser().parseFromString(`<RibbonDefinitions><Ribbon><Tabs><Tab Id="${TAB}" Title="Home" Sequence="10"><Groups><Group Id="${GROUP}" Title="Actions" Sequence="10"><Controls/></Group></Groups></Tab></Tabs></Ribbon></RibbonDefinitions>`, "application/xml");
	full.querySelector("Controls")!.appendChild(full.importNode(control, true));
	for (const sectionName of ["CommandDefinitions", "RuleDefinitions", "LocLabels", "Scalings"]) {
		const section = source.querySelector(`RibbonDiffXml > ${sectionName}`);
		if (section) full.documentElement.appendChild(full.importNode(section, true));
	}
	return new XMLSerializer().serializeToString(full);
}

function workspaceFrom(sourceXml = originalUnmanaged()): RibbonWorkspace {
	const parsed = parseRibbonXml(compiledEntityFrom(sourceXml), "HomepageGrid", "account");
	const empty = (location: RibbonDefinition["location"], entityLogicalName = "account"): RibbonDefinition => ({ location, entityLogicalName, tabs: [] });
	return {
		ribbons: {
			HomepageGrid: parsed.ribbon,
			SubGrid: empty("SubGrid"),
			Form: empty("Form"),
			Application: empty("Application", "{!EntityLogicalName}"),
		},
		commands: parsed.commands,
		enableRules: parsed.enableRules,
		displayRules: parsed.displayRules,
		locLabels: parsed.locLabels,
	};
}

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function deltaFor(current: RibbonWorkspace, baseline: RibbonWorkspace) {
	return generateRibbonDelta({
		current: current.ribbons.HomepageGrid,
		baseline: baseline.ribbons.HomepageGrid,
		commands: current.commands,
		enableRules: current.enableRules,
		displayRules: current.displayRules,
		locLabels: current.locLabels,
		baselineDefinitions: baseline,
		entityLogicalName: "account",
		location: "HomepageGrid",
	});
}

function commandSource(workspace: RibbonWorkspace): string {
	return workspace.commands.find((command) => command.id === COMMAND)?.sourceXml ?? "";
}

describe("rebaseWorkspaceSource: verified compiled XML source caches", () => {
	it("prevents the second publish from restoring URL A after URL A→B was verified", () => {
		const initial = workspaceFrom();
		const current = copy(initial);
		const command = current.commands.find((item) => item.id === COMMAND)!;
		if (command.actions[0].kind !== "url") throw new Error("URL fixture expected");
		command.actions[0].address = "https://example.test/B";

		const storedAfterFirst = mergeRibbonDiffXml(originalUnmanaged(), [deltaFor(current, initial)]);
		const compiledB = compiledEntityFrom(storedAfterFirst);
		const published = rebaseWorkspaceSource(current, compiledB);
		expect(commandSource(current)).toContain("https://example.test/A"); // input stays immutable
		expect(commandSource(published)).toContain("https://example.test/B");
		expect(published.commands.find((item) => item.id === COMMAND)?.actions).toEqual(command.actions);

		const next = copy(published);
		next.commands.find((item) => item.id === COMMAND)!.enableRules = [];
		const secondDelta = deltaFor(next, published);
		const storedAfterSecond = mergeRibbonDiffXml(storedAfterFirst, [secondDelta]);
		const stored = new DOMParser().parseFromString(storedAfterSecond, "application/xml");
		const sourceCommand = stored.querySelector(`CommandDefinitions > CommandDefinition[Id="${COMMAND}"]`)!;
		expect(sourceCommand.querySelector("Actions > Url")?.getAttribute("Address")).toBe("https://example.test/B");
		expect(sourceCommand.querySelectorAll("EnableRules > EnableRule")).toHaveLength(0);
		expect(sourceCommand.getAttribute("VendorCommand")).toBe("keep");
	});

	it("does not resurrect a removed optional rule attribute on the following edit", () => {
		const initial = workspaceFrom();
		const publishedCurrent = copy(initial);
		const authoredRule = publishedCurrent.enableRules.find((rule) => rule.id === RULE)!;
		const custom = authoredRule.steps.find((step) => step.kind === "CustomRule")!;
		if (custom.kind !== "CustomRule") throw new Error("CustomRule fixture expected");
		custom.default = undefined;
		const firstStored = mergeRibbonDiffXml(originalUnmanaged(), [deltaFor(publishedCurrent, initial)]);
		expect(firstStored).not.toContain('Default="1"');
		const published = rebaseWorkspaceSource(publishedCurrent, compiledEntityFrom(firstStored));
		expect(published.enableRules.find((rule) => rule.id === RULE)?.sourceXml).not.toContain('Default="1"');
		const next = copy(published);
		const secondStep = next.enableRules.find((rule) => rule.id === RULE)!.steps[0];
		if (secondStep.kind !== "CustomRule") throw new Error("CustomRule fixture expected");
		secondStep.functionName = "Contoso.AllowAgain";
		const afterSecond = mergeRibbonDiffXml(firstStored, [deltaFor(next, published)]);
		const ruleXml = new DOMParser().parseFromString(afterSecond, "application/xml").querySelector(`RuleDefinitions > EnableRules > EnableRule[Id="${RULE}"]`)!.outerHTML;
		expect(ruleXml).toContain("Contoso.AllowAgain");
		expect(ruleXml).not.toContain("Default=");
	});

	it("adds only generated labels referenced by compiled controls, preserving edited UI labels and translations", () => {
		const initial = workspaceFrom();
		const updated = copy(initial);
		updated.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].label = "Renamed label";
		const afterRename = mergeRibbonDiffXml(originalUnmanaged(), [deltaFor(updated, initial)]);
		const document = new DOMParser().parseFromString(afterRename, "application/xml");
		const extras = document.querySelector("LocLabels")!;
		extras.insertAdjacentHTML("beforeend", '<LocLabel Id="unrelated.Label"><Titles><Title languagecode="1033" description="Not needed"/></Titles></LocLabel>');
		const withExtras = new XMLSerializer().serializeToString(document);
		const published = rebaseWorkspaceSource(updated, compiledEntityFrom(withExtras));
		expect(published.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].label).toBe("Renamed label");
		expect(published.locLabels.map((label) => label.id)).toEqual([LABEL]);
		expect(published.locLabels[0].sourceXml).toContain("Renamed label");
		const translated = copy(published);
		translated.locLabels[0].titles.push({ languageCode: 1036, description: "Renommé" });
		const afterTranslation = mergeRibbonDiffXml(afterRename, [deltaFor(translated, published)]);
		expect(afterTranslation).toContain("Renommé");
		expect(afterTranslation).toContain("Renamed label");
	});

	it("allows rebasing later dirty values from the compiled source while retaining newer edits", () => {
		const initial = workspaceFrom();
		const publishedInput = copy(initial);
		const command = publishedInput.commands.find((item) => item.id === COMMAND)!;
		if (command.actions[0].kind !== "url") throw new Error("URL fixture expected");
		command.actions[0].address = "https://example.test/B";
		const stored = mergeRibbonDiffXml(originalUnmanaged(), [deltaFor(publishedInput, initial)]);
		const pending = copy(publishedInput);
		const pendingCommand = pending.commands.find((item) => item.id === COMMAND)!;
		if (pendingCommand.actions[0].kind !== "url") throw new Error("URL fixture expected");
		pendingCommand.actions[0].address = "https://example.test/C";
		const rebasedPending = rebaseWorkspaceSource(pending, compiledEntityFrom(stored));
		expect(rebasedPending.commands.find((item) => item.id === COMMAND)?.actions).toEqual(pendingCommand.actions);
		expect(commandSource(rebasedPending)).toContain("https://example.test/B");
		const publishedBaseline = rebaseWorkspaceSource(publishedInput, compiledEntityFrom(stored));
		const next = deltaFor(rebasedPending, publishedBaseline);
		expect(next.xml).toContain("https://example.test/C");
	});

	it("keeps application caches and application-only definitions untouched if application XML is not verified", () => {
		const workspace = workspaceFrom();
		workspace.ribbons.Application = {
			location: "Application", entityLogicalName: "{!EntityLogicalName}",
			tabs: [{
				id: "global.Tab", label: "Global", sequence: 1, tabDisplayRules: [], sourceXml: '<Tab Id="global.Tab" VendorApp="old"/>', groups: [
					{
						id: "global.Group", label: "G", template: "", sequence: 10, sourceXml: '<Group Id="global.Group" VendorApp="old"/>', buttons: [
							{ id: "global.Button", label: "G", kind: "button", commandId: "global.Command", templateAlias: "o1", sequence: 10, hidden: false, oob: false, custom: true, managed: false, sourceXml: '<Button Id="global.Button" VendorApp="old"/>' },
						]
					},
				]
			}],
		};
		workspace.commands.push({ id: "global.Command", enableRules: [], displayRules: [], actions: [], sourceXml: '<CommandDefinition Id="global.Command" VendorApp="old"/>' });
		const next = rebaseWorkspaceSource(workspace, compiledEntityFrom(originalUnmanaged()));
		expect(next.ribbons.Application).toEqual(workspace.ribbons.Application);
		expect(next.commands.find((command) => command.id === "global.Command")).toEqual(workspace.commands.find((command) => command.id === "global.Command"));
	});

	it("refreshes independently verified application caches and adds its referenced generated label", () => {
		const workspace = workspaceFrom();
		workspace.ribbons.Application = {
			location: "Application", entityLogicalName: "{!EntityLogicalName}",
			tabs: [{
				id: "global.Tab", label: "Global", sequence: 10, sourceXml: '<Tab Id="global.Tab" Title="Global"/>', tabDisplayRules: [], groups: [
					{
						id: "global.Group", label: "Actions", template: "", sequence: 10, sourceXml: '<Group Id="global.Group" Title="Actions"/>', buttons: [
							{ id: "global.Button", label: "New Global Button", kind: "button", commandId: "global.Command", templateAlias: "o1", sequence: 10, hidden: false, oob: false, custom: true, managed: false, sourceXml: '<Button Id="global.Button" LabelText="Old"/>' },
						]
					},
				]
			}],
		};
		workspace.commands.push({ id: "global.Command", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "https://example.test/old-global", passParams: false, params: [] }], sourceXml: '<CommandDefinition Id="global.Command"><Actions><Url Address="https://example.test/old-global"/></Actions></CommandDefinition>' });
		const verifiedApplication = `<RibbonDefinitions><Ribbon><Tabs><Tab Id="global.Tab" Title="Global" Sequence="10" VendorTab="app-new"><Groups><Group Id="global.Group" Title="Actions" Sequence="10" VendorGroup="app-new"><Controls><Button Id="global.Button" Command="global.Command" LabelText="$LocLabels:global.Button.LabelText" VendorControl="app-new"/></Controls></Group></Groups></Tab></Tabs></Ribbon><CommandDefinitions><CommandDefinition Id="global.Command" VendorCommand="app-new"><EnableRules/><DisplayRules/><Actions><Url Address="https://example.test/new-global"/></Actions></CommandDefinition></CommandDefinitions><LocLabels><LocLabel Id="global.Button.LabelText"><Titles><Title languagecode="1033" description="New Global Button"/></Titles></LocLabel></LocLabels></RibbonDefinitions>`;
		const published = rebaseWorkspaceSource(workspace, compiledEntityFrom(originalUnmanaged()), verifiedApplication);
		const app = published.ribbons.Application.tabs[0];
		expect(app.sourceXml).toContain('VendorTab="app-new"');
		expect(app.groups[0].sourceXml).toContain('VendorGroup="app-new"');
		expect(app.groups[0].buttons[0].sourceXml).toContain('VendorControl="app-new"');
		expect(app.groups[0].buttons[0].label).toBe("New Global Button");
		expect(published.commands.find((command) => command.id === "global.Command")?.sourceXml).toContain("https://example.test/new-global");
		expect(published.commands.find((command) => command.id === "global.Command")?.actions).toEqual(workspace.commands.find((command) => command.id === "global.Command")?.actions);
		expect(published.locLabels.map((label) => label.id)).toContain("global.Button.LabelText");
	});

	it("fails closed on conflicting verified entity/application definitions for a shared command ID", () => {
		const workspace = workspaceFrom();
		const changed = workspace.commands.find((command) => command.id === COMMAND)!;
		if (changed.actions[0].kind !== "url") throw new Error("URL fixture expected");
		changed.actions[0].address = "https://example.test/deliberate-edit";
		workspace.ribbons.Application = {
			location: "Application", entityLogicalName: "{!EntityLogicalName}",
			tabs: [{
				id: "global.Tab", label: "Global", sequence: 10, tabDisplayRules: [], groups: [
					{
						id: "global.Group", label: "Actions", template: "", sequence: 10, buttons: [
							{ id: "global.Button", label: "Global", kind: "button", commandId: COMMAND, templateAlias: "o1", sequence: 10, hidden: false, oob: false, custom: true, managed: false },
						]
					},
				]
			}],
		};
		const application = `<RibbonDefinitions><Ribbon><Tabs><Tab Id="global.Tab" Title="Global"><Groups><Group Id="global.Group"><Controls><Button Id="global.Button" Command="${COMMAND}"/></Controls></Group></Groups></Tab></Tabs></Ribbon><CommandDefinitions><CommandDefinition Id="${COMMAND}"><Actions><Url Address="https://example.test/unrelated"/></Actions></CommandDefinition></CommandDefinitions></RibbonDefinitions>`;
		expect(() => rebaseWorkspaceSource(workspace, compiledEntityFrom(originalUnmanaged()), application)).toThrow(/conflict|shared|definition/i);
	});

	it("uses entity-first precedence for an unchanged shared command when application compiles a different definition", () => {
		const workspace = workspaceFrom();
		workspace.ribbons.Application = {
			location: "Application", entityLogicalName: "{!EntityLogicalName}",
			tabs: [{
				id: "global.Tab", label: "Global", sequence: 10, tabDisplayRules: [], groups: [
					{
						id: "global.Group", label: "Actions", template: "", sequence: 10, buttons: [
							{ id: "global.Button", label: "Global", kind: "button", commandId: COMMAND, templateAlias: "o1", sequence: 10, hidden: false, oob: false, custom: true, managed: false },
						]
					},
				]
			}],
		};
		const application = `<RibbonDefinitions><Ribbon><Tabs><Tab Id="global.Tab" Title="Global"><Groups><Group Id="global.Group"><Controls><Button Id="global.Button" Command="${COMMAND}"/></Controls></Group></Groups></Tab></Tabs></Ribbon><CommandDefinitions><CommandDefinition Id="${COMMAND}"><Actions><Url Address="https://example.test/app-variant"/></Actions></CommandDefinition></CommandDefinitions></RibbonDefinitions>`;
		const published = rebaseWorkspaceSource(workspace, compiledEntityFrom(originalUnmanaged()), application);
		expect(commandSource(published)).toContain("https://example.test/A");
		expect(published.commands.find((command) => command.id === COMMAND)?.actions).toEqual(workspace.commands.find((command) => command.id === COMMAND)?.actions);
	});

	it("uses the effective rendered control instead of a shadow CustomAction declaration with the same ID", () => {
		const workspace = workspaceFrom();
		const compiled = compiledEntityFrom(originalUnmanaged()).replace(
			"</RibbonDefinitions>",
			`<CustomActions><CustomAction Id="shadow.Action" Location="${BUTTON}"><CommandUIDefinition><Button Id="${BUTTON}" LabelText="Wrong shadow"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDefinitions>`,
		);
		const published = rebaseWorkspaceSource(workspace, compiled);
		const effective = published.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].sourceXml;
		expect(effective).toContain('LabelText="Original"');
		expect(effective).not.toContain("Wrong shadow");
	});

	it("refuses XML DOCTYPE and external entity declarations in purported compiled responses", () => {
		const workspace = workspaceFrom();
		const injected = '<!DOCTYPE RibbonDefinitions [<!ENTITY secret SYSTEM "file:///C:/private">]><RibbonDefinitions/>';
		expect(() => rebaseWorkspaceSource(workspace, injected)).toThrow(/DOCTYPE|entity|prohibit/i);
	});

	it("rejects conflicting referenced duplicate definitions and invalid or non-compiled XML", () => {
		const workspace = workspaceFrom();
		const compiled = compiledEntityFrom(originalUnmanaged());
		const conflicting = workspace.commands[0].sourceXml!.replace("https://example.test/A", "https://example.test/conflicting");
		const duplicate = compiled.replace("</CommandDefinitions>", `${conflicting}</CommandDefinitions>`);
		expect(() => rebaseWorkspaceSource(workspace, duplicate)).toThrow(/duplicate|ambiguous/i);
		expect(() => rebaseWorkspaceSource(workspace, "<RibbonDefinitions>")).toThrow(/xml|parse|valid/i);
		expect(() => rebaseWorkspaceSource(workspace, originalUnmanaged())).toThrow(/compiled|RibbonDefinitions/i);
	});

	it("deduplicates identical platform command declarations in a real-style compiled response", () => {
		const workspace = workspaceFrom();
		const compiled = compiledEntityFrom(originalUnmanaged());
		const repeated = compiled.replace("</CommandDefinitions>", `${workspace.commands[0].sourceXml}</CommandDefinitions>`);
		const published = rebaseWorkspaceSource(workspace, repeated);
		expect(commandSource(published)).toContain("https://example.test/A");
	});

	it("ignores conflicting unreferenced platform declaration duplicates", () => {
		const workspace = workspaceFrom();
		const compiled = compiledEntityFrom(originalUnmanaged());
		const unrelated = `<CommandDefinition Id="Mscrm.UnusedPlatformAction"><Actions><Url Address="https://example.test/one"/></Actions></CommandDefinition><CommandDefinition Id="Mscrm.UnusedPlatformAction"><Actions><Url Address="https://example.test/two"/></Actions></CommandDefinition>`;
		const withDuplicates = compiled.replace("</CommandDefinitions>", `${unrelated}</CommandDefinitions>`);
		const published = rebaseWorkspaceSource(workspace, withDuplicates);
		expect(commandSource(published)).toContain("https://example.test/A");
	});
});

describe("rebasePendingWorkspace: cache-only transfer into later-edited current", () => {
	it("retains later URL C while replacing prepublish raw A with verified raw B", () => {
		const initial = workspaceFrom();
		const before = copy(initial);
		const old = before.commands.find((command) => command.id === COMMAND)!;
		if (old.actions[0].kind !== "url") throw new Error("URL fixture expected");
		old.actions[0].address = "https://example.test/B";
		const storedB = mergeRibbonDiffXml(originalUnmanaged(), [deltaFor(before, initial)]);
		const rebasedPublished = rebaseWorkspaceSource(before, compiledEntityFrom(storedB));
		const latest = copy(before);
		const later = latest.commands.find((command) => command.id === COMMAND)!;
		if (later.actions[0].kind !== "url") throw new Error("URL fixture expected");
		later.actions[0].address = "https://example.test/C";
		const result = rebasePendingWorkspace(latest, before, rebasedPublished);
		expect(commandSource(result)).toContain("https://example.test/B");
		expect(commandSource(latest)).toContain("https://example.test/A");
		expect(result.commands.find((command) => command.id === COMMAND)?.actions).toEqual(later.actions);
		expect(deltaFor(result, rebasedPublished).xml).toContain("https://example.test/C");
	});

	it("retains an independently refreshed raw cache and never overwrites newer values", () => {
		const before = workspaceFrom();
		const published = copy(before);
		published.commands[0].sourceXml = published.commands[0].sourceXml?.replace("/A", "/B");
		const latest = copy(before);
		latest.commands[0].sourceXml = latest.commands[0].sourceXml?.replace("/A", "/locally-cached-C");
		if (latest.commands[0].actions[0].kind !== "url") throw new Error("URL fixture expected");
		latest.commands[0].actions[0].address = "https://example.test/new-authored";
		const rebased = rebasePendingWorkspace(latest, before, published);
		expect(commandSource(rebased)).toContain("/locally-cached-C");
		expect(rebased.commands[0].actions).toEqual(latest.commands[0].actions);
	});

	it("adopts generated labels absent at publish start but never resurrects explicitly removed labels", () => {
		const initial = workspaceFrom();
		const before = copy(initial);
		before.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].label = "Renamed label";
		const stored = mergeRibbonDiffXml(originalUnmanaged(), [deltaFor(before, initial)]);
		const published = rebaseWorkspaceSource(before, compiledEntityFrom(stored));
		expect(before.locLabels).toHaveLength(0);
		expect(published.locLabels.map((label) => label.id)).toContain(LABEL);
		const pending = copy(before);
		pending.commands[0].enableRules = [];
		const adopted = rebasePendingWorkspace(pending, before, published);
		expect(adopted.locLabels.map((label) => label.id)).toContain(LABEL);
		expect(adopted.commands[0].enableRules).toEqual([]);

		const beforeWithLabel = copy(published);
		const nextPublished = copy(published);
		nextPublished.locLabels[0].sourceXml = nextPublished.locLabels[0].sourceXml?.replace("Renamed", "Published");
		const explicitlyRemoved = copy(beforeWithLabel);
		explicitlyRemoved.locLabels = [];
		const merged = rebasePendingWorkspace(explicitlyRemoved, beforeWithLabel, nextPublished);
		expect(merged.locLabels).toHaveLength(0);
	});

	it("refuses to transfer caches across mismatched entity workspaces", () => {
		const before = workspaceFrom();
		const current = copy(before);
		current.ribbons.Form.entityLogicalName = "contact";
		expect(() => rebasePendingWorkspace(current, before, before)).toThrow(/workspace|entity|mismatch/i);
	});
});
