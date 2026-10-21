 // Runs inside the reviewed HUD closure only in the bundled native entry point.
 let nativeReceivedAt=0, nativePendingDeparture=null, nativeWrappedId=null;
 function nativeSend(action){if(nativeHost)window.webkit.messageHandlers.motuo.postMessage({action});}
 function nativeAudio(){
  const s=state.nativeSnapshot;
  const valid=!!s?.sound?.live&&performance.now()-nativeReceivedAt<1000&&!document.hidden&&state.phase!=='paused';
  soundDemo=false;audioLive=valid;
  if(!valid){clearSoundFeatures();inputQuality=s?.sound?.status||'麦克风关闭';return;}
  const f=s.sound;energy=Math.max(0,Math.min(1,f.level||0));inputDb=Number.isFinite(f.db)?f.db:null;
  spectrum=Array.from({length:32},(_,i)=>Math.max(0,Math.min(1,f.spectrum?.[i]||0)));
  wave=Array.from({length:64},(_,i)=>Math.max(-1,Math.min(1,f.wave?.[i]||0)));
  bandLevels=[spectrum.slice(0,10),spectrum.slice(10,21),spectrum.slice(21)].map(a=>a.reduce((x,y)=>x+y,0)/a.length);
  inputClipped=!!f.clipped;inputQuality=inputClipped?'输入削波':'外界混合声音 · 本机分析';state.beat=energy;
 }
 function nativeLabels(){
  const s=state.nativeSnapshot;if(!s)return;
  const stale=performance.now()-nativeReceivedAt>1500;
  const valid=Number.isFinite(s.speedKmh)&&!stale&&state.phase==='riding';
  const estimated=valid&&s.speedSource==='inertial';
  $('speed').textContent=state.phase==='idle'?'0':valid?String(Math.round(s.speedKmh)):'—';
  $('speed-estimate').hidden=!estimated;
  $('speed-source').textContent=s.simulated?'DEMO · 模拟速度':estimated?'IMU 短时估计':state.phase==='paused'?'记录已暂停':valid?'GPS 实测速度':'等待有效定位';
  $('ride-state').textContent=stale?'等待原生数据':estimated?`惯导估计 ±${Number(s.uncertaintyKmh||0).toFixed(1)} km/h · 待实车标定`:s.stateLabel;
  $('accel-source').textContent=(s.simulated?'DEMO · 模拟':'')+(s.speedSource==='inertial'?'惯导速度差分':'GPS 速度差分');
  if(stale||!valid){$('accel-value').textContent='—';$('accel-g').textContent='— g';$('accel-positive').style.width=$('accel-negative').style.width='0%';}
  $('gps-status').querySelector('span').textContent=s.locationStatus;
  $('nas-status').querySelector('span').textContent='本机记录 · NAS 待恢复';
  const watch=document.querySelector('.statuses .status-item:nth-child(2)');if(watch)watch.innerHTML=icon('watch')+(s.watchReachable?'Watch 在线':'Watch 未连接');
  $('ambient-source').textContent=s.sound?.status||'麦克风关闭';$('mic-pill-label').textContent=audioLive?'聆听中':'声浪';
  $('mic-open').setAttribute('aria-label','声音输入：'+(s.sound?.status||'麦克风关闭'));
  $('yu7-sound-source').textContent=audioLive?'麦克风声浪':'声浪待命';
  $('app').classList.toggle('mic-live',audioLive);$('app').classList.remove('sound-demo');
  $('trace-quality').textContent=s.simulated?'DEMO · km/h':valid?'速度趋势 · km/h':'缺测 · 留空';
  $('song-title').textContent=s.musicTitle||'选择 Apple Music 歌曲';document.querySelector('.song small').textContent=s.musicArtist||'Apple Music · 与声浪独立';
  $('music-toggle').innerHTML=icon(s.musicPlaying?'pause':'play');$('music-toggle').setAttribute('aria-label',s.musicPlaying?'暂停音乐':'播放音乐');
  $('music-toggle').setAttribute('aria-pressed',String(!!s.musicPlaying));
  document.querySelector('.demo')?.replaceChildren(document.createTextNode(s.simulated?'DEMO':'RIDE OS'));
  document.querySelector('.vehicle-title strong').textContent=s.vehicleModel||'我的摩托';
  $('page-subtitle').textContent=s.simulated?'DEMO · 模拟数据':'MOTUO / RIDE OS';
  if(state.phase==='idle')$('ride-primary').innerHTML=icon('power')+`<span class="button-label">${s.simulated?'进入演示骑行':'开始骑行'}</span>`;
 }
 // The saved native ride summary drives the full-screen recap; the native detail opens from its last card.
 function nativeWrapped(f){
  const ride={distance:Math.max(0,f.distanceM||0),seconds:Math.max(0,f.durationS||0),maxSpeed:Math.max(0,f.maxSpeedKmh||0),source:f.simulated?'simulated':'measured'};
  if(!fxLevel().world||!gameFx.wrappedRecap(ride,game.summary(),{native:true,onClose:reason=>nativeSend(reason==='detail'?'rideDetail':'wrappedDone')})){nativeSend('rideDetail');return;}
  nativeSend('wrappedShown');
 }
 if(nativeHost){
  document.documentElement.classList.add('native-host');
  $('cockpit').setAttribute('aria-label','原生骑行驾驶舱');
  $('map-toggle').setAttribute('aria-label','开源导航状态');
  $('preview-launch').setAttribute('aria-label','动效预演 · 不开始真实骑行');
  $('music-prev').setAttribute('aria-label','上一首');$('music-next').setAttribute('aria-label','下一首');
  const card=document.querySelector('#page-garage .cards');card.replaceChildren();
  const profile=document.createElement('button');profile.className='native-profile';profile.id='native-profile';profile.textContent='车辆档案 · 手册 · 保养';card.append(profile);
  const song=document.querySelector('.song');song.setAttribute('role','button');song.tabIndex=0;song.setAttribute('aria-label','选择 Apple Music 歌曲');song.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();nativeSend('musicLibrary');}});
  document.addEventListener('click',event=>{
   const button=event.target.closest('button,.song,.album');if(!button)return;
   const actions={'ride-primary':'primary','ride-stop':'finish','finish-confirm':'finish','music-toggle':'musicToggle','music-prev':'musicPrevious','music-next':'musicNext','mic-open':'microphone','sound-trend-open':'microphone','preview-launch':'demoStart','native-profile':'garage','map-toggle':'navigation','destination-open':'navigation','history-start':'history','map-info':'navigation'};
   let action=actions[button.id];if(button.matches('.song,.album'))action='musicLibrary';
   if(button.dataset.page==='history')action='history';if(button.dataset.page==='settings')action='settings';
   if(action){event.preventDefault();event.stopImmediatePropagation();if((action==='primary'||action==='demoStart')&&state.phase==='idle')nativePendingDeparture=departure.capture();nativeSend(action);}
  },true);
  window.MotuoNativeReceive=s=>{
   if(!s||!['idle','riding','paused'].includes(s.phase))return;
   nativeReceivedAt=performance.now();const oldPhase=state.phase,oldMotion=state.motion;
   state.nativeSnapshot=s;state.nativeModal=!!s.modal;state.phase=s.phase;state.seconds=Math.max(0,s.seconds||0);state.distance=Math.max(0,s.distanceM||0);
   state.speed=Number.isFinite(s.speedKmh)?s.speedKmh:0;state.speedSampleTime=s.sampleTime;
   state.speedReading={speedKmh:s.phase==='riding'&&Number.isFinite(s.speedKmh)?s.speedKmh:null,source:s.speedSource||'unavailable',uncertaintyKmh:s.uncertaintyKmh||0,confidence:'low',reason:'native'};
   state.scenario=s.phase==='riding'&&s.speedSource==='unavailable'?'gps':'normal';state.motion=motionLabels[s.motion]?s.motion:'ready';
   const wasReduced=state.reduced;state.reduced=!!s.reduced;state.music=!!s.musicPlaying;$('app').classList.toggle('reduced-effects',state.reduced);
   // Thermal pressure lowers the motion tier (30fps, fewer particles/blur); reduced motion stays a user/system choice.
   motionClock.setHint(!!s.thermal);if(state.reduced&&!wasReduced)hudReset();renderPerfTier();
   $('app').classList.toggle('immersive',s.phase!=='idle');$('ride-stop').hidden=s.phase==='idle';
   if(oldPhase!==s.phase){updateControls();if(s.phase!=='riding')cancelDeparture();if(s.phase==='idle')hudReset();else if(oldPhase!=='idle')pauseFx(s.phase==='paused');if(s.phase==='idle'){state.stoppedSince=null;state.distance=0;state.seconds=0;setPage('cockpit');}}
   if(oldMotion!==state.motion&&s.phase==='riding')pulseEvent();
   nativeAudio();render();
   if(s.finishedRide&&s.finishedRide.id!==nativeWrappedId){nativeWrappedId=s.finishedRide.id;nativeWrapped(s.finishedRide);}
   if(oldPhase==='idle'&&s.phase==='riding'&&nativePendingDeparture){state.departureUntil=state.seconds+3.8;beginDeparture(nativePendingDeparture);nativePendingDeparture=null;}
  };
 }
