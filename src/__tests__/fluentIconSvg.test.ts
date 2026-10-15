import { describe, expect, it } from "vitest";
import { fluentIconToSvg } from "@/utils/fluentIconSvg";

describe("Fluent icon web-resource SVG serialization", () => {
	it("preserves existing recognized icon output as standalone dimensions and themeable currentColor", async () => {
		const svg = await fluentIconToSvg("search", 32);
		expect(svg).toContain("<svg");
		expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(svg).toContain('width="32"');
		expect(svg).toContain('height="32"');
		expect(svg).toContain("currentColor");
		expect(svg).not.toContain("data-cbs-icon-fallback");
	});

	it("supports a filled variant and alias while declining unknown icon names", async () => {
		expect(await fluentIconToSvg("not_a_real_icon_name", 24)).toBeNull();
		const svg = await fluentIconToSvg("columns", 24, "filled");
		expect(svg).toContain('width="24"');
		expect(svg).toContain('height="24"');
	});
});
