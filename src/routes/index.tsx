import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Линиофон — рисуй линии, слышь музыку" },
      {
        name: "description",
        content:
          "Интерактивный холст: каждая нарисованная линия мгновенно звучит. Позиция задаёт ноту, длина — длительность, угол — тембр.",
      },
      { property: "og:title", content: "Линиофон — рисуй линии, слышь музыку" },
      {
        property: "og:description",
        content:
          "Рисуйте линии на холсте и слушайте, как они превращаются в музыку в реальном времени.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Line = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  hue: number;
  born: number;
  life: number;
};

const SCALE = [0, 2, 3, 5, 7, 9, 10, 12, 14, 15, 17, 19, 21, 22, 24];

function timbreFor(angleDeg: number): { type: OscillatorType; hue: number } {
  const a = ((angleDeg % 180) + 180) % 180;
  if (a < 45) return { type: "sine", hue: 190 };
  if (a < 90) return { type: "triangle", hue: 145 };
  if (a < 135) return { type: "sawtooth", hue: 35 };
  return { type: "square", hue: 320 };
}

function Index() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const linesRef = useRef<Line[]>([]);
  const drawingRef = useRef<{ x: number; y: number } | null>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const [count, setCount] = useState(0);
  const [last, setLast] = useState<string | null>(null);

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 0.35;
      const delay = ctx.createDelay(1.5);
      delay.delayTime.value = 0.28;
      const fb = ctx.createGain();
      fb.gain.value = 0.32;
      delay.connect(fb);
      fb.connect(delay);
      master.connect(ctx.destination);
      master.connect(delay);
      delay.connect(ctx.destination);
      audioRef.current = ctx;
      masterRef.current = master;
    }
    if (audioRef.current.state === "suspended") void audioRef.current.resume();
    return audioRef.current;
  }, []);

  const playLine = useCallback(
    (line: Line) => {
      const ctx = ensureAudio();
      const master = masterRef.current;
      if (!master) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const h = canvas.clientHeight;
      const w = canvas.clientWidth;
      const midY = (line.y1 + line.y2) / 2;
      const midX = (line.x1 + line.x2) / 2;
      const dx = line.x2 - line.x1;
      const dy = line.y2 - line.y1;
      const len = Math.hypot(dx, dy);
      const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
      const { type } = timbreFor(angle);

      const idx = Math.round((1 - midY / h) * (SCALE.length - 1));
      const semitone = SCALE[Math.max(0, Math.min(SCALE.length - 1, idx))];
      const freq = 174.61 * Math.pow(2, semitone / 12);
      const dur = Math.min(3.2, 0.14 + (len / Math.max(w, 1)) * 3);

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.linearRampToValueAtTime(
        freq * (1 + (dy < 0 ? 0.01 : -0.01)),
        now + dur,
      );

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(700 + Math.abs(angle) * 40, now);
      filter.Q.value = 4;

      const gain = ctx.createGain();
      const peak = 0.12 + Math.min(0.22, len / 1400);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, (midX / Math.max(w, 1)) * 2 - 1));

      osc.connect(filter).connect(gain).connect(pan).connect(master);
      osc.start(now);
      osc.stop(now + dur + 0.05);

      const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
      setLast(
        `${names[(3 + semitone) % 12]} · ${dur.toFixed(2)} с · ${type}`,
      );
      return { dur, hue: timbreFor(angle).hue };
    },
    [ensureAudio],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const render = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      // grid of pitch rows
      ctx.lineWidth = 1;
      for (let i = 0; i < SCALE.length; i++) {
        const y = (i / (SCALE.length - 1)) * h;
        ctx.strokeStyle = `oklch(0.32 0.03 265 / ${i % 7 === 0 ? 0.55 : 0.22})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const now = performance.now();
      linesRef.current = linesRef.current.filter(
        (l) => now - l.born < l.life + 1200,
      );

      for (const l of linesRef.current) {
        const age = (now - l.born) / (l.life + 1200);
        const alpha = Math.max(0, 1 - age);
        ctx.lineCap = "round";
        ctx.strokeStyle = `oklch(0.82 0.19 ${l.hue} / ${alpha})`;
        ctx.lineWidth = 3 + 9 * alpha;
        ctx.shadowBlur = 26 * alpha;
        ctx.shadowColor = `oklch(0.8 0.2 ${l.hue} / ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      const start = drawingRef.current;
      const cur = cursorRef.current;
      if (start && cur) {
        ctx.setLineDash([6, 8]);
        ctx.strokeStyle = "oklch(0.9 0.02 265 / 0.7)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(cur.x, cur.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    ensureAudio();
    const p = pos(e);
    drawingRef.current = p;
    cursorRef.current = p;
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    cursorRef.current = pos(e);
  };

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = drawingRef.current;
    if (!start) return;
    const end = pos(e);
    drawingRef.current = null;
    cursorRef.current = null;
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    if (dist < 6) return;
    const angle =
      (Math.atan2(-(end.y - start.y), end.x - start.x) * 180) / Math.PI;
    const { hue } = timbreFor(angle);
    const line: Line = {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      hue,
      born: performance.now(),
      life: 400,
    };
    const res = playLine(line);
    line.life = (res?.dur ?? 0.5) * 1000;
    linesRef.current.push(line);
    setCount((c) => c + 1);
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Линиофон</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Проведите линию по холсту — она зазвучит. Выше линия — выше нота,
              длиннее — дольше звук, угол меняет тембр.
            </p>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <div>Линий сыграно: {count}</div>
            <div className="font-mono">{last ?? "—"}</div>
          </div>
        </header>

        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className="h-[65vh] w-full touch-none rounded-xl border border-border bg-card shadow-lg"
          aria-label="Холст для рисования звучащих линий"
        />

        <footer className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span>0–45° — мягкая синусоида</span>
          <span>45–90° — треугольник</span>
          <span>90–135° — пила</span>
          <span>135–180° — квадрат</span>
        </footer>
      </div>
    </main>
  );
}
