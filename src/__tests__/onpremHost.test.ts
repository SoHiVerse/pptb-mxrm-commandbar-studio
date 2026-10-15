import { describe, expect, it, vi } from "vitest";
import { createOnPremHost } from "@/hosts/onpremHost";

const ID = "abf1037e-a1b2-4d33-8a56-b1d3f1a38e70";
const PAGE = "https://crm.example.test/Org/WebResources/prefix_/commandbarstudio/onprem.html";
const ORG = "https://crm.example.test/Org";

function reply(body: unknown, status = 200, contentType = "application/json", headers: Record<string, string> = {}): Response {
	const responseHeaders = new Map(Object.entries({ "content-type": contentType, ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 503 ? "Service Unavailable" : status === 401 ? "Unauthorized" : "Response",
		headers: { get: (key: string) => responseHeaders.get(key.toLowerCase()) ?? null },
		text: async () => typeof body === "string" ? body : JSON.stringify(body),
	} as unknown as Response;
}

function fixture(handler: (url: URL, init: RequestInit) => Response | Promise<Response>, extras: Record<string, unknown> = {}) {
	const seen: Array<{ url: URL; init: RequestInit }> = [];
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = { url: new URL(String(input)), init: init ?? {} };
		seen.push(request);
		return handler(request.url, request.init);
	});
	return {
		seen,
		fetchImpl,
		host: createOnPremHost({ orgUrl: ORG, pageUrl: PAGE, fetchImpl, ...extras }),
	};
}

