/**
 * AWTRIX NG status mirror for omp.
 *
 * Ports openharness' Harness-device "cable" semantics (turn.started, turn.activity,
 * turn.done, summary, turn.error, question, question.close) from USB serial frames
 * to the AWTRIX NG HTTP API:
 *
 *   per-agent tile      -> pushed app `omp-<project>-<pid>`: state icon, project, activity
 *   global mood         -> the three edge indicators, aggregated over every omp process
 *                          (1 top: needs you, 2 middle: working, 3 bottom: done / error)
 *   summary + beep      -> done notification with the device's 3-beep alert (main agent only)
 *   question            -> attention notification that wakes the display, closed when answered
 *   25 s busy watchdog  -> pushed-app `lifetimeMs`, refreshed by a heartbeat while busy
 *
 * Env: AWTRIX_URL (default http://10.42.1.80; "off" disables), AWTRIX_AUTH=user:pass,
 *      AWTRIX_SOUND=0, AWTRIX_INDICATORS=0, AWTRIX_INK=#RRGGBB (omp's tile color).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type Phase = "idle" | "working" | "attention" | "done" | "error";
type Fragment = { text: string; color: string };
type SharedEntry = { pid: number; phase: Phase; project: string; at: number };

const URL_BASE = (process.env.AWTRIX_URL ?? "http://10.42.1.80").trim().replace(/\/+$/, "");
const ENABLED = URL_BASE !== "" && URL_BASE.toLowerCase() !== "off";
const AUTH = process.env.AWTRIX_AUTH ? `Basic ${Buffer.from(process.env.AWTRIX_AUTH).toString("base64")}` : undefined;
const INDICATORS = process.env.AWTRIX_INDICATORS !== "0";
const INK = process.env.AWTRIX_INK && /^#[0-9a-f]{6}$/i.test(process.env.AWTRIX_INK) ? process.env.AWTRIX_INK : "#4FC3F7";
let soundOn = process.env.AWTRIX_SOUND !== "0";

const REQUEST_TIMEOUT_MS = 2500;
const HEARTBEAT_MS = 15_000;
const BUSY_LIFETIME_MS = 45_000;
const DONE_TTL_MS = 10 * 60_000;
const ACTIVITY_MIN_INTERVAL_MS = 5_000;
const MAX_QUEUE = 32;

const COLOR = { attention: "#FF8C00", attentionDim: "#4A2800", done: "#00E05A", error: "#FF2020", dim: "#9A9A9A", text: "#FFFFFF" };
// openharness audio_notify_done: three ~2 kHz beeps of 80 ms (B6 = 1976 Hz, 1/16 at 188 bpm = 80 ms).
const DONE_BEEP = { rtttl: "omp:d=16,o=6,b=188:b,p,b,p,b" };
const PHASES: Record<Phase, true> = { idle: true, working: true, attention: true, done: true, error: true };

// ---------------------------------------------------------------------------
// 8x8 GIF icons (AWTRIX takes GIF/JPEG data URLs, not PNG)
// ---------------------------------------------------------------------------

const PIXEL: Record<string, number> = { ".": 0, o: 1, "+": 2 };

/** Encodes frames of `.`/`o`/`+` pixel art (palette indices 0/1/2) as an optionally looping GIF data URL. */
function gif(palette: string[], frames: string[][], delayMs = 0): string {
  const w = frames[0][0].length;
  const h = frames[0].length;
  const minCode = 3;
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const out: number[] = [...Buffer.from("GIF89a"), w & 255, w >> 8, h & 255, h >> 8, 0xf2, 0, 0];
  for (let i = 0; i < 8; i++) {
    const n = Number.parseInt((palette[i] ?? "#000000").slice(1), 16);
    out.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  const animated = frames.length > 1;
  if (animated) out.push(0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 0x03, 0x01, 0, 0, 0);
  const delay = Math.round(delayMs / 10);
  for (const rows of frames) {
    if (animated) out.push(0x21, 0xf9, 0x04, 0x04, delay & 255, delay >> 8, 0, 0);
    out.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, minCode);
    // Uncompressed LZW: re-clear before the decoder's code table outgrows minCode+1 bits.
    const codes = [clear];
    let run = 0;
    for (const row of rows) {
      for (const ch of row) {
        if (run === clear - 2) {
          codes.push(clear);
          run = 0;
        }
        codes.push(PIXEL[ch] ?? 0);
        run++;
      }
    }
    codes.push(eoi);
    const data: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const code of codes) {
      acc |= code << bits;
      bits += minCode + 1;
      while (bits >= 8) {
        data.push(acc & 255);
        acc >>= 8;
        bits -= 8;
      }
    }
    if (bits > 0) data.push(acc & 255);
    for (let i = 0; i < data.length; i += 255) {
      const block = data.slice(i, i + 255);
      out.push(block.length, ...block);
    }
    out.push(0);
  }
  out.push(0x3b);
  return `data:image/gif;base64,${Buffer.from(out).toString("base64")}`;
}

