// The page `pitroom dash` serves: one static document that polls /api/state. Every value from a
// run record is written with textContent, never as HTML. No external files, fonts or scripts.
export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pitroom</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23ff6a2b'/%3E%3Cpath d='M9 8h4v4H9zm8 0h4v4h-4zm-4 4h4v4h-4zm8 0h4v4h-4zM9 16h4v4H9zm8 0h4v4h-4zm-4 4h4v4h-4zm8 0h4v4h-4z' fill='%23fff'/%3E%3C/svg%3E">
<style>
:root{color-scheme:dark;--bg:#07090f;--glow1:rgba(255,106,43,.14);--glow2:rgba(56,189,248,.12);--card:rgba(255,255,255,.035);--card2:rgba(255,255,255,.06);--line:rgba(255,255,255,.09);--tx:#f3f5fb;--sub:#8e98b8;--dim:#5d6684;--ok:#34d399;--run:#38bdf8;--bad:#fb7185;--warn:#fbbf24;--acc:#ff6a2b;--shadow:0 1px 0 rgba(255,255,255,.04) inset,0 10px 30px -12px rgba(0,0,0,.6);--ease:cubic-bezier(.22,1,.36,1)}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f5f6fa;--glow1:rgba(255,106,43,.12);--glow2:rgba(2,132,199,.10);--card:rgba(255,255,255,.75);--card2:rgba(255,255,255,.95);--line:rgba(20,26,50,.10);--tx:#12172b;--sub:#5a6381;--dim:#8a93ad;--ok:#059669;--run:#0284c7;--bad:#e11d48;--warn:#b45309;--acc:#ea580c;--shadow:0 1px 0 rgba(255,255,255,.8) inset,0 10px 30px -14px rgba(20,26,50,.25)}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;min-height:100vh;color:var(--tx);font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;background:radial-gradient(60rem 30rem at 85% -10%,var(--glow1),transparent 60%),radial-gradient(50rem 28rem at -10% 0%,var(--glow2),transparent 60%),var(--bg);background-attachment:fixed}
body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:44px 44px;opacity:.35;-webkit-mask-image:radial-gradient(ellipse at 50% 0%,#000 0%,transparent 70%);mask-image:radial-gradient(ellipse at 50% 0%,#000 0%,transparent 70%)}
main{position:relative;max-width:860px;margin:0 auto;padding:36px 18px 64px}
header{display:flex;align-items:center;gap:14px;margin-bottom:26px;animation:rise .7s var(--ease) both}
.mark{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--acc),#ff9a5c);display:grid;place-items:center;box-shadow:0 8px 24px -8px var(--acc)}
.mark svg{width:22px;height:22px;fill:#fff}
h1{font-size:21px;letter-spacing:-.02em;margin:0;font-weight:650}
.sub{color:var(--sub);font-size:13px;margin-top:1px}
.grow{flex:1}
.live{display:flex;align-items:center;gap:7px;color:var(--dim);font-size:12px}
.live i{width:7px;height:7px;border-radius:50%;background:var(--ok);opacity:.35}
.live.tick i{animation:blink .9s var(--ease)}
.live.off i{background:var(--bad);opacity:1}
@keyframes blink{0%{opacity:1;box-shadow:0 0 0 0 var(--ok)}100%{opacity:.35;box-shadow:0 0 0 8px transparent}}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:22px}
.stat{position:relative;overflow:hidden;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);animation:rise .7s var(--ease) both}
.stat:nth-child(2){animation-delay:.07s}.stat:nth-child(3){animation-delay:.14s}
.stat .k{color:var(--sub);font-size:12px;letter-spacing:.04em;text-transform:uppercase}
.stat .v{font-size:30px;font-weight:650;letter-spacing:-.03em;margin-top:4px;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:10px}
.stat.go:before{content:"";position:absolute;inset:-1px;border-radius:inherit;padding:1px;background:conic-gradient(from var(--a,0deg),transparent 0 70%,var(--run) 85%,transparent);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:spin 3.2s linear infinite}
@property --a{syntax:"<angle>";inherits:false;initial-value:0deg}
@keyframes spin{to{--a:360deg}}
.pulse{width:10px;height:10px;border-radius:50%;background:var(--dim)}
.go .pulse{background:var(--run);animation:ping 1.6s infinite}
@keyframes ping{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--run) 60%,transparent)}100%{box-shadow:0 0 0 12px transparent}}
.bar{display:flex;align-items:center;gap:10px;margin:0 0 16px;animation:rise .7s var(--ease) .15s both}
.seg{position:relative;display:inline-flex;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:3px}
.seg button{position:relative;z-index:1;font:inherit;font-size:13px;color:var(--sub);background:none;border:0;padding:6px 14px;border-radius:9px;cursor:pointer;transition:color .25s}
.seg button.on{color:var(--tx)}
.seg .thumb{position:absolute;top:3px;bottom:3px;left:0;border-radius:9px;background:var(--card2);box-shadow:var(--shadow);transition:transform .35s var(--ease),width .35s var(--ease)}
select{font:inherit;font-size:13px;color:var(--sub);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:7px 12px;cursor:pointer;transition:border-color .2s}
select:hover{border-color:var(--sub)}
.card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:16px;margin-bottom:10px;box-shadow:var(--shadow);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);cursor:pointer;transition:transform .35s var(--ease),border-color .25s,background .25s}
.card:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--tx) 22%,transparent);background:var(--card2)}
.card.enter{animation:enter .6s var(--ease) both;animation-delay:var(--d,0s)}
.card.leave{animation:leave .35s ease both}
.card.pop{animation:pop .9s var(--ease)}
@keyframes enter{from{opacity:0;transform:translateY(14px) scale(.985);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
@keyframes leave{to{opacity:0;transform:scale(.97)}}
@keyframes pop{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 55%,transparent)}100%{box-shadow:0 0 0 14px transparent}}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.row{display:grid;grid-template-columns:34px 1fr auto;gap:14px;padding:15px 16px;align-items:start}
.ico{width:30px;height:30px;margin-top:1px}
.ico svg{width:100%;height:100%;overflow:visible}
.ico .ring{fill:none;stroke:var(--dim);stroke-width:1.8}
.ico .tick,.ico .cross,.ico .hand{fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:24;stroke-dashoffset:24;animation:draw .55s .15s var(--ease) forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.s-done .ring,.s-done .tick{stroke:var(--ok)}
.s-failed .ring,.s-timeout .ring,.s-stopped .ring,.s-failed .cross,.s-timeout .hand,.s-stopped .cross{stroke:var(--bad)}
.s-running .ring{stroke:color-mix(in srgb,var(--run) 25%,transparent)}
.s-running .arc{fill:none;stroke:var(--run);stroke-width:2.4;stroke-linecap:round;stroke-dasharray:22 60;transform-origin:12px 12px;animation:rot 1s linear infinite}
.s-queued .ring{stroke:var(--warn);stroke-dasharray:3 3;transform-origin:12px 12px;animation:rot 6s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;border-radius:999px;padding:2px 10px 2px 8px;background:color-mix(in srgb,var(--c) 14%,transparent);color:var(--c);border:1px solid color-mix(in srgb,var(--c) 28%,transparent)}
.pill:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--c)}
.pill em{font-style:normal;font-weight:500;color:var(--sub)}
.kind{color:var(--sub);font-size:13px}
.badge{font-size:12px;border-radius:999px;padding:1px 9px;border:1px solid var(--line);color:var(--sub)}
.badge.good{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:color-mix(in srgb,var(--ok) 10%,transparent)}
.badge.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent);background:color-mix(in srgb,var(--bad) 10%,transparent)}
.task{margin-top:5px;overflow-wrap:anywhere}
.note{margin-top:4px;color:var(--sub);font-size:13px;overflow-wrap:anywhere;animation:fade .4s ease}
@keyframes fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.shim{display:none;height:3px;border-radius:3px;margin-top:10px;overflow:hidden;background:color-mix(in srgb,var(--run) 14%,transparent)}
.s-running .shim{display:block}
.shim:after{content:"";display:block;height:100%;width:38%;border-radius:3px;background:linear-gradient(90deg,transparent,var(--run),transparent);animation:slide 1.5s var(--ease) infinite}
@keyframes slide{from{transform:translateX(-110%)}to{transform:translateX(280%)}}
.side{text-align:right;font-variant-numeric:tabular-nums}
.time{font-size:14px;font-weight:600}
.s-running .time{color:var(--run)}
.fine{color:var(--dim);font-size:12px;margin-top:2px}
.fine b{color:var(--ok);font-weight:500}
.more{display:grid;grid-template-rows:0fr;transition:grid-template-rows .45s var(--ease)}
.open .more{grid-template-rows:1fr}
.more>div{overflow:hidden}
.more .in{padding:0 16px 16px 64px;opacity:0;transform:translateY(-4px);transition:opacity .35s ease .05s,transform .45s var(--ease)}
.open .more .in{opacity:1;transform:none}
pre{margin:0;padding:12px 14px;border-radius:12px;background:rgba(0,0,0,.28);border:1px solid var(--line);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:380px;overflow:auto;cursor:text;color:var(--tx)}
@media (prefers-color-scheme:light){pre{background:rgba(20,26,50,.05)}}
.copy{margin-top:10px;font:inherit;font-size:12px;color:var(--sub);background:none;border:1px solid var(--line);border-radius:8px;padding:3px 10px;cursor:pointer;transition:color .2s,border-color .2s}
.copy:hover{color:var(--tx);border-color:var(--sub)}
.empty{text-align:center;padding:56px 0;color:var(--sub);animation:rise .7s var(--ease) both}
.empty .flag{font-size:42px;display:inline-block;animation:wave 2.4s ease-in-out infinite;transform-origin:20% 90%}
@keyframes wave{50%{transform:rotate(-8deg) translateY(-3px)}}
.empty code{display:inline-block;margin-top:12px;padding:6px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);font:13px ui-monospace,Menlo,monospace;color:var(--tx)}
footer{margin-top:28px;text-align:center;color:var(--dim);font-size:12px}
@media (max-width:560px){.row{grid-template-columns:30px 1fr}.side{grid-column:2;text-align:left;display:flex;gap:10px;align-items:baseline}.more .in{padding-left:16px}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}.ico .tick,.ico .cross,.ico .hand{stroke-dashoffset:0}}
</style></head><body><main>
<header><div class="mark"><svg viewBox="0 0 24 24"><path d="M4 4h4v4H4zm8 0h4v4h-4zM8 8h4v4H8zm8 0h4v4h-4zM4 12h4v4H4zm8 0h4v4h-4zm-4 4h4v4H8zm8 0h4v4h-4z"/></svg></div><div><h1>Pitroom</h1><div class="sub">Your agent's pit crew, live</div></div><div class="grow"></div><div class="live" id="live"><i></i><span id="livet">live</span></div></header>
<section class="stats">
 <div class="stat" id="s1"><div class="k">Running now</div><div class="v"><span class="pulse"></span><span id="nrun">0</span></div></div>
 <div class="stat"><div class="k">Finished</div><div class="v"><span id="nfin">0</span></div></div>
 <div class="stat"><div class="k">Saved this week</div><div class="v"><span id="nsave">$0.00</span></div></div>
