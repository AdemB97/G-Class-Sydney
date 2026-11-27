import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/* ================= Helpers ================= */
const pad=n=>String(n).padStart(2,'0');
const iso=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const today=()=>{const d=new Date();d.setHours(0,0,0,0);return d};
const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x};
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDay=s=>{const d=new Date(s+'T00:00');return DOW[d.getDay()]+' '+d.getDate()+' '+MON[d.getMonth()]};
const fmtTime=t=>{const d=new Date(t);return pad(d.getHours())+':'+pad(d.getMinutes())};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ddmmyy=s=>{if(!s)return'';const [y,m,d]=s.split('-');return d+'/'+m+'/'+y.slice(2)};
const h12=t=>{if(!/^\d\d:\d\d$/.test(t||''))return t||'';let [h,m]=t.split(':').map(Number);const ap=h>=12?'pm':'am';h=h%12||12;return h+':'+pad(m)+ap};
const addHours=(t,hrs)=>{if(!/^\d\d:\d\d$/.test(t||'')||!hrs)return'';const [h,m]=t.split(':').map(Number);const mins=h*60+m+Math.round(hrs*60);return pad(Math.floor(mins/60)%24)+':'+pad(mins%60)};
const initials=n=>(n||'?').trim().split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase();
const $=id=>document.getElementById(id);
function toast(msg){const el=document.createElement('div');el.className='toast';el.textContent=msg;document.body.appendChild(el);setTimeout(()=>el.remove(),3000)}

const configured=SUPABASE_URL&&SUPABASE_ANON_KEY&&!SUPABASE_URL.includes('YOUR_');
const sb=configured?createClient(SUPABASE_URL,SUPABASE_ANON_KEY):null;

/* ================= State ================= */
// S mirrors the database for the signed-in person. Everything renders from it.
let S={profiles:[],cars:[],avail:{},jobs:[],trips:[],notes:[],chats:{},reads:{}};
let me=null, session=null, authMode='signin', tab='today', draft=null, sheet=null, viewJob=null, paste=null, delArm=null, chatJob=null, busy=false;
const staff=()=>S.profiles.filter(p=>p.role!=='pending');
const W=id=>S.profiles.find(w=>w.id===id)||{name:'?'};
const C=id=>S.cars.find(c=>c.id===id)||{name:'',code:'?'};
const J=id=>S.jobs.find(j=>j.id===id);
const openTrip=carId=>S.trips.find(t=>t.carId===carId&&!t.inAt);
const myOpenTrip=()=>S.trips.find(t=>t.wid===me.id&&!t.inAt);
const sw=(id)=>`<div class="swatch">${esc(C(id).code||'?')}</div>`;
const shifts=()=>S.jobs.flatMap(j=>j.lines.map(l=>({...l,job:j,date:j.date})));
const myShifts=()=>shifts().filter(s=>s.wid===me.id);
const isOwner=()=>me?.role==='owner';

/* ---------- Photo URLs (private bucket -> short-lived signed links) ---------- */
const urlCache={};
async function signPhotos(paths){
  const need=[...new Set(paths.filter(p=>p&&!urlCache[p]))]; if(!need.length) return;
  const {data}=await sb.storage.from('photos').createSignedUrls(need,60*60*6);
  (data||[]).forEach(d=>{if(d.signedUrl) urlCache[d.path]=d.signedUrl});
}
const purl=p=>urlCache[p]||'';
async function uploadPhoto(blob,folder){
  const path=`${folder}/${me.id}/${Date.now()}-${Math.random().toString(36).slice(2,7)}.jpg`;
  const {error}=await sb.storage.from('photos').upload(path,blob,{contentType:'image/jpeg'});
  if(error) throw error; return path;
}
function shrink(file,max=1600){return new Promise(res=>{const u=URL.createObjectURL(file);const img=new Image();img.onload=()=>{const s=Math.min(1,max/Math.max(img.width,img.height));const cv=document.createElement('canvas');cv.width=Math.round(img.width*s);cv.height=Math.round(img.height*s);cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);URL.revokeObjectURL(u);cv.toBlob(b=>res(b),'image/jpeg',.82)};img.onerror=()=>{URL.revokeObjectURL(u);res(null)};img.src=u})}

/* ================= Loading ================= */
async function loadAll(){
  const since=iso(addDays(today(),-60));
  const [p,c,a,j,l,n,t,m,r]=await Promise.all([
    sb.from('profiles').select('*').order('created_at'),
    sb.from('cars').select('*').eq('active',true).order('sort'),
    sb.from('availability').select('*').gte('day',iso(addDays(today(),-1))),
    sb.from('jobs').select('*').gte('date',since).order('date'),
    sb.from('job_lines').select('*').order('sort'),
    sb.from('notifications').select('*').order('created_at',{ascending:false}).limit(100),
    sb.from('trips').select('*').gte('day',since).order('out_at'),
    sb.from('messages').select('*').order('created_at').limit(2000),
    sb.from('chat_reads').select('*')]);
  const err=[p,c,a,j,l,n,t,m,r].find(x=>x.error); if(err) throw err.error;
  S.profiles=p.data; S.cars=c.data;
  S.avail={}; a.data.forEach(x=>S.avail[x.worker_id+'|'+x.day]=x.status);
  S.jobs=j.data.map(x=>({id:x.id,client:x.client,date:x.date,groom:{},bride:{},ceremony:{},photos:{},reception:{},getaway:{},note:'',...x.data,
    lines:l.data.filter(y=>y.job_id===x.id).map(y=>({id:y.id,carId:y.car_id,wid:y.worker_id,hours:y.hours==null?null:+y.hours,task:y.task,note:y.note,start:y.start,carText:y.car_text,driverText:y.driver_text}))}));
  S.notes=n.data.map(x=>({id:x.id,wid:x.worker_id,jobId:x.job_id,text:x.text,read:x.read,at:Date.parse(x.created_at)}));
  S.trips=t.data.map(tripFromRow);
  S.chats={}; m.data.forEach(addMsg);
  S.reads={}; r.data.forEach(x=>S.reads[x.job_id]=Date.parse(x.last_read_at));
  me=S.profiles.find(x=>x.id===session.user.id)||null;
  await signPhotos(S.trips.flatMap(x=>[...x.outPhotos,...x.inPhotos]));
}
function tripFromRow(x){return {id:x.id,carId:x.car_id,wid:x.worker_id,jobId:x.job_id,date:x.day,outAt:Date.parse(x.out_at),outOdo:x.out_odo,outFuel:x.out_fuel,outChecks:x.out_checks,outNotes:x.out_notes,outPhotos:x.out_photos||[],
  inAt:x.in_at?Date.parse(x.in_at):null,inOdo:x.in_odo,inFuel:x.in_fuel,inChecks:x.in_checks,inNotes:x.in_notes,inPhotos:x.in_photos||[]}}
function addMsg(x){(S.chats[x.job_id]=S.chats[x.job_id]||[]).push({id:x.id,wid:x.worker_id,text:x.text,photo:x.photo_path,sys:x.sys,at:Date.parse(x.created_at)})}

let reloadTimer=null;
function scheduleReload(){clearTimeout(reloadTimer);reloadTimer=setTimeout(async()=>{try{await loadAll();render()}catch(e){console.error(e)}},400)}
let channel=null;
function subscribe(){
  if(channel) sb.removeChannel(channel);
  channel=sb.channel('crew')
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages'},async ev=>{
      const x=ev.new; if((S.chats[x.job_id]||[]).some(m=>m.id===x.id)) return; addMsg(x);
      if(x.photo_path) await signPhotos([x.photo_path]);
      if(sheet==='chat'&&chatJob===x.job_id) markChatRead(x.job_id);
      if(!(sheet==='paste'||sheet==='trip')) render();
      if(x.worker_id!==me.id&&!x.sys&&!(sheet==='chat'&&chatJob===x.job_id)) toast(`${W(x.worker_id).name}: ${x.text||'sent a photo'}`)})
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications'},ev=>{toast(ev.new.text.split('.')[0]);scheduleReload()})
    .on('postgres_changes',{event:'*',schema:'public',table:'jobs'},()=>{if(sheet!=='paste')scheduleReload()})
    .on('postgres_changes',{event:'*',schema:'public',table:'job_lines'},()=>{if(sheet!=='paste')scheduleReload()})
    .on('postgres_changes',{event:'*',schema:'public',table:'trips'},()=>{if(sheet!=='trip')scheduleReload()})
    .subscribe();
}

