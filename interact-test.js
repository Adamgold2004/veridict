const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');
const BASE='http://localhost:3000';
const login=async(e,p)=>{const r=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})});return r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');};
(async()=>{
  const judge=await login('judge@veridict.local','judge1234');
  const admin=await login('admin@veridict.local','admin1234');
  const tid=(await (await fetch(BASE+'/api/tournaments',{headers:{cookie:judge}})).json()).tournaments[0].id;
  const rid=(await (await fetch(BASE+'/api/tournaments/'+tid,{headers:{cookie:judge}})).json()).rounds[0].id;

  const errors=[];
  const vc=new VirtualConsole();
  vc.on('jsdomError',e=>{const m=e.message||String(e); if(!/fonts\.googleapis|Could not load/.test(m))errors.push(m);});
  const html=await (await fetch(BASE+'/ballot?round='+rid,{headers:{cookie:judge}})).text();
  const dom=new JSDOM(html,{url:BASE+'/ballot?round='+rid,runScripts:'dangerously',resources:'usable',
    [requestInterceptor](req){ if(!req.url.startsWith(BASE))return{response:new Response('',{status:204})}; req.headers.set('cookie',judge); },
    virtualConsole:vc,pretendToBeVisual:true,
    beforeParse(w){
      w.fetch=(u,o={})=>fetch(new URL(u,BASE).href,{...o,headers:{...(o.headers||{}),cookie:judge}});
      w.EventSource=class{constructor(){}close(){}addEventListener(){}};
      w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});
    }});
  const w=dom.window,d=w.document;
  await new Promise(r=>setTimeout(r,1500));

  console.log('submit disabled at start:', d.querySelector('#submit').disabled);
  console.log('note:', d.querySelector('#submit-note').textContent);

  // score every speech via the actual UI controls
  const cells=[...d.querySelectorAll('.flow-cell')];
  console.log('speeches in strip:', cells.length);
  for(const cell of cells){
    cell.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
    await new Promise(r=>setTimeout(r,60));
    for(const sl of d.querySelectorAll('#criteria input[type=range]')){
      sl.value=String(Math.round(Number(sl.max)*0.8));
      sl.dispatchEvent(new w.Event('input',{bubbles:true}));
    }
    await new Promise(r=>setTimeout(r,750)); // let debounce fire
  }
  console.log('tally after scoring:', d.querySelector('#tally-total').textContent);

  // rank via UI
  const rows=[...d.querySelectorAll('.rank-row')];
  for(let i=0;i<rows.length;i++){
    const btns=[...d.querySelectorAll('.rank-row')][i].querySelectorAll('.rank-pick button');
    btns[i].dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
    await new Promise(r=>setTimeout(r,200));
  }
  const rfd=d.querySelector('#rfd');
  rfd.value='Closing Government took it on the enforcement extension.';
  rfd.dispatchEvent(new w.Event('input',{bubbles:true}));
  await new Promise(r=>setTimeout(r,1000));

  console.log('submit enabled now:', !d.querySelector('#submit').disabled);
  d.querySelector('#submit').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,1500));
  console.log('submit label:', d.querySelector('#submit').textContent);
  console.log('note:', d.querySelector('#submit-note').textContent);

  // verify server-side
  await fetch(BASE+'/api/rounds/'+rid+'/status',{method:'POST',headers:{'Content-Type':'application/json',cookie:admin},body:JSON.stringify({status:'completed'})});
  const res=await (await fetch(BASE+'/api/rounds/'+rid+'/results',{headers:{cookie:judge}})).json();
  console.log('server teams:', res.teams.map(t=>t.name+' '+t.avg_rank).join(' | '));
  console.log('server speakers:', res.speakers.map(s=>s.short_label+'='+s.avg).join(' '));
  console.log('server rfd:', res.reasons.map(r=>r.judge+': '+String(r.reasoning).slice(0,40)).join(''));
  if(errors.length) console.log('JS ERRORS:',errors); else console.log('no JS errors');
})();
