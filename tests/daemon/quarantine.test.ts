import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify, isAppliedInvite, Verdict } from "../../src/daemon/quarantine.js";
import { MAX_HELD, openQuarantineStore } from "../../src/daemon/quarantine-store.js";
import { QuarantineDecision, SenderClass } from "../../src/types.js";
import { BINDING, external, HOST, notice, policyOf, SENDER_ID, uuidN } from "./fixtures.js";

const none = { approved: new Set<string>(), senderOrgId: null };

describe("isAppliedInvite", () => {
	const policy = policyOf('profile = "open"\n[external]\ngroups = [{ handle = "#platform-dev@b1409923.rine.network", agents = ["dev"] }]\n');
	const siblings = new Set(["55555555-5555-4555-8555-555555555555"]);

	it("isAppliedInvite_inviterIsABoundAgentOfTheRepo_true", () => {
		expect(isAppliedInvite({ id: "55555555-5555-4555-8555-555555555555", handle: "planner@acme.rine.network" }, BINDING, policyOf('profile = "team"'), siblings)).toBe(true);
	});

	it("isAppliedInvite_inviterOnTheConfiguredExternalGroupsDomainAndWeAreNamed_true", () => {
		expect(isAppliedInvite({ id: SENDER_ID, handle: "bee@b1409923.rine.network" }, BINDING, policy, siblings)).toBe(true);
	});

	it("isAppliedInvite_externalGroupNamesOnlyOtherAgents_false", () => {
		const other = policyOf('profile = "open"\n[external]\ngroups = [{ handle = "#platform-dev@b1409923.rine.network", agents = ["reviewer"] }]\n');
		expect(isAppliedInvite({ id: SENDER_ID, handle: "bee@b1409923.rine.network" }, BINDING, other, siblings)).toBe(false);
	});

	it("isAppliedInvite_strangerFromAnotherDomain_false", () => {
		expect(isAppliedInvite({ id: SENDER_ID, handle: "bee@evil.rine.network" }, BINDING, policy, siblings)).toBe(false);
		expect(isAppliedInvite({ id: SENDER_ID, handle: null }, BINDING, policy, siblings)).toBe(false);
	});

	it("isAppliedInvite_soloProfileSeatsNoGroups_false", () => {
		const solo = policyOf();
		expect(isAppliedInvite({ id: "55555555-5555-4555-8555-555555555555", handle: "planner@acme.rine.network" }, BINDING, solo, siblings)).toBe(false);
		expect(isAppliedInvite({ id: SENDER_ID, handle: "bee@b1409923.rine.network" }, BINDING, solo, siblings)).toBe(false);
	});

	it("isAppliedInvite_sameOrgAgentOutsideTheRepo_false", () => {
		expect(isAppliedInvite({ id: SENDER_ID, handle: "peer@acme.rine.network" }, BINDING, policyOf('profile = "team"'), siblings)).toBe(false);
	});
});

describe("classify", () => {
	it("classify_sameOrgSender_announces", () => {
		expect(classify(notice(1), policyOf(), HOST, none)).toMatchObject({ verdict: Verdict.Announce, class: SenderClass.SameOrg });
	});

	it("classify_herdrGroupMessage_announcesAsGroup", () => {
		const n = external(1, { groupHandle: "#herdr-repo@acme.rine.network" });
		expect(classify(n, policyOf(), HOST, none)).toMatchObject({ verdict: Verdict.Announce, class: SenderClass.Group });
	});

	it("classify_configuredExternalGroup_announcesAsGroup", () => {
		const policy = policyOf('profile = "open"\n[external]\ngroups = [{ handle = "#partners@other.rine.network", agents = ["dev"] }]\n');
		const n = external(1, { groupHandle: "#partners@other.rine.network" });
		expect(classify(n, policy, HOST, none).class).toBe(SenderClass.Group);
	});

	it("classify_allowlistedOrg_announcesAsAllowlisted", () => {
		const orgId = "44444444-4444-4444-8444-444444444444";
		const policy = policyOf(`profile = "team"\n[external]\norgs = ["${orgId}"]\n`);
		expect(classify(external(1), policy, HOST, { approved: new Set(), senderOrgId: orgId }).class).toBe(SenderClass.ExternalAllowlisted);
	});

	it("classify_previouslyApprovedSender_announces", () => {
		const facts = { approved: new Set([SENDER_ID]), senderOrgId: null };
		expect(classify(external(1), policyOf(), HOST, facts)).toMatchObject({ verdict: Verdict.Announce, class: SenderClass.ExternalApproved });
	});

	it("classify_firstContactApprove_holds", () => {
		expect(classify(external(1), policyOf(), HOST, none).verdict).toBe(Verdict.Hold);
	});

	it("classify_firstContactAllow_announcesAndAsksToRecordApproval", () => {
		const policy = policyOf('profile = "open"\n[external]\nfirst_contact = "allow"\n');
		expect(classify(external(1), policy, HOST, none)).toMatchObject({ verdict: Verdict.Announce, recordApproval: true });
	});

	it("classify_firstContactDeny_drops", () => {
		const policy = policyOf('profile = "open"\n[external]\nfirst_contact = "deny"\n');
		expect(classify(external(1), policy, HOST, none).verdict).toBe(Verdict.Drop);
	});

	it("classify_spoofedSameOrgSlug_cannotComeFromAnotherDomain", () => {
		expect(classify(external(1, { senderOrgSlug: null }), policyOf(), HOST, none).verdict).toBe(Verdict.Hold);
	});
});