/* ================= Run sheet parser (WhatsApp text -> job) ================= */
const CAR_KEYS=[[/cullinan/i],[/limo|chrysler/i],[/urus|lambo/i],[/ghost/i],[/g\s*-?\s*wagon|g\s*class|g63/i]];
function matchCar(txt){for(const [re] of CAR_KEYS) if(re.test(txt)){const c=S.cars.find(c=>re.test(c.name));if(c)return c.id}
  const t=txt.trim().toLowerCase();if(t.length<3)return'';const c=S.cars.find(c=>t.includes(c.name.toLowerCase())||c.name.toLowerCase().includes(t));return c?c.id:''}
function matchWorker(txt){const t=txt.trim().toLowerCase();if(!t)return'';const ws=staff();
  const w=ws.find(w=>w.name.toLowerCase()===t)||ws.find(w=>w.name.toLowerCase().startsWith(t))||ws.find(w=>t.startsWith(w.name.toLowerCase().split(' ')[0]));return w?w.id:''}
function parseTime(raw,ctx,warns){
  if(!raw)return {text:'',t24:''};
  const m=raw.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i);
  if(!m) return {text:raw.trim(),t24:''};
  let h=+m[1],mi=+(m[2]||0),ap=(m[3]||'').toLowerCase();
  if(ap==='am'&&h<9&&/ceremony|reception|photos|getaway/i.test(ctx)){warns.push(`${ctx} time says ${raw.trim()}. I've read it as ${h}:${pad(mi)}pm.`);ap='pm'}
  if(!ap) ap=(h>=1&&h<=9)?'pm':'am';
  const H=h%12+(ap==='pm'?12:0); const rest=raw.replace(m[0],'').trim(); const t24=pad(H)+':'+pad(mi);
  return {text:h12(t24)+(rest?' '+rest:''),t24};
}
function parseRunSheet(text){
  const warns=[];const job={id:null,client:'',date:'',groom:{},bride:{},ceremony:{},photos:{},reception:{},getaway:{},note:'',lines:[]};
  let sec=null;
  for(const raw of text.split(/\r?\n/)){
    const line=raw.replace(/\s+/g,' ').trim(); if(!line)continue; let m;
    if((m=line.match(/^(\d+)\s*x\s+(.+?)\s+-\s+(.+)$/i))){
      let left=m[2],right=m[3],hours=null;
      const hm=left.match(/@\s*(\d+(?:\.\d+)?)\s*h(?:ou)?rs?/i); if(hm){hours=+hm[1];left=left.replace(hm[0],' ')}
      const tm=left.match(/\(([^)]*)\)/g)||[]; const parens=tm.map(x=>x.slice(1,-1).trim()); tm.forEach(x=>left=left.replace(x,' '));
      const dot=left.split('·'); left=dot[0]; const after=dot.slice(1).join(' ').trim();
      const task=[after,...parens].filter(Boolean).join(' · ');
      const rn=right.match(/^([^(]+?)\s*(?:\((.*)\))?$/); const who=(rn?rn[1]:right).trim(); const note=rn&&rn[2]?rn[2]:'';
      const carText=left.replace(/\s+/g,' ').trim();
      const l={carText,carId:matchCar(carText),hours,task,driverText:who,wid:matchWorker(who),note};
      if(!l.carId) warns.push(`I don't recognise the car "${carText}". Pick it below.`);
      if(!l.wid) warns.push(`I don't recognise the driver "${who}". Pick them below.`);
      job.lines.push(l); sec=null; continue;
    }
    if((m=line.match(/^client\s*:\s*(.*)$/i))){job.client=m[1];continue}
    if((m=line.match(/^date\s*:\s*(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/i))){let y=+m[3];if(y<100)y+=2000;job.date=y+'-'+pad(+m[2])+'-'+pad(+m[1]);continue}
    if((m=line.match(/^(groom|bride)\s*:\s*(.*)$/i))){sec=m[1].toLowerCase();job[sec].name=m[2];continue}
    if((m=line.match(/^(ceremony|photos|getaway)\s*:?\s*$/i))){sec=m[1].toLowerCase();continue}
    if((m=line.match(/^reception\s*:?\s*(.*)$/i))){sec='reception';job.reception.venue=m[1];continue}
    if((m=line.match(/^note\s*:\s*(.*)$/i))){job.note=(job.note?job.note+' ':'')+m[1];continue}
    if(sec&&(m=line.match(/^([a-z ]+?)\s*:\s*(.*)$/i))){
      const k=m[1].toLowerCase(),v=m[2].trim(),o=job[sec];
      if(/time/.test(k)){const p=parseTime(v,sec[0].toUpperCase()+sec.slice(1),warns);o.time=p.text;o.t24=p.t24}
      else if(/address/.test(k))o.address=v; else if(/location|venue/.test(k))o.location=v;
      else if(/cars?/.test(k))o.cars=v; else if(/destination/.test(k))o.destination=v; else o[k]=v;
      continue;
    }
    if(/^g class run sheet$/i.test(line)) continue;
    job.note=(job.note?job.note+' ':'')+line;
  }
  if(!job.date) warns.push('No date found. Add a line like "Date : 29/11/26".');
  if(!job.client) warns.push('No client name found.');
  if(!job.lines.length) warns.push('No cars found. Car lines look like "1x RR Ghost @2 Hours - Adem".');
  const start=[job.groom.t24,job.bride.t24].filter(Boolean).sort()[0]||'';
  job.lines.forEach(l=>{l.start=l.start||start});
  return {job,warns};
}
function jobWarnings(job){
  const w=[];
  job.lines.forEach(l=>{
    if(l.wid&&S.avail[l.wid+'|'+job.date]==='no') w.push(`${W(l.wid).name} marked ${fmtDay(job.date)} as Off.`);
    const clash=S.jobs.find(j=>j.id!==job.id&&j.date===job.date&&j.lines.some(x=>x.carId&&x.carId===l.carId));
    if(clash) w.push(`${C(l.carId).name} is already on ${clash.client}'s job that day.`);
  });
  const seen={};job.lines.forEach(l=>{if(l.wid){if(seen[l.wid])w.push(`${W(l.wid).name} is on two cars in this job.`);seen[l.wid]=1}});
  return w;
}
function runSheetText(j){
  const L=['G Class Run Sheet',''];
  j.lines.forEach(l=>L.push(`1x ${C(l.carId).name||l.carText}${l.hours?` @${l.hours} Hours`:''}${l.task?` · (${l.task})`:''} - ${l.wid?W(l.wid).name:l.driverText}${l.note?` (${l.note})`:''}`));
  L.push('',`Client: ${j.client}`,`Date : ${ddmmyy(j.date)}`);
  [['groom','Groom'],['bride','Bride']].forEach(([k,n])=>{const o=j[k];if(o.name||o.address)L.push('',`${n}: ${o.name||''}`,`Address: ${o.address||''}`,`Time: ${o.time||''}`,`Cars: ${o.cars||''}`)});
  if(j.ceremony.time||j.ceremony.location)L.push('','CEREMONY',`Time: ${j.ceremony.time||''}`,`Location: ${j.ceremony.location||''}`,`Address: ${j.ceremony.address||''}`);
  if(j.photos.time||j.photos.address)L.push('','PHOTOS',`Time: ${j.photos.time||''}`,`Address: ${j.photos.address||''}`);
  if(j.note)L.push('',`NOTE: ${j.note}`);
  if(j.reception.venue||j.reception.time)L.push('',`RECEPTION: ${j.reception.venue||''}`,`Arrival Time: ${j.reception.time||''}`);
  if(j.getaway.time||j.getaway.destination)L.push('','GETAWAY',`Time: ${j.getaway.time||''}`,`Destination: ${j.getaway.destination||''}`);
  return L.join('\n');
}
const TEMPLATE=`G Class Run Sheet

1x RR Cullinan @6 Hours - Sammy
1x G Wagon · Getaway Car - Ahmed K

Client:
Date : dd/mm/yy

Groom:
Address:
Time:
Cars:

Bride:
Address:
Time:
Cars:

CEREMONY
Time:
Location:
Address:

PHOTOS
Time:
Address:

RECEPTION:
Arrival Time:

GETAWAY
Time:
Destination: `;

/* ---------- Pickup matching ---------- */
function carTokenMatch(tok,carId){const c=C(carId),T=tok.trim().toLowerCase();if(!T||!carId)return false;
  if(T==='rr'||T==='rolls')return /^rr\b|rolls/i.test(c.name);
  if(T==='g'||T==='g wagon'||T==='gwagon')return /g\s*-?\s*wagon/i.test(c.name);
  return T.length>2&&(matchCar(tok)===carId||c.name.toLowerCase().includes(T))}
function pickupFor(job,l){const t=(l.task||'').toLowerCase();
  if(/groom/.test(t))return ['Groom',job.groom]; if(/bride/.test(t))return ['Bride',job.bride];
  for(const k of ['bride','groom']){const toks=(job[k].cars||'').split(/&|,|\+|\band\b/i);if(toks.some(x=>carTokenMatch(x,l.carId)))return [k==='groom'?'Groom':'Bride',job[k]]}
  return null}
function members(job){return [...new Set([...S.profiles.filter(w=>w.role==='owner').map(w=>w.id),...job.lines.map(l=>l.wid).filter(Boolean)])]}

/* ---------- Unread ---------- */
const chatUnread=jobId=>{const since=S.reads[jobId]||0;return (S.chats[jobId]||[]).filter(x=>!x.sys&&x.wid!==me.id&&x.at>since).length};
const myJobs=()=>isOwner()?S.jobs:S.jobs.filter(j=>j.lines.some(l=>l.wid===me.id));
const unreadCount=()=>S.notes.filter(n=>n.wid===me.id&&!n.read).length+myJobs().reduce((n,j)=>n+chatUnread(j.id),0);
async function markChatRead(jobId){S.reads[jobId]=Date.now();await sb.from('chat_reads').upsert({worker_id:me.id,job_id:jobId,last_read_at:new Date().toISOString()})}
async function markNotesRead(jobId){const ids=S.notes.filter(n=>n.wid===me.id&&!n.read&&(!jobId||n.jobId===jobId)).map(n=>n.id);if(!ids.length)return;
  S.notes.forEach(n=>{if(ids.includes(n.id))n.read=true});await sb.from('notifications').update({read:true}).in('id',ids)}

/* ================= Rendering ================= */
const ICON={
 today:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 17h14l-1.5-6.5A2 2 0 0 0 15.6 9H8.4a2 2 0 0 0-1.9 1.5Z"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/></svg>',
 avail:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
 shifts:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
 roster:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>',
 fleet:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21V8l8-5 8 5v13"/><path d="M8 21v-6h8v6"/></svg>',
 log:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/></svg>',
 staff:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0 0-6M21 20a6 6 0 0 0-4-5.6"/></svg>'};

function render(){
  const app=$('app');
  if(!configured){app.innerHTML=`<div class="wrap login"><div class="card"><h2>Almost there</h2><p class="muted">This copy of G Class Crew isn't connected to its database yet. Add the Supabase URL and key to <span class="mono">config.js</span>.</p></div></div>`;return}
  if(!session){app.innerHTML=authView();bindAuth();return}
  if(!me){app.innerHTML=`<div class="wrap login"><div class="card"><p class="muted" style="margin:0">Loading…</p></div></div>`;return}
  if(me.role==='pending'){app.innerHTML=`<div class="wrap login"><div class="hero"><span class="eyebrow">G Class Hire Sydney · Staff only</span><h1>Thanks, ${esc(me.name)}</h1><p class="muted">Your account is waiting for Ahmed to approve it. Once he does, refresh this page.</p></div><div class="row"><button class="btn" id="refresh">Refresh</button><button class="btn ghost" id="logout">Log out</button></div></div>`;
    $('refresh').onclick=async()=>{await loadAll();render()};$('logout').onclick=logout;return}
  const owner=isOwner();
  const tabs=owner?[['today','Today'],['roster','Jobs'],['fleet','Cars'],['log','Photos'],['staff','Staff']]:[['today','Today'],['avail','Availability'],['shifts','My jobs']];
  if(!tabs.some(t=>t[0]===tab)) tab=tabs[0][0];
  const body={today:todayView,avail:availView,shifts:shiftsView,roster:rosterView,fleet:fleetView,log:logView,staff:staffView}[tab]();
  const u=unreadCount();
  // keep scroll position of an open sheet and typed text across re-renders
  const panel=document.querySelector('.sheet .panel'),st=panel?panel.scrollTop:0,chatDraft=$('chatin')?.value;
  app.innerHTML=`
  <header class="top"><div class="wrap ${owner?'wide':''}">
    <div class="avatar">${esc(initials(me.name))}</div>
    <div class="brand">G Class Crew<small>${esc(me.name)} · ${owner?'Owner':'Chauffeur'}</small></div>
    <div class="spacer"></div>
    <button class="bell" id="bell" aria-label="Inbox, ${u} unread"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>${u?`<span class="dot">${u}</span>`:''}</button>
    <button class="btn ghost" id="logout">Log out</button>
  </div></header>
  <main class="wrap ${owner?'wide':''}">${body}</main>
  <nav class="tabs"><div class="wrap ${owner?'wide':''}">${tabs.map(([k,l])=>`<button data-tab="${k}" aria-current="${tab===k}">${ICON[k]}${l}</button>`).join('')}</div></nav>
  ${sheet==='trip'?tripSheet():sheet==='job'?jobSheet():sheet==='paste'?pasteSheet():sheet==='inbox'?inboxSheet():sheet==='chat'?chatSheet():''}`;
  const np=document.querySelector('.sheet .panel');if(np&&sheet!=='chat')np.scrollTop=st;
  if(chatDraft&&$('chatin'))$('chatin').value=chatDraft;
  bind();
}

/* ---------- Sign in / sign up ---------- */
function authView(){
  const up=authMode==='signup', reset=authMode==='reset';
  return `<div class="wrap login">
   <div class="hero"><span class="eyebrow">G Class Hire Sydney · Staff only</span><h1>G Class Crew</h1>
   <p class="muted">Run sheets, availability and car sign-out in one place.</p></div>
   <form class="card" id="authform">
     <span class="eyebrow">${up?'Create your account':reset?'Reset your password':'Sign in'}</span>
     ${up?'<label class="f">Your name (as on the run sheet)<input id="aname" type="text" required autocomplete="name" placeholder="e.g. Sammy"></label>':''}
     <label class="f">Email<input id="aemail" type="email" required autocomplete="email"></label>
     ${reset?'':`<label class="f">Password<input id="apass" type="password" required minlength="8" autocomplete="${up?'new-password':'current-password'}"></label>`}
     <button class="btn primary block" type="submit" ${busy?'disabled':''}>${up?'Create account':reset?'Email me a reset link':'Sign in'}</button>
     <div class="row" style="justify-content:space-between">
       <button type="button" class="btn ghost" data-mode="${up?'signin':'signup'}">${up?'I already have an account':'New here? Create an account'}</button>
       ${up||reset?(reset?'<button type="button" class="btn ghost" data-mode="signin">Back to sign in</button>':''):'<button type="button" class="btn ghost" data-mode="reset">Forgot password?</button>'}
     </div>
   </form></div>`;
}
function bindAuth(){
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{authMode=b.dataset.mode;render()});
  $('authform').onsubmit=async e=>{e.preventDefault();busy=true;
    const email=$('aemail').value.trim(),pass=$('apass')?.value;
    try{
      if(authMode==='signup'){const {data,error}=await sb.auth.signUp({email,password:pass,options:{data:{name:$('aname').value.trim()},emailRedirectTo:location.origin+location.pathname}});
        if(error)throw error; if(!data.session) toast('Check your email to confirm your account, then sign in.')}
      else if(authMode==='reset'){const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});if(error)throw error;toast('Reset link sent. Check your email.');authMode='signin';render()}
      else {const {error}=await sb.auth.signInWithPassword({email,password:pass});if(error)throw error}
    }catch(err){toast(err.message||'Something went wrong. Try again.')}
    busy=false;
  };
}
async function logout(){await sb.auth.signOut();me=null;sheet=null;render()}

