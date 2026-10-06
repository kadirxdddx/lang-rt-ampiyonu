import { createTableScene } from './scene.js';
import { createGame, beginGame, applyInput, stepGame, snapshot, ROD_LAYOUT, ROD_SPEED, PLAYER_SPACING } from './shared/game.js';

const $ = selector => document.querySelector(selector);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const moveToward = (a, b, d) => a + clamp(b - a, -d, d);
const positions = Array(6).fill(0), predicted = Array(6).fill(0);
const kickSeq = Array(6).fill(0), kickVisual = Array(6).fill(0), lastKick = Array(6).fill(-1000);
const keys = new Set(), pointers = new Map(), samples = [];
let scene, game = createGame(), mode = 'practice', team = 0, selected = 2;
let socket = null, connectionGeneration = 0, reconnectTimer, connectTimer, reconnectAttempt = 0;
let room = null, resume = null, joined = false, initialized = false, connected = [false, false], ready = [false, false];
let latest = snapshot(game), seq = 0, localSeq = [0, 0], lastSend = 0, lastPayload = '', lastPing = 0, lastPacket = 0;
let lastFrame = performance.now(), accumulator = 0, lastHud = 0, toastTimer, muted = false, audio, view = 'perspective';
let shownScores = [0, 0], previousPhase = 'waiting', matchEvent = -1;
const storage = {
  get() { try { return JSON.parse(sessionStorage.getItem('masa-room')); } catch { return null; } },
  set(value) { try { if (value) sessionStorage.setItem('masa-room', JSON.stringify(value)); else sessionStorage.removeItem('masa-room'); } catch {} },
};

function toast(text) {
  clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3600);
}
function note(text) { $('#room-status').textContent = text; }
function sound(kind = 'kick') {
  if (muted) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    const oscillator = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime;
    oscillator.type = kind === 'kick' ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(kind === 'goal' ? 660 : 180, now);
    oscillator.frequency.exponentialRampToValueAtTime(kind === 'goal' ? 990 : 65, now + .11);
    gain.gain.setValueAtTime(kind === 'goal' ? .08 : .035, now);
    gain.gain.exponentialRampToValueAtTime(.001, now + .2);
    oscillator.connect(gain).connect(audio.destination); oscillator.start(); oscillator.stop(now + .22);
  } catch {}
}
function canControl() { return mode !== 'online' || joined && socket?.readyState === WebSocket.OPEN; }
function ownIndices() { return team === 0 ? [0, 1, 2] : [5, 4, 3]; }
function selectRod(index) {
  selected = index;
  for (const card of document.querySelectorAll('.rod-control')) {
    const active = Number(card.dataset.rod) === index;
    card.classList.toggle('active', active); card.querySelector('button').setAttribute('aria-pressed', String(active));
  }
}
function buildControls() {
  const labels = ['Kaleci', 'Orta saha', 'Hücum'], bindings = team ? ['O / L', 'I / K', 'U / J'] : ['Q / A', 'W / S', 'E / D'];
  $('#rod-controls').replaceChildren();
  ownIndices().forEach((index, local) => {
    const card = document.createElement('div'); card.className = 'rod-control'; card.dataset.rod = index;
    const button = document.createElement('button'); button.className = 'rod-select';
    button.innerHTML = `<span class="rod-number">${local + 1}</span><span>${labels[local]}</span><span class="rod-key">${bindings[local]}</span>`;
    button.addEventListener('click', () => selectRod(index));
    const slider = document.createElement('input'); slider.type = 'range'; slider.min = '-1'; slider.max = '1'; slider.step = '.005'; slider.value = positions[index];
    slider.className = 'rod-slider'; slider.setAttribute('aria-label', `${labels[local]} çubuğunu hareket ettir`);
    slider.addEventListener('input', () => { if (!canControl()) return; selectRod(index); positions[index] = Number(slider.value); });
    card.append(button, slider); $('#rod-controls').append(card);
  });
  selectRod(ownIndices()[2]);
}
function shoot(index = selected) {
  const now = performance.now();
  if (!canControl() || latest.phase !== 'playing' || now - lastKick[index] < 250) return;
  if (mode !== 'local' && ROD_LAYOUT[index].team !== team) return;
  lastKick[index] = now; kickSeq[index]++; kickVisual[index] = 1; sound();
  if (mode === 'online') sendInput(now, true);
}
function send(message) {
  if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 16384) return false;
  socket.send(JSON.stringify(message)); return true;
}
function sendInput(now, force = false) {
  if (!joined || !initialized) return;
  const offset = team * 3;
  const data = { positions: positions.slice(offset, offset + 3).map(v => Math.round(v * 1000) / 1000), kick: kickSeq.slice(offset, offset + 3) };
  const payload = JSON.stringify(data);
  if (!force && (now - lastSend < 1000 / 60 || payload === lastPayload && now - lastSend < 200)) return;
  if (send({ type: 'input', ...data, seq: seq + 1 })) { seq++; lastPayload = payload; lastSend = now; }
}
function releaseControls() { keys.clear(); pointers.clear(); }
function clearConnection(explicit = true) {
  connectionGeneration++; clearTimeout(reconnectTimer); clearTimeout(connectTimer);
  if (explicit && socket?.readyState === WebSocket.OPEN) send({ type: 'leave' });
  socket?.close(); socket = null; joined = false; room = null; resume = null;
  storage.set(null); samples.length = 0; initialized = false; releaseControls();
}
function setPractice(nextMode = 'practice') {
  clearConnection(); mode = nextMode; team = 0; seq = 0; localSeq = [0, 0];
  positions.fill(0); predicted.fill(0); kickSeq.fill(0); kickVisual.fill(0);
  game = createGame(); beginGame(game); latest = snapshot(game); shownScores = [0, 0]; accumulator = 0;
  connected = [false, false]; ready = [false, false]; previousPhase = 'waiting';
  $('#room-active').hidden = true; $('#lobby-actions').hidden = false;
  $('#create-room').disabled = false; $('#join-room').disabled = false;
  $('#practice-button').classList.toggle('active', mode === 'practice');
  $('#local-button').classList.toggle('active', mode === 'local');
  $('#team0-name').textContent = mode === 'practice' ? 'SEN' : 'TURUNCU';
  $('#team1-name').textContent = mode === 'practice' ? 'ANTRENMAN' : 'NANE';
  $('#connection').textContent = 'YEREL OYUN'; $('#connection').classList.remove('slow');
  $('#chat-input').disabled = $('#chat-send').disabled = true;
  note(mode === 'local' ? 'Turuncu: Q/A W/S E/D + F · Nane: U/J I/K O/L + H' : 'İkiniz de hazır olduğunuzda online maç başlar.');
  const url = new URL(location.href); url.searchParams.delete('oda'); history.replaceState({}, '', url);
  buildControls(); updateHud();
}