describe("quarantine store", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rh-quarantine-"));
		file = join(dir, "quarantine.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("hold_sameMessageTwice_isHeldOnce", () => {
		const store = openQuarantineStore(file, () => {});
		expect(store.hold(external(1))).toBe(true);
		expect(store.hold(external(1))).toBe(false);
		expect(store.list()).toHaveLength(1);
	});

	it("contacts_twoMessagesFromOneSender_countsOneContactWhileListCountsTwoMessages", () => {
		const store = openQuarantineStore(file, () => {});
		store.hold(external(1));
		store.hold(external(2));
		store.hold(external(3, { senderId: uuidN(99) }));
		expect(store.list()).toHaveLength(3);
		expect(store.contacts()).toBe(2);
	});

	it("hold_persistsAcrossReopen", () => {
		openQuarantineStore(file, () => {}).hold(external(1));
		expect(openQuarantineStore(file, () => {}).list()).toEqual([external(1)]);
	});

	it("hold_overTheCap_dropsTheOldest", () => {
		const store = openQuarantineStore(file, () => {});
		for (let i = 0; i < MAX_HELD + 5; i++) store.hold(external(i));
		expect(store.list()).toHaveLength(MAX_HELD);
		expect(store.list()[0]?.messageId).toBe(uuidN(5));
	});

	it("decide_approve_releasesHeldAndRemembersTheSender", () => {
		const store = openQuarantineStore(file, () => {});
		store.hold(external(1));
		store.hold(external(2, { senderId: uuidN(99) }));
		const released = store.decide(BINDING.key, SENDER_ID, QuarantineDecision.Approve);
		expect(released.map((n) => n.messageId)).toEqual([uuidN(1)]);
		expect(store.list()).toHaveLength(1);
		expect(store.approvedSenders(BINDING.key).has(SENDER_ID)).toBe(true);
	});

	it("decide_deny_dropsHeldAndRemembersTheDenial", () => {
		const store = openQuarantineStore(file, () => {});
		store.hold(external(1));
		store.approve(BINDING.key, SENDER_ID);
		store.decide(BINDING.key, SENDER_ID, QuarantineDecision.Deny);
		expect(store.list()).toEqual([]);
		expect(store.isDenied(BINDING.key, SENDER_ID)).toBe(true);
		expect(store.approvedSenders(BINDING.key).has(SENDER_ID)).toBe(false);
	});

	it("decide_approveAfterDeny_clearsTheDenial", () => {
		const store = openQuarantineStore(file, () => {});
		store.decide(BINDING.key, SENDER_ID, QuarantineDecision.Deny);
		store.decide(BINDING.key, SENDER_ID, QuarantineDecision.Approve);
		expect(store.isDenied(BINDING.key, SENDER_ID)).toBe(false);
	});

	it("open_corruptFile_startsEmptyAndLogs", () => {
		writeFileSync(file, "{not json");
		const logs: string[] = [];
		expect(openQuarantineStore(file, (l) => logs.push(l)).list()).toEqual([]);
		expect(logs[0]).toMatch(/unreadable/);
	});

	it("hold_whenTheDiskIsUnwritable_logsAndKeepsTheNoticeInMemory", () => {
		const logs: string[] = [];
		const blocked = openQuarantineStore(join(dir, "no-such-dir", "q.json"), (l) => void logs.push(l));
		expect(blocked.hold(external(1))).toBe(true);
		expect(blocked.list()).toHaveLength(1);
		expect(logs.some((l) => l.includes("could not be written"))).toBe(true);
	});

	it("file_holdsMetadataOnly", () => {
		openQuarantineStore(file, () => {}).hold(external(1));
		expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).held[0]).sort()).toEqual(
			["bindingKey", "conversationId", "groupHandle", "messageId", "receivedAt", "senderHandle", "senderId", "senderOrgSlug"],
		);
	});
});
