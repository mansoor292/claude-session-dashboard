const http = require('http');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { URL } = require('url');
const path = require('path');
const PORT = 5000;
const HOMEDIR = process.env.HOME || '/home/ubuntu';
// Base wildcard domain the box is served on, e.g. dev.example.com.
// Set DEV_DOMAIN (and optionally the *_URL overrides) to your own.
const DOMAIN = process.env.DEV_DOMAIN || 'dev.example.com';
const TERM = process.env.TERM_URL || ('https://term.' + DOMAIN);   // ttyd web terminal
const CODE = process.env.CODE_URL || ('https://code.' + DOMAIN);   // code-server
const HOST = os.hostname();
const CODE_ROOT = process.env.CODE_ROOT || (HOMEDIR + '/Code');    // where your repos live
const DIR = process.env.REPO_DIR || CODE_ROOT;                     // default cwd for a blank session
const CLAUDE_BIN = process.env.CLAUDE_BIN || (HOMEDIR + '/.local/bin/claude');
function repos(){
  const out=[]; const add=q=>out.push({name:q.slice(CODE_ROOT.length+1),path:q});
  let top; try{top=fs.readdirSync(CODE_ROOT,{withFileTypes:true});}catch{return[];}
  for(const e of top){
    if(!e.isDirectory()||e.name.startsWith('.')||e.name==='node_modules')continue;
    const q=CODE_ROOT+'/'+e.name; add(q);
    if(!fs.existsSync(q+'/.git')){
      let sub; try{sub=fs.readdirSync(q,{withFileTypes:true});}catch{sub=[];}
      for(const c of sub) if(c.isDirectory()&&!c.name.startsWith('.')&&c.name!=='node_modules'&&fs.existsSync(q+'/'+c.name+'/.git')) add(q+'/'+c.name);
    }
  }
  return out.sort((a,b)=>a.name.localeCompare(b.name));
}
const SESS_DIR = HOMEDIR + '/.claude/sessions';
const NCPU = os.cpus().length;

