const http = require('http');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { URL } = require('url');
const path = require('path');
const PORT = 5000;
const HOMEDIR = process.env.HOME || '/home/ubuntu';
const DOMAIN = process.env.DEV_DOMAIN || 'dev.example.com';
const TERM = process.env.TERM_URL || ('https://term.' + DOMAIN);
const CODE = process.env.CODE_URL || ('https://code.' + DOMAIN);
const HOST = os.hostname();
const CODE_ROOT = process.env.CODE_ROOT || (HOMEDIR + '/Code');
const DIR = process.env.REPO_DIR || CODE_ROOT;
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
const HOME_DIR = HOMEDIR;
// Each Claude account = one config dir. Primary is ~/.claude; extra accounts live in
// ~/.claude-<name> (created by: CLAUDE_CONFIG_DIR=~/.claude-<name> claude  then /login).
function accounts(){
  const out=[{id:'primary', dir:HOME_DIR+'/.claude', label:'primary'}];
  try{ for(const e of fs.readdirSync(HOME_DIR,{withFileTypes:true})){
    if(e.isDirectory() && /^\.claude-[A-Za-z0-9_-]+$/.test(e.name) && fs.existsSync(HOME_DIR+'/'+e.name+'/.credentials.json'))
      out.push({id:e.name.slice(8), dir:HOME_DIR+'/'+e.name, label:e.name.slice(8)});
  }}catch{}
  return out;
}
function accountDir(id){ const a=accounts().find(x=>x.id===id); return a?a.dir:HOME_DIR+'/.claude'; }
// Which account owns a tmux session, and the conversation it is running: sessionId feeds
// `--resume`, cwd locates the transcript. Prefer the live pid; stale json files linger.
function claudeSession(tname){
  let best=null;
  for(const a of accounts()){
    let files=[]; try{ files=fs.readdirSync(a.dir+'/sessions'); }catch{ continue; }
    for(const f of files){
      if(!f.endsWith('.json')) continue;
      let d; try{ d=JSON.parse(fs.readFileSync(a.dir+'/sessions/'+f,'utf8')); }catch{ continue; }
      if((d.tmux||'').split(':')[0]!==tname || !d.sessionId) continue;
      const alive=!!(d.pid && fs.existsSync('/proc/'+d.pid));
      const cand={account:a.id, dir:a.dir, sid:d.sessionId, cwd:d.cwd||'', status:d.status||'', alive, at:d.updatedAt||0};
      if(!best || (cand.alive&&!best.alive) || (cand.alive===best.alive && cand.at>best.at)) best=cand;
    }
  }
  return best;
}
// True "last used" = the conversation transcript's mtime; it updates on EVERY message
// regardless of access path (terminal, remote-control, claude.ai, mobile) — unlike tmux
// session_activity, which only sees local pane I/O.
// Claude's per-project transcript dir mangles every '/', '.' and '_' in the cwd to '-',
// so ~/Code/.worktrees/repo__wt lives in projects/-home-ubuntu-Code--worktrees-repo--wt.
const projDir = cwd => cwd.replace(/[/._]/g,'-');
function transcriptMtime(dir, sessionId, cwd){
  if(!sessionId || !cwd) return 0;
  try{ return Math.floor(fs.statSync(dir+'/projects/'+projDir(cwd)+'/'+sessionId+'.jsonl').mtimeMs/1000); }catch{ return 0; }
}
const NCPU = os.cpus().length;

const tmux = (a) => { try { return execFileSync('tmux', a, {encoding:'utf8'}); } catch { return ''; } };
const hasSession = (n) => { try { execFileSync('tmux', ['has-session','-t','='+n], {stdio:'ignore'}); return true; } catch { return false; } };
const git = (a) => { try { return {code:0, out: execFileSync('git', a, {encoding:'utf8'})}; } catch(e){ return {code: e.status||1, out: ((e.stdout||'')+(e.stderr||''))}; } };
// A freshly spawned Claude stops on one-time prompts (trust folder, bypass-permissions,
// teleport confirm). Poll the pane and answer them so the session comes up unattended.
const sleep = ms => new Promise(r=>setTimeout(r,ms));
// Type a first message into a freshly launched session, but only once it is past the
// trust/bypass prompts and showing its input line — otherwise the keys answer a dialog.
function sendWhenReady(name, text, tries){
  let n=0; const max=tries||24;
  const tick=()=>{ n++;
    let pane=''; try{ pane=tmux(['capture-pane','-p','-t',name]); }catch{}
    if(/bypass permissions on/.test(pane) && !/trust this folder|Yes, I accept/.test(pane)){
      tmux(['send-keys','-t',name,'-l',text]);
      setTimeout(()=>tmux(['send-keys','-t',name,'Enter']),600);
      return;
    }
    if(n<max) setTimeout(tick,2500);
  };
  setTimeout(tick,6000);
}
function autoAnswer(name, mode){
  const rcState={sent:false};
  const answer=()=>{ try{ const pane=tmux(['capture-pane','-p','-t',name]);
    if(/trust this folder/.test(pane)) tmux(['send-keys','-t',name,'1','Enter']);
    else if(/Bypass Permissions mode/.test(pane) && /Yes, I accept/.test(pane)) tmux(['send-keys','-t',name,'2','Enter']);   // one-time per new config dir
    else if(/Teleport to Repo|Resume full session|Enter to confirm/.test(pane)) tmux(['send-keys','-t',name,'Enter']);
    else if(mode==='teleport' && !rcState.sent && !/remote-control is active/.test(pane) && /(Session resumed|bypass permissions on)/i.test(pane)){ tmux(['send-keys','-t',name,'/remote-control','Enter']); rcState.sent=true; } }catch{} };
  const sched = (mode==='teleport') ? [4000,7000,10000,13000,16000,19000,22000,25000,28000,32000,36000,40000,45000,50000,55000] : [4000,7000,10000];
  sched.forEach(t=>setTimeout(answer,t));
}
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
  // Root fs — /home is on the same device here. bavail is what a normal user can
  // actually claim, so used% is measured against total-minus-reserve, like df.
  let diskTotal=0, diskUsed=0, diskAvail=0;
  try{ const st=fs.statfsSync('/');
    diskTotal=st.blocks*st.bsize; diskAvail=st.bavail*st.bsize; diskUsed=(st.blocks-st.bfree)*st.bsize; }catch{}
  return {cpu:cpuPct, ncpu:NCPU, memTotal, memUsed, memAvail, swapTotal, swapUsed, diskTotal, diskUsed, diskAvail, load, up, procs};
}

