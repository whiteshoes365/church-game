// 호스트(선생님 큰 화면) 배경 음악.
//
// 저작권: 여기 있는 모든 곡은 이 프로젝트를 위해 직접 지은 짧은 반복 악절이고,
// 음원 파일 없이 브라우저의 Web Audio API(오실레이터 + 노이즈)로 그 자리에서 합성한다.
// 외부 음원·샘플·MP3·유료 API 를 쓰지 않는다. (출처 표기: RESULT.md "배경 음악" 항목)
//
// 음악은 이 모듈을 불러 쓰는 호스트 화면(방 만들기 미리 듣기, 호스트 방)에서만 난다.
// 학생 화면(PlayerRoom 등)은 이 모듈을 import 하지 않으므로 학생 기기에서는 소리가 나지 않는다.

export type TrackId = 'upbeat' | 'calm' | 'countdown' | 'chiptune' | 'march' | 'musicbox';

/** 정답 공개 효과음 종류 (직접 합성). */
export type SfxKind = 'cheer' | 'aww';

export interface MusicPrefs {
  track: TrackId;
  enabled: boolean; // false = 음악 끄기
  volume: number; // 0..1
}

export const DEFAULT_MUSIC_VOLUME = 0.3; // 처음에는 작게 (30%)
const DEFAULT_PREFS: MusicPrefs = { track: 'upbeat', enabled: true, volume: DEFAULT_MUSIC_VOLUME };
const PREFS_KEY = 'church-game:music';
// 슬라이더 100% 일 때의 마스터 게인. 슬라이더 값은 제곱해서 쓴다(작은 쪽을 더 세밀하게).
const MASTER_PEAK = 0.55;

interface Voice {
  wave: OscillatorType;
  /** "C4:2 E4:2 -:4 ..." = 음이름:길이(스텝). '-' 는 쉼표, '|' 는 읽기 좋으라고 넣는 마디 구분. */
  notes: string;
  gain: number;
  attack?: number; // 초
  release?: number; // 초
  hold?: number; // 음 길이 중 소리를 유지하는 비율 (0..1)
  decayTo?: number; // 유지 구간 끝의 음량 비율 (1 = 그대로, 0.2 = 뚝 떨어지는 통통 소리)
  lowpass?: number; // Hz
  octaveUp?: number; // 한 옥타브 위 배음을 이 비율로 섞는다 (오르골·종소리 느낌)
}

interface Drums {
  /** 스텝마다 한 글자. x = 치기, - = 쉬기. 패턴 길이만큼 반복. */
  kick?: string;
  snare?: string;
  hat?: string;
  tick?: string; // 똑딱 (우드블록)
  gain?: number;
}

interface Track {
  id: TrackId;
  label: string;
  mood: string;
  bpm: number;
  stepsPerBeat: number;
  voices: Voice[];
  drums?: Drums;
}

