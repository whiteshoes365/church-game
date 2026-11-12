import { Navigate, Route, Routes } from 'react-router-dom';
import { PlayerJoin } from './pages/PlayerJoin';
import { PlayerRooms } from './pages/PlayerRooms';
import { PlayerRoom } from './pages/PlayerRoom';
import { HostHome } from './pages/HostHome';
import { HostRooms } from './pages/HostRooms';
import { HostRoom } from './pages/HostRoom';
import { HostGroup } from './pages/HostGroup';
import { PlayerShop } from './pages/PlayerShop';
import { JoinByCode } from './pages/JoinByCode';
import { DisplayRoom } from './pages/DisplayRoom';
import { RemoteRoom } from './pages/RemoteRoom';
import { Legal } from './pages/Legal';
import { QuestionReview } from './pages/QuestionReview';
import { ServerWakeNotice } from './components/ServerWakeNotice';

export default function App() {
  return (
    <>
      <ServerWakeNotice />
      <Routes>
      <Route path="/" element={<PlayerJoin />} />
      <Route path="/j/:code" element={<JoinByCode />} />
      <Route path="/rooms/:churchId" element={<PlayerRooms />} />
      <Route path="/play/:roomId" element={<PlayerRoom />} />
      <Route path="/shop" element={<PlayerShop />} />
      <Route path="/host" element={<HostHome />} />
      <Route path="/host/rooms/:churchId" element={<HostRooms />} />
      <Route path="/host/room/:roomId" element={<HostRoom />} />
      <Route path="/host/group/:code" element={<HostGroup />} />
      <Route path="/display" element={<DisplayRoom />} />
      <Route path="/display/:roomId" element={<DisplayRoom />} />
      <Route path="/remote/pair/:pairCode" element={<RemoteRoom />} />
      <Route path="/remote/:codeOrId" element={<RemoteRoom />} />
      <Route path="/review" element={<QuestionReview />} />
      <Route path="/privacy" element={<Legal tab="privacy" />} />
      <Route path="/terms" element={<Legal tab="terms" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
