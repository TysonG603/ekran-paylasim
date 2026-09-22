const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// roomId -> { host: socketId|null, guest: socketId|null }
const rooms = new Map();

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomId() {
  let id;
  do {
    id = Array.from({ length: 6 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function cleanupSocket(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (room) {
    socket.to(roomId).emit('peer-left');
    if (room.host === socket.id) {
      rooms.delete(roomId);
    } else if (room.guest === socket.id) {
      room.guest = null;
    }
  }
  socket.data.roomId = null;
  socket.data.role = null;
}

io.on('connection', (socket) => {
  socket.on('create-room', (cb) => {
    const roomId = generateRoomId();
    rooms.set(roomId, { host: socket.id, guest: null });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'host';
    cb({ ok: true, roomId });
  });

  socket.on('join-room', (rawRoomId, cb) => {
    const roomId = String(rawRoomId || '').toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room) {
      cb({ ok: false, error: 'Oda bulunamadi. Kodu kontrol et.' });
      return;
    }
    if (room.guest) {
      cb({ ok: false, error: 'Bu oda zaten dolu.' });
      return;
    }
    room.guest = socket.id;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'guest';
    cb({ ok: true, roomId });
    socket.to(roomId).emit('peer-joined');
  });

  socket.on('signal', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('signal', data);
  });

  socket.on('chat', (text) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof text !== 'string') return;
    const trimmed = text.slice(0, 1000).trim();
    if (!trimmed) return;
    io.to(roomId).emit('chat', { text: trimmed, sender: socket.data.role, ts: Date.now() });
  });

  socket.on('leave-room', () => cleanupSocket(socket));
  socket.on('disconnect', () => cleanupSocket(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sunucu calisiyor: http://localhost:${PORT}`);
});
