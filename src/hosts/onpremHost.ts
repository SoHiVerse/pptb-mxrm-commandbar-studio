import { activateOnPremRuntime, activatePptbRuntime, type RuntimeCapabilities } from "./runtime";

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENTITY_SET: Record<string, string> = {
	account: "accounts",
	asyncoperation: "asyncoperations",
	importjob: "importjobs",
	solution: "solutions",
	systemuser: "systemusers",
	webresource: "webresourceset",
};
const READ_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_PAGES = 100;

/** These are the only host APIs called by Command Bar Studio. */
export type NativeDataverseAPI = Pick<
	DataverseAPI.API,
	| "queryData"
	| "execute"
	| "retrieve"
	| "create"
	| "update"
	| "getSolutions"
	| "deploySolution"
	| "getImportJobStatus"
	| "publishCustomizations"
>;

export interface NativeToolboxAPI {
	connections: Pick<ToolBoxAPI.ConnectionsAPI, "getActiveConnection">;
	utils: Pick<ToolBoxAPI.UtilsAPI, "getCurrentTheme" | "openInConnectionBrowser" | "copyToClipboard">;
}

export interface OnPremHostOptions {
	orgUrl: string;
	/** The web-resource URL. Inject this in tests; defaults to the current document. */
	pageUrl?: string;
	organizationName?: string;
	fetchImpl?: typeof fetch;
	/** Per-request timeout, including reading the response body. */
	timeoutMs?: number;
	onCapabilitiesChanged?: (capabilities: RuntimeCapabilities) => void;
}

export interface CrmGlobalContext {
	getClientUrl(): string;
	getOrgUniqueName?(): string;
}

export type OnPremInstallOptions = Omit<OnPremHostOptions, "orgUrl" | "organizationName" | "onCapabilitiesChanged"> & {
	globalContext?: CrmGlobalContext;
};

export interface OnPremHost {
	dataverseAPI: NativeDataverseAPI;
	toolboxAPI: NativeToolboxAPI;
	detectCapabilities(): Promise<RuntimeCapabilities>;
}

interface HttpReply {
	response: Response;
	data: unknown;
}

class OnPremHttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(`Dynamics Web API HTTP ${status}: ${message}`);
		this.name = "OnPremHttpError";
	}
}

class OnPremNetworkError extends Error {
	constructor(message: string, readonly causeValue?: unknown) {
		super(message);
		this.name = "OnPremNetworkError";
	}
}

class OnPremResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OnPremResponseError";
	}
}

export class OnPremWriteOutcomeUnknownError extends Error {
	constructor(operation: string, reason: string) {
		super(`${operation}: write outcome uncertain. Do not retry automatically; check Dynamics before attempting again. ${reason}`);
		this.name = "OnPremWriteOutcomeUnknownError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIdentifier(value: string, label: string): string {
	if (!IDENTIFIER.test(value)) throw new Error(`Invalid ${label}: ${value}`);
	return value;
}

function assertGuid(value: string, label: string): string {
	const guid = value.replace(/^\{(.*)\}$/, "$1");
	if (!GUID_PATTERN.test(guid)) throw new Error(`Invalid ${label} GUID: ${value}`);
	return guid;
}

function requirePrimaryConnection(
	target?: DataverseAPI.ConnectionTarget,
	additionalHeaders?: DataverseAPI.AdditionalHeaders,
): void {
	if (target !== undefined && target !== "primary" && target !== 0) {
		throw new Error("Native Dynamics supports only the current primary organization connection");
	}
	if (additionalHeaders && Object.keys(additionalHeaders).length) {
		throw new Error("Native Dynamics does not accept additional host request headers");
	}
}

function rejectEncodedPathSeparators(url: string): void {
	// Validate the raw path before URL construction canonicalizes encoded dot
	// segments. Query values may legitimately contain percent-encoded slashes.
	const pathname = url.split("?", 1)[0].split("#", 1)[0];
	if (/%(?:2f|5c|2e)/i.test(pathname) || /\\/.test(pathname) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname)) {
		throw new Error("Rejected encoded traversal or separator in Dynamics URL path");
	}
}