// ---------------------------------------------------------------------------
// 곡 (모두 직접 지은 것)
// ---------------------------------------------------------------------------
const TRACKS: Track[] = [
  {
    id: 'upbeat',
    label: '신나는',
    mood: '밝고 통통 튀는 기본 음악',
    bpm: 126,
    stepsPerBeat: 4,
    voices: [
      {
        wave: 'triangle',
        gain: 0.5,
        hold: 0.8,
        decayTo: 0.5,
        notes:
          'E5:2 G5:2 C6:2 G5:2 E5:2 G5:2 C6:4 | D5:2 G5:2 B5:2 G5:2 D5:2 G5:2 B5:4 | C5:2 E5:2 A5:2 E5:2 C5:2 E5:2 A5:4 | A5:2 G5:2 F5:2 E5:2 F5:2 G5:2 A5:2 B5:2 | ' +
          'C6:4 G5:2 E5:2 G5:4 E5:2 C5:2 | D5:4 G5:2 B5:2 D6:4 B5:2 G5:2 | A5:2 A5:2 G5:2 E5:2 C5:4 E5:4 | F5:2 A5:2 C6:2 A5:2 G5:2 B5:2 D6:4',
      },
      {
        wave: 'square',
        gain: 0.16,
        hold: 0.5,
        lowpass: 1400,
        notes:
          '-:2 E4:2 -:2 G4:2 -:2 E4:2 -:2 G4:2 | -:2 D4:2 -:2 G4:2 -:2 D4:2 -:2 G4:2 | -:2 E4:2 -:2 A4:2 -:2 E4:2 -:2 A4:2 | -:2 F4:2 -:2 A4:2 -:2 G4:2 -:2 B4:2',
      },
      {
        wave: 'triangle',
        gain: 0.55,
        hold: 0.7,
        notes: 'C2:2 C3:2 C2:2 C3:2 C2:2 C3:2 C2:2 C3:2 | G2:2 G3:2 G2:2 G3:2 G2:2 G3:2 G2:2 G3:2 | A2:2 A3:2 A2:2 A3:2 A2:2 A3:2 A2:2 A3:2 | F2:2 F3:2 F2:2 F3:2 G2:2 G3:2 G2:2 G3:2',
      },
    ],
    drums: { kick: 'x---x---x---x---', snare: '----x-------x---', hat: '--x---x---x---xx', gain: 0.5 },
  },
  {
    id: 'calm',
    label: '잔잔한',
    mood: '조용히 기다릴 때',
    bpm: 72,
    stepsPerBeat: 2,
    voices: [
      {
        wave: 'sine',
        gain: 0.3,
        attack: 0.5,
        release: 1.2,
        notes: 'F3:8 | D3:8 | A#2:8 | C3:8',
      },
      {
        wave: 'sine',
        gain: 0.2,
        attack: 0.5,
        release: 1.2,
        notes: 'A3:8 | F3:8 | D3:8 | E3:8',
      },
      {
        wave: 'sine',
        gain: 0.2,
        attack: 0.5,
        release: 1.2,
        notes: 'C4:8 | A3:8 | F3:8 | G3:8',
      },
      {
        wave: 'triangle',
        gain: 0.34,
        attack: 0.02,
        release: 0.9,
        decayTo: 0.35,
        notes:
          'F4:1 A4:1 C5:1 E5:1 C5:1 A4:1 C5:2 | D4:1 F4:1 A4:1 C5:1 A4:1 F4:1 A4:2 | A#3:1 D4:1 F4:1 A4:1 F4:1 D4:1 F4:2 | C4:1 E4:1 G4:1 A#4:1 G4:1 E4:1 G4:2 | ' +
          'A4:2 C5:2 F5:3 E5:1 | D5:2 C5:2 A4:4 | A#4:2 D5:2 F5:3 D5:1 | E5:2 D5:2 C5:4',
      },
    ],
  },
  {
    id: 'countdown',
    label: '긴장감 카운트다운',
    mood: '두근두근 시간이 줄어드는 느낌',
    bpm: 120,
    stepsPerBeat: 4,
    voices: [
      {
        wave: 'sawtooth',
        gain: 0.3,
        hold: 0.45,
        lowpass: 520,
        notes: 'A1:2 A1:2 A1:2 A1:2 A1:2 A1:2 A1:2 A1:2 | A1:2 A1:2 A1:2 A1:2 A1:2 A1:2 A1:2 C2:2 | F1:2 F1:2 F1:2 F1:2 F1:2 F1:2 F1:2 F1:2 | E1:2 E1:2 E1:2 E1:2 E1:2 E1:2 G#1:2 B1:2',
      },
      {
        wave: 'square',
        gain: 0.15,
        hold: 0.35,
        lowpass: 1800,
        notes:
          'A3:1 -:1 E4:1 -:1 A3:1 -:1 E4:1 -:1 A3:1 -:1 E4:1 -:1 C4:1 -:1 E4:1 -:1 | A3:1 -:1 E4:1 -:1 A3:1 -:1 E4:1 -:1 B3:1 -:1 E4:1 -:1 C4:1 -:1 E4:1 -:1 | ' +
          'A3:1 -:1 F4:1 -:1 A3:1 -:1 F4:1 -:1 A3:1 -:1 F4:1 -:1 C4:1 -:1 F4:1 -:1 | G#3:1 -:1 E4:1 -:1 G#3:1 -:1 E4:1 -:1 B3:1 -:1 E4:1 -:1 D4:1 -:1 E4:1 -:1',
      },
      {
        wave: 'triangle',
        gain: 0.3,
        hold: 0.9,
        notes: '-:16 | -:8 E5:2 D5:2 C5:2 B4:2 | A4:8 C5:8 | B4:6 G#4:2 E4:8',
      },
    ],
    drums: { kick: 'x-------x-------', tick: 'x---x---x---x---', hat: '--x---x---x---x-', gain: 0.45 },
  },
  {
    id: 'chiptune',
    label: '8비트 게임풍',
    mood: '옛날 오락기 같은 소리',
    bpm: 150,
    stepsPerBeat: 4,
    voices: [
      {
        wave: 'square',
        gain: 0.22,
        hold: 0.75,
        notes:
          'G5:1 B5:1 D6:1 B5:1 G5:2 D5:2 G5:1 B5:1 D6:1 G6:1 D6:4 | E5:1 G5:1 B5:1 G5:1 E5:2 B4:2 E5:1 G5:1 B5:1 E6:1 B5:4 | ' +
          'C5:1 E5:1 G5:1 E5:1 C6:2 G5:2 E5:1 G5:1 C6:1 E6:1 C6:4 | D5:1 F#5:1 A5:1 F#5:1 D6:2 A5:2 C6:2 B5:2 A5:2 F#5:2 | ' +
          'G5:2 G5:1 G5:1 B5:2 G5:2 D6:2 B5:2 G5:4 | E5:2 E5:1 E5:1 G5:2 E5:2 B5:2 G5:2 E5:4 | C6:2 B5:2 A5:2 G5:2 A5:2 G5:2 E5:2 C5:2 | D5:2 E5:2 F#5:2 A5:2 D6:4 -:4',
      },
      {
        wave: 'square',
        gain: 0.1,
        hold: 0.5,
        notes: 'B4:2 D5:2 B4:2 D5:2 B4:2 D5:2 B4:2 D5:2 | G4:2 B4:2 G4:2 B4:2 G4:2 B4:2 G4:2 B4:2 | G4:2 C5:2 G4:2 C5:2 G4:2 C5:2 G4:2 C5:2 | F#4:2 A4:2 F#4:2 A4:2 F#4:2 A4:2 F#4:2 A4:2',
      },
      {
        wave: 'triangle',
        gain: 0.5,
        hold: 0.6,
        notes: 'G2:2 G2:2 D3:2 G2:2 G2:2 G2:2 D3:2 G2:2 | E2:2 E2:2 B2:2 E2:2 E2:2 E2:2 B2:2 E2:2 | C2:2 C2:2 G2:2 C2:2 C2:2 C2:2 G2:2 C2:2 | D2:2 D2:2 A2:2 D2:2 D2:2 D2:2 A2:2 D2:2',
      },
    ],
    drums: { kick: 'x-----x-x-------', snare: '----x-------x---', hat: 'x-x-x-x-x-x-x-x-', gain: 0.38 },
  },
  {
    id: 'march',
    label: '행진곡풍',
    mood: '씩씩하게 걸어가는 느낌',
    bpm: 112,
    stepsPerBeat: 4,
    voices: [
      {
        wave: 'sawtooth',
        gain: 0.26,
        hold: 0.8,
        lowpass: 1900,
        attack: 0.02,
        notes:
          'F4:3 F4:1 A4:4 C5:3 C5:1 F5:4 | E5:3 D5:1 C5:4 A#4:3 A4:1 G4:4 | A4:3 A4:1 C5:4 F5:3 F5:1 A5:4 | G5:3 F5:1 E5:4 F5:8 | ' +
          'A#4:3 A#4:1 D5:4 F5:3 F5:1 A#5:4 | A5:3 G5:1 F5:4 C5:8 | D5:3 E5:1 F5:4 G5:3 A5:1 A#5:4 | A5:4 G5:4 F5:6 -:2',
      },
      {
        wave: 'triangle',
        gain: 0.55,
        hold: 0.55,
        notes:
          'F2:4 C3:4 F2:4 C3:4 | C2:4 G2:4 C2:4 G2:4 | F2:4 C3:4 F2:4 C3:4 | C2:4 G2:4 F2:4 C3:4 | A#1:4 F2:4 A#1:4 F2:4 | F2:4 C3:4 F2:4 C3:4 | A#1:4 F2:4 C2:4 G2:4 | C2:4 G2:4 F2:4 C3:4',
      },
      {
        wave: 'square',
        gain: 0.1,
        hold: 0.4,
        lowpass: 1500,
        notes: '-:4 A3:2 C4:2 -:4 A3:2 C4:2 | -:4 G3:2 A#3:2 -:4 G3:2 A#3:2 | -:4 A3:2 C4:2 -:4 A3:2 C4:2 | -:4 G3:2 A#3:2 -:4 A3:2 C4:2',
      },
    ],
    drums: { kick: 'x-------x-------', snare: 'x---x-xxx---x-xx', hat: '----x-------x---', gain: 0.4 },
  },
  {
    id: 'musicbox',
    label: '오르골 왈츠',
    mood: '맑고 반짝이는 3박자',
    bpm: 108,
    stepsPerBeat: 2,
    voices: [
      {
        wave: 'sine',
        gain: 0.42,
        attack: 0.004,
        release: 0.7,
        decayTo: 0.25,
        octaveUp: 0.35,
        notes:
          'F#5:2 A5:2 D6:2 | C#6:2 A5:2 E5:2 | B5:2 G5:2 D5:2 | A5:3 G5:1 F#5:2 | F#5:2 A5:2 D6:2 | E6:2 C#6:2 A5:2 | G5:1 A5:1 B5:2 C#6:2 | D6:6 | ' +
          'B5:2 D6:2 G6:2 | F#6:2 D6:2 A5:2 | G5:2 B5:2 E6:2 | D6:3 C#6:1 B5:2 | A5:2 F#5:2 D5:2 | E5:2 G5:2 C#6:2 | D6:2 A5:2 F#5:2 | D5:6',
      },
      {
        wave: 'triangle',
        gain: 0.3,
        release: 0.5,
        decayTo: 0.3,
        notes:
          'D3:2 A3:2 F#4:2 | A2:2 A3:2 E4:2 | G2:2 B3:2 D4:2 | D3:2 A3:2 F#4:2 | D3:2 A3:2 F#4:2 | A2:2 A3:2 E4:2 | G2:2 B3:2 E4:2 | D3:2 A3:2 F#4:2 | ' +
          'G2:2 B3:2 D4:2 | D3:2 A3:2 F#4:2 | E3:2 B3:2 G4:2 | G2:2 B3:2 D4:2 | D3:2 A3:2 F#4:2 | A2:2 A3:2 E4:2 | D3:2 A3:2 F#4:2 | D3:2 A3:2 D4:2',
      },
    ],
  },
];