</section>
<div class="bar"><div class="seg" id="seg"><span class="thumb" id="thumb"></span><button data-f="all" class="on">All</button><button data-f="running">Running</button><button data-f="problem">Needs attention</button></div><select id="grp" hidden><option value="">All groups</option></select></div>
<div id="list"></div>
<footer>Read-only · this machine only · updates every 2 seconds</footer>
</main>
<script>
var NS='http://www.w3.org/2000/svg',filter='all',group='',els={},cur={run:0,fin:0,save:0};
function $(i){return document.getElementById(i)}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function sv(t,a){var e=document.createElementNS(NS,t);for(var k in a)e.setAttribute(k,a[k]);return e}
function clock(s){s=Math.max(0,Math.round(s));return s>=3600?Math.floor(s/3600)+'h '+('0'+Math.floor(s%3600/60)).slice(-2)+'m':s>=60?Math.floor(s/60)+'m '+('0'+s%60).slice(-2)+'s':s+'s'}
function tok(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?Math.round(n/1e3)+'k':String(n)}
function tween(node,key,to,fmt){var from=cur[key],t0=performance.now();cur[key]=to;if(from===to){node.textContent=fmt(to);return}
 (function f(t){var p=Math.min(1,(t-t0)/450),e=1-Math.pow(1-p,3);node.textContent=fmt(from+(to-from)*e);if(p<1)requestAnimationFrame(f)})(t0)}
