(function (root) {
  'use strict';
  const audioUnavailable = 'Tela transmitida sem som. Não foi possível iniciar o áudio do computador. Confira a saída de som do Windows e tente compartilhar novamente.';
  const audioNotIsolated = 'Tela transmitida sem som porque não foi possível excluir as vozes da chamada.';
  function stop(stream) { stream?.getTracks().forEach(track => track.stop()); }
  function cancelled() { return Object.assign(new Error('Transmissão cancelada.'), { code: 'CAPTURE_CANCELLED' }); }
  function audioStartFailed(error) {
    return /could not start audio source|failed to (?:start|initialize) audio/i.test(error?.message || '');
  }
  async function capture({ source, withAudio, video, mediaDevices, selectSource, isCurrent, onRetry = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const check = () => { if (!isCurrent()) throw cancelled(); };
    async function attempt(audio) {
      check();
      // Electron consumes the source choice even when opening the audio fails.
      await selectSource({ id: source.id, audio });
      check();
      const stream = await mediaDevices.getDisplayMedia({ video, audio: audio ? { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false });
      if (!isCurrent()) { stop(stream); throw cancelled(); }
      if (!stream.getVideoTracks().some(track => track.readyState === 'live')) {
        stop(stream); throw new Error('A tela selecionada não está mais disponível. Escolha uma tela ou janela novamente.');
      }
      return stream;
    }
    let warning = '';
    if (withAudio && mediaDevices.getSupportedConstraints().restrictOwnAudio) {
      for (let attemptNumber = 0; attemptNumber < 3; attemptNumber++) {
        let stream;
        try {
          stream = await attempt(true);
          const audio = stream.getAudioTracks();
          if (audio.length && audio.every(track => track.readyState === 'live' && track.getSettings().restrictOwnAudio === true)) return { stream, warning: '' };
          warning = audio.length ? audioNotIsolated : audioUnavailable;
          stop(stream);
          break;
        } catch (error) {
          stop(stream);
          check();
          // Permission refusals, cancellations and video failures must not retry.
          if (['NotAllowedError', 'AbortError'].includes(error?.name) || !audioStartFailed(error)) throw error;
          warning = audioUnavailable;
          if (attemptNumber < 2) {
            onRetry();
            await wait(attemptNumber === 0 ? 350 : 900);
          }
        }
      }
    } else if (withAudio) warning = audioNotIsolated;
    // Never recover using unrestricted loopback: that would echo the call.
    const stream = await attempt(false);
    stream.getAudioTracks().forEach(track => { track.stop(); stream.removeTrack(track); });
    return { stream, warning };
  }
  const exported = { capture };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.EntreTelaCapture = exported;
})(typeof window === 'object' ? window : globalThis);
