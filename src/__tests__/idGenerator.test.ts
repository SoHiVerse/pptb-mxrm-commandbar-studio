import { describe, it, expect } from "vitest";
import {
	generateRibbonId,
	generateCommandId,
	generateRuleId,
	generateLocLabelId,
} from "@/utils/idGenerator";

// Note: generateRibbonId reads publisherPrefix from sessionStore (defaults to "new" when store is not set up)

describe("generateRibbonId", () => {
	it("generates IDs in {prefix}.{entity}.{name}.{suffix} format", () => {
		const id = generateRibbonId("account", "CreditCheck", "Button", new Set());
		expect(id).toMatch(/^[a-zA-Z][a-zA-Z0-9._]*\.[a-zA-Z0-9._]+\.[a-zA-Z0-9._]+\.[a-zA-Z0-9._]+$/);
	});

	it("never generates IDs containing whitespace", () => {
		const id = generateRibbonId("account", "Credit Check Button", "Button", new Set());
		expect(id).not.toMatch(/\s/);
	});

	it("never generates IDs containing invalid XML special characters", () => {
		const id = generateRibbonId("account", "Credit&Check", "Button", new Set());
		expect(id).not.toContain("&");
		expect(id).not.toContain("<");
		expect(id).not.toContain(">");
	});

	it("does not generate duplicate IDs — appends numeric suffix for uniqueness", () => {
		const existingIds = new Set<string>();
		const id1 = generateRibbonId("account", "Test", "Button", existingIds);
		existingIds.add(id1);
		const id2 = generateRibbonId("account", "Test", "Button", existingIds);
		expect(id1).not.toBe(id2);
	});

	it("sanitizes entity names with special characters", () => {
		const id = generateRibbonId("my entity!", "Test", "Button", new Set());
		expect(id).not.toMatch(/[!@#$%^*()=+[\]{}|;,<>?/\\]/);
	});
});

describe("generateCommandId", () => {
	it("generates command IDs ending in .Command", () => {
		const id = generateCommandId("account", "CreditCheck", new Set());
		expect(id).toMatch(/\.Command$/);
	});

	it("never generates duplicate command IDs", () => {
		const existing = new Set<string>();
		const id1 = generateCommandId("account", "Test", existing);
		existing.add(id1);
		const id2 = generateCommandId("account", "Test", existing);
		expect(id1).not.toBe(id2);
	});
});

describe("generateRuleId", () => {
	it("generates enable rule IDs ending in .EnableRule", () => {
		const id = generateRuleId("CreditCheck", "Enable", new Set());
		expect(id).toMatch(/\.EnableRule$/);
	});

	it("generates display rule IDs ending in .DisplayRule", () => {
		const id = generateRuleId("CreditCheck", "Display", new Set());
		expect(id).toMatch(/\.DisplayRule$/);
	});
});

describe("generateLocLabelId", () => {
	it("generates LabelText IDs by appending .LabelText", () => {
		const id = generateLocLabelId("Contoso.account.Test.Button", "LabelText");
		expect(id).toBe("Contoso.account.Test.Button.LabelText");
	});

	it("generates ToolTip IDs by appending .ToolTip", () => {
		const id = generateLocLabelId("Contoso.account.Test.Button", "ToolTip");
		expect(id).toBe("Contoso.account.Test.Button.ToolTip");
	});
});