function icon(state){var s=sv('svg',{viewBox:'0 0 24 24'});s.appendChild(sv('circle',{cx:12,cy:12,r:10,'class':'ring'}));
 if(state==='done')s.appendChild(sv('path',{d:'M7.5 12.5l3 3 6-6.5','class':'tick'}));
 else if(state==='running')s.appendChild(sv('circle',{cx:12,cy:12,r:10,'class':'arc'}));
 else if(state==='failed'||state==='stopped')s.appendChild(sv('path',{d:'M8.5 8.5l7 7M15.5 8.5l-7 7','class':'cross'}));
 else if(state==='timeout')s.appendChild(sv('path',{d:'M12 7v5l3 2','class':'hand'}));
 return s}
function color(w){return /^opencode/.test(w)?'#38bdf8':/^codex/.test(w)?'#34d399':/^claude/.test(w)?'#ff8a4c':'#a78bfa'}
function visible(r){return filter==='all'||(filter==='running'&&(r.state==='running'||r.state==='queued'))||(filter==='problem'&&(r.state==='failed'||r.state==='timeout'||r.state==='stopped'))}
function report(o){fetch('/api/run/'+o.r.id).then(function(x){return x.json()}).then(function(j){o.pre.textContent=j.report})}
function build(r){var o={r:r},c=el('article','card enter');o.root=c;
 var row=el('div','row'),mid=el('div'),head=el('div','head'),side=el('div','side');
 o.ic=el('div','ico');o.pill=el('span','pill');o.kind=el('span','kind');o.badges=el('span','head');head.appendChild(o.pill);head.appendChild(o.kind);head.appendChild(o.badges);
 o.task=el('div','task');o.note=el('div','note');o.shim=el('div','shim');mid.appendChild(head);mid.appendChild(o.task);mid.appendChild(o.note);mid.appendChild(o.shim);
 o.time=el('div','time');o.fine=el('div','fine');side.appendChild(o.time);side.appendChild(o.fine);
 row.appendChild(o.ic);row.appendChild(mid);row.appendChild(side);c.appendChild(row);
 var more=el('div','more'),box=el('div'),inn=el('div','in'),cp=el('button','copy','Copy run id');o.pre=el('pre');
 cp.onclick=function(e){e.stopPropagation();if(navigator.clipboard)navigator.clipboard.writeText(o.r.id);cp.textContent='Copied '+o.r.id;setTimeout(function(){cp.textContent='Copy run id'},1400)};
 inn.appendChild(o.pre);inn.appendChild(cp);box.appendChild(inn);more.appendChild(box);c.appendChild(more);
 c.onanimationend=function(){c.classList.remove('enter','pop')};
 c.onclick=function(){if(window.getSelection&&String(window.getSelection()))return;if(c.classList.toggle('open'))report(o)};
 return o}
