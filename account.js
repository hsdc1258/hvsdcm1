(() => {
  'use strict';
  const script=document.currentScript, app=script?.dataset.app, storageKey=script?.dataset.key;
  const API=localStorage.getItem('hvsdcm.api')||'https://hvsdcm-api.hvsdcm1.workers.dev';
  const token=localStorage.getItem('hvsdcm.token');
  const headers=()=>({'content-type':'application/json','authorization':'Bearer '+(localStorage.getItem('hvsdcm.token')||'')});
  if(!app||!storageKey)return;
  if(!token){location.replace('/?login=1&next='+encodeURIComponent(location.pathname));return}
  let syncing=false,timer=0;
  const originalSet=Storage.prototype.setItem,originalRemove=Storage.prototype.removeItem;
  async function api(path,options={}){
    const res=await fetch(API+path,{...options,headers:{...headers(),...(options.headers||{})}});
    if(res.status===401){localStorage.removeItem('hvsdcm.token');location.replace('/?login=1&next='+encodeURIComponent(location.pathname));throw new Error('unauthorized')}
    if(!res.ok)throw new Error((await res.json().catch(()=>({}))).error||'sync failed');
    return res.json();
  }
  function aliases(data){const out=[];for(const [questionId,values] of Object.entries(data?.customAliases||{}))for(const answer of Array.isArray(values)?values:[])out.push({questionId,answer});return out}
  async function push(raw){if(syncing)return;try{const data=JSON.parse(raw);await api('/api/progress/'+app,{method:'PUT',body:JSON.stringify({data})});await Promise.all(aliases(data).map(x=>api('/api/answers/accept',{method:'POST',body:JSON.stringify({app,...x})})))}catch(e){if(e.message!=='unauthorized')console.warn('Account sync delayed')}}
  Storage.prototype.setItem=function(key,value){originalSet.call(this,key,value);if(this===localStorage&&key===storageKey){clearTimeout(timer);timer=setTimeout(()=>push(value),350)}};
  Storage.prototype.removeItem=function(key){originalRemove.call(this,key);if(this===localStorage&&key===storageKey){clearTimeout(timer);timer=setTimeout(()=>push('{}'),350)}};
  window.HvsAccount={api,app};
  (async()=>{
    try{
      const [remote,shared]=await Promise.all([api('/api/progress/'+app),api('/api/answers/'+app)]);
      let data=remote.data;
      if(!data){const local=localStorage.getItem(storageKey);data=local?JSON.parse(local):null;if(data)await api('/api/progress/'+app,{method:'PUT',body:JSON.stringify({data})})}
      if(data){data.customAliases||={};for(const row of shared.answers||[]){const list=data.customAliases[row.question_id]||=[];if(!list.includes(row.display_answer))list.push(row.display_answer)}
        const next=JSON.stringify(data);if(localStorage.getItem(storageKey)!==next){syncing=true;originalSet.call(localStorage,storageKey,next);syncing=false;if(!sessionStorage.getItem('hvsdcm.loaded.'+app)){sessionStorage.setItem('hvsdcm.loaded.'+app,'1');location.reload()}}}
      document.documentElement.dataset.accountReady='true';
    }catch(e){console.warn('Using cached study data')}
  })();
})();