function updateRoom() {
  $('#room-active').hidden = !room; $('#lobby-actions').hidden = Boolean(room);
  $('#room-code').textContent = room || '------';
  for (let i = 0; i < 2; i++) {
    const label = $(`#player${i}-state`);
    label.textContent = !connected[i] ? 'Bekleniyor' : ready[i] ? 'Hazır ✓' : i === team ? 'Sen' : 'Bağlandı';
    label.classList.toggle('ready', ready[i]);
  }
  const playing = ['playing', 'countdown', 'goal'].includes(latest.phase);
  $('#ready-button').disabled = !joined || !connected.every(Boolean) || ready[team] || playing;
  $('#ready-button').textContent = playing ? 'Maç sürüyor' : ready[team] ? 'Hazırsın ✓' : latest.phase === 'finished' ? 'Rövanşa hazırım' : 'Hazırım ✓';
  $('#chat-input').disabled = $('#chat-send').disabled = !joined || !connected.every(Boolean);
}
function connect(action, code = '', token = null, reconnecting = false) {
  if (location.protocol === 'file:') { toast('Online oyun için sitenin Render adresini aç.'); return; }
  if (!reconnecting) {
    clearConnection(); mode = 'online'; latest = snapshot(createGame()); positions.fill(0); predicted.fill(0); kickSeq.fill(0); kickVisual.fill(0);
    connected = [false, false]; ready = [false, false]; seq = 0; reconnectAttempt = 0; shownScores = [0, 0];
    $('#chat-messages').replaceChildren();
  }
  const generation = ++connectionGeneration;
  joined = false; initialized = false; samples.length = 0;
  $('#practice-button').classList.remove('active'); $('#local-button').classList.remove('active');
  $('#create-room').disabled = $('#join-room').disabled = true;
  note(reconnecting ? 'Bağlantı yenileniyor; odadaki yerin korunuyor…' : 'Oyun sunucusuna bağlanılıyor…');
  $('#connection').textContent = 'BAĞLANIYOR';
  const peer = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket = peer;
  connectTimer = setTimeout(() => { if (generation === connectionGeneration && !joined) { note('Sunucu uyanıyor olabilir; bağlantı tekrar deneniyor…'); peer.close(); } }, 20000);
  peer.addEventListener('open', () => {
    if (generation !== connectionGeneration) return;
    send({ type: action, code, ...(token ? { token } : {}) });
  });
  peer.addEventListener('message', event => {
    if (generation !== connectionGeneration) return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'joined') {
      clearTimeout(connectTimer); reconnectAttempt = 0; joined = true; room = message.code; team = message.team;
      resume = { code: room, token: message.token }; storage.set(resume); seq = Math.max(0, message.inputSeq ?? 0);
      (message.kickSeq || [0, 0, 0]).forEach((value, index) => { kickSeq[team * 3 + index] = value; });
      lastPayload = ''; lastSend = 0; lastPing = 0; lastPacket = performance.now();
      $('#team0-name').textContent = team === 0 ? 'SEN' : 'ARKADAŞIN'; $('#team1-name').textContent = team === 1 ? 'SEN' : 'ARKADAŞIN';
      const url = new URL(location.href); url.searchParams.set('oda', room); history.replaceState({}, '', url);
      note(reconnecting ? 'Yeniden bağlandın. İkiniz de hazır verince devam edersiniz.' : 'Davet bağlantısını paylaş. İkiniz de hazır verince başlayın.');
      buildControls(); updateRoom();
    } else if (message.type === 'room') {
      connected = message.connected; ready = message.ready; updateRoom();
      if (joined) note(!connected[1 - team] ? 'Arkadaşını bekliyorsun. Oda kodunu veya davet bağlantısını paylaş.' : ready[team] && !ready[1 - team] ? 'Sen hazırsın. Arkadaşının hazır olmasını bekliyorsun.' : 'İkiniz de hazır olduğunuzda maç başlar.');
    } else if (message.type === 'state') {
      if (!joined) return;
      const now = performance.now(), state = message.state;
      if (!initialized) {
        state.rods.forEach((value, index) => { positions[index] = predicted[index] = value; });
        initialized = true;
      }
      // Never interpolate through a goal, kickoff, pause or a new match.
      if (latest.eventId !== state.eventId || latest.phase !== state.phase) samples.length = 0;
      if (state.phase === 'countdown' && (latest.phase === 'waiting' || latest.phase === 'finished')) {
        state.rods.forEach((value, index) => { positions[index] = predicted[index] = value; });
      }
      samples.push({ state, time: message.time, received: now }); if (samples.length > 15) samples.shift();
      latest = state; lastPacket = now;
      updateRoom();
    } else if (message.type === 'pong') {
      const ping = Math.round(performance.now() - message.sentAt);
      $('#connection').textContent = `${ping} ms · ONLINE`; $('#connection').classList.toggle('slow', ping > 160);
    } else if (message.type === 'chat') addChat(message);
    else if (message.type === 'error') {
      if (!joined) {
        clearTimeout(connectTimer); clearTimeout(reconnectTimer); storage.set(null); resume = null;
        connectionGeneration++; peer.close(); socket = null; $('#create-room').disabled = $('#join-room').disabled = false;
        room = null; $('#room-active').hidden = true; $('#lobby-actions').hidden = false;
      }
      note(message.message); toast(message.message);
    }
  });
  peer.addEventListener('close', () => {
    if (generation !== connectionGeneration || mode !== 'online') return;
    clearTimeout(connectTimer); joined = false; connected[team] = false; releaseControls(); updateRoom();
    latest = { ...latest, phase: 'paused' }; $('#connection').textContent = 'BAĞLANTI KOPTU';
    if (reconnectAttempt >= 10) {
      note('Bağlantı kurulamadı. Oda kur veya oda koduyla tekrar dene.');
      $('#create-room').disabled = $('#join-room').disabled = false; $('#lobby-actions').hidden = false;
      return;
    }
    note('Bağlantı koptu. Yeniden bağlanılıyor…');
    reconnectTimer = setTimeout(() => {
      reconnectAttempt++;
      if (resume) connect('join', resume.code, resume.token, true); else connect(action, code, token, true);
    }, Math.min(4000, 600 * 1.5 ** reconnectAttempt));
  });
  peer.addEventListener('error', () => { if (generation === connectionGeneration) note('Sunucuya ulaşılmaya çalışılıyor…'); });
  updateRoom();
}

