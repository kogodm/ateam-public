/** Self-contained HTML for the relay's own two pages (login + host picker),
 *  styled to match the desktop's LAN login page. Everything the device serves
 *  afterwards comes through the tunnel, untouched. */
const SHELL_CSS = `
html,body{margin:0;height:100%;background:#101014;color:#e8e8ec;font:15px/1.5 -apple-system,'Segoe UI',sans-serif}
.wrap{display:flex;align-items:center;justify-content:center;min-height:100%;padding:24px;box-sizing:border-box}
.card{background:#17171d;border:1px solid #2a2a33;border-radius:12px;padding:28px;width:340px;display:flex;flex-direction:column;gap:12px}
h1{font-size:17px;margin:0 0 4px;font-weight:600}h1 span{opacity:.55;font-weight:400}
input{background:#101014;border:1px solid #33333d;border-radius:8px;color:inherit;padding:10px 12px;font-size:15px;outline:none}
input:focus{border-color:#5a5af0}
button{background:#5a5af0;border:0;border-radius:8px;color:#fff;padding:10px;font-size:15px;cursor:pointer}
button:disabled{opacity:.5}
button.ghost{background:transparent;border:1px solid #33333d;color:#9a9aa5;font-size:13px;padding:7px}
.err{color:#ff7676;font-size:13px;min-height:18px;margin:0}
.muted{color:#9a9aa5;font-size:13px}
.dev{display:flex;align-items:center;gap:12px;background:#101014;border:1px solid #33333d;border-radius:10px;padding:12px 14px;cursor:pointer;text-align:left;color:inherit;font-size:15px;transition:border-color .12s}
.dev:hover{border-color:#5a5af0}
.dev .dot{width:9px;height:9px;border-radius:50%;background:#3a3a44;flex:none}
.dev.on .dot{background:#5ed188;box-shadow:0 0 6px rgba(94,209,136,.6)}
.dev .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dev .ls{font-size:12px;color:#9a9aa5;flex:none}
`;

export const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ateam relay</title><style>${SHELL_CSS}</style></head><body><div class="wrap">
<form class="card" id="f"><h1>◇ ATEAM <span>· relay</span></h1>
<input id="e" type="email" placeholder="Email" autocomplete="username" autofocus>
<input id="p" type="password" placeholder="Password" autocomplete="current-password">
<button id="b" type="submit">Sign in</button><p class="err" id="err"></p>
<p class="muted">Devices are registered from the Ateam desktop app (Settings → Remote → Remote access).</p>
</form></div><script>
const f=document.getElementById('f'),e=document.getElementById('e'),p=document.getElementById('p'),b=document.getElementById('b'),err=document.getElementById('err');
f.addEventListener('submit',async(ev)=>{ev.preventDefault();b.disabled=true;err.textContent='';
try{const r=await fetch('/relay/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e.value,password:p.value})});
if(r.ok){location.replace('/');return}
err.textContent=r.status===429?'Too many attempts — wait 30s':'Wrong email or password';
}catch{err.textContent='Network error'}
b.disabled=false});
</script></body></html>`;

export const PICKER_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ateam — pick a host</title><style>${SHELL_CSS}</style></head><body><div class="wrap">
<div class="card"><h1>◇ ATEAM <span>· your machines</span></h1>
<div id="list" style="display:flex;flex-direction:column;gap:8px"><p class="muted">loading…</p></div>
<button class="ghost" id="lo" type="button">Sign out</button>
</div></div><script>
const ago=(iso)=>{if(!iso)return'';const s=(Date.now()-Date.parse(iso))/1e3;
return s<90?'just now':s<5400?Math.round(s/60)+'m ago':s<129600?Math.round(s/3600)+'h ago':Math.round(s/86400)+'d ago'};
async function load(){
const r=await fetch('/relay/api/devices');if(!r.ok){location.replace('/relay/login');return}
const {devices}=await r.json();const list=document.getElementById('list');list.innerHTML='';
if(!devices.length){list.innerHTML='<p class="muted">No devices yet — register one from the Ateam desktop app (Settings → Remote → Remote access).</p>';return}
for(const d of devices){const b=document.createElement('button');b.className='dev'+(d.online?' on':'');
b.innerHTML='<span class="dot"></span><span class="nm"></span><span class="ls"></span>';
b.querySelector('.nm').textContent=d.name;
b.querySelector('.ls').textContent=d.online?'online':(d.lastSeenAt?ago(d.lastSeenAt):'never seen');
b.addEventListener('click',async()=>{const p=await fetch('/relay/api/pick',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:d.id})});
if(p.ok)location.replace('/')});
list.appendChild(b)}
}
document.getElementById('lo').addEventListener('click',async()=>{await fetch('/relay/api/logout',{method:'POST'});location.replace('/relay/login')});
load();setInterval(load,5000);
</script></body></html>`;

/** The device is reachable but the relay could not sign the client in to it,
 *  so we answer INSTEAD of proxying. Proxying here would surface the device's
 *  own LAN password page, which has no way back to the machine picker — on a
 *  home-screen app with no address bar that strands the user on one machine
 *  and cuts off every other machine they own. */
export const NO_SSO_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ateam</title><style>${SHELL_CSS}</style></head><body><div class="wrap">
<div class="card" style="text-align:center"><h1 style="text-align:center">◇ ATEAM</h1>
<p class="muted">This machine did not hand over a sign-in pass, so we can't let you<br>
straight in. Restart Ateam on it (and make sure only ONE copy is running),<br>
then try again.</p>
<button class="ghost" onclick="location.replace(location.pathname)">Try again</button>
<button class="ghost" onclick="fetch('/relay/api/pick',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(()=>location.replace('/'))">← Pick another machine</button>
</div></div></body></html>`;

/** The preview port was opened without picking a server first (or the pick
 *  expired with an app restart, which clears every approval on purpose). */
export const NO_PREVIEW_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ateam</title><style>${SHELL_CSS}</style></head><body><div class="wrap">
<div class="card" style="text-align:center"><h1 style="text-align:center">◇ ATEAM</h1>
<p class="muted">No local server is shared right now.<br>
Open Ateam, pick one under Preview, then come back.</p>
<button class="ghost" onclick="location.reload()">Try again</button>
</div></div></body></html>`;

/** Every channel to this device is in use. Saying "not connected" here was a
 *  lie the user could not act on — the machine is up, it is the tunnel that is
 *  full, and that is a different thing to do something about. */
export const BUSY_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ateam</title><style>${SHELL_CSS}</style></head><body><div class="wrap">
<div class="card" style="text-align:center"><h1 style="text-align:center">◇ ATEAM</h1>
<p class="muted">This machine is connected, but every tunnel channel is in
use.<br>Give it a moment, or reload.</p>
<button class="ghost" onclick="location.reload()">Reload</button>
<button class="ghost" onclick="fetch('/relay/api/pick',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(()=>location.replace('/'))">← Pick another machine</button>
</div></div></body></html>`;

export const OFFLINE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ateam</title><style>${SHELL_CSS}</style></head><body><div class="wrap">
<div class="card" style="text-align:center"><h1 style="text-align:center">◇ ATEAM</h1>
<p class="muted">This machine is not connected to the relay right now.<br>Open Ateam on it — the tunnel reconnects by itself.</p>
<button class="ghost" onclick="fetch('/relay/api/pick',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(()=>location.replace('/'))">← Pick another machine</button>
</div></div></body></html>`;