/* ---------- Job cards ---------- */
function myLineCard(s){
  const fin=addHours(s.start,s.hours); const p=pickupFor(s.job,s); const u=chatUnread(s.job.id);
  return `<div class="card">
    <div class="row"><span class="eyebrow">${fmtDay(s.date)}</span><div class="spacer"></div><span class="pill acc">${esc(s.job.client)}</span></div>
    <div class="status">${sw(s.carId)}<div style="min-width:0"><div class="big">${esc(C(s.carId).name||s.carText)}</div>
      <div class="muted">${s.task?esc(s.task)+' · ':''}${s.hours?s.hours+' hrs':'Hours not set'}${s.start?' · from '+h12(s.start):''}${fin?' to '+h12(fin):''}</div></div></div>
    ${p?`<div class="pickup"><span class="eyebrow">${p[0]} pickup</span><div><b class="mono">${esc(p[1].time||'Time TBC')}</b> · ${esc(p[1].address||'Address TBC')}</div></div>`:''}
    ${s.note?`<div class="warn-row">${esc(s.note)}</div>`:''}
    <div class="grid2"><button class="btn" data-job="${s.job.id}">Run sheet</button><button class="btn" data-chat="${s.job.id}">Group chat${u?` (${u})`:''}</button></div>
  </div>`;
}

