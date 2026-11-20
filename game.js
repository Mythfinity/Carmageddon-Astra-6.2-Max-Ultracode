import { createGame, stepGame, CHECKPOINTS, BOUNDS, PROPS, ROAD_WIDTH } from './sim.js';
import { createAudio } from './audio.js';

const $ = id => document.getElementById(id);
const app = $('app'), dialog = $('dialog');
const sound = createAudio();
const prefix = 'wreck-district-astra:';
const read = key => { try { return localStorage.getItem(prefix + key); } catch { return null; } };
const save = (key, value) => { try { localStorage.setItem(prefix + key, value); } catch {} };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const coarse = matchMedia('(pointer: coarse)');
const keys = new Set(), pointers = new Map();
const svgIcon = id => '<svg aria-hidden="true"><use href="#i-' + id + '"/></svg>';
let muted = read('muted') === 'true';
let game = createGame(), stage = 'menu', previousStage = '', modal = '';
let world, loading, frame = 0, previousTime = 0, countdown = 0, notice = 0;

function setSound() {
  sound.setMuted(muted);
  $('sound').innerHTML = svgIcon(muted ? 'muted' : 'volume') + '<span>SOUND ' + (muted ? 'OFF' : 'ON') + '</span>';
  $('sound').setAttribute('aria-label', muted ? 'Enable sound' : 'Mute sound');
  $('sound').setAttribute('aria-pressed', String(!muted));
}
function toggleSound() {
  sound.unlock();
  muted = !muted;
  setSound();
  save('muted', String(muted));
}
setSound();
$('sound').onclick = toggleSound;
const fullscreenSupported = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
$('fullscreen').hidden = !fullscreenSupported;
async function fullscreen() {
  if (!fullscreenSupported) return;
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement)
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else await (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen).call(document.documentElement);
  } catch { /* Embedded browsers can decline fullscreen. The game already fits its viewport. */ }
}
$('fullscreen').onclick = fullscreen;
for (const event of ['fullscreenchange','webkitfullscreenchange']) document.addEventListener(event, () => {
  $('fullscreen').setAttribute('aria-label', (document.fullscreenElement || document.webkitFullscreenElement) ? 'Exit fullscreen' : 'Enter fullscreen');
  world?.resize();
});

function drawCircuitDossier() {
  const plot = p => [78 + p.z * .68, 48 + p.x * .65];
  const line = CHECKPOINTS.map(p => plot(p).join(',')).join(' ');
  const start = plot(CHECKPOINTS.at(-1));
  $('track-drawing').innerHTML = '<polygon points="' + line + '" stroke="#6b6f5b" stroke-width="6" fill="#2a2d2526"/><polygon points="' + line + '" stroke="#b5b6a0" stroke-width="2"/><path d="m' + (start[0]-4) + ',' + (start[1]-4) + ' 8,8" stroke="#ff733d" stroke-width="4"/><circle cx="' + start[0] + '" cy="' + start[1] + '" r="2.4" fill="#ffe4a5" stroke="none"/>';
}
drawCircuitDossier();

function resetInput() {
  keys.clear();
  pointers.clear();
  document.querySelectorAll('#touchpad .active').forEach(el => el.classList.remove('active'));
}
function inputState() {
  const held = new Set(pointers.values());
  const has = (touch, ...codes) => held.has(touch) || codes.some(code => keys.has(code));
  return {
    steer: Number(has('right','ArrowRight','KeyD')) - Number(has('left','ArrowLeft','KeyA')),
    throttle: Number(has('throttle','ArrowUp','KeyW')),
    brake: Number(has('brake','ArrowDown','KeyS')),
    boost: has('boost','ShiftLeft','ShiftRight'), handbrake: has('handbrake','Space'),
  };
}
for (const button of document.querySelectorAll('[data-input]')) {
  button.onpointerdown = e => {
    e.preventDefault();
    if (stage !== 'playing' && stage !== 'countdown') return;
    button.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, button.dataset.input);
    button.classList.add('active');
  };
  const release = e => {
    pointers.delete(e.pointerId);
    if (![...pointers.values()].includes(button.dataset.input)) button.classList.remove('active');
  };
  button.onpointerup = button.onpointercancel = button.onlostpointercapture = release;
  button.oncontextmenu = e => e.preventDefault();
}