describe("native authenticated Dataverse host", () => {
	it("rejects a context for a different origin or a different organization path", () => {
		const fetchImpl = vi.fn();
		expect(() => createOnPremHost({ orgUrl: "https://evil.example/Org", pageUrl: PAGE, fetchImpl })).toThrow(/origin/i);
		expect(() => createOnPremHost({ orgUrl: "https://crm.example.test/OtherOrg", pageUrl: PAGE, fetchImpl })).toThrow(/organization|WebResources/i);
		expect(() => createOnPremHost({ orgUrl: "https://crm.example.test/Org", pageUrl: "https://crm.example.test/OrgElse/WebResources/prefix_/commandbarstudio/onprem.html", fetchImpl })).toThrow(/organization|WebResources/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("uses the exact organization API base with session credentials and no redirect following", async () => {
		const { host, seen } = fixture(() => reply({ value: [{ solutionid: ID }] }));
		const result = await host.dataverseAPI.queryData("solutions?$select=solutionid");
		expect(result.value).toEqual([{ solutionid: ID }]);
		expect(seen[0].url.href).toBe(`${ORG}/api/data/v9.1/solutions?$select=solutionid`);
		expect(seen[0].init.credentials).toBe("same-origin");
		expect(seen[0].init.redirect).toBe("error");
	});

	it("blocks absolute external or path traversal URLs before any request", async () => {
		const { host, seen } = fixture(() => reply({ value: [] }));
		await expect(host.dataverseAPI.queryData("https://evil.example/steal")).rejects.toThrow(/API|origin|URL/i);
		await expect(host.dataverseAPI.queryData("//evil.example/steal")).rejects.toThrow(/API|origin|URL/i);
		await expect(host.dataverseAPI.queryData("../api/data/v9.1/solutions")).rejects.toThrow(/path|URL/i);
		await expect(host.dataverseAPI.queryData("solutions#fragment")).rejects.toThrow(/fragment|URL/i);
		expect(seen).toHaveLength(0);
	});

	it("follows validated OData pages and concatenates their rows", async () => {
		const { host, seen } = fixture((url) => url.searchParams.has("$skiptoken")
			? reply({ value: [{ name: "second" }] })
			: reply({ value: [{ name: "first" }], "@odata.nextLink": `${ORG}/api/data/v9.1/solutions?$skiptoken=next` }));
		expect((await host.dataverseAPI.queryData("solutions?$select=name")).value).toEqual([{ name: "first" }, { name: "second" }]);
		expect(seen).toHaveLength(2);
	});

	it("rejects forged paging origins, other organizations, and changed endpoints", async () => {
		for (const next of [
			"https://outside.example/api/data/v9.1/solutions?$skiptoken=1",
			"https://crm.example.test/OtherOrg/api/data/v9.1/solutions?$skiptoken=1",
			`${ORG}/api/data/v9.1/systemusers?$skiptoken=1`,
		]) {
			const { host, seen } = fixture(() => reply({ value: [{ name: "first" }], "@odata.nextLink": next }));
			await expect(host.dataverseAPI.queryData("solutions?$top=1")).rejects.toThrow(/page|origin|path|endpoint/i);
			expect(seen).toHaveLength(1);
		}
	});

	it("rejects encoded traversal and path separators in a paging pathname", async () => {
		for (const next of [
			`${ORG}/api/data/v9.1/solutions%2Fmore?$skiptoken=next`,
			`${ORG}/api/data/v9.1/intermediate/%2e%2e/solutions?$skiptoken=next`,
			`${ORG}/api/data/v9.1/solutions%5Cother?$skiptoken=next`,
		]) {
			const { host, seen } = fixture(() => reply({ value: [], "@odata.nextLink": next }));
			await expect(host.dataverseAPI.queryData("solutions?$top=1")).rejects.toThrow(/paging|path|endpoint/i);
			expect(seen).toHaveLength(1);
		}
	});

	it("rejects literal dot segments in a server paging pathname before URL normalization", async () => {
		const next = `${ORG}/api/data/v9.1/intermediate/../solutions?$skiptoken=next`;
		const { host, seen } = fixture(() => reply({ value: [], "@odata.nextLink": next }));
		await expect(host.dataverseAPI.queryData("solutions?$top=1")).rejects.toThrow(/paging|traversal|path/i);
		expect(seen).toHaveLength(1);
	});

	it("detects repeated paging cursors before looping", async () => {
		const next = `${ORG}/api/data/v9.1/solutions?$skiptoken=repeated`;
		const { host, seen } = fixture(() => reply({ value: [], "@odata.nextLink": next }));
		await expect(host.dataverseAPI.queryData("solutions?$top=1")).rejects.toThrow(/page|cycle|loop/i);
		expect(seen).toHaveLength(2);
	});

	it("preserves singleton EntityDefinitions metadata rather than wrapping it in a collection", async () => {
		const { host } = fixture(() => reply({ MetadataId: ID, LogicalName: "account" }));
		const record = await host.dataverseAPI.queryData(`EntityDefinitions(${ID})?$select=MetadataId,LogicalName`);
		expect(record).toEqual({ MetadataId: ID, LogicalName: "account" });
	});

	it("rejects malformed collection payloads instead of returning an empty catalog", async () => {
		const { host } = fixture(() => reply({ unexpected: true }));
		await expect(host.dataverseAPI.queryData("solutions?$select=solutionid")).rejects.toThrow(/collection|value/i);
	});

	it("maps logical names to actual entity sets, retaining the record shape", async () => {
		const { host, seen } = fixture(() => reply({ fullname: "Tester" }));
		expect(await host.dataverseAPI.retrieve("systemuser", ID, ["fullname"])).toEqual({ fullname: "Tester" });
		expect(seen[0].url.pathname).toBe(`/Org/api/data/v9.1/systemusers(${ID})`);
		expect(seen[0].url.searchParams.get("$select")).toBe("fullname");
		await host.dataverseAPI.retrieve("webresource", ID, ["content"]);
		expect(seen[1].url.pathname).toBe(`/Org/api/data/v9.1/webresourceset(${ID})`);
		await host.dataverseAPI.retrieve("asyncoperation", ID);
		expect(seen[2].url.pathname).toBe(`/Org/api/data/v9.1/asyncoperations(${ID})`);
	});

	it("resolves the singular importjob logical name without guessed pluralization", async () => {
		const { host, seen } = fixture(() => reply({ importjobid: ID, statuscode: 30 }));
		expect(await host.dataverseAPI.retrieve("importjob", ID, ["statuscode"])).toMatchObject({ statuscode: 30 });
		expect(seen).toHaveLength(1);
		expect(seen[0].url.pathname).toBe(`/Org/api/data/v9.1/importjobs(${ID})`);
	});

	it("expands publisher navigation when getSolutions asks for publisherid", async () => {
		const { host, seen } = fixture(() => reply({ value: [{ solutionid: ID, publisherid: { friendlyname: "Publisher", customizationprefix: "pub" } }] }));
		const result = await host.dataverseAPI.getSolutions(["solutionid", "publisherid", "friendlyname"]);
		expect(result.value[0].publisherid).toEqual({ friendlyname: "Publisher", customizationprefix: "pub" });
		expect(seen[0].url.searchParams.get("$select")).toBe("solutionid,friendlyname");
		expect(seen[0].url.searchParams.get("$expand")).toBe("publisherid($select=friendlyname,customizationprefix)");
	});

	it("resolves an unknown custom table's actual EntitySetName from metadata", async () => {
		const { host, seen } = fixture((url) => url.pathname.endsWith("EntityDefinitions(LogicalName='custom_case')")
			? reply({ EntitySetName: "custom_cases" })
			: reply({ custom_caseid: ID }));
		expect(await host.dataverseAPI.retrieve("custom_case", ID)).toEqual({ custom_caseid: ID });
		expect(seen[0].url.pathname).toContain("EntityDefinitions(LogicalName='custom_case')");
		expect(seen[1].url.pathname).toBe(`/Org/api/data/v9.1/custom_cases(${ID})`);
	});

	it("encodes OData function string escaping, typed enum literals, and GUID values", async () => {
		const { host, seen } = fixture(() => reply({ CompressedEntityXml: "UEs=" }));
		await host.dataverseAPI.execute({
			operationName: "RetrieveEntityRibbon", operationType: "function", parameters: {
				EntityName: "O'Neil", RibbonLocationFilter: "Microsoft.Dynamics.CRM.RibbonLocationFilters'All'", RequestId: ID,
			}
		});
		const decoded = decodeURIComponent(seen[0].url.href);
		expect(seen[0].init.method).toBe("GET");
		expect(decoded).toContain("'O''Neil'");
		expect(decoded).toContain("Microsoft.Dynamics.CRM.RibbonLocationFilters'All'");
		expect(decoded).toContain(ID);
		expect(decoded).not.toContain(`'${ID}'`);
	});

	it("sends parameterless Web API functions with required empty parentheses", async () => {
		const { host, seen } = fixture(() => reply({ UserId: ID }));
		await host.dataverseAPI.execute({ operationName: "WhoAmI", operationType: "function" });
		await host.dataverseAPI.execute({ operationName: "RetrieveApplicationRibbon", operationType: "function" });
		expect(seen.map((s) => s.url.pathname)).toEqual([
			"/Org/api/data/v9.1/WhoAmI()",
			"/Org/api/data/v9.1/RetrieveApplicationRibbon()",
		]);
	});

	it("executes ExportSolution as a POST action with its exact supplied inputs", async () => {
		const { host, seen } = fixture(() => reply({ ExportSolutionFile: "UEs=" }));
		expect(await host.dataverseAPI.execute({ operationName: "ExportSolution", operationType: "action", parameters: { SolutionName: "Unmanaged", Managed: false } }))
			.toEqual({ ExportSolutionFile: "UEs=" });
		expect(seen[0].url.pathname).toBe("/Org/api/data/v9.1/ExportSolution");
		expect(seen[0].init.method).toBe("POST");
		expect(JSON.parse(String(seen[0].init.body))).toEqual({ SolutionName: "Unmanaged", Managed: false });
	});

	it("accepts a real created GUID from OData-EntityId on a 204 response", async () => {
		const { host, seen } = fixture(() => reply("", 204, "", { "odata-entityid": `${ORG}/api/data/v9.1/webresourceset(${ID})` }));
		expect(await host.dataverseAPI.create("webresource", { name: "prefix_/icon.svg", webresourcetype: 11 })).toEqual({ id: ID });
		expect(seen[0].url.pathname).toBe("/Org/api/data/v9.1/webresourceset");
		expect(seen[0].init.method).toBe("POST");
	});

	it("does not report a synthetic ID when CRM omits both body ID and entity-ID headers", async () => {
		const { host, seen } = fixture(() => reply("", 204));
		await expect(host.dataverseAPI.create("webresource", { name: "prefix_/new.js" })).rejects.toThrow(/ID|identifier|uncertain/i);
		expect(seen).toHaveLength(1);
	});

	it("supports 204 PATCH updates without demanding a JSON body", async () => {
		const { host, seen } = fixture(() => reply("", 204));
		await expect(host.dataverseAPI.update("webresource", ID, { content: "ZGF0YQ==" })).resolves.toBeUndefined();
		expect(seen[0].init.method).toBe("PATCH");
		expect((seen[0].init.headers as Record<string, string>)["If-Match"]).toBe("*");
	});

	it("keeps HTTP error codes and CRM messages and rejects HTML login pages", async () => {
		const { host } = fixture(() => reply({ error: { code: "0x80060888", message: "Entity not found" } }, 400));
		await expect(host.dataverseAPI.queryData("solutions")).rejects.toThrow(/0x80060888.*Entity not found/);
		const redirected = fixture(() => reply("<html>Sign in</html>", 200, "text/html"));
		await expect(redirected.host.dataverseAPI.queryData("solutions")).rejects.toThrow(/HTML|login|session/i);
		const expired = fixture(() => reply("", 401, "text/html"));
		await expect(expired.host.dataverseAPI.queryData("solutions")).rejects.toThrow(/401|sign in|session/i);
	});

	it("does not retry a 200 HTML login response as though it were a transient network failure", async () => {
		const { host, seen } = fixture(() => reply("<html>Session expired</html>", 200, "text/html"));
		await expect(host.dataverseAPI.queryData("solutions")).rejects.toThrow(/login|session/i);
		expect(seen).toHaveLength(1);
	});

	it("preserves a definite HTTP 401 login rejection for writes instead of claiming unknown outcome", async () => {
		const { host, seen } = fixture(() => reply("<html>Sign in</html>", 401, "text/html"));
		await expect(host.dataverseAPI.update("webresource", ID, { content: "x" }))
			.rejects.toThrow(/HTTP 401.*session|HTTP 401.*login/i);
		expect(seen).toHaveLength(1);
	});

	it("retries a transient GET a bounded number of times", async () => {
		let attempts = 0;
		const { host, seen } = fixture(() => ++attempts === 1 ? reply({ error: { message: "Unavailable" } }, 503) : reply({ value: [] }));
		expect((await host.dataverseAPI.queryData("solutions")).value).toEqual([]);
		expect(seen).toHaveLength(2);
	});

	it("rejects a secondary connection selector instead of silently using the native primary org", async () => {
		const { host, seen } = fixture(() => reply({ value: [] }));
		await expect(host.dataverseAPI.queryData("solutions", "secondary")).rejects.toThrow(/connection|primary/i);
		expect(seen).toHaveLength(0);
	});

	it("never retries a write after an uncertain network failure", async () => {
		const seen: RequestInit[] = [];
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			seen.push(init ?? {});
			throw new TypeError("Network connection lost");
		});
		const host = createOnPremHost({ orgUrl: ORG, pageUrl: PAGE, fetchImpl, timeoutMs: 25 });
		await expect(host.dataverseAPI.execute({ operationName: "PublishXml", operationType: "action", parameters: { ParameterXml: "<xml/>" } }))
			.rejects.toThrow(/outcome|unknown|uncertain/i);
		expect(seen).toHaveLength(1);
	});

	it("rejects an unresponsive write on its deadline without retrying", async () => {
		const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => new Promise(() => { }));
		const host = createOnPremHost({ orgUrl: ORG, pageUrl: PAGE, fetchImpl, timeoutMs: 15 });
		await expect(host.dataverseAPI.update("webresource", ID, { content: "updated" })).rejects.toThrow(/timeout|uncertain|outcome/i);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("imports once with a valid job GUID and retains the returned job ID", async () => {
		const { host, seen } = fixture(() => reply("", 204));
		const result = await host.dataverseAPI.deploySolution("UEs=", {
			importJobId: ID, publishWorkflows: false, overwriteUnmanagedCustomizations: false,
		});
		expect(result).toEqual({ ImportJobId: ID });
		expect(seen[0].init.method).toBe("POST");
		expect(seen[0].url.pathname).toBe("/Org/api/data/v9.1/ImportSolution");
		expect(JSON.parse(String(seen[0].init.body))).toMatchObject({
			CustomizationFile: "UEs=", ImportJobId: ID, PublishWorkflows: false, OverwriteUnmanagedCustomizations: false,
		});
		expect(seen).toHaveLength(1);
	});

	it("retrieves an import job without inferring success from progress", async () => {
		const { host, seen } = fixture(() => reply({ importjobid: ID, progress: 100, statuscode: 31, data: "<error />" }));
		expect(await host.dataverseAPI.getImportJobStatus(ID)).toMatchObject({ progress: 100, statuscode: 31, data: "<error />" });
		expect(seen[0].url.pathname).toBe(`/Org/api/data/v9.1/importjobs(${ID})`);
	});

	it("publishes only the requested entity using PublishXml rather than a global fallback", async () => {
		const { host, seen } = fixture(() => reply("", 204));
		await host.dataverseAPI.publishCustomizations("account");
		expect(seen).toHaveLength(1);
		expect(seen[0].url.pathname).toBe("/Org/api/data/v9.1/PublishXml");
		expect(JSON.parse(String(seen[0].init.body)).ParameterXml).toContain("<entity>account</entity>");
	});

	it("denies PublishAllXmlAsync until its real action is positively found in CSDL", async () => {
		const { host, seen } = fixture((_url) => reply("<Edmx><Schema Namespace='Microsoft.Dynamics.CRM'><Action Name='PublishAllXmlAsync' /></Schema></Edmx>", 200, "application/xml"));
		await expect(host.dataverseAPI.execute({ operationName: "PublishAllXmlAsync", operationType: "action" })).rejects.toThrow(/unavailable|capability|CSDL/i);
		expect(seen).toHaveLength(0);
		expect(await host.detectCapabilities()).toEqual({ kind: "onpremises", publishAllXmlAsync: true });
	});

	it("does not enable async publish when CSDL lacks the exact Dynamics action", async () => {
		const { host } = fixture(() => reply("<Edmx><Schema Namespace='Other.Namespace'><Action Name='PublishAllXmlAsync'/></Schema></Edmx>", 200, "application/xml"));
		expect(await host.detectCapabilities()).toEqual({ kind: "onpremises", publishAllXmlAsync: false });
	});

	it("exposes browser theme, connection, preview and clipboard conveniences", async () => {
		const { host } = fixture(() => reply({ value: [] }));
		const conn = await host.toolboxAPI.connections.getActiveConnection();
		expect(conn?.url).toBe(ORG);
		expect(conn?.environment).toBe("Production");
		expect(["light", "dark"]).toContain(await host.toolboxAPI.utils.getCurrentTheme());
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		await host.toolboxAPI.utils.openInConnectionBrowser(`${ORG}/main.aspx?pagetype=entitylist&etn=account`, "primary");
		expect(open).toHaveBeenCalledWith(`${ORG}/main.aspx?pagetype=entitylist&etn=account`, "_blank", "noopener,noreferrer");
		await expect(host.toolboxAPI.utils.openInConnectionBrowser("https://evil.example", "primary")).rejects.toThrow(/origin|organization/i);
		open.mockRestore();
	});

	it("copies text using the native browser clipboard when available", async () => {
		const { host } = fixture(() => reply({ value: [] }));
		const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		const writeText = vi.fn(async (_text: string) => undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		try {
			await host.toolboxAPI.utils.copyToClipboard("ribbon definition");
			expect(writeText).toHaveBeenCalledWith("ribbon definition");
		} finally {
			if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
			else Reflect.deleteProperty(navigator, "clipboard");
		}
	});
});