/* ---------- Today ---------- */
function todayView(){
  const t=iso(today()); const mine=myShifts().filter(s=>s.date===t); const trip=myOpenTrip();
  let html=`<div><span class="eyebrow">${fmtDay(t)}</span><h2>${trip?'You have a car out':mine.length?'You\'re on today':'No job today'}</h2></div>`;
  html+=mine.map(myLineCard).join('');
  if(trip){
    html+=`<div class="card"><div class="status">${sw(trip.carId)}<div><div class="big">${esc(C(trip.carId).name)}</div><div class="muted">Signed out at ${fmtTime(trip.outAt)} · <span class="mono">${trip.outOdo} km</span> · Fuel ${esc(trip.outFuel)}</div></div></div>
      <button class="btn primary block" data-act="signin">Return car &amp; sign in</button></div>`;
  } else {
    const suggested=mine[0]?.carId;
    html+=`<div class="card"><span class="eyebrow">Sign a car out</span><p class="muted" style="margin:0">Pick the car you're taking. Cars already out are greyed.</p>
     <div class="cars">${S.cars.map(c=>{const o=openTrip(c.id);return `<button class="car" data-act="pickcar" data-car="${c.id}" ${o?'disabled':''}>${sw(c.id)}<div class="meta"><b>${esc(c.name)}</b><span class="mono muted">${esc(c.rego||'')}</span></div>${o?`<span class="pill no">Out · ${esc(W(o.wid).name.split(' ')[0])}</span>`:c.id===suggested?'<span class="pill acc">Your car today</span>':'<span class="pill ok">Available</span>'}</button>`}).join('')||'<p class="muted">No cars set up yet.</p>'}</div></div>`;
  }
  const next=myShifts().filter(s=>s.date>t).sort((a,b)=>a.date.localeCompare(b.date))[0];
  if(next) html+=`<div><span class="eyebrow">Next job</span></div>`+myLineCard(next);
  if(!isOwner()){
    const missing=Array.from({length:14},(_,i)=>iso(addDays(today(),i))).filter(d=>!S.avail[me.id+'|'+d]).length;
    if(missing) html+=`<div class="card"><div class="row"><span class="pill warn">${missing} day${missing>1?'s':''} not marked</span><span class="muted">in the next 2 weeks</span><div class="spacer"></div><button class="btn" data-tab="avail">Mark availability</button></div></div>`;
  }
  return html;
}

