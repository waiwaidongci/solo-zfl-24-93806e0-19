// 并发命令复验：多设备并发上报 + 同批次并发重放 + 告警处置高并发竞争。
// 用法：E2E_BASE=http://127.0.0.1:3199 node concurrency-check.mjs
const BASE = process.env.E2E_BASE || "http://127.0.0.1:3199";
const tag = `CC${Date.now().toString(36)}`;
let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const get = async path => (await fetch(BASE + path)).json();

// 1) 建棚 + 5 台设备 + 温度传感器 + 阈值（连续2）
const loft = (await post("/api/monitor/lofts", { name: `并发棚-${tag}`, offlineTimeoutMs: 10 * 60000 })).json;
const setup = await Promise.all(Array.from({ length: 5 }, async (_, i) => {
  const device = (await post("/api/monitor/devices", { code: `CDEV-${tag}-${i}`, loftId: loft.id })).json;
  const sensor = (await post("/api/monitor/sensors", { deviceId: device.id, metric: "temperature" })).json;
  return { device, sensor };
}));
await post("/api/monitor/thresholds", { loftId: loft.id, metric: "temperature", min: 15, max: 30, consecutive: 2 });

// 2) 20 个并发批次（每批3条越限）打向 5 台设备
const t0 = Date.now();
const ingestResults = await Promise.all(Array.from({ length: 20 }, (_, i) => {
  const { device, sensor } = setup[i % 5];
  return post("/api/monitor/ingest", {
    batchId: `CCB-${tag}-${i}`,
    readings: [0, 1, 2].map(k => ({ deviceId: device.id, sensorId: sensor.id, value: 35 + i, ts: t0 + i * 4000 + k * 1000 }))
  });
}));
ok("20 个并发批次全部 200", ingestResults.every(r => r.status === 200),
  `ingested=${ingestResults.reduce((n, r) => n + (r.json.ingested || 0), 0)}/60`);

// 3) 同一批次号 12 路并发重放：只有首见者真正入库，其余全部 duplicated
const { device, sensor } = setup[0];
const dupBatch = { batchId: `CCDUP-${tag}`, readings: [
  { deviceId: device.id, sensorId: sensor.id, value: 40, ts: t0 + 200000 },
  { deviceId: device.id, sensorId: sensor.id, value: 41, ts: t0 + 201000 }
] };
const replays = await Promise.all(Array.from({ length: 12 }, (_, i) =>
  i === 0 ? post("/api/monitor/ingest", dupBatch)
          // 重放者故意携带不同内容，必须被幂等丢弃
          : post("/api/monitor/ingest", { ...dupBatch, readings: [{ deviceId: device.id, sensorId: sensor.id, value: 99, ts: t0 + 300000 + i }] })));
ok("同批次12路并发：恰好1路首次、11路 duplicated",
  replays.filter(r => r.json.duplicated === false).length === 1 && replays.filter(r => r.json.duplicated === true).length === 11);
const hist = await get(`/api/monitor/sensors/${sensor.id}/readings`);
ok("并发重放未写入任何伪造读数（该批只入库2条）",
  hist.readings.filter(r => r.batchId === dupBatch.batchId).length === 2,
  `实际 ${hist.readings.filter(r => r.batchId === dupBatch.batchId).length} 条`);

// 4) 每台设备应恰好有 1 条 open/acked 告警（4 批 ×3 条越限，告警中不重复建警）
let state = await get("/api/monitor/state");
const myAlerts = state.alerts.filter(a => a.loftId === loft.id);
ok("5台设备并发上报后各1条告警（共5条，无重复建警）", myAlerts.length === 5, `实际 ${myAlerts.length} 条`);

// 5) 单条告警 30 路并发确认：恰好 1 路成功
const aid = myAlerts[0].id;
const acks = await Promise.all(Array.from({ length: 30 }, () => post(`/api/monitor/alerts/${aid}/acknowledge`, { by: "cc" })));
ok("30路并发确认：1成功 29冲突",
  acks.filter(a => a.status === 200).length === 1 && acks.filter(a => a.status === 409).length === 29,
  `200×${acks.filter(a => a.status === 200).length} 409×${acks.filter(a => a.status === 409).length}`);

// 6) 并发改派：10 路各自不同指派人，全部串行成功且留痕 10 条；再 5 路同人重复全部冲突
const people = Array.from({ length: 10 }, (_, i) => `工${i}`);
const assigns1 = await Promise.all(people.map(p => post(`/api/monitor/alerts/${aid}/assign`, { assignee: p })));
ok("10路并发改派（不同人）全部成功", assigns1.every(a => a.status === 200),
  `成功 ${assigns1.filter(a => a.status === 200).length}`);
const assigns2 = await Promise.all(Array.from({ length: 5 }, () => post(`/api/monitor/alerts/${aid}/assign`, { assignee: "重复人" })));
ok("5路并发同人指派：仅1成功", assigns2.filter(a => a.status === 200).length === 1);

// 7) 升级竞争：10 路同时升到 L5，只有1路成功，其余 409
const escs = await Promise.all(Array.from({ length: 10 }, () => post(`/api/monitor/alerts/${aid}/escalate`, { level: 5 })));
ok("10路并发升级到同级：仅1成功", escs.filter(e => e.status === 200).length === 1);

// 8) 恢复后 20 路并发关闭：恰好 1 路成功；未恢复的告警关闭仍被拒
state = await get("/api/monitor/state");
const target = state.alerts.find(a => a.id === aid);
// 恢复读数必须发给该告警自己的传感器，且时间戳晚于其当前最新读数
const recRes = await post("/api/monitor/ingest", {
  batchId: `CCREC-${tag}`,
  readings: [{ deviceId: target.deviceId, sensorId: target.sensorId, value: 22, ts: t0 + 500000 }]
});
ok("恢复批次推进状态机", recRes.status === 200 && recRes.json.late === 0, JSON.stringify(recRes.json.results?.map(r => r.reason)));
const notRecovered = state.alerts.find(a => a.loftId === loft.id && a.id !== aid).id;
const earlyClose = await post(`/api/monitor/alerts/${notRecovered}/close`, {});
ok("未恢复告警关闭被拒（409 not_recovered）", earlyClose.status === 409 && earlyClose.json.error === "not_recovered");
const closes = await Promise.all(Array.from({ length: 20 }, () => post(`/api/monitor/alerts/${aid}/close`, { by: "cc" })));
ok("20路并发关闭恢复告警：1成功 19冲突",
  closes.filter(c => c.status === 200).length === 1 && closes.filter(c => c.status === 409).length === 19,
  `200×${closes.filter(c => c.status === 200).length} 409×${closes.filter(c => c.status === 409).length}`);
state = await get("/api/monitor/state");
const final = state.alerts.find(a => a.id === aid);
ok("处置留痕：ack×1 close×1",
  final.actions.filter(a => a.kind === "acknowledge").length === 1 &&
  final.actions.filter(a => a.kind === "close").length === 1,
  JSON.stringify(final.actions.map(a => a.kind)));

console.log(`\n${failures === 0 ? "全部并发复验通过" : failures + " 项失败"}`);
process.exit(failures ? 1 : 0);
