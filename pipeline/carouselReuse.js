const general = x => x == null || x === "" || x === "General" || x === "general";
const time = x => { if (x?.toMillis) return x.toMillis(); if (x?.toDate) return x.toDate().getTime(); if (x instanceof Date) return x.getTime(); if (typeof x === "number") return x; if (typeof x === "string") return Date.parse(x); return NaN; };
const slides = c => Array.isArray(c?.slides) ? c.slides : [];
const validUrl = bg => typeof bg?.url === "string" && bg.url.trim() !== "";
const safe = x => typeof x === "string" ? x : "";
const eligible = (c,t) => c && c.projectId === "ttchop2" && t.projectId === "ttchop2" && c.userId === t.userId && (general(c.accountId) ? general(t.accountId) : c.accountId === t.accountId) && Number.isFinite(time(c.createdAt)) && Number.isFinite(time(t.createdAt)) && time(c.createdAt) < time(t.createdAt);
export async function matchCarouselBackgrounds({targetCarousel,targetSlides,trustedCandidates,callLLMJson,getCarousel}) {
  const ordered = [...targetSlides].sort((a,b) => a.index-b.index);
  const allUnmatched = () => ordered.map(s => s.index);
  const candidates = (Array.isArray(trustedCandidates) ? trustedCandidates : []).filter(c => c?.id !== targetCarousel.id && eligible(c,targetCarousel) && slides(c).some(s => s?.bg?.status === "done" && validUrl(s.bg)));
  if (!candidates.length) return {matches:[],unmatchedSlideIndices:allUnmatched()};
  const metadata = {destination:{language:targetCarousel.language ?? null,caption:safe(targetCarousel.caption),slides:ordered.map(({index,text,imagePrompt})=>({index,text:safe(text),imagePrompt:safe(imagePrompt)}))},candidates:candidates.map(c=>({id:c.id,language:c.language ?? null,caption:safe(c.caption),slides:slides(c).filter(s=>s?.bg?.status === "done" && validUrl(s.bg)).map(s=>({carouselId:c.id,slideIndex:s.index,text:safe(s.text),imagePrompt:safe(s.imagePrompt),scriptTemplateTitle:safe(c.scriptTemplate?.title),styleTemplateTitle:safe(c.styleTemplate?.title),language:c.language ?? null,caption:safe(c.caption),imageTaskPrompt:safe(c.imageTaskPrompts?.[s.bg.taskId]?.prompt)}))}))};
  const fail = () => ({matches:[],unmatchedSlideIndices:allUnmatched()});
  let result;
  try { result=await callLLMJson({system:"Return ONLY JSON {matches:[{targetSlideIndex,sourceCarouselId,sourceSlideIndex}]}; select semantic matches only.",user:JSON.stringify(metadata)}); if(typeof result === "string") result=JSON.parse(result); } catch { return fail(); }
  if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 1 || !Array.isArray(result.matches)) return fail();
  const targetSet=new Set(ordered.map(s=>s.index)), candidateMap=new Map(candidates.map(c=>[c.id,c])), seen=new Set();
  for(const m of result.matches){
    if(!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).length!==3 || !Number.isInteger(m.targetSlideIndex) || !Number.isInteger(m.sourceSlideIndex) || typeof m.sourceCarouselId!=="string" || !targetSet.has(m.targetSlideIndex) || seen.has(m.targetSlideIndex)) return fail();
    const c=candidateMap.get(m.sourceCarouselId);
    if(!c || !slides(c).some(s=>s.index===m.sourceSlideIndex && s?.bg?.status==="done" && validUrl(s.bg))) return fail();
    seen.add(m.targetSlideIndex);
  }
  const matches=[];
  for(const m of result.matches){
    let fresh; try { fresh=await getCarousel("ttchop2",m.sourceCarouselId); } catch { continue; }
    if(!eligible(fresh,targetCarousel)) continue;
    const s=slides(fresh).find(x=>x.index===m.sourceSlideIndex);
    if(!s || s.bg?.status!=="done" || !validUrl(s.bg)) continue;
    matches.push({targetSlideIndex:m.targetSlideIndex,sourceCarouselId:fresh.id,sourceSlideIndex:s.index,url:s.bg.url,...(typeof s.bg.storagePath==="string" ? {storagePath:s.bg.storagePath} : {})});
  }
  const done=new Set(matches.map(m=>m.targetSlideIndex));
  return {matches,unmatchedSlideIndices:ordered.filter(s=>!done.has(s.index)).map(s=>s.index)};
}