/* ---------- Availability ---------- */
function availView(){
  const t=today(); const days=Array.from({length:14},(_,i)=>addDays(t,i)); const lead=(t.getDay()+6)%7;
  let cells=''; for(let i=0;i<lead;i++) cells+='<div></div>';
  days.forEach(d=>{const k=iso(d),v=S.avail[me.id+'|'+k],sh=myShifts().some(s=>s.date===k);
    cells+=`<button class="day ${v||''} ${sh?'shift locked':''}" data-day="${k}" aria-label="${fmtDay(k)}: ${sh?'booked':v==='yes'?'available':v==='no'?'unavailable':'not set'}"><span class="dw">${DOW[d.getDay()]}</span><span class="dn">${d.getDate()}</span><span class="ds">${sh?'Booked':v==='yes'?'Free':v==='no'?'Off':'–'}</span></button>`});
  const set=days.filter(d=>S.avail[me.id+'|'+iso(d)]).length;
  return `<div><span class="eyebrow">Next 14 days</span><h2>When can you drive?</h2><p class="muted" style="margin:4px 0 0">Tap a day to switch between Free, Off and not set. Booked days are locked; message Ahmed to swap.</p></div>
  <div class="card">
   <div class="days">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<div class="dw muted" style="text-align:center;font-size:.68rem;font-weight:700;text-transform:uppercase">${d}</div>`).join('')}${cells}</div>
   <div class="legend"><span><i style="background:var(--ok)"></i>Free</span><span><i style="background:var(--no)"></i>Off</span><span><i style="background:var(--accent)"></i>Booked</span></div>
   <div class="row"><span class="pill ${set===14?'ok':'warn'}">${set}/14 marked</span><div class="spacer"></div><button class="btn" data-act="allfree">Mark rest Free</button></div>
  </div>`;
}

/* ---------- My jobs ---------- */
function shiftsView(){
  const t=iso(today()); const up=myShifts().filter(s=>s.date>=t).sort((a,b)=>(a.date+a.start).localeCompare(b.date+b.start));
  const past=S.trips.filter(x=>x.wid===me.id&&x.inAt).slice(-5).reverse();
  return `<div><span class="eyebrow">Rostered</span><h2>My jobs</h2></div>
  ${up.length?up.map(myLineCard).join(''):'<div class="card"><p class="muted" style="margin:0">No jobs booked yet. Keep your availability up to date and Ahmed will roster you.</p></div>'}
  ${past.length?`<div class="card"><span class="eyebrow">Recent car returns</span>${past.map(tripRow).join('')}</div>`:''}`;
}

/* ---------- Run sheet ---------- */
function rsSec(k,rows){rows=rows.filter(r=>r[1]);if(!rows.length)return'';return `<div class="rs-sec"><div class="k">${k}</div><div class="v">${rows.map(([l,v,cls])=>`<div>${l?`<span class="muted">${l}</span> `:''}<span class="${cls||''}">${esc(v)}</span></div>`).join('')}</div></div>`}
function jobSheet(){
  const j=J(viewJob); if(!j) return '';
  const owner=isOwner(); const warns=owner?jobWarnings(j):[];
  return `<div class="sheet" id="sheetbg"><div class="panel" role="dialog" aria-modal="true" aria-label="Run sheet">
   <div class="row"><div><span class="eyebrow">Run sheet · ${fmtDay(j.date)}</span><h2>${esc(j.client||'Untitled job')}</h2></div><div class="spacer"></div><button class="btn ghost" data-act="close" aria-label="Close">✕</button></div>
   ${warns.length?`<div class="warns">${warns.map(w=>`<div class="warn-row">${esc(w)}</div>`).join('')}</div>`:''}
   <div class="lineup">${j.lines.map(l=>{const fin=addHours(l.start,l.hours);const p=pickupFor(j,l);return `<div class="lu ${l.wid===me.id?'me':''}">${sw(l.carId)}<div class="body"><b>${esc(C(l.carId).name||l.carText)}</b>${l.wid===me.id?' <span class="pill acc">You</span>':''}<div class="muted" style="font-size:.82rem">${esc(l.wid?W(l.wid).name:l.driverText)}${l.hours?' · '+l.hours+' hrs':''}${l.task?' · '+esc(l.task):''}${fin?' · done ~'+h12(fin):''}</div>${p?`<div style="font-size:.82rem">${p[0]} pickup ${esc(p[1].time||'')}</div>`:''}${l.note?`<div style="font-size:.82rem;color:var(--warn);font-weight:700">${esc(l.note)}</div>`:''}</div></div>`}).join('')}</div>
   <div class="card rs">
    ${rsSec('Groom',[['',j.groom.name],['',j.groom.address],['Pickup',j.groom.time,'t'],['Cars',j.groom.cars]])}
    ${rsSec('Bride',[['',j.bride.name],['',j.bride.address],['Pickup',j.bride.time,'t'],['Cars',j.bride.cars]])}
    ${rsSec('Ceremony',[['',j.ceremony.location],['',j.ceremony.address!==j.ceremony.location?j.ceremony.address:''],['Time',j.ceremony.time,'t']])}
    ${rsSec('Photos',[['',j.photos.address],['Time',j.photos.time]])}
    ${rsSec('Reception',[['',j.reception.venue],['Arrive',j.reception.time,'t']])}
    ${rsSec('Getaway',[['',j.getaway.destination],['Time',j.getaway.time,'t']])}
    ${rsSec('Note',[['',j.note]])}
   </div>
   <div class="row"><button class="btn primary" data-chat="${j.id}">Group chat</button><button class="btn" data-act="copyrs">Copy text</button>${owner?`<button class="btn" data-act="editjob">Edit</button><div class="spacer"></div><button class="btn ${delArm===j.id?'danger':'ghost'}" data-act="deljob">${delArm===j.id?'Tap again to delete':'Delete job'}</button>`:''}</div>
  </div></div>`;
}

/* ---------- New / edit job ---------- */
function pasteSheet(){
  const p=paste;
  const preview=p.parsed?(()=>{const {job,warns}=p.parsed;const all=[...warns,...jobWarnings(job)];
    return `<div class="card"><span class="eyebrow">Check before saving</span>
    <div><b>${esc(job.client||'No client')}</b> · ${job.date?fmtDay(job.date):'<span style="color:var(--no)">no date</span>'}</div>
    ${all.length?`<div class="warns">${all.map(w=>`<div class="warn-row">${esc(w)}</div>`).join('')}</div>`:'<div class="pill ok">Everything matched</div>'}
    ${job.lines.map((l,i)=>`<div class="edit-line"><div class="lbl">${esc(l.carText)}${l.task?' · '+esc(l.task):''}</div>
      <label class="f">Car<select data-lc="${i}"><option value="">Choose car</option>${S.cars.map(c=>`<option value="${c.id}" ${l.carId===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="f">Driver<select data-lw="${i}"><option value="">Choose driver</option>${staff().map(w=>{const v=S.avail[w.id+'|'+job.date];return `<option value="${w.id}" ${l.wid===w.id?'selected':''}>${esc(w.name)}${v==='yes'?' (free)':v==='no'?' (OFF)':''}</option>`}).join('')}</select></label>
      <label class="f hrs">Hrs<input type="number" step="0.5" min="0" data-lh="${i}" value="${l.hours??''}"></label></div>`).join('')}
    <button class="btn primary block" data-act="savejob" ${job.date&&job.lines.length&&!busy?'':'disabled'}>${busy?'Saving…':p.editId?'Save & notify drivers of changes':'Save job & notify drivers'}</button></div>`})():'';
  return `<div class="sheet" id="sheetbg"><div class="panel" role="dialog" aria-modal="true" aria-label="Run sheet">
   <div class="row"><div><span class="eyebrow">${p.editId?'Edit job':'New job'}</span><h2>Paste the run sheet</h2></div><div class="spacer"></div><button class="btn ghost" data-act="close" aria-label="Close">✕</button></div>
   <p class="muted" style="margin:0">Paste it exactly as you'd send it on WhatsApp. The app reads the cars, drivers, hours and times.</p>
   <textarea id="pastein" class="paste" spellcheck="false" aria-label="Run sheet text">${esc(p.text)}</textarea>
   <button class="btn block" data-act="parse">Read run sheet</button>
   ${preview}
  </div></div>`;
}
async function saveJob(){
  const {job}=paste.parsed; busy=true; render();
  try{
    const {groom,bride,ceremony,photos,reception,getaway,note}=job; const data={groom,bride,ceremony,photos,reception,getaway,note};
    let id=paste.editId;
    if(id){const {error}=await sb.from('jobs').update({client:job.client,date:job.date,data,updated_at:new Date().toISOString()}).eq('id',id);if(error)throw error;
      const {error:e2}=await sb.from('job_lines').delete().eq('job_id',id);if(e2)throw e2}
    else {const {data:row,error}=await sb.from('jobs').insert({client:job.client,date:job.date,data,created_by:me.id}).select().single();if(error)throw error;id=row.id}
    const lines=job.lines.map((l,i)=>({job_id:id,sort:i,car_id:l.carId||null,worker_id:l.wid||null,hours:l.hours,task:l.task||'',note:l.note||'',start:l.start||'',car_text:l.carText||'',driver_text:l.driverText||''}));
    if(lines.length){const {error}=await sb.from('job_lines').insert(lines);if(error)throw error}
    // availability: assigned drivers count as free that day unless they said otherwise
    const av=job.lines.filter(l=>l.wid&&!S.avail[l.wid+'|'+job.date]).map(l=>({worker_id:l.wid,day:job.date,status:'yes'}));
    if(av.length) await sb.from('availability').upsert(av);
    // notify each driver with their car, time and pickup
    const told=[],notes=[];job.id=id;
    job.lines.forEach(l=>{if(!l.wid||told.includes(W(l.wid).name))return;const p=pickupFor(job,l);
      notes.push({worker_id:l.wid,job_id:id,text:`${paste.editId?'Job updated':'New job'} · ${fmtDay(job.date)} · ${C(l.carId).name||l.carText}${l.hours?' ('+l.hours+' hrs)':''}. `+(p?`${p[0]} pickup ${p[1].time||'time TBC'} at ${p[1].address||'address TBC'}.`:`Start ${h12(l.start)||'time TBC'}.`)+(l.note?' '+l.note:'')});
      told.push(W(l.wid).name)});
    if(notes.length){const {error}=await sb.from('notifications').insert(notes);if(error)throw error}
    await sb.from('messages').insert({job_id:id,worker_id:me.id,sys:true,text:`${me.name} ${paste.editId?'updated':'created'} the run sheet and notified ${told.join(', ')||'nobody yet'}.`});
    await loadAll(); busy=false; paste=null; viewJob=id; sheet='job'; render();
    toast(told.length?`Saved. Notified ${told.join(', ')}.`:'Saved. No drivers assigned yet.');
  }catch(e){busy=false;render();toast('Could not save: '+(e.message||e))}
}

/* ---------- Car sign-out / return ---------- */
const OUT_CHECKS=['Exterior clean','Interior clean','Ribbons on board','Water & umbrellas on board','No new damage'];
const IN_CHECKS=['No new damage','Interior cleared of rubbish','Keys returned','Fuel receipt uploaded (if refuelled)'];
function lastOdo(carId){let m=0;S.trips.filter(t=>t.carId===carId).forEach(t=>{m=Math.max(m,t.outOdo||0,t.inOdo||0)});return m}
function startDraft(mode,carId){const trip=myOpenTrip();draft={mode,carId:carId||trip?.carId,odo:mode==='in'?'':String(lastOdo(carId)||''),fuel:'',checks:[],notes:'',photos:[]};sheet='trip';render()}
function tripSheet(){
  const d=draft, c=C(d.carId), out=d.mode==='out', checks=out?OUT_CHECKS:IN_CHECKS;
  const ok=d.odo&&d.fuel&&d.photos.length>=2&&!busy;
  return `<div class="sheet" id="sheetbg"><div class="panel" role="dialog" aria-modal="true" aria-label="${out?'Sign car out':'Return car'}">
    <div class="status">${sw(d.carId)}<div><span class="eyebrow">${out?'Signing out':'Returning'}</span><h2>${esc(c.name)}</h2></div><div class="spacer"></div><button class="btn ghost" data-act="close" aria-label="Close">✕</button></div>
    <div class="grid2"><label class="f">Odometer (km)<input id="odo" type="number" inputmode="numeric" value="${esc(d.odo)}"></label>
    <div class="f" style="display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:.88rem">Fuel<div class="fuel">${['1/4','1/2','3/4','Full'].map(f=>`<button type="button" data-fuel="${f}" aria-pressed="${d.fuel===f}">${f}</button>`).join('')}</div></div></div>
    <div class="f" style="display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:.88rem">Photos <span class="muted" style="font-weight:500">At least 2: front and back. Add any marks or damage.</span>
      <div class="photos">${d.photos.map((p,i)=>`<img src="${p.preview}" alt="Photo ${i+1}">`).join('')}<label class="addphoto"><input id="ph" type="file" accept="image/*" capture="environment" multiple>＋<br>Add photo</label></div></div>
    <div class="checks">${checks.map(x=>`<label><input type="checkbox" data-chk="${esc(x)}" ${d.checks.includes(x)?'checked':''}>${esc(x)}</label>`).join('')}</div>
    <label class="f">Notes<textarea id="notes" placeholder="${out?'Anything already wrong with the car?':'Anything Ahmed should know? Damage, warning lights, needs a wash…'}">${esc(d.notes)}</textarea></label>
    <button class="btn primary block" data-act="confirm" ${ok?'':'disabled'}>${busy?'Uploading photos…':out?'Sign out car':'Sign car back in'}</button>
    ${d.odo&&d.fuel&&d.photos.length>=2?'':'<p class="muted" style="margin:0;font-size:.8rem;text-align:center">Add odometer, fuel level and 2 photos to continue.</p>'}
  </div></div>`;
}
async function confirmTrip(){
  const d=draft; busy=true; render();
  try{
    const paths=[];for(const p of d.photos) paths.push(await uploadPhoto(p.blob,'cars'));
    if(d.mode==='out'){
      const job=myShifts().find(s=>s.date===iso(today())&&s.carId===d.carId);
      const {error}=await sb.from('trips').insert({car_id:d.carId,worker_id:me.id,job_id:job?.job.id||null,day:iso(today()),out_odo:+d.odo,out_fuel:d.fuel,out_checks:d.checks,out_notes:d.notes,out_photos:paths});
      if(error) throw error.code==='23505'?new Error('Someone has just signed this car out.'):error;
      toast(C(d.carId).name+' signed out to you');
    } else {
      const t=myOpenTrip(); if(+d.odo<t.outOdo){busy=false;render();toast('Odometer is lower than at sign-out ('+t.outOdo+' km). Check the reading.');return}
      const {error}=await sb.from('trips').update({in_at:new Date().toISOString(),in_odo:+d.odo,in_fuel:d.fuel,in_checks:d.checks,in_notes:d.notes,in_photos:paths}).eq('id',t.id);
      if(error) throw error; toast('Car returned. '+(+d.odo-t.outOdo)+' km driven.');
    }
    d.photos.forEach(p=>URL.revokeObjectURL(p.preview));
    await loadAll(); busy=false; draft=null; sheet=null; render();
  }catch(e){busy=false;render();toast('Could not save: '+(e.message||e))}
}