// ---- per-session CPU/RAM: sum each tmux session's whole process tree ----
const CLK_TCK = 100;                 // USER_HZ on Linux
let _uPrev = null;                   // { t: ms, ticks: {pid: utime+stime} }
function _readProcs(){
  const stat = {}, rssB = {}, children = {};
  let pids; try { pids = fs.readdirSync('/proc').filter(f=>/^\d+$/.test(f)); } catch { return null; }
  for (const pid of pids) {
    let s; try { s = fs.readFileSync('/proc/'+pid+'/stat','utf8'); } catch { continue; }
    const rp = s.lastIndexOf(')'); if (rp < 0) continue;
    const rest = s.slice(rp+2).split(' ');       // fields after comm: state=0 ppid=1 ... utime=11 stime=12
    const ppid = +rest[1]||0, ticks = (+rest[11]||0)+(+rest[12]||0);
    stat[pid] = { ppid, ticks };
    (children[ppid] = children[ppid] || []).push(+pid);
    try { rssB[pid] = (+fs.readFileSync('/proc/'+pid+'/statm','utf8').split(' ')[1]||0) * 4096; } catch { rssB[pid] = 0; }
  }
  return { stat, rssB, children };
}
function usage(){
  const snap = _readProcs(); if (!snap) return {};
  const now = Date.now();
  const dt = _uPrev ? (now - _uPrev.t)/1000 : 0;
  const panes = tmux(['list-panes','-a','-F','#{session_name}\t#{pane_pid}']).trim();
  const sess = {};
  if (panes) for (const l of panes.split('\n')) { const [nm,pp]=l.split('\t'); if(nm) (sess[nm]=sess[nm]||[]).push(+pp); }
  const out = {};
  for (const nm in sess) {
    const seen = new Set(); const stack = sess[nm].slice();
    while (stack.length) { const pid = stack.pop(); if (seen.has(pid)) continue; seen.add(pid); for (const k of (snap.children[pid]||[])) stack.push(k); }
    let mem = 0, deltaTicks = 0;
    for (const pid of seen) {
      const st = snap.stat[pid]; if (!st) continue;
      mem += snap.rssB[pid] || 0;
      if (_uPrev && _uPrev.ticks[pid] != null) { const d = st.ticks - _uPrev.ticks[pid]; if (d > 0) deltaTicks += d; }
    }
    let cpu = (_uPrev && dt > 0) ? (deltaTicks / CLK_TCK / dt * 100) : 0;
    cpu = Math.max(0, Math.min(cpu, NCPU*100));
    out[nm] = { mem: Math.round(mem/1048576), cpu: Math.round(cpu) };
  }
  const ticksMap = {}; for (const pid in snap.stat) ticksMap[pid] = snap.stat[pid].ticks;
  _uPrev = { t: now, ticks: ticksMap };
  return out;
}
function sessions(){
  const out = tmux(['list-sessions','-F','#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}']).trim();
  const tsess = !out ? [] : out.split('\n').map(l=>{
    const [name,wins,att,created,activity]=l.split('\t');
    const info=tmux(['display-message','-p','-t',name,'#{pane_current_command}\t#{pane_title}\t#{pane_current_path}']).trim();
    const [cmd='',rawTitle='',cwd='']=info.split('\t');
    const bareTitle=(rawTitle||'').replace(/^[\s✳✶✻✽●◐◓◑◒○◍◉·]+/u,'').trim();   // strip Claude's status glyph
    const title=(bareTitle && bareTitle!==HOST && bareTitle!=='Claude Code' && bareTitle!=='teleported')?rawTitle:'';
    const cap=tmux(['capture-pane','-p','-t',name,'-S','-14']).replace(/\s+$/,'');
    const lines=cap.split('\n').map(s=>s.replace(/\s+$/,'')).filter(s=>s.length);
    return {name,wins:+wins,attached:att==='1',cmd,title,cwd,created:+created||0,activity:+activity||0,preview:lines.slice(-3).join('\n'),running:/^(claude|node|python|vim|nano|ssh|git)/.test(cmd)};
  }).filter(x=>!(x.name||'').startsWith('_'));   // '_'-prefixed = hidden/internal (e.g. the dashboard's own control session)
  const tnames = new Set(tsess.map(x=>x.name));
  const rc = [];
  const meta = {};   // tmux name -> {account, bridge}
  for (const a of accounts()) {
    let files=[]; try { files = fs.readdirSync(a.dir+'/sessions'); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let d; try { d = JSON.parse(fs.readFileSync(a.dir+'/sessions/'+f,'utf8')); } catch { continue; }
      const alive = d.pid && fs.existsSync('/proc/'+d.pid);
      const tname = (d.tmux||'').split(':')[0];
      const lu = transcriptMtime(a.dir, d.sessionId, d.cwd);
      if (tname && tnames.has(tname)) { if(!meta[tname]) meta[tname]={account:a.id, bridge:d.bridgeSessionId||null, lastUsed:lu, sid:(alive?d.sessionId:null), status:d.status||''}; else { if(lu>(meta[tname].lastUsed||0)) meta[tname].lastUsed=lu; if(alive && d.sessionId && !meta[tname].sid){ meta[tname].sid=d.sessionId; meta[tname].status=d.status||''; } } continue; }
      if (!alive || !d.bridgeSessionId) continue;                // rc-hosted needs alive + registered
      const nm = tname || d.name || ('rc-'+d.pid);
      if (nm.startsWith('_')) continue;                          // hidden/internal session
      if (tnames.has(nm)) continue;
      tnames.add(nm);
      let st; try{ st=fs.statSync(a.dir+'/sessions/'+f); }catch{ st=null; }
      const fileAct = st?Math.floor(st.mtimeMs/1000):0;
      rc.push({name:nm, rc:true, account:a.id, bridge:d.bridgeSessionId, cwd:d.cwd||'',
        title:(d.nameSource && d.nameSource!=='derived')?(d.name||''):'',
        cmd:'remote-control host', status:d.status||'', wins:1, attached:false, running:true, preview:'',
        created: st?Math.floor((st.birthtimeMs||st.mtimeMs)/1000):0, activity: Math.max(fileAct, lu)});
    }
  }
  const use = usage();
  tsess.forEach(s=>{ const m=meta[s.name]; s.account = m?m.account:'primary'; s.bridge = m?m.bridge:null; if(m && m.lastUsed>s.activity) s.activity=m.lastUsed; const u=use[s.name]; s.mem = u?u.mem:0; s.cpu = u?u.cpu:0;
    s.canBranch = !!(m && m.sid && inGitRepo(s.cwd));   // forking needs a live Claude conversation; a worktree needs git
  });
  rc.forEach(s=>{ s.mem = 0; s.cpu = 0; });
  return tsess.concat(rc).sort((a,b)=>a.name.localeCompare(b.name));
}
// Walk up to CODE_ROOT looking for .git (a file in a worktree, a dir in a checkout).
function inGitRepo(cwd){
  if(!cwd || cwd.indexOf(CODE_ROOT)!==0) return false;
  let d=cwd;
  for(let i=0;i<8 && d.length>=CODE_ROOT.length;i++){
    if(fs.existsSync(d+'/.git')) return true;
    const up=path.dirname(d); if(up===d) break; d=up;
  }
  return false;
}
// ---- Basecamp bridge state (written by bin/bc-threads) ----
const BC_STORE   = HOMEDIR+'/.claude/bc-threads.json';
const BC_HISTORY = HOMEDIR+'/.claude/bc-history.jsonl';
const BC_HOOKS   = HOMEDIR+'/.claude/bc-hooks.json';
function bcSave(reg){
  const tmp=BC_STORE+'.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg,null,1));
  fs.renameSync(tmp, BC_STORE);                    // atomic: bc-threads may be mid-cycle
}
function bcNote(rec){
  try{ fs.appendFileSync(BC_HISTORY, JSON.stringify(Object.assign({ts:Math.floor(Date.now()/1000)},rec))+'\n'); }catch{}
}
// Drop the routing between a thread (or ping) and its session. A thread with no session
// has nothing to deliver to, so unlinking stops watching it; a ping falls back to the
// dashboard, which is where unrouted pings go anyway.
function bcUnlink(kind, id){
  let reg; try{ reg=JSON.parse(fs.readFileSync(BC_STORE,'utf8')); }catch{ return {ok:false,err:'no registry'}; }
  if(kind==='ping'){
    const t=(reg.pings||{})[id]; if(!t) return {ok:false,err:'unknown ping'};
    const was=t.session||'';
    if(was){ delete t.session; bcSave(reg); bcNote({kind:'unlink',circle:id,title:t.who||'',session:was,text:'ping unlinked \u2014 routes to _dashboard again'}); return {ok:true,was,mode:'ping-detached'}; }
    delete reg.pings[id]; bcSave(reg); bcNote({kind:'unlink',circle:id,title:t.who||'',session:'',text:'ping thread removed'});
    return {ok:true,was:'',mode:'ping-removed'};
  }
  const t=(reg.threads||{})[id]; if(!t) return {ok:false,err:'unknown thread'};
  const was=t.session||''; const title=t.title||'';
  delete reg.threads[id]; bcSave(reg);
  bcNote({kind:'unlink',thread:id,title,session:was,text:'thread unlinked \u2014 no longer watched'});
  return {ok:true,was,title,mode:'thread-removed'};
}
function bcState(){
  let reg={threads:{},pings:{}}, hooks={projects:{}}, hist=[];
  try{ reg=JSON.parse(fs.readFileSync(BC_STORE,'utf8')); }catch{}
  try{ hooks=JSON.parse(fs.readFileSync(BC_HOOKS,'utf8')); }catch{}
  try{
    const lines=fs.readFileSync(BC_HISTORY,'utf8').trim().split('\n').slice(-400);
    for(const l of lines){ try{ hist.push(JSON.parse(l)); }catch{} }
  }catch{}
  hist.reverse();                                   // newest first
  const live={}; for(const x of sessions()) live[x.name]={bridge:x.bridge,rc:!!x.rc,cwd:x.cwd,attached:x.attached};
  const threads=Object.entries(reg.threads||{}).map(([id,t])=>({
    id, kind:'thread', title:t.title||'', session:t.session||'', project:String(t.project||''),
    url:t.url||'', last:t.last_comment_id||0, ours:(t.ours||[]).length,
    bridge:(live[t.session]||{}).bridge||null, alive:!!live[t.session]
  }));
  const pings=Object.entries(reg.pings||{}).map(([id,t])=>({
    id, kind:'ping', title:t.who||'', session:t.session||'_dashboard', project:'',
    url:'https://app.basecamp.com/4156959/circles/'+id, last:t.last_line_id||0, ours:0,
    bridge:(live[t.session||'_dashboard']||{}).bridge||null, alive:!!live[t.session||'_dashboard']
  }));
  const projects=Object.entries(reg.projects||{}).map(([id,r])=>({
    id, hook:r.hook_id||null, active:!!r.active, connected:r.connected||0,
    threads:threads.filter(t=>t.project===id),
    sessions:[...new Set(threads.filter(t=>t.project===id).map(t=>t.session))]
  })).sort((a,b)=>a.id.localeCompare(b.id));
  return {projects, threads:threads.concat(pings), hooks, hist, self:reg.self||null};
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
 .fldhint{text-transform:none;letter-spacing:0;font-weight:400;font-size:11px;color:#64748b;margin-top:4px}
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
  if(u.pathname==='/api/bridge'){ const nm=clean(u.searchParams.get('name')); let bridge=null;
    for(const a of accounts()){ let files=[]; try{ files=fs.readdirSync(a.dir+'/sessions'); }catch{ continue; }
      for(const f of files){ if(!f.endsWith('.json'))continue;
        let d; try{ d=JSON.parse(fs.readFileSync(a.dir+'/sessions/'+f,'utf8')); }catch{ continue; }
        if((d.tmux||'').split(':')[0]===nm && d.bridgeSessionId){ bridge=d.bridgeSessionId; break; } }
      if(bridge) break; }
    res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({bridge})); }
  if(u.pathname==='/api/accounts'){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(accounts().map(a=>({id:a.id,label:a.label})))); }
  if(req.method==='POST'&&u.pathname==='/api/spawn'){
    const repo=(u.searchParams.get('repo')||''); let name=clean(u.searchParams.get('name')) || clean((repo.split('/').filter(Boolean).pop())||'') || 'session';   // internal id, derived from repo; Claude's title is what surfaces
    const mreq=u.searchParams.get('mode');
    const mode=(mreq==='shell'||mreq==='teleport')?mreq:'claude';
    const worktree=u.searchParams.get('worktree')==='1';
    const account=(u.searchParams.get('account')||'primary');
    const cfgDir=accountDir(account);
    const envArgs=(account!=='primary')?['-e','CLAUDE_CONFIG_DIR='+cfgDir]:[];
    let sid=(u.searchParams.get('session')||'').trim();
    if(sid.includes('/')) sid=(sid.split(/[?#]/)[0].split('/').filter(Boolean).pop())||'';
    sid=sid.replace(/[^A-Za-z0-9_-]/g,'').slice(0,120);
    let ok, cwd, branch=null, err=null;
    if(mode==='teleport'){ cwd=CODE_ROOT; ok=true; }   // teleport self-selects (and clones) its repo; run from ~/Code
    else { ok = repo.startsWith(CODE_ROOT+'/') && !repo.includes('..') && fs.existsSync(repo); cwd=repo; }
    if(ok){ const b0=name; let k=2; while(hasSession(name)){ name=b0+'-'+k; k++; } }   // guarantee a unique session name
    if(ok && worktree && mode!=='teleport'){
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
    if(mode==='teleport' && !sid){ ok=false; err='cloud session id or claude.ai/code URL required'; }
    if(ok){
      if(mode==='shell'){
        tmux(['new-session','-d','-s',name,'-c',cwd].concat(envArgs));
      } else {
        const cmd = (mode==='teleport')
          ? CLAUDE_BIN+" --teleport '"+sid+"' --remote-control '"+name+"' --dangerously-skip-permissions"
          : CLAUDE_BIN+" --remote-control '"+name+"' --dangerously-skip-permissions";
        tmux(['new-session','-d','-s',name,'-c',cwd].concat(envArgs).concat([cmd]));
        autoAnswer(name,mode);
      }
    }
    res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok,name,mode,cwd,sid,branch,err}));
  }
  // Everything the branch dialog needs to prefill: deliberate names derived from the REPO
  // (parent session names are often inherited and say nothing about the code), plus whether
  // the parent is mid-turn.
  function branchDefaults(parent){
    if(!parent||!hasSession(parent)) return {ok:false,err:'no such session'};
    const ps=claudeSession(parent);
    const pcwd=(ps&&ps.cwd)||tmux(['display-message','-p','-t',parent,'#{pane_current_path}']).trim();
    if(!pcwd||!fs.existsSync(pcwd)) return {ok:false,err:'cannot resolve that session’s directory'};
    if(git(['-C',pcwd,'rev-parse','--git-dir']).code!==0) return {ok:false,err:'not a git repo — branching needs git'};
    if(!ps || !ps.sid) return {ok:false,err:'no Claude conversation here — branching forks a running Claude session'};
    if(git(['-C',pcwd,'rev-parse','--verify','--quiet','HEAD']).code!==0) return {ok:false,err:'this repo has no commits to branch from'};
    const g=git(['-C',pcwd,'rev-parse','--git-common-dir']);
    let common=g.out.trim(); if(common && common[0]!=='/') common=path.resolve(pcwd,common);
    const mainRepo=path.dirname(common), repoName=path.basename(mainRepo);
    const pbranch=git(['-C',pcwd,'rev-parse','--abbrev-ref','HEAD']).out.trim();
    const mainBranch=git(['-C',mainRepo,'rev-parse','--abbrev-ref','HEAD']).out.trim();
    let name='', n=2;
    while(n<60){ const c=repoName+'-b'+n; if(!hasSession(c) && !fs.existsSync(CODE_ROOT+'/.worktrees/'+repoName+'__b'+n)){ name=c; break; } n++; }
    return {ok:true, parent, pcwd, mainRepo, repoName, pbranch, mainBranch,
      dirty: git(['-C',pcwd,'status','--porcelain']).out.trim().length>0,
      status:(ps&&ps.status)||'', hasConvo:!!(ps&&ps.sid),
      name, wt: repoName+'__b'+n, branch:'wt/'+name};
  }
  if(u.pathname==='/api/branchinfo'){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(branchDefaults(clean(u.searchParams.get('name'))))); }

  // Branch a running session into its own worktree: a new branch off its current HEAD plus
  // a fork of its conversation, so the spin-off starts knowing what the parent knew.
  if(req.method==='POST'&&u.pathname==='/api/branch'){
    const parent=clean(u.searchParams.get('name'));
    const carry=u.searchParams.get('carry')!=='0';           // fork the transcript too
    const wait=u.searchParams.get('wait')!=='0';             // let the parent land its turn first
    const wantName=clean(u.searchParams.get('as')||'');
    const wantWt=(u.searchParams.get('wt')||'').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,80);
    const done=o=>{ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(o)); };
    (async()=>{
      const d=branchDefaults(parent);
      if(!d.ok) return done(d);
      const name=wantName||d.name;
      const wtName=wantWt||d.wt;
      const cwd=CODE_ROOT+'/.worktrees/'+wtName;
      const branch='wt/'+name;
      if(!name) return done({ok:false,err:'a session name is required'});
      if(hasSession(name)) return done({ok:false,err:'session “'+name+'” already exists'});
      if(fs.existsSync(cwd)) return done({ok:false,err:'worktree “'+wtName+'” already exists'});
      if(git(['-C',d.pcwd,'rev-parse','--verify','--quiet','refs/heads/'+branch]).code===0)
        return done({ok:false,err:'branch “'+branch+'” already exists'});
      // Forking mid-turn copies a half-written transcript, so hold until the parent is idle.
      let waited=0;
      if(wait){ const t0=Date.now();
        while(Date.now()-t0 < 900000){ const cs=claudeSession(parent); if(!cs || cs.status!=='busy') break; await sleep(2000); }
        waited=Math.round((Date.now()-t0)/1000); }
      const ps=claudeSession(parent);
      const busy=!!(ps && ps.status==='busy');
      const headr=git(['-C',d.pcwd,'rev-parse','HEAD']);
      if(headr.code!==0) return done({ok:false,err:'repo has no commits to branch from'});
      const dirty=git(['-C',d.pcwd,'status','--porcelain']).out.trim().length>0;
      try{fs.mkdirSync(CODE_ROOT+'/.worktrees',{recursive:true});}catch{}
      const r=git(['-C',d.pcwd,'worktree','add','-b',branch,cwd,headr.out.trim()]);
      if(r.code!==0) return done({ok:false,err:('worktree add failed: '+r.out).slice(0,300)});
      const cfgDir=(ps&&ps.dir)||(HOME_DIR+'/.claude');
      const account=(ps&&ps.account)||'primary';
      // Transcripts are stored per project dir, so seed the parent's into the worktree's
      // before --resume goes looking for it there.
      let carried=false;
      if(!ps || !ps.sid || !ps.cwd) return done({ok:false,err:'the parent’s Claude session went away before we could fork it'});
      if(carry){
        const src=cfgDir+'/projects/'+projDir(ps.cwd)+'/'+ps.sid+'.jsonl';
        const dstDir=cfgDir+'/projects/'+projDir(cwd);
        try{ if(fs.existsSync(src)){ fs.mkdirSync(dstDir,{recursive:true}); fs.copyFileSync(src,dstDir+'/'+ps.sid+'.jsonl'); carried=true; } }catch{}
      }
      const note=[
        'You are a FORK of the session “'+parent+'”'+(carried?', carrying its conversation history':'')+'.',
        'STOP before acting: do NOT continue whatever that session was in the middle of. It was working somewhere else, on a different branch. Re-orient first — check where you are and what this branch is for, and say so — before you touch a file.',
        'Your cwd '+cwd+' is a git worktree on branch '+branch+', cut from '+(d.pbranch||'HEAD')+' — the branch the parent is on, checked out at '+d.pcwd+'.',
        'The primary checkout is '+d.mainRepo+' on '+(d.mainBranch||'unknown')+'. Every one of these is the SAME repository: all worktrees share one object store and one set of refs.',
        'So you can take their work directly, with no remote and no fetch: git merge '+(d.pbranch||'HEAD')+', git diff '+(d.mainBranch||'HEAD')+', git log '+(d.mainBranch||'HEAD')+', git rebase '+(d.mainBranch||'HEAD')+'.',
        dirty
          ? 'The parent working tree '+d.pcwd+' has UNCOMMITTED changes that did not come with you. To pull them in: git -C '+d.pcwd+' diff | git apply - (add --staged for staged work; untracked files are not included).'
          : 'The parent working tree had no uncommitted changes when you were branched.',
        'Never check out '+[d.pbranch,d.mainBranch].filter((v,i,a)=>v&&a.indexOf(v)===i).join(' or ')+' here — git forbids the same branch in two worktrees. Work on '+branch+' and merge back when done.'
      ].join(' ');
      const shq = v => "'"+String(v).replace(/'/g,"'\\''")+"'";
      const envArgs=(account!=='primary')?['-e','CLAUDE_CONFIG_DIR='+cfgDir]:[];
      if(!carried){ git(['-C',d.pcwd,'worktree','remove','--force',cwd]); git(['-C',d.pcwd,'branch','-D',branch]);
        return done({ok:false,err:'could not read the parent’s transcript — nothing to fork'}); }
      const cmd = CLAUDE_BIN+' --resume '+shq(ps.sid)+' --fork-session --remote-control '+shq(name)
        +' --dangerously-skip-permissions --append-system-prompt '+shq(note);
      tmux(['new-session','-d','-s',name,'-c',cwd].concat(envArgs).concat([cmd]));
      autoAnswer(name,'claude');
      sendWhenReady(name,'You have just been forked into a new git worktree. Stop the task you were mid-way through — it belongs to the session you were forked from, not here. Run pwd, git branch --show-current and git status, then tell me in a couple of lines where you are, what this branch is for as far as you can tell, and what you would do first. Do not change any files until I answer.');
      done({ok:true,name,parent,cwd,branch,carried,dirty,waited,busy,err:null});
    })().catch(e=>{ try{ done({ok:false,err:String((e&&e.message)||e)}); }catch{} });
    return;
  }
  if(req.method==='POST'&&u.pathname==='/api/kill'){ const n=clean(u.searchParams.get('name')); const rmwt=u.searchParams.get('worktree')==='1'; const cwd=u.searchParams.get('cwd')||''; if(n) tmux(['kill-session','-t',n]); let wt=null; if(rmwt) wt=removeWorktree(cwd); res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true,wt})); }
  if(u.pathname==='/api/sessions'){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(sessions())); }
  if(u.pathname==='/api/stats'){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(stats())); }

  // ---- Monitor page ----
  if(req.method==='POST'&&(u.pathname==='/api/basecamp/connect'||u.pathname==='/api/basecamp/disconnect')){
    const proj=(u.searchParams.get('project')||'').replace(/[^0-9]/g,'');
    const flag=(u.pathname.endsWith('/connect'))?'--connect':'--disconnect';
    if(!proj){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,err:'missing project'})); }
    let out='',ok=true;
    try{ out=execFileSync('/usr/local/bin/bc-threads',['projects',flag,proj],{encoding:'utf8',timeout:120000}); }
    catch(e){ ok=false; out=String((e&&(e.stdout||e.message))||e); }
    bcNote({kind:flag==='--connect'?'connect':'disconnect',title:'project '+proj,text:out.trim().slice(0,300)});
    res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok,out:out.trim()}));
  }
  if(req.method==='POST'&&u.pathname==='/api/basecamp/unlink'){
    const kind=(u.searchParams.get('kind')==='ping')?'ping':'thread';
    const id=(u.searchParams.get('id')||'').replace(/[^0-9]/g,'');
    const r=id?bcUnlink(kind,id):{ok:false,err:'missing id'};
    res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(r));
  }
  if(u.pathname==='/api/basecamp'){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(bcState())); }
  if(u.pathname==='/basecamp'){
    const d=bcState();
    const ago=t=>{ if(!t) return '—'; const s=Math.floor(Date.now()/1000)-t; if(s<60) return s+'s'; if(s<3600) return Math.floor(s/60)+'m'; if(s<86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; };
    const hookRows=d.projects.map(p=>`<tr><td class=cmd>${esc(p.id)}</td>
        <td>${p.hook?`<span class="pill live">webhook ${esc(String(p.hook))}${p.active?'':' (inactive)'}</span>`:'<span class="pill idle">no webhook — polling only</span>'}</td>
        <td>${p.threads.map(t=>`<span class=chip>${esc(t.title||t.id)}</span>`).join(' ')||'<span class=dim>no threads watched</span>'}</td>
        <td>${p.sessions.map(x=>esc(x)).join(', ')||'<span class=dim>—</span>'}</td>
        <td><button class=unlink data-act=disconnect data-id="${esc(p.id)}" data-n="${p.threads.length}" title="remove this box's webhook for the project">disconnect</button></td></tr>`).join('');
    const linkRows=d.threads.map(t=>`<tr>
      <td><span class="pill ${t.kind==='ping'?'rc':'live'}">${t.kind}</span></td>
      <td>${t.url?`<a href="${esc(t.url)}" target=_blank rel=noopener>${esc(t.title||t.id)}</a>`:esc(t.title||t.id)}<div class=dim>${esc(t.id)}</div></td>
      <td class=cmd>${esc(t.project||'—')}</td>
      <td>${esc(t.session||'—')} ${t.alive?'<span class="pill live">live</span>':'<span class="pill idle">gone</span>'}</td>
      <td>${t.bridge?`<a href="https://claude.ai/code/${esc(t.bridge)}" target=_blank rel=noopener>claude.ai ↗</a>`:'<span class=dim>not bridged</span>'}</td>
      <td class=num>${t.ours||0}</td>
      <td><button class=unlink data-kind="${t.kind}" data-id="${esc(t.id)}" data-label="${esc(t.title||t.id)}" data-sess="${esc(t.session||'')}" title="remove this link">unlink</button></td></tr>`).join('');
    const histRows=d.hist.map(h=>{
      const k=h.kind==='sent'?'sent':(h.kind==='hold'?'held':'in');
      const cls=h.kind==='sent'?'acct':(h.kind==='hold'?'idle':'live');
      return `<tr><td class=num title="${esc(new Date((h.ts||0)*1000).toISOString())}">${ago(h.ts)}</td>
        <td><span class="pill ${cls}">${k}</span></td>
        <td>${esc(h.title||h.thread||h.circle||'')}</td>
        <td>${esc(h.frm||(h.kind==='sent'?'CatalogsAI':''))}</td>
        <td>${esc(h.session||'')}</td>
        <td class=msg>${esc(h.text||(h.why?('('+h.why+', '+(h.count||0)+' waiting)'):''))}</td></tr>`;
    }).join('');
    res.writeHead(200,{'Content-Type':'text/html'});
    return res.end(`<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Basecamp · Claude box</title>
<style>${CSS}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin:26px 0 6px}
table{width:100%;border-collapse:collapse;font-size:13px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;overflow:hidden}
th{text-align:left;color:#94a3b8;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:9px 11px;border-bottom:1px solid rgba(148,163,184,.2)}
td{padding:8px 11px;border-bottom:1px solid rgba(148,163,184,.07);vertical-align:top}
td.num{font-variant-numeric:tabular-nums;color:#94a3b8;white-space:nowrap}
td.cmd{font-family:ui-monospace,Menlo,monospace;color:#7dd3fc}
td.msg{color:#cbd5e1;max-width:640px}
.dim{color:#64748b;font-size:11.5px}
.chip{display:inline-block;background:rgba(56,189,248,.12);border:1px solid rgba(56,189,248,.3);color:#7dd3fc;border-radius:7px;padding:1px 7px;font-size:11.5px;margin:1px 0}
a{color:#7dd3fc;text-decoration:none} a:hover{text-decoration:underline}
.hookurl{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#64748b;word-break:break-all}
.unlink{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.32);color:#f87171;border-radius:8px;padding:3px 10px;font-size:11.5px;cursor:pointer}
.unlink:hover{background:#ef4444;color:#fff;border-color:#ef4444}
</style></head><body><div class=wrap>
<header><div><h1>Basecamp bridge</h1><span class=sub>${d.projects.length} project(s) · ${d.threads.length} watched · ${d.hist.length} events · posting as ${esc((d.self||{}).name||'?')}</span></div>
<div class=nav><a href="/">Sessions</a><a href="/monitor">📊 Monitor</a><a href="/basecamp" class=on>Basecamp</a></div></header>
<h2>This box ↔ projects</h2>
<div class=dim style="margin-bottom:6px">One webhook per project, owned by the box. Independent of threads and sessions — unlinking a thread leaves the connection alone.</div>
<table><thead><tr><th>Project</th><th>Connection</th><th>Watched threads</th><th>Sessions</th><th></th></tr></thead><tbody>${hookRows||'<tr><td colspan=5 class=dim>not connected to any project</td></tr>'}</tbody></table>
<div class=hookurl>receiver: ${esc((d.hooks.url||'').replace(/\/[^/]+$/,'/••••••'))} · snapshot ${ago(d.hooks.checked)} ago</div>
<h2>Thread ↔ session links</h2>
<table><thead><tr><th>Kind</th><th>Thread</th><th>Project</th><th>Session</th><th>Web</th><th>Sent</th><th></th></tr></thead><tbody>${linkRows||'<tr><td colspan=7 class=dim>nothing registered</td></tr>'}</tbody></table>
<h2>Message history</h2>
<table><thead><tr><th>When</th><th></th><th>Thread</th><th>From</th><th>Session</th><th>Message</th></tr></thead><tbody>${histRows||'<tr><td colspan=6 class=dim>no messages yet</td></tr>'}</tbody></table>
</div><script>
var RELOAD=setTimeout(function(){location.reload();},20000);
document.addEventListener('click',async function(e){
  var b=e.target.closest('.unlink'); if(!b) return;
  clearTimeout(RELOAD);
  if(b.dataset.act==='disconnect'){
    var n=+b.dataset.n||0;
    if(!confirm('Disconnect this box from project '+b.dataset.id+'?\\n\\nIts webhook is deleted. '+(n?(n+' watched thread(s) stay registered and fall back to 2-minute polling.'):'No threads are watched there.')+'\\n\\nReconnect with: bc-threads projects --connect '+b.dataset.id)){ RELOAD=setTimeout(function(){location.reload();},20000); return; }
    b.disabled=true; b.textContent='\u2026';
    var rr=await(await fetch('/api/basecamp/disconnect?project='+encodeURIComponent(b.dataset.id),{method:'POST'})).json();
    if(!rr.ok){ alert('Could not disconnect: '+(rr.out||'')); b.disabled=false; b.textContent='disconnect'; return; }
    location.reload(); return;
  }
  var kind=b.dataset.kind, sess=b.dataset.sess;
  var what=(kind==='ping')
    ? 'Unlink this ping from '+(sess||'its session')+'?\\n\\nIt will route to _dashboard again.'
    : 'Unlink "'+b.dataset.label+'" from '+(sess||'its session')+'?\\n\\nThe thread stops being watched \u2014 new comments will not reach any session. Re-add it later with: bc-threads register '+b.dataset.id+' -s <session>';
  if(!confirm(what)){ RELOAD=setTimeout(function(){location.reload();},20000); return; }
  b.disabled=true; b.textContent='\u2026';
  var r=await(await fetch('/api/basecamp/unlink?kind='+kind+'&id='+encodeURIComponent(b.dataset.id),{method:'POST'})).json();
  if(!r.ok){ alert('Could not unlink'+(r.err?': '+r.err:'')); b.disabled=false; b.textContent='unlink'; return; }
  location.reload();
});
</script></body></html>`);
  }
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
<div class=nav><a href="/">Sessions</a><a href="/monitor" class=on>Monitor</a><a href="/basecamp">Basecamp</a></div></header>
<div class=gauges id=gauges></div>
<table><thead><tr><th>PID</th><th>Process</th><th>CPU %</th><th>MEM %</th><th>RSS</th></tr></thead><tbody id=procs></tbody></table>
</div>
<script>
const INIT=${JSON.stringify(s)};
const col=(p)=>p<50?'#22c55e':p<80?'#f59e0b':'#ef4444';
function gb(b){return (b/1073741824).toFixed(1);}
function render(d){try{
 const memPct=d.memTotal?d.memUsed/d.memTotal*100:0, swapPct=d.swapTotal?d.swapUsed/d.swapTotal*100:0;
 const diskPct=d.diskTotal?d.diskUsed/(d.diskUsed+d.diskAvail)*100:0;
 document.getElementById('meta').textContent=d.ncpu+' vCPU · up '+fmtUp(d.up)+' · load '+d.load.map(x=>x.toFixed(2)).join(' ');
 document.getElementById('gauges').innerHTML=[
  card('CPU',d.cpu.toFixed(0)+'%',d.cpu,'load '+d.load[0].toFixed(2)+' over '+d.ncpu+' cores'),
  card('Memory',memPct.toFixed(0)+'%',memPct,gb(d.memUsed)+' / '+gb(d.memTotal)+' GB used · '+gb(d.memAvail)+'G free'),
  card('Swap',d.swapTotal?swapPct.toFixed(0)+'%':'—',swapPct,d.swapTotal?(gb(d.swapUsed)+' / '+gb(d.swapTotal)+' GB'):'no swap'),
  card('Disk',d.diskTotal?diskPct.toFixed(0)+'%':'—',diskPct,d.diskTotal?(gb(d.diskUsed)+' / '+gb(d.diskTotal)+' GB used · '+gb(d.diskAvail)+'G free'):'unavailable'),
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
  const multiAcct = accounts().length>1;
  const acctBadge = x => (multiAcct && x.account) ? `<span class="pill acct">${esc(x.account)}</span>` : '';
  const rccard=x=>`<div class="card rc" data-name="${esc(x.name)}"><div class=body onclick="window.open('https://claude.ai/code/${esc(x.bridge)}','_blank')"><div class=row><span class=name>${esc(x.title||x.name)}</span>${acctBadge(x)}<span class="pill rc">RC</span></div><div class=cid>${esc(x.name)}</div><div class=cmd>▶ ${esc(x.cmd)}${x.status?' · '+esc(x.status):''}</div><pre class=preview><span class=e>rc-hosted · not in tmux · opens in claude.ai</span></pre><div class=meta>claude.ai ↗ <a class=vscode href="${CODE}/?folder=${encodeURIComponent(x.cwd||HOMEDIR)}" target=_blank rel=noopener onclick="event.stopPropagation()">‹/› VS Code</a></div></div></div>`;
  const card=x=> x.rc ? rccard(x) : `<div class="card ${x.attached?'on':''}" data-name="${esc(x.name)}" data-cwd="${esc(x.cwd||'')}">${x.canBranch?`<button class=branch title="branch into a worktree" onclick="branchSession('${esc(x.name)}',event)">⑂</button>`:''}<button class=kill title="kill session" onclick="killSession('${esc(x.name)}',event)">✕</button><div class=body onclick="open_('${encodeURIComponent(x.name)}')"><div class=row><span class=name>${esc(x.title||x.name)}</span>${acctBadge(x)}<span class="pill ${x.attached?'live':'idle'}">${x.attached?'LIVE':'idle'}</span></div><div class=cid>${esc(x.name)}</div><div class=cmd>${x.running?'▶':'○'} ${esc(x.cmd||'shell')}</div><pre class=preview>${esc(x.preview)||'<span class=e>— no output yet —</span>'}</pre><div class=meta>${x.wins} win · open ↗ <a class=vscode href="${CODE}/?folder=${encodeURIComponent(x.cwd||HOMEDIR)}" target=_blank rel=noopener onclick="event.stopPropagation()">‹/› VS Code</a>${x.bridge?` · <a class=vscode href="https://claude.ai/code/${esc(x.bridge)}" target=_blank rel=noopener onclick="event.stopPropagation()">claude.ai ↗</a>`:''}</div></div></div>`;
  res.writeHead(200,{'Content-Type':'text/html'});
  res.end(`<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Claude Sessions</title>
<style>${CSS}
.grid{margin-top:22px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{position:relative;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:14px;transition:.15s}
.card:hover{transform:translateY(-3px);border-color:#38bdf8;background:rgba(56,189,248,.08)}
.card.on{border-color:rgba(34,197,94,.45)}.body{display:block;padding:15px 16px;cursor:pointer}
.kill{position:absolute;top:8px;right:8px;z-index:2;width:24px;height:24px;border-radius:7px;border:1px solid rgba(248,113,113,.35);background:rgba(248,113,113,.12);color:#f87171;font-size:12px;cursor:pointer;line-height:1;padding:0}
.kill:hover{background:#ef4444;color:#fff;border-color:#ef4444}
.branch{position:absolute;top:8px;right:38px;z-index:2;width:24px;height:24px;border-radius:7px;border:1px solid rgba(129,140,248,.35);background:rgba(129,140,248,.12);color:#818cf8;font-size:13px;cursor:pointer;line-height:1;padding:0}
.branch:hover{background:#6366f1;color:#fff;border-color:#6366f1}
.row{display:flex;align-items:center;justify-content:space-between;padding-right:26px}
.name{font-weight:650;font-size:15.5px;color:#e2e8f0;line-height:1.3;word-break:break-word}
.cid{margin-top:4px;color:#64748b;font-size:11px;font-family:ui-monospace,Menlo,monospace;word-break:break-word}
.pill{font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:3px 9px;border-radius:999px}
.pill.live{color:#22c55e;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.4)}
.pill.idle{color:#64748b;background:rgba(100,116,139,.12);border:1px solid rgba(100,116,139,.3)}
 .pill.rc{color:#a78bfa;background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.45)}
 .pill.acct{color:#fbbf24;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.4);margin-left:6px}
 .lname .pill.acct{margin-left:8px;vertical-align:middle}
 .card.rc{border-color:rgba(167,139,250,.3)}
.ctitle{margin-top:7px;font-size:15px;font-weight:650;color:#e2e8f0;line-height:1.3;word-break:break-word}.ctitle[hidden]{display:none}
.cmd{margin-top:7px;font-size:12px;color:#7dd3fc;font-family:ui-monospace,Menlo,monospace}
.preview{margin-top:9px;background:rgba(2,6,23,.55);border:1px solid rgba(148,163,184,.12);border-radius:8px;padding:9px 10px;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.5;color:#cbd5e1;white-space:pre-wrap;word-break:break-word;max-height:66px;overflow:hidden}
.preview .e{color:#475569}.meta{margin-top:9px;color:#94a3b8;font-size:11.5px}
 .vscode{margin-left:8px;color:#38bdf8;text-decoration:none;font-weight:600}
 .vscode:hover{text-decoration:underline}
 .viewtoggle{display:inline-flex;border:1px solid rgba(148,163,184,.32);border-radius:10px;overflow:hidden;margin-right:4px}
 .viewbtn{background:transparent;color:#94a3b8;border:0;padding:8px 12px;font-size:12.5px;cursor:pointer}
 .viewbtn.on{background:rgba(56,189,248,.16);color:#7dd3fc}
 .viewbtn+.viewbtn{border-left:1px solid rgba(148,163,184,.32)}
 .ltbl{width:100%;margin-top:22px;border-collapse:collapse;font-size:13px}
 .ltbl th,.ltbl td{text-align:left;padding:10px 12px;border-bottom:1px solid rgba(148,163,184,.14)}
 .ltbl thead th{color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;position:sticky;top:0;background:#0b1220;user-select:none}
 .ltbl th.sortable{cursor:pointer}
 .ltbl th.sortable:hover{color:#e2e8f0}
 .ltbl th.sortable::after{content:'';opacity:.35;margin-left:6px}
 .ltbl th.sortable.asc::after{content:'▲';opacity:.9}
 .ltbl th.sortable.desc::after{content:'▼';opacity:.9}
 .ltbl tbody tr{cursor:pointer}
 .ltbl tbody tr:hover{background:rgba(56,189,248,.07)}
 .lname .lopen{font-weight:640;color:#e2e8f0}
 .lname .lsub{display:block;color:#64748b;font-size:11px;margin-top:2px;font-family:ui-monospace,Menlo,monospace}
 .lrepo{color:#7dd3fc;font-family:ui-monospace,Menlo,monospace}
 .ltbl td.num{color:#cbd5e1;font-variant-numeric:tabular-nums;white-space:nowrap}
 #listwrap{overflow-x:auto}
 .cpuval{font-variant-numeric:tabular-nums}
 .cpuval.mid{color:#fbbf24}
 .cpuval.hi{color:#f87171;font-weight:600}
 .lact{white-space:nowrap;text-align:right}
 .lact .vs{color:#38bdf8;text-decoration:none;font-weight:600;margin-right:10px}
 .lact .lkill{width:24px;height:24px;border-radius:7px;border:1px solid rgba(248,113,113,.35);background:rgba(248,113,113,.12);color:#f87171;font-size:12px;cursor:pointer;padding:0;line-height:1}
 .lact .lkill:hover{background:#ef4444;color:#fff;border-color:#ef4444}
 .lact .lbranch{width:24px;height:24px;border-radius:7px;border:1px solid rgba(129,140,248,.35);background:rgba(129,140,248,.12);color:#818cf8;font-size:13px;cursor:pointer;padding:0;line-height:1}
 .lact .lbranch:hover{background:#6366f1;color:#fff;border-color:#6366f1}
</style></head><body><div class=wrap>
<header><div><h1>🧠 Claude Sessions</h1><span class=sub>${s.length} sessions · refreshes every 4s</span></div>
<div class=nav><a href="/" class=on>Sessions</a><a href="/monitor">📊 Monitor</a><a href="/basecamp">✉️ Basecamp</a><span class=viewtoggle><button class=viewbtn data-v=grid onclick="setView('grid')">▦ Grid</button><button class=viewbtn data-v=list onclick="setView('list')">☰ List</button></span><button class=add onclick=openModal()>+ Session</button></div></header>
<div class=grid id=g>${s.map(card).join('')}</div>
<div id=listwrap style="display:none"><table class=ltbl><thead><tr><th class=sortable data-k=name onclick="setSort('name')">Name</th><th class=sortable data-k=repo onclick="setSort('repo')">Repo</th><th class=sortable data-k=launch onclick="setSort('launch')">Launched</th><th class=sortable data-k=used onclick="setSort('used')">Last used</th><th class=sortable data-k=cpu onclick="setSort('cpu')">CPU</th><th class=sortable data-k=mem onclick="setSort('mem')">Mem</th><th>Status</th><th></th></tr></thead><tbody id=ltbody></tbody></table></div></div>
<div id=modal class=modal hidden onclick="if(event.target===this)closeModal()"><div class=sheet>
<div class=sheettitle>New session</div>
<label class=fld id=m_acctrow style="display:none">Account<select id=m_account></select><span class=fldhint>which Claude login (Max plan) runs this session</span></label>
<label class=fld>Type<select id=m_mode onchange="onModeChange()"><option value="claude">Claude</option><option value="shell">Shell</option><option value="teleport">Teleport (cloud → box)</option></select></label>
<label class=fld id=m_sessrow style="display:none">Cloud session<input id=m_session type=text placeholder="session id or claude.ai/code URL"><span class=fldhint>pull a running cloud session down to this box · pick the matching repo below</span></label>
<label class=fld id=m_reporow>Repo<span class=repowrap><select id=m_repo onchange="syncName()"></select><label class=wtlbl title="isolated git worktree + branch"><input type=checkbox id=m_wt> worktree</label></span></label>
<div class=sheetbtns><button class=ghost onclick="closeModal()">Cancel</button><button class=add onclick="doSpawn()">Launch</button></div>
</div></div>
<div id=bmodal class=modal hidden onclick="if(event.target===this)closeBModal()"><div class=sheet>
<div class=sheettitle>Branch session</div>
<div class=fldhint id=b_ctx style="text-transform:none;letter-spacing:0"></div>
<label class=fld>Session name<input id=b_name type=text oninput="bSync()" spellcheck=false><span class=fldhint>new tmux session · its branch will be <span id=b_br>wt/…</span></span></label>
<label class=fld>Worktree folder<input id=b_wt type=text spellcheck=false oninput="B_WT_TOUCHED=true"><span class=fldhint>created under ~/Code/.worktrees/</span></label>
<label class=fld style="text-transform:none;letter-spacing:0;font-weight:400"><label class=wtlbl><input type=checkbox id=b_wait checked> wait for the parent to finish its current turn</label><span class=fldhint>forking mid-turn copies a half-written transcript</span></label>
<div class=sheetbtns><button class=ghost onclick="closeBModal()">Cancel</button><button class=add id=b_go onclick="doBranch()">Branch</button></div>
</div></div>
<script>
function open_(n){window.open('${TERM}/?arg='+n,'_blank');}
var CODEBASE='${CODE}';
var HOMEBASE='${HOMEDIR}';
var MULTIACCT = ${accounts().length>1};
var DATA = ${JSON.stringify(s).replace(/</g,'\\u003c')};
var VIEW = localStorage.getItem('view')||'grid';
var SORT = localStorage.getItem('sortk')||'used';
var DIR  = localStorage.getItem('sortd')||'desc';
function repoOf(x){var c=x.cwd||'';if(!c)return '';var p=c.split('/').filter(Boolean);return p[p.length-1]||'';}
function fmtAgo(sec){if(!sec)return '—';var d=Date.now()/1000-sec;if(d<0)d=0;if(d<60)return Math.floor(d)+'s';if(d<3600)return Math.floor(d/60)+'m';if(d<86400)return Math.floor(d/3600)+'h';return Math.floor(d/86400)+'d';}
function fmtWhen(sec){if(!sec)return 'unknown';return new Date(sec*1000).toLocaleString();}
function fmtMem(mb){if(!mb)return '—';return mb>=1024?(mb/1024).toFixed(1)+' GB':mb+' MB';}
function fmtCpu(x){if(x.rc)return '—';var p=x.cpu||0;var cls=p>=80?'hi':(p>=25?'mid':'');return '<span class="cpuval '+cls+'">'+p+'%</span>';}
function esc2(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function sortData(a){var k=SORT,dir=DIR==='asc'?1:-1;return a.slice().sort(function(p,q){var x,y;if(k==='name'){x=(p.title||p.name||'').toLowerCase();y=(q.title||q.name||'').toLowerCase();}else if(k==='repo'){x=repoOf(p).toLowerCase();y=repoOf(q).toLowerCase();}else if(k==='launch'){x=p.created||0;y=q.created||0;}else if(k==='cpu'){x=p.cpu||0;y=q.cpu||0;}else if(k==='mem'){x=p.mem||0;y=q.mem||0;}else{x=p.activity||0;y=q.activity||0;}return x<y?-1*dir:(x>y?1*dir:0);});}
function renderList(){var tb=document.getElementById('ltbody');if(!tb)return;var arr=sortData(DATA);tb.innerHTML=arr.map(function(x){var st=x.rc?'RC':(x.attached?'LIVE':'idle');var pc='pill '+(x.rc?'rc':(x.attached?'live':'idle'));return '<tr data-name="'+esc2(x.name)+'" data-cwd="'+esc2(x.cwd||'')+'" data-rc="'+(x.rc?'1':'')+'" data-bridge="'+esc2(x.bridge||'')+'"><td class=lname><span class=lopen>'+esc2(x.title||x.name)+'</span>'+((MULTIACCT&&x.account)?' <span class="pill acct">'+esc2(x.account)+'</span>':'')+'<span class=lsub>'+esc2(x.name)+'</span></td><td class=lrepo>'+esc2(repoOf(x)||'—')+'</td><td class=num title="'+esc2(fmtWhen(x.created))+'">'+fmtAgo(x.created)+'</td><td class=num title="'+esc2(fmtWhen(x.activity))+'">'+fmtAgo(x.activity)+'</td><td class="num cpu">'+fmtCpu(x)+'</td><td class=num>'+fmtMem(x.mem)+'</td><td><span class="'+pc+'">'+st+'</span></td><td class=lact>'+(x.bridge?'<a class=vs href="https://claude.ai/code/'+esc2(x.bridge)+'" target=_blank rel=noopener title="claude.ai">◎</a>':'')+'<a class=vs href="'+CODEBASE+'/?folder='+encodeURIComponent(x.cwd||HOMEBASE)+'" target=_blank rel=noopener title="VS Code">‹/›</a>'+(x.rc?'':((x.canBranch?'<button class=lbranch title="branch into a worktree">⑂</button>':'')+'<button class=lkill title="kill">✕</button>'))+'</td></tr>';}).join('');document.querySelectorAll('th.sortable').forEach(function(th){var k=th.dataset.k;th.classList.remove('asc','desc');if(SORT===k)th.classList.add(DIR);});}
function setView(v){VIEW=v;localStorage.setItem('view',v);var g=document.getElementById('g'),l=document.getElementById('listwrap');if(g)g.style.display=(v==='grid')?'':'none';if(l)l.style.display=(v==='list')?'':'none';document.querySelectorAll('.viewbtn').forEach(function(b){b.classList.toggle('on',b.dataset.v===v);});if(v==='list')renderList();}
function setSort(k){if(SORT===k){DIR=(DIR==='asc')?'desc':'asc';}else{SORT=k;DIR=(k==='name'||k==='repo')?'asc':'desc';}localStorage.setItem('sortk',SORT);localStorage.setItem('sortd',DIR);renderList();}
function killByName(name,cwd,ev,disp){if(ev)ev.stopPropagation();var isWt=(cwd||'').indexOf('/.worktrees/')>=0;if(!confirm('Kill session "'+(disp||name)+'"?'))return;var wt=0;if(isWt){wt=confirm('This session runs in a git worktree:\\n'+cwd+'\\n\\nAlso remove the worktree and its branch?\\nUncommitted changes there will be lost.')?1:0;}var url='/api/kill?name='+encodeURIComponent(name);if(wt)url+='&worktree=1&cwd='+encodeURIComponent(cwd);fetch(url,{method:'POST'});DATA=DATA.filter(function(z){return z.name!==name;});var c=document.querySelector('.card[data-name="'+CSS.escape(name)+'"]');if(c)c.remove();renderList();}
function openModal(){document.getElementById('modal').hidden=false;onModeChange();}
function onModeChange(){var mo=document.getElementById('m_mode').value;var row=document.getElementById('m_sessrow');if(row)row.style.display=(mo==='teleport')?'':'none';var rr=document.getElementById('m_reporow');if(rr)rr.style.display=(mo==='teleport')?'none':'';var wl=document.querySelector('.wtlbl');if(wl)wl.style.display=(mo==='teleport')?'none':'';}
function closeModal(){document.getElementById('modal').hidden=true;}
function syncName(){}
async function loadRepos(){try{const r=await(await fetch('/api/repos')).json();const sel=document.getElementById('m_repo');if(sel){sel.innerHTML=r.map(x=>'<option value="'+x.path+'">'+x.name+'</option>').join('');syncName();}}catch(e){}}
loadRepos();
async function loadAccounts(){try{const a=await(await fetch('/api/accounts')).json();const sel=document.getElementById('m_account');const row=document.getElementById('m_acctrow');if(sel){sel.innerHTML=a.map(function(x){return '<option value="'+x.id+'">'+x.label+'</option>';}).join('');}if(row)row.style.display=(a.length>1)?'':'none';}catch(e){}}
loadAccounts();
async function pollBridge(name){for(var i=0;i<14;i++){try{var j=await(await fetch('/api/bridge?name='+encodeURIComponent(name))).json();if(j.bridge)return j.bridge;}catch(e){}await new Promise(function(r){setTimeout(r,1500);});}return null;}
async function doSpawn(){var mode=document.getElementById('m_mode').value;var repo=document.getElementById('m_repo').value;if(mode!=='teleport'&&!repo){alert('No repo found under ~/Code');return;}var wt=(mode==='teleport')?0:(document.getElementById('m_wt').checked?1:0);var session='';if(mode==='teleport'){session=(document.getElementById('m_session').value||'').trim();if(!session){alert('Paste the cloud session id or claude.ai/code URL to teleport');return;}}var win=(mode==='claude'||mode==='teleport')?window.open('about:blank','_blank'):null;if(win){try{win.document.write('<title>Launching…</title><body style="font:16px system-ui;padding:2rem;color:#334155">Launching…</body>');}catch(e){}}var account=((document.getElementById('m_account')||{}).value)||'primary';var q='/api/spawn?repo='+encodeURIComponent(repo)+'&mode='+mode+'&worktree='+wt+'&account='+encodeURIComponent(account)+(session?('&session='+encodeURIComponent(session)):'');var r=await(await fetch(q,{method:'POST'})).json();if(!r.ok){if(win)win.close();alert('Could not start session'+(r.err?': '+r.err:''));return;}if(win){var nm=r.name||'';if(mode==='claude'&&account==='primary'){var b=await pollBridge(nm);win.location=b?('https://claude.ai/code/'+b):('${TERM}/?arg='+encodeURIComponent(nm));}else{win.location='${TERM}/?arg='+encodeURIComponent(nm);}}closeModal();setTimeout(function(){location.reload();},1200);}
var B_PARENT='', B_WT_TOUCHED=false;
function closeBModal(){document.getElementById('bmodal').hidden=true;}
function bSync(){var n=(document.getElementById('b_name').value||'').trim();
 document.getElementById('b_br').textContent='wt/'+(n||'…');
 if(!B_WT_TOUCHED){var repo=(document.getElementById('bmodal').dataset.repo||'');
  var suffix=n.indexOf(repo+'-')===0?n.slice(repo.length+1):n;
  document.getElementById('b_wt').value=repo+'__'+(suffix||'b');}}
async function branchSession(n,e){if(e)e.stopPropagation();
 var d=await(await fetch('/api/branchinfo?name='+encodeURIComponent(n))).json();
 if(!d.ok){alert('Cannot branch '+n+(d.err?': '+d.err:''));return;}
 B_PARENT=n;B_WT_TOUCHED=false;
 var m=document.getElementById('bmodal');m.dataset.repo=d.repoName;
 document.getElementById('b_ctx').innerHTML='from <b>'+esc2(n)+'</b> \u00b7 repo <b>'+esc2(d.repoName)+'</b> on <b>'+esc2(d.pbranch||'?')+'</b>'
  +(d.dirty?' \u00b7 <span style="color:#fbbf24">uncommitted changes stay with the parent</span>':'')
  +(d.status==='busy'?' \u00b7 <span style="color:#fbbf24">busy right now</span>':'')
  +(d.hasConvo?'':' \u00b7 <span style="color:#fbbf24">no conversation to fork</span>');
 document.getElementById('b_name').value=d.name;document.getElementById('b_wt').value=d.wt;
 document.getElementById('b_br').textContent=d.branch;
 document.getElementById('b_go').textContent='Branch';document.getElementById('b_go').disabled=false;
 m.hidden=false;document.getElementById('b_name').focus();}
async function doBranch(){var as=(document.getElementById('b_name').value||'').trim();
 var wt=(document.getElementById('b_wt').value||'').trim();
 var wait=document.getElementById('b_wait').checked?1:0;
 if(!as){alert('Give the new session a name');return;}
 var go=document.getElementById('b_go');go.disabled=true;
 go.textContent=wait?'Waiting for parent\u2026':'Branching\u2026';
 var q='/api/branch?name='+encodeURIComponent(B_PARENT)+'&as='+encodeURIComponent(as)+'&wt='+encodeURIComponent(wt)+'&wait='+wait;
 var r=await(await fetch(q,{method:'POST'})).json();
 if(!r.ok){go.disabled=false;go.textContent='Branch';alert('Could not branch'+(r.err?': '+r.err:''));return;}
 closeBModal();
 setTimeout(function(){location.reload();},1200);}
async function killSession(n,e){e.stopPropagation();const c=document.querySelector('.card[data-name="'+CSS.escape(n)+'"]');const cwd=c?(c.dataset.cwd||''):'';const disp=(c&&c.querySelector('.name'))?c.querySelector('.name').textContent.trim():n;const isWt=cwd.indexOf('/.worktrees/')>=0;if(!confirm('Kill session "'+disp+'"?'))return;let wt=0;if(isWt){wt=confirm('This session runs in a git worktree:\\n'+cwd+'\\n\\nAlso remove the worktree and its branch?\\nUncommitted changes there will be lost.')?1:0;}let url='/api/kill?name='+encodeURIComponent(n);if(wt)url+='&worktree=1&cwd='+encodeURIComponent(cwd);await fetch(url,{method:'POST'});if(c)c.remove();}
async function tick(){try{const d=await(await fetch('/api/sessions')).json();DATA=d;
 if(VIEW==='list'){renderList();return;}
 if(d.length!==document.querySelectorAll('.card').length){location.reload();return;}
 d.forEach(x=>{const c=document.querySelector('.card[data-name="'+CSS.escape(x.name)+'"]');if(!c||x.rc)return;const p=c.querySelector('.pill');p.className='pill '+(x.attached?'live':'idle');p.textContent=x.attached?'LIVE':'idle';c.classList.toggle('on',x.attached);c.querySelector('.name').textContent=x.title||x.name;c.querySelector('.cmd').textContent=(x.running?'▶ ':'○ ')+(x.cmd||'shell');c.querySelector('.preview').textContent=x.preview||'— no output yet —';});
}catch(e){}}
setInterval(tick,4000);
(function(){var tb=document.getElementById('ltbody');if(tb){tb.addEventListener('click',function(e){var tr=e.target.closest('tr');if(!tr)return;var name=tr.dataset.name;if(e.target.closest('.lkill')){killByName(name,tr.dataset.cwd,e,((tr.querySelector('.lopen')||{}).textContent||name).trim());return;}if(e.target.closest('.lbranch')){branchSession(name,e);return;}if(e.target.closest('.vs'))return;if(tr.dataset.rc){window.open('https://claude.ai/code/'+tr.dataset.bridge,'_blank');}else{open_(encodeURIComponent(name));}});}setView(VIEW);})();
</script></body></html>`);
}).listen(PORT,'127.0.0.1',()=>console.log('dashboard on '+PORT));
