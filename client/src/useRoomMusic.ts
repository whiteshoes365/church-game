import { useEffect, useRef } from 'react';
import { gameSocket } from './ws';
import { music, type TrackId } from './music';
import type { RoomMusic, RoomSnapshot } from './protocol';

// 방의 배경 음악 선택(서버가 기억)과 이 기기의 음악 재생기를 맞춘다.
//  - 서버 값이 바뀌면(리모컨이 곡·소리 크기를 바꿈) 이 기기 재생기에 반영한다.
//  - publish: 이 화면의 음악 고르기(진행자 화면)에서 바꾼 값을 서버에 알린다.
//  - play: 이 기기에서 실제로 소리를 낼지. 송출 화면은 항상, 진행자 화면은 송출 화면이 없을 때만.
// 휴대폰 리모컨은 이 훅을 쓰지 않는다 (소리를 내지 않고 명령만 보낸다).
const ECHO_GUARD_MS = 700; // 방금 이 화면에서 바꾼 직후에 오는 예전 값은 무시한다 (슬라이더가 튀지 않게)

function sameMusic(a: RoomMusic, b: { track: string; enabled: boolean; volume: number }) {
  return a.track === b.track && a.enabled === b.enabled && Math.abs(a.volume - b.volume) < 0.005;
}

export function useRoomMusic(room: RoomSnapshot | null, { play, publish }: { play: boolean; publish: boolean }) {
  const roomId = room?.id;
  const serverMusic = room?.music;
  const serverRef = useRef<RoomMusic | undefined>(serverMusic);
  serverRef.current = serverMusic;
  const applying = useRef(false);
  const lastLocalAt = useRef(0);

  // 서버 → 이 기기
  const signature = serverMusic ? `${serverMusic.track}|${serverMusic.enabled}|${serverMusic.volume}` : '';
  useEffect(() => {
    const target = serverRef.current;
    if (!target) return;
    const apply = () => {
      const want = serverRef.current;
      if (!want || sameMusic(want, music.getState())) return;
      applying.current = true;
      try {
        if (music.getState().track !== want.track) music.setTrack(want.track as TrackId);
        if (music.getState().enabled !== want.enabled) music.setEnabled(want.enabled);
        if (Math.abs(music.getState().volume - want.volume) >= 0.005) music.setVolume(want.volume);
      } finally {
        applying.current = false;
      }
    };
    const wait = lastLocalAt.current + ECHO_GUARD_MS - Date.now();
    if (wait <= 0) {
      apply();
      return;
    }
    const id = setTimeout(apply, wait);
    return () => clearTimeout(id);
  }, [signature]);

  // 이 기기 → 서버
  useEffect(() => {
    if (!publish || !roomId) return;
    return music.subscribe(() => {
      if (applying.current) return;
      const local = music.getState();
      const server = serverRef.current;
      if (server && sameMusic(server, local)) return;
      lastLocalAt.current = Date.now();
      gameSocket.send('setMusic', { roomId, track: local.track, enabled: local.enabled, volume: local.volume });
    });
  }, [publish, roomId]);

  // 소리 내기
  const loaded = !!room;
  useEffect(() => {
    if (!loaded || !play) return;
    music.start();
    return () => music.stop();
  }, [loaded, play]);
}
