import assert from "node:assert/strict";
import test from "node:test";
import { hasWechatConfig, sendWechatNotification, type WechatTemplateData } from "../extensions/index.ts";

const ENV_KEYS = ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_OPEN_ID", "WECHAT_TEMPLATE_ID"] as const;

test("通过微信稳定版 token 发送模板消息并复用 access_token", async () => {
	const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	const originalFetch = globalThis.fetch;
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	Object.assign(process.env, {
		WECHAT_APP_ID: "test-app-id",
		WECHAT_APP_SECRET: "test-app-secret",
		WECHAT_OPEN_ID: "test-open-id",
		WECHAT_TEMPLATE_ID: "test-template-id",
	});
	globalThis.fetch = (async (input, init) => {
		calls.push({ url: String(input), init });
		if (String(input).includes("/cgi-bin/stable_token")) {
			return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 7200 }));
		}
		return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", msgid: 1 }));
	}) as typeof fetch;

	try {
		const data: WechatTemplateData = {
			project: "pi-notify-agent",
			status: "成功",
			duration: "4.2s",
			time: "2026/8/1 10:00:00",
			summary: "任务完成",
		};
		assert.equal(hasWechatConfig(), true);
		await sendWechatNotification(data);
		await sendWechatNotification(data);
		assert.equal(calls.length, 3);
		assert.equal(new URL(calls[0].url).pathname, "/cgi-bin/stable_token");
		assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
			grant_type: "client_credential",
			appid: "test-app-id",
			secret: "test-app-secret",
			force_refresh: false,
		});
		const payload = JSON.parse(String(calls[1].init?.body));
		assert.deepEqual(payload, {
			touser: "test-open-id",
			template_id: "test-template-id",
			data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { value }])),
		});
	} finally {
		globalThis.fetch = originalFetch;
		for (const key of ENV_KEYS) {
			const value = previousEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