const tmux = (a) => { try { return execFileSync('tmux', a, {encoding:'utf8'}); } catch { return ''; } };
const git = (a) => { try { return {code:0, out: execFileSync('git', a, {encoding:'utf8'})}; } catch(e){ return {code: e.status||1, out: ((e.stdout||'')+(e.stderr||''))}; } };
function removeWorktree(w){
  if(!w || w.indexOf(CODE_ROOT+'/.worktrees/')!==0 || w.indexOf('..')>=0) return {ok:false,err:'not a managed worktree'};
  const g=git(['-C',w,'rev-parse','--git-common-dir']);
  if(g.code!==0) return {ok:false,err:'not a git worktree'};
  let common=g.out.trim(); if(common && common[0]!=='/') common=path.resolve(w,common);
  const mainrepo=path.dirname(common);
  const brr=git(['-C',w,'rev-parse','--abbrev-ref','HEAD']); const br=(brr.code===0)?brr.out.trim():'';
  const r=git(['-C',mainrepo,'worktree','remove','--force',w]);
  if(r.code!==0) return {ok:false,err:('remove failed: '+r.out).slice(0,200)};
  if(br && br!=='HEAD') git(['-C',mainrepo,'branch','-D',br]);
  return {ok:true,branch:br};
}
const clean = (s) => (s||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,40);
const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ---- CPU sampler (1s) ----
let cpuPct = 0, last = null;
function sampleCpu(){
  try{
    const l = fs.readFileSync('/proc/stat','utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = l[3]+ (l[4]||0); const total = l.reduce((a,b)=>a+b,0);
    if(last){ const dt=total-last.total, di=idle-last.idle; if(dt>0) cpuPct = Math.max(0,Math.min(100,(1-di/dt)*100)); }
    last = {idle,total};
  }catch{}
}
setInterval(sampleCpu, 1000); sampleCpu();

function stats(){
  const mi = {}; try{ fs.readFileSync('/proc/meminfo','utf8').split('\n').forEach(l=>{const m=l.match(/^(\w+):\s+(\d+)/); if(m) mi[m[1]]=+m[2]*1024;}); }catch{}
  const memTotal=mi.MemTotal||0, memAvail=mi.MemAvailable||0, memUsed=memTotal-memAvail;
  const swapTotal=mi.SwapTotal||0, swapUsed=swapTotal-(mi.SwapFree||0);
  let load=[0,0,0], up=0;
  try{ load = fs.readFileSync('/proc/loadavg','utf8').trim().split(/\s+/).slice(0,3).map(Number);}catch{}
  try{ up = +fs.readFileSync('/proc/uptime','utf8').split(' ')[0]; }catch{}
  let procs=[];
  try{
    const out = execFileSync('ps',['-eo','pid,%cpu,%mem,rss,comm','--sort=-%cpu'],{encoding:'utf8'}).trim().split('\n').slice(1,16);
    procs = out.map(l=>{const p=l.trim().split(/\s+/); return {pid:p[0],cpu:+p[1],mem:+p[2],rss:+p[3]*1024,comm:p.slice(4).join(' ')};});
  }catch{}
  return {cpu:cpuPct, ncpu:NCPU, memTotal, memUsed, memAvail, swapTotal, swapUsed, load, up, procs};
}

function sessions(){
  const out = tmux(['list-sessions','-F','#{session_name}\t#{session_windows}\t#{session_attached}']).trim();
  const tsess = !out ? [] : out.split('\n').map(l=>{
    const [name,wins,att]=l.split('\t');
    const info=tmux(['display-message','-p','-t',name,'#{pane_current_command}\t#{pane_title}\t#{pane_current_path}']).trim();
    const [cmd='',rawTitle='',cwd='']=info.split('\t');
    const title=(rawTitle&&rawTitle!==HOST)?rawTitle:'';
    const cap=tmux(['capture-pane','-p','-t',name,'-S','-14']).replace(/\s+$/,'');
    const lines=cap.split('\n').map(s=>s.replace(/\s+$/,'')).filter(s=>s.length);
    return {name,wins:+wins,attached:att==='1',cmd,title,cwd,preview:lines.slice(-3).join('\n'),running:/^(claude|node|python|vim|nano|ssh|git)/.test(cmd)};
  });
  const tnames = new Set(tsess.map(x=>x.name));
  const rc = [];
  try {
    for (const f of fs.readdirSync(SESS_DIR)) {
      if (!f.endsWith('.json')) continue;
      let d; try { d = JSON.parse(fs.readFileSync(SESS_DIR+'/'+f,'utf8')); } catch { continue; }
      if (!d.pid || !fs.existsSync('/proc/'+d.pid)) continue;   // process alive?
      if (!d.bridgeSessionId) continue;                          // remote-control only
      const tname = (d.tmux||'').split(':')[0];
      if (tname && tnames.has(tname)) continue;                  // already shown via tmux
      const nm = tname || d.name || ('rc-'+d.pid);
      if (tnames.has(nm)) continue;
      tnames.add(nm);
      rc.push({name:nm, rc:true, bridge:d.bridgeSessionId, cwd:d.cwd||'',
        title:(d.nameSource && d.nameSource!=='derived')?(d.name||''):'',
        cmd:'remote-control host', status:d.status||'', wins:1, attached:false, running:true, preview:''});
    }
  } catch {}
  return tsess.concat(rc).sort((a,b)=>a.name.localeCompare(b.name));
}
const gb = b => (b/1073741824);
const fmtGB = b => gb(b).toFixed(1)+'G';
const fmtUp = s => { const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60); return (d?d+'d ':'')+(h?h+'h ':'')+m+'m'; };