export const MUSIC_TRACKS: { id: TrackId; label: string; mood: string }[] = TRACKS.map(({ id, label, mood }) => ({ id, label, mood }));

// ---------------------------------------------------------------------------
// 악보 읽기
// ---------------------------------------------------------------------------
const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteToFrequency(name: string): number {
  const m = /^([A-G])(#?)(\d)$/.exec(name);
  if (!m) throw new Error(`음이름을 읽을 수 없어요: ${name}`);
  const midi = 12 * (Number(m[3]) + 1) + SEMITONE[m[1]] + (m[2] ? 1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
}

interface NoteEvent {
  freq: number;
  steps: number;
}

interface ParsedVoice {
  voice: Voice;
  length: number; // 스텝
  starts: Map<number, NoteEvent>;
}

function parseVoice(voice: Voice): ParsedVoice {
  const starts = new Map<number, NoteEvent>();
  let step = 0;
  for (const token of voice.notes.split(/\s+/)) {
    if (!token || token === '|') continue;
    const [name, len] = token.split(':');
    const steps = Number(len) || 1;
    if (name !== '-') starts.set(step, { freq: noteToFrequency(name), steps });
    step += steps;
  }
  return { voice, length: step, starts };
}

const parsedCache = new Map<TrackId, ParsedVoice[]>();
function parsedVoices(track: Track): ParsedVoice[] {
  let v = parsedCache.get(track.id);
  if (!v) {
    v = track.voices.map(parseVoice);
    parsedCache.set(track.id, v);
  }
  return v;
}

/** 검사용: 모든 곡의 악보가 읽히는지, 길이가 얼마인지. */
export function describeTracks(): { id: TrackId; label: string; steps: number[]; seconds: number }[] {
  return TRACKS.map((t) => {
    const steps = parsedVoices(t).map((v) => v.length);
    return { id: t.id, label: t.label, steps, seconds: (Math.max(...steps) * 60) / t.bpm / t.stepsPerBeat };
  });
}

// ---------------------------------------------------------------------------
// 설정 저장 (이 브라우저에만)
// ---------------------------------------------------------------------------
function loadPrefs(): MusicPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS };
    const track = TRACKS.some((t) => t.id === raw.track) ? (raw.track as TrackId) : DEFAULT_PREFS.track;
    const volume = Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, Number(raw.volume))) : DEFAULT_PREFS.volume;
    return { track, enabled: raw.enabled !== false, volume };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs: MusicPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 저장이 안 되면 이번 화면에서만 유지 */
  }
}

