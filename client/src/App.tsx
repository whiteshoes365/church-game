import { Navigate, Route, Routes } from 'react-router-dom';
import { PlayerJoin } from './pages/PlayerJoin';
import { PlayerRooms } from './pages/PlayerRooms';
import { PlayerRoom } from './pages/PlayerRoom';
import { HostHome } from './pages/HostHome';
import { HostRooms } from './pages/HostRooms';
import { HostRoom } from './pages/HostRoom';
import { HostGroup } from './pages/HostGroup';
import { PlayerShop } from './pages/PlayerShop';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PlayerJoin />} />
      <Route path="/rooms/:churchId" element={<PlayerRooms />} />
      <Route path="/play/:roomId" element={<PlayerRoom />} />
      <Route path="/shop" element={<PlayerShop />} />
      <Route path="/host" element={<HostHome />} />
      <Route path="/host/rooms/:churchId" element={<HostRooms />} />
      <Route path="/host/room/:roomId" element={<HostRoom />} />
      <Route path="/host/group/:code" element={<HostGroup />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
