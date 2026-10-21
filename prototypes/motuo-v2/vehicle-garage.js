/* Appearance is local visual preference, never a measured vehicle property. */
(function (global) {
  'use strict';
  const KEY = 'motuo.vehicle-appearance.v1';
  const presets = Object.freeze({
    panda: {name:'熊猫白', bodyColor:'#f2f1ec', accentColor:'#171b22'},
    stealth: {name:'曜石黑', bodyColor:'#252b35', accentColor:'#b8c4ce'},
    glacier: {name:'冰川蓝', bodyColor:'#409bc6', accentColor:'#131c2c'},
    ember: {name:'熔岩红', bodyColor:'#c93241', accentColor:'#191c24'},
    violet: {name:'电光紫', bodyColor:'#7854ba', accentColor:'#191a28'}
  });
  function normalizeAppearance(value) {
    const v = value && typeof value === 'object' && value.version === 1 ? value : {};
    const color = (x,fallback) => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x) ? x.toLowerCase() : fallback;
    return {version:1, bodyColor:color(v.bodyColor,presets.panda.bodyColor),
      accentColor:color(v.accentColor,presets.panda.accentColor),
      finish:v.finish === 'satin' ? 'satin' : 'gloss', autoRotate:v.autoRotate !== false,
      // 2D comic is the default look; 3D realistic stays one tap away.
      renderStyle:v.renderStyle === '3d' ? '3d' : '2d'};
  }
  function create(doc = document) {
    const $ = id => doc.getElementById(id), all = selector => [...doc.querySelectorAll(selector)];
    let appearance, viewer=null, status='loading', disposed=false, generation=0;
    let context={page:'cockpit',parked:true,departing:false,reduced:false,active:!doc.hidden,chase:false},chasing=false;
    try { appearance=normalizeAppearance(JSON.parse(global.localStorage.getItem(KEY))); }
    catch { appearance=normalizeAppearance(null); }
    function save() {
      try { global.localStorage.setItem(KEY,JSON.stringify(appearance)); }
      catch { $('paint-save-state').textContent='本次预览生效 · 浏览器未允许保存'; }
    }
    function paintUI() {
      const preset=Object.entries(presets).find(([,v])=>v.bodyColor===appearance.bodyColor&&v.accentColor===appearance.accentColor);
      $('paint-name').textContent=preset?.[1].name??'自定义车漆';
      $('body-color').value=appearance.bodyColor;$('accent-color').value=appearance.accentColor;
      all('button[data-paint]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.paint===preset?.[0])));
      all('button[data-finish]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.finish===appearance.finish)));
      $('vehicle-auto').setAttribute('aria-pressed',String(appearance.autoRotate));
      all('button[data-render-style]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.renderStyle===appearance.renderStyle)));
      doc.documentElement.dataset.vehicleStyle=appearance.renderStyle;
      $('vehicle-auto').textContent=context.reduced&&appearance.autoRotate?'环绕已减弱':appearance.autoRotate?'自动环绕 开':'自动环绕 关';
      $('garage-showroom').style.setProperty('--paint',appearance.bodyColor);
    }
    function apply() {
      viewer?.setAppearance(appearance);
      viewer?.setRenderStyle?.(appearance.renderStyle);
      viewer?.setAutoRotate(appearance.autoRotate&&!context.reduced);
      paintUI();
    }
    function reconcile() {
      if (!viewer || disposed) return;
      // The departure controller owns the very same canvas for 1.15 seconds.
      if(context.departing)return;
      const garage=context.page==='garage',chase=!garage&&context.chase&&!!$('chase-host');
      // While riding in the sport world the same canvas becomes a chase camera.
      viewer.mount($(garage?'garage-vehicle-host':chase?'chase-host':'cockpit-vehicle-host'));
      if(chase!==chasing){chasing=chase;viewer.setView(chase?'chase':'hero');}
      viewer.setInteractive(context.active&&!chase&&(garage||context.parked));
      viewer.setActive(context.active&&(garage||chase||(context.page==='cockpit'&&context.parked)));
      viewer.setAutoRotate(appearance.autoRotate&&!context.reduced&&!chase);
      paintUI();
    }
    function report(next) {
      status=typeof next==='string'?next:next.state??next.status;
      doc.documentElement.dataset.vehicleState=status;
      const labels={loading:'正在装载 3D 车库…',ready:'拖动旋转 · 双指缩放',error:'3D 暂未加载 · 可重试',unsupported:'此浏览器无法开启 3D',lost:'3D 显示中断 · 请重试','context-lost':'3D 显示中断 · 请重试'};
      all('[data-vehicle-status]').forEach(el=>el.textContent=labels[status]??'3D 暂不可用 · 可重试');
      all('.vehicle-loading').forEach(el=>el.hidden=status==='ready');
      all('[data-vehicle-control]').forEach(el=>el.disabled=status!=='ready');
      all('[data-vehicle-retry]').forEach(el=>el.hidden=status==='ready'||status==='loading');
      if(status==='ready') {apply();reconcile();}
    }
    async function initialize() {
      const run=++generation;
      viewer?.dispose();viewer=null;report('loading');
      try {
        const {createVehicleViewer}=await import('./vehicle-viewer.js?v=suzuki-20260920');
        if(disposed||run!==generation)return;
        viewer=createVehicleViewer({host:$('cockpit-vehicle-host'),modelURL:'./assets/models/suzuki-gsx-r1000/model.glb',
          onStatus:next=>{if(!disposed&&run===generation)report(next);}});
        viewer.canvas.addEventListener('pointerdown',()=>{appearance.autoRotate=false;save();apply();});
        apply();reconcile();
        await viewer.ready;
        if(!disposed&&run===generation){apply();reconcile();}
      } catch {if(!disposed&&run===generation)report('error');}
    }
    all('button[data-paint]').forEach(b=>b.addEventListener('click',()=>{
      Object.assign(appearance,presets[b.dataset.paint]);delete appearance.name;save();apply();
    }));
    for(const [id,key] of [['body-color','bodyColor'],['accent-color','accentColor']]){
      $(id).addEventListener('input',()=>{appearance=normalizeAppearance({...appearance,[key]:$(id).value});save();apply();});
    }
    all('button[data-finish]').forEach(b=>b.addEventListener('click',()=>{appearance.finish=b.dataset.finish;save();apply();}));
    all('button[data-render-style]').forEach(b=>b.addEventListener('click',()=>{appearance.renderStyle=b.dataset.renderStyle==='3d'?'3d':'2d';save();apply();}));
    all('[data-vehicle-view]').forEach(b=>b.addEventListener('click',()=>{
      appearance.autoRotate=false;save();apply();viewer?.setView(b.dataset.vehicleView);
    }));
    all('[data-vehicle-zoom]').forEach(b=>b.addEventListener('click',()=>viewer?.zoom(Number(b.dataset.vehicleZoom))));
    $('vehicle-auto').addEventListener('click',()=>{appearance.autoRotate=!appearance.autoRotate;save();apply();});
    $('vehicle-reset').addEventListener('click',()=>{viewer?.resetView();});
    all('[data-vehicle-retry]').forEach(b=>b.addEventListener('click',initialize));
    paintUI();initialize();
    return Object.freeze({
      update(next){Object.assign(context,next);reconcile();},
      getViewer(){return status==='ready'?viewer:null;},
      dispose(){disposed=true;generation++;viewer?.dispose();viewer=null;}
    });
  }
  global.MotuoGarage=Object.freeze({create,normalizeAppearance,presets});
})(window);
