import { useSyncExternalStore } from 'react';
import { music, MUSIC_TRACKS, type TrackId } from '../music';

export function useMusicState() {
  return useSyncExternalStore(music.subscribe, music.getState, music.getState);
}

function VolumeSlider({ volume }: { volume: number }) {
  const percent = Math.round(volume * 100);
  return (
    <label className="music-volume">
      <span className="music-volume-label">소리 크기</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        aria-label="배경 음악 소리 크기"
        onChange={(e) => music.setVolume(Number(e.target.value) / 100)}
      />
      <span className="music-volume-value">{percent}%</span>
    </label>
  );
}

interface Props {
  /** 방 만들기 화면: 고르기만 하고, 「미리 듣기」를 눌러야 소리가 난다. */
  preview?: boolean;
  /** 진행 중 화면 머리줄에 넣는 한 줄짜리. */
  compact?: boolean;
}

/** 배경 음악 고르기: 곡 선택 · 음악 끄기 · 소리 크기. 선택은 이 브라우저에 기억된다. */
export function MusicPicker({ preview = false, compact = false }: Props) {
  const state = useMusicState();

  if (compact) {
    return (
      <div className="music-mini" aria-label="배경 음악">
        <span className="music-mini-label">음악</span>
        <select
          className="music-mini-select"
          aria-label="배경 음악 고르기"
          value={state.enabled ? state.track : 'off'}
          onChange={(e) => (e.target.value === 'off' ? music.setEnabled(false) : music.setTrack(e.target.value as TrackId))}
        >
          {MUSIC_TRACKS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
          <option value="off">음악 끄기</option>
        </select>
        <input
          className="music-mini-range"
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(state.volume * 100)}
          aria-label="배경 음악 소리 크기"
          onChange={(e) => music.setVolume(Number(e.target.value) / 100)}
        />
        <span className="music-mini-value">{Math.round(state.volume * 100)}%</span>
      </div>
    );
  }

  return (
    <div className="music-picker">
      <div className="music-picker-head">
        <b>배경 음악</b>
        {preview ? (
          <button type="button" className={`chip ${state.active ? 'on' : ''}`} disabled={!state.enabled} onClick={() => (state.active ? music.stop() : music.start())}>
            {state.active ? '미리 듣기 멈춤' : '미리 듣기'}
          </button>
        ) : (
          <span className={`music-now ${state.enabled ? 'on' : ''}`}>{state.enabled ? '켜짐' : '꺼짐'}</span>
        )}
      </div>
      <div className="music-tracks">
        {MUSIC_TRACKS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`music-track ${state.enabled && state.track === t.id ? 'selected' : ''}`}
            title={t.mood}
            aria-pressed={state.enabled && state.track === t.id}
            onClick={() => music.setTrack(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button type="button" className={`music-track music-off ${state.enabled ? '' : 'selected'}`} aria-pressed={!state.enabled} onClick={() => music.setEnabled(false)}>
          음악 끄기
        </button>
      </div>
      <VolumeSlider volume={state.volume} />
      {state.blocked && !preview && <p className="fine-print music-hint">화면을 한 번 누르면 음악이 시작돼요.</p>}
      <p className="fine-print music-hint">
        {preview ? '고른 음악은 방을 열면 선생님 화면에서 나와요. 대기실에서도 바꿀 수 있어요.' : '음악은 이 화면(선생님 기기)에서만 나와요. 학생 폰에서는 나지 않아요.'}
      </p>
    </div>
  );
}
