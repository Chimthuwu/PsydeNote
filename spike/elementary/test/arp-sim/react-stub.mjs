const refs=[];let i=0;
export const useRef=(v)=>{ if(!refs[i]) refs[i]={current:v}; return refs[i++]; };
export const useEffect=(fn)=>{ if(!globalThis.__effectRan){ globalThis.__effectRan=true; globalThis.__cleanup=fn(); } };
export const __reset=()=>{i=0;};
globalThis.__reset=()=>{i=0;};
