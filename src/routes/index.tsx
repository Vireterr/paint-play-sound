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
type OscType = "sine" | "triangle" | "sawtooth" | "square" | "pulse" | "noise";
type ImageFeature = "brightness" | "hue" | "saturation" | "edges" | "texture";
type SoundParameter = "pitch" | "volume" | "timbre" | "duration";
type SonificationMappings = Record<ImageFeature, Record<SoundParameter, number>>;

type SoundPreset = {
  id: string;
  name: string;
  hue: number;
  oscType: OscType;
  pulseWidth: number;
  filterFreq: number;
  filterQ: number;
  distortion: number;
  bitcrusher: number;
  delayTime: number;
  delayFeedback: number;
  volume: number;
};

type SonificationSettings = {
  bands: number;
  baseOctave: number; // 2-5 (C2-C5)
  oscType: OscType | "auto";
  volume: number;
  scanStep: number; // каждые N пикселей
  filterFreq: number;
  filterQ: number;
  delayTime: number;
  delayFeedback: number;
  minBrightness: number;
  detail: number; // 0..1 — количество текстуры/шума от мелких деталей
  contrast: number; // 0.5..3 — контраст яркости → громкость
  mappings: SonificationMappings;
};

type Stroke = {
  pts: Pt[];
  presetId: string;
  notes: NotePt[];
};

const SCALE = [0, 2, 3, 5, 7, 9, 10, 12, 14, 15, 17, 19, 21, 22, 24];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_SPACING = 38;
const HANDLE_R = 9;
const PIXEL_SIZE = 5;

const DEFAULT_MAPPINGS: SonificationMappings = {
  brightness: { pitch: 0, volume: 1, timbre: 0.5, duration: 0 },
  hue: { pitch: 0, volume: 0, timbre: 0.2, duration: 0 },
  saturation: { pitch: 0, volume: 0, timbre: 0.3, duration: 0 },
  edges: { pitch: 0, volume: 0, timbre: 0.15, duration: 0 },
  texture: { pitch: 0, volume: 0, timbre: 0.15, duration: 0 },
};

const IMAGE_FEATURES: { key: ImageFeature; label: string }[] = [
  { key: "brightness", label: "Яркость" },
  { key: "hue", label: "Оттенок" },
  { key: "saturation", label: "Насыщенность" },
  { key: "edges", label: "Края" },
  { key: "texture", label: "Текстура" },
];

const SOUND_PARAMETERS: { key: SoundParameter; label: string }[] = [
  { key: "pitch", label: "Высота" },
  { key: "volume", label: "Громкость" },
  { key: "timbre", label: "Тембр" },
  { key: "duration", label: "Длительность" },
];

const DEFAULT_PRESETS: SoundPreset[] = [
  { id: "sega-lead", name: "SEGA Lead", hue: 0, oscType: "sawtooth", pulseWidth: 0.5, filterFreq: 2600, filterQ: 1.2, distortion: 6, bitcrusher: 0, delayTime: 0.12, delayFeedback: 0.18, volume: 0.22 },
  { id: "nes-square", name: "NES Square", hue: 210, oscType: "square", pulseWidth: 0.5, filterFreq: 2200, filterQ: 0.8, distortion: 0, bitcrusher: 0, delayTime: 0, delayFeedback: 0, volume: 0.2 },
  { id: "gameboy-arp", name: "Game Boy Arp", hue: 120, oscType: "triangle", pulseWidth: 0.5, filterFreq: 3000, filterQ: 0.7, distortion: 0, bitcrusher: 0, delayTime: 0.16, delayFeedback: 0.25, volume: 0.26 },
  { id: "chiptune-bass", name: "Chiptune Bass", hue: 280, oscType: "square", pulseWidth: 0.3, filterFreq: 700, filterQ: 2, distortion: 4, bitcrusher: 0, delayTime: 0.05, delayFeedback: 0.1, volume: 0.24 },
  { id: "8bit-noise", name: "8-bit Noise", hue: 50, oscType: "noise", pulseWidth: 0.5, filterFreq: 2400, filterQ: 0.7, distortion: 0, bitcrusher: 6, delayTime: 0, delayFeedback: 0, volume: 0.14 },
  { id: "pulse-wave", name: "Pulse Wave", hue: 170, oscType: "pulse", pulseWidth: 0.35, filterFreq: 1800, filterQ: 1, distortion: 3, bitcrusher: 0, delayTime: 0.2, delayFeedback: 0.22, volume: 0.2 },
];

const DEFAULT_SONIFICATION: SonificationSettings = {
  bands: 6,
  baseOctave: 3,
  oscType: "auto",
  volume: 0.08,
  scanStep: 3,
  filterFreq: 2000,
  filterQ: 2,
  delayTime: 0,
  delayFeedback: 0,
  minBrightness: 20,
  detail: 0.35,
  contrast: 1.4,
  mappings: DEFAULT_MAPPINGS,
};

// Мягкое насыщение (tanh) с нормализацией — вместо резкого клиппинга
function makeDistortionCurve(amount: number) {
  const drive = 1 + Math.max(0, Math.min(100, amount)) * 0.25;
  const n = 2048;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

// Биткрашер: ступенчатая кривая квантования (0 = выкл, 1..8 бит)
function makeBitcrushCurve(bits: number) {
  const b = Math.max(1, Math.min(8, Math.round(bits)));
  const levels = Math.pow(2, b);
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  return curve;
}

function createPulseWave(ctx: AudioContext, pulseWidth: number): PeriodicWave {
  const real = new Float32Array(64);
  const imag = new Float32Array(64);
  for (let n = 1; n < 64; n++) {
    imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * pulseWidth);
  }
  return ctx.createPeriodicWave(real, imag);
}

function createNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const bufferSize = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
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
        pi: i, x: b.x, y: b.y,
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
  const noiseBufferRef = useRef<AudioBuffer | null>(null);

  const [presets, setPresets] = useState<SoundPreset[]>(DEFAULT_PRESETS);
  const [currentPresetId, setCurrentPresetId] = useState(DEFAULT_PRESETS[0]!.id);
  const [showSettings, setShowSettings] = useState(false);

  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [imageSonification, setImageSonification] = useState(false);
  const [sonSettings, setSonSettings] = useState<SonificationSettings>(DEFAULT_SONIFICATION);
  const [showSonSettings, setShowSonSettings] = useState(false);

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

  const presetsRef = useRef(presets);
  useEffect(() => { presetsRef.current = presets; }, [presets]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { loopSecRef.current = loopSec; }, [loopSec]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const sonSettingsRef = useRef(sonSettings);
  useEffect(() => { sonSettingsRef.current = sonSettings; }, [sonSettings]);

  const currentPreset = presets.find(p => p.id === currentPresetId) ?? presets[0] ?? DEFAULT_PRESETS[0]!;

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 0.5;
      // Лимитер на выходе — защита от перегруза и «пердящего» клиппинга
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      const recDest = ctx.createMediaStreamDestination();
      master.connect(limiter);
      limiter.connect(ctx.destination);
      limiter.connect(recDest);
      audioRef.current = ctx;
      masterRef.current = master;
      recDestRef.current = recDest;
      noiseBufferRef.current = createNoiseBuffer(ctx);
    }
    if (audioRef.current.state === "suspended") void audioRef.current.resume();
    return audioRef.current;
  }, []);

  const playNote = useCallback(
    (n: Omit<NotePt, "pi">, preset: SoundPreset, silentLabel = false) => {
      const ctx = ensureAudio();
      const master = masterRef.current;
      const canvas = canvasRef.current;
      if (!master || !canvas) return;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const idx = Math.round((1 - n.y / h) * (SCALE.length - 1));
      const semitone = SCALE[Math.max(0, Math.min(SCALE.length - 1, idx))] ?? 0;
      const freq = 174.61 * Math.pow(2, semitone / 12);
      const dur = Math.min(2.2, 0.18 + (n.len / Math.max(w, 1)) * 3.2);
      const now = ctx.currentTime;

      const tail = dur + 0.12;
      let sourceNode: AudioNode;
      let stopper: (() => void) | null = null;
      if (preset.oscType === "noise") {
        const noise = ctx.createBufferSource();
        noise.buffer = noiseBufferRef.current!;
        noise.loop = true;
        sourceNode = noise;
        noise.start(now);
        noise.stop(now + tail);
        stopper = () => { try { noise.stop(); } catch { /* noop */ } };
      } else if (preset.oscType === "pulse") {
        const osc = ctx.createOscillator();
        osc.setPeriodicWave(createPulseWave(ctx, preset.pulseWidth));
        osc.frequency.setValueAtTime(freq, now);
        sourceNode = osc;
        osc.start(now);
        osc.stop(now + tail);
        stopper = () => { try { osc.stop(); } catch { /* noop */ } };
      } else {
        const osc = ctx.createOscillator();
        osc.type = preset.oscType as OscillatorType;
        osc.frequency.setValueAtTime(freq, now);
        sourceNode = osc;
        osc.start(now);
        osc.stop(now + tail);
        stopper = () => { try { osc.stop(); } catch { /* noop */ } };
      }
      void stopper;

      // Предусиление перед насыщением — контролируемый «драйв», а не клиппинг
      const drive = ctx.createGain();
      drive.gain.value = preset.distortion > 0 ? 1 + preset.distortion * 0.06 : 1;

      const shaper = ctx.createWaveShaper();
      if (preset.distortion > 0) {
        shaper.curve = makeDistortionCurve(preset.distortion);
        shaper.oversample = "4x";
      }
      const crusher = ctx.createWaveShaper();
      if (preset.bitcrusher > 0) {
        crusher.curve = makeBitcrushCurve(preset.bitcrusher);
        crusher.oversample = "2x";
      }
      // Компенсация громкости после насыщения
      const postGain = ctx.createGain();
      postGain.gain.value = preset.distortion > 0 ? 1 / (1 + preset.distortion * 0.05) : 1;

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(Math.max(freq * 1.5, Math.min(16000, preset.filterFreq)), now);
      filter.Q.value = Math.min(8, Math.max(0.0001, preset.filterQ));
      // Убираем «пердёж» — срезаем нижний гул
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 45;

      const gain = ctx.createGain();
      const peak = Math.min(0.5, preset.volume * (0.5 + Math.min(0.5, n.len / 1600)));
      const attack = 0.012;
      const decayEnd = now + dur;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), now + attack);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak * 0.6), now + attack + dur * 0.35);
      gain.gain.exponentialRampToValueAtTime(0.0001, decayEnd);
      gain.gain.setValueAtTime(0, decayEnd + 0.001);

      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, (n.x / Math.max(w, 1)) * 2 - 1));

      // Цепочка: источник → драйв → сатурация → биткраш → фильтры → огибающая → панорама
      sourceNode.connect(drive);
      let node: AudioNode = drive;
      if (preset.distortion > 0) { node.connect(shaper); node = shaper; }
      if (preset.bitcrusher > 0) { node.connect(crusher); node = crusher; }
      node.connect(postGain);
      postGain.connect(filter);
      filter.connect(hp);
      hp.connect(gain);
      gain.connect(pan);
      pan.connect(master);

      let delayNode: DelayNode | null = null;
      let wet: GainNode | null = null;
      if (preset.delayTime > 0 && preset.delayFeedback > 0) {
        delayNode = ctx.createDelay(1.5);
        delayNode.delayTime.value = Math.min(1.2, preset.delayTime);
        const fb = ctx.createGain();
        fb.gain.value = Math.min(0.55, preset.delayFeedback);
        // Демпфирование повторов, чтобы эхо не превращалось в кашу
        const damp = ctx.createBiquadFilter();
        damp.type = "lowpass";
        damp.frequency.value = 2500;
        wet = ctx.createGain();
        wet.gain.value = 0.3;
        gain.connect(delayNode);
        delayNode.connect(damp);
        damp.connect(fb);
        fb.connect(delayNode);
        delayNode.connect(wet);
        wet.connect(master);
      }

      // Освобождаем узлы — иначе эхо и фильтры копятся и превращаются в грязь
      const cleanupIn = (tail + (delayNode ? 2.5 : 0.2)) * 1000;
      window.setTimeout(() => {
        for (const nd of [sourceNode, drive, shaper, crusher, postGain, filter, hp, gain, pan, delayNode, wet]) {
          try { nd?.disconnect(); } catch { /* noop */ }
        }
      }, cleanupIn);

      if (!silentLabel)
        setLast(`${NOTE_NAMES[(3 + semitone) % 12]} · ${dur.toFixed(2)} с · ${preset.name}`);
    },
    [ensureAudio],
  );

  // ---- Качественная сонификация изображения: предрасчёт + непрерывный банк голосов ----
  const analysisRef = useRef<{
    cols: number; rows: number;
    lum: Float32Array; r: Float32Array; g: Float32Array; b: Float32Array;
    hue: Float32Array; sat: Float32Array; edge: Float32Array; texture: Float32Array;
  } | null>(null);

  useEffect(() => {
    if (!bgImage) { analysisRef.current = null; return; }
    // Высокое разрешение анализа — больше деталей по горизонтали и вертикали
    const COLS = 1024;
    const ROWS = 256;
    const off = document.createElement("canvas");
    off.width = COLS;
    off.height = ROWS;
    const octx = off.getContext("2d", { willReadFrequently: true })!;
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(bgImage, 0, 0, COLS, ROWS);
    const d = octx.getImageData(0, 0, COLS, ROWS).data;
    const n = COLS * ROWS;
    const lum = new Float32Array(n), rr = new Float32Array(n), gg = new Float32Array(n), bb = new Float32Array(n);
    const hue = new Float32Array(n), sat = new Float32Array(n);
    const edge = new Float32Array(n), texture = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const a = (d[o + 3] ?? 255) / 255;
      const r = (d[o] ?? 0) * a, g = (d[o + 1] ?? 0) * a, b = (d[o + 2] ?? 0) * a;
      rr[i] = r; gg[i] = g; bb[i] = b;
      lum[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sat[i] = mx <= 0 ? 0 : (mx - mn) / mx;
      const delta = mx - mn;
      let h = 0;
      if (delta > 0) {
        if (mx === r) h = ((g - b) / delta) % 6;
        else if (mx === g) h = (b - r) / delta + 2;
        else h = (r - g) / delta + 4;
      }
      hue[i] = ((h / 6) + 1) % 1;
    }
    // Края — направленный градиент; текстура — отклонение от локального среднего.
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const i = y * COLS + x;
        const l = lum[i] ?? 0;
        const left = lum[y * COLS + Math.max(0, x - 1)] ?? l;
        const right = lum[y * COLS + Math.min(COLS - 1, x + 1)] ?? l;
        const top = lum[Math.max(0, y - 1) * COLS + x] ?? l;
        const bottom = lum[Math.min(ROWS - 1, y + 1) * COLS + x] ?? l;
        edge[i] = Math.min(1, Math.hypot(right - left, bottom - top) * 2.5);

        let local = 0;
        let localCount = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const sy = Math.min(ROWS - 1, Math.max(0, y + oy));
            const sx = Math.min(COLS - 1, Math.max(0, x + ox));
            local += lum[sy * COLS + sx] ?? l;
            localCount++;
          }
        }
        texture[i] = Math.min(1, Math.abs(l - local / localCount) * 6);
      }
    }
    analysisRef.current = { cols: COLS, rows: ROWS, lum, r: rr, g: gg, b: bb, hue, sat, edge, texture };
  }, [bgImage]);

  type SonVoice = {
    osc: AudioNode; gain: GainNode; filter: BiquadFilterNode; pan: StereoPannerNode; level: number;
    pitchOsc: OscillatorNode | null; noiseGain: GainNode; noiseFilter: BiquadFilterNode; baseFreq: number; noiseLevel: number;
    cutoff: number; semi: number;
  };
  const sonVoicesRef = useRef<SonVoice[] | null>(null);
  const sonBusRef = useRef<GainNode | null>(null);

  const teardownSonVoices = useCallback(() => {
    const voices = sonVoicesRef.current;
    if (voices) {
      for (const v of voices) {
        try {
          v.gain.gain.cancelScheduledValues(0);
          v.gain.gain.value = 0;
          (v.osc as OscillatorNode).stop?.();
        } catch { /* noop */ }
        try { v.pan.disconnect(); } catch { /* noop */ }
      }
    }
    sonVoicesRef.current = null;
    try { sonBusRef.current?.disconnect(); } catch { /* noop */ }
    sonBusRef.current = null;
  }, []);

  const buildSonVoices = useCallback(() => {
    const ctx = ensureAudio();
    const master = masterRef.current;
    if (!master) return;
    teardownSonVoices();

    const s = sonSettingsRef.current;
    const bus = ctx.createGain();
    bus.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 6;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    bus.connect(comp);
    comp.connect(master);

    if (s.delayTime > 0 && s.delayFeedback > 0) {
      const delay = ctx.createDelay(1.5);
      delay.delayTime.value = s.delayTime;
      const fb = ctx.createGain();
      fb.gain.value = Math.min(0.7, s.delayFeedback);
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      bus.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      delay.connect(wet);
      wet.connect(comp);
    }
    sonBusRef.current = bus;

    // Приятная пентатоника, снизу вверх
    const PENTA = [0, 3, 5, 7, 10];
    const baseFreqs: Record<number, number> = { 2: 65.41, 3: 130.81, 4: 261.63, 5: 523.25 };
    const baseFreq = baseFreqs[s.baseOctave] ?? 130.81;
    const now = ctx.currentTime;
    const voices: SonVoice[] = [];

    for (let b = 0; b < s.bands; b++) {
      const degree = s.bands - 1 - b; // верхняя полоса = высокая нота
      const semi = (PENTA[degree % 5] ?? 0) + 12 * Math.floor(degree / 5);
      const freq = baseFreq * Math.pow(2, semi / 12);

      const type: OscType = s.oscType === "auto" ? (b % 2 === 0 ? "triangle" : "sine") : s.oscType;
      let src: AudioNode;
      let pitchOsc: OscillatorNode | null = null;
      if (type === "noise") {
        const noise = ctx.createBufferSource();
        noise.buffer = noiseBufferRef.current!;
        noise.loop = true;
        noise.start(now);
        src = noise;
      } else if (type === "pulse") {
        const osc = ctx.createOscillator();
        osc.setPeriodicWave(createPulseWave(ctx, 0.35));
        osc.frequency.value = freq;
        osc.detune.value = (b % 2 === 0 ? 4 : -4);
        osc.start(now);
        src = osc;
        pitchOsc = osc;
      } else {
        const osc = ctx.createOscillator();
        osc.type = type as OscillatorType;
        osc.frequency.value = freq;
        osc.detune.value = (b % 2 === 0 ? 4 : -4);
        osc.start(now);
        src = osc;
        pitchOsc = osc;
      }

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = Math.max(freq * 2, s.filterFreq);
      filter.Q.value = Math.min(6, s.filterQ);

      const gain = ctx.createGain();
      gain.gain.value = 0.0001;

      const pan = ctx.createStereoPanner();
      pan.pan.value = s.bands > 1 ? ((b / (s.bands - 1)) * 1.4 - 0.7) : 0;

      // Текстурный слой: мелкие детали изображения → полосовой шум на частоте голоса
      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = noiseBufferRef.current!;
      noiseSrc.loop = true;
      noiseSrc.start(now);
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = "bandpass";
      noiseFilter.frequency.value = freq * 2;
      noiseFilter.Q.value = 6;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.0001;
      noiseSrc.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(pan);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(pan);
      pan.connect(bus);

      voices.push({ osc: src, pitchOsc, gain, filter, pan, level: 0, noiseGain, noiseFilter, baseFreq: freq, noiseLevel: 0, cutoff: Math.max(freq * 2, s.filterFreq), semi: 0 });
    }
    sonVoicesRef.current = voices;
  }, [ensureAudio, teardownSonVoices]);

  useEffect(() => {
    if (bgImage && imageSonification) buildSonVoices();
    else teardownSonVoices();
    return () => { if (!bgImage || !imageSonification) teardownSonVoices(); };
  }, [bgImage, imageSonification, buildSonVoices, teardownSonVoices, sonSettings.bands, sonSettings.oscType, sonSettings.baseOctave, sonSettings.delayTime, sonSettings.delayFeedback]);

  // Плавное обновление голосов по позиции сканера (0..1)
  const updateSonification = useCallback(
    (progress: number) => {
      const an = analysisRef.current;
      const voices = sonVoicesRef.current;
      const ctx = audioRef.current;
      if (!an || !voices || !ctx) return;
      const s = sonSettingsRef.current;
      const bands = voices.length;
      const now = ctx.currentTime;

      // Окно сканирования: «Шаг сканирования» задаёт ширину читаемой полосы пикселей
      const xf = Math.min(an.cols - 1, Math.max(0, progress * (an.cols - 1)));
      const half = Math.max(0, Math.round((s.scanStep - 1) / 2));
      const xFrom = Math.max(0, Math.round(xf) - half);
      const xTo = Math.min(an.cols - 1, Math.round(xf) + half);
      const rowsPerBand = an.rows / bands;
      const minL = s.minBrightness / 255;
      // реакция сглаживания: мелкий шаг = быстрее и детальнее
      // Более плотное сглаживание — меньше дребезга и щелчков
      const smooth = Math.min(0.96, 0.8 + s.scanStep * 0.015);
      const glide = Math.max(0.05, 0.05 + s.scanStep * 0.01);
      const PENTA_STEPS = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];

      for (let b = 0; b < bands; b++) {
        const yStart = Math.floor(b * rowsPerBand);
        const yEnd = Math.max(yStart + 1, Math.floor((b + 1) * rowsPerBand));
        let lum = 0, hs = 0, st = 0, ed = 0, tx = 0, cnt = 0;
        for (let y = yStart; y < yEnd; y++) {
          const row = y * an.cols;
          for (let x = xFrom; x <= xTo; x++) {
            const i = row + x;
            const l = an.lum[i] ?? 0;
            lum += l;
            hs += an.hue[i] ?? 0; st += an.sat[i] ?? 0;
            ed += an.edge[i] ?? 0; tx += an.texture[i] ?? 0;
            cnt++;
          }
        }
        if (cnt === 0) continue;
        lum /= cnt; hs /= cnt; st /= cnt; ed /= cnt; tx /= cnt;

        const above = lum <= minL ? 0 : (lum - minL) / Math.max(0.001, 1 - minL);
        const features: Record<ImageFeature, number> = {
          brightness: Math.pow(above, Math.max(0.4, s.contrast)),
          hue: hs,
          saturation: st,
          edges: Math.min(1, ed),
          texture: Math.min(1, tx),
        };
        const mappedValue = (parameter: SoundParameter, neutral = 0.5) => {
          let weighted = 0;
          let amount = 0;
          for (const { key } of IMAGE_FEATURES) {
            const weight = s.mappings[key][parameter];
            if (weight === 0) continue;
            weighted += Math.abs(weight) * (weight > 0 ? features[key] : 1 - features[key]);
            amount += Math.abs(weight);
          }
          if (amount <= 1) return neutral * (1 - amount) + weighted;
          return weighted / amount;
        };

        const v = voices[b]!;

        // Громкость: мягкая кривая + шумовой порог, чтобы тихие полосы молчали
        const volumeShape = mappedValue("volume", 1);
        const gated = volumeShape < 0.04 ? 0 : (volumeShape - 0.04) / 0.96;
        const target = Math.pow(gated, 1.3) * s.volume * (1.6 / Math.sqrt(bands));
        const durationShape = mappedValue("duration", 0.5);
        const responseTime = Math.min(1.2, Math.max(0.04, glide * Math.pow(2, (durationShape - 0.5) * 4)));

        v.level = v.level * smooth + target * (1 - smooth);
        v.gain.gain.setTargetAtTime(Math.max(0.00005, v.level), now, responseTime);

        // Высота: квантуем в пентатонику — без «воя» между нотами
        const pitchShape = mappedValue("pitch", 0.5);
        if (v.pitchOsc) {
          const span = (pitchShape - 0.5) * 2; // -1..1
          const idx = Math.round(Math.abs(span) * 5);
          const semiRaw = (PENTA_STEPS[Math.min(PENTA_STEPS.length - 1, idx)] ?? 0) * Math.sign(span);
          v.semi = v.semi * 0.85 + semiRaw * 0.15;
          const quant = Math.round(v.semi);
          v.pitchOsc.frequency.setTargetAtTime(v.baseFreq * Math.pow(2, quant / 12), now, Math.max(0.08, responseTime));
        }

        // Тембр: плавный фильтр без резких скачков резонанса
        const timbreShape = mappedValue("timbre", 0.5);
        const timbreAmount = (timbreShape - 0.5) * 2;
        const cutoffTarget = Math.min(9000, Math.max(Math.min(900, v.baseFreq * 2), s.filterFreq * Math.pow(2, timbreAmount * 1.6)));
        v.cutoff = v.cutoff * 0.85 + cutoffTarget * 0.15;
        v.filter.frequency.setTargetAtTime(v.cutoff, now, 0.15);
        v.filter.Q.setTargetAtTime(Math.min(6, Math.max(0.3, s.filterQ * (1 + timbreAmount * 0.25))), now, 0.25);

        // Текстурный шум — только как лёгкий призвук
        const textureLevel = Math.max(0, Math.min(1, (features.edges * 0.6 + features.texture * 0.4)));
        const nTarget = textureLevel * gated * s.detail * s.volume * (0.5 / Math.sqrt(bands));
        v.noiseLevel = v.noiseLevel * Math.max(smooth, 0.9) + nTarget * (1 - Math.max(smooth, 0.9));
        v.noiseGain.gain.setTargetAtTime(Math.max(0.00005, v.noiseLevel), now, Math.max(0.12, responseTime));
        v.noiseFilter.frequency.setTargetAtTime(
          Math.min(9000, v.baseFreq * (2 + textureLevel * 3)),
          now,
          0.2,
        );
      }
    },
    [],
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

    const drawStrokePixelated = (s: Stroke) => {
      if (s.pts.length < 2) return;
      const preset = presetsRef.current.find(p => p.id === s.presetId);
      if (!preset) return;
      ctx.fillStyle = `oklch(0.82 0.19 ${preset.hue})`;
      ctx.shadowBlur = 0;
      for (let i = 1; i < s.pts.length; i++) {
        const a = s.pts[i - 1]!;
        const b = s.pts[i]!;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.floor(dist / PIXEL_SIZE));
        for (let step = 0; step <= steps; step++) {
          const t = step / steps;
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t;
          const px = Math.floor(x / PIXEL_SIZE) * PIXEL_SIZE;
          const py = Math.floor(y / PIXEL_SIZE) * PIXEL_SIZE;
          ctx.fillRect(px, py, PIXEL_SIZE, PIXEL_SIZE);
        }
      }
    };

    const render = (time: number) => {
      const dt = Math.min(0.1, (time - prevTime) / 1000);
      prevTime = time;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

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
        for (let si = 0; si < strokesRef.current.length; si++) {
          const s = strokesRef.current[si]!;
          const preset = presetsRef.current.find(p => p.id === s.presetId);
          if (!preset) continue;
          for (let ni = 0; ni < s.notes.length; ni++) {
            const n = s.notes[ni]!;
            const hit = wrapped ? n.x >= prevX || n.x < x : n.x >= prevX && n.x < x;
            if (hit) {
              playNote(n, preset, true);
              flashRef.current.set(`${si}:${ni}`, time);
            }
          }
        }

        if (imageSonification && bgImage) {
          updateSonification(x / Math.max(1, w));
        }
      } else if (sonVoicesRef.current && audioRef.current) {
        const nowT = audioRef.current.currentTime;
        for (const v of sonVoicesRef.current) {
          v.level = 0;
          v.gain.gain.setTargetAtTime(0.00005, nowT, 0.05);
        }
      }

      for (const s of strokesRef.current) drawStrokePixelated(s);
      if (currentRef.current) drawStrokePixelated(currentRef.current);

      for (const [key, t] of flashRef.current) {
        const age = (time - t) / 450;
        if (age >= 1) { flashRef.current.delete(key); continue; }
        const [siStr, niStr] = key.split(":");
        const s = strokesRef.current[Number(siStr)];
        const n = s?.notes[Number(niStr)];
        if (!n) continue;
        const preset = presetsRef.current.find(p => p.id === s!.presetId);
        if (!preset) continue;
        ctx.fillStyle = `oklch(0.95 0.15 ${preset.hue} / ${1 - age})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, 4 + 14 * age, 0, Math.PI * 2);
        ctx.fill();
      }

      if (modeRef.current === "edit") {
        for (let si = 0; si < strokesRef.current.length; si++) {
          const s = strokesRef.current[si]!;
          const preset = presetsRef.current.find(p => p.id === s.presetId);
          if (!preset) continue;
          for (let ni = 0; ni < s.notes.length; ni++) {
            const n = s.notes[ni]!;
            const active = (dragRef.current?.si === si && dragRef.current?.ni === ni) || (hoverRef.current?.si === si && hoverRef.current?.ni === ni);
            ctx.beginPath();
            ctx.arc(n.x, n.y, active ? HANDLE_R + 3 : HANDLE_R, 0, Math.PI * 2);
            ctx.fillStyle = active ? "oklch(0.95 0.02 265 / 0.95)" : "oklch(0.25 0.03 265 / 0.9)";
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = `oklch(0.85 0.18 ${preset.hue})`;
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
  }, [playNote, bgImage, imageSonification, updateSonification]);

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

  const describe = (n: NotePt, preset: SoundPreset) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const h = canvas.clientHeight;
    const w = canvas.clientWidth;
    const idx = Math.round((1 - n.y / h) * (SCALE.length - 1));
    const semitone = SCALE[Math.max(0, Math.min(SCALE.length - 1, idx))] ?? 0;
    const dur = Math.min(2.2, 0.18 + (n.len / Math.max(w, 1)) * 3.2);
    setLast(`${NOTE_NAMES[(3 + semitone) % 12]} · ${dur.toFixed(2)} с · ${preset.name}`);
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    ensureAudio();
    const p = pos(e);
    if (mode === "edit") {
      const hit = findHandle(p);
      dragRef.current = hit;
      if (hit) {
        const s = strokesRef.current[hit.si]!;
        const preset = presetsRef.current.find(pr => pr.id === s.presetId);
        if (!preset) return;
        const n = s.notes[hit.ni]!;
        describe(n, preset);
        playNote(n, preset);
      }
      return;
    }
    currentRef.current = { pts: [p], presetId: currentPresetId, notes: [] };
    lastSoundPtRef.current = p;
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pos(e);
    if (mode === "edit") {
      const drag = dragRef.current;
      if (!drag) { hoverRef.current = findHandle(p); return; }
      const s = strokesRef.current[drag.si];
      const preset = presetsRef.current.find(pr => pr.id === s?.presetId);
      if (!s || !preset) return;
      const n = s.notes[drag.ni];
      if (!n) return;
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
      describe(n, preset);
      return;
    }
    const cur = currentRef.current;
    if (!cur) return;
    cur.pts.push(p);
    const anchor = lastSoundPtRef.current;
    const preset = presetsRef.current.find(pr => pr.id === cur.presetId);
    if (!preset) return;
    if (anchor && Math.hypot(p.x - anchor.x, p.y - anchor.y) > NOTE_SPACING) {
      playNote({
        x: p.x, y: p.y,
        angle: (Math.atan2(-(p.y - anchor.y), p.x - anchor.x) * 180) / Math.PI,
        len: Math.hypot(p.x - anchor.x, p.y - anchor.y),
      }, preset);
      lastSoundPtRef.current = p;
    }
  };

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === "edit") {
      const drag = dragRef.current;
      if (drag) {
        const s = strokesRef.current[drag.si];
        const preset = presetsRef.current.find(pr => pr.id === s?.presetId);
        if (s && preset) {
          const n = s.notes[drag.ni];
          if (n) playNote(n, preset);
        }
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

  const addPreset = () => {
    const newId = `preset-${Date.now()}`;
    const hue = Math.floor(Math.random() * 360);
    const newPreset: SoundPreset = {
      id: newId, name: `Цвет ${presets.length + 1}`, hue,
      oscType: "sine", pulseWidth: 0.5, filterFreq: 800, filterQ: 3,
      distortion: 0, bitcrusher: 0, delayTime: 0, delayFeedback: 0, volume: 0.28,
    };
    setPresets([...presets, newPreset]);
    setCurrentPresetId(newId);
  };

  const deletePreset = (id: string) => {
    if (presets.length <= 1) return;
    const newPresets = presets.filter(p => p.id !== id);
    setPresets(newPresets);
    if (currentPresetId === id) setCurrentPresetId(newPresets[0]!.id);
  };

  const updatePreset = (id: string, updates: Partial<SoundPreset>) => {
    setPresets(presets.map(p => p.id === id ? { ...p, ...updates } : p));
  };

  const updateSonSettings = (updates: Partial<SonificationSettings>) => {
    setSonSettings({ ...sonSettings, ...updates });
  };

  const updateMapping = (feature: ImageFeature, parameter: SoundParameter, value: number) => {
    setSonSettings(current => ({
      ...current,
      mappings: {
        ...current.mappings,
        [feature]: { ...current.mappings[feature], [parameter]: value },
      },
    }));
  };

  const resetMappings = () => {
    setSonSettings(current => ({
      ...current,
      mappings: Object.fromEntries(
        IMAGE_FEATURES.map(({ key }) => [key, { ...DEFAULT_MAPPINGS[key] }]),
      ) as SonificationMappings,
    }));
  };

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
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  };

  const startVideo = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    ensureAudio();
    const recDest = recDestRef.current;
    if (!recDest) return;
    const mimeType = pick(["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]);
    if (!mimeType) { setNotice("Браузер не умеет записывать видео с холста."); return; }
    const isMp4 = mimeType.startsWith("video/mp4");
    setNotice(isMp4 ? null : "Браузер не поддерживает MP4 — видео сохранится в формате WEBM.");
    const stream = canvas.captureStream(60);
    for (const t of recDest.stream.getAudioTracks()) stream.addTrack(t);
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (ev) => ev.data.size > 0 && chunks.push(ev.data);
    rec.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
      setVideoFile((prev) => { if (prev) URL.revokeObjectURL(prev.url); return { url, name: isMp4 ? "liniofon.mp4" : "liniofon.webm" }; });
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
    const mimeType = pick(["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);
    if (!mimeType) { setNotice("Браузер не умеет записывать звук."); return; }
    const ext = mimeType.startsWith("audio/mp4") ? "m4a" : mimeType.startsWith("audio/ogg") ? "ogg" : "webm";
    const rec = new MediaRecorder(recDest.stream, { mimeType });
    const chunks: Blob[] = [];
    rec.ondataavailable = (ev) => ev.data.size > 0 && chunks.push(ev.data);
    rec.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
      setAudioFile((prev) => { if (prev) URL.revokeObjectURL(prev.url); return { url, name: `liniofon.${ext}` }; });
      setRecAudio(false);
    };
    audioRecRef.current = rec;
    rec.start(200);
    setRecAudio(true);
  };

  const stopVideo = () => { videoRecRef.current?.stop(); videoRecRef.current = null; };
  const stopAudio = () => { audioRecRef.current?.stop(); audioRecRef.current = null; };

  const btn = "rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-card-foreground transition-colors hover:bg-accent";
  const btnPrimary = "rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90";
  const btnStop = "inline-flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Линиофон</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Рисуйте свободные линии — они остаются на холсте и звучат по кругу.
              Каждый цвет имеет свой звук.
            </p>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <div>Линий: {strokeCount}</div>
            <div className="font-mono">{last ?? "—"}</div>
          </div>
        </header>

        {/* ПАНЕЛЬ ЦВЕТОВ И ПРЕСЕТОВ */}
        <div className="rounded-xl border border-border bg-card p-4 shadow-lg">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Цвет линии</span>
              <div className="flex flex-wrap gap-1">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setCurrentPresetId(p.id)}
                    className={`h-8 w-8 rounded border-2 transition-all ${
                      currentPresetId === p.id ? "border-white scale-110 shadow-lg" : "border-transparent hover:border-white/50"
                    }`}
                    style={{ backgroundColor: `oklch(0.7 0.2 ${p.hue})` }}
                    title={p.name}
                  />
                ))}
                <button
                  onClick={addPreset}
                  className="h-8 w-8 rounded border-2 border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary"
                  title="Добавить цвет"
                >
                  +
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Пресет звука</span>
              <select
                value={currentPresetId}
                onChange={(e) => setCurrentPresetId(e.target.value)}
                className="rounded border border-border bg-background px-3 py-1.5 text-sm"
              >
                {presets.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Управление</span>
              <div className="flex gap-1">
                <button onClick={() => setShowSettings(!showSettings)} className={btn}>
                  {showSettings ? "Скрыть" : "Настроить звук"}
                </button>
                {presets.length > 1 && (
                  <button
                    onClick={() => deletePreset(currentPresetId)}
                    className="rounded-md border border-destructive bg-background px-3 py-2 text-sm text-destructive hover:bg-destructive hover:text-destructive-foreground"
                  >
                    Удалить
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Текущий</span>
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded" style={{ backgroundColor: `oklch(0.7 0.2 ${currentPreset.hue})` }} />
                <span className="text-sm font-medium">{currentPreset.name}</span>
              </div>
            </div>
          </div>

          {showSettings && (
            <div className="mt-4 border-t border-border pt-4">
              <h3 className="mb-3 text-sm font-semibold">Настройки: {currentPreset.name}</h3>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Название</label>
                  <input type="text" value={currentPreset.name} onChange={(e) => updatePreset(currentPreset.id, { name: e.target.value })} className="rounded border border-border bg-background px-2 py-1 text-sm" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Цвет: {currentPreset.hue}°</label>
                  <input type="range" min={0} max={360} step={1} value={currentPreset.hue} onChange={(e) => updatePreset(currentPreset.id, { hue: Number(e.target.value) })} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Тембр</label>
                  <select value={currentPreset.oscType} onChange={(e) => updatePreset(currentPreset.id, { oscType: e.target.value as OscType })} className="rounded border border-border bg-background px-2 py-1 text-sm">
                    <option value="sine">Синус (мягкий)</option>
                    <option value="triangle">Треугольник (флейта)</option>
                    <option value="sawtooth">Пила (SEGA)</option>
                    <option value="square">Квадрат (NES)</option>
                    <option value="pulse">Pulse (чиптюн)</option>
                    <option value="noise">Шум (8-bit)</option>
                  </select>
                </div>
                {currentPreset.oscType === "pulse" && (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Ширина Pulse: {currentPreset.pulseWidth.toFixed(2)}</label>
                    <input type="range" min={0.1} max={0.9} step={0.05} value={currentPreset.pulseWidth} onChange={(e) => updatePreset(currentPreset.id, { pulseWidth: Number(e.target.value) })} />
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Фильтр: {currentPreset.filterFreq} Hz</label>
                  <input type="range" min={100} max={8000} step={50} value={currentPreset.filterFreq} onChange={(e) => updatePreset(currentPreset.id, { filterFreq: Number(e.target.value) })} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Резонанс: {currentPreset.filterQ}</label>
                  <input type="range" min={0.1} max={8} step={0.1} value={currentPreset.filterQ} onChange={(e) => updatePreset(currentPreset.id, { filterQ: Number(e.target.value) })} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Дисторшн: {currentPreset.distortion}</label>
                  <input type="range" min={0} max={30} step={1} value={currentPreset.distortion} onChange={(e) => updatePreset(currentPreset.id, { distortion: Number(e.target.value) })} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Bitcrusher: {currentPreset.bitcrusher} бит</label>
                  <input type="range" min={0} max={16} step={1} value={currentPreset.bitcrusher} onChange={(e) => updatePreset(currentPreset.id, { bitcrusher: Number(e.target.value) })} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Эхо: {(currentPreset.delayTime * 1000).toFixed(0)} мс</label>
                  <input type="range" min={0} max={1000} step={10} value={currentPreset.delayTime * 1000} onChange={(e) => updatePreset(currentPreset.id, { delayTime: Number(e.target.value) / 1000 })} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Обратная связь: {Math.round(currentPreset.delayFeedback * 100)}%</label>
                  <input type="range" min={0} max={90} step={5} value={currentPreset.delayFeedback * 100} onChange={(e) => updatePreset(currentPreset.id, { delayFeedback: Number(e.target.value) / 100 })} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Громкость: {Math.round(currentPreset.volume * 100)}%</label>
                  <input type="range" min={0} max={100} step={1} value={currentPreset.volume * 100} onChange={(e) => updatePreset(currentPreset.id, { volume: Number(e.target.value) / 100 })} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ПАНЕЛЬ SONIFICATION (появляется только при загруженном изображении) */}
        {bgImage && (
          <div className="rounded-xl border border-primary/50 bg-card p-4 shadow-lg">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">🎨 Sonification изображения</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setImageSonification(!imageSonification)}
                    className={imageSonification ? btnPrimary : btn}
                  >
                    {imageSonification ? "🔊 ВКЛ" : "🔇 ВЫКЛ"}
                  </button>
                  <button onClick={() => setShowSonSettings(!showSonSettings)} className={btn}>
                    {showSonSettings ? "Скрыть" : "Настройки"}
                  </button>
                  <button onClick={removeImage} className="rounded-md border border-destructive bg-background px-3 py-2 text-sm text-destructive hover:bg-destructive hover:text-destructive-foreground">
                    Убрать
                  </button>
                </div>
              </div>
            </div>

            {showSonSettings && (
              <div className="mt-4 border-t border-border pt-4">
                <h3 className="mb-3 text-sm font-semibold">Настройки озвучивания изображения</h3>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Голоса: {sonSettings.bands}</label>
                    <input type="range" min={1} max={12} step={1} value={sonSettings.bands} onChange={(e) => updateSonSettings({ bands: Number(e.target.value) })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Октава: C{sonSettings.baseOctave}</label>
                    <input type="range" min={2} max={5} step={1} value={sonSettings.baseOctave} onChange={(e) => updateSonSettings({ baseOctave: Number(e.target.value) })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Тембр</label>
                    <select value={sonSettings.oscType} onChange={(e) => updateSonSettings({ oscType: e.target.value as OscType | "auto" })} className="rounded border border-border bg-background px-2 py-1 text-sm">
                      <option value="auto">Авто (по цвету)</option>
                      <option value="sine">Синус</option>
                      <option value="triangle">Треугольник</option>
                      <option value="sawtooth">Пила</option>
                      <option value="square">Квадрат</option>
                      <option value="pulse">Pulse</option>
                      <option value="noise">Шум</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Громкость: {Math.round(sonSettings.volume * 100)}%</label>
                    <input type="range" min={0} max={30} step={1} value={sonSettings.volume * 100} onChange={(e) => updateSonSettings({ volume: Number(e.target.value) / 100 })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Детализация: {Math.round(sonSettings.detail * 100)}%</label>
                    <input type="range" min={0} max={100} step={5} value={sonSettings.detail * 100} onChange={(e) => updateSonSettings({ detail: Number(e.target.value) / 100 })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Контраст: {sonSettings.contrast.toFixed(1)}×</label>
                    <input type="range" min={0.5} max={3} step={0.1} value={sonSettings.contrast} onChange={(e) => updateSonSettings({ contrast: Number(e.target.value) })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Шаг сканирования: {sonSettings.scanStep} px</label>
                    <input type="range" min={1} max={20} step={1} value={sonSettings.scanStep} onChange={(e) => updateSonSettings({ scanStep: Number(e.target.value) })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Фильтр: {sonSettings.filterFreq} Hz</label>
                    <input type="range" min={200} max={8000} step={100} value={sonSettings.filterFreq} onChange={(e) => updateSonSettings({ filterFreq: Number(e.target.value) })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Резонанс: {sonSettings.filterQ}</label>
                    <input type="range" min={0.1} max={20} step={0.1} value={sonSettings.filterQ} onChange={(e) => updateSonSettings({ filterQ: Number(e.target.value) })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Порог яркости: {sonSettings.minBrightness}</label>
                    <input type="range" min={0} max={100} step={5} value={sonSettings.minBrightness} onChange={(e) => updateSonSettings({ minBrightness: Number(e.target.value) })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Эхо: {(sonSettings.delayTime * 1000).toFixed(0)} мс</label>
                    <input type="range" min={0} max={1000} step={10} value={sonSettings.delayTime * 1000} onChange={(e) => updateSonSettings({ delayTime: Number(e.target.value) / 1000 })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Обратная связь: {Math.round(sonSettings.delayFeedback * 100)}%</label>
                    <input type="range" min={0} max={90} step={5} value={sonSettings.delayFeedback * 100} onChange={(e) => updateSonSettings({ delayFeedback: Number(e.target.value) / 100 })} />
                  </div>
                </div>

                <div className="mt-5 border-t border-border pt-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-semibold">Привязка изображения к звуку</h4>
                      <p className="text-xs text-muted-foreground">− инвертирует влияние · 0 отключает связь · + усиливает</p>
                    </div>
                    <button type="button" onClick={resetMappings} className={btn}>Сбросить связи</button>
                  </div>
                  <div className="overflow-x-auto pb-2">
                    <div className="grid min-w-[760px] grid-cols-[120px_repeat(4,minmax(140px,1fr))] gap-x-4 gap-y-3">
                      <div />
                      {SOUND_PARAMETERS.map(parameter => (
                        <div key={parameter.key} className="text-center text-xs font-semibold text-card-foreground">{parameter.label}</div>
                      ))}
                      {IMAGE_FEATURES.map(feature => (
                        <div key={feature.key} className="contents">
                          <div className="flex items-center text-xs font-medium text-card-foreground">{feature.label}</div>
                          {SOUND_PARAMETERS.map(parameter => {
                            const value = sonSettings.mappings[feature.key][parameter.key];
                            return (
                              <label key={parameter.key} className="flex min-w-0 flex-col gap-1">
                                <span className="text-center font-mono text-[11px] text-muted-foreground">{value > 0 ? "+" : ""}{Math.round(value * 100)}%</span>
                                <input
                                  type="range"
                                  min={-100}
                                  max={100}
                                  step={5}
                                  value={value * 100}
                                  aria-label={`${feature.label} — ${parameter.label}`}
                                  onChange={(e) => updateMapping(feature.key, parameter.key, Number(e.target.value) / 100)}
                                />
                              </label>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ПАНЕЛЬ УПРАВЛЕНИЯ */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            <button onClick={() => setMode("draw")} className={`px-4 py-2 text-sm font-medium transition-colors ${mode === "draw" ? "bg-primary text-primary-foreground" : "bg-card text-card-foreground hover:bg-accent"}`}>Рисование</button>
            <button onClick={() => setMode("edit")} className={`px-4 py-2 text-sm font-medium transition-colors ${mode === "edit" ? "bg-primary text-primary-foreground" : "bg-card text-card-foreground hover:bg-accent"}`}>Настройка звука</button>
          </div>
          <button onClick={() => { ensureAudio(); setPlaying((p) => !p); }} className={btnPrimary}>{playing ? "Пауза" : "Играть"}</button>
          <label className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
            <span className="text-muted-foreground">Круг</span>
            <input type="range" min={2} max={16} step={1} value={loopSec} onChange={(e) => setLoopSec(Number(e.target.value))} />
            <span className="w-8 font-mono">{loopSec}с</span>
          </label>
          <label className={btn}>
            📷 Загрузить изображение
            <input type="file" accept="image/*" className="hidden" onChange={handleImageLoad} />
          </label>
          <button onClick={recVideo ? stopVideo : startVideo} className={recVideo ? btnStop : btn}>
            {recVideo ? (<><span className="size-2 animate-pulse rounded-full bg-current" />Стоп видео</>) : ("Записать видео")}
          </button>
          <button onClick={recAudio ? stopAudio : startAudio} className={recAudio ? btnStop : btn}>
            {recAudio ? (<><span className="size-2 animate-pulse rounded-full bg-current" />Стоп аудио</>) : ("Записать аудио")}
          </button>
          <button onClick={clear} className={btn}>Очистить холст</button>
          {videoFile && !recVideo && (<a href={videoFile.url} download={videoFile.name} className={btn}>Скачать {videoFile.name}</a>)}
          {audioFile && !recAudio && (<a href={audioFile.url} download={audioFile.name} className={btn}>Скачать {audioFile.name}</a>)}
        </div>

        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className={`h-[62vh] w-full touch-none rounded-xl border border-border shadow-lg ${mode === "edit" ? "cursor-grab" : "cursor-crosshair"}`}
          aria-label="Холст для рисования звучащих линий"
        />

        <footer className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span>Каждый цвет = свой звук</span>
          <span>Пиксельные линии</span>
          <span>Тембры: синус, треугольник, пила, квадрат, pulse, шум</span>
          {bgImage && <span>🎨 Изображение загружено</span>}
        </footer>
      </div>
    </main>
  );
}
