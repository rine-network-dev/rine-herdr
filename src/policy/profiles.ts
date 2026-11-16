// profiles.ts — what each profile means for one agent's policy, exposure and tools (one row per Profile).
import { toolsFor } from "../tool-profiles.js";
import { type DesiredAgentPolicy, Profile } from "../types.js";

export type ProfileSettings = Omit<DesiredAgentPolicy, "bindingKey">;

export function profileSettings(profile: Profile, features: readonly string[] = []): ProfileSettings {
	const open = profile === Profile.Open;
	return {
		incoming: open ? "accept_all" : "groups_only",
		outgoing: open ? "send_all" : "groups_only",
		exposure: open ? "findable" : "private",
		tools: toolsFor(profile, features),
	};
}