function openModal(type, kicker, title, html, actions) {
  modal = type;
  $('modal-kicker').textContent = kicker;
  $('dialog-title').textContent = title;
  $('dialog-content').innerHTML = html;
  $('dialog-actions').replaceChildren();
  for (const [i, [label, action]] of actions.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = i === 0 ? 'primary' : 'secondary';
    button.textContent = label;
    button.onclick = action;
    $('dialog-actions').append(button);
  }
  if (!dialog.open) dialog.showModal();
  $('dialog-actions').firstElementChild?.focus({preventScroll:true});
}
function closeModal() {
  modal = '';
  if (dialog.open) dialog.close();
}
function dismiss() {
  if (modal === 'paused') resume();
  else if (modal === 'result') menu();
  else { closeModal(); $('help').focus({preventScroll:true}); }
}
$('close').onclick = dismiss;
dialog.oncancel = e => { e.preventDefault(); dismiss(); };
$('help').onclick = () => {
  const rows = coarse.matches
    ? [['Steer','◀ / ▶'],['Accelerate','Gas'],['Brake / reverse','Brake'],['Nitro / handbrake','Nitro / Drift'],['Pause','Pause button']]
    : [['Drive / steer','W A S D or arrow keys'],['Brake / reverse','S or ↓'],['Nitro while accelerating','Shift'],['Handbrake / drift','Space'],['Pause / sound','Esc or P / M']];
  openModal('help','DRIVER MANUAL','HOW TO PLAY',
    '<p>Clear ten gates per lap and finish both laps, or wreck all three rivals. Each gate adds three seconds. A rival you wreck adds six. Hold the brake to reverse out of trouble.</p><dl class="manual">' +
    rows.map(([action,key]) => '<div><dt>' + action + '</dt><dd>' + key + '</dd></div>').join('') + '</dl>',
    [['START RACE',startRace],['BACK',dismiss]]);
};
function menu() {
  cancelAnimationFrame(frame); frame = 0;
  stage = 'menu';
  closeModal(); resetInput(); sound.drive(null);
  app.dataset.screen = 'menu';
  $('race').hidden = true; $('pause').hidden = true; $('menu').hidden = false;
  $('start').focus({preventScroll:true});
}
function hint(text, seconds) {
  $('message').textContent = text;
  $('message').classList.add('on');
  notice = seconds;
}
async function ensureWorld() {
  if (world) return;
  if (!loading) loading = (async () => {
    try {
      const { createWorld } = await import('./world.js');
      world = createWorld($('world'));
    } catch (error) {
      console.warn('Using the overhead circuit view.', error.message);
      const canvas = document.createElement('canvas');
      canvas.className = 'fallback';
      canvas.setAttribute('aria-label','Overhead driving arena');
      $('world').after(canvas);
      world = overheadView(canvas);
    }
  })();
  await loading;
}
async function startRace() {
  sound.unlock(); closeModal(); resetInput(); sound.drive(null);
  cancelAnimationFrame(frame); frame = 0; stage = 'loading';
  $('start').disabled = true;
  app.dataset.screen = 'race';
  $('menu').hidden = true; $('race').hidden = false; $('pause').hidden = false;
  $('count').textContent = '•••';
  $('message').classList.remove('on');
  game = createGame(); updateHud();
  await ensureWorld();
  $('start').disabled = false;
  world.resize();
  countdown = 3; stage = 'countdown';
  $('count').textContent = '3';
  hint(coarse.matches ? 'HOLD GAS TO DRIVE · FOLLOW THE GATES' : 'WASD / ARROWS TO DRIVE · SHIFT FOR NITRO', 4.2);
  sound.beep(false);
  if (document.hidden) pause();
  else run();
}
$('start').onclick = startRace;

function pause() {
  if (stage !== 'playing' && stage !== 'countdown') return;
  previousStage = stage; stage = 'paused';
  cancelAnimationFrame(frame); frame = 0; resetInput(); sound.drive(null);
  openModal('paused','FOUNDRY LOOP','RACE PAUSED','<p>Your car and the race clock are paused.</p>',
    [['RESUME',resume],['RESTART',startRace],['MAIN MENU',menu]]);
}
function resume() {
  if (stage !== 'paused' || document.hidden) return;
  closeModal(); resetInput(); sound.unlock();
  stage = previousStage; run();
}
$('pause').onclick = pause;
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.addEventListener('blur', pause);

