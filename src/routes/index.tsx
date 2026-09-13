import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Линиофон — рисуй линии, слышь музыку" },
      { name: "description", content: "Интерактивный холст: свободный рисунок звучит зацикленно, точки можно перетаскивать и менять ноту, длительность и тембр. Запись видео и аудио." },
      { property: "og:title", content: "Линиофон — рисуй линии, слышь музыку" },
      { property: "og:description", content: "Рисуйте линии, перетаскивайте точки для настройки звука и сохраняйте результат видео- или аудиофайлом." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Pt = { x: number; y: number };
type NotePt = { pi: number; x: number; y: number; angle: number; len: number };
type Stroke = { pts: Pt[]; hue: number; notes: NotePt[] };

const SCALE = [0, 2, 3, 5, 7, 9, 10, 12, 14, 15, 17, 19, 21, 22, 24];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_SPACING = 38;
const HANDLE_R = 9;

function timbreFor(angleDeg: number): { type: OscillatorType; hue: number } {
  const a = ((angleDeg % 180) + 180) % 180;
  if (a < 45) return { type: "sine", hue: 190 };
  if (a < 90) return { type: "triangle", hue: 145 };
  if (a < 135) return { type: "sawtooth", hue: 35 };
  return { type: "square", hue: 320 };
}

function refreshNotes(s: Stroke) {
  let prevIdx = 0;
  for (const n of s.notes) {
    const p = s.pts[n.pi];
    if (!p) continue;
    n.x = p.x;
    n.y = p.y;
    let len = 0;
    for (let i = prevIdx + 1; i <= n.pi; i++) {
      const a = s.pts[i - 1]!;
      const b = s.pts[i]!;
      len += Math.hypot(b.x - a.x, b.y - a.y);
    }
    n.len = Math.max(8, len);
    const a = s.pts[Math.max(0, n.pi - 1)]!;
    n.angle = (Math.atan2(-(p.y - a.y), p.x - a.x) * 180) / Math.PI;
    prevIdx = n.pi;
  }
}

function buildNotes(pts: Pt[]): NotePt[] {
  const notes: NotePt[] = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    acc += Math.hypot(b.x - a.x, b.y - a.y);
    if (acc >= NOTE_SPACING || i === pts.length - 1) {
      notes.push({
        pi: i,
        x: b.x,
        y: b.y,
        angle: (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI,
        len: acc,
      });
      acc = 0;
    }
  }
  return notes;
}

function Index() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const lastSoundPtRef = useRef<Pt | null>(null);
  const playheadRef = useRef(0);
  const playingRef = useRef(true);
  const loopSecRef = useRef(6);
  const modeRef = useRef<"draw" | "edit">("draw");
  const flashRef = useRef<Map<string, number>>(new Map());
  const dragRef = useRef<{ si: number; ni: number } | null>(null);
  const hoverRef = useRef<{ si: number; ni: number } | null>(null);

  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const recDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const videoRecRef = useRef<MediaRecorder | null>(null);
  const audioRecRef = useRef<MediaRecorder | null>(null);

  // Состояние для изображения и sonification
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [imageSonification, setImageSonification] = useState(false);
  const lastSonifyXRef = useRef(-1);

  const [mode, setMode] = useState<"draw" | "edit">("draw");
  const [playing, setPlaying] = useState(true);
  const [loopSec, setLoopSec] = useState(6);
  const [last, setLast] = useState<string | null>(null);
  const [strokeCount, setStrokeCount] = useState(0);
  const [recVideo, setRecVideo] = useState(false);
  const [recAudio, setRecAudio] = useState(false);
  const [videoFile, setVideoFile] = useState<{ url: string; name: string } | null>(null);
  const [audioFile, setAudioFile] = useState<{ url: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { loopSecRef.current = loopSec; }, [loopSec]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 0.28;
      const delay = ctx.createDelay(1.5);
      delay.delayTime.value = 0.26;
      const fb = ctx.createGain();
      fb.gain.value = 0.28;
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

  const playNote = useCallback(
    (n: Omit<NotePt, "pi">, silentLabel = false) => {
      const ctx = ensureAudio();
      const master = masterRef.current;
      const canvas = canvasRef.current;
      if (!master || !canvas) return 190;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const { type, hue } = timbreFor(n.angle);
      const idx = Math.round((1 - n.y / h) * (SCALE.length - 1));
      const semitone = SCALE[Math.max(0, Math.min(SCALE.length - 1, idx))] ?? 0;
      const freq = 174.61 * Math.pow(2, semitone / 12);
      const dur = Math.min(2.2, 0.18 + (n.len / Math.max(w, 1)) * 3.2);
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(800 + Math.abs(n.angle) * 40, now);
      filter.Q.value = 3;

      const gain = ctx.createGain();
      const peak = 0.07 + Math.min(0.13, n.len / 1600);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, (n.x / Math.max(w, 1)) * 2 - 1));

      osc.connect(filter).connect(gain).connect(pan).connect(master);
      osc.start(now);
      osc.stop(now + dur + 0.05);

      if (!silentLabel)
        setLast(`${NOTE_NAMES[(3 + semitone) % 12]} · ${dur.toFixed(2)} с · ${type}`);
      return hue;
    },
    [ensureAudio],
  );

  // Sonification: озвучивание столбца пикселей изображения
  const sonifyColumn = useCallback(
    (canvasX: number) => {
      if (!bgImage || !imageSonification) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      // Создаём offscreen canvas для чтения пикселей
      const offCanvas = document.createElement("canvas");
      offCanvas.width = w;
      offCanvas.height = h;
      const offCtx = offCanvas.getContext("2d")!;
      offCtx.drawImage(bgImage, 0, 0, w, h);

      const imgData = offCtx.getImageData(canvasX, 0, 1, h);
      const data = imgData.data;

      const audioCtx = ensureAudio();
      const master = masterRef.current;
      if (!master) return;

      const BANDS = 6; // 6 голосов
      const bandHeight = Math.floor(h / BANDS);
      const now = audioCtx.currentTime;
      const dur = 0.12;

      for (let b = 0; b < BANDS; b++) {
        let totalBrightness = 0;
        let totalR = 0, totalG = 0, totalB = 0;
        let pixelCount = 0;

        for (let y = b * bandHeight; y < (b + 1) * bandHeight && y < h; y++) {
          const idx = y * 4;
          const r = data[idx]!;
          const g = data[idx + 1]!;
          const bl = data[idx + 2]!;
          const alpha = data[idx + 3]!;
          
          if (alpha < 30) continue; // пропускаем прозрачные
          
          const brightness = (r + g + bl) / 3;
          totalBrightness += brightness;
          totalR += r;
          totalG += g;
          totalB += bl;
          pixelCount++;
        }

        if (pixelCount === 0) continue;

        const avgBrightness = totalBrightness / pixelCount;
        const avgR = totalR / pixelCount;
        const avgG = totalG / pixelCount;
        const avgB = totalB / pixelCount;

        // Пропускаем очень тёмные пиксели
        if (avgBrightness < 20) continue;

        // Маппинг яркости на ноту
        const noteIdx = Math.round((1 - avgBrightness / 255) * (SCALE.length - 1));
        const semitone = SCALE[Math.max(0, Math.min(SCALE.length - 1, noteIdx))] ?? 0;
        const freq = 130.81 * Math.pow(2, semitone / 12);

        // Громкость от яркости
        const vol = (avgBrightness / 255) * 0.08;

        // Тембр от доминирующего цвета
        let oscType: OscillatorType = "sine";
        if (avgR > avgG && avgR > avgB) oscType = "sawtooth";
        else if (avgG > avgR && avgG > avgB) oscType = "triangle";
        else if (avgB > avgR && avgB > avgG) oscType = "square";

        const osc = audioCtx.createOscillator();
        osc.type = oscType;
        osc.frequency.setValueAtTime(freq, now);

        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(vol, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

        const pan = audioCtx.createStereoPanner();
        pan.pan.value = (b / BANDS) * 2 - 1;

        osc.connect(gain).connect(pan).connect(master);
        osc.start(now);
        osc.stop(now + dur + 0.05);
      }
    },
    [bgImage, imageSonification, ensureAudio],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let prevTime = performance.now();

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

    const render = (time: number) => {
      const dt = Math.min(0.1, (time - prevTime) / 1000);
      prevTime = time;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      // Фон: изображение или тёмный цвет
      if (bgImage) {
        ctx.drawImage(bgImage, 0, 0, w, h);
        ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
        ctx.fillRect(0, 0, w, h);
      } else {
        ctx.fillStyle = "oklch(0.19 0.03 265)";
        ctx.fillRect(0, 0, w, h);
      }

      ctx.lineWidth = 1;
      for (let i = 0; i < SCALE.length; i++) {
        const y = (i / (SCALE.length - 1)) * h;
        ctx.strokeStyle = `oklch(0.35 0.03 265 / ${i % 7 === 0 ? 0.6 : 0.25})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const prevX = playheadRef.current;
      let x = prevX;
      if (playingRef.current) {
        x = prevX + (w / loopSecRef.current) * dt;
        if (x >= w) x -= w;
      }
      playheadRef.current = x;

      if (playingRef.current) {
        const wrapped = x < prevX;
        
        // Воспроизведение линий
        for (let si = 0; si < strokesRef.current.length; si++) {
          const s = strokesRef.current[si]!;
          for (let ni = 0; ni < s.notes.length; ni++) {
            const n = s.notes[ni]!;
            const hit = wrapped ? n.x >= prevX || n.x < x : n.x >= prevX && n.x < x;
            if (hit) {
              playNote(n, true);
              flashRef.current.set(`${si}:${ni}`, time);
            }
          }
        }

        // Sonification изображения
        if (imageSonification && bgImage) {
          const currentX = Math.floor(x);
          if (currentX !== lastSonifyXRef.current && currentX % 3 === 0) {
            sonifyColumn(currentX);
            lastSonifyXRef.current = currentX;
          }
        }
      }

      for (const s of strokesRef.current) drawStroke(s);
      if (currentRef.current) drawStroke(currentRef.current);

      for (const [key, t] of flashRef.current) {
        const age = (time - t) / 450;
        if (age >= 1) {
          flashRef.current.delete(key);
          continue;
        }
        const [siStr, niStr] = key.split(":");
        const s = strokesRef.current[Number(siStr)];
        const n = s?.notes[Number(niStr)];
        if (!n) continue;
        ctx.fillStyle = `oklch(0.95 0.15 ${s!.hue} / ${1 - age})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, 4 + 14 * age, 0, Math.PI * 2);
        ctx.fill();
      }

      if (modeRef.current === "edit") {
        for (let si = 0; si < strokesRef.current.length; si++) {
          const s = strokesRef.current[si]!;
          for (let ni = 0; ni < s.notes.length; ni++) {
            const n = s.notes[ni]!;
            const active =
              (dragRef.current?.si === si && dragRef.current?.ni === ni) ||
              (hoverRef.current?.si === si && hoverRef.current?.ni === ni);
            ctx.beginPath();
            ctx.arc(n.x, n.y, active ? HANDLE_R + 3 : HANDLE_R, 0, Math.PI * 2);
            ctx.fillStyle = active
              ? "oklch(0.95 0.02 265 / 0.95)"
              : "oklch(0.25 0.03 265 / 0.9)";
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = `oklch(0.85 0.18 ${timbreFor(n.angle).hue})`;
            ctx.stroke();
          }
        }
      }

      ctx.strokeStyle = "oklch(0.95 0.02 265 / 0.75)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [playNote, bgImage, imageSonification, sonifyColumn]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const findHandle = (p: Pt) => {
    for (let si = strokesRef.current.length - 1; si >= 0; si--) {
      const s = strokesRef.current[si]!;
      for (let ni = 0; ni < s.notes.length; ni++) {
        const n = s.notes[ni]!;
        if (Math.hypot(p.x - n.x, p.y - n.y) <= HANDLE_R + 6) return { si, ni };
      }
    }
    return null;
  };

  const describe = (n: NotePt) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const h = canvas.clientHeight;
    const w = canvas.clientWidth;
    const idx = Math.round((1 - n.y / h) * (SCALE.length - 1));
    const semitone = SCALE[Math.max(0, Math.min(SCALE.length - 1, idx))] ?? 0;
    const dur = Math.min(2.2, 0.18 + (n.len / Math.max(w, 1)) * 3.2);
    setLast(
      `${NOTE_NAMES[(3 + semitone) % 12]} · ${dur.toFixed(2)} с · ${timbreFor(n.angle).type}`,
    );
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    ensureAudio();
    const p = pos(e);

    if (mode === "edit") {
      const hit = findHandle(p);
      dragRef.current = hit;
      if (hit) {
        const n = strokesRef.current[hit.si]!.notes[hit.ni]!;
        describe(n);
        playNote(n);
      }
      return;
    }

    currentRef.current = { pts: [p], hue: 190, notes: [] };
    lastSoundPtRef.current = p;
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pos(e);

    if (mode === "edit") {
      const drag = dragRef.current;
      if (!drag) {
        hoverRef.current = findHandle(p);
        return;
      }
      const s = strokesRef.current[drag.si];
      const n = s?.notes[drag.ni];
      if (!s || !n) return;
      const anchor = s.pts[n.pi]!;
      const dx = p.x - anchor.x;
      const dy = p.y - anchor.y;
      const span = 6;
      for (let i = -span; i <= span; i++) {
        const pt = s.pts[n.pi + i];
        if (!pt) continue;
        const f = 1 - Math.abs(i) / (span + 1);
        pt.x += dx * f;
        pt.y += dy * f;
      }
      refreshNotes(s);
      s.hue = timbreFor(n.angle).hue;
      describe(n);
      return;
    }

    const cur = currentRef.current;
    if (!cur) return;
    cur.pts.push(p);
    const anchor = lastSoundPtRef.current;
    if (anchor && Math.hypot(p.x - anchor.x, p.y - anchor.y) > NOTE_SPACING) {
      cur.hue = playNote({
        x: p.x,
        y: p.y,
        angle: (Math.atan2(-(p.y - anchor.y), p.x - anchor.x) * 180) / Math.PI,
        len: Math.hypot(p.x - anchor.x, p.y - anchor.y),
      });
      lastSoundPtRef.current = p;
    }
  };

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === "edit") {
      const drag = dragRef.current;
      if (drag) {
        const n = strokesRef.current[drag.si]?.notes[drag.ni];
        if (n) playNote(n);
      }
      dragRef.current = null;
      return;
    }

    const cur = currentRef.current;
    if (!cur) return;
    cur.pts.push(pos(e));
    if (cur.pts.length > 2) {
      cur.notes = buildNotes(cur.pts);
      strokesRef.current.push(cur);
      setStrokeCount(strokesRef.current.length);
    }
    currentRef.current = null;
    lastSoundPtRef.current = null;
  };

  const clear = () => {
    strokesRef.current = [];
    currentRef.current = null;
    flashRef.current.clear();
    dragRef.current = null;
    hoverRef.current = null;
    setStrokeCount(0);
    setLast(null);
  };

  // Загрузка изображения
  const handleImageLoad = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      setBgImage(img);
      setImageSonification(true);
      setNotice("Изображение загружено. Sonification включен.");
    };
    img.onerror = () => {
      setNotice("Ошибка загрузки изображения");
    };
    img.src = URL.createObjectURL(file);
  };

  const removeImage = () => {
    setBgImage(null);
    setImageSonification(false);
    setNotice(null);
  };

  const pick = (candidates: string[]) => {
    for (const m of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m))
        return m;
    }
    return "";
  };

  const startVideo = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    ensureAudio();
    const recDest = recDestRef.current;
    if (!recDest) return;

    const mimeType = pick([
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm",
    ]);
    if (!mimeType) {
      setNotice("Браузер не умеет записывать видео с холста.");
      return;
    }
    const isMp4 = mimeType.startsWith("video/mp4");
    setNotice(
      isMp4 ? null : "Браузер не поддерживает MP4 — видео сохранится в формате WEBM.",
    );

    const stream = canvas.captureStream(60);
    for (const t of recDest.stream.getAudioTracks()) stream.addTrack(t);
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (ev) => ev.data.size > 0 && chunks.push(ev.data);
    rec.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
      setVideoFile((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url, name: isMp4 ? "liniofon.mp4" : "liniofon.webm" };
      });
      setRecVideo(false);
    };
    videoRecRef.current = rec;
    rec.start(200);
    setRecVideo(true);
  };

  const startAudio = () => {
    ensureAudio();
    const recDest = recDestRef.current;
    if (!recDest) return;

    const mimeType = pick([
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ]);
    if (!mimeType) {
      setNotice("Браузер не умеет записывать звук.");
      return;
    }
    const ext = mimeType.startsWith("audio/mp4")
      ? "m4a"
      : mimeType.startsWith("audio/ogg")
        ? "ogg"
        : "webm";

    const rec = new MediaRecorder(recDest.stream, { mimeType });
    const chunks: Blob[] = [];
    rec.ondataavailable = (ev) => ev.data.size > 0 && chunks.push(ev.data);
    rec.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
      setAudioFile((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url, name: `liniofon.${ext}` };
      });
      setRecAudio(false);
    };
    audioRecRef.current = rec;
    rec.start(200);
    setRecAudio(true);
  };

  const stopVideo = () => {
    videoRecRef.current?.stop();
    videoRecRef.current = null;
  };
  const stopAudio = () => {
    audioRecRef.current?.stop();
    audioRecRef.current = null;
  };

  const btn =
    "rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-card-foreground transition-colors hover:bg-accent";
  const btnPrimary =
    "rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90";
  const btnStop =
    "inline-flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Линиофон</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Рисуйте свободные линии — они остаются на холсте и звучат по кругу.
              В режиме настройки перетаскивайте точки: вверх-вниз меняет ноту,
              вбок — момент и длительность, наклон — тембр.
            </p>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <div>Линий: {strokeCount}</div>
            <div className="font-mono">{last ?? "—"}</div>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            <button
              onClick={() => setMode("draw")}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                mode === "draw"
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-card-foreground hover:bg-accent"
              }`}
            >
              Рисование
            </button>
            <button
              onClick={() => setMode("edit")}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                mode === "edit"
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-card-foreground hover:bg-accent"
              }`}
            >
              Настройка звука
            </button>
          </div>
          <button
            onClick={() => {
              ensureAudio();
              setPlaying((p) => !p);
            }}
            className={btnPrimary}
          >
            {playing ? "Пауза" : "Играть"}
          </button>
          <label className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
            <span className="text-muted-foreground">Круг</span>
            <input
              type="range"
              min={2}
              max={16}
              step={1}
              value={loopSec}
              onChange={(e) => setLoopSec(Number(e.target.value))}
            />
            <span className="w-8 font-mono">{loopSec}с</span>
          </label>
          
          {/* Кнопки для изображения */}
          <label className={btn}>
            📷 Загрузить изображение
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageLoad}
            />
          </label>
          {bgImage && (
            <button
              onClick={() => setImageSonification(!imageSonification)}
              className={imageSonification ? btnPrimary : btn}
            >
              {imageSonification ? "🔊 Звук ВКЛ" : "🔇 Звук ВЫКЛ"}
            </button>
          )}
          {bgImage && (
            <button onClick={removeImage} className={btn}>
              Убрать изображение
            </button>
          )}

          <button
            onClick={recVideo ? stopVideo : startVideo}
            className={recVideo ? btnStop : btn}
          >
            {recVideo ? (
              <>
                <span className="size-2 animate-pulse rounded-full bg-current" />
                Стоп видео
              </>
            ) : (
              "Записать видео"
            )}
          </button>
          <button
            onClick={recAudio ? stopAudio : startAudio}
            className={recAudio ? btnStop : btn}
          >
            {recAudio ? (
              <>
                <span className="size-2 animate-pulse rounded-full bg-current" />
                Стоп аудио
              </>
            ) : (
              "Записать аудио"
            )}
          </button>
          <button onClick={clear} className={btn}>
            Очистить холст
          </button>
          {videoFile && !recVideo && (
            <a href={videoFile.url} download={videoFile.name} className={btn}>
              Скачать {videoFile.name}
            </a>
          )}
          {audioFile && !recAudio && (
            <a href={audioFile.url} download={audioFile.name} className={btn}>
              Скачать {audioFile.name}
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
          className={`h-[62vh] w-full touch-none rounded-xl border border-border shadow-lg ${
            mode === "edit" ? "cursor-grab" : "cursor-crosshair"
          }`}
          aria-label="Холст для рисования звучащих линий"
        />

        <footer className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span>0–45° — мягкая синусоида</span>
          <span>45–90° — треугольник</span>
          <span>90–135° — пила</span>
          <span>135–180° — квадрат</span>
          {bgImage && <span>🎨 Изображение загружено</span>}
        </footer>
      </div>
    </main>
  );
}