const WALK_A = ["...oo...", "..oooo..", ".oooooo.", "oo.oo.oo", "oooooooo", "..o..o..", ".o.oo.o.", "o.o..o.o"];
const WALK_B = ["...oo...", "..oooo..", ".oooooo.", "oo.oo.oo", "oooooooo", ".o.oo.o.", "o......o", ".o....o."];
const ASK = ["..oooo..", ".oo..oo.", ".....oo.", "....oo..", "...oo...", "...oo...", "........", "...oo..."];
const CHECK = ["........", ".......o", "......oo", "o....oo.", "oo..oo..", ".oooo...", "..oo....", "........"];
const CROSS = ["o......o", ".o....o.", "..o..o..", "...oo...", "...oo...", "..o..o..", ".o....o.", "o......o"];

const ICON: Record<Exclude<Phase, "idle">, string> = {
  working: gif(["#000000", INK], [WALK_A, WALK_B], 350),
  attention: gif(["#000000", COLOR.attention, COLOR.attentionDim], [ASK, ASK.map(r => r.replaceAll("o", "+"))], 500),
  done: gif(["#000000", COLOR.done], [CHECK]),
  error: gif(["#000000", COLOR.error], [CROSS]),
};

// ---------------------------------------------------------------------------
// Transport: one serialized queue; keyed ops (app, indicators) keep only the latest
// ---------------------------------------------------------------------------

type Op = { key?: string; run: () => Promise<unknown> };
const queue: Op[] = [];
let draining: Promise<void> | undefined;
let offline = false;
let log: ExtensionAPI["logger"] | undefined;

function enqueue(op: Op): void {
  if (op.key) {
    const at = queue.findIndex(q => q.key === op.key);
    if (at >= 0) {
      queue[at] = op;
      return;
    }
  }
  if (queue.length >= MAX_QUEUE) {
    const oldest = queue.findIndex(q => !q.key);
    queue.splice(oldest >= 0 ? oldest : 0, 1);
  }
  queue.push(op);
  draining ??= drain();
}

async function drain(): Promise<void> {
  try {
    while (queue.length > 0) {
      const op = queue.shift();
      try {
        await op?.run();
      } catch {}
    }
  } finally {
    draining = undefined;
  }
}

