"use client";

/**
 * TEMPORARY Slice 3 device diagnostic — NOT product UI.
 *
 * Answers one question before any capture code is written: does the real
 * Android device honour `new AudioContext({ sampleRate: 16000 })`, and what
 * does the live mic track actually report? Must be run on the physical phone
 * over HTTPS (a Vercel preview) — desktop and localhost don't count here.
 *
 * Displays everything on screen because mobile Chrome has no usable console.
 * Delete this route once the sampleRate question is settled.
 */

import { useState } from "react";

interface Report {
  ok: boolean;
  requestedContextRate: 16000;
  actualContextRate: number | null;
  contextHonoured: boolean | null;
  defaultContextRate: number | null;
  sourceNodeContextRate: number | null;
  trackSettings: Record<string, unknown> | null;
  userAgent: string;
  error?: string;
}

export default function Diag() {
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    const base: Report = {
      ok: false,
      requestedContextRate: 16000,
      actualContextRate: null,
      contextHonoured: null,
      defaultContextRate: null,
      sourceNodeContextRate: null,
      trackSettings: null,
      userAgent: navigator.userAgent,
    };

    let ctx: AudioContext | null = null;
    let defaultCtx: AudioContext | null = null;
    let stream: MediaStream | null = null;

    try {
      // 1. Does the device honour a requested 16kHz context?
      const AC: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      ctx = new AC({ sampleRate: 16000 });
      base.actualContextRate = ctx.sampleRate;
      base.contextHonoured = ctx.sampleRate === 16000;

      // What rate does the device pick with no request, for comparison?
      defaultCtx = new AC();
      base.defaultContextRate = defaultCtx.sampleRate;

      // 2. What does the live mic track actually report?
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const track = stream.getAudioTracks()[0];
      base.trackSettings = track ? { ...track.getSettings() } : null;

      // 3. Does the resampling path engage — source node inherits ctx rate?
      const source = ctx.createMediaStreamSource(stream);
      base.sourceNodeContextRate = source.context.sampleRate;
      source.disconnect();

      base.ok = true;
    } catch (err) {
      base.error =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      await ctx?.close().catch(() => {});
      await defaultCtx?.close().catch(() => {});
      setReport(base);
      setRunning(false);
    }
  }

  async function copy() {
    if (report) {
      await navigator.clipboard
        .writeText(JSON.stringify(report, null, 2))
        .catch(() => {});
    }
  }

  return (
    <main style={{ padding: 16, fontFamily: "system-ui, sans-serif", maxWidth: 480 }}>
      <h1 style={{ fontSize: 18 }}>Slice 3 device diagnostic</h1>
      <p style={{ fontSize: 13, color: "#555" }}>
        Run this on the real Android phone (Vercel preview URL). Grant mic access
        when prompted.
      </p>
      <button
        type="button"
        onClick={run}
        disabled={running}
        style={{ fontSize: 16, padding: "12px 20px", minHeight: 44, width: "100%" }}
      >
        {running ? "Running…" : "Run diagnostic"}
      </button>

      {report && (
        <>
          <ul style={{ fontSize: 15, lineHeight: 1.6, marginTop: 16 }}>
            <li>
              <strong>Context honoured 16000?</strong>{" "}
              {report.contextHonoured === null
                ? "—"
                : report.contextHonoured
                  ? "YES"
                  : "NO"}
            </li>
            <li>
              <strong>Requested context rate:</strong> {report.requestedContextRate}
            </li>
            <li>
              <strong>Actual context rate:</strong>{" "}
              {report.actualContextRate ?? "—"}
            </li>
            <li>
              <strong>Default context rate (no request):</strong>{" "}
              {report.defaultContextRate ?? "—"}
            </li>
            <li>
              <strong>Source-node context rate:</strong>{" "}
              {report.sourceNodeContextRate ?? "—"}
            </li>
            {report.error && (
              <li style={{ color: "crimson" }}>
                <strong>Error:</strong> {report.error}
              </li>
            )}
          </ul>

          <p style={{ fontSize: 14, marginBottom: 4 }}>
            <strong>Track getSettings():</strong>
          </p>
          <pre
            style={{
              fontSize: 13,
              background: "#f4f4f4",
              padding: 8,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {JSON.stringify(report.trackSettings, null, 2)}
          </pre>

          <p style={{ fontSize: 12, color: "#777", wordBreak: "break-word" }}>
            UA: {report.userAgent}
          </p>

          <button
            type="button"
            onClick={copy}
            style={{ fontSize: 14, padding: "8px 16px", minHeight: 44 }}
          >
            Copy full JSON
          </button>
        </>
      )}
    </main>
  );
}