function paint(o,r,fresh){var prev=o.r.state,c=o.root;o.r=r;
 if(fresh||prev!==r.state){c.className=c.className.replace(/ s-\\w+/g,'')+' s-'+r.state;o.ic.textContent='';o.ic.appendChild(icon(r.state));if(!fresh){c.classList.add('pop');if(c.classList.contains('open'))report(o)}}
 var m=/^(\\S+)(?: \\((.*)\\))?$/.exec(r.worker)||[0,r.worker,''];o.pill.style.setProperty('--c',color(r.worker));o.pill.textContent=m[1];if(m[2])o.pill.appendChild(el('em',null,m[2]));
 o.kind.textContent=r.kind;o.badges.textContent='';
 if(r.verdict){var good=/PASS/.test(r.verdict)&&/APPROVED/.test(r.verdict);o.badges.appendChild(el('span','badge '+(good?'good':'bad'),good?'Approved':/FAIL/.test(r.verdict)?'Spec fail':'Needs fixes'))}
 if(r.changes)o.badges.appendChild(el('span','badge',r.changes+(r.changes===1?' file':' files')));
 if(r.applied)o.badges.appendChild(el('span','badge good','Applied'));
 o.task.textContent=r.task;
 var note=r.verdict?r.note.replace(/^SPEC: \\w+ · QUALITY: \\w+ · /,'').replace(/^ISSUES: /,'issues: '):r.note;
 if(o.note.textContent!==note){o.note.textContent=note;o.note.style.display=note?'':'none'}
 if(r.state==='running'||r.state==='queued'){o.time.dataset.start=Date.parse(r.startedAt);o.time.textContent=clock((Date.now()-Date.parse(r.startedAt))/1000)}else{delete o.time.dataset.start;o.time.textContent=r.time}
 var f=[];if(r.steps)f.push(r.steps+(r.steps===1?' step':' steps'));if(r.tokens)f.push(tok(r.tokens)+' tokens');o.fine.textContent=f.join(' · ');
 if(r.saved)o.fine.appendChild(el('b',null,'  ~$'+r.saved.toFixed(2)))}
