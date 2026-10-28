export function terms(text){const s=String(text||'').normalize('NFKC').toLowerCase();const words=s.match(/[a-z0-9]{2,}/g)||[];for(const run of s.match(/[\u3400-\u9fff]+/g)||[])for(let i=0;i<run.length-1;i++)words.push(run.slice(i,i+2));return new Set(words);}
export function retrieve(store,zoneId,question){
 const q=terms(question);if(!q.size)return [];
 return store.list('knowledge').filter(x=>x.enabled!==false&&(x.zoneId===zoneId||x.zoneId==='*')).map(doc=>{
  const body=terms(doc.title+' '+doc.body);const title=terms(doc.title);let score=0;for(const term of q){if(body.has(term))score+=1;if(title.has(term))score+=1.5;}
  const coverage=score/q.size;return {...doc,score,coverage};
 }).filter(x=>x.score>=1.5&&x.coverage>=.2).sort((a,b)=>b.score-a.score).slice(0,4).map(x=>({id:x.id,title:x.title,body:x.body.slice(0,7000),score:x.score}));
}
