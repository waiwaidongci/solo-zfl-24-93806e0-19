// 环境监控台页面（服务端渲染的单页应用，原生 JS，无外部依赖）
export const monitorPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>鸽舍环境监控台</title>
<style>
  :root { --bg:#eef1f4; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#2f6d5b; --red:#b03a2e; --amber:#b9770e; --blue:#2c5f8a; --green:#2e7d32; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
  header { padding:18px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }
  h1 { margin:0; font-size:23px; }
  h2 { margin:0 0 10px; font-size:16px; }
  main { padding:18px 26px; display:grid; grid-template-columns:360px 1fr; gap:18px; align-items:start; }
  .panel,form,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; }
  .stack { display:grid; gap:14px; }
  label { display:block; margin:8px 0 4px; color:var(--muted); font-size:12px; }
  input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; }
  button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; font-size:13px; }
  button.ghost { background:#eef1f4; color:var(--ink); border:1px solid var(--line); }
  button.red { background:var(--red); } button.amber { background:var(--amber); } button.blue { background:var(--blue); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .stats { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:14px; }
  .stat b { display:block; font-size:22px; } .stat span { color:var(--muted); font-size:12px; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
  .pill.online { background:#e8f5e9; color:var(--green); border-color:#a5d6a7; }
  .pill.offline { background:#fdecea; color:var(--red); border-color:#f5b7b1; }
  .pill.maint { background:#fff8e1; color:var(--amber); border-color:#f0d9a0; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
  .meta { color:var(--muted); font-size:12px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .sensor-line { display:flex; justify-content:space-between; padding:6px 8px; background:#f8fafb; border:1px solid var(--line); border-radius:6px; margin-top:6px; font-size:13px; }
  .val-bad { color:var(--red); font-weight:700; } .val-ok { color:var(--green); }
  .alert { border-left:5px solid var(--red); margin-bottom:10px; }
  .alert.acked { border-left-color:var(--amber); }
  .alert.recovered { border-left-color:var(--green); }
  .alert.closed { border-left-color:#9aa7b2; opacity:.75; }
  .escalation { color:var(--red); font-weight:700; }
  .timeline { max-height:260px; overflow:auto; font-size:12px; }
  .timeline div { padding:3px 0; border-bottom:1px dashed var(--line); }
  .toast { position:fixed; right:20px; bottom:20px; display:grid; gap:8px; z-index:99; }
  .toast div { padding:10px 14px; border-radius:8px; color:#fff; box-shadow:0 4px 14px rgba(0,0,0,.18); max-width:380px; }
  .toast .ok { background:var(--green); } .toast .err { background:var(--red); }
  .thr-row { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 0; border-bottom:1px dashed var(--line); font-size:13px; }
  a { color:var(--blue); }
  header a.pill { white-space:nowrap; text-decoration:none; }
  header button { flex-shrink:0; }
  details summary { cursor:pointer; font-weight:700; margin:4px 0; }
  @media (max-width:980px){ main{grid-template-columns:1fr;} .stats{grid-template-columns:repeat(2,1fr);} }
</style>
</head>
<body>
<header>
  <div><h1>鸽舍环境监控台</h1><div class="meta">鸽棚 · 设备 · 传感器 · 批次读数 · 连续越限告警与处置</div></div>
  <div class="row">
    <label style="margin:0;display:flex;gap:6px;align-items:center;"><input type="checkbox" id="autoRefresh" checked style="width:auto"> 自动刷新</label>
    <a class="pill" href="/">← 返回赛鸽登记旧入口</a>
    <button id="refreshBtn" class="ghost">刷新</button>
  </div>
</header>
<main>
  <div class="stack">
    <form id="loftForm">
      <h2>① 登记鸽棚</h2>
      <label>棚名</label><input name="name" required data-testid="loft-name">
      <label>位置（可选）</label><input name="location">
      <label>离线超时（分钟，可填 0.05 用于调试）</label><input name="timeoutMin" type="number" min="0.05" step="0.05" value="5">
      <button type="submit" data-testid="loft-submit">登记鸽棚</button>
    </form>

    <form id="deviceForm">
      <h2>② 登记设备</h2>
      <label>所属鸽棚</label><select name="loftId" data-testid="device-loft"></select>
      <label>设备编码</label><input name="code" required data-testid="device-code" placeholder="如 DEV-01">
      <label>设备名称</label><input name="name">
      <button type="submit" data-testid="device-submit">登记设备</button>
    </form>

    <form id="sensorForm">
      <h2>③ 登记环境传感器</h2>
      <label>所属设备</label><select name="deviceId" data-testid="sensor-device"></select>
      <label>监测指标</label>
      <select name="metric"><option value="temperature">温度 (℃)</option><option value="humidity">湿度 (%)</option><option value="ammonia">氨气 (ppm)</option></select>
      <button type="submit" data-testid="sensor-submit">登记传感器</button>
    </form>

    <form id="thresholdForm">
      <h2>④ 阈值（按棚/设备/时段）</h2>
      <label>鸽棚</label><select name="loftId" id="thr-loft" data-testid="thr-loft"></select>
      <label>限定设备（可选，留空=棚级）</label><select name="deviceId"><option value="">棚级默认</option></select>
      <label>指标</label>
      <select name="metric"><option value="temperature">温度</option><option value="humidity">湿度</option><option value="ammonia">氨气</option></select>
      <div class="row"><div style="flex:1"><label>下限</label><input name="min" type="number" step="0.1" value="15"></div>
      <div style="flex:1"><label>上限</label><input name="max" type="number" step="0.1" value="30"></div>
      <div style="flex:1"><label>连续次数</label><input name="consecutive" type="number" min="1" value="3"></div></div>
      <div class="row"><div style="flex:1"><label>时段起</label><input name="timeStart" value="00:00"></div>
      <div style="flex:1"><label>时段止（支持跨夜）</label><input name="timeEnd" value="24:00"></div></div>
      <button type="submit" data-testid="thr-submit">配置阈值</button>
    </form>

    <div class="panel">
      <h2>⑤ 维护期（维护内不告警）</h2>
      <div class="row">
        <select id="maintenanceLoft" data-testid="maint-loft" style="flex:1"></select>
        <button id="maintStart" data-testid="maint-start">开始维护</button>
        <button id="maintStop" class="ghost" data-testid="maint-stop">结束维护</button>
      </div>
      <label>维护原因</label><input id="maintenanceReason" placeholder="如：清棚消毒">
    </div>

    <form id="ingestForm" class="panel">
      <h2>⑥ 设备分批上报读数</h2>
      <label>设备</label><select name="deviceId" id="ingest-device" data-testid="ingest-device"></select>
      <label>传感器</label><select name="sensorId" id="ingest-sensor" data-testid="ingest-sensor"></select>
      <div class="row">
        <div style="flex:1"><label>数值</label><input name="value" type="number" step="0.1" value="32" data-testid="ingest-value"></div>
        <div style="flex:1"><label>连续上报条数</label><input name="count" type="number" min="1" value="1" data-testid="ingest-count"></div>
        <div style="flex:1"><label>间隔(秒，可为负=乱序补发)</label><input name="stepSec" type="number" step="1" value="60" data-testid="ingest-step"></div>
      </div>
      <label>批次号（相同批次号重复提交=幂等）</label><input name="batchId" data-testid="ingest-batch" placeholder="留空自动生成">
      <div class="row" style="margin-top:8px"><button type="submit" data-testid="ingest-submit">上报批次</button>
      <button type="button" id="seedDemo" class="ghost">一键演示数据</button></div>
    </form>
  </div>

  <div class="stack">
    <div class="stats" id="stats"></div>

    <section class="panel">
      <h2>设备与最新读数</h2>
      <div class="grid" id="devices" data-testid="devices"></div>
    </section>

    <section class="panel">
      <h2>告警处置（连续越限触发；恢复后自动结束，方可关闭）</h2>
      <div id="alerts" data-testid="alerts"></div>
    </section>

    <section class="panel">
      <h2>阈值清单</h2>
      <div id="thresholds"></div>
    </section>

    <section class="panel">
      <h2>事件时间线（重启后仍可查）</h2>
      <div class="timeline" id="events"></div>
    </section>
  </div>
</main>
<div class="toast" id="toast"></div>

<script>
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
let state = null;

async function api(path, options) {
  const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
  return data;
}
function toast(msg, ok) {
  const box = $("#toast");
  const el = document.createElement("div");
  el.className = ok === false ? "err" : "ok";
  el.textContent = (ok === false ? "✕ " : "✓ ") + msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function fmtTime(ts) { if (!ts) return "—"; const d = new Date(ts); return d.toLocaleString("zh-CN", { hour12: false }); }
function relTime(ts) {
  if (!ts) return "从无上报";
  const s = Math.max(0, Math.floor((state.serverTime - ts) / 1000));
  if (s < 60) return s + "秒前";
  if (s < 3600) return Math.floor(s / 60) + "分钟前";
  return Math.floor(s / 3600) + "小时前";
}

const STATUS_TEXT = { open: "未确认", acked: "已确认", recovered: "已恢复待关闭", closed: "已关闭" };
const METRIC_UNIT = { temperature: "℃", humidity: "%", ammonia: "ppm" };

async function refresh() {
  try {
    state = await api("/api/monitor/state");
    render();
  } catch (e) { toast("加载失败: " + e.message, false); }
}

function fillSelect(sel, items, labelFn, keep) {
  const cur = keep === undefined ? sel.value : keep;
  sel.innerHTML = items.map((it, i) => '<option value="' + esc(it.id) + '">' + esc(labelFn(it, i)) + "</option>").join("");
  if (items.some(it => it.id === cur)) sel.value = cur;
}

function render() {
  const online = state.devices.filter(d => d.online).length;
  const activeAlerts = state.alerts.filter(a => a.status === "open" || a.status === "acked").length;
  const maintLofts = new Set(state.maintenance.filter(m => !m.end).map(m => m.loftId));
  $("#stats").innerHTML = [
    ["鸽棚", state.lofts.length], ["设备在线", online + "/" + state.devices.length],
    ["进行中告警", activeAlerts], ["维护中鸽棚", maintLofts.size], ["阈值规则", state.thresholds.length]
  ].map(([k, v]) => '<div class="stat"><b>' + v + '</b><span>' + k + "</span></div>").join("");

  // 下拉填充（保留已选值）
  fillSelect($("#deviceForm [name=loftId]"), state.lofts, l => l.name);
  fillSelect($("#sensorForm [name=deviceId]"), state.devices, d => d.code + "（" + (d.loftName || "") + "）");
  fillSelect($("#thr-loft"), state.lofts, l => l.name);
  fillSelect($("#maintenanceLoft"), state.lofts, l => l.name + (maintLofts.has(l.id) ? "（维护中）" : ""));
  const thrDevSel = $("#thresholdForm [name=deviceId]");
  {
    const cur = thrDevSel.value;
    thrDevSel.innerHTML = '<option value="">棚级默认</option>' + state.devices.map(d => '<option value="' + esc(d.id) + '">' + esc(d.code + "（" + (d.loftName || "") + "）") + "</option>").join("");
    thrDevSel.value = cur;
  }
  fillSelect($("#ingest-device"), state.devices, d => d.code + " · " + (d.loftName || ""));
  syncSensorSelect();

  // 设备卡片
  $("#devices").innerHTML = state.devices.map(d => {
    const maint = maintLofts.has(d.loftId);
    const sensors = d.sensors.map(s => {
      const v = s.state.value;
      const bad = s.state.status === "breaching";
      return '<div class="sensor-line"><span>' + esc(s.label) + "</span><span>" +
        (v === null ? '<span class="meta">无读数</span>'
          : '<span class="' + (bad ? "val-bad" : "val-ok") + '">' + Number(v).toFixed(1) + " " + (METRIC_UNIT[s.metric] || "") + "</span>") +
        ' <span class="meta">' + ({ idle: "空闲", ok: "正常", breaching: "越限", maintenance: "维护期", no_threshold: "未配阈值" }[s.state.status] || s.state.status) +
        (s.state.breachStreak ? " · 连续" + s.state.breachStreak + "次" : "") + "</span></span></div>";
    }).join("") || '<div class="meta">尚未登记传感器</div>';
    return '<article class="card" data-testid="device-card"><div class="row" style="justify-content:space-between">' +
      "<h2 style='margin:0'>" + esc(d.code) + "</h2>" +
      '<span class="pill ' + (d.online ? "online" : "offline") + '">' + (d.online ? "在线" : "离线") + "</span></div>" +
      '<div class="meta">' + esc(d.name) + " · " + esc(d.loftName || "") +
      (maint ? ' · <span class="pill maint">维护期</span>' : "") + "</div>" +
      sensors +
      '<div class="meta" style="margin-top:6px">最近上报：' + relTime(d.lastSeen) + (d.markedOfflineAt ? "（" + fmtTime(d.markedOfflineAt) + " 标记离线）" : "") + "</div></article>";
  }).join("") || '<p class="meta">还没有设备，请先登记鸽棚和设备。</p>';

  // 告警
  $("#alerts").innerHTML = state.alerts.map(a => {
    const canAck = a.status === "open";
    const canAssign = a.status === "open" || a.status === "acked";
    const canEsc = canAssign;
    const canClose = a.status === "recovered";
    return '<article class="card alert ' + a.status + '" data-testid="alert" data-alert="' + esc(a.id) + '">' +
      '<div class="row" style="justify-content:space-between"><div><b>' + esc(a.metricLabel) + "越限</b> " +
      '<span class="pill">' + STATUS_TEXT[a.status] + "</span>" +
      (a.escalation > 0 ? ' <span class="pill escalation">升级 L' + a.escalation + "</span>" : "") +
      (a.assignee ? ' <span class="pill">指派：' + esc(a.assignee) + "</span>" : "") + "</div>" +
      '<span class="meta">' + esc(a.deviceCode) + " · " + esc(a.loftName || "") + "</span></div>" +
      '<div class="meta">限值 ' + a.thresholdMin + "~" + a.thresholdMax + "（连续 " + a.consecutive + " 次）｜最新 " + Number(a.lastValue).toFixed(1) +
      " ｜起 " + fmtTime(a.startedAt) + (a.recoveredAt ? " ｜恢复 " + fmtTime(a.recoveredAt) : "") +
      (a.closedAt ? " ｜关闭 " + fmtTime(a.closedAt) : "") + "</div>" +
      '<div class="row" style="margin-top:8px">' +
      '<button data-act="acknowledge" ' + (canAck ? "" : "disabled") + ' data-testid="alert-ack">确认</button>' +
      '<input data-assignee placeholder="指派人" style="flex:1;min-width:110px" ' + (canAssign ? "" : "disabled") + '>' +
      '<button data-act="assign" class="blue" ' + (canAssign ? "" : "disabled") + ' data-testid="alert-assign">指派</button>' +
      '<button data-act="escalate" class="amber" ' + (canEsc ? "" : "disabled") + ' data-testid="alert-escalate">升级 L' + (a.escalation + 1) + "</button>" +
      '<button data-act="close" class="red" ' + (canClose ? "" : "disabled") + ' title="仅恢复后可关闭" data-testid="alert-close">关闭</button>' +
      "</div></article>";
  }).join("") || '<p class="meta">暂无告警。连续越限达到阈值次数后会出现在这里。</p>';

  // 阈值
  $("#thresholds").innerHTML = state.thresholds.map(t => {
    const dev = t.deviceId ? state.devices.find(d => d.id === t.deviceId) : null;
    const loft = state.lofts.find(l => l.id === t.loftId);
    return '<div class="thr-row"><span>' + esc(METRIC_LABEL_CN(t.metric)) + " · " + esc(loft ? loft.name : t.loftId) +
      (dev ? " · " + esc(dev.code) : " · 棚级") + ' · ' + t.timeStart + "~" + t.timeEnd +
      ' · 连续' + t.consecutive + "次</span><span><b>" + t.min + "~" + t.max + "</b> " +
      '<button class="ghost" data-del-thr="' + esc(t.id) + '">删除</button></span></div>';
  }).join("") || '<p class="meta">尚未配置阈值。</p>';

  // 时间线
  $("#events").innerHTML = state.events.slice(0, 120).map(e => {
    const d = e.detail || {};
    const text = {
      loft_registered: "登记鸽棚 " + (d.name || ""),
      device_registered: "登记设备 " + (d.code || ""),
      sensor_registered: "登记传感器 " + (d.metric || ""),
      threshold_added: "配置阈值 " + (d.metric || "") + " " + (d.min || "") + "~" + (d.max || "") + " " + (d.window || ""),
      maintenance_started: "开始维护：" + (d.reason || d.loftId || ""),
      maintenance_stopped: "结束维护 " + (d.loftId || ""),
      device_online: "设备上线 " + (d.code || d.deviceId || ""),
      device_offline: "设备离线（超时） " + (d.code || d.deviceId || ""),
      alert_raised: "⚠ 告警触发 " + (d.metric || "") + " = " + (d.value !== undefined ? d.value : "") + "（连续" + (d.consecutive || "") + "次）",
      alert_recovered: "告警自动恢复 " + (d.sensorId || ""),
      alert_acknowledge: "告警已确认 " + (d.by || ""),
      alert_assign: "告警指派 " + ((d.from || "无人") + "→" + (d.to || "")),
      alert_escalate: "告警升级 L" + (d.from || 0) + "→L" + (d.to || 1),
      alert_close: "告警关闭 " + (d.by || "")
    }[e.type] || e.type;
    return "<div>" + fmtTime(e.ts) + " · " + esc(text) + "</div>";
  }).join("");
}

function METRIC_LABEL_CN(m) { return { temperature: "温度", humidity: "湿度", ammonia: "氨气" }[m] || m; }

function syncSensorSelect() {
  const deviceId = $("#ingest-device").value;
  const device = state.devices.find(d => d.id === deviceId);
  const sel = $("#ingest-sensor");
  const cur = sel.value;
  const sensors = device ? device.sensors : [];
  sel.innerHTML = sensors.map(s => '<option value="' + esc(s.id) + '">' + esc(s.label) + "</option>").join("");
  if (!sensors.some(s => s.id === cur)) sel.value = sensors[0] ? sensors[0].id : "";
}
$("#ingest-device").addEventListener("change", syncSensorSelect);

function bindForm(id, url, mk, done) {
  $(id).addEventListener("submit", async e => {
    e.preventDefault();
    const form = $(id);
    try {
      const data = await api(url, { method: "POST", body: JSON.stringify(mk()) });
      toast("操作成功");
      if (done) done(data);
      form.reset();
      refresh();
    } catch (err) { toast(err.message, false); }
  });
}

bindForm("#loftForm", "/api/monitor/lofts", () => {
  const f = new FormData($("#loftForm"));
  return { name: f.get("name"), location: f.get("location"), offlineTimeoutMs: Number(f.get("timeoutMin")) * 60000 };
});
bindForm("#deviceForm", "/api/monitor/devices", () => {
  const f = new FormData($("#deviceForm"));
  return { loftId: f.get("loftId"), code: f.get("code"), name: f.get("name") };
});
bindForm("#sensorForm", "/api/monitor/sensors", () => {
  const f = new FormData($("#sensorForm"));
  return { deviceId: f.get("deviceId"), metric: f.get("metric") };
});
bindForm("#thresholdForm", "/api/monitor/thresholds", () => {
  const f = new FormData($("#thresholdForm"));
  return {
    loftId: f.get("loftId"), deviceId: f.get("deviceId") || null, metric: f.get("metric"),
    min: Number(f.get("min")), max: Number(f.get("max")), consecutive: Number(f.get("consecutive")),
    timeStart: f.get("timeStart"), timeEnd: f.get("timeEnd")
  };
});

$("#maintStart").onclick = async () => {
  try {
    await api("/api/monitor/maintenance/start", { method: "POST", body: JSON.stringify({ loftId: $("#maintenanceLoft").value, reason: $("#maintenanceReason").value }) });
    toast("维护期已开始"); refresh();
  } catch (e) { toast(e.message, false); }
};
$("#maintStop").onclick = async () => {
  try {
    await api("/api/monitor/maintenance/stop", { method: "POST", body: JSON.stringify({ loftId: $("#maintenanceLoft").value }) });
    toast("维护期已结束"); refresh();
  } catch (e) { toast(e.message, false); }
};

$("#ingestForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = new FormData($("#ingestForm"));
  const sensorId = f.get("sensorId");
  const deviceId = f.get("deviceId");
  const value = Number(f.get("value"));
  const count = Math.max(1, Number(f.get("count") || 1));
  const stepSec = Number(f.get("stepSec") || 60);
  let batchId = String(f.get("batchId") || "").trim();
  if (!batchId) batchId = "B-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
  const tBase = Date.now();
  const readings = [];
  for (let i = 0; i < count; i++) readings.push({ deviceId, sensorId, value, ts: tBase + i * stepSec * 1000 });
  try {
    const r = await api("/api/monitor/ingest", { method: "POST", body: JSON.stringify({ batchId, readings }) });
    toast((r.duplicated ? "重复批次已幂等忽略 · " : "已入库 " + r.ingested + " 条") + (r.late ? " · 乱序 " + r.late + " 条未覆盖状态" : ""),
      r.duplicated ? true : true);
    refresh();
  } catch (err) { toast(err.message, false); }
});

$("#seedDemo").onclick = async () => {
  try { await api("/api/monitor/demo-seed", { method: "POST", body: "{}" }); toast("演示数据已创建"); refresh(); }
  catch (e) { toast(e.message, false); }
};

$("#thresholds").addEventListener("click", async e => {
  const id = e.target.dataset.delThr;
  if (!id) return;
  try { await api("/api/monitor/thresholds/" + encodeURIComponent(id), { method: "DELETE" }); toast("阈值已删除"); refresh(); }
  catch (err) { toast(err.message, false); }
});

$("#alerts").addEventListener("click", async e => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || btn.disabled) return;
  const card = btn.closest("[data-alert]");
  const id = card.dataset.alert;
  const act = btn.dataset.act;
  let body = {};
  if (act === "assign") {
    const v = card.querySelector("[data-assignee]").value.trim();
    if (!v) return toast("请填写指派人", false);
    body = { assignee: v };
  }
  try {
    const r = await api("/api/monitor/alerts/" + encodeURIComponent(id) + "/" + act, { method: "POST", body: JSON.stringify(body) });
    toast("处置成功：" + ({ acknowledge: "确认", assign: "指派", escalate: "升级", close: "关闭" })[act]);
    refresh();
  } catch (err) { toast("处置失败：" + err.message, false); }
});

$("#refreshBtn").onclick = refresh;
setInterval(() => { if ($("#autoRefresh").checked) refresh(); }, 4000);
refresh();
</script>
</body>
</html>`;
