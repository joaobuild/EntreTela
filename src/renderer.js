/* Three stable transceivers: voice, screen video and screen sound.
 * No local audio element ever receives the microphone or screen audio. */
const api = window.entretela;
const $ = id => document.getElementById(id);
const peers = new Map();
let me = null, members = [], presenter = null, microphone = null, screen = null;
let muted = true, deafened = false, capabilities, inRoom = false, pendingShare = false, capturing = false, sessionEpoch = 0;
const profiles = { low: { width: 854, height: 480, fps: 15, bitrate: 650000 }, balanced: { width: 1280, height: 720, fps: 24, bitrate: 1400000 }, high: { width: 1920, height: 1080, fps: 30, bitrate: 2600000 } };
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
function error(e) { notice(e.message || String(e)); }
function send(msg) { return api.send(msg).catch(error); }
function updateStage() {
  const sharing = presenter && members.some(p => p.id === presenter);
  $('empty').hidden = !!sharing;
  $('preview').hidden = !(presenter === me && screen);
  for (const [id, p] of peers) { p.video.hidden = id !== presenter; p.sound.muted = deafened || id !== presenter; }
  $('screen-label').hidden = !sharing;
  $('fullscreen').hidden = !sharing;
  $('screen-label').textContent = presenter === me ? 'Sua tela · prévia sem som' : `${members.find(p => p.id === presenter)?.name || 'Amigo'} está compartilhando`;
  $('share').disabled = !inRoom || capturing || !!(presenter && presenter !== me);
  $('share').textContent = screen ? 'Parar transmissão' : 'Compartilhar tela';
}
function renderMembers() {
  $('count').textContent = `${members.length}/10`; $('people-count').textContent = members.length;
  $('people').replaceChildren();
  for (const p of members) {
    const li = document.createElement('li'), avatar = document.createElement('span'), name = document.createElement('span'), state = document.createElement('span');
    avatar.className = 'avatar'; avatar.textContent = p.name.slice(0, 1).toUpperCase();
    name.className = 'person-name'; name.textContent = p.name + (p.id === me ? ' (você)' : '');
    state.className = 'peer-state'; state.textContent = p.id === me ? (muted ? 'mudo' : 'mic on') : (peers.get(p.id)?.pc.connectionState === 'connected' ? 'online' : 'conectando');
    li.append(avatar, name, state); $('people').append(li);
  }
}
function setLimits(p) {
  p.limitTask = (p.limitTask || Promise.resolve()).then(() => applyLimits(p)).catch(e => console.warn('Bitrate setting', e.message));
  return p.limitTask;
}
async function applyLimits(p) {
  if (p.pc.signalingState !== 'stable') return;
  const preset = profiles[$('quality').value];
  for (const [i, limit] of [40000, Math.min(preset.bitrate, Math.floor(8000000 / Math.max(1, peers.size))), 96000].entries()) {
    const sender = p.pc.getTransceivers()[i]?.sender;
    if (!sender?.track || p.pc.signalingState !== 'stable') continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    params.encodings[0].maxBitrate = limit;
    if (i === 1) { params.encodings[0].maxFramerate = preset.fps; params.degradationPreference = 'maintain-framerate'; }
    try { await sender.setParameters(params); } catch (e) { console.warn('Bitrate setting', e.message); }
  }
}
function createPeer(id) {
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true; video.hidden = true;
  const voice = document.createElement('audio'), sound = document.createElement('audio');
  voice.autoplay = sound.autoplay = true; voice.muted = deafened; sound.muted = true;
  $('remote-videos').append(video); $('audio-elements').append(voice, sound);
  const p = { pc, video, voice, sound, makingOffer: false, ignoreOffer: false, settingAnswer: false, polite: me.localeCompare(id) > 0, candidates: [], restarts: 0 };
  peers.set(id, p);
  const tracks = [microphone?.getAudioTracks()[0] || null, screen?.getVideoTracks()[0] || null, screen?.getAudioTracks()[0] || null];
  ['audio', 'video', 'audio'].forEach((kind, i) => pc.addTransceiver(tracks[i] || kind, { direction: 'sendrecv' }));
  pc.onicecandidate = ({ candidate }) => { if (candidate) send({ type: 'signal', to: id, data: { candidate: candidate.toJSON() } }); };
  pc.onnegotiationneeded = async () => {
    // A deterministic initial offer avoids a glare race while both sides have
    // only empty transceivers. Later ICE restarts use perfect negotiation.
    if (p.polite && !pc.remoteDescription) return;
    try { p.makingOffer = true; await pc.setLocalDescription(); await send({ type: 'signal', to: id, data: { description: pc.localDescription.toJSON() } }); }
    catch (e) { if (pc.signalingState !== 'closed') error(e); }
    finally { p.makingOffer = false; }
  };
  pc.ontrack = event => {
    const index = pc.getTransceivers().indexOf(event.transceiver);
    const element = [voice, video, sound][index];
    if (!element) return;
    element.srcObject = new MediaStream([event.track]);
    element.play().catch(() => notice('Clique em um controle da sala para liberar a reprodução do áudio.'));
    updateStage();
  };
  pc.onconnectionstatechange = () => {
    renderMembers();
    if (pc.connectionState === 'connected') setLimits(p);
    if (pc.connectionState === 'failed') {
      if (p.restarts++ < 2) pc.restartIce();
      else notice('Uma conexão direta falhou. Confiram a rede VPN e o firewall nos dois computadores.');
    }
  };
  return p;
}
async function signal(from, data) {
  if (!inRoom || !members.some(p => p.id === from)) return;
  const p = createPeer(from), pc = p.pc;
  try {
    if (data.description) {
      const description = data.description;
      const ready = !p.makingOffer && (pc.signalingState === 'stable' || p.settingAnswer);
      p.ignoreOffer = !p.polite && description.type === 'offer' && !ready;
      if (p.ignoreOffer) return;
      p.settingAnswer = description.type === 'answer';
      await pc.setRemoteDescription(description); p.settingAnswer = false;
      for (const candidate of p.candidates.splice(0)) await pc.addIceCandidate(candidate);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        await send({ type: 'signal', to: from, data: { description: pc.localDescription.toJSON() } });
      }
      await setLimits(p);
    } else if (data.candidate && !p.ignoreOffer) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else if (p.candidates.length < 100) p.candidates.push(data.candidate);
    }
  } catch (e) { if (pc.signalingState !== 'closed') error(e); }
}
function removePeer(id) {
  const p = peers.get(id); if (!p) return;
  p.pc.close(); p.video.srcObject = p.voice.srcObject = p.sound.srcObject = null;
  p.video.remove(); p.voice.remove(); p.sound.remove(); peers.delete(id);
}
async function replace(index, track) {
  await Promise.all([...peers.values()].map(async p => {
    try { await p.pc.getTransceivers()[index].sender.replaceTrack(track); await setLimits(p); }
    catch (e) { if (p.pc.signalingState !== 'closed') error(e); }
  }));
}
async function stopScreen() {
  const old = screen; screen = null;
  old?.getTracks().forEach(t => t.stop()); $('preview').srcObject = null;
  await Promise.all([replace(1, null), replace(2, null)]);
  if (inRoom) await send({ type: 'share-stop' });
  updateStage();
}
async function chooseSource(source) {
  if (capturing) return;
  capturing = true; $('picker').close(); updateStage();
  const epoch = sessionEpoch;
  let captured;
  try {
    const withAudio = $('with-audio').checked;
    if (withAudio && !navigator.mediaDevices.getSupportedConstraints().restrictOwnAudio) throw new Error('Esta versão não permite excluir o áudio da chamada. Compartilhe sem som.');
    await api.selectSource({ id: source.id, audio: withAudio });
    const preset = profiles[$('quality').value];
    captured = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: preset.width, max: preset.width }, height: { ideal: preset.height, max: preset.height }, frameRate: { ideal: preset.fps, max: preset.fps } }, audio: withAudio ? { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false });
    if (epoch !== sessionEpoch || !inRoom || presenter !== me) { captured.getTracks().forEach(t => t.stop()); return; }
    if (withAudio && (!captured.getAudioTracks().length || captured.getAudioTracks()[0].getSettings().restrictOwnAudio !== true)) {
      captured.getTracks().forEach(t => t.stop());
      throw new Error('O Windows não confirmou a exclusão das vozes. Por segurança, tente compartilhar sem som.');
    }
    screen = captured; screen.getVideoTracks()[0].contentHint = 'detail';
    screen.getVideoTracks()[0].onended = () => { stopScreen().catch(error); };
    $('preview').srcObject = new MediaStream(screen.getVideoTracks());
    await Promise.all([replace(1, screen.getVideoTracks()[0]), replace(2, screen.getAudioTracks()[0] || null)]);
  } catch (e) { captured?.getTracks().forEach(t => t.stop()); await stopScreen(); error(e); }
  finally { capturing = false; updateStage(); }
}
async function showPicker() {
  try {
    $('sources').replaceChildren();
    const sources = await api.sources();
    if (!inRoom || presenter !== me) return;
    for (const source of sources) {
      const button = document.createElement('button'), img = document.createElement('img'), label = document.createElement('span');
      img.src = source.thumbnail; img.alt = ''; label.textContent = source.name;
      button.append(img, label); button.onclick = () => chooseSource(source); $('sources').append(button);
    }
    if (!sources.length) throw new Error('Nenhuma tela disponível.');
    $('picker').showModal();
  } catch (e) { await send({ type: 'share-stop' }); error(e); }
}
api.onEvent(async msg => {
  if (msg.type === 'connected') {
    inRoom = true; me = msg.id; $('status').textContent = msg.isHost ? 'Você está hospedando' : 'Conectado à sala';
    $('host-note').textContent = msg.isHost ? 'Este computador hospeda a sala. Se sair, outro membro conectado assume.' : 'A sala é hospedada por um dos amigos conectados.';
    $('lobby').hidden = true; $('room').hidden = false; notice('');
    $('connection-note').textContent = `Sala em ${msg.hosts.join(' / ')}:${msg.port} • Uma transmissão por vez.`;
  } else if (msg.type === 'roster') {
    members = msg.peers; presenter = msg.presenter;
    for (const id of peers.keys()) if (!members.some(p => p.id === id)) removePeer(id);
    for (const p of members) if (p.id !== me) createPeer(p.id);
    if (screen && presenter !== me) await stopScreen();
    renderMembers(); updateStage();
    for (const p of peers.values()) setLimits(p);
    if (pendingShare && presenter === me) { pendingShare = false; await showPicker(); }
  } else if (msg.type === 'signal') await signal(msg.from, msg.data);
  else if (msg.type === 'share-denied') { pendingShare = false; notice('Um amigo já está compartilhando. Aguarde ele terminar.'); }
  else if (msg.type === 'reconnecting') {
    inRoom = false; sessionEpoch++; presenter = null; pendingShare = false;
    $('picker').close(); await stopScreen();
    for (const id of peers.keys()) removePeer(id);
    $('status').textContent = 'Trocando anfitrião…';
    notice('O anfitrião desconectou. Buscando outro membro. A tela precisará ser compartilhada novamente.');
  } else if (msg.type === 'error') notice(msg.message);
});
$('join-form').onsubmit = async event => {
  event.preventDefault(); notice(''); $('join').disabled = true; $('status').textContent = 'Procurando a turma…';
  try { const result = await api.join({ name: $('name').value }); if (!result.ok) throw new Error(result.message); }
  catch (e) { error(e); $('status').textContent = 'Não conectado'; }
  finally { $('join').disabled = false; }
};
$('allow-network').onclick = async () => {
  $('allow-network').disabled = true;
  notice('Aguarde a autorização do Windows para permitir a conexão do EntreTela.');
  try { const result = await api.allowNetwork(); notice(result.message); }
  catch (e) { error(e); }
  finally { $('allow-network').disabled = false; }
};
$('mic').onclick = async () => {
  if (!inRoom) return;
  const epoch = sessionEpoch;
  $('mic').disabled = true;
  try {
    if (!microphone) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      if (!inRoom || epoch !== sessionEpoch) { stream.getTracks().forEach(t => t.stop()); return; }
      microphone = stream; muted = false;
      microphone.getAudioTracks()[0].onended = () => { microphone = null; muted = true; $('mic').textContent = 'Ativar microfone'; $('mic').classList.remove('active'); renderMembers(); notice('O microfone foi desconectado. Selecione ou reconecte um dispositivo no Windows.'); };
      await replace(0, microphone.getAudioTracks()[0]);
    } else { muted = !muted; microphone.getAudioTracks()[0].enabled = !muted; }
    $('mic').textContent = muted ? 'Ativar microfone' : 'Desligar microfone'; $('mic').classList.toggle('active', !muted); renderMembers();
  } catch (e) { error(e); } finally { $('mic').disabled = false; }
};
$('deafen').onclick = () => {
  deafened = !deafened;
  for (const [id, p] of peers) { p.voice.muted = deafened; p.sound.muted = deafened || presenter !== id; }
  $('deafen').textContent = deafened ? 'Ouvir chamada' : 'Silenciar chamada'; $('deafen').classList.toggle('active', deafened);
};
$('share').onclick = () => { if (screen) stopScreen().catch(error); else { pendingShare = true; send({ type: 'share-request' }); } };
$('picker').addEventListener('cancel', () => send({ type: 'share-stop' }));
$('cancel-picker').onclick = () => { $('picker').close(); send({ type: 'share-stop' }); };
$('quality').onchange = async () => {
  try {
    const p = profiles[$('quality').value];
    if (screen) await screen.getVideoTracks()[0].applyConstraints({ width: { ideal: p.width, max: p.width }, height: { ideal: p.height, max: p.height }, frameRate: { ideal: p.fps, max: p.fps } });
    await Promise.all([...peers.values()].map(setLimits));
  } catch (e) { error(e); }
};
$('fullscreen').onclick = () => { (document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen()).catch(error); };
$('leave').onclick = async () => {
  inRoom = false; sessionEpoch++; pendingShare = false; presenter = null;
  $('picker').close(); await stopScreen(); microphone?.getTracks().forEach(t => t.stop()); microphone = null; muted = true;
  for (const id of peers.keys()) removePeer(id);
  await api.leave(); members = []; me = null; deafened = false;
  $('room').hidden = true; $('lobby').hidden = false; $('status').textContent = 'Você saiu da sala';
  $('mic').textContent = 'Ativar microfone'; $('mic').classList.remove('active');
  $('deafen').textContent = 'Silenciar chamada'; $('deafen').classList.remove('active'); notice('');
};
api.capabilities().then(value => {
  capabilities = value; $('version').textContent = `Windows · v${value.version}`;
  if (!value.audio) { $('with-audio').checked = false; $('with-audio').disabled = true; $('audio-note').textContent = 'Neste Windows, use tela sem som. Som com exclusão das vozes requer Windows 11 (ou build 20348+).'; }
}).catch(error);
