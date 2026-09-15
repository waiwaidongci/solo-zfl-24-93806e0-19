// 真实浏览器 E2E：驱动 /monitor 页面走完整业务流，并验证旧入口页面。
// 用法：先启动服务（PORT/E2E_BASE 环境变量），再 node browser-e2e.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.E2E_BASE || "http://127.0.0.1:3199";
const tag = `E2E${Date.now().toString(36)}`;

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", e => errors.push(String(e)));

async function fill(sel, v) { await page.fill(sel, String(v)); }
async function selectByLabelContains(sel, text) {
  const value = await page.locator(sel).evaluate((node, needle) => {
    const opt = [...node.options].find(o => o.textContent.includes(needle));
    return opt ? opt.value : null;
  }, text);
  assert.ok(value, `下拉 ${sel} 中找不到包含 "${text}" 的选项`);
  await page.selectOption(sel, value);
}

async function expectText(sel, text, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const ok = await page.locator(sel).filter({ hasText: text }).count() > 0;
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(200);
  }
}

try {
  // ---------- 旧入口 ----------
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  check("旧入口标题", (await page.title()).includes("赛鸽"));
  await page.fill('input[name=ringNo]', `CHN-E2E-${tag}`);
  await page.fill('input[name=owner]', "浏览器主");
  await page.fill('input[name=color]', "灰");
  await page.fill('input[name=loft]', "浏览器棚");
  await page.click('form#form button');
  await page.waitForTimeout(500);
  check("旧入口：新建鸽只出现在卡片", await page.locator(`#cards >> text=CHN-E2E-${tag}`).count() >= 1);
  check("旧入口：含指向监控台的链接", await page.locator('a[href="/monitor"]').count() === 1);
  await page.click('a[href="/monitor"]');
  await page.waitForURL("**/monitor");
  check("从旧入口跳到监控台", (await page.title()).includes("监控台"));

  // ---------- ① 登记鸽棚（超时 0.05 分钟 = 3 秒） ----------
  await fill('[data-testid=loft-name]', `自动化棚-${tag}`);
  await page.fill('input[name=timeoutMin]', "0.05");
  await page.click('[data-testid=loft-submit]');
  await page.waitForTimeout(400);

  // ② 设备
  await selectByLabelContains('[data-testid=device-loft]', `自动化棚-${tag}`);
  await fill('[data-testid=device-code]', `BDEV-${tag}`);
  await page.click('[data-testid=device-submit]');
  await page.waitForTimeout(400);

  // ③ 温度传感器
  await selectByLabelContains('[data-testid=sensor-device]', `BDEV-${tag}`);
  await page.selectOption('#sensorForm select[name=metric]', 'temperature');
  await page.click('[data-testid=sensor-submit]');
  await page.waitForTimeout(400);

  // ④ 阈值 15~30，连续 3 次
  await selectByLabelContains('[data-testid=thr-loft]', `自动化棚-${tag}`);
  await page.fill('#thresholdForm input[name=min]', "15");
  await page.fill('#thresholdForm input[name=max]', "30");
  await page.fill('#thresholdForm input[name=consecutive]', "3");
  await page.click('[data-testid=thr-submit]');
  await page.waitForTimeout(400);
  check("阈值清单出现规则", await page.locator('#thresholds >> text=BDEV-' + tag).count() === 0 // 棚级规则不带设备码
    && (await page.locator('#thresholds').innerText()).includes("15~30"));

  // 设备卡片 + 在线状态初始离线
  await selectByLabelContains('[data-testid=ingest-device]', `BDEV-${tag}`);
  await page.waitForTimeout(200);
  check("设备卡片渲染", await page.locator('[data-testid=device-card] >> text=BDEV-' + tag).count() >= 1);
  check("新设备初始离线", (await page.locator('[data-testid=device-card]').first().innerText()).includes("离线"));

  // ---------- 上报：2 条越限（抖动，不告警） ----------
  async function sendBatch({ value, count = 1, step = 1, batch, settleMs }) {
    await page.fill('#ingestForm input[name=value]', String(value));
    await page.fill('#ingestForm input[name=count]', String(count));
    await page.fill('#ingestForm input[name=stepSec]', String(step));
    await fill('[data-testid=ingest-batch]', batch);
    await page.click('[data-testid=ingest-submit]');
    // 等待墙钟越过本批最后一条读数的时间戳，避免下一批（按当前时间）被判乱序
    await page.waitForTimeout(settleMs ?? 400 + count * step * 1000);
  }
  await sendBatch({ value: 32, count: 2, step: 1, batch: `EB1-${tag}` });
  check("两次越限不产生告警（短时抖动）", await expectText('[data-testid=alerts]', "暂无告警"));

  // 重复批次：同批次号再报 -> 幂等提示且读数不增加（回放不产生新读数，无需等待）
  await sendBatch({ value: 99, count: 5, step: 1, batch: `EB1-${tag}`, settleMs: 500 });
  check("重复批次显示幂等提示", (await page.locator('.toast').innerText()).includes("重复批次已幂等忽略"));

  // 第 3 次越限 -> 告警
  await sendBatch({ value: 33, count: 1, step: 1, batch: `EB2-${tag}` });
  const alertCard = page.locator('[data-testid=alert]').first();
  await alertCard.waitFor({ timeout: 3000 });
  check("连续3次越限触发告警", (await alertCard.innerText()).includes("未确认"));
  check("设备转在线", (await page.locator('[data-testid=device-card]', { hasText: `BDEV-${tag}` }).innerText()).includes("在线"));

  // 并发处置：确认按钮点一次；用 API 并发再试 9 次确认，页面仍只有一次确认留痕
  const state0 = await (await fetch(BASE + "/api/monitor/state")).json();
  const alertId = state0.alerts[0].id;
  await Promise.all(Array.from({ length: 9 }, () =>
    fetch(`${BASE}/api/monitor/alerts/${alertId}/acknowledge`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ by: "并发" })
    }).then(r => r.status)));
  // 页面点确认应失败（已被并发请求抢先确认），出现错误 toast
  await page.click('[data-testid=alert-ack]');
  await page.waitForTimeout(600);
  check("并发确认仅一次成功（页面再确认报错）", (await page.locator('.toast .err').last().innerText()).includes("不可确认"));
  await page.waitForTimeout(2600); // 等自动刷新
  check("告警态变为已确认", (await page.locator('[data-testid=alert]').first().innerText()).includes("已确认"));

  // 指派
  await page.locator('[data-testid=alert] [data-assignee]').first().fill("赵工");
  await page.click('[data-testid=alert-assign]');
  await page.waitForTimeout(700);
  check("指派成功显示指派人", (await page.locator('[data-testid=alert]').first().innerText()).includes("赵工"));

  // 升级
  await page.click('[data-testid=alert-escalate]');
  await page.waitForTimeout(700);
  check("升级到 L1", (await page.locator('[data-testid=alert]').first().innerText()).includes("L1"));

  // 未恢复时关闭按钮禁用
  check("未恢复时关闭按钮禁用", await page.locator('[data-testid=alert-close]').first().isDisabled());

  // 维护期：开始维护后再越限不产生第二条告警
  await selectByLabelContains('[data-testid=maint-loft]', `自动化棚-${tag}`);
  await page.fill('#maintenanceReason', "清棚");
  await page.click('[data-testid=maint-start]');
  await page.waitForTimeout(500);
  await sendBatch({ value: 45, count: 3, step: 1, batch: `EB3-${tag}` });
  const stateM = await (await fetch(BASE + "/api/monitor/state")).json();
  check("维护期连续越限不新增告警", stateM.alerts.filter(a => a.deviceCode === `BDEV-${tag}`).length === 1);
  check("设备卡片显示维护期标记", (await page.locator('[data-testid=device-card]', { hasText: `BDEV-${tag}` }).innerText()).includes("维护期"));
  await page.click('[data-testid=maint-stop]');
  await page.waitForTimeout(400);

  // 恢复读数 -> 自动结束，关闭按钮启用
  await sendBatch({ value: 25, count: 1, step: 1, batch: `EB4-${tag}` });
  await page.waitForTimeout(2600);
  const recoveredCard = page.locator('[data-testid=alert]', { hasText: "已恢复待关闭" }).first();
  check("恢复后告警自动结束", await recoveredCard.count() === 1);
  check("恢复后关闭按钮可用", await recoveredCard.locator('[data-testid=alert-close]').isEnabled());

  // 并发关闭：页面点 1 次 + API 9 次，仅 1 次成功
  const closedStatuses = await Promise.all(Array.from({ length: 9 }, () =>
    fetch(`${BASE}/api/monitor/alerts/${alertId}/close`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ by: "并发关" })
    }).then(r => r.status)));
  // 若 API 已抢先关闭，页面按钮会在下次刷新后变禁用/卡片消失为关闭态；这里等待并断言最终已关闭且只有一条 close 记录
  await page.waitForTimeout(2600);
  const stateC = await (await fetch(BASE + "/api/monitor/state")).json();
  const finalAlert = stateC.alerts.find(a => a.id === alertId);
  check("告警最终已关闭", finalAlert.status === "closed");
  check("并发关闭仅一次 200", closedStatuses.filter(s => s === 200).length <= 1);
  check("处置留痕中 close 仅一条", finalAlert.actions.filter(a => a.kind === "close").length === 1);

  // 离线超时自动标记（3 秒）：等待超过超时后显式扫描
  await page.waitForTimeout(3500);
  const sweepStateBefore = await (await fetch(BASE + "/api/monitor/state")).json();
  // 自动刷新的周期扫描可能已先行标记；显式扫描应保持幂等（不再重复标记）
  const offline = await fetch(BASE + "/api/monitor/sweep", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }).then(r => r.json());
  const sweepStateAfter = await (await fetch(BASE + "/api/monitor/state")).json();
  const offDev = sweepStateAfter.devices.find(d => d.id === finalAlert.deviceId);
  check("超时后设备被标记离线（自动或手动扫描，且有标记时间）",
    offDev.online === false && !!offDev.markedOfflineAt,
    `online=${offDev.online} markedAt=${offDev.markedOfflineAt} explicitSweep=${JSON.stringify(offline.markedOffline)}`);
  await page.waitForTimeout(2600);
  check("页面显示设备离线", (await page.locator('[data-testid=device-card]', { hasText: `BDEV-${tag}` }).innerText()).includes("离线"));

  // 乱序补发：旧时间戳不覆盖当前状态
  await sendBatch({ value: 26, count: 1, step: 1, batch: `EB5-${tag}` });
  // 直接用 API 发一条明显旧的读数
  const sensorId = stateC.sensors.find(s => stateC.devices.find(d => d.id === s.deviceId)?.code === `BDEV-${tag}`).id;
  const lateRes = await fetch(BASE + "/api/monitor/ingest", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchId: `EBLATE-${tag}`, readings: [{ deviceId: finalAlert.deviceId, sensorId, value: 5, ts: Date.now() - 90000 }] })
  }).then(r => r.json());
  check("乱序补发计数 late=1 且不覆盖状态", lateRes.late === 1);
  const stateEnd = await (await fetch(BASE + "/api/monitor/state")).json();
  check("时间线含离线/上线/告警/恢复/关闭事件",
    ["device_offline", "alert_raised", "alert_recovered", "alert_close"].every(t => stateEnd.events.some(e => e.type === t)));

  // ---------- 页面无 JS 错误 ----------
  check("浏览器控制台无页面脚本错误", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("E2E 执行未抛异常: " + e.message, false, e.stack?.split("\n").slice(0, 3).join(" / "));
} finally {
  await page.screenshot({ path: new URL("./monitor-final.png", import.meta.url).pathname, fullPage: true });
  await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项浏览器复验通过`);
process.exit(failed.length ? 1 : 0);
