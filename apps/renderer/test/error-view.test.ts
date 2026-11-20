import { test } from "node:test";
import assert from "node:assert/strict";
import { humanize, isTechnical, presentAppError, presentModelError, stripAddresses } from "../src/error-view.ts";

const TIMEOUT_RAW =
  "Request timed out.: Connect Timeout Error (attempted addresses: 2606:4700::6812:b42:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT)";

test("网络超时归成一句人话，不带地址与错误码", () => {
  const reason = humanize(TIMEOUT_RAW);
  assert.equal(reason, "网络请求超时");
  assert.ok(!/2606:|UND_ERR|attempted addresses/i.test(reason));
});

test("域名解析失败单独识别", () => {
  assert.equal(humanize("getaddrinfo ENOTFOUND api.example.com (UND_ERR_DNS_LOOKUP_FAILED)"), "域名解析失败");
});

test("stripAddresses 只藏地址，保留超时值", () => {
  const out = stripAddresses(TIMEOUT_RAW);
  assert.ok(out.includes("（地址已隐藏）"));
  assert.ok(out.includes("timeout: 10000ms"));
  assert.ok(!out.includes("2606:4700"));
});

test("presentModelError：主行不含原文，raw 折叠里地址已隐藏", () => {
  const view = presentModelError({
    kind: "network",
    title: "网络连接失败",
    detail: TIMEOUT_RAW,
    hint: "检查服务地址（baseUrl）与代理设置",
  });
  assert.equal(view.title, "网络连接失败");
  assert.equal(view.reason, "网络请求超时（检查服务地址（baseUrl）与代理设置）");
  assert.ok(!/2606:|UND_ERR|attempted addresses/i.test(view.reason));
  assert.ok(view.raw);
  assert.ok(!view.raw.includes("2606:4700"));
  assert.ok(view.raw.includes("（地址已隐藏）"));
});

test("presentAppError：进度类 detail 不产生折叠原文", () => {
  const view = presentAppError({
    code: "E_MODEL_NETWORK",
    severity: "warning",
    title: "正在重试",
    detail: "第 1/3 次，2 秒后重试",
    raw: TIMEOUT_RAW,
    recoverable: true,
    action: "retry",
  });
  assert.equal(view.tone, "warn");
  assert.equal(view.reason, "第 1/3 次，2 秒后重试");
  assert.ok(view.raw);
  assert.ok(!view.raw.includes("2606:4700"));
});

test("isTechnical 区分人话与原文", () => {
  assert.equal(isTechnical(TIMEOUT_RAW), true);
  assert.equal(isTechnical("第 1/3 次，2 秒后重试"), false);
});