const CSS=`*{box-sizing:border-box;margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(135deg,#0f172a,#1e293b 60%,#334155);color:#e2e8f0;min-height:100vh;padding:36px 22px}.wrap{max-width:1180px;margin:0 auto}header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}h1{font-size:25px;letter-spacing:-.02em}.sub{color:#94a3b8;font-size:13.5px}.nav{display:flex;gap:8px}.nav a,.add{text-decoration:none;background:rgba(148,163,184,.15);color:#e2e8f0;font-weight:600;border:0;padding:9px 16px;border-radius:10px;cursor:pointer;font-size:13.5px}.nav a.on{background:#38bdf8;color:#0f172a}.add{background:#22c55e;color:#052e16}
 .reposel{background:rgba(15,23,42,.55);color:#e2e8f0;border:1px solid rgba(148,163,184,.32);border-radius:10px;padding:8px 10px;font-size:12.5px;max-width:190px;font-family:ui-monospace,Menlo,monospace}
 .modesel{background:rgba(15,23,42,.55);color:#e2e8f0;border:1px solid rgba(148,163,184,.32);border-radius:10px;padding:8px 10px;font-size:12.5px}
 .wtlbl{display:inline-flex;align-items:center;gap:5px;color:#94a3b8;font-size:12.5px;cursor:pointer;user-select:none}
 .wtlbl input{accent-color:#22c55e;cursor:pointer}
 .modal{position:fixed;inset:0;background:rgba(2,6,23,.62);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:50}
 .modal[hidden]{display:none}
 .sheet{background:#0f172a;border:1px solid rgba(148,163,184,.25);border-radius:16px;padding:22px;width:min(430px,92vw);box-shadow:0 24px 70px rgba(0,0,0,.55);display:flex;flex-direction:column;gap:13px}
 .sheettitle{font-size:16px;font-weight:700;color:#e2e8f0}
 .fld{display:flex;flex-direction:column;gap:6px;color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
 .fld input,.fld select{background:rgba(15,23,42,.85);color:#e2e8f0;border:1px solid rgba(148,163,184,.32);border-radius:10px;padding:9px 11px;font-size:13.5px;font-weight:400;text-transform:none;letter-spacing:0}
 .repowrap{display:flex;gap:12px;align-items:center}
 .repowrap select{flex:1;min-width:0}
 .repowrap .wtlbl{text-transform:none;letter-spacing:0;font-weight:400;font-size:12.5px;white-space:nowrap}
 .sheetbtns{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}
 .ghost{background:transparent;color:#94a3b8;border:1px solid rgba(148,163,184,.3);border-radius:10px;padding:9px 15px;cursor:pointer;font-size:13px}
 .ghost:hover{color:#e2e8f0;border-color:rgba(148,163,184,.5)}`;