function validateOriginAndPaths(orgUrl: string, pageUrl: string): { org: URL; apiBase: URL; orgPath: string } {
	rejectEncodedPathSeparators(orgUrl);
	rejectEncodedPathSeparators(pageUrl);
	let org: URL;
	let page: URL;
	try {
		org = new URL(orgUrl);
		page = new URL(pageUrl);
	} catch {
		throw new Error("Invalid Dynamics organization or web-resource URL");
	}
	if (!["https:", "http:"].includes(org.protocol) || org.username || org.password || org.search || org.hash) {
		throw new Error("Dynamics organization URL must be an HTTP(S) origin and path without credentials, query or fragment");
	}
	if (org.origin !== page.origin || page.username || page.password) {
		throw new Error("Dynamics organization origin does not match the current web resource origin");
	}
	const orgPath = org.pathname.replace(/\/+$/, "");
	const resourcePrefix = `${orgPath}/WebResources/`.replace(/\/\//g, "/");
	if (!page.pathname.toLowerCase().startsWith(resourcePrefix.toLowerCase())) {
		throw new Error("Dynamics web resource must belong to the current organization path under WebResources");
	}
	const apiBase = new URL(`${org.origin}${orgPath}/api/data/v9.1/`);
	return { org: new URL(`${org.origin}${orgPath}`), apiBase, orgPath };
}

/** Guard every outgoing API URL, including server-generated OData continuations. */
function requireApiUrl(candidate: URL, apiBase: URL): URL {
	if (
		/%(?:2f|5c|2e)/i.test(candidate.pathname) ||
		/\\/.test(candidate.pathname) ||
		candidate.origin !== apiBase.origin ||
		candidate.username ||
		candidate.password ||
		candidate.hash ||
		!candidate.pathname.toLowerCase().startsWith(apiBase.pathname.toLowerCase())
	) {
		throw new Error("Rejected paging/request URL outside the active Dynamics organization API path or origin");
	}
	return candidate;
}

function collectionPath(query: string): { path: string; singleton: boolean } {
	if (!query || /[\\#]/.test(query) || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(query)) {
		throw new Error("Invalid relative Dynamics API URL");
	}
	const path = query.split("?", 1)[0];
	if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\([0-9a-f-]+\))?$/i.test(path)) {
		throw new Error("Invalid Dynamics API collection or metadata key path");
	}
	if (path.includes("(")) assertGuid(path.slice(path.indexOf("(") + 1, -1), "metadata key");
	return { path, singleton: path.includes("(") };
}

function functionLiteral(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value !== "string") throw new Error("Unsupported Dynamics OData function parameter type");
	if (GUID_PATTERN.test(value)) return value;
	// Type-qualified enum values must remain OData enum tokens rather than quoted strings.
	if (/^Microsoft\.Dynamics\.CRM\.[A-Za-z_][A-Za-z0-9_]*'[A-Za-z_][A-Za-z0-9_,]*'$/.test(value)) return value;
	return `'${value.replace(/'/g, "''")}'`;
}

function formatFunctionUrl(request: DataverseAPI.ExecuteRequest): string {
	if (request.entityName || request.entityId) throw new Error("Bound Dynamics operations are not used by Command Bar Studio");
	const name = assertIdentifier(request.operationName, "operation name");
	const parameters = Object.entries(request.parameters ?? {});
	if (!parameters.length) return `${name}()`;
	const aliases = new URLSearchParams();
	const args = parameters.map(([key, value], index) => {
		assertIdentifier(key, "parameter name");
		const alias = `@p${index + 1}`;
		aliases.set(alias, functionLiteral(value));
		return `${key}=${alias}`;
	});
	return `${name}(${args.join(",")})?${aliases.toString()}`;
}

function makeUuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
		throw new Error("A cryptographically secure GUID generator is required before importing a solution");
	}
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 15) | 64;
	bytes[8] = (bytes[8] & 63) | 128;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toBase64(content: DataverseAPI.SolutionContentInput): string {
	if (typeof content === "string") {
		if (!content || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
			throw new Error("Solution ZIP must be a valid base64 string");
		}
		return content;
	}
	const bytes = content instanceof ArrayBuffer
		? new Uint8Array(content)
		: new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	let raw = "";
	for (let i = 0; i < bytes.length; i += 8192) {
		raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
	}
	return btoa(raw);
}

