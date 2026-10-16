import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
await build({ entryPoints:['../../../../src/renderer/hooks/useArpEngine.ts'], bundle:true, format:'esm', outfile:'.engine.mjs', platform:'node',
  alias:{ react: './react-stub.mjs' }, logLevel:'error' });
// virtual clock
let now=0; const q=[]; let seq=0;
globalThis.setTimeout=(fn,ms)=>{const id=++seq;q.push({id,t:now+(ms||0),fn});return id;};
globalThis.clearTimeout=(id)=>{const k=q.findIndex(x=>x.id===id);if(k>=0)q.splice(k,1);};
const advance=(ms)=>{const end=now+ms;for(;;){q.sort((a,b)=>a.t-b.t);if(!q.length||q[0].t>end)break;const e=q.shift();now=e.t;e.fn();}now=end;};
const stub=await import('./react-stub.mjs'); const { useArpEngine } = await import('./.engine.mjs');
const active=new Set(); const log=[];
const on=(n)=>{active.add(n);log.push([Math.round(now),'on',n]);}; const off=(n)=>{active.delete(n);log.push([Math.round(now),'off',n]);};
const lanes=Array.from({length:16},()=>({on:true,velocity:.9,gate:.6,octave:0,semitone:0}));
const cfg=(o)=>({on:true,mode:'up',rateHz:8,octaves:1,gate:.6,hold:false,keySnap:false,keyRoot:0,keyScale:'major',seq:{enabled:false,steps:4,lanes},...o});
const held=new Set([60,64,67]);
let c=cfg({}); const render=()=>{globalThis.__reset();useArpEngine(held,c,on,off);};
render(); advance(1000);
c=cfg({seq:{enabled:true,steps:4,lanes}}); render(); advance(1000);
c=cfg({on:false,seq:{enabled:true,steps:4,lanes}}); render(); advance(1000);
console.log('active after off:',[...active]);
// timing of seq: intervals between ons
c=cfg({on:true,seq:{enabled:true,steps:4,lanes}}); render(); log.length=0; advance(2000);
const ons=log.filter(l=>l[1]==='on').map(l=>l[0]); console.log('seq on-times', ons.slice(0,10).join(','), 'intervals', ons.slice(1,10).map((t,i)=>t-ons[i]).join(','));
// seq with some off steps
const l2=lanes.map((l,i)=>({...l,on:i%2===0})); c=cfg({seq:{enabled:true,steps:4,lanes:l2}}); render(); log.length=0; advance(2000);
const ons2=log.filter(l=>l[1]==='on').map(l=>l[0]); console.log('half-rest on-times', ons2.slice(0,8).join(','));
console.log('active end:',[...active]);
