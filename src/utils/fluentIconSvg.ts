import React from "react";
import FluentIcon from "@/components/shared/FluentIcon";

type IconVariant = NonNullable<React.ComponentProps<typeof FluentIcon>["variant"]>;

/**
 * Render the exact same icon as the CBS preview into a standalone SVG for a
 * Dataverse web resource. Keep React-component exports in FluentIcon.tsx only.
 */
export async function fluentIconToSvg(
	name: string,
	size = 32,
	variant: IconVariant = "regular",
): Promise<string | null> {
	const { renderToStaticMarkup } = await import("react-dom/server");
	let markup = renderToStaticMarkup(React.createElement(FluentIcon, {
		name,
		size,
		variant,
		style: { color: "currentColor" },
	}));
	// Unknown icon names legitimately fall back to AppsAddIn inside the canvas,
	// but that fallback must not be uploaded under a misleading requested name.
	if (!markup.includes("<svg") || markup.includes('data-cbs-icon-fallback="true"')) return null;
	if (!markup.includes("xmlns")) {
		markup = markup.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
	}
	return markup.replace(/width="1em"/, `width="${size}"`).replace(/height="1em"/, `height="${size}"`);
}
