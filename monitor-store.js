// 监控数据持久层：JSON 文件 + 串行写队列 + 原子写（temp+rename）。
// 所有变更走 mutate()：先在副本上执行，校验/落盘任一步失败都整体回滚。
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyDb, sweepOffline } from "./monitor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.MONITOR_DB || join(__dirname, "data", "monitor.json");

// 测试钩子：置 true 后落盘必然失败，用于验证写入失败整体回滚
let failWrites = false;
export function setFailWrites(v) { failWrites = !!v; }

let db = emptyDb();
let loaded = false;
let chain = Promise.resolve();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function atomicSave(data) {
  if (failWrites) throw new Error("injected_write_failure");
  await mkdir(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, dbPath);
}

export async function load() {
  if (loaded) return db;
  if (existsSync(dbPath)) {
    try {
      const parsed = JSON.parse(await readFile(dbPath, "utf8"));
      db = { ...emptyDb(), ...parsed };
    } catch (err) {
      // 文件损坏不应拖垮服务；以空库继续（损坏文件保留以便排查）
      console.error(`monitor db unreadable, starting empty: ${err.message}`);
      db = emptyDb();
    }
  } else {
    await mkdir(dirname(dbPath), { recursive: true });
    await atomicSave(db);
  }
  loaded = true;
  return db;
}

// 串行化所有变更：同一时刻只有一个事务在改库，配合“副本+原子写”实现并发处置仅一次成功。
export function mutate(fn) {
  const run = chain.then(async () => {
    await load();
    const draft = clone(db);
    const result = fn(draft); // 校验失败直接抛错，draft 被丢弃 => 内存库不变 => 回滚
    await atomicSave(draft); // 落盘失败同样丢弃 draft => 整体回滚
    db = draft;
    return result;
  });
  // 队列自身不因为单个失败而断裂
  chain = run.then(() => {}, () => {});
  return run;
}

export async function read() {
  await load();
  return db;
}

// 周期离线扫描：在事务中标记并持久化（重启后离线状态仍可查）
export function startSweeper(intervalMs = 10_000, clock = () => Date.now()) {
  const timer = setInterval(() => {
    mutate(d => sweepOffline(d, clock())).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

export async function resetForTests() {
  db = emptyDb();
  loaded = true;
  chain = Promise.resolve();
  if (existsSync(dbPath)) await unlink(dbPath).catch(() => {});
}

export function getDbPath() { return dbPath; }
