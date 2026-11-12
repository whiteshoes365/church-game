// 개인정보처리방침 · 이용 안내 (한 페이지, 탭 두 개). 라우트: /#/privacy, /#/terms
// 실제 동작과 다르게 쓰지 않는다. 문의는 CONTACT_EMAIL(mailto)로 받는다.
import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CONTACT_EMAIL, CONTACT_MAILTO } from '../contact';

const UPDATED = '2026년 11월 12일';

function ContactLink() {
  return (
    <a href={CONTACT_MAILTO} className="legal-mailto">
      {CONTACT_EMAIL}
    </a>
  );
}

function Privacy() {
  return (
    <article className="legal-body">
      <p className="legal-lead">
        교회학교 게임 플랫폼(베타)은 수업 시간에 쓰는 OX 퀴즈 도구예요. 꼭 필요한 정보만 다루고, 무엇을 다루는지 아래에 그대로 적었어요.
      </p>
      <p>
        <b>베타 기간 무료:</b> 베타 기간에는 결제나 유료 기능이 없고, 서버도 무료로 운영해요.
      </p>

      <h2>1. 학생은 계정을 만들지 않아요</h2>
      <p>학생은 회원가입·로그인 없이 방 코드(또는 QR)와 방 PIN으로 들어와요. 아이디·비밀번호를 만들지 않아요.</p>

      <h2>2. 다루는 정보</h2>
      <ul>
        <li>
          <b>닉네임</b> (최대 12자) — 게임 화면과 점수판, 반 장부에 표시해요. 실명 대신 별명을 쓰도록 안내해요.
        </li>
        <li>
          <b>블록 아바타</b> — 고른 피부색·옷 색·모자와 상점에서 얻은 꾸미기 아이템.
        </li>
        <li>
          <b>기기 식별값</b> — 브라우저에 저장되는 임의의 값이에요. 같은 기기인지 알아보는 데만 쓰고(출석, 상점 아이템이 내 것인지 확인), 사람이나 전화번호와 연결되지 않아요. 반 장부에는 원래 값이 아니라 변환한 값만 남겨요.
        </li>
        <li>
          <b>반 기록</b> (반이 연결된 방에서만) — 닉네임별 출석 주차, 달란트 적립·사용 내역, 게임 점수.
        </li>
      </ul>
      <p>
        <b>받지 않는 정보:</b> 실명, 전화번호, 이메일, 생일, 주소, 사진, 위치 정보는 받지 않아요. 입력하는 칸도 없어요.
      </p>

      <h2>3. 어디에 남나요</h2>
      <ul>
        <li>반이 연결되지 않은 방은 게임이 진행되는 동안 서버 메모리에만 있고, 장부에 남지 않아요.</li>
        <li>선생님이 반(반 코드 + 교사 PIN)을 연결한 방에서만 출석·달란트 장부가 저장소(로컬 또는 운영 저장소)에 남아요.</li>
        <li>기기 식별값, 마지막으로 쓴 반 코드·닉네임 같은 편의 설정은 그 기기의 브라우저에만 저장돼요.</li>
      </ul>

      <h2>4. 쓰는 목적</h2>
      <p>게임 진행(입장·점수·순위), 반 출석과 달란트 관리, 상점 아이템 소유 확인. 이 밖의 용도로 쓰지 않아요.</p>

      <h2>5. 광고·추적·제3자 제공</h2>
      <p>광고가 없어요. 외부 추적 도구(분석·광고 식별자)를 쓰지 않아요. 마케팅 목적으로 제3자에게 정보를 주거나 팔지 않아요.</p>

      <h2>6. 만 14세 미만 어린이</h2>
      <p>
        만 14세 미만 어린이를 포함해 학생에게는 계정이 없고, 선생님이 수업을 진행해요. 법정대리인의 동의·확인이 필요한 개인정보 처리가 생기지 않도록 계정형 가입을 받지 않아요. 닉네임에는 실명이나 연락처를 쓰지 않도록 선생님이 지도해 주세요.
      </p>

      <h2>7. 보유 기간</h2>
      <p>반 장부가 유지되는 동안 보관해요. 반이 연결되지 않은 방의 정보는 방이 닫히면 남지 않아요.</p>

      <h2>8. 삭제·정정</h2>
      <ul>
        <li>선생님이 반 장부에서 출석 취소, 달란트 정정, 닉네임과 기기의 연결 해제를 직접 할 수 있어요.</li>
        <li>
          한 학생의 기록 전체 삭제처럼 장부에서 바로 할 수 없는 것은 <ContactLink />로 운영자에게 요청할 수 있어요.
        </li>
        <li>기기에 저장된 값은 브라우저의 사이트 데이터 삭제로 지울 수 있어요.</li>
      </ul>

      <h2>9. 문의</h2>
      <p>
        문의는 <ContactLink />로 보내 주세요.
      </p>

      <p className="legal-updated">시행일: {UPDATED} (베타). 내용이 바뀌면 이 페이지에 알려요.</p>
    </article>
  );
}

