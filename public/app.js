const socket = io();

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
];

// ---- DOM ----
const landingEl = document.getElementById('landing');
const roomEl = document.getElementById('room');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const roomCodeInput = document.getElementById('roomCodeInput');
const landingError = document.getElementById('landingError');

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const roomCodeBox = document.getElementById('roomCodeBox');
const roomCodeText = document.getElementById('roomCodeText');
const copyBtn = document.getElementById('copyBtn');
const leaveBtn = document.getElementById('leaveBtn');

const remoteVideo = document.getElementById('remoteVideo');
const localPreviewBox = document.getElementById('localPreviewBox');
const localPreview = document.getElementById('localPreview');
const waitingMsg = document.getElementById('waitingMsg');

const chatPanel = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendChatBtn = document.getElementById('sendChatBtn');
const closeChatBtn = document.getElementById('closeChatBtn');
const toggleChatBtn = document.getElementById('toggleChatBtn');

const micBtn = document.getElementById('micBtn');
const stopShareBtn = document.getElementById('stopShareBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');

// ---- State ----
let role = null; // 'host' | 'guest'
let roomId = null;
let pc = null;
let screenStream = null;
let micStream = null;
let remoteStream = new MediaStream();
let pendingCandidates = [];

// ---- Landing actions ----

createBtn.addEventListener('click', async () => {
  clearError();
  setButtonsDisabled(true);
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    showError('Ekran paylaşımı izni alınamadı: ' + err.message);
    setButtonsDisabled(false);
    return;
  }

  // Kendi paylaştığın ekranı hemen göster (mikrofon durumundan bağımsız).
  localPreview.srcObject = screenStream;
  localPreviewBox.hidden = false;

  micStream = await tryGetMic();

  screenStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (role === 'host') stopScreenShareAndLeave();
  });

  socket.emit('create-room', (res) => {
    setButtonsDisabled(false);
    if (!res.ok) {
      showError('Oda oluşturulamadı, tekrar dene.');
      cleanupLocalStreams();
      return;
    }
    role = 'host';
    roomId = res.roomId;
    enterRoomUI();
    roomCodeBox.hidden = false;
    roomCodeText.textContent = roomId;
    stopShareBtn.hidden = false;
    updateMicButtonState();
    if (!micStream) addSystemMessage('Mikrofon bulunamadı, sadece ekran paylaşımı aktif.');
    if (screenStream.getAudioTracks().length === 0) {
      addSystemMessage('Sistem sesi paylaşılmadı: paylaşım penceresinde "Ses paylaş / Share audio" kutucuğunu işaretlemeyi unuttun. Tekrar denemek için paylaşımı durdurup yeniden başlat.');
    }
    setStatus('waiting', 'Arkadaşının katılması bekleniyor...');
  });
});

async function tryGetMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    console.warn('Mikrofon alınamadı:', err.message);
    return null;
  }
}

joinBtn.addEventListener('click', () => doJoin());
roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doJoin();
});

async function doJoin() {
  clearError();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (code.length < 4) {
    showError('Geçerli bir oda kodu gir.');
    return;
  }
  setButtonsDisabled(true);
  micStream = await tryGetMic();

  socket.emit('join-room', code, (res) => {
    setButtonsDisabled(false);
    if (!res.ok) {
      showError(res.error || 'Katılınamadı.');
      cleanupLocalStreams();
      return;
    }
    role = 'guest';
    roomId = res.roomId;
    enterRoomUI();
    updateMicButtonState();
    if (!micStream) addSystemMessage('Mikrofon bulunamadı, sadece izleyip yazabilirsin.');
    setStatus('waiting', 'Ekran paylaşımı bekleniyor...');
  });
}

// ---- WebRTC ----

socket.on('peer-joined', () => {
  if (role === 'host') startCallAsHost();
});

async function startCallAsHost() {
  setStatus('waiting', 'Bağlantı kuruluyor...');
  pc = createPeerConnection();
  screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));
  if (micStream) micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { type: 'offer', sdp: pc.localDescription });
}

socket.on('signal', async (data) => {
  if (data.type === 'offer') {
    pc = createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await flushCandidates();
    if (micStream) micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { type: 'answer', sdp: pc.localDescription });
  } else if (data.type === 'answer') {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await flushCandidates();
  } else if (data.type === 'candidate') {
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) { /* ignore */ }
    } else {
      pendingCandidates.push(data.candidate);
    }
  }
});

async function flushCandidates() {
  const queued = pendingCandidates;
  pendingCandidates = [];
  for (const c of queued) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    } catch (e) { /* ignore */ }
  }
}

function createPeerConnection() {
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  conn.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { type: 'candidate', candidate: e.candidate });
    }
  };

  conn.ontrack = (e) => {
    remoteStream.addTrack(e.track);
    remoteVideo.srcObject = remoteStream;
    waitingMsg.hidden = true;
  };

  conn.onconnectionstatechange = () => {
    if (conn.connectionState === 'connected') {
      setStatus('connected', 'Bağlandı');
    } else if (['disconnected', 'failed'].includes(conn.connectionState)) {
      setStatus('disconnected', 'Bağlantı koptu');
    } else if (conn.connectionState === 'connecting') {
      setStatus('waiting', 'Bağlanıyor...');
    }
  };

  return conn;
}

