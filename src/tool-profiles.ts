// tool-profiles.ts — which rine tools a bound pane may call. This file is the herdr host's
// registration source for the skill gate: it names every exposable tool and no other.
import { HERDR_DEFAULT_TOOLS, HERDR_OPTIONAL_TOOLS, type HerdrTool, type OptionalTool, Profile } from "./types.js";

export { HERDR_DEFAULT_TOOLS, HERDR_OPTIONAL_TOOLS, type OptionalTool } from "./types.js";

const OPEN_PROFILE_TOOLS: readonly OptionalTool[] = ["rine_discover", "rine_inspect"];

export function isOptionalTool(name: string): name is OptionalTool {
	return (HERDR_OPTIONAL_TOOLS as readonly string[]).includes(name);
}

export function isExposableTool(name: string): name is HerdrTool {
	return (HERDR_DEFAULT_TOOLS as readonly string[]).includes(name) || isOptionalTool(name);
}

/** The tool list a binding gets: defaults, the open profile's discovery pair, then the policy's feature additions. */
export function toolsFor(profile: Profile, features: readonly string[] = []): readonly string[] {
	const bad = features.filter((name) => !isOptionalTool(name));
	if (bad.length > 0) throw new Error(`tools not available to herdr panes: ${bad.join(", ")}`);
	const extra = profile === Profile.Open ? OPEN_PROFILE_TOOLS : [];
	return [...new Set<string>([...HERDR_DEFAULT_TOOLS, ...extra, ...features])];
}