// ---------------------------------------------------------------------------
// 재생기
// ---------------------------------------------------------------------------
const LOOKAHEAD_S = 0.3; // 이만큼 앞의 음까지 미리 예약
const TIMER_MS = 70;

export interface MusicState extends MusicPrefs {
  active: boolean; // 호스트 화면이 음악을 틀어 달라고 한 상태
  blocked: boolean; // 브라우저가 아직 소리를 막고 있음 (화면을 한 번 눌러야 함)
}

class MusicPlayer {
  private prefs: MusicPrefs = loadPrefs();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private timer: number | null = null;
  private active = false;
  private step = 0;
  private nextTime = 0;
  private playing: TrackId | null = null;
  private listeners = new Set<() => void>();
  private snapshot: MusicState | null = null;
  private unlockBound = false;

  // ---- 구독 (React useSyncExternalStore 용) ----
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getState = (): MusicState => {
    if (!this.snapshot) {
      this.snapshot = { ...this.prefs, active: this.active, blocked: this.active && this.prefs.enabled && (!this.ctx || this.ctx.state !== 'running') };
    }
    return this.snapshot;
  };

  private changed() {
    this.snapshot = null;
    for (const fn of this.listeners) fn();
  }

  // ---- 설정 ----
  setTrack(track: TrackId) {
    this.prefs = { ...this.prefs, track, enabled: true };
    savePrefs(this.prefs);
    this.sync();
  }

