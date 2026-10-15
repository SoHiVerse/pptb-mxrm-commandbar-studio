import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { installOnPremHost } from "@/hosts/onpremHost";
import { getRuntimeCapabilities } from "@/hosts/runtime";
import { bootstrapOnPrem } from "@/hosts/bootstrap";

const PAGE = "https://crm.example.test/Org/WebResources/prefix_/commandbarstudio/onprem.html";
const ORG = "https://crm.example.test/Org";

beforeEach(() => {
	vi.stubGlobal("dataverseAPI", undefined);
	vi.stubGlobal("toolboxAPI", undefined);
});

describe("on-premises native bootstrap", () => {
	it("loads ClientGlobalContext synchronously before the native entry module", () => {
		const html = readFileSync("onprem.html", "utf8");
		expect(html).toContain('<script src="../../ClientGlobalContext.js.aspx"></script>');
		expect(html).toContain('<script type="module" src="/src/onprem.ts"></script>');
		expect(html.indexOf("ClientGlobalContext.js.aspx\"></script>")).toBeLessThan(html.indexOf("/src/onprem.ts\"></script>"));
	});
	it("refuses to install without synchronous ClientGlobalContext", () => {
		expect(() => installOnPremHost({ pageUrl: PAGE })).toThrow(/ClientGlobalContext|GetGlobalContext/i);
	});

	it("installs native globals before importing the existing app and sets safe capabilities", async () => {
		const context = { getClientUrl: () => ORG, getOrgUniqueName: () => "DemoOrg" };
		const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, statusText: "Not Found", headers: { get: () => "application/json" }, text: async () => "{}" }) as unknown as Response);
		const snapshots: string[] = [];
		await bootstrapOnPrem(async () => {
			expect(window.dataverseAPI).toBeDefined();
			expect(window.toolboxAPI).toBeDefined();
			snapshots.push(getRuntimeCapabilities().kind);
		}, { globalContext: context, pageUrl: PAGE, fetchImpl });
		expect(snapshots).toEqual(["onpremises"]);
		expect(getRuntimeCapabilities().publishAllXmlAsync).toBe(false);
		expect((await window.toolboxAPI.connections.getActiveConnection())?.name).toBe("DemoOrg");
	});

	it("never overwrites a genuine PPTB host", async () => {
		const originalDataverse = { queryData: vi.fn() };
		const originalToolbox = { connections: { getActiveConnection: vi.fn() } };
		vi.stubGlobal("dataverseAPI", originalDataverse);
		vi.stubGlobal("toolboxAPI", originalToolbox);
		await bootstrapOnPrem(async () => {
			expect(window.dataverseAPI).toBe(originalDataverse);
			expect(window.toolboxAPI).toBe(originalToolbox);
			expect(getRuntimeCapabilities()).toEqual({ kind: "pptb", publishAllXmlAsync: true });
		});
	});

	it("reports a missing context or failed dynamic import to the visible root", async () => {
		const root = document.createElement("div");
		root.id = "root";
		document.body.appendChild(root);
		try {
			await bootstrapOnPrem(async () => { throw new Error("chunk unavailable"); }, {
				globalContext: { getClientUrl: () => ORG },
				pageUrl: PAGE,
				fetchImpl: vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => "" }) as unknown as Response),
			});
			expect(root.getAttribute("role")).toBe("alert");
			expect(root.textContent).toMatch(/chunk unavailable/i);
		} finally {
			root.remove();
		}
	});
});
