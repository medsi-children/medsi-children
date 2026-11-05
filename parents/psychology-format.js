(function(){
  const META=[['тема групповой психотерапии','Тема групповой психотерапии'],['тема','Тема групповой психотерапии'],['цель групповой психотерапии','Цель групповой психотерапии'],['цель','Цель групповой психотерапии'],['возрастная категория','Возрастная категория'],['начало группы','Начало группы']];
  const SECTIONS=[['начало','Начало'],['вводная часть','Вводная часть'],['разогрев','Разогрев'],['интерактивная часть','Интерактивная часть'],['основная часть','Основная часть'],['практическое упражнение','Практическое упражнение'],['заключительная часть','Заключительная часть'],['заключение','Заключение'],['выводы','Выводы'],['рефлексия','Рефлексия'],['в завершении','В завершении'],['завершение','Завершение']];
  const ARROW=' [[ARROW]] ';
  function cap(v){const s=String(v||'').replace(/\s*\[\[ARROW\]\]\s*/g,' ').replace(/[ \t]{2,}/g,' ').trim();if(!s)return'';const m=s.match(/[A-Za-zА-Яа-яЁё]/);if(!m)return s;const i=m.index;return s.slice(0,i)+s[i].toLocaleUpperCase('ru-RU')+s.slice(i+1)}
  function stripEmoji(v){return String(v||'').replace(/[\u2600-\u27BF]/g,'').replace(/[\uD83C-\uDBFF][\uDC00-\uDFFF]/g,'').replace(/[\uFE0F\u200D]/g,'').replace(/[ \t]{2,}/g,' ').trim()}
  function normalize(v){return stripEmoji(String(v||'').replace(/\r\n?/g,'\n').replace(/➡️?/g,ARROW).replace(/([1-9])️⃣/g,'$1.').replace(/[➀➊①]/g,'1.').replace(/[➁➋②]/g,'2.').replace(/[➂➌③]/g,'3.').replace(/[➃➍④]/g,'4.').replace(/[➄➎⑤]/g,'5.').replace(/[➅➏⑥]/g,'6.').replace(/[➆➐⑦]/g,'7.').replace(/[➇➑⑧]/g,'8.').replace(/[➈➒⑨]/g,'9.')).replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim()}
  function canonical(list,v){const low=String(v||'').trim().toLocaleLowerCase('ru-RU');for(const p of list)if(low===p[0])return p[1];return cap(v)}
  function stripSectionMarker(v){return String(v||'').replace(/^\s*(?:[•·∙▪◦‣]+|[1-9]?[.)])\s+(?=(?:Начало|Вводная часть|Разогрев|Интерактивная часть|Основная часть|Практическое упражнение|Заключительная часть|Выводы|Рефлексия|В завершении|Завершение)(?:\s|$|[:.,]))/i,'')}
  function stripBodyNoise(v){return String(v||'').replace(/^\s*[.·∙•]+\s*/,'').trim()}
  function insertBreaks(v){
    const metaBroken=String(v||'').replace(/\s*(ТЕМА(?: групповой психотерапии)?|ЦЕЛЬ(?: групповой психотерапии)?|Возрастная категория|Начало группы)\s*:/gi,'\n\n$1:');
    return metaBroken.split(/\n\s*\n+/).map(chunk=>{
      const clean=chunk.trim();
      if(/^ТЕМА(?: групповой психотерапии)?\s*:/i.test(clean))return clean;
      return clean.replace(/([.!?])\s+(Заключение)\s*[.:]\s*/g,'$1\n\n$2: ').replace(/\s*(ЧАСТЬ\s+[1-9])\s*:?\s*/gi,'\n\n$1: ').replace(/\s+([1-9])[.)]\s+(?=[А-ЯЁ])/g,'\n\n$1. ').replace(/\s*((?:[1-9][.)]\s*)?)(НАЧАЛО|Начало|Вводная часть|РАЗОГРЕВ|Разогрев|Интерактивная часть|Основная часть|Практическое упражнение|Заключительная часть|Заключение|Выводы|Рефлексия|В завершении|Завершение)\s*:/gi,'\n\n$1$2:').trim();
    }).filter(Boolean).join('\n\n').replace(/^\s+/,'').replace(/\n{3,}/g,'\n\n')
  }
  function bodyParts(v){const text=stripBodyNoise(stripSectionMarker(String(v||'').trim()));if(!text)return[];const raw=text.split('[[ARROW]]').map(x=>stripBodyNoise(stripSectionMarker(x.trim()))).filter(Boolean);if(raw.length===1){const enhanced=plainParts(raw[0]);if(enhanced.some(part=>part.type==='list'||part.type==='heading'))return enhanced;return[{type:'p',text:cap(raw[0])}];}const out=[];if(!text.startsWith('[[ARROW]]')&&raw.length)out.push({type:'p',text:cap(raw.shift())});const short=raw.length>1&&raw.every(x=>x.length<=110&&!/[.!?][\s\S]{45,}/.test(x));if(short){out.push({type:'list',items:raw.map(cap)});return out}raw.forEach(x=>{const m=x.match(/^(Выполнение техники|Практическое упражнение|Упражнение\s+[^:]{1,70}|В завершении|Обратная связь)\s*:?\s*([\s\S]*)$/i);if(m&&m[2].trim())out.push({type:'sub',title:cap(m[1]),text:cap(m[2])});else out.push({type:'p',text:cap(x)})});return out}
  function splitNumberedHeading(v){
    const text=stripBodyNoise(String(v||'').trim());
    if(!text)return{title:'Этап занятия',body:''};
    const m=text.match(/^(.{2,120}?)(?::\s*|[.!?]\s+)([\s\S]*)$/);
    if(m)return{title:cap(m[1]),body:m[2].trim()};
    if(text.length<=90)return{title:cap(text),body:''};
    return{title:'Этап занятия',body:text}
  }
  function parse(v){const chunks=insertBreaks(normalize(v)).split(/\n\s*\n+/).map(x=>x.trim()).filter(Boolean);const meta=[],sections=[],tail=[];let current=null;chunks.forEach(chunk=>{let m=chunk.match(/^(ТЕМА(?: групповой психотерапии)?|ЦЕЛЬ(?: групповой психотерапии)?|Возрастная категория|Начало группы)\s*:\s*([\s\S]*)$/i);if(m){meta.push({title:canonical(META,m[1]),body:cap(m[2])});current=null;return}m=chunk.match(/^Часть\s+([1-9])\s*:?\s*([\s\S]*)$/i);if(m){current={number:m[1],title:'Часть',parts:bodyParts(m[2])};sections.push(current);return}m=chunk.match(/^(?:([1-9])[.)]\s*)?(НАЧАЛО|Начало|Вводная часть|РАЗОГРЕВ|Разогрев|Интерактивная часть|Основная часть|Практическое упражнение|Заключительная часть|Заключение|Выводы|Рефлексия|В завершении|Завершение)\s*[:.]?\s*([\s\S]*)$/i);if(m){current={number:m[1]||'',title:canonical(SECTIONS,m[2]),parts:bodyParts(m[3])};sections.push(current);return}m=chunk.match(/^([1-9])[.)]\s*([\s\S]*)$/);if(m){const generic=splitNumberedHeading(m[2]);current={number:m[1],title:generic.title,parts:bodyParts(generic.body)};sections.push(current);return}const parts=bodyParts(chunk);if(current)current.parts.push.apply(current.parts,parts);else tail.push.apply(tail,parts)});return expandNarrativeTopic({meta,sections,tail})}

  // Older therapy notes can contain the entire chronology directly after "Тема:".
  // Only use explicit transitions; do not rewrite or invent clinical observations.
  function expandNarrativeTopic(data){
    const topic=data.meta.find(item=>item.title==='Тема групповой психотерапии');
    if(!topic||!topic.body)return data;
    const quoted=topic.body.match(/^([«"][^»"\n]{3,160}[»"])[.!?]?\s+([\s\S]+)$/);
    if(!quoted)return data;
    const narrative=quoted[2].trim();
    if(!/^Сначала\b/i.test(narrative)||!/(?:Затем|Основная часть\s*:|Активно участвовали|Групповое занятие в целом)/i.test(narrative))return data;
    const fragments=narrative.split(/(?<=[.!?])\s+(?=(?:Сначала\b|Затем\b|Основная часть\s*:|Активно участвовали\b|Групповое занятие в целом\b))/i).map(x=>x.trim()).filter(Boolean);
    if(fragments.length<2)return data;
    topic.body=quoted[1];
    let thenCount=0,insertAt=0;
    for(const fragment of fragments){
      let heading='Ход занятия',body=fragment;
      if(/^Сначала\b/i.test(fragment))heading='Начало занятия';
      else if(/^Основная часть\s*:/i.test(fragment)){
        heading='Основная часть';body=fragment.replace(/^Основная часть\s*:\s*/i,'');
      }else if(/^Затем\b/i.test(fragment)){
        heading=thenCount++===0?'Разминка':'Практическая часть';
      }else if(/^Активно участвовали\b/i.test(fragment))heading='Наблюдения за участниками';
      else if(/^Групповое занятие в целом\b/i.test(fragment))heading='Итог занятия';
      data.sections.splice(insertAt++,0,{number:'',title:heading,parts:bodyParts(body)});
    }
    return data;
  }
  function plainParts(v){
    const lines=normalize(v).replace(/\[\[ARROW\]\]/g,'\n• ').split(/\n+/);
    const out=[];let bullet=[],paragraph=[];
    const flushBullet=()=>{if(bullet.length){out.push({type:'list',items:bullet});bullet=[]}};
    const flushParagraph=()=>{const value=paragraph.join(' ').trim();if(value)out.push({type:'p',text:cap(value)});paragraph=[]};
    for(const rawLine of lines){
      const line=String(rawLine||'').trim();
      if(!line){flushParagraph();flushBullet();continue}
      const bulletMatch=line.match(/^(?:[•·∙▪◦‣*\-]|\d{1,2}[.)])\s+(.+)$/);
      if(bulletMatch){flushParagraph();bullet.push(cap(bulletMatch[1].trim()));continue}
      flushBullet();
      const heading=line.match(/^([^:]{3,90}):\s*$/);
      if(heading){flushParagraph();out.push({type:'heading',text:cap(heading[1])});continue}
      paragraph.push(line);
    }
    flushParagraph();flushBullet();return out;
  }
  function appendParts(parent,parts){parts.forEach(part=>{if(part.type==='heading'){const h=document.createElement('h4');h.className='psych-subheading';h.textContent=part.text;parent.appendChild(h);return}if(part.type==='list'){const ul=document.createElement('ul');ul.className='psych-list';part.items.forEach(v=>{const li=document.createElement('li');li.textContent=v;ul.appendChild(li)});parent.appendChild(ul);return}if(part.type==='sub'){const box=document.createElement('div');box.className='psych-subsection';const h=document.createElement('div');h.className='psych-subheading';h.textContent=part.title;const p=document.createElement('p');p.textContent=part.text;box.append(h,p);parent.appendChild(box);return}const p=document.createElement('p');p.className='psych-paragraph';p.textContent=part.text;parent.appendChild(p)})}
  function isRedundantDocumentTitle(part){return part&&part.type==='p'&&/^отч[её]т\s+(?:по|о)\s+групповой\s+психотерапии[.!?]?$/i.test(String(part.text||'').trim())}
  function render(container,v){if(!container)return false;const data=parse(v);const visibleTail=data.tail.filter(part=>!isRedundantDocumentTitle(part));if(!data.meta.length&&!data.sections.length){const fallback=plainParts(v);if(fallback.length<2){container.textContent=normalize(v).replace(/\[\[ARROW\]\]/g,' ');return false}const formatted=document.createElement('div');formatted.className='psych-report psych-report-plain';appendParts(formatted,fallback);container.replaceChildren(formatted);return true}const root=document.createElement('div');root.className='psych-report';if(data.meta.length){const intro=document.createElement('section');intro.className='psych-intro';data.meta.forEach(item=>{const row=document.createElement('div');row.className='psych-intro-row';const l=document.createElement('div');l.className='psych-intro-label';l.textContent=item.title;const val=document.createElement('div');val.className='psych-intro-value';val.textContent=item.body;row.append(l,val);intro.appendChild(row)});root.appendChild(intro)}if(data.sections.length){const flow=document.createElement('div');flow.className='psych-flow';data.sections.forEach((section,i)=>{const item=document.createElement('section');item.className='psych-step';const rail=document.createElement('div');rail.className='psych-step-rail';const n=document.createElement('div');n.className='psych-step-number';n.textContent=(section.number||String(i+1))+'.';rail.appendChild(n);const body=document.createElement('div');body.className='psych-step-body';const h=document.createElement('h3');h.className='psych-step-title';h.textContent=section.title;body.appendChild(h);appendParts(body,section.parts);item.append(rail,body);flow.appendChild(item)});root.appendChild(flow)}if(visibleTail.length){const tail=document.createElement('section');tail.className='psych-tail';appendParts(tail,visibleTail);root.appendChild(tail)}container.replaceChildren(root);return true}
  function isPsych(){const title=document.getElementById('title');return document.body.dataset.screen==='screenReport'&&title&&/психотерап/i.test(title.textContent||'')}
  function tryFormat(){const box=document.getElementById('reportContent');if(!box||!isPsych()||box.querySelector('.psych-report')||box.querySelector('.report-loading'))return;const text=box.textContent||'';if(text.trim())render(box,text)}
  function start(){const box=document.getElementById('reportContent');if(!box)return;new MutationObserver(()=>setTimeout(tryFormat,0)).observe(box,{childList:true,subtree:true,characterData:true});document.getElementById('btnPsychology')?.addEventListener('click',()=>setTimeout(tryFormat,0));tryFormat()}
  window.MedsiPsychologyFormatter={parse,plainParts,render,tryFormat};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
