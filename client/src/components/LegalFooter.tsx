// 화면 바닥글: 개인정보처리방침 · 이용 안내 · 문의 메일 링크.
// newTab: 입력 중인 화면(닉네임·아바타 고르기 등)에서는 새 탭으로 열어 입력이 사라지지 않게 한다.
import { Link } from 'react-router-dom';
import { CONTACT_EMAIL, CONTACT_MAILTO } from '../contact';

export function LegalFooter({ newTab = false, className = '' }: { newTab?: boolean; className?: string }) {
  const extra = newTab ? { target: '_blank', rel: 'noreferrer' } : {};
  return (
    <footer className={`legal-footer ${className}`}>
      <Link to="/privacy" {...extra}>
        개인정보처리방침
      </Link>
      <span aria-hidden> · </span>
      <Link to="/terms" {...extra}>
        이용 안내
      </Link>
      <span aria-hidden> · </span>
      <a href={CONTACT_MAILTO} className="legal-footer-mail">
        문의 {CONTACT_EMAIL}
      </a>
    </footer>
  );
}