function selectColumns(columns?: string[]): string {
	return columns?.length ? `?$select=${columns.map((c) => assertIdentifier(c, "column")).join(",")}` : "";
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function createdId(response: Response, data: unknown, apiBase: URL, entitySet: string): string {
	for (const header of ["odata-entityid", "OData-EntityId", "location", "Location"]) {
		const raw = response.headers.get(header);
		if (!raw) continue;
		const url = requireApiUrl(new URL(raw, apiBase), apiBase);
		const match = url.pathname.match(/\(([0-9a-f-]{36})\)$/i);
		if (url.pathname.toLowerCase().startsWith(`${apiBase.pathname}${entitySet}(`.toLowerCase()) && match) {
			return assertGuid(match[1], "created record");
		}
	}
	if (isRecord(data)) {
		for (const field of ["id", "webresourceid", "solutionid", "systemuserid"]) {
			if (typeof data[field] === "string" && GUID_PATTERN.test(data[field])) return data[field];
		}
	}
	throw new OnPremWriteOutcomeUnknownError("Create", "Dynamics acknowledged creation but returned no usable record ID.");
}

function isConfirmedCSDLOperation(xml: string): boolean {
	try {
		const doc = new DOMParser().parseFromString(xml, "application/xml");
		if (doc.getElementsByTagName("parsererror").length || doc.getElementsByTagNameNS("*", "parsererror").length) return false;
		const actions = Array.from(doc.getElementsByTagNameNS("*", "Action"));
		// Some test CSDL snippets have no namespace prefixes at all.
		for (const action of actions.length ? actions : Array.from(doc.getElementsByTagName("Action"))) {
			if (action.getAttribute("Name") !== "PublishAllXmlAsync") continue;
			const schema = action.parentElement;
			if (schema?.localName === "Schema" && schema.getAttribute("Namespace") === "Microsoft.Dynamics.CRM") return true;
		}
	} catch {
		return false;
	}
	return false;
}

export function createOnPremHost(options: OnPremHostOptions): OnPremHost {
	const pageUrl = options.pageUrl ?? window.location.href;
	const { org, apiBase } = validateOriginAndPaths(options.orgUrl, pageUrl);
	const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
	if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
		throw new Error("Invalid Dynamics request timeout");
	}
	let publishAllXmlAsync = false;
	const entitySets = new Map(Object.entries(ENTITY_SET));

	async function sendOnce(url: URL, method: "GET" | "POST" | "PATCH", body?: unknown, responseType: "json" | "text" = "json"): Promise<HttpReply> {
		requireApiUrl(url, apiBase);
		const timeoutMs = options.timeoutMs ?? (url.pathname.endsWith("/ImportSolution") ? 600_000 : method === "GET" ? 120_000 : 180_000);
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				abort.abort();
				reject(new OnPremNetworkError(`Dynamics request timeout after ${timeoutMs}ms`));
			}, timeoutMs);
		});
		const attempt = async (): Promise<HttpReply> => {
			const response = await fetchImpl(url.href, {
				method,
				credentials: "same-origin",
				redirect: "error",
				mode: "same-origin",
				signal: abort.signal,
				headers: {
					Accept: responseType === "text" ? "application/xml, text/xml" : "application/json",
					"OData-Version": "4.0",
					"OData-MaxVersion": "4.0",
					...(method === "PATCH" ? { "If-Match": "*" } : {}),
					...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			if (response.redirected) throw new OnPremResponseError("Dynamics session redirected to a login page");
			const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
			if (contentType.includes("text/html")) {
				if (!response.ok) throw new OnPremHttpError(response.status, "session/login HTML response; sign in again");
				throw new OnPremResponseError(`Dynamics session/login HTML response (HTTP ${response.status}); sign in again`);
			}
			const raw = response.status === 204 ? "" : await response.text();
			let parsed: unknown = null;
			if (raw.trim()) {
				if (responseType === "text") {
					parsed = raw;
				} else {
					try { parsed = JSON.parse(raw) as unknown; }
					catch {
						if (!response.ok) throw new OnPremHttpError(response.status, response.statusText || "Non-JSON CRM error response");
						throw new OnPremResponseError(`Dynamics returned malformed JSON or an expired session (HTTP ${response.status})`);
					}
				}
			}
			if (!response.ok) {
				const err = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
				const code = err && typeof err.code === "string" ? `${err.code}: ` : "";
				const msg = err && typeof err.message === "string" ? err.message : response.statusText || "Unknown CRM response";
				throw new OnPremHttpError(response.status, `${code}${msg}`);
			}
			return { response, data: parsed };
		};
		try {
			return await Promise.race([attempt(), deadline]);
		} catch (error) {
			if (error instanceof OnPremHttpError || (method === "GET" && error instanceof OnPremResponseError)) throw error;
			if (method !== "GET") {
				throw new OnPremWriteOutcomeUnknownError(`${method} ${url.pathname}`, error instanceof Error ? error.message : String(error));
			}
			if (error instanceof OnPremNetworkError) throw error;
			throw new OnPremNetworkError(`Dynamics GET request failed: ${error instanceof Error ? error.message : String(error)}`, error);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async function send(url: URL, method: "GET" | "POST" | "PATCH", body?: unknown, responseType: "json" | "text" = "json"): Promise<HttpReply> {
		const attempts = method === "GET" ? 2 : 1;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try { return await sendOnce(url, method, body, responseType); }
			catch (error) {
				const retry = error instanceof OnPremHttpError
					? READ_RETRY_STATUSES.has(error.status)
					: error instanceof OnPremNetworkError;
				if (!retry || attempt === attempts) throw error;
			}
		}
		throw new Error("Dynamics request exhausted its retry attempts");
	}

	function apiUrl(relative: string): URL {
		return requireApiUrl(new URL(relative, apiBase), apiBase);
	}

	async function requestObject(relative: string): Promise<Record<string, unknown>> {
		const { data } = await send(apiUrl(relative), "GET");
		if (!isRecord(data)) throw new Error(`Dynamics metadata/record response is not a single JSON object: ${relative}`);
		return data;
	}

	async function queryData(query: string, target?: DataverseAPI.ConnectionTarget, additionalHeaders?: DataverseAPI.AdditionalHeaders): ReturnType<DataverseAPI.API["queryData"]> {
		requirePrimaryConnection(target, additionalHeaders);
		const { singleton } = collectionPath(query);
		const start = apiUrl(query);
		if (singleton) return requestObject(query) as ReturnType<DataverseAPI.API["queryData"]>;
		const seen = new Set<string>();
		const rows: Record<string, unknown>[] = [];
		let next: URL | null = start;
		let first: Record<string, unknown> | null = null;
		while (next) {
			if (seen.size >= MAX_PAGES) throw new Error(`Dynamics paging exceeded ${MAX_PAGES} pages`);
			if (seen.has(next.href)) throw new Error("Dynamics paging cycle detected; repeated continuation URL");
			seen.add(next.href);
			const { data } = await send(next, "GET");
			if (!isRecord(data) || !Array.isArray(data.value) || !data.value.every(isRecord)) {
				throw new Error("Dynamics collection response is missing a valid value array");
			}
			first ??= data;
			rows.push(...data.value);
			const link = data["@odata.nextLink"];
			if (link === undefined || link === null || link === "") {
				next = null;
			} else {
				if (typeof link !== "string") throw new Error("Dynamics paging link must be a URL string");
				rejectEncodedPathSeparators(link);
				const continuation = requireApiUrl(new URL(link, next), apiBase);
				if (continuation.pathname.toLowerCase() !== start.pathname.toLowerCase()) {
					throw new Error("Dynamics paging link changed the collection endpoint");
				}
				next = continuation;
			}
		}
		const result: Record<string, unknown> & { value: Record<string, unknown>[] } = { ...(first ?? {}), value: rows };
		delete result["@odata.nextLink"];
		return result;
	}

	async function resolveEntitySet(logicalName: string): Promise<string> {
		const name = assertIdentifier(logicalName, "entity logical name").toLowerCase();
		const cached = entitySets.get(name);
		if (cached) return cached;
		// Unknown custom entities are resolved from metadata, never pluralized by guesswork.
		const metadata = await requestObject(`EntityDefinitions(LogicalName='${name}')?$select=EntitySetName`);
		const entitySet = metadata.EntitySetName;
		if (typeof entitySet !== "string" || !IDENTIFIER.test(entitySet)) {
			throw new Error(`Dynamics EntityDefinitions lacks a valid EntitySetName for ${name}`);
		}
		entitySets.set(name, entitySet);
		return entitySet;
	}

	const dataverseAPI: NativeDataverseAPI = {
		queryData,
		async getSolutions(columns, target, additionalHeaders) {
			requirePrimaryConnection(target, additionalHeaders);
			if (!columns.length) throw new Error("At least one solution column is required");
			const withPublisher = columns.includes("publisherid");
			const scalars = columns.filter((column) => column !== "publisherid");
			const expand = withPublisher ? "&$expand=publisherid($select=friendlyname,customizationprefix)" : "";
			return queryData(`solutions${selectColumns(scalars.length ? scalars : ["solutionid"])}${expand}`);
		},
		async retrieve(entityLogicalName, id, columns, target, additionalHeaders) {
			requirePrimaryConnection(target, additionalHeaders);
			const entitySet = await resolveEntitySet(entityLogicalName);
			return requestObject(`${entitySet}(${assertGuid(id, "record")})${selectColumns(columns)}`);
		},
		async create(entityLogicalName, record, target, additionalHeaders) {
			requirePrimaryConnection(target, additionalHeaders);
			const entitySet = await resolveEntitySet(entityLogicalName);
			const { response, data } = await send(apiUrl(entitySet), "POST", record);
			return { id: createdId(response, data, apiBase, entitySet) };
		},
		async update(entityLogicalName, id, record, target, additionalHeaders) {
			requirePrimaryConnection(target, additionalHeaders);
			const entitySet = await resolveEntitySet(entityLogicalName);
			await send(apiUrl(`${entitySet}(${assertGuid(id, "record")})`), "PATCH", record);
		},
		async execute(request, target, additionalHeaders) {
			requirePrimaryConnection(target, additionalHeaders);
			if (request.operationName === "PublishAllXmlAsync" && !publishAllXmlAsync) {
				throw new Error("PublishAllXmlAsync unavailable: native Dynamics CSDL does not expose this action");
			}
			if (request.operationType === "function") {
				const { data } = await send(apiUrl(formatFunctionUrl(request)), "GET");
				if (!isRecord(data)) throw new Error(`Dynamics function ${request.operationName} returned no JSON object`);
				return data;
			}
			if (request.operationType === "action") {
				if (request.entityName || request.entityId) throw new Error("Bound actions are not supported by this app");
				const name = assertIdentifier(request.operationName, "operation name");
				const { data } = await send(apiUrl(name), "POST", request.parameters ?? {});
				if (data === null) return {};
				if (!isRecord(data)) throw new OnPremWriteOutcomeUnknownError(name, "Action returned an unexpected response body");
				return data;
			}
			throw new Error(`Unknown Dynamics operation type: ${request.operationType}`);
		},
		async deploySolution(solutionContent, importOptions, target, additionalHeaders) {
			requirePrimaryConnection(target, additionalHeaders);
			const importJobId = assertGuid(importOptions?.importJobId ?? makeUuid(), "ImportJobId");
			const body = {
				CustomizationFile: toBase64(solutionContent),
				ImportJobId: importJobId,
				PublishWorkflows: importOptions?.publishWorkflows ?? false,
				OverwriteUnmanagedCustomizations: importOptions?.overwriteUnmanagedCustomizations ?? false,
				...(importOptions?.skipProductUpdateDependencies === undefined ? {} : { SkipProductUpdateDependencies: importOptions.skipProductUpdateDependencies }),
				...(importOptions?.convertToManaged === undefined ? {} : { ConvertToManaged: importOptions.convertToManaged }),
			};
			await send(apiUrl("ImportSolution"), "POST", body);
			return { ImportJobId: importJobId };
		},
		async getImportJobStatus(importJobId, target, additionalHeaders) {
			requirePrimaryConnection(target, additionalHeaders);
			return requestObject(`importjobs(${assertGuid(importJobId, "ImportJobId")})`);
		},
		async publishCustomizations(tableLogicalName, target, additionalHeaders) {
			requirePrimaryConnection(target, additionalHeaders);
			if (tableLogicalName) {
				const name = assertIdentifier(tableLogicalName, "entity logical name");
				const ParameterXml = `<importexportxml><entities><entity>${xmlEscape(name)}</entity></entities></importexportxml>`;
				await send(apiUrl("PublishXml"), "POST", { ParameterXml });
			} else {
				await send(apiUrl("PublishAllXml"), "POST", {});
			}
		},
	};

	const toolboxAPI: NativeToolboxAPI = {
		connections: {
			getActiveConnection: async () => ({
				id: org.href,
				url: org.href,
				name: options.organizationName || org.pathname.split("/").filter(Boolean).at(-1) || org.hostname,
				// Native CRM does not expose a reliable environment classification.
				// Prefer the conservative badge rather than labeling a live org "Dev".
				environment: "Production",
			}),
		},
		utils: {
			getCurrentTheme: async () =>
				window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
			async openInConnectionBrowser(url, connectionTarget) {
				if (connectionTarget !== undefined && connectionTarget !== "primary" && connectionTarget !== 0) {
					throw new Error("Native Dynamics has only the current organization connection");
				}
				const target = new URL(url);
				const root = org.pathname.replace(/\/$/, "");
				if (target.origin !== org.origin || !target.pathname.toLowerCase().startsWith(`${root}/`.toLowerCase())) {
					throw new Error("Preview URL is outside the active Dynamics organization origin/path");
				}
				window.open(target.href, "_blank", "noopener,noreferrer");
			},
			async copyToClipboard(text) {
				if (navigator.clipboard?.writeText) {
					await navigator.clipboard.writeText(text);
					return;
				}
				const textarea = document.createElement("textarea");
				textarea.value = text;
				textarea.style.position = "fixed";
				textarea.style.left = "-10000px";
				document.body.appendChild(textarea);
				try {
					textarea.select();
					if (!document.execCommand?.("copy")) throw new Error("Browser clipboard is unavailable; use HTTPS or copy manually");
				} finally {
					textarea.remove();
				}
			},
		},
	};

	return {
		dataverseAPI,
		toolboxAPI,
		async detectCapabilities() {
			let available = false;
			try {
				const { data } = await send(apiUrl("$metadata"), "GET", undefined, "text");
				available = typeof data === "string" && isConfirmedCSDLOperation(data);
			} catch {
				// Unknown/missing metadata can never enable an optional write action.
			}
			publishAllXmlAsync = available;
			const capabilities: RuntimeCapabilities = { kind: "onpremises", publishAllXmlAsync: available };
			options.onCapabilitiesChanged?.(capabilities);
			return capabilities;
		},
	};
}

/** Installs only the native subset. Existing PPTB global objects are preserved. */
export function installOnPremHost(options: OnPremInstallOptions = {}): { ready: Promise<RuntimeCapabilities>; kind: "pptb" | "onpremises" } {
	if (window.dataverseAPI && window.toolboxAPI) {
		activatePptbRuntime();
		return { kind: "pptb", ready: Promise.resolve({ kind: "pptb", publishAllXmlAsync: true }) };
	}
	if (window.dataverseAPI || window.toolboxAPI) {
		throw new Error("Incomplete PPTB host APIs; refusing to install a mixed native host");
	}
	const contextFactory = (window as Window & { GetGlobalContext?: () => CrmGlobalContext }).GetGlobalContext;
	const context = options.globalContext ?? contextFactory?.();
	if (!context || typeof context.getClientUrl !== "function") {
		throw new Error("ClientGlobalContext.js.aspx did not provide GetGlobalContext; open the native CRM HTML web resource");
	}
	const host = createOnPremHost({
		orgUrl: context.getClientUrl(),
		organizationName: context.getOrgUniqueName?.(),
		pageUrl: options.pageUrl,
		fetchImpl: options.fetchImpl,
		timeoutMs: options.timeoutMs,
		onCapabilitiesChanged: (caps) => activateOnPremRuntime(caps.publishAllXmlAsync),
	});
	// Assignments are the only boundary where the intentionally narrow facade
	// must be viewed as PPTB's larger API type (the app uses only the subset).
	window.dataverseAPI = host.dataverseAPI as DataverseAPI.API;
	window.toolboxAPI = host.toolboxAPI as ToolBoxAPI.API;
	activateOnPremRuntime(false);
	return { kind: "onpremises", ready: host.detectCapabilities() };
}
