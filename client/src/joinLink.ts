// 학생 입장 주소 · 리모컨 주소 만들기.
// 앱이 HashRouter 를 쓰므로 주소는 항상 <사이트 주소>/#<경로> 꼴이다.
//   학생 입장 QR : https://church-game.onrender.com/#/j/ABCDE?p=1234   (입장 코드 + 방 PIN)
//   글자 주소    : church-game.onrender.com/#/j/ABCDE                  (방 PIN 은 따로 입력)
//   리모컨       : https://church-game.onrender.com/#/remote/ABCDE     (진행자 비밀번호 필요)
import type { RoomSnapshot } from './protocol';

/** 지금 이 앱이 열려 있는 사이트 주소 (해시 앞부분). */
export function appBase(): string {
  return `${location.origin}${location.pathname}`;
}

export function hashUrl(path: string, base: string = appBase()): string {
  return `${base}#${path}`;
}

/** 화면에 글자로 보여 줄 때는 https:// 를 떼서 짧게. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/** QR 에 넣는 학생 입장 주소 (방 PIN 포함). 서버가 준 경로를 그대로 쓴다. */
export function joinQrUrl(room: Pick<RoomSnapshot, 'joinPath'>): string | null {
  return room.joinPath ? hashUrl(room.joinPath) : null;
}

/** 글자로 보여 주는 학생 입장 주소 (방 PIN 없음). */
export function joinTextUrl(room: Pick<RoomSnapshot, 'joinPathNoPin'>): string | null {
  return room.joinPathNoPin ? displayUrl(hashUrl(room.joinPathNoPin)) : null;
}

/** 선생님 휴대폰 리모컨 주소 (비밀번호·PIN 은 넣지 않는다). */
export function remoteUrl(room: Pick<RoomSnapshot, 'joinCode' | 'id'>): string {
  return hashUrl(`/remote/${room.joinCode ?? room.id}`);
}

/** PC 송출 화면이 띄우는 연결 QR: 선생님 휴대폰이 찍으면 리모컨에서 연결을 확인한다. */
export function pairUrl(code: string): string {
  return hashUrl(`/remote/pair/${code}`);
}