socket.on('peer-left', () => {
  addSystemMessage('Karşı taraf odadan ayrıldı.');
  setStatus('disconnected', 'Karşı taraf ayrıldı');
  waitingMsg.textContent = 'Karşı taraf ayrıldı.';
  waitingMsg.hidden = false;
  remoteVideo.srcObject = null;
  remoteStream = new MediaStream();
  if (pc) {
    pc.close();
    pc = null;
  }
});

// ---- Controls ----

micBtn.addEventListener('click', () => {
  if (!micStream) return;
  const track = micStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micBtn.textContent = track.enabled ? '🎤 Mikrofon' : '🔇 Mikrofon Kapalı';
  micBtn.classList.toggle('active-off', !track.enabled);
});

function updateMicButtonState() {
  if (!micStream) {
    micBtn.disabled = true;
    micBtn.textContent = '🔇 Mikrofon Yok';
    micBtn.classList.add('active-off');
  } else {
    micBtn.disabled = false;
    micBtn.textContent = '🎤 Mikrofon';
    micBtn.classList.remove('active-off');
  }
}

function isFullscreenActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

fullscreenBtn.addEventListener('click', async () => {
  const el = remoteVideo;
  if (!isFullscreenActive()) {
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else if (el.webkitEnterFullscreen) el.webkitEnterFullscreen(); // iOS Safari
      else if (el.msRequestFullscreen) el.msRequestFullscreen();
    } catch (e) { /* ignore */ }
    try {
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape');
      }
    } catch (e) { /* not supported/allowed, ignore */ }
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
});

function updateFullscreenBtnIcon() {
  fullscreenBtn.textContent = isFullscreenActive() ? '✕' : '⛶';
}
document.addEventListener('fullscreenchange', updateFullscreenBtnIcon);
document.addEventListener('webkitfullscreenchange', updateFullscreenBtnIcon);

stopShareBtn.addEventListener('click', () => stopScreenShareAndLeave());

function stopScreenShareAndLeave() {
  addSystemMessage('Ekran paylaşımını durdurdun.');
  leaveRoom();
}

leaveBtn.addEventListener('click', () => leaveRoom());

function leaveRoom() {
  socket.emit('leave-room');
  if (pc) {
    pc.close();
    pc = null;
  }
  cleanupLocalStreams();
  remoteStream = new MediaStream();
  remoteVideo.srcObject = null;
  localPreview.srcObject = null;
  localPreviewBox.hidden = true;
  role = null;
  roomId = null;
  pendingCandidates = [];
  chatMessages.innerHTML = '';
  roomCodeBox.hidden = true;
  stopShareBtn.hidden = true;
  micBtn.disabled = false;
  micBtn.textContent = '🎤 Mikrofon';
  micBtn.classList.remove('active-off');
  showLanding();
}

function cleanupLocalStreams() {
  [screenStream, micStream].forEach((s) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  });
  screenStream = null;
  micStream = null;
}

// ---- Chat ----

toggleChatBtn.addEventListener('click', () => {
  chatPanel.hidden = !chatPanel.hidden;
});
closeChatBtn.addEventListener('click', () => {
  chatPanel.hidden = true;
});

sendChatBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat', text);
  chatInput.value = '';
}

socket.on('chat', ({ text, sender }) => {
  addMessage(text, sender === role ? 'me' : 'peer');
});

function addMessage(text, kind) {
  const div = document.createElement('div');
  div.className = `chat-msg ${kind}`;
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ---- UI helpers ----

function enterRoomUI() {
  landingEl.hidden = true;
  roomEl.hidden = false;
  waitingMsg.hidden = false;
  waitingMsg.textContent = role === 'host'
    ? 'Arkadaşının katılması bekleniyor...'
    : 'Ekran paylaşımı bekleniyor...';
}

function showLanding() {
  roomEl.hidden = true;
  landingEl.hidden = false;
  roomCodeInput.value = '';
  clearError();
}

function setStatus(kind, text) {
  statusDot.className = 'status-dot' + (kind === 'connected' ? ' connected' : kind === 'disconnected' ? ' disconnected' : '');
  statusText.textContent = text;
}

function showError(msg) {
  landingError.textContent = msg;
  landingError.hidden = false;
}
function clearError() {
  landingError.hidden = true;
  landingError.textContent = '';
}
function setButtonsDisabled(disabled) {
  createBtn.disabled = disabled;
  joinBtn.disabled = disabled;
}

copyBtn.addEventListener('click', async () => {
  if (!roomId) return;
  try {
    await navigator.clipboard.writeText(roomId);
    copyBtn.textContent = 'Kopyalandı';
    setTimeout(() => (copyBtn.textContent = 'Kopyala'), 1500);
  } catch (e) { /* clipboard not available */ }
});

window.addEventListener('beforeunload', () => {
  if (roomId) socket.emit('leave-room');
});