  setEnabled(enabled: boolean) {
    this.prefs = { ...this.prefs, enabled };
    savePrefs(this.prefs);
    this.sync();
  }

  setVolume(volume: number) {
    this.prefs = { ...this.prefs, volume: Math.min(1, Math.max(0, volume)) };
    savePrefs(this.prefs);
    this.applyVolume();
    this.changed();
  }

  /** 호스트 화면이 열렸을 때: 저장된 곡을 튼다 (꺼 두었으면 조용히 있는다). */
  start() {
    this.active = true;
    this.sync();
  }

  /** 호스트 화면을 떠날 때. */
  stop() {
    this.active = false;
    this.sync();
  }

  // ---- 내부 ----
  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = 0;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.ratio.value = 8;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    ctx.addEventListener('statechange', () => this.changed());
    this.ctx = ctx;
    this.master = master;
    this.noise = noise;
    return ctx;
  }

  // 브라우저는 사용자가 화면을 누르기 전에는 소리를 막는다. 처음 누르거나 키를 칠 때 풀어 준다.
  private bindUnlock() {
    if (this.unlockBound) return;
    this.unlockBound = true;
    const unlock = () => {
      if (this.ctx && this.ctx.state === 'suspended' && this.active && this.prefs.enabled) void this.ctx.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  private applyVolume() {
    if (!this.ctx || !this.master) return;
    const on = this.active && this.prefs.enabled;
    const target = on ? this.prefs.volume ** 2 * MASTER_PEAK : 0;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.06);
  }

  private sync() {
    const shouldPlay = this.active && this.prefs.enabled;
    if (shouldPlay) {
      const ctx = this.ensureContext();
      if (ctx) {
        this.bindUnlock();
        if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
        if (this.playing !== this.prefs.track) {
          this.playing = this.prefs.track;
          this.step = 0;
          this.nextTime = ctx.currentTime + 0.12;
        }
        if (this.timer === null) this.timer = window.setInterval(() => this.schedule(), TIMER_MS);
      }
    } else {
      if (this.timer !== null) {
        window.clearInterval(this.timer);
        this.timer = null;
      }
      this.playing = null;
    }
    this.applyVolume();
    this.changed();
  }

  private schedule() {
    const ctx = this.ctx;
    const track = TRACKS.find((t) => t.id === this.playing);
    if (!ctx || !track || ctx.state !== 'running') return;
    const stepDur = 60 / track.bpm / track.stepsPerBeat;
    // 탭이 뒤에 있다가 돌아오면 밀린 음을 한꺼번에 내지 않고 지금부터 다시 센다.
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.05;
    const voices = parsedVoices(track);
    while (this.nextTime < ctx.currentTime + LOOKAHEAD_S) {
      for (const pv of voices) {
        const ev = pv.starts.get(this.step % pv.length);
        if (ev) this.playNote(pv.voice, ev.freq, this.nextTime, ev.steps * stepDur);
      }
      if (track.drums) this.playDrums(track.drums, this.step, this.nextTime);
      this.step += 1;
      this.nextTime += stepDur;
    }
  }

  private playNote(voice: Voice, freq: number, at: number, dur: number) {
    const ctx = this.ctx!;
    const attack = voice.attack ?? 0.008;
    const release = voice.release ?? 0.06;
    const holdEnd = at + Math.max(attack + 0.01, dur * (voice.hold ?? 0.92));
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(voice.gain, at + attack);
    env.gain.linearRampToValueAtTime(voice.gain * (voice.decayTo ?? 0.8), holdEnd);
    env.gain.exponentialRampToValueAtTime(0.0001, holdEnd + release);
    let out: AudioNode = env;
    if (voice.lowpass) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = voice.lowpass;
      env.connect(filter);
      out = filter;
    }
    out.connect(this.master!);
    const end = holdEnd + release + 0.02;
    const partials: [number, number][] = [[freq, 1]];
    if (voice.octaveUp) partials.push([freq * 2, voice.octaveUp]);
    for (const [f, level] of partials) {
      const osc = ctx.createOscillator();
      osc.type = voice.wave;
      osc.frequency.value = f;
      if (level === 1) osc.connect(env);
      else {
        const g = ctx.createGain();
        g.gain.value = level;
        osc.connect(g);
        g.connect(env);
      }
      osc.start(at);
      osc.stop(end);
    }
  }

  private playDrums(drums: Drums, step: number, at: number) {
    const hit = (pattern?: string) => !!pattern && pattern[step % pattern.length] === 'x';
    const level = drums.gain ?? 0.4;
    if (hit(drums.kick)) this.kick(at, level);
    if (hit(drums.snare)) this.noiseHit(at, level * 0.55, 1800, 0.11);
    if (hit(drums.hat)) this.noiseHit(at, level * 0.22, 7000, 0.035);
    if (hit(drums.tick)) this.tick(at, level * 0.5, Math.floor(step / 4) % 2 === 0 ? 1320 : 990);
  }

  private kick(at: number, level: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(130, at);
    osc.frequency.exponentialRampToValueAtTime(45, at + 0.12);
    env.gain.setValueAtTime(level, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    osc.connect(env);
    env.connect(this.master!);
    osc.start(at);
    osc.stop(at + 0.18);
  }

  private noiseHit(at: number, level: number, highpass: number, dur: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = highpass;
    const env = ctx.createGain();
    env.gain.setValueAtTime(level, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(filter);
    filter.connect(env);
    env.connect(this.master!);
    src.start(at, Math.random() * 0.5);
    src.stop(at + dur + 0.02);
  }

  private tick(at: number, level: number, freq: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(level, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(env);
    env.connect(this.master!);
    osc.start(at);
    osc.stop(at + 0.07);
  }

  // ---- 효과음 (정답 공개 반응) ----
  // 배경 음악과 같은 master 를 거치므로 소리 크기 설정을 그대로 따른다.
  // 음악이 꺼져 있거나(끄기), 소리 크기가 0 이거나, 이 기기가 소리를 내는 화면이 아니면 나지 않는다.
  // 음원은 전부 여기서 Web Audio 로 직접 합성한다 (외부 파일 없음).
  private sfxCount = 0;

  /** 지금 효과음을 낼 수 있는 상태인지 (배경 음악 설정을 따른다). */
  canPlaySfx(): boolean {
    return this.active && this.prefs.enabled && this.prefs.volume > 0 && !!this.ctx && !!this.master && this.ctx.state === 'running';
  }

  /** cheer = 짧은 환호(올라가는 팡파르 + 반짝이), aww = 짧은 아쉬움(내려가는 소리). */
  playSfx(kind: SfxKind, delayS = 0): boolean {
    if (!this.canPlaySfx()) return false;
    const ctx = this.ctx!;
    const at = ctx.currentTime + 0.03 + Math.max(0, delayS);
    if (kind === 'cheer') {
      // 도-미-솔-도 로 뛰어오르는 짧은 팡파르
      const notes: [number, number, number][] = [
        [523.25, 0, 0.09],
        [659.25, 0.09, 0.09],
        [783.99, 0.18, 0.09],
        [1046.5, 0.27, 0.3],
      ];
      for (const [freq, offset, dur] of notes) {
        this.sfxTone('square', freq, freq, at + offset, dur, 0.16, 2600);
        this.sfxTone('triangle', freq * 2, freq * 2, at + offset, dur, 0.1);
      }
      // 반짝이: 높은 음 두 번 + 짧은 박수 같은 잡음
      this.sfxTone('sine', 2093, 2093, at + 0.4, 0.12, 0.1);
      this.sfxTone('sine', 2637, 2637, at + 0.5, 0.18, 0.09);
      this.noiseHit(at + 0.27, 0.12, 5000, 0.22);
    } else {
      // "으응…" 하고 미끄러져 내려가는 두 음
      this.sfxTone('triangle', 392, 349.23, at, 0.2, 0.26, 1400);
      this.sfxTone('triangle', 311.13, 233.08, at + 0.22, 0.42, 0.26, 1200);
      this.sfxTone('sine', 155.56, 116.54, at + 0.22, 0.42, 0.16);
    }
    this.sfxCount += 1;
    return true;
  }

  private sfxTone(wave: OscillatorType, from: number, to: number, at: number, dur: number, level: number, lowpass?: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(from, at);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + dur);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(level, at + 0.012);
    env.gain.linearRampToValueAtTime(level * 0.7, at + dur * 0.7);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.06);
    osc.connect(env);
    if (lowpass) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = lowpass;
      env.connect(filter);
      filter.connect(this.master!);
    } else {
      env.connect(this.master!);
    }
    osc.start(at);
    osc.stop(at + dur + 0.1);
  }

  /** 검사용: 지금 실제로 소리를 예약하고 있는지. */
  debug() {
    return {
      contextState: this.ctx?.state ?? 'none',
      playing: this.playing,
      step: this.step,
      masterGain: this.master?.gain.value ?? 0,
      timerOn: this.timer !== null,
      sfxCount: this.sfxCount,
    };
  }
}

export const music = new MusicPlayer();