function addChat(message) {
  const box = $('#chat-messages'); box.querySelector('.chat-empty')?.remove();
  const bubble = document.createElement('div'); bubble.className = `chat-bubble${message.team === team ? ' mine' : ''}`;
  const label = document.createElement('small'); label.textContent = message.team === team ? 'Sen' : 'Arkadaşın';
  bubble.append(label, document.createTextNode(message.text)); box.append(bubble);
  while (box.children.length > 80) box.firstElementChild.remove(); box.scrollTop = box.scrollHeight;
}
function interpolated(now, dt) {
  if (!samples.length) return latest;
  const newest = samples.at(-1), renderTime = newest.time + (now - newest.received) - 65;
  let a = samples[0], b = newest;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].time >= renderTime) { b = samples[i]; a = samples[i - 1]; break; }
    a = samples[i];
  }
  const alpha = a.time === b.time ? 1 : clamp((renderTime - a.time) / (b.time - a.time), 0, 1);
  const state = { ...latest, rods: a.state.rods.map((v, i) => mix(v, b.state.rods[i], alpha)), kicks: a.state.kicks.map((v, i) => mix(v, b.state.kicks[i], alpha)), ball: { ...latest.ball, x: mix(a.state.ball.x, b.state.ball.x, alpha), z: mix(a.state.ball.z, b.state.ball.z, alpha) } };
  if (joined && ['playing', 'countdown'].includes(latest.phase)) {
    for (let i = team * 3; i < team * 3 + 3; i++) {
      // Own rods react before a round trip, using the same speed cap as physics.
      predicted[i] = moveToward(predicted[i], positions[i], ROD_SPEED * dt / ROD_LAYOUT[i].travel);
      if (latest.ack[team] >= seq && Math.abs(positions[i] - latest.rods[i]) < .01) predicted[i] = mix(predicted[i], latest.rods[i], 1 - Math.exp(-14 * dt));
      state.rods[i] = predicted[i]; state.kicks[i] = Math.max(state.kicks[i], kickVisual[i]);
    }
  }
  return state;
}
function keyboard(dt) {
  if (!canControl() || !['playing', 'countdown'].includes(latest.phase)) return;
  const binds = [['q', 'a'], ['w', 's'], ['e', 'd'], ['u', 'j'], ['i', 'k'], ['o', 'l']];
  for (let i = 0; i < 6; i++) {
    if (mode !== 'local' && ROD_LAYOUT[i].team !== team) continue;
    let direction = Number(keys.has(binds[i][1])) - Number(keys.has(binds[i][0]));
    if (i === selected) direction += Number(keys.has('ArrowDown')) - Number(keys.has('ArrowUp'));
    positions[i] = clamp(positions[i] + clamp(direction, -1, 1) * 5.5 * dt / ROD_LAYOUT[i].travel, -1, 1);
  }
}
function practiceAI(dt) {
  if (mode !== 'practice') return;
  for (let i = 3; i < 6; i++) {
    const rod = ROD_LAYOUT[i];
    let target = positions[i], best = Infinity;
    for (let p = 0; p < rod.count; p++) {
      const candidate = clamp((game.ball.z - (p - (rod.count - 1) / 2) * PLAYER_SPACING) / rod.travel, -1, 1);
      const distance = Math.abs(candidate - positions[i]); if (distance < best) { best = distance; target = candidate; }
    }
    positions[i] = moveToward(positions[i], target, dt * .8 / rod.travel);
    if (game.phase === 'playing' && game.ball.x < rod.x && Math.abs(game.ball.x - rod.x) < .6 && performance.now() - lastKick[i] > 650) {
      kickSeq[i]++; lastKick[i] = performance.now();
    }
  }
}
function updateHud() {
  $('#score0').textContent = latest.scores[0]; $('#score1').textContent = latest.scores[1];
  const seconds = Math.max(0, Math.ceil(latest.timer)); $('#match-time').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  if (shownScores.some((value, i) => latest.scores[i] > value)) sound('goal'); shownScores = [...latest.scores];
  const overlay = $('#game-overlay'); let title = '', subtitle = '', eyebrow = '';
  if (latest.phase === 'waiting' && mode === 'online') { eyebrow = room ? `ODA ${room}` : 'ONLINE MASA'; title = room ? 'Arkadaşını bekle.' : 'Masaya bağlanıyoruz.'; subtitle = room ? 'İkiniz de hazır verince maç başlar.' : 'Bağlantı birkaç saniye sürebilir.'; }
  else if (latest.phase === 'countdown') { eyebrow = 'HAZIR MISIN?'; title = String(Math.max(1, Math.ceil(latest.countdown))); subtitle = 'Her çubuk senin kontrolünde.'; }
  else if (latest.phase === 'goal') { eyebrow = 'İŞTE BU!'; title = 'Gooool!'; subtitle = `${latest.scores[0]} — ${latest.scores[1]}`; }
  else if (latest.phase === 'paused') { eyebrow = 'KISA BİR MOLA'; title = 'Maç duraklatıldı.'; subtitle = 'Bağlanın, hazır verin ve devam edin.'; }
  else if (latest.phase === 'finished') { eyebrow = 'MAÇ BİTTİ'; title = latest.winner === 'draw' ? 'Dostluk kazandı.' : `${latest.winner === 0 ? 'Turuncu' : 'Nane'} kazandı!`; subtitle = mode === 'online' ? 'Rövanş için ikiniz de hazır verin.' : 'Yeni maç için Antrenman veya Aynı cihazda 2 kişi seç.'; }
  overlay.hidden = !title; $('#overlay-eyebrow').textContent = eyebrow; $('#overlay-title').textContent = title; $('#overlay-text').textContent = subtitle;
  $('#match-status').textContent = mode === 'online' ? `${team === 0 ? 'Turuncu' : 'Nane'} takım sensin · ${latest.phase === 'playing' ? 'Maç sürüyor' : 'Online masa'}` : mode === 'local' ? 'Aynı cihazda iki kişi' : 'Serbest antrenman';
  for (const card of document.querySelectorAll('.rod-control')) {
    const slider = card.querySelector('input'); if (document.activeElement !== slider) slider.value = positions[Number(card.dataset.rod)];
  }
  if (mode === 'online' && latest.phase !== previousPhase) updateRoom(); previousPhase = latest.phase;
}
function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, .05); lastFrame = now;
  keyboard(dt); kickVisual.forEach((value, i) => { kickVisual[i] = Math.max(0, value - dt / .23); });
  if (mode !== 'online') {
    practiceAI(dt);
    for (let t = 0; t < 2; t++) applyInput(game, t, { positions: positions.slice(t * 3, t * 3 + 3), kick: kickSeq.slice(t * 3, t * 3 + 3), seq: ++localSeq[t] });
    accumulator = Math.min(.1, accumulator + dt);
    while (accumulator >= 1 / 120) { stepGame(game, 1 / 120); accumulator -= 1 / 120; }
    latest = snapshot(game); scene.render(latest, dt, team, selected);
  } else {
    if (joined) {
      sendInput(now);
      if (now - lastPing > 2000) { send({ type: 'ping', sentAt: now }); lastPing = now; }
      if (now - lastPacket > 12000) socket?.close();
      else if (now - lastPacket > 2000) { $('#connection').textContent = 'BAĞLANTI BEKLENİYOR'; $('#connection').classList.add('slow'); }
    }
    scene.render(interpolated(now, dt), dt, team, selected);
  }
  if (now - lastHud > 100) { updateHud(); lastHud = now; }
  requestAnimationFrame(frame);
}

