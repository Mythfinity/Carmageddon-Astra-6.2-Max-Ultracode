// An exhaust pulse train and filtered noise supply every driving sound locally.
export function createAudio() {
  let context, master, engine, intake, exhaust, engineLevel, air, airLevel;
  let noiseBuffer, muted = false, gear = 0, playing = false, lastDrive = -1;
  const shiftSpeeds = [0, 10, 19, 29, 40, 55];

  function gain(destination, value = 0) {
    const node = context.createGain();
    node.gain.value = value;
    node.connect(destination);
    return node;
  }

  function filter(destination, type, frequency, resonance) {
    const node = context.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = resonance;
    node.connect(destination);
    return node;
  }

  function noise(destination, loop = false) {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = loop;
    source.connect(destination);
    return source;
  }

  function unlock() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    if (!context) {
      try { context = new Audio(); } catch { return; }
      master = gain(context.destination, muted ? 0 : 0.65);
      engineLevel = gain(master);
      exhaust = filter(engineLevel, 'lowpass', 330, 0.7);
      engine = context.createOscillator();
      // The first partial carries the rumble. The stronger upper partials read on phone speakers.
      const harmonics = Float32Array.of(0, 0.55, 0.3, 0.65, 0.46, 0.18, 0.25, 0.12, 0.1, 0.06);
      engine.setPeriodicWave(context.createPeriodicWave(new Float32Array(harmonics.length), harmonics));
      engine.frequency.value = 28;
      engine.connect(exhaust);
      engine.start();
      intake = context.createOscillator();
      intake.type = 'triangle';
      intake.frequency.value = 55.6;
      intake.connect(gain(exhaust, 0.17));
      intake.start();
      noiseBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const samples = noiseBuffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      airLevel = gain(master);
      air = filter(airLevel, 'bandpass', 650, 0.75);
      noise(air, true).start();
    }
    if (context.state !== 'running') context.resume().catch(() => {});
  }

  function setMuted(value) {
    muted = Boolean(value);
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.65, context.currentTime, 0.012);
  }

  function drive(player) {
    if (!context) return;
    const now = context.currentTime;
    if (!player || player.alive === false) {
      if (playing) {
        engineLevel.gain.setTargetAtTime(0, now, 0.014);
        airLevel.gain.setTargetAtTime(0, now, 0.014);
      }
      playing = false;
      gear = 0;
      return;
    }
    if (playing && now - lastDrive < 0.028) return;
    playing = true;
    lastDrive = now;
    const speed = Math.min(55, Math.abs(player.speed) || 0);
    while (gear < 4 && speed > shiftSpeeds[gear + 1]) gear++;
    while (gear > 0 && speed < shiftSpeeds[gear] - 2) gear--;
    const ratio = Math.max(0, Math.min(1, (speed - shiftSpeeds[gear]) / (shiftSpeeds[gear + 1] - shiftSpeeds[gear])));
    const rpm = (gear ? 46 : 28) + ratio * (gear ? 27 : 42) + (player.boosting ? 8 : 0);
    engine.frequency.setTargetAtTime(rpm, now, 0.075);
    intake.frequency.setTargetAtTime(rpm * 1.985, now, 0.065);
    exhaust.frequency.setTargetAtTime(200 + rpm * 3.7 + (player.boosting ? 230 : 0), now, 0.08);
    engineLevel.gain.setTargetAtTime(0.07 + 0.07 * Math.min(speed / 30, 1), now, 0.045);
    const slip = Math.max(0, Math.min(1, player.skid || 0));
    air.frequency.setTargetAtTime(player.boosting ? 660 : 850 + slip * 710, now, 0.08);
    airLevel.gain.setTargetAtTime(slip * 0.13 + (player.boosting ? 0.14 : 0), now, 0.055);
  }

  function tone(hz, endHz, duration, volume, delay = 0, waveform = 'sine') {
    const start = context.currentTime + delay;
    const envelope = gain(master);
    const osc = context.createOscillator();
    osc.type = waveform;
    osc.frequency.setValueAtTime(hz, start);
    osc.frequency.exponentialRampToValueAtTime(endHz, start + duration);
    osc.connect(envelope);
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(volume, start + 0.009);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.start(start);
    osc.stop(start + duration + 0.012);
    osc.onended = () => { osc.disconnect(); envelope.disconnect(); };
  }

  function burst(cutoff, duration, volume) {
    const start = context.currentTime;
    const envelope = gain(master);
    const body = filter(envelope, 'lowpass', cutoff, 0.78);
    body.frequency.exponentialRampToValueAtTime(130, start + duration);
    const source = noise(body);
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(volume, start + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.start(start);
    source.stop(start + duration + 0.012);
    source.onended = () => { source.disconnect(); body.disconnect(); envelope.disconnect(); };
  }

  function beep(final = false) {
    if (!context || muted) return;
    tone(final ? 660 : 330, final ? 660 : 330, final ? 0.32 : 0.13, 0.16, 0, 'triangle');
  }

  function event(type, intensity = 1) {
    if (!context || muted) return;
    const strength = Math.max(0.15, Math.min(1, Number(intensity) || 0));
    if (type === 'impact' || type === 'ram' || type === 'wreck') {
      const wreck = type === 'wreck';
      burst(wreck ? 1850 : 1180, wreck ? 0.62 : 0.23, (wreck ? 0.55 : 0.40) * strength);
      tone(wreck ? 107 : 130, 37, wreck ? 0.42 : 0.17, 0.26 * strength, 0, 'triangle');
    } else if (type === 'boost') {
      burst(1350, 0.26, 0.15);
    } else if (type === 'checkpoint') {
      tone(440, 440, 0.115, 0.11, 0, 'triangle');
      tone(659, 659, 0.18, 0.10, 0.072, 'triangle');
    } else if (type === 'finish') {
      tone(392, 392, 0.2, 0.14, 0, 'triangle');
      tone(294, 294, 0.45, 0.12, 0.135, 'triangle');
    }
  }

  return { unlock, setMuted, drive, event, beep };
}
