import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type FleetPlanner,
	FleetPlannerAddressError,
	fleetPlannerAddress,
	selectFleetPlanner,
	validatePlanners,
} from "../src/fleet-planner.ts";

function fixture(label: string, host: string, handle?: string): FleetPlanner {
	return {
		label,
		host,
		handle,
		identityFile: "/keys/plan",
		knownHostsFile: "/keys/known",
		node: "/bin/node",
		entry: "/app/worker.ts",
	};
}

const m4 = fixture("Mac mini M4", "worker@mini4.example.ts.net");
const second = fixture("Second mini", "worker@mini2.example.ts.net", "desk");
const future = fixture("Mac mini M6", "worker@mini6.example.ts.net");

test("pools accept configured tailnet workers and reject duplicate or unsafe identities", () => {
	assert.ok(validatePlanners([]));
	assert.ok(validatePlanners([m4, second]));
	for (const bad of [
		null,
		{},
		[m4, m4],
		[m4, fixture("M4", "worker@other.example.ts.net")],
		[m4, { ...second, host: m4.host }],
		[{ ...m4, host: "worker@example.org" }],
		[{ ...m4, handle: "a b" }],
		[{ ...m4, label: "Mini\nM4" }],
	])
		assert.equal(validatePlanners(bad), false);
});

test("stable allocation is order independent; adding a future worker only moves its own share", () => {
	assert.equal(selectFleetPlanner("id", []), undefined);
	assert.equal(selectFleetPlanner("id", [m4]), m4);
	const selected = new Set();
	for (let i = 0; i < 100; i++) {
		const id = `thread-${i}`;
		const previous = selectFleetPlanner(id, [m4, second]);
		assert.equal(selectFleetPlanner(id, [second, m4]), previous);
		const next = selectFleetPlanner(id, [m4, second, future]);
		assert.ok(next === future || next === previous);
		selected.add(next);
	}
	assert.equal(selected.size, 3);
});

test("only an owner's leading literal address changes the selected planner", () => {
	assert.equal(fleetPlannerAddress("Please review @M4"), undefined);
	assert.equal(fleetPlannerAddress("<@U123> review"), undefined);
	assert.equal(fleetPlannerAddress("@M4: check"), "M4");
	assert.equal(selectFleetPlanner("id", [m4, second], "  @m4, review this"), m4);
	assert.equal(selectFleetPlanner("id", [m4, second], "@DESK check"), second);
	assert.throws(() => selectFleetPlanner("id", [m4, second], "@M6 review"), FleetPlannerAddressError);
	assert.throws(() => selectFleetPlanner("id", [], "@M6"), FleetPlannerAddressError);
});