$('#create-room').addEventListener('click', () => connect('create'));
$('#join-form').addEventListener('submit', event => { event.preventDefault(); const code = $('#room-input').value.trim().toUpperCase(); if (/^[A-Z0-9]{6}$/.test(code)) connect('join', code); });
$('#ready-button').addEventListener('click', () => { if (send({ type: 'ready', ready: true })) { ready[team] = true; updateRoom(); } });
$('#leave-room').addEventListener('click', () => setPractice());
$('#practice-button').addEventListener('click', () => setPractice());
$('#local-button').addEventListener('click', () => setPractice('local'));
$('#copy-invite').addEventListener('click', async () => {
  const url = new URL(location.href); url.searchParams.set('oda', room);
  try { await navigator.clipboard.writeText(url.href); toast('Davet bağlantısı kopyalandı. Arkadaşına gönder!'); }
  catch { toast(`Oda kodun: ${room}`); }
});
$('#chat-form').addEventListener('submit', event => {
  event.preventDefault(); const input = $('#chat-input'), text = input.value.trim();
  if (text && joined && connected.every(Boolean) && send({ type: 'chat', text })) input.value = '';
});
$('#help-button').addEventListener('click', () => { releaseControls(); $('#help-dialog').showModal(); });
$('#help-dialog').addEventListener('click', event => { if (event.target === $('#help-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
$('#view-button').addEventListener('click', () => { view = view === 'perspective' ? 'top' : 'perspective'; scene?.setView(view); $('#view-button').setAttribute('aria-label', view === 'top' ? 'Perspektif kamera görünümü' : 'Üstten kamera görünümü'); });
$('#quality').addEventListener('change', event => scene?.setQuality(event.target.value));
$('#sound-button').addEventListener('click', () => { muted = !muted; $('#sound-button').textContent = muted ? '♩' : '♪'; $('#sound-button').setAttribute('aria-label', muted ? 'Sesi aç' : 'Sesi kapat'); toast(muted ? 'Ses kapalı.' : 'Ses açık.'); });
$('#fullscreen-button').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('#arena').requestFullscreen) await $('#arena').requestFullscreen(); else toast('Bu tarayıcıda tam ekran desteklenmiyor. Tableti yatay çevirebilirsin.'); } catch { toast('Tam ekran açılamadı. Tableti yatay çevirebilirsin.'); } });
$('#shoot-button').addEventListener('pointerdown', event => { event.preventDefault(); shoot(); });
$('#shoot-button').addEventListener('click', event => { if (event.detail === 0) shoot(); });
const field = $('#scene');
field.addEventListener('pointerdown', event => {
  if (!scene || !canControl()) return;
  const index = scene.pickRod(event.clientX, event.clientY, team); if (index === null) return;
  const position = scene.pointerPosition(event.clientX, event.clientY, index); if (position === null) return;
  selectRod(index); pointers.set(event.pointerId, { index, start: position, target: positions[index] });
  field.setPointerCapture(event.pointerId); field.focus({ preventScroll: true }); event.preventDefault();
});
field.addEventListener('pointermove', event => {
  const pointer = pointers.get(event.pointerId); if (!pointer) return;
  const position = scene.pointerPosition(event.clientX, event.clientY, pointer.index);
  if (position !== null) positions[pointer.index] = clamp(pointer.target + position - pointer.start, -1, 1);
  event.preventDefault();
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) field.addEventListener(name, event => pointers.delete(event.pointerId));
addEventListener('keydown', event => {
  if (event.target.closest('input,textarea,select') || $('#help-dialog').open || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (['ArrowUp', 'ArrowDown', ' ', '1', '2', '3'].includes(key)) event.preventDefault();
  const fresh = !keys.has(key); keys.add(key); if (!fresh) return;
  if (['1', '2', '3'].includes(key)) selectRod(ownIndices()[Number(key) - 1]);
  if (key === ' ') shoot();
  if (key === 'f' && (mode === 'local' || team === 0)) shoot(selected < 3 ? selected : 2);
  if (key === 'h' && (mode === 'local' || team === 1)) {
    let index = selected >= 3 ? selected : 3;
    if (mode === 'local') index = [3, 4, 5].reduce((a, b) => Math.abs(ROD_LAYOUT[a].x - latest.ball.x) < Math.abs(ROD_LAYOUT[b].x - latest.ball.x) ? a : b);
    shoot(index);
  }
});
addEventListener('keyup', event => keys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key));
addEventListener('blur', releaseControls);
document.addEventListener('visibilitychange', () => { releaseControls(); lastFrame = performance.now(); accumulator = 0; });
addEventListener('beforeunload', () => socket?.close());

try {
  scene = createTableScene(field); $('#loading').hidden = true;
  const saved = storage.get(), invitation = new URLSearchParams(location.search).get('oda')?.toUpperCase();
  setPractice();
  if (saved?.code && saved?.token && (!invitation || invitation === saved.code)) connect('join', saved.code, saved.token);
  else if (invitation && /^[A-Z0-9]{6}$/.test(invitation)) { $('#room-input').value = invitation; connect('join', invitation); }
  requestAnimationFrame(frame);
} catch (error) {
  $('#loading').textContent = `3D masa açılamadı. Güncel Chrome, Edge veya Safari kullan ve tarayıcıda grafik hızlandırmayı aç. (${error.message})`;
  $('#create-room').disabled = $('#join-room').disabled = true;
  console.error(error);
}
