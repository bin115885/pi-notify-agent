import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { getNextBreakReminderTime, isBreakReminderTime, startBreakReminderCoordinator } from "../extensions/index.ts";

const getAvailablePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("无法分配测试端口"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});

test("按开关控制周末休息提醒", () => {
	for (const [hour, minute] of [[10, 0], [11, 0], [12, 0], [14, 30], [15, 30], [16, 30], [17, 30], [18, 30]]) {
		assert.equal(isBreakReminderTime(new Date(2026, 2, 2, hour, minute)), true);
	}
	assert.equal(isBreakReminderTime(new Date(2026, 2, 2, 10, 1)), false);
	assert.equal(isBreakReminderTime(new Date(2026, 2, 7, 10, 0)), false);
	assert.equal(isBreakReminderTime(new Date(2026, 2, 7, 10, 0), true), true);
});

test("计算下一次休息提醒而不轮询", () => {
	assert.deepEqual(getNextBreakReminderTime(new Date(2026, 2, 2, 10, 0, 1)), new Date(2026, 2, 2, 11, 0));
	assert.deepEqual(getNextBreakReminderTime(new Date(2026, 2, 6, 18, 30)), new Date(2026, 2, 9, 10, 0));
	assert.deepEqual(getNextBreakReminderTime(new Date(2026, 2, 6, 18, 30), true), new Date(2026, 2, 7, 10, 0));
});

test("多会话只保留一个提醒主会话并在退出后接管", { timeout: 3000 }, async (t) => {
	const port = await getAvailablePort();
	let firstLeader!: () => void;
	const firstLeaderReady = new Promise<void>((resolve) => (firstLeader = resolve));
	const first = startBreakReminderCoordinator((role) => role === "leader" && firstLeader(), (error) => assert.fail(error.message), port);
	t.after(() => first.stop());
	await firstLeaderReady;

	let secondFollower!: () => void;
	let secondLeader!: () => void;
	const secondFollowerReady = new Promise<void>((resolve) => (secondFollower = resolve));
	const secondLeaderReady = new Promise<void>((resolve) => (secondLeader = resolve));
	const second = startBreakReminderCoordinator((role) => {
		if (role === "follower") secondFollower();
		if (role === "leader") secondLeader();
	}, (error) => assert.fail(error.message), port);
	t.after(() => second.stop());
	await secondFollowerReady;

	first.stop();
	await secondLeaderReady;
});
