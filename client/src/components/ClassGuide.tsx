// "오늘 수업" 3단계와 아주 짧은 도움말 (호스트 홈 · 송출 시작 화면 공용).
// 긴 가이드는 앱 안에 복제하지 않는다.
export function ClassGuide({ className = '' }: { className?: string }) {
  return (
    <section className={`class-guide card ${className}`} aria-label="오늘 수업 순서">
      <h2 className="card-title">
        <span className="title-block block-gold" aria-hidden />
        오늘 수업, 3단계
      </h2>
      <ol className="class-guide-steps">
        <li>
          <b>송출 PC 열기</b>
          <span>프로젝터·TV에 연결한 PC에서 송출 화면을 열어요.</span>
        </li>
        <li>
          <b>방 만들거나 짝 코드로 연결</b>
          <span>송출 PC에서 바로 방을 만들거나, 폰·진행자 화면에서 만든 방을 짝 코드 6자리로 연결해요.</span>
        </li>
        <li>
          <b>학생은 QR 또는 방 코드 + PIN</b>
          <span>송출 화면의 QR을 찍거나, 학생 첫 화면에 입장 코드와 방 PIN을 넣어요.</span>
        </li>
      </ol>
      <p className="fine-print class-guide-warn">
        <b>진행자 비밀번호와 방 PIN은 서로 달라요.</b> 방 PIN은 학생에게 알려 주고, 진행자 비밀번호는 선생님만 알고 계세요.
      </p>
      <details className="class-guide-help">
        <summary>짧은 도움말</summary>
        <ul>
          <li>
            <b>방 PIN</b> (숫자 4자리) — 학생 입장용. 송출 화면에 크게 보여요.
          </li>
          <li>
            <b>진행자 비밀번호</b> (영문·숫자 4~12자) — 폰 리모컨·진행자 화면용. 학생에게 보여 주지 마세요.
          </li>
          <li>
            <b>교사 PIN</b> (숫자 4~8자리) — 반 출석·달란트 장부용. 방마다가 아니라 반마다 하나예요.
          </li>
          <li>
            <b>서버 대기</b> — 한동안 안 쓰던 서버는 첫 접속에 최대 1분 정도 걸릴 수 있어요. 수업 시작 몇 분 전에 미리 열어 두세요.
          </li>
        </ul>
      </details>
    </section>
  );
}