function result() {
  stage = 'finished'; sound.drive(null); resetInput();
  const won = game.status === 'won';
  const best = Math.max(Number(read('best')) || 0, game.score);
  save('best',String(best));
  const table = [['Gates cleared',game.passed + ' / ' + game.totalCheckpoints],['Rivals wrecked',game.wrecks + ' / 3'],['Score',game.score.toLocaleString()],['Personal best',best.toLocaleString()]];
  openModal('result',won ? 'EVENT WON' : 'EVENT LOST',game.reason.toUpperCase(),
    '<dl class="results">' + table.map(([k,v])=>'<div><dt>'+k+'</dt><dd>'+v+'</dd></div>').join('')+'</dl>',
    [['RACE AGAIN',startRace],['MAIN MENU',menu]]);
}

const driveKeys = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD','ShiftRight','ShiftLeft','Space']);
window.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'KeyM' && !e.repeat) { e.preventDefault(); toggleSound(); return; }
  if (e.code === 'KeyF' && !e.repeat) { e.preventDefault(); fullscreen(); return; }
  if (dialog.open) {
    if (modal === 'paused' && e.code === 'KeyP' && !e.repeat) { e.preventDefault(); resume(); }
    return;
  }
  if (stage === 'menu' && e.code === 'Enter' && !(e.target instanceof HTMLButtonElement) && !e.repeat) {
    e.preventDefault(); startRace(); return;
  }
  if (stage !== 'playing' && stage !== 'countdown') return;
  if (['Escape','KeyP'].includes(e.code) && !e.repeat) { e.preventDefault(); pause(); return; }
  if (driveKeys.has(e.code)) { e.preventDefault(); keys.add(e.code); }
});
window.addEventListener('keyup', e => keys.delete(e.code));

