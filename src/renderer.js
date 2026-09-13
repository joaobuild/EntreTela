/* Three stable transceivers: voice, screen video and screen sound.
 * No local audio element ever receives the microphone or screen audio. */
const api = window.entretela;
const $ = id => document.getElementById(id);
const peers = new Map();
const mediaRoles = ['voice', 'video', 'sound'];
const mediaKinds = { voice: 'audio', video: 'video', sound: 'audio' };
let me = null, members = [], presenter = null, microphone = null, screen = null;
let muted = true, deafened = false, capabilities, inRoom = false, pendingShare = false, capturing = false, sessionEpoch = 0;
let exitingFullscreen = false;
const profiles = { low: { width: 854, height: 480, fps: 15, bitrate: 650000 }, balanced: { width: 1280, height: 720, fps: 24, bitrate: 1400000 }, high: { width: 1920, height: 1080, fps: 30, bitrate: 2600000 } };
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
function error(e) { notice(e.message || String(e)); }
function send(msg) { return api.send(msg).catch(error); }
function exitStageFullscreen() {
  if (exitingFullscreen || document.fullscreenElement !== $('stage')) return;
  exitingFullscreen = true;
  document.exitFullscreen().catch(error).finally(() => { exitingFullscreen = false; });
}
function updateStage() {
  const sharing = presenter && members.some(p => p.id === presenter);
  if (!sharing) exitStageFullscreen();
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
    state.className = 'peer-state'; state.textContent = p.id === me ? (muted ? 'mudo' : 'mic on') : (peers.get(p.id)?.incompatible ? 'atualize o app' : peers.get(p.id)?.pc.connectionState === 'connected' ? 'online' : 'conectando');
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
  const limits = { voice: 40000, video: Math.min(preset.bitrate, Math.floor(8000000 / Math.max(1, peers.size))), sound: 96000 };
  for (const role of mediaRoles) {
    const sender = p.channels[role]?.sender;
    if (!sender?.track || p.pc.signalingState !== 'stable') continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    params.encodings[0].maxBitrate = limits[role];
    if (role === 'video') { params.encodings[0].maxFramerate = preset.fps; params.degradationPreference = 'maintain-framerate'; }
    try { await sender.setParameters(params); } catch (e) { console.warn('Bitrate setting', e.message); }
  }
}
function incompatibleMedia() {
  return Object.assign(new Error('A conexão de áudio e vídeo usa uma versão incompatível. Atualizem o EntreTela nos dois computadores e entrem novamente.'), { code: 'INCOMPATIBLE_MEDIA' });
}
function readMediaLayout(description, media) {
  if (!description || !['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' || !media || media.version !== 1) throw incompatibleMedia();
  const sections = [];
  for (const line of description.sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) sections.push({ kind: line.slice(2).split(' ')[0], mid: null });
    else if (line.startsWith('a=mid:') && sections.length) sections.at(-1).mid = line.slice(6);
  }
  const mids = mediaRoles.map(role => media[role]);
  if (sections.length !== 3 || new Set(mids).size !== 3 || mids.some(mid => typeof mid !== 'string' || !/^[\w-]{1,64}$/.test(mid))) throw incompatibleMedia();
  for (const role of mediaRoles) if (!sections.some(section => section.mid === media[role] && section.kind === mediaKinds[role])) throw incompatibleMedia();
  return Object.fromEntries(mediaRoles.map(role => [role, media[role]]));
}
function queuePeer(p, operation) {
  p.operations = (p.operations || Promise.resolve()).then(() => {
    if (p.pc.signalingState !== 'closed') return operation();
  }).catch(e => {
    if (e.code === 'INCOMPATIBLE_MEDIA') {
      p.incompatible = true; p.pc.close(); notice(e.message); renderMembers();
    } else if (p.pc.signalingState !== 'closed') error(e);
  });
  return p.operations;
}
function syncTrack(p, role) {
  p.trackTasks[role] = (p.trackTasks[role] || Promise.resolve()).catch(() => {}).then(async () => {
    const sender = p.channels[role]?.sender;
    if (!sender || p.pc.signalingState === 'closed') return;
    const desired = p.desiredTracks[role];
    const track = desired?.readyState === 'ended' ? null : desired;
    if (sender.track !== track) await sender.replaceTrack(track);
  });
  return p.trackTasks[role];
}
function attachReceiver(p, transceiver, track) {
  const role = mediaRoles.find(value => p.channels[value] === transceiver || p.remoteLayout?.[value] === transceiver.mid);
  if (!role || track.kind !== mediaKinds[role]) throw incompatibleMedia();
  if (p.channels[role] && p.channels[role] !== transceiver) throw incompatibleMedia();
  p.channels[role] = transceiver;
  const element = p[role];
  if (element.srcObject?.getTracks()[0] !== track) element.srcObject = new MediaStream([track]);
  element.play().catch(() => {
    if (inRoom && peers.get(p.id) === p) notice('Clique em um controle da sala para liberar a reprodução do áudio.');
  });
  updateStage();
}
async function adoptChannels(p, layout) {
  const transceivers = p.pc.getTransceivers();
  if (transceivers.length !== 3) throw incompatibleMedia();
  for (const role of mediaRoles) {
    const channel = transceivers.find(transceiver => transceiver.mid === layout[role]);
    if (!channel || channel.receiver.track.kind !== mediaKinds[role] || (p.channels[role] && p.channels[role] !== channel)) throw incompatibleMedia();
    p.channels[role] = channel;
    channel.direction = 'sendrecv';
    // Track events can fire while setRemoteDescription is still resolving.
    // Attach by the negotiated MID, including tracks which are initially muted.
    attachReceiver(p, channel, channel.receiver.track);
  }
  await Promise.all(mediaRoles.map(role => syncTrack(p, role)));
}
function sendDescription(p) {
  const description = p.pc.localDescription.toJSON();
  const media = { version: 1, ...Object.fromEntries(mediaRoles.map(role => [role, p.channels[role]?.mid])) };
  readMediaLayout(description, media);
  return send({ type: 'signal', to: p.id, data: { description, media } });
}
function createPeer(id) {
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true; video.hidden = true;
  const voice = document.createElement('audio'), sound = document.createElement('audio');
  voice.autoplay = sound.autoplay = true; voice.muted = deafened; sound.muted = true;
  $('remote-videos').append(video); $('audio-elements').append(voice, sound);
  const p = { id, pc, video, voice, sound, channels: {}, trackTasks: {}, remoteLayout: null, makingOffer: false, ignoreOffer: false, settingAnswer: false, polite: me.localeCompare(id) > 0, candidates: [], restarts: 0 };
  peers.set(id, p);
  p.desiredTracks = { voice: microphone?.getAudioTracks()[0] || null, video: screen?.getVideoTracks()[0] || null, sound: screen?.getAudioTracks()[0] || null };
  pc.onicecandidate = ({ candidate }) => { if (candidate) send({ type: 'signal', to: id, data: { candidate: candidate.toJSON() } }); };
  pc.onnegotiationneeded = () => {
    if (p.polite && !pc.remoteDescription) return;
    queuePeer(p, async () => {
      if (pc.signalingState !== 'stable' || mediaRoles.some(role => !p.channels[role])) return;
      try { p.makingOffer = true; await pc.setLocalDescription(); await sendDescription(p); }
      finally { p.makingOffer = false; }
    });
  };
  pc.ontrack = event => {
    try { attachReceiver(p, event.transceiver, event.track); }
    catch (e) { queuePeer(p, () => { throw e; }); }
  };
  pc.onconnectionstatechange = () => {
    renderMembers();
    if (pc.connectionState === 'connected') setLimits(p);
    if (pc.connectionState === 'failed') {
      if (p.restarts++ < 2) pc.restartIce();
      else notice('Uma conexão direta falhou. Confiram a rede VPN e o firewall nos dois computadores.');
    }
  };
  // Only the initial offerer allocates channels. The answerer adopts the three
  // channels in the incoming offer; preallocating them would create six.
  if (!p.polite) for (const role of mediaRoles) p.channels[role] = pc.addTransceiver(p.desiredTracks[role] || mediaKinds[role], { direction: 'sendrecv' });
  return p;
}
async function signal(from, data) {
  if (!inRoom || !members.some(p => p.id === from) || !data || typeof data !== 'object') return;
  const p = createPeer(from), pc = p.pc;
  return queuePeer(p, async () => {
    if (data.description) {
      const description = data.description;
      const ready = !p.makingOffer && (pc.signalingState === 'stable' || p.settingAnswer);
      p.ignoreOffer = !p.polite && description.type === 'offer' && !ready;
      if (p.ignoreOffer) return;
      const layout = readMediaLayout(description, data.media);
      for (const role of mediaRoles) if (p.channels[role]?.mid != null && p.channels[role].mid !== layout[role]) throw incompatibleMedia();
      p.remoteLayout = layout;
      p.settingAnswer = description.type === 'answer';
      try { await pc.setRemoteDescription(description); }
      finally { p.settingAnswer = false; }
      await adoptChannels(p, layout);
      for (const candidate of p.candidates.splice(0)) await pc.addIceCandidate(candidate);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        await sendDescription(p);
      }
      await setLimits(p);
    } else if (data.candidate && !p.ignoreOffer) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else if (p.candidates.length < 100) p.candidates.push(data.candidate);
    }
  });
}
function removePeer(id) {
  const p = peers.get(id); if (!p) return;
  p.pc.close(); p.video.srcObject = p.voice.srcObject = p.sound.srcObject = null;
  p.video.remove(); p.voice.remove(); p.sound.remove(); peers.delete(id);
}
async function replace(index, track) {
  const role = mediaRoles[index];
  if (!role) throw new Error('Trilha de mídia inválida.');
  await Promise.all([...peers.values()].map(async p => {
    // Keep the requested track even before the answerer's channels exist.
    p.desiredTracks[role] = track;
    try { await syncTrack(p, role); await setLimits(p); }
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
document.addEventListener('fullscreenchange', () => {
  $('fullscreen').textContent = document.fullscreenElement === $('stage') ? 'Sair da tela cheia ⛶' : 'Tela cheia ⛶';
});
$('leave').onclick = async () => {
  exitStageFullscreen();
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
