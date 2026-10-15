import { describe, expect, it } from "vitest";
import { resolveRibbonIconUrl } from "@/utils/ribbonIconUrl";

const ORG = "https://example.test/sample-org";

describe("resolveRibbonIconUrl", () => {
	it("resolves nested classic-ribbon resources beneath the active organization", () => {
		expect(resolveRibbonIconUrl("$webresource:sample_/icons/ribbon/primary.svg", ORG))
			.toBe(`${ORG}/WebResources/sample_/icons/ribbon/primary.svg`);
		expect(resolveRibbonIconUrl("$webresource:sample_/icons/ribbon/secondary.png", ORG))
			.toBe(`${ORG}/WebResources/sample_/icons/ribbon/secondary.png`);
		expect(resolveRibbonIconUrl("$webresource:sample_/images/appointments/create.png", ORG))
			.toBe(`${ORG}/WebResources/sample_/images/appointments/create.png`);
	});

	it("preserves organization virtual-directory prefixes, ports and optional trailing slash", () => {
		expect(resolveRibbonIconUrl("$webresource:Publisher_/icons/View.svg", "http://crm.example.test:5555/CRM/Org/"))
			.toBe("http://crm.example.test:5555/CRM/Org/WebResources/Publisher_/icons/View.svg");
		expect(resolveRibbonIconUrl("$webresource:Publisher_/icons/View.svg", "https://crm.example.test"))
			.toBe("https://crm.example.test/WebResources/Publisher_/icons/View.svg");
	});

	it("URI-encodes each filename segment without flattening legitimate subdirectories", () => {
		expect(resolveRibbonIconUrl("$webresource:Team Assets/Icons/Sales & Support's.svg", ORG))
			.toBe(`${ORG}/WebResources/Team%20Assets/Icons/Sales%20%26%20Support%27s.svg`);
		expect(resolveRibbonIconUrl("$webresource:Team%20Assets/Icons/Icon%20One.svg", ORG))
			.toBe(`${ORG}/WebResources/Team%20Assets/Icons/Icon%20One.svg`);
		expect(resolveRibbonIconUrl("$webresource:محتوا/ساعت.svg", ORG))
			.toBe(`${ORG}/WebResources/${encodeURIComponent("محتوا")}/${encodeURIComponent("ساعت.svg")}`);
	});

	it("does not interpret Fluent library names, resource tokens or missing organizations as URLs", () => {
		for (const icon of ["search", "apps_add_in", "$Resources:Ribbon.Home.Icon", "", "https://evil.test/logo.svg"]) {
			expect(resolveRibbonIconUrl(icon, ORG)).toBeNull();
		}
		expect(resolveRibbonIconUrl("$webresource:Service/Good.svg", "")).toBeNull();
	});

	it("rejects traversal, encoded path escapes, backslashes and external or executable schemes", () => {
		const attacks = [
			"$webresource:",
			"$webresource:/Service/Icon.svg",
			"$webresource://evil.test/image.svg",
			"$webresource:https://evil.test/image.svg",
			"$webresource:http://evil.test/image.svg",
			"$webresource:javascript:alert(1)",
			"$webresource:data:image/svg+xml,hello",
			"$webresource:Service\\_imgs\\Icon.svg",
			"$webresource:Service/../Image.svg",
			"$webresource:Service/./Image.svg",
			"$webresource:Service//Image.svg",
			"$webresource:Service/%2e%2e/Image.svg",
			"$webresource:Service/%2E/Image.svg",
			"$webresource:Service/%252e%252e/Image.svg",
			"$webresource:Service/%2fhidden.svg",
			"$webresource:Service/%5Cwindows.svg",
			"$webresource:Service/%253Ainvalid.svg",
			"$webresource:Service/Bad%ZZ.svg",
			"$webresource:Service/Icon.svg?token=secret",
			"$webresource:Service/Icon.svg#fragment",
		];
		for (const attack of attacks) {
			expect(resolveRibbonIconUrl(attack, ORG), attack).toBeNull();
		}
	});

	it("refuses untrusted organization protocols, credentials, query/hash and path escapes", () => {
		const badOrganizations = [
			"javascript:alert(1)",
			"data:text/html,evil",
			"file:///C:/CRM",
			"https://user:password@crm.example.test/Org",
			"https://crm.example.test/Org?secret=true",
			"https://crm.example.test/Org#hash",
			"https://crm.example.test/Org/../Other",
			"https://crm.example.test/Org/%2e%2e/Other",
			"https://crm.example.test/Org/%252e%252e/Other",
			"https://crm.example.test/Org/%2Fadmin",
			"https://crm.example.test/Org\\Other",
		];
		for (const org of badOrganizations) {
			expect(resolveRibbonIconUrl("$webresource:Service/Good.svg", org), org).toBeNull();
		}
	});
});
