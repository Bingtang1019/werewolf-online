
const elements = new Map();
function mkEl(id) { return { id, value:'', textContent:'', innerHTML:'', className:'', style:{}, classList:{add(){},remove(){},contains(){return false},toggle(){}}, dataset:{}, addEventListener(t,f){(this._ls=this._ls||{})[t]=f;}, removeEventListener(){}, appendChild(){}, removeChild(){}, setAttribute(){}, getAttribute(){return null}, querySelector(){return null}, querySelectorAll(){return []}, closest(){return null}, focus(){}, click(){}, _ls:{} }; }
globalThis.document = { getElementById(id){ if(!elements.has(id)) elements.set(id,mkEl(id)); return elements.get(id); }, createElement(){ return mkEl('x'); }, addEventListener(){}, querySelector(){return null}, querySelectorAll(){return []}, body:mkEl('b'), head:mkEl('h'), documentElement:mkEl('d') };
globalThis.window = globalThis;
globalThis.location = { href:'http://localhost:3000/', origin:'http://localhost:3000', protocol:'http:', host:'localhost:3000', hostname:'localhost', port:'3000', pathname:'/', search:'', hash:'' };
globalThis.localStorage = { _d:{}, getItem(k){return this._d[k]??null}, setItem(k,v){this._d[k]=String(v)}, removeItem(k){delete this._d[k]} };
globalThis.navigator = { userAgent:'m', language:'zh', clipboard:{writeText(){return Promise.resolve()}}, sendBeacon(){return true}, onLine:true, mediaDevices:{}, vibrate(){} };
globalThis.fetch = (u) => String(u).includes('playlist') ? Promise.resolve({ok:true,json:()=>Promise.resolve([])}) : Promise.resolve({ok:false,json:()=>Promise.resolve({})});
globalThis.Audio = function(){ this.play=()=>Promise.resolve(); this.pause=()=>{}; this.load=()=>{}; this.src=''; this.volume=1; this.currentTime=0; this.duration=0; this.addEventListener=()=>{}; this.muted=false; this.loop=false; };
globalThis.Notification = function(){}; Notification.requestPermission = ()=>Promise.resolve('denied');
globalThis.setInterval = ()=>1; globalThis.clearInterval = ()=>{}; globalThis.setTimeout = ()=>1; globalThis.clearTimeout = ()=>{};
globalThis.requestAnimationFrame = ()=>1;
globalThis.performance = { now:()=>Date.now() };
globalThis.confirm = ()=>true; globalThis.alert = ()=>{}; globalThis.prompt = ()=>null;
globalThis.matchMedia = ()=>({matches:false,addEventListener(){}});
globalThis.EventSource = function(){ this.addEventListener=()=>{}; this.close=()=>{}; };