function circuitLine(ctx, plot) {
  ctx.beginPath();
  CHECKPOINTS.forEach((p,i) => { const [x,y] = plot(p); if (!i) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
  ctx.closePath();
}
const mapContext = $('map').getContext('2d');
function minimap() {
  const ctx = mapContext;
  ctx.clearRect(0,0,280,205);
  const plot = p => [141 - p.x * 1.27, 103 - p.z * .84];
  circuitLine(ctx,plot);
  ctx.lineJoin = 'round'; ctx.strokeStyle = '#636854'; ctx.lineWidth = 16; ctx.stroke();
  ctx.strokeStyle = '#252922'; ctx.lineWidth = 9; ctx.stroke();
  const [gx,gy] = plot(CHECKPOINTS[game.checkpoint]);
  ctx.strokeStyle = '#ff9a5b';ctx.lineWidth = 4;ctx.strokeRect(gx-6,gy-6,12,12);
  for (const c of game.rivals) {
    const [x,y] = plot(c);
    ctx.fillStyle = c.alive ? c.color : '#68675a';ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();
  }
  const [x,y] = plot(game.player);
  ctx.save();ctx.translate(x,y);ctx.rotate(-game.player.heading);
  ctx.fillStyle = '#fff6d8';ctx.beginPath();ctx.moveTo(0,-9);ctx.lineTo(6,6);ctx.lineTo(0,3);ctx.lineTo(-6,6);ctx.closePath();ctx.fill();ctx.restore();
}
function updateHud() {
  const p = game.player, gate = CHECKPOINTS[game.checkpoint];
  $('lap').textContent = game.lap + ' / ' + game.laps;
  const t = Math.ceil(game.time);
  $('clock').textContent = String(Math.floor(t / 60)).padStart(2,'0') + ':' + String(t % 60).padStart(2,'0');
  $('wrecks').textContent = game.wrecks + ' / ' + game.rivals.length;
  $('gate').textContent = String(game.checkpoint + 1).padStart(2,'0') + ' / ' + CHECKPOINTS.length;
  $('speed').textContent = String(Math.round(Math.abs(p.speed) * 3.6)).padStart(3,'0');
  $('armor').style.width = Math.max(0,p.health) + '%';
  $('nitro').style.width = p.nitro + '%';
  const bearing = Math.atan2(gate.x-p.x,gate.z-p.z) - p.heading;
  $('waypoint').firstElementChild.style.transform = 'rotate(' + (-bearing-Math.PI/2) + 'rad)';
  minimap();
}
function run() { previousTime = performance.now(); frame = requestAnimationFrame(tick); }
function tick(time) {
  frame = 0;
  if (stage !== 'playing' && stage !== 'countdown') return;
  const dt = Math.min(.16, Math.max(0,(time-previousTime)/1000));
  previousTime = time;
  if (stage === 'countdown') {
    const last = Math.ceil(countdown);
    countdown -= dt;
    if (Math.ceil(countdown) !== last) {
      $('count').textContent = countdown <= 0 ? 'GO!' : Math.ceil(countdown);
      sound.beep(countdown <= 0);
    }
    if (countdown <= 0) stage = 'playing';
  } else {
    const input = inputState();
    stepGame(game,input,dt);
    sound.drive(game.player);
    if (game.elapsed > .7) $('count').textContent = '';
    for (const e of game.events) { sound.event(e.type,e.intensity); if (e.type !== 'finish') hint(e.text,1.25); }
    updateHud();
  }
  notice -= dt;
  if (notice <= 0) $('message').classList.remove('on');
  world.render(game,{mode:'play',dt,time:game.elapsed,reducedMotion:reducedMotion.matches});
  if (game.status !== 'playing') { result(); return; }
  frame = requestAnimationFrame(tick);
}
window.addEventListener('resize', () => {
  if (world && !$('race').hidden) {
    world.resize();
    if (stage === 'paused' || stage === 'finished') world.render(game,{mode:'play',dt:0,time:game.elapsed,reducedMotion:reducedMotion.matches});
  }
});

// A canvas-only overhead view keeps the same race playable on devices without WebGL.
function overheadView(canvas) {
  const ctx = canvas.getContext('2d');
  function resize() {
    const scale = Math.min(devicePixelRatio,2);
    canvas.width = Math.max(1,Math.round(canvas.clientWidth * scale));
    canvas.height = Math.max(1,Math.round(canvas.clientHeight * scale));
  }
  function render(state) {
    const w=canvas.width, h=canvas.height, player=state.player;
    const s=Math.max(w/166,h/128);
    ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#6f604d';ctx.fillRect(0,0,w,h);
    ctx.translate(w*.5,h*.56);ctx.scale(-s,-s);ctx.translate(-player.x,-player.z);
    ctx.fillStyle='#8b7760';ctx.fillRect(BOUNDS.minX,BOUNDS.minZ,BOUNDS.maxX-BOUNDS.minX,BOUNDS.maxZ-BOUNDS.minZ);
    circuitLine(ctx,p=>[p.x,p.z]);ctx.lineJoin='round';ctx.lineWidth=ROAD_WIDTH+1.8;ctx.strokeStyle='#c2ad86';ctx.stroke();ctx.lineWidth=ROAD_WIDTH;ctx.strokeStyle='#4b4b44';ctx.stroke();
    ctx.lineWidth=.35;ctx.setLineDash([3,4]);ctx.strokeStyle='#afa68a';ctx.stroke();ctx.setLineDash([]);
    for (const p of PROPS) {
      ctx.save();ctx.translate(p.x,p.z);ctx.rotate(-p.heading);
      ctx.fillStyle=({factory:'#775344',workshop:'#69503f',container:'#90583e',barrier:'#c0ae8e',drums:'#734332',tank:'#9d9989'})[p.type];
      ctx.strokeStyle='#4a4137';ctx.lineWidth=.5;
      if (p.type==='tank' || p.type==='drums') {ctx.beginPath();ctx.arc(0,0,p.r,0,Math.PI*2);ctx.fill();ctx.stroke();}
      else {ctx.fillRect(-p.width/2,-p.length/2,p.width,p.length);ctx.strokeRect(-p.width/2,-p.length/2,p.width,p.length);}
      ctx.restore();
    }
    const cp=CHECKPOINTS[state.checkpoint];ctx.save();ctx.translate(cp.x,cp.z);ctx.rotate(-cp.heading);
    ctx.fillStyle='#ffb45c';ctx.fillRect(-ROAD_WIDTH/2,-.5,ROAD_WIDTH,1);ctx.restore();
    for (const car of [...state.rivals,player]) {
      ctx.save();ctx.translate(car.x,car.z);ctx.rotate(-car.heading);
      ctx.fillStyle='#282922';ctx.fillRect(-1.65,-1.8,3.3,3.6);
      ctx.fillStyle=car.alive?car.color:'#3d3935';ctx.fillRect(-1.28,-2.6,2.56,5.2);
      ctx.fillStyle='#363d39';ctx.fillRect(-1.03,-.72,2.06,1.5);
      ctx.fillStyle='#fff0b6';ctx.fillRect(-1.15,2,.52,.4);ctx.fillRect(.65,2,.52,.4);ctx.restore();
    }
  }
  return {resize,render};
}
