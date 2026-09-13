import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Линиофон — рисуй линии, слышь музыку" },
      {
        name: "description",
        content:
          "Интерактивный холст: свободный рисунок мгновенно звучит. Позиция задаёт ноту, длина — длительность, угол — тембр. Запись в видеофайл.",
      },
      { property: "og:title", content: "Линиофон — рисуй линии, слышь музыку" },
      {
        property: "og:description",
        content:
          "Рисуйте свободные линии, слушайте музыку и сохраняйте результат видеофайлом.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Pt = { x: number; y: number };
type Stroke = { pts: Pt[]; hue: number };

const SCALE = [0, 2, 3, 5, 7, 9, 10, 12, 14, 15, 17, 19, 21, 22, 24];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function timbreFor(angleDeg: number): { type: OscillatorType; hue: number } {
  const a = ((angleDeg % 180) + 180) % 180;
  if (a < 45) return { type: "sine", hue: 190 };
  if (a < 90) return { type: "triangle", hue: 145 };
  if (a < 135) return { type: "sawtooth", hue: 35 };
  return { type: "square", hue: 320 };
}

function Index() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const lastSoundPtRef = useRef<Pt | null>(null);

  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const recDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [notes, setNotes] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("liniofon.mp4");
  const [notice, setNotice] = useState<string | null>(null);

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 0.3;
      const delay = ctx.createDelay(1.5);
      delay.delayTime.value = 0.26;
      const fb = ctx.createGain();
      fb.gain.value = 0.3;
      delay.connect(fb);
      fb.connect(delay);

      const recDest = ctx.createMediaStreamDestination();
      master.connect(ctx.destination);
      master.connect(recDest);
      master.connect(delay);
      delay.connect(ctx.destination);
      delay.connect(recDest);

      audioRef.current = ctx;
      masterRef.current = master;
      recDestRef.current = recDest;
    }
    if (audioRef.current.state === "suspended") void audioRef.current.resume();
    return audioRef.current;
  }, []);

  const playSegment = useCallback(
    (a: Pt, b: Pt) => {
      const ctx = ensureAudio();
      const master = masterRef.current;
      const canvas = canvasRef.current;
      if (!master || !canvas) return 190;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
      const { type, hue } = timbreFor(angle);

      const midY = (a.y + b.y) / 2;
      const idx = Math.round((1 - midY / h) * (SCALE.length - 1));
      const semitone = SCALE[Math.max(0, Math.min(SCALE.length - 1, idx))] ?? 0;
      const freq = 174.61 * Math.pow(2, semitone / 12);
      const dur = Math.min(2.4, 0.18 + (len / Math.max(w, 1)) * 3.2);

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(800 + Math.abs(angle) * 40, now);
      filter.Q.value = 3;

      const gain = ctx.createGain();
      const peak = 0.08 + Math.min(0.16, len / 1600);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(
        -1,
        Math.min(1, (((a.x + b.x) / 2) / Math.max(w, 1)) * 2 - 1),
      );

      osc.connect(filter).connect(gain).connect(pan).connect(master);
      osc.start(now);
      osc.stop(now + dur + 0.05);

      setLast(`${NOTE_NAMES[(3 + semitone) % 12]} · ${dur.toFixed(2)} с · ${type}`);
      setNotes((n) => n + 1);
      return hue;
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

    const drawStroke = (s: Stroke) => {
      if (s.pts.length < 2) return;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = `oklch(0.82 0.19 ${s.hue})`;
      ctx.lineWidth = 4;
      ctx.shadowBlur = 14;
      ctx.shadowColor = `oklch(0.8 0.2 ${s.hue} / 0.7)`;
      ctx.beginPath();
      const first = s.pts[0]!;
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < s.pts.length; i++) {
        const p = s.pts[i]!;
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    const render = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.fillStyle = "oklch(0.19 0.03 265)";
      ctx.fillRect(0, 0, w, h);

      ctx.lineWidth = 1;
      for (let i = 0; i < SCALE.length; i++) {
        const y = (i / (SCALE.length - 1)) * h;
        ctx.strokeStyle = `oklch(0.35 0.03 265 / ${i % 7 === 0 ? 0.6 : 0.25})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      for (const s of strokesRef.current) drawStroke(s);
      if (currentRef.current) drawStroke(currentRef.current);

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    ensureAudio();
    const p = pos(e);
    currentRef.current = { pts: [p], hue: 190 };
    lastSoundPtRef.current = p;
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cur = currentRef.current;
    if (!cur) return;
    const p = pos(e);
    cur.pts.push(p);
    const anchor = lastSoundPtRef.current;
    if (anchor && Math.hypot(p.x - anchor.x, p.y - anchor.y) > 42) {
      cur.hue = playSegment(anchor, p);
      lastSoundPtRef.current = p;
    }
  };

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cur = currentRef.current;
    if (!cur) return;
    const p = pos(e);
    cur.pts.push(p);
    const anchor = lastSoundPtRef.current;
    if (anchor && Math.hypot(p.x - anchor.x, p.y - anchor.y) > 6) {
      cur.hue = playSegment(anchor, p);
    }
    if (cur.pts.length > 1) strokesRef.current.push(cur);
    currentRef.current = null;
    lastSoundPtRef.current = null;
  };

  const clear = () => {
    strokesRef.current = [];
    currentRef.current = null;
    setNotes(0);
    setLast(null);
  };

  const pickMime = () => {
    const candidates = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm",
    ];
    for (const m of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m))
        return m;
    }
    return "";
  };

  const startRecording = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    ensureAudio();
    const recDest = recDestRef.current;
    if (!recDest) return;

    const stream = canvas.captureStream(60);
    for (const track of recDest.stream.getAudioTracks()) stream.addTrack(track);

    const mimeType = pickMime();
    if (!mimeType) {
      setNotice("Ваш браузер не умеет записывать видео с холста.");
      return;
    }
    const isMp4 = mimeType.startsWith("video/mp4");
    setNotice(
      isMp4
        ? null
        : "Браузер не поддерживает MP4-запись — файл сохранится в формате WEBM (открывается везде и легко конвертируется).",
    );
    setFileName(isMp4 ? "liniofon.mp4" : "liniofon.webm");

    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    chunksRef.current = [];
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      setFileUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      setRecording(false);
    };
    recorderRef.current = rec;
    rec.start(200);
    setRecording(true);
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    };
  }, [fileUrl]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Линиофон</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Рисуйте свободные линии — они звучат и остаются на холсте. Выше
              линия — выше нота, длиннее штрих — дольше звук, наклон меняет тембр.
            </p>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <div>Нот сыграно: {notes}</div>
            <div className="font-mono">{last ?? "—"}</div>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          {recording ? (
            <button
              onClick={stopRecording}
              className="inline-flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90"
            >
              <span className="size-2 animate-pulse rounded-full bg-current" />
              Остановить запись
            </button>
          ) : (
            <button
              onClick={startRecording}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Записать видео
            </button>
          )}
          <button
            onClick={clear}
            className="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-card-foreground transition-colors hover:bg-accent"
          >
            Очистить холст
          </button>
          {fileUrl && !recording && (
            <a
              href={fileUrl}
              download={fileName}
              className="rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
            >
              Скачать {fileName}
            </a>
          )}
        </div>

        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className="h-[62vh] w-full touch-none rounded-xl border border-border shadow-lg"
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
