let ctx: AudioContext | undefined;

/** Short, quiet two-tone chime. Webview-safe (no assets, no network). */
export function chime(kind: "done" | "attention"): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const notes =
      kind === "done"
        ? [
            [523.25, 0], // C5
            [783.99, 0.12], // G5
          ]
        : [
            [659.25, 0], // E5
            [659.25, 0.16], // repeat
          ];
    for (const [freq, offset] of notes as Array<[number, number]>) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + offset);
      gain.gain.linearRampToValueAtTime(0.06, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.25);
    }
  } catch {
    /* audio unavailable — silence is fine */
  }
}