function Terms() {
  return (
    <article className="legal-body">
      <p className="legal-lead">교회학교 수업에서 선생님과 학생이 함께 쓰는 OX 퀴즈 게임이에요. 지금은 베타예요.</p>

      <h2>1. 누가 어떻게 쓰나요</h2>
      <ul>
        <li>
          <b>선생님</b>이 방을 만들고 수업을 진행해요. 송출 PC, 폰 리모컨, 진행자 화면을 쓸 수 있어요.
        </li>
        <li>
          <b>학생</b>은 계정 없이 QR 또는 방 코드와 방 PIN으로 들어와 닉네임과 블록 아바타를 골라요.
        </li>
      </ul>

      <h2>2. 지켜 주세요</h2>
      <ul>
        <li>닉네임에 실명·전화번호 같은 개인정보나 남을 불쾌하게 하는 말을 쓰지 않아요.</li>
        <li>진행자 비밀번호와 교사 PIN은 선생님만 알고, 학생에게는 방 PIN만 알려 주세요.</li>
        <li>다른 사람의 닉네임으로 들어가거나 수업을 방해하지 않아요. 선생님은 참가자를 내보낼 수 있어요.</li>
      </ul>

      <h2>3. 달란트와 상점</h2>
      <p>달란트는 게임 안에서 블록 캐릭터를 꾸미는 데만 쓰는 점수예요. 돈으로 사거나 바꿀 수 없고, 실제 상품 교환이 아니에요.</p>

      <h2>4. 베타 서비스</h2>
      <ul>
        <li>베타 기간에는 결제나 유료 기능이 없고 무료로 쓸 수 있어요. 서버도 무료로 운영해요.</li>
        <li>기능과 화면이 예고 없이 바뀌거나 잠시 멈출 수 있어요.</li>
        <li>한동안 안 쓰던 서버는 첫 접속에 최대 1분 정도 걸릴 수 있어요.</li>
        <li>반이 연결되지 않은 방의 점수는 방이 닫히면 남지 않아요.</li>
      </ul>

      <h2>5. 개인정보</h2>
      <p>
        다루는 정보와 보관 방법은 <Link to="/privacy">개인정보처리방침</Link>에 적었어요.
      </p>

      <h2>6. 문의</h2>
      <p>
        문의는 <ContactLink />로 보내 주세요.
      </p>

      <p className="legal-updated">안내일: {UPDATED} (베타)</p>
    </article>
  );
}

export function Legal({ tab }: { tab: 'privacy' | 'terms' }) {
  const navigate = useNavigate();

  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = tab === 'privacy' ? '개인정보처리방침 · 교회학교 게임 플랫폼' : '이용 안내 · 교회학교 게임 플랫폼';
    return () => {
      document.title = '교회학교 게임 플랫폼';
    };
  }, [tab]);

  return (
    <div className="screen legal-screen">
      <div className="legal-wrap stack">
        <h1 className="title">{tab === 'privacy' ? '개인정보처리방침' : '이용 안내'}</h1>
        <nav className="legal-tabs" aria-label="안내 종류">
          <Link to="/privacy" replace className={`legal-tab ${tab === 'privacy' ? 'on' : ''}`} aria-current={tab === 'privacy' ? 'page' : undefined}>
            개인정보처리방침
          </Link>
          <Link to="/terms" replace className={`legal-tab ${tab === 'terms' ? 'on' : ''}`} aria-current={tab === 'terms' ? 'page' : undefined}>
            이용 안내
          </Link>
        </nav>
        <div className="card">{tab === 'privacy' ? <Privacy /> : <Terms />}</div>
        <div className="row legal-actions">
          <button className="btn" type="button" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}>
            이전 화면으로
          </button>
          <button className="btn" type="button" onClick={() => navigate('/')}>
            처음 화면
          </button>
        </div>
      </div>
    </div>
  );
}
