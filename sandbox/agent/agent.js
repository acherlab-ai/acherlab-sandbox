"use strict";

/**
 * AcherLab Sandbox Agent
 * ----------------------
 * Runs inside a GitHub Actions runner (self-hosted or hosted).
 * Boots a bash PTY, connects back to the AcherLab backend over WebSocket,
 * and bridges terminal I/O until the 2-hour TTL (or the backend/WS drops).
 *
 * PTY backend: prefers node-pty (real resize), falls back to the `script`
 * utility + `stty` so the agent runs even when native builds are unavailable.
 *
 * Env:  SANDBOX_ID, SANDBOX_TOKEN, WS_URL
 */

const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const WS_URL = process.env.WS_URL || "http://localhost:8081";
const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "";
const SANDBOX_ID = process.env.SANDBOX_ID || crypto.randomUUID();

const TTL_MS = Number(process.env.SANDBOX_TTL_MS || 120 * 60 * 1000); // 120 min
const SHELL =
  process.env.SANDBOX_SHELL ||
  (os.platform() === "win32" ? "powershell.exe" : "/bin/bash");

const WS_ENDPOINT = `${WS_URL.replace(/^http/, "ws")}/ws/sandbox?token=${encodeURIComponent(SANDBOX_TOKEN)}`;

const log = (...args) => console.log(`[agent:${SANDBOX_ID}]`, ...args);

let term = null;
let ws = null;
let heartbeat;

/* ---------- PTY backends ---------- */
let ptyMode = null;

function tryNodePty() {
  try {
    const pty = require("node-pty");
    const cols = Number(process.env.SANDBOX_COLS || 120);
    const rows = Number(process.env.SANDBOX_ROWS || 32);
    const t = pty.spawn(SHELL, os.platform() === "win32" ? [] : ["--login"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: os.homedir(),
      env: process.env,
    });
    t.onData((data) => send({ type: "data", data: Buffer.from(data, "utf8").toString("base64") }));
    t.onExit(({ exitCode }) => {
      send({ type: "exit", code: exitCode || 0 });
      setTimeout(() => killAgent("pty exited"), 400);
    });
    t.resize = (c, r) => t.resize(cols, rows);
    ptyMode = "node-pty";
    return t;
  } catch (err) {
    log("node-pty unavailable, using script fallback:", err.message);
    return null;
  }
}

function tryScriptPty() {
  try {
    const { spawn: _spawn } = require("child_process");
    const cols = Number(process.env.SANDBOX_COLS || 120);
    const rows = Number(process.env.SANDBOX_ROWS || 32);
    const proc = _spawn("script", ["-qfc", SHELL, "/dev/null"], {
      env: { ...process.env, TERM: "xterm-256color", SHELL },
    });
    const t = {
      cols,
      rows,
      proc,
      write(data) {
        if (proc.stdin.writable) proc.stdin.write(data);
      },
      resize(c, r) {
        t.cols = c; t.rows = r;
        // `script` has no direct resize; tell the pty's tty via stty.
        t.write(`\x1b[?25lstty cols ${c} rows ${r}\r\x1b[?25h`);
      },
      kill() {
        try { proc.kill("SIGKILL"); } catch {}
      },
    };
    proc.stdout.on("data", (buf) => send({ type: "data", data: buf.toString("base64") }));
    proc.stderr.on("data", (buf) => send({ type: "data", data: buf.toString("base64") }));
    proc.on("exit", (code) => {
      send({ type: "exit", code: code || 0 });
      setTimeout(() => killAgent("script exited"), 400);
    });
    ptyMode = "script";
    return t;
  } catch (err) {
    log("script fallback failed:", err.message);
    return null;
  }
}

function spawnShell() {
  log("spawning", SHELL);
  term = tryNodePty() || tryScriptPty();
  if (!term) {
    log("no usable PTY backend, exiting");
    process.exit(1);
  }
  log("pty ready via", ptyMode, `(${term.cols}x${term.rows})`);
  send({ type: "ready", cols: term.cols, rows: term.rows });
}

/* ---------- messaging ---------- */
function send(msg) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      log("send error", e.message);
    }
  }
}

function connect() {
  const WebSocket = require("ws");
  log("connecting to", WS_ENDPOINT);
  ws = new WebSocket(WS_ENDPOINT);

  ws.on("open", () => {
    log("connected to backend");
    send({ type: "ready", cols: term ? term.cols : 120, rows: term ? term.rows : 32 });
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "data" && term) {
      term.write(Buffer.from(msg.data, "base64").toString("utf8"));
    } else if (msg.type === "resize" && term) {
      const cols = Math.max(10, Number(msg.cols) || term.cols);
      const rows = Math.max(4, Number(msg.rows) || term.rows);
      term.resize(cols, rows);
      send({ type: "resize", cols, rows });
    } else if (msg.type === "ready-ack") {
      log("handshake complete");
    }
  });

  ws.on("close", (code) => {
    log("connection closed", code);
    killAgent("Backend connection closed");
  });

  ws.on("error", (err) => {
    log("ws error", err.message);
    killAgent("WebSocket error");
  });
}

let exiting = false;
function killAgent(reason) {
  if (exiting) return;
  exiting = true;
  log("shutting down:", reason);
  try { term && term.kill(); } catch {}
  try { ws && ws.close(); } catch {}
  clearInterval(heartbeat);
  process.exit(0);
}

// Hard self-destruct at the 2-hour mark
setTimeout(() => killAgent("TTL expired (120 min)"), TTL_MS);

heartbeat = setInterval(() => {
  send({ type: "info", status: "active", ttl_ms: TTL_MS, up_ms: Date.now() - process.uptime() * 1000 });
}, 30_000);

process.on("SIGTERM", () => killAgent("SIGTERM"));
process.on("SIGINT", () => killAgent("SIGINT"));

spawnShell();
connect();