function thumb(){var b=document.querySelector('#seg button.on');if(!b)return;var t=$('thumb');t.style.width=b.offsetWidth+'px';t.style.transform='translateX('+b.offsetLeft+'px)'}
function render(d){
 tween($('nrun'),'run',d.running,function(v){return String(Math.round(v))});
 tween($('nfin'),'fin',d.runs.filter(function(r){return r.state==='done'}).length,function(v){return String(Math.round(v))});
 tween($('nsave'),'save',d.saved,function(v){return '$'+v.toFixed(2)});
 $('s1').className='stat'+(d.running?' go':'');document.title=(d.running?'('+d.running+') ':'')+'Pitroom';
 var g=$('grp');g.hidden=!d.groups.length;if(g.options.length!==d.groups.length+1){var cv=g.value;while(g.options.length>1)g.remove(1);d.groups.forEach(function(n){var o=el('option',null,n);o.value=n;g.appendChild(o)});g.value=cv}
 var list=$('list'),shown=d.runs.filter(visible),keep={},i=0,emp=list.querySelector('.empty');if(emp&&shown.length)emp.remove();
 shown.forEach(function(r){keep[r.id]=1;var o=els[r.id],fresh=!o;if(fresh){o=els[r.id]=build(r);o.root.style.setProperty('--d',Math.min(i,8)*.045+'s')}paint(o,r,fresh);
  var at=list.children[i];if(o.root!==at)list.insertBefore(o.root,at||null);i++});
 Object.keys(els).forEach(function(id){if(!keep[id]){var o=els[id];delete els[id];o.root.classList.add('leave');setTimeout(function(){o.root.remove()},330)}});
 if(!shown.length&&!list.querySelector('.empty')){var e=el('div','empty');e.appendChild(el('div','flag','🏁'));e.appendChild(el('div',null,d.runs.length?'Nothing matches this filter.':'All quiet. Workers appear here the moment they start.'));if(!d.runs.length)e.appendChild(el('code',null,'pitroom run "your task"'));list.appendChild(e)}}
function load(){if(document.hidden)return;fetch('/api/state'+(group?'?group='+encodeURIComponent(group):'')).then(function(r){return r.json()}).then(function(d){var l=$('live');l.className='live';void l.offsetWidth;l.className='live tick';$('livet').textContent='live';render(d)}).catch(function(){$('live').className='live off';$('livet').textContent='offline'})}
Array.prototype.forEach.call(document.querySelectorAll('#seg button'),function(b){b.onclick=function(){filter=b.dataset.f;Array.prototype.forEach.call(document.querySelectorAll('#seg button'),function(x){x.className=x===b?'on':''});thumb();load()}});
$('grp').onchange=function(e){group=e.target.value;load()};
window.addEventListener('resize',thumb);thumb();
setInterval(function(){Array.prototype.forEach.call(document.querySelectorAll('.time[data-start]'),function(t){t.textContent=clock((Date.now()-Number(t.dataset.start))/1000)})},1000);
setInterval(load,2000);load();
</script></body></html>`;