http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x');
  if(req.method==='POST'&&u.pathname==='/api/new'){ const n=clean(u.searchParams.get('name'))||('session-'+Math.floor(Date.now()/1000)); tmux(['new-session','-d','-s',n,'-c',DIR]); res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true,name:n})); }
  if(u.pathname==='/api/repos'){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(repos())); }
  if(req.method==='POST'&&u.pathname==='/api/spawn'){
    const repo=(u.searchParams.get('repo')||''); const name=clean(u.searchParams.get('name'))||('sess-'+Math.floor(Date.now()/1000));
    const mode=(u.searchParams.get('mode')==='shell')?'shell':'claude';
    const worktree=u.searchParams.get('worktree')==='1';
    let ok = repo.startsWith(CODE_ROOT+'/') && !repo.includes('..') && fs.existsSync(repo);
    let cwd=repo, branch=null, err=null;
    if(ok && worktree){
      if(!fs.existsSync(repo+'/.git')){ ok=false; err='not a git repo \u2014 worktree needs git'; }
      else{
        const wtBase=CODE_ROOT+'/.worktrees'; try{fs.mkdirSync(wtBase,{recursive:true});}catch{}
        const wtPath=wtBase+'/'+repo.split('/').pop()+'__'+name;
        branch='wt/'+name;
        let r=git(['-C',repo,'worktree','add','-b',branch,wtPath,'HEAD']);
        if(r.code!==0) r=git(['-C',repo,'worktree','add',wtPath,branch]);
        if(r.code!==0){ ok=false; err=('worktree add failed: '+r.out).slice(0,300); branch=null; }
        else cwd=wtPath;
      }
    }
    if(ok && !tmux(['has-session','-t',name])){
      if(mode==='shell'){
        tmux(['new-session','-d','-s',name,'-c',cwd]);
      } else {
        tmux(['new-session','-d','-s',name,'-c',cwd, CLAUDE_BIN+" --remote-control '"+name+"' --dangerously-skip-permissions"]);
        const answer=()=>{ try{ const pane=tmux(['capture-pane','-p','-t',name]);
          if(/trust this folder/.test(pane)) tmux(['send-keys','-t',name,'1','Enter']);
          else if(/Resume full session|Enter to confirm/.test(pane)) tmux(['send-keys','-t',name,'Enter']); }catch{} };
        [4000,7000,10000].forEach(t=>setTimeout(answer,t));
      }
    }
    res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok,name,mode,cwd,branch,err}));
  }
  if(req.method==='POST'&&u.pathname==='/api/kill'){ const n=clean(u.searchParams.get('name')); const rmwt=u.searchParams.get('worktree')==='1'; const cwd=u.searchParams.get('cwd')||''; if(n) tmux(['kill-session','-t',n]); let wt=null; if(rmwt) wt=removeWorktree(cwd); res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true,wt})); }
  if(u.pathname==='/api/sessions'){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(sessions())); }
  if(u.pathname==='/api/stats'){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(stats())); }

  // ---- Monitor page ----
  if(u.pathname==='/monitor'){
    const s=stats();
    res.writeHead(200,{'Content-Type':'text/html'});
    return res.end(`<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Monitor · Claude box</title>
<style>${CSS}
.gauges{margin-top:22px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.g{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:18px}
.g h3{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;font-weight:600}
.big{font-size:34px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
.bar{margin-top:12px;height:10px;border-radius:6px;background:rgba(2,6,23,.6);overflow:hidden}
.fill{height:100%;border-radius:6px;transition:width .5s,background .5s}
.small{margin-top:8px;font-size:12.5px;color:#94a3b8}
table{width:100%;margin-top:20px;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#94a3b8;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.2)}
td{padding:7px 10px;border-bottom:1px solid rgba(148,163,184,.07);font-variant-numeric:tabular-nums}
td.cmd{font-family:ui-monospace,Menlo,monospace;color:#7dd3fc}
.mini{display:inline-block;width:64px;height:6px;border-radius:4px;background:rgba(2,6,23,.6);vertical-align:middle;overflow:hidden;margin-left:8px}
.mini i{display:block;height:100%;background:#38bdf8}
</style></head><body><div class=wrap>
<header><div><h1>📊 System Monitor</h1><span class=sub id=meta></span></div>
<div class=nav><a href="/">Sessions</a><a href="/monitor" class=on>Monitor</a></div></header>
<div class=gauges id=gauges></div>
<table><thead><tr><th>PID</th><th>Process</th><th>CPU %</th><th>MEM %</th><th>RSS</th></tr></thead><tbody id=procs></tbody></table>
</div>
<script>
const INIT=${JSON.stringify(s)};
const col=(p)=>p<50?'#22c55e':p<80?'#f59e0b':'#ef4444';
function gb(b){return (b/1073741824).toFixed(1);}
function render(d){try{
 const memPct=d.memTotal?d.memUsed/d.memTotal*100:0, swapPct=d.swapTotal?d.swapUsed/d.swapTotal*100:0;
 document.getElementById('meta').textContent=d.ncpu+' vCPU · up '+fmtUp(d.up)+' · load '+d.load.map(x=>x.toFixed(2)).join(' ');
 document.getElementById('gauges').innerHTML=[
  card('CPU',d.cpu.toFixed(0)+'%',d.cpu,'load '+d.load[0].toFixed(2)+' over '+d.ncpu+' cores'),
  card('Memory',memPct.toFixed(0)+'%',memPct,gb(d.memUsed)+' / '+gb(d.memTotal)+' GB used · '+gb(d.memAvail)+'G free'),
  card('Swap',d.swapTotal?swapPct.toFixed(0)+'%':'—',swapPct,d.swapTotal?(gb(d.swapUsed)+' / '+gb(d.swapTotal)+' GB'):'no swap'),
  card('Load (1m)',d.load[0].toFixed(2),Math.min(100,d.load[0]/d.ncpu*100),'1/5/15: '+d.load.map(x=>x.toFixed(2)).join(' / '))
 ].join('');
 document.getElementById('procs').innerHTML=d.procs.map(p=>'<tr><td>'+p.pid+'</td><td class=cmd>'+p.comm+'</td><td>'+p.cpu.toFixed(1)+'<span class=mini><i style="width:'+Math.min(100,p.cpu)+'%;background:'+col(p.cpu)+'"></i></span></td><td>'+p.mem.toFixed(1)+'</td><td>'+gb(p.rss)+'G</td></tr>').join('');
}catch(e){}}
async function tick(){try{render(await(await fetch('/api/stats')).json());}catch(e){}}
function card(t,big,pct,small){return '<div class=g><h3>'+t+'</h3><div class=big>'+big+'</div><div class=bar><div class=fill style="width:'+Math.min(100,pct)+'%;background:'+col(pct)+'"></div></div><div class=small>'+small+'</div></div>';}
function fmtUp(s){const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+'d ':'')+(h?h+'h ':'')+m+'m';}
render(INIT);tick();setInterval(tick,2000);
</script></body></html>`);
  }

  // ---- Sessions page ----
  const s=sessions();
  const rccard=x=>`<div class="card rc" data-name="${esc(x.name)}"><div class=body onclick="window.open('https://claude.ai/code/${esc(x.bridge)}','_blank')"><div class=row><span class=name>${esc(x.name)}</span><span class="pill rc">RC</span></div><div class=ctitle ${x.title?'':'hidden'}>${esc(x.title)}</div><div class=cmd>▶ ${esc(x.cmd)}${x.status?' · '+esc(x.status):''}</div><pre class=preview><span class=e>rc-hosted · not in tmux · opens in claude.ai</span></pre><div class=meta>claude.ai ↗ <a class=vscode href="${CODE}/?folder=${encodeURIComponent(x.cwd||HOMEDIR)}" target=_blank rel=noopener onclick="event.stopPropagation()">‹/› VS Code</a></div></div></div>`;
  const card=x=> x.rc ? rccard(x) : `<div class="card ${x.attached?'on':''}" data-name="${esc(x.name)}" data-cwd="${esc(x.cwd||'')}"><button class=kill title="kill session" onclick="killSession('${esc(x.name)}',event)">✕</button><div class=body onclick="open_('${encodeURIComponent(x.name)}')"><div class=row><span class=name>${esc(x.name)}</span><span class="pill ${x.attached?'live':'idle'}">${x.attached?'LIVE':'idle'}</span></div><div class=ctitle ${x.title?'':'hidden'}>${esc(x.title)}</div><div class=cmd>${x.running?'▶':'○'} ${esc(x.cmd||'shell')}</div><pre class=preview>${esc(x.preview)||'<span class=e>— no output yet —</span>'}</pre><div class=meta>${x.wins} win · open ↗ <a class=vscode href="${CODE}/?folder=${encodeURIComponent(x.cwd||HOMEDIR)}" target=_blank rel=noopener onclick="event.stopPropagation()">‹/› VS Code</a></div></div></div>`;
  res.writeHead(200,{'Content-Type':'text/html'});
  res.end(`<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Claude Sessions</title>
<style>${CSS}
.grid{margin-top:22px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{position:relative;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:14px;transition:.15s}
.card:hover{transform:translateY(-3px);border-color:#38bdf8;background:rgba(56,189,248,.08)}
.card.on{border-color:rgba(34,197,94,.45)}.body{display:block;padding:15px 16px;cursor:pointer}
.kill{position:absolute;top:8px;right:8px;z-index:2;width:24px;height:24px;border-radius:7px;border:1px solid rgba(248,113,113,.35);background:rgba(248,113,113,.12);color:#f87171;font-size:12px;cursor:pointer;line-height:1;padding:0}
.kill:hover{background:#ef4444;color:#fff;border-color:#ef4444}
.row{display:flex;align-items:center;justify-content:space-between;padding-right:26px}
.name{font-weight:640;font-size:15.5px;color:#94a3b8;font-variant-numeric:tabular-nums}
.pill{font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:3px 9px;border-radius:999px}
.pill.live{color:#22c55e;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.4)}
.pill.idle{color:#64748b;background:rgba(100,116,139,.12);border:1px solid rgba(100,116,139,.3)}
 .pill.rc{color:#a78bfa;background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.45)}
 .card.rc{border-color:rgba(167,139,250,.3)}
.ctitle{margin-top:7px;font-size:15px;font-weight:650;color:#e2e8f0;line-height:1.3;word-break:break-word}.ctitle[hidden]{display:none}
.cmd{margin-top:7px;font-size:12px;color:#7dd3fc;font-family:ui-monospace,Menlo,monospace}
.preview{margin-top:9px;background:rgba(2,6,23,.55);border:1px solid rgba(148,163,184,.12);border-radius:8px;padding:9px 10px;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.5;color:#cbd5e1;white-space:pre-wrap;word-break:break-word;max-height:66px;overflow:hidden}
.preview .e{color:#475569}.meta{margin-top:9px;color:#94a3b8;font-size:11.5px}
 .vscode{margin-left:8px;color:#38bdf8;text-decoration:none;font-weight:600}
 .vscode:hover{text-decoration:underline}
</style></head><body><div class=wrap>
<header><div><h1>🧠 Claude Sessions</h1><span class=sub>${s.length} sessions · refreshes every 4s</span></div>
<div class=nav><a href="/" class=on>Sessions</a><a href="/monitor">📊 Monitor</a><button class=add onclick=openModal()>+ Session</button></div></header>
<div class=grid id=g>${s.map(card).join('')}</div></div>
<div id=modal class=modal hidden onclick="if(event.target===this)closeModal()"><div class=sheet>
<div class=sheettitle>New session</div>
<label class=fld>Name<input id=m_name type=text oninput="this.dataset.touched=1" placeholder="session name"></label>
<label class=fld>Type<select id=m_mode><option value="claude">Claude</option><option value="shell">Shell</option></select></label>
<label class=fld>Repo<span class=repowrap><select id=m_repo onchange="syncName()"></select><label class=wtlbl title="isolated git worktree + branch"><input type=checkbox id=m_wt> worktree</label></span></label>
<div class=sheetbtns><button class=ghost onclick="closeModal()">Cancel</button><button class=add onclick="doSpawn()">Launch</button></div>
</div></div>
<script>
function open_(n){window.open('${TERM}/?arg='+n,'_blank');}
function openModal(){const m=document.getElementById('modal');m.hidden=false;const n=document.getElementById('m_name');delete n.dataset.touched;syncName();setTimeout(function(){n.focus();},30);}
function closeModal(){document.getElementById('modal').hidden=true;}
function syncName(){const sel=document.getElementById('m_repo');const n=document.getElementById('m_name');if(sel&&sel.value&&n&&!n.dataset.touched)n.value=sel.value.split('/').pop();}
async function loadRepos(){try{const r=await(await fetch('/api/repos')).json();const sel=document.getElementById('m_repo');if(sel){sel.innerHTML=r.map(x=>'<option value="'+x.path+'">'+x.name+'</option>').join('');syncName();}}catch(e){}}
loadRepos();
async function doSpawn(){const repo=document.getElementById('m_repo').value;if(!repo){alert('No repo found under ~/Code');return;}const mode=document.getElementById('m_mode').value;const wt=document.getElementById('m_wt').checked?1:0;const name=(document.getElementById('m_name').value||'').trim();if(!name){alert('Enter a session name');return;}const q='/api/spawn?repo='+encodeURIComponent(repo)+'&name='+encodeURIComponent(name)+'&mode='+mode+'&worktree='+wt;const r=await(await fetch(q,{method:'POST'})).json();if(!r.ok){alert('Could not start session'+(r.err?': '+r.err:''));return;}closeModal();setTimeout(function(){location.reload();},1500);}
async function killSession(n,e){e.stopPropagation();const c=document.querySelector('.card[data-name="'+CSS.escape(n)+'"]');const cwd=c?(c.dataset.cwd||''):'';const isWt=cwd.indexOf('/.worktrees/')>=0;if(!confirm('Kill session "'+n+'"?'))return;let wt=0;if(isWt){wt=confirm('This session runs in a git worktree:\\n'+cwd+'\\n\\nAlso remove the worktree and its branch?\\nUncommitted changes there will be lost.')?1:0;}let url='/api/kill?name='+encodeURIComponent(n);if(wt)url+='&worktree=1&cwd='+encodeURIComponent(cwd);await fetch(url,{method:'POST'});if(c)c.remove();}
async function tick(){try{const d=await(await fetch('/api/sessions')).json();if(d.length!==document.querySelectorAll('.card').length){location.reload();return;}
 d.forEach(x=>{const c=document.querySelector('.card[data-name="'+CSS.escape(x.name)+'"]');if(!c||x.rc)return;const p=c.querySelector('.pill');p.className='pill '+(x.attached?'live':'idle');p.textContent=x.attached?'LIVE':'idle';c.classList.toggle('on',x.attached);const ct=c.querySelector('.ctitle');if(x.title){ct.textContent=x.title;ct.hidden=false;}else{ct.hidden=true;}c.querySelector('.cmd').textContent=(x.running?'▶ ':'○ ')+(x.cmd||'shell');c.querySelector('.preview').textContent=x.preview||'— no output yet —';});
}catch(e){}}
setInterval(tick,4000);
</script></body></html>`);
}).listen(PORT,'127.0.0.1',()=>console.log('dashboard on '+PORT));