/* ---------- Owner: Jobs ---------- */
function rosterView(){
  const t=today(); const days=Array.from({length:14},(_,i)=>addDays(t,i)); const people=staff();
  const sh=shifts(); const out=S.trips.filter(x=>!x.inAt);
  const in14=S.jobs.filter(j=>j.date>=iso(t)&&j.date<=iso(days[13]));
  const unmarked=people.filter(w=>w.role!=='owner').reduce((n,w)=>n+days.filter(d=>!S.avail[w.id+'|'+iso(d)]).length,0);
  return `<div class="row"><div><span class="eyebrow">Owner view · next 14 days</span><h2>Jobs &amp; roster</h2></div><div class="spacer"></div><button class="btn primary" data-act="newjob">+ New job</button></div>
  <div class="stats">
    <div class="stat"><span class="eyebrow">Jobs, 14 days</span><b>${in14.length}</b></div>
    <div class="stat"><span class="eyebrow">Car bookings</span><b>${in14.reduce((n,j)=>n+j.lines.length,0)}</b></div>
    <div class="stat"><span class="eyebrow">Cars out now</span><b>${out.length}/${S.cars.length}</b></div>
    <div class="stat"><span class="eyebrow">Unmarked days</span><b style="color:${unmarked?'var(--warn)':'inherit'}">${unmarked}</b></div>
  </div>
  <div class="ownergrid">
  <div class="card"><span class="eyebrow">Upcoming jobs</span><div class="list">${S.jobs.filter(j=>j.date>=iso(t)).sort((a,b)=>a.date.localeCompare(b.date)).map(j=>{const w=jobWarnings(j).length;return `<button class="li" data-job="${j.id}" style="background:none;border-left:0;border-right:0;border-bottom:0;text-align:left;cursor:pointer;width:100%"><div style="min-width:86px"><b>${fmtDay(j.date)}</b><div class="mono muted">${esc(j.groom.time||j.bride.time||'')}</div></div><div class="body"><b>${esc(j.client)}</b><div class="muted" style="font-size:.85rem">${j.lines.map(l=>esc((C(l.carId).name||l.carText)+' – '+(l.wid?W(l.wid).name:(l.driverText||'?')+' (no driver)'))).join('<br>')}</div>${w?`<span class="pill warn" style="margin-top:6px">${w} to check</span>`:''}</div></button>`}).join('')||'<p class="muted">No jobs booked. Tap New job and paste a run sheet.</p>'}</div></div>
  <div class="card"><span class="eyebrow">Who's free</span>
    <div class="scroll"><table class="roster"><thead><tr><th>Driver</th>${days.map(d=>`<th>${DOW[d.getDay()].slice(0,2)}<b>${d.getDate()}</b></th>`).join('')}</tr></thead>
    <tbody>${people.map(w=>`<tr><td>${esc(w.name)}</td>${days.map(d=>{const k=iso(d),v=S.avail[w.id+'|'+k],s=sh.find(s=>s.wid===w.id&&s.date===k);
      return `<td><button class="cell ${s?'sh':v||''}" ${s?`data-job="${s.job.id}"`:`data-cell="${w.id}|${k}"`} aria-label="${esc(w.name)} ${fmtDay(k)}">${s?esc(C(s.carId).code):v==='yes'?'✓':v==='no'?'✕':'·'}</button></td>`}).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="legend"><span><i style="background:var(--ok)"></i>Free</span><span><i style="background:var(--no)"></i>Off</span><span><i style="background:var(--accent)"></i>Booked (car)</span><span>· not marked</span></div>
  </div></div>`;
}

/* ---------- Owner: Cars ---------- */
function fleetView(){
  const t=iso(today());
  return `<div><span class="eyebrow">Fleet</span><h2>Cars</h2></div>
  <div class="cars">${S.cars.map(c=>{const o=openTrip(c.id);const last=S.trips.filter(x=>x.carId===c.id&&x.inAt).slice(-1)[0];
   const next=shifts().filter(s=>s.carId===c.id&&s.date>=t).sort((a,b)=>a.date.localeCompare(b.date))[0];
   return `<div class="card"><div class="status">${sw(c.id)}<div style="flex:1;min-width:0"><b class="big" style="font-size:1.1rem">${esc(c.name)}</b><div class="mono muted">${esc(c.rego||'Rego not set')} · ${lastOdo(c.id)||'–'} km</div></div>${o?'<span class="pill no">Out</span>':'<span class="pill ok">In garage</span>'}</div>
   ${o?`<div class="muted">With <b style="color:var(--fg)">${esc(W(o.wid).name)}</b> since ${fmtTime(o.outAt)} · Fuel at sign-out ${esc(o.outFuel)}</div>`:last?`<div class="muted">Last back ${fmtDay(last.date)} from ${esc(W(last.wid).name)} · Fuel ${esc(last.inFuel)}${last.inNotes?` · “${esc(last.inNotes)}”`:''}</div>`:'<div class="muted">No sign-outs yet.</div>'}
   ${next?`<div class="muted">Next: <b style="color:var(--fg)">${fmtDay(next.date)}</b> · ${esc(next.job.client)} · ${esc(W(next.wid).name)}</div>`:''}
   <form class="row" data-rego="${c.id}"><input type="text" placeholder="Rego" value="${esc(c.rego||'')}" style="flex:1;min-width:0" aria-label="Rego for ${esc(c.name)}"><button class="btn" type="submit">Save rego</button></form>
   </div>`}).join('')}</div>
  <form class="card" id="carform"><span class="eyebrow">Add a car</span><div class="grid2"><label class="f">Name<input id="cname" type="text" required placeholder="e.g. Bentley Mulsanne"></label><label class="f">Rego<input id="crego" type="text"></label></div><button class="btn" type="submit">Add car</button></form>`;
}

/* ---------- Owner: Photos & log ---------- */
function tripRow(t){
  const ph=[...(t.outPhotos||[]),...(t.inPhotos||[])];
  return `<div class="li">${sw(t.carId)}<div class="body">
   <div class="row" style="gap:6px"><b>${esc(C(t.carId).name)}</b><span class="muted">· ${esc(W(t.wid).name)} · ${fmtDay(t.date)}</span>${t.inAt?'':'<span class="pill no">Still out</span>'}</div>
   ${t.jobId&&J(t.jobId)?`<div class="muted" style="font-size:.85rem">${esc(J(t.jobId).client)}</div>`:''}
   <div class="mono muted">${fmtTime(t.outAt)} out · ${t.outOdo} km · ${esc(t.outFuel)}${t.inAt?` → ${fmtTime(t.inAt)} in · ${t.inOdo} km · ${esc(t.inFuel)} · <b style="color:var(--fg)">${t.inOdo-t.outOdo} km</b>`:''}</div>
   ${t.outNotes?`<div style="font-size:.88rem">Out: ${esc(t.outNotes)}</div>`:''}${t.inNotes?`<div style="font-size:.88rem">In: ${esc(t.inNotes)}</div>`:''}
   ${ph.length?`<div class="photos" style="margin-top:6px">${ph.map(p=>`<a href="${esc(purl(p))}" target="_blank" rel="noopener"><img src="${esc(purl(p))}" alt="Car photo" loading="lazy"></a>`).join('')}</div>`:''}</div></div>`;
}
function logView(){
  const ts=S.trips.slice().sort((a,b)=>b.outAt-a.outAt);
  const n=ts.reduce((a,t)=>a+t.outPhotos.length+t.inPhotos.length,0);
  return `<div><span class="eyebrow">Every sign-out and return</span><h2>Photos &amp; log</h2><p class="muted" style="margin:4px 0 0">${ts.length} trip${ts.length===1?"":"s"} · ${n} photo${n===1?"":"s"} in the last 60 days. Tap a photo to open it full size.</p></div>
  <div class="card">${ts.map(tripRow).join('')||'<p class="muted" style="margin:0">Nothing yet. When a driver signs a car out, their photos and odometer show up here.</p>'}</div>`;
}

/* ---------- Owner: Staff ---------- */
function staffView(){
  const pending=S.profiles.filter(p=>p.role==='pending');
  return `<div><span class="eyebrow">Team</span><h2>Staff</h2></div>
  ${pending.length?`<div class="card"><span class="eyebrow">Waiting for approval</span><div class="list">${pending.map(w=>`<div class="li"><div class="avatar">${esc(initials(w.name))}</div><div class="body"><b>${esc(w.name)}</b><div class="muted" style="font-size:.85rem">Signed up ${fmtDay(w.created_at.slice(0,10))}</div></div><button class="btn primary" data-approve="${w.id}">Approve</button><button class="btn ghost" data-remove="${w.id}">Remove</button></div>`).join('')}</div></div>`:''}
  <div class="card"><div class="list">${staff().map(w=>`<div class="li"><div class="avatar">${esc(initials(w.name))}</div><div class="body"><b>${esc(w.name)}</b><div class="muted" style="font-size:.85rem">${w.role==='owner'?'Owner':'Chauffeur'}</div></div>${w.id!==me.id?`<button class="btn ghost" data-remove="${w.id}">${delArm===w.id?'Tap again to remove':'Remove'}</button>`:''}</div>`).join('')}</div></div>
  <div class="card"><span class="eyebrow">Add a chauffeur</span><p class="muted" style="margin:0">Send them this app's link. They tap "Create an account" using the name they go by on run sheets, and then show up above for you to approve.</p>
   <div class="row"><input type="text" readonly value="${esc(location.origin+location.pathname)}" id="applink" style="flex:1;min-width:0"><button class="btn" data-act="copylink">Copy link</button></div></div>`;
}

/* ---------- Inbox & chat ---------- */
function inboxSheet(){
  const ns=S.notes.filter(n=>n.wid===me.id);
  const js=myJobs().filter(j=>j.date>=iso(addDays(today(),-7))).sort((a,b)=>a.date.localeCompare(b.date));
  return `<div class="sheet" id="sheetbg"><div class="panel" role="dialog" aria-modal="true" aria-label="Inbox">
   <div class="row"><h2>Inbox</h2><div class="spacer"></div><button class="btn ghost" data-act="close" aria-label="Close">✕</button></div>
   <span class="eyebrow">Job group chats</span>
   <div class="list">${js.map(j=>{const m=(S.chats[j.id]||[]).filter(x=>!x.sys).slice(-1)[0];const u=chatUnread(j.id);return `<button class="li" data-chat="${j.id}" style="background:none;border-left:0;border-right:0;border-bottom:0;text-align:left;cursor:pointer;width:100%"><div class="avatar">${j.lines.length}</div><div class="body"><b>${esc(j.client)} · ${fmtDay(j.date)}</b><div class="muted" style="font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m?esc(W(m.wid).name.split(' ')[0]+': '+(m.text||'Photo')):members(j).map(id=>esc(W(id).name)).join(', ')}</div></div>${u?`<span class="pill acc">${u}</span>`:''}</button>`}).join('')||'<p class="muted" style="margin:0">No job chats yet.</p>'}</div>
   ${ns.length?`<span class="eyebrow">Notifications</span><div class="list">${ns.map(n=>`<button class="li" data-note="${n.id}" style="background:none;border-left:0;border-right:0;border-bottom:0;text-align:left;cursor:pointer;width:100%"><span class="pill ${n.read?'n':'acc'}">${n.read?'Read':'New'}</span><div class="body" style="font-size:.9rem">${esc(n.text)}</div></button>`).join('')}</div>`:''}
  </div></div>`;
}
function chatSheet(){
  const j=J(chatJob);if(!j)return'';const msgs=S.chats[j.id]||[];
  return `<div class="sheet" id="sheetbg"><div class="panel" role="dialog" aria-modal="true" aria-label="Job chat" style="gap:10px">
   <div class="row"><div style="min-width:0"><span class="eyebrow">Group chat · ${fmtDay(j.date)}</span><h2>${esc(j.client)}</h2></div><div class="spacer"></div><button class="btn ghost" data-act="close" aria-label="Close">✕</button></div>
   <div class="row" style="gap:6px">${members(j).map(id=>`<span class="pill n">${esc(W(id).name)}</span>`).join('')}<button class="btn ghost" data-job="${j.id}" style="min-height:0;padding:3px 8px">Run sheet</button></div>
   <div class="chat" id="chatlog">${msgs.map(m=>m.sys?`<div class="sysmsg">${esc(m.text)}</div>`:`<div class="msg ${m.wid===me.id?'mine':''}"><div class="who-l">${esc(W(m.wid).name)} · ${fmtTime(m.at)}</div>${m.photo?`<a href="${esc(purl(m.photo))}" target="_blank" rel="noopener"><img src="${esc(purl(m.photo))}" alt="Photo from ${esc(W(m.wid).name)}"></a>`:''}${m.text?`<div>${esc(m.text)}</div>`:''}</div>`).join('')||'<div class="sysmsg">No messages yet.</div>'}</div>
   <form id="chatform" class="row" style="flex-wrap:nowrap"><label class="btn" style="padding-inline:12px" aria-label="Add photo">＋<input id="chatph" type="file" accept="image/*" hidden></label><input id="chatin" type="text" placeholder="Message everyone on this job" autocomplete="off" style="flex:1;min-width:0"><button class="btn primary" type="submit">Send</button></form>
  </div></div>`;
}
async function sendChat(text,blob){
  try{
    let photo=null; if(blob){toast('Sending photo…');photo=await uploadPhoto(blob,'chat');await signPhotos([photo])}
    const {data,error}=await sb.from('messages').insert({job_id:chatJob,worker_id:me.id,text:text||'',photo_path:photo}).select().single();
    if(error) throw error; if(!(S.chats[chatJob]||[]).some(m=>m.id===data.id)) addMsg(data);
    markChatRead(chatJob); render();
  }catch(e){toast('Not sent: '+(e.message||e))}
}
async function openChat(id){chatJob=id;sheet='chat';await signPhotos((S.chats[id]||[]).map(m=>m.photo));markChatRead(id);markNotesRead(id);render()}

/* ================= Events ================= */
function bind(){
  $('logout').onclick=logout;
  $('bell').onclick=()=>{sheet='inbox';render()};
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;sheet=null;render();scrollTo(0,0)});
  document.querySelectorAll('[data-job]').forEach(b=>b.onclick=()=>{viewJob=b.dataset.job;delArm=null;sheet='job';markNotesRead(viewJob);render()});
  document.querySelectorAll('[data-chat]').forEach(b=>b.onclick=()=>openChat(b.dataset.chat));
  document.querySelectorAll('[data-note]').forEach(b=>b.onclick=()=>{const n=S.notes.find(x=>x.id===b.dataset.note);markNotesRead(n.jobId);viewJob=n.jobId;sheet=J(n.jobId)?'job':null;render()});
  document.querySelectorAll('[data-day]').forEach(b=>b.onclick=async()=>{const day=b.dataset.day,k=me.id+'|'+day;
    if(myShifts().some(s=>s.date===day))return toast('You\'re booked that day. Message Ahmed to swap.');
    const v=S.avail[k],nv=!v?'yes':v==='yes'?'no':null; if(nv)S.avail[k]=nv; else delete S.avail[k]; render();
    const {error}=nv?await sb.from('availability').upsert({worker_id:me.id,day,status:nv}):await sb.from('availability').delete().match({worker_id:me.id,day});
    if(error){toast('Not saved. Check your connection.');if(v)S.avail[k]=v;else delete S.avail[k];render()}});
  document.querySelectorAll('[data-cell]').forEach(b=>b.onclick=()=>{const [wid,date]=b.dataset.cell.split('|');const v=S.avail[wid+'|'+date];toast(`${W(wid).name}: ${v==='yes'?'free':v==='no'?'off':'hasn\'t marked'} ${fmtDay(date)}`)});
  document.querySelectorAll('[data-approve]').forEach(b=>b.onclick=async()=>{const {error}=await sb.from('profiles').update({role:'driver'}).eq('id',b.dataset.approve);if(error)return toast(error.message);await loadAll();render();toast('Approved')});
  document.querySelectorAll('[data-remove]').forEach(b=>b.onclick=async()=>{const id=b.dataset.remove;if(delArm!==id&&W(id).role!=='pending'){delArm=id;return render()}
    const {error}=await sb.from('profiles').update({role:'pending'}).eq('id',id);if(error)return toast(error.message);delArm=null;await loadAll();render();toast('Access removed')});
  document.querySelectorAll('[data-rego]').forEach(f=>f.onsubmit=async e=>{e.preventDefault();const v=f.querySelector('input').value.trim().toUpperCase();const {error}=await sb.from('cars').update({rego:v}).eq('id',f.dataset.rego);if(error)return toast(error.message);await loadAll();render();toast('Rego saved')});
  document.querySelectorAll('[data-act]').forEach(b=>b.onclick=async()=>{const a=b.dataset.act;
    if(a==='pickcar')startDraft('out',b.dataset.car);
    if(a==='signin')startDraft('in');
    if(a==='close'){if(draft)draft.photos.forEach(p=>URL.revokeObjectURL(p.preview));sheet=null;draft=null;paste=null;render()}
    if(a==='confirm')confirmTrip();
    if(a==='newjob'){paste={text:TEMPLATE,parsed:null};sheet='paste';render()}
    if(a==='editjob'){const j=J(viewJob);paste={text:runSheetText(j),editId:j.id,parsed:null};sheet='paste';render()}
    if(a==='parse'){paste.text=$('pastein').value;paste.parsed=parseRunSheet(paste.text);if(paste.editId)paste.parsed.job.id=paste.editId;render();setTimeout(()=>document.querySelector('[data-act="savejob"]')?.scrollIntoView({block:'nearest'}),0)}
    if(a==='savejob')saveJob();
    if(a==='deljob'){if(delArm===viewJob){const {error}=await sb.from('jobs').delete().eq('id',viewJob);if(error)return toast(error.message);sheet=null;delArm=null;await loadAll();render();toast('Job deleted')}else{delArm=viewJob;render()}}
    if(a==='copyrs'){try{await navigator.clipboard.writeText(runSheetText(J(viewJob)));toast('Copied. Paste it into WhatsApp.')}catch(e){toast('Copy blocked. Open Edit and copy the text.')}}
    if(a==='copylink'){try{await navigator.clipboard.writeText($('applink').value);toast('Link copied')}catch(e){$('applink').select()}}
    if(a==='allfree'){const rows=[];for(let i=0;i<14;i++){const day=iso(addDays(today(),i)),k=me.id+'|'+day;if(!S.avail[k]){S.avail[k]='yes';rows.push({worker_id:me.id,day,status:'yes'})}}
      render();if(rows.length){const {error}=await sb.from('availability').upsert(rows);toast(error?'Not saved. Check your connection.':'Marked as Free')}}
  });
  if(sheet==='paste'&&paste.parsed){
    const L=paste.parsed.job.lines;
    const keep=()=>{paste.text=$('pastein').value};
    document.querySelectorAll('[data-lc]').forEach(s=>s.onchange=()=>{L[+s.dataset.lc].carId=s.value;keep();refreshWarn()});
    document.querySelectorAll('[data-lw]').forEach(s=>s.onchange=()=>{L[+s.dataset.lw].wid=s.value;keep();refreshWarn()});
    document.querySelectorAll('[data-lh]').forEach(s=>s.oninput=()=>{L[+s.dataset.lh].hours=s.value?+s.value:null});
  }
  if(sheet==='trip'){
    $('odo').oninput=e=>{draft.odo=e.target.value;const btn=document.querySelector('[data-act="confirm"]');if(btn)btn.disabled=!(draft.odo&&draft.fuel&&draft.photos.length>=2)};
    $('notes').oninput=e=>draft.notes=e.target.value;
    document.querySelectorAll('[data-fuel]').forEach(b=>b.onclick=()=>{draft.fuel=b.dataset.fuel;render()});
    document.querySelectorAll('[data-chk]').forEach(c=>c.onchange=()=>{const x=c.dataset.chk;draft.checks=c.checked?[...draft.checks,x]:draft.checks.filter(y=>y!==x)});
    $('ph').onchange=async e=>{for(const f of e.target.files){const blob=await shrink(f);if(blob)draft.photos.push({blob,preview:URL.createObjectURL(blob)})}render()};
  }
  if(sheet==='chat'){const log=$('chatlog');if(log)log.scrollTop=log.scrollHeight;
    $('chatform').onsubmit=e=>{e.preventDefault();const v=$('chatin').value.trim();if(!v)return;$('chatin').value='';sendChat(v)};
    $('chatph').onchange=async e=>{const f=e.target.files[0];if(f){const blob=await shrink(f);if(blob)sendChat('',blob)}}}
  const cf=$('carform');if(cf)cf.onsubmit=async e=>{e.preventDefault();const n=$('cname').value.trim();
    const {error}=await sb.from('cars').insert({name:n,code:initials(n),rego:$('crego').value.trim().toUpperCase(),sort:S.cars.length+1});if(error)return toast(error.message);await loadAll();render();toast('Car added')};
}
function refreshWarn(){const p=paste.parsed;p.warns=p.warns.filter(w=>{const m=w.match(/"(.+)"/);if(!m)return true;return p.job.lines.some(l=>(/car/.test(w)?!l.carId&&l.carText===m[1]:!l.wid&&l.driverText===m[1]))});render()}

/* ================= Start ================= */
async function start(){
  if(!configured){render();return}
  const {data}=await sb.auth.getSession(); session=data.session;
  sb.auth.onAuthStateChange(async (ev,s)=>{
    if(ev==='PASSWORD_RECOVERY'){const np=await askNewPassword();if(np){const {error}=await sb.auth.updateUser({password:np});toast(error?error.message:'Password updated')}}
    const changed=(s?.user?.id)!==(session?.user?.id); session=s;
    if(!s){me=null;render();return}
    if(changed){try{await loadAll();subscribe()}catch(e){toast('Could not load: '+(e.message||e))}render()}
  });
  render();
  if(session){try{await loadAll();subscribe()}catch(e){toast('Could not load: '+(e.message||e))}render()}
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&session&&me)scheduleReload()});
}
function askNewPassword(){return new Promise(res=>{const el=document.createElement('div');el.className='sheet';
  el.innerHTML=`<form class="panel"><h2>Choose a new password</h2><label class="f">New password<input type="password" minlength="8" required id="np"></label><button class="btn primary block">Save password</button></form>`;
  document.body.appendChild(el);el.querySelector('form').onsubmit=e=>{e.preventDefault();const v=el.querySelector('#np').value;el.remove();res(v)}})}
start();