async function request(method: string, route: string, body?: unknown): Promise<Response | undefined> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (AUTH) headers.Authorization = AUTH;
  try {
    const res = await fetch(URL_BASE + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (offline) {
      offline = false;
      log?.info(`awtrix: ${URL_BASE} reachable again`);
    }
    // 404 is expected when closing a notification or app that is already gone.
    if (!res.ok && res.status !== 404) log?.warn(`awtrix: ${method} ${route} -> ${res.status} ${await res.clone().text()}`);
    return res;
  } catch (err) {
    if (!offline) {
      offline = true;
      log?.warn(`awtrix: ${URL_BASE} unreachable (${err instanceof Error ? err.message : String(err)})`);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** AWTRIX fonts cover Latin/Greek/Cyrillic; anything else renders as `?`. */
function clean(text: string, max: number): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>|~]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u2192/g, "->")
    .replace(/[^\x20-\x7E\u00A0-\u024F\u0370-\u04FF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

/** First meaningful line of the final reply: the dial's recap. */
function recapOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  const text = content.map(block => (block.type === "text" && block.text ? block.text : "")).join("\n");
  for (const line of text.replace(/```[\s\S]*?```/g, "\n").split("\n")) {
    const recap = clean(line, 100);
    if (recap.length > 1) return recap;
  }
  return "";
}

function firstQuestion(args: unknown): string {
  if (!args || typeof args !== "object" || !("questions" in args) || !Array.isArray(args.questions)) return "question";
  const first: unknown = args.questions[0];
  return first && typeof first === "object" && "question" in first && typeof first.question === "string" ? first.question : "question";
}

// ---------------------------------------------------------------------------
// Session state (main agent of this process) + cross-process aggregation
// ---------------------------------------------------------------------------

const PID36 = process.pid.toString(36);
const ASK_NOTIFICATION = `omp-ask-${PID36}`;
const SHARED_DIR = path.join(os.tmpdir(), "omp-awtrix");
const SHARED_FILE = path.join(SHARED_DIR, `${process.pid}.json`);

const state = { phase: "idle" as Phase, project: "omp", app: "", activity: "", detail: "", lastAppPush: 0 };
let trailingPush: Timer | undefined;
let doneTimer: Timer | undefined;
let heartbeat: Timer | undefined;

function setProject(cwd: string): void {
  state.project = path.basename(cwd) || "omp";
  const slug = state.project.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
  const app = `omp-${slug.slice(0, 32 - 5 - PID36.length)}-${PID36}`;
  if (state.app && state.app !== app && state.phase !== "idle") {
    const old = state.app;
    enqueue({ run: () => request("DELETE", `/api/v1/apps/${old}`) });
  }
  state.app = app;
}

/** Timer callbacks run outside omp's handler isolation; an escaped throw would kill the session. */
function guarded(fn: () => void): () => void {
  return () => {
    try {
      fn();
    } catch (err) {
      log?.warn(`awtrix: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

function writeShared(): void {
  try {
    if (state.phase === "idle") {
      fs.rmSync(SHARED_FILE, { force: true });
      return;
    }
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    const entry: SharedEntry = { pid: process.pid, phase: state.phase, project: state.project, at: Date.now() };
    fs.writeFileSync(SHARED_FILE, JSON.stringify(entry));
  } catch {}
}

const isPhase = (value: string): value is Phase => value in PHASES;

function parseShared(raw: string): SharedEntry | undefined {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") return undefined;
  if (!("pid" in value) || typeof value.pid !== "number") return undefined;
  if (!("phase" in value) || typeof value.phase !== "string" || !isPhase(value.phase)) return undefined;
  if (!("at" in value) || typeof value.at !== "number") return undefined;
  const project = "project" in value && typeof value.project === "string" ? value.project : "?";
  return { pid: value.pid, phase: value.phase, project, at: value.at };
}

/** Phases of every live omp process on this machine, like the dial's per-agent tiles. */
function livePhases(): { project: string; phase: Phase }[] {
  const out: { project: string; phase: Phase }[] = [];
  if (state.phase !== "idle") out.push({ project: state.project, phase: state.phase });
  let names: string[] = [];
  try {
    names = fs.readdirSync(SHARED_DIR);
  } catch {
    return out;
  }
  const now = Date.now();
  for (const name of names) {
    const file = path.join(SHARED_DIR, name);
    if (file === SHARED_FILE || !name.endsWith(".json")) continue;
    try {
      const entry = parseShared(fs.readFileSync(file, "utf8"));
      if (!entry) continue;
      try {
        process.kill(entry.pid, 0);
      } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "EPERM")) {
          fs.rmSync(file, { force: true });
          continue;
        }
      }
      const busy = entry.phase === "working" || entry.phase === "attention";
      if (now - entry.at > (busy ? BUSY_LIFETIME_MS : DONE_TTL_MS)) continue;
      out.push({ project: entry.project, phase: entry.phase });
    } catch {}
  }
  return out;
}

function setIndicator(id: number, value: Record<string, unknown> | null): void {
  enqueue({
    key: `indicator${id}`,
    run: () => (value ? request("PUT", `/api/v1/indicators/${id}`, value) : request("DELETE", `/api/v1/indicators/${id}`)),
  });
}

/** Global mood: needs-you > working > done, each on its own edge light so they never hide each other. */
function syncIndicators(): void {
  if (!INDICATORS) return;
  const phases = new Set(livePhases().map(entry => entry.phase));
  setIndicator(1, phases.has("attention") ? { color: COLOR.attention, blinkMs: 500 } : null);
  setIndicator(2, phases.has("working") ? { color: INK, fadeMs: 2000 } : null);
  setIndicator(3, phases.has("error") ? { color: COLOR.error } : phases.has("done") ? { color: COLOR.done } : null);
}

function appPayload(phase: Exclude<Phase, "idle">): Record<string, unknown> {
  const text: Fragment[] = [{ text: state.project, color: INK }];
  if (phase === "working" && state.activity) text.push({ text: ` ${state.activity}`, color: COLOR.dim });
  if (phase === "attention") text.push({ text: ` ${state.detail || "needs you"}`, color: COLOR.attention });
  if (phase === "done") text.push({ text: " done", color: COLOR.done });
  if (phase === "error") text.push({ text: " error", color: COLOR.error });
  const busy = phase === "working" || phase === "attention";
  return { icon: ICON[phase], text, lifetimeMs: busy ? BUSY_LIFETIME_MS : DONE_TTL_MS, lifetimeExpiry: "remove" };
}

/** Pushes the tile now, or (for activity-only changes) at most once per ACTIVITY_MIN_INTERVAL_MS. */
function pushApp(immediate: boolean): void {
  clearTimeout(trailingPush);
  trailingPush = undefined;
  const app = state.app;
  const phase = state.phase;
  if (phase === "idle") {
    enqueue({ key: "app", run: () => request("DELETE", `/api/v1/apps/${app}`) });
    return;
  }
  const wait = immediate ? 0 : state.lastAppPush + ACTIVITY_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    trailingPush = setTimeout(guarded(() => pushApp(true)), wait);
    trailingPush.unref();
    return;
  }
  state.lastAppPush = Date.now();
  const payload = appPayload(phase);
  enqueue({ key: "app", run: () => request("PUT", `/api/v1/apps/pushed/${app}`, payload) });
}

function notify(icon: string, detail: string, detailColor: string, extra: Record<string, unknown>): void {
  const payload = {
    icon,
    text: [
      { text: `${state.project}: `, color: INK },
      { text: detail, color: detailColor },
    ],
    repeat: 1,
    ...extra,
  };
  enqueue({ run: () => request("POST", "/api/v1/notifications", payload) });
}

function setPhase(next: Phase): void {
  const prev = state.phase;
  clearTimeout(doneTimer);
  doneTimer = undefined;
  state.phase = next;
  if (next !== "working") state.activity = "";
  if (prev === "attention" && next !== "attention") {
    enqueue({ run: () => request("DELETE", `/api/v1/notifications/${ASK_NOTIFICATION}`) });
  }
  if (next === "done" || next === "error") {
    doneTimer = setTimeout(guarded(() => setPhase("idle")), DONE_TTL_MS);
    doneTimer.unref();
  }
  writeShared();
  syncIndicators();
  if (prev === "idle" && next === "idle") return;
  pushApp(true);
}

// openharness turn.started / turn.activity
function working(activity?: string): void {
  if (state.phase !== "working") {
    state.activity = activity ?? "";
    setPhase("working");
    return;
  }
  if (activity === undefined || activity === state.activity) return;
  state.activity = activity;
  pushApp(false);
}

// openharness question: wakes the display; no beep, like the dial.
function attention(prompt: string): void {
  state.detail = clean(prompt, 90) || "needs you";
  setPhase("attention");
  notify(ICON.attention, state.detail, COLOR.attention, { name: ASK_NOTIFICATION, repeat: 2, wakeup: true });
}

// openharness turn.done + summary: the beep rides the summary; an empty reply stays silent.
function done(recap: string): void {
  setPhase("done");
  if (recap) notify(ICON.done, recap, COLOR.text, { name: `omp-done-${PID36}`, ...(soundOn ? { sound: DONE_BEEP } : {}) });
}

// openharness turn.error: a toast with the message.
function failed(message: string): void {
  state.detail = clean(message, 90) || "error";
  setPhase("error");
  notify(ICON.error, state.detail, COLOR.error, { name: `omp-err-${PID36}` });
}

async function deviceStatus(): Promise<string> {
  const res = await request("GET", "/api/v1/device");
  if (!res?.ok) return `AWTRIX unreachable at ${URL_BASE}`;
  const device: unknown = await res.json();
  const field = (key: string): string =>
    device && typeof device === "object" && key in device ? String(Reflect.get(device, key)) : "?";
  const sessions = livePhases()
    .map(entry => `${entry.project}=${entry.phase}`)
    .join(", ");
  return `AWTRIX NG ${field("version")} (${field("hostname")}) at ${URL_BASE}, showing ${field("currentApp")}; tile ${state.app}; sound ${soundOn ? "on" : "off"}; omp sessions: ${sessions || "none"}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function awtrixStatus(pi: ExtensionAPI): void {
  if (!ENABLED) return;
  log = pi.logger;
  // Subagents and the advisor run in child sessions; only the main agent owns the tile
  // (openharness marks sub-agent summaries `silent`).
  const owns = (ctx: ExtensionContext): boolean => {
    if (ctx.agent.kind !== "main") return false;
    if (!state.app) setProject(ctx.cwd);
    return true;
  };

  pi.on("session_start", (_event, ctx) => {
    if (!owns(ctx)) return;
    setProject(ctx.cwd);
    // Busy tiles expire on the clock after BUSY_LIFETIME_MS unless refreshed (the dial's stale-busy watchdog).
    heartbeat ??= setInterval(
      guarded(() => {
        if (state.phase !== "working" && state.phase !== "attention") return;
        writeShared();
        syncIndicators();
        pushApp(true);
      }),
      HEARTBEAT_MS,
    );
    heartbeat.unref();
  });
  pi.on("session_switch", (_event, ctx) => {
    if (!owns(ctx)) return;
    setPhase("idle");
    setProject(ctx.cwd);
  });
  pi.on("agent_start", (_event, ctx) => {
    if (owns(ctx)) working();
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (!owns(ctx)) return;
    if (event.toolName === "ask") attention(firstQuestion(event.args));
    else if (state.phase !== "attention") working(clean(event.intent || event.toolName, 48));
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (owns(ctx) && event.toolName === "ask" && state.phase === "attention") working();
  });
  pi.on("tool_approval_requested", (event, ctx) => {
    if (owns(ctx)) attention(`approve ${event.toolName}?`);
  });
  pi.on("tool_approval_resolved", (_event, ctx) => {
    if (owns(ctx) && state.phase === "attention") working();
  });
  pi.on("agent_end", (event, ctx) => {
    if (!owns(ctx) || event.willContinue === true) return;
    // Like the dial, hold turn end while task subagents still run; the agent resumes when they deliver.
    if (ctx.getAsyncJobSnapshot()?.running.some(job => job.type === "task")) return;
    const last = event.messages.findLast(message => message.role === "assistant");
    if (!last || last.role !== "assistant") done("");
    else if (last.stopReason === "aborted") setPhase("idle");
    else if (last.stopReason === "error") failed(last.errorMessage ?? "error");
    else done(recapOf(last.content));
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!owns(ctx)) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
    setPhase("idle");
    // session_shutdown handlers get a 2 s budget; deliver the final DELETEs inside it.
    if (draining) await Promise.race([draining, Bun.sleep(1500)]);
  });

  pi.registerCommand("awtrix", {
    description: "AWTRIX clock: status | test | mute | unmute",
    handler: async (args, ctx) => {
      const verb = args.trim().toLowerCase();
      if (verb === "mute" || verb === "unmute") {
        soundOn = verb === "unmute";
        ctx.ui.notify(`AWTRIX done-beep ${soundOn ? "on" : "off"}`, "info");
        return;
      }
      if (verb === "test") {
        if (state.phase === "working" || state.phase === "attention") {
          ctx.ui.notify("Agent is busy; run /awtrix test when idle", "warning");
          return;
        }
        setProject(ctx.cwd);
        working("Testing AWTRIX link");
        await Bun.sleep(6000);
        attention("Ship it?");
        await Bun.sleep(8000);
        working();
        await Bun.sleep(2000);
        done("AWTRIX link works");
      }
      ctx.ui.notify(await deviceStatus(), offline ? "warning" : "info");
    },
  });
}
