(function(){
  const META=[['тема групповой психотерапии','Тема групповой психотерапии'],['тема','Тема групповой психотерапии'],['тема занятия','Тема групповой психотерапии'],['цель групповой психотерапии','Цель групповой психотерапии'],['цель','Цель групповой психотерапии'],['цель занятия','Цель групповой психотерапии'],['возрастная категория','Возрастная категория'],['начало группы','Начало группы']];
  const SECTIONS=[['начало','Начало'],['вводная часть','Вводная часть'],['разогрев','Разогрев'],['интерактивная часть','Интерактивная часть'],['основная часть','Основная часть'],['практическое упражнение','Практическое упражнение'],['заключительная часть','Заключительная часть'],['заключение','Заключение'],['выводы','Выводы'],['рефлексия','Рефлексия'],['в завершении','В завершении'],['завершение','Завершение']];
  const ARROW=' [[ARROW]] ';
  function cap(v){const s=String(v||'').replace(/\s*\[\[ARROW\]\]\s*/g,' ').replace(/[ \t]{2,}/g,' ').trim();if(!s)return'';const m=s.match(/[A-Za-zА-Яа-яЁё]/);if(!m)return s;const i=m.index;return s.slice(0,i)+s[i].toLocaleUpperCase('ru-RU')+s.slice(i+1)}
  function stripEmoji(v){return String(v||'').replace(/[\u2600-\u27BF]/g,'').replace(/[\uD83C-\uDBFF][\uDC00-\uDFFF]/g,'').replace(/[\uFE0F\u200D]/g,'').replace(/[ \t]{2,}/g,' ').trim()}
  function normalize(v){return stripEmoji(String(v||'').replace(/\r\n?/g,'\n').replace(/➡️?/g,ARROW).replace(/([1-9])️⃣/g,'$1.').replace(/[➀➊①]/g,'1.').replace(/[➁➋②]/g,'2.').replace(/[➂➌③]/g,'3.').replace(/[➃➍④]/g,'4.').replace(/[➄➎⑤]/g,'5.').replace(/[➅➏⑥]/g,'6.').replace(/[➆➐⑦]/g,'7.').replace(/[➇➑⑧]/g,'8.').replace(/[➈➒⑨]/g,'9.')).replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim()}
  function canonical(list,v){const low=String(v||'').trim().toLocaleLowerCase('ru-RU');for(const p of list)if(low===p[0])return p[1];return cap(v)}
  function stripSectionMarker(v){return String(v||'').replace(/^\s*(?:[•·∙▪◦‣]+|[1-9]?[.)])\s+(?=(?:Начало|Вводная часть|Разогрев|Интерактивная часть|Основная часть|Практическое упражнение|Заключительная часть|Выводы|Рефлексия|В завершении|Завершение)(?:\s|$|[:.,]))/i,'')}
  function stripBodyNoise(v){return String(v||'').replace(/^\s*[.·∙•]+\s*/,'').trim()}
  function insertBreaks(v){
    const metaBroken=String(v||'').replace(/\s*(ТЕМА(?: групповой психотерапии| занятия)?|ЦЕЛЬ(?: групповой психотерапии| занятия)?|Возрастная категория|Начало группы)\s*:/gi,'\n\n$1:')
      // Some storage paths flatten every paragraph into a single line.
      // Separate only explicit prose transitions after a complete sentence.
      .replace(/([.!?])\s+(Занятие началось|В начале (?:занятия|встречи)|В ходе занятия (?:наиболее активн[^\s]*|участники|часть участников)|Наиболее активн[^\s]*|Некоторые участники|Все молодцы|В целом группа|По итогам занятия|Подводя итоги|Занятие прошло)(?=\s|[.,:;!?]|$)/giu,'$1\n\n$2');
    return metaBroken.split(/\n\s*\n+/).map(chunk=>{
      const clean=chunk.trim();
      if(/^ТЕМА(?: групповой психотерапии| занятия)?\s*:/i.test(clean))return clean;
      return clean.replace(/([.!?])\s+(Заключение)\s*[.:]\s*/g,'$1\n\n$2: ').replace(/\s*(ЧАСТЬ\s+[1-9])\s*:?\s*/gi,'\n\n$1: ').replace(/\s+([1-9])[.)]\s+(?=[А-ЯЁ])/g,'\n\n$1. ').replace(/\s*((?:[1-9][.)]\s*)?)(НАЧАЛО|Начало|Вводная часть|РАЗОГРЕВ|Разогрев|Интерактивная часть|Основная часть|Практическое упражнение|Заключительная часть|Заключение|Выводы|Рефлексия|В завершении|Завершение)\s*:/gi,'\n\n$1$2:').trim();
    }).filter(Boolean).join('\n\n').replace(/^\s+/,'').replace(/\n{3,}/g,'\n\n')
  }
  function bodyParts(v){const text=stripBodyNoise(stripSectionMarker(String(v||'').trim()));if(!text)return[];const raw=text.split('[[ARROW]]').map(x=>stripBodyNoise(stripSectionMarker(x.trim()))).filter(Boolean);if(raw.length===1){const enhanced=plainParts(raw[0]);if(enhanced.length>1||enhanced.some(part=>part.type==='list'||part.type==='heading'))return enhanced;return[{type:'p',text:cap(raw[0])}];}const out=[];if(!text.startsWith('[[ARROW]]')&&raw.length)out.push({type:'p',text:cap(raw.shift())});const short=raw.length>1&&raw.every(x=>x.length<=110&&!/[.!?][\s\S]{45,}/.test(x));if(short){out.push({type:'list',items:raw.map(cap)});return out}raw.forEach(x=>{const m=x.match(/^(Выполнение техники|Практическое упражнение|Упражнение\s+[^:]{1,70}|В завершении|Обратная связь)\s*:?\s*([\s\S]*)$/i);if(m&&m[2].trim())out.push({type:'sub',title:cap(m[1]),text:cap(m[2])});else out.push({type:'p',text:cap(x)})});return out}
  function splitNumberedHeading(v){
    const text=stripBodyNoise(String(v||'').trim());
    if(!text)return{title:'Этап занятия',body:''};
    const m=text.match(/^(.{2,120}?)(?::\s*|[.!?]\s+)([\s\S]*)$/);
    if(m)return{title:cap(m[1]),body:m[2].trim()};
    if(text.length<=90)return{title:cap(text),body:''};
    return{title:'Этап занятия',body:text}
  }
  function parse(v){const chunks=insertBreaks(normalize(v)).split(/\n\s*\n+/).map(x=>x.trim()).filter(Boolean);const meta=[],sections=[],tail=[];let current=null;chunks.forEach(chunk=>{let m=chunk.match(/^(ТЕМА(?: групповой психотерапии| занятия)?|ЦЕЛЬ(?: групповой психотерапии| занятия)?|Возрастная категория|Начало группы)\s*:\s*([\s\S]*)$/i);if(m){meta.push({title:canonical(META,m[1]),body:cap(m[2])});current=null;return}m=chunk.match(/^Часть\s+([1-9])\s*:?\s*([\s\S]*)$/i);if(m){current={number:m[1],title:'Часть',parts:bodyParts(m[2])};sections.push(current);return}m=chunk.match(/^(?:([1-9])[.)]\s*)?(НАЧАЛО|Начало|Вводная часть|РАЗОГРЕВ|Разогрев|Интерактивная часть|Основная часть|Практическое упражнение|Заключительная часть|Заключение|Выводы|Рефлексия|В завершении|Завершение)\s*[:.]?\s*([\s\S]*)$/i);if(m){current={number:m[1]||'',title:canonical(SECTIONS,m[2]),parts:bodyParts(m[3])};sections.push(current);return}m=chunk.match(/^([1-9])[.)]\s*([\s\S]*)$/);if(m){const generic=splitNumberedHeading(m[2]);current={number:m[1],title:generic.title,parts:bodyParts(generic.body)};sections.push(current);return}const parts=bodyParts(chunk);if(current)current.parts.push.apply(current.parts,parts);else tail.push.apply(tail,parts)});return expandNarrativeCategories(expandNarrativeProse(v,expandStructuredTopicProse(expandNarrativeTopic({meta,sections,tail}))))}

  // Older therapy notes can contain the entire chronology directly after "Тема:".
  // Only use explicit transitions; do not rewrite or invent clinical observations.
  function expandNarrativeTopic(data){
    const topic=data.meta.find(item=>item.title==='Тема групповой психотерапии');
    if(!topic||!topic.body)return data;
    const quoted=topic.body.match(/^([«"][^»"\n]{3,160}[»"])[.!?]?\s+([\s\S]+)$/);
    if(!quoted)return data;
    const narrative=quoted[2].trim();
    // JavaScript word-boundary matching treats Cyrillic as non-word; use explicit delimiters.
    if(!/^Сначала(?=\s|$|[.,:;!?])/i.test(narrative)||!/(?:Затем|Основная часть\s*:|Активно участвовали|Групповое занятие в целом)/i.test(narrative))return data;
    const fragments=narrative.split(/(?<=[.!?])\s+(?=(?:Сначала(?=\s|$|[.,:;!?])|Затем(?=\s|$|[.,:;!?])|Основная часть\s*:|Активно участвовали(?=\s|$|[.,:;!?])|Групповое занятие в целом(?=\s|$|[.,:;!?])))/i).map(x=>x.trim()).filter(Boolean);
    if(fragments.length<2)return data;
    topic.body=quoted[1];
    let thenCount=0,insertAt=0;
    for(const fragment of fragments){
      let heading='Ход занятия',body=fragment;
      if(/^Сначала(?=\s|$|[.,:;!?])/i.test(fragment))heading='Начало занятия';
      else if(/^Основная часть\s*:/i.test(fragment)){
        heading='Основная часть';body=fragment.replace(/^Основная часть\s*:\s*/i,'');
      }else if(/^Затем(?=\s|$|[.,:;!?])/i.test(fragment)){
        heading=thenCount++===0?'Разминка':'Практическая часть';
      }else if(/^Активно участвовали(?=\s|$|[.,:;!?])/i.test(fragment))heading='Наблюдения за участниками';
      else if(/^Групповое занятие в целом(?=\s|$|[.,:;!?])/i.test(fragment))heading='Итоги';
      data.sections.splice(insertAt++,0,{number:'',title:heading,parts:bodyParts(body)});
    }
    // Later sections may contain several stages in one paragraph as well.
    const splitSections=[];
    for(const section of data.sections){
      if(section.title!=='Основная часть'||section.parts.length!==1||section.parts[0].type!=='p'){
        splitSections.push(section);continue;
      }
      const original=section.parts[0].text;
      const pieces=original.split(/(?<=[.!?])\s+(?=(?:Затем(?=\s|$|[.,:;!?])|Активно участвовали(?=\s|$|[.,:;!?])|Групповое занятие в целом(?=\s|$|[.,:;!?])))/i).map(x=>x.trim()).filter(Boolean);
      if(pieces.length<2){splitSections.push(section);continue}
      section.parts=bodyParts(pieces.shift());
      splitSections.push(section);
      for(const piece of pieces){
        const heading=/^Активно участвовали(?=\s|$|[.,:;!?])/i.test(piece)?'Наблюдения за участниками':
          /^Групповое занятие в целом(?=\s|$|[.,:;!?])/i.test(piece)?'Итоги':'Практическая часть';
        splitSections.push({number:'',title:heading,parts:bodyParts(piece)});
      }
    }
    data.sections=splitSections;
    return data;
  }
  // Reports sometimes put the entire session under a quoted "Тема:" label.
  // Split only at explicit, sentence-initial activity transitions; never
  // invent observations or infer a participant's condition from free prose.
  function expandStructuredTopicProse(data){
    const topic=data.meta.find(item=>item.title==='Тема групповой психотерапии');
    if(!topic||!topic.body)return data;
    const match=/^([«"][^»"\n]{3,160}[»"])[.!?]?\s+([\s\S]+)$/u.exec(topic.body);
    if(!match)return data;
    const narrative=match[2].trim();
    if(!/^(?:Вначале занятия|В начале (?:занятия|встречи)|Занятие началось)(?=\s|[.,:;!?]|$)/iu.test(narrative))return data;
    const pieces=narrative.split(/(?<=[.!?])\s+(?=(?:Затем(?:\s+разминка)?|Далее(?:\s+обсуждение)?|Практическое (?:задание|упражнение)|Активно участвовали|В конце занятия|Группа прошла)(?=\s|[.,:;!?]|$))/iu)
      .map(item=>item.trim()).filter(Boolean);
    // One isolated transition may simply be prose about the theme.
    if(pieces.length<3)return data;
    const steps=[];
    for(const piece of pieces){
      let title='Ход занятия';
      if(/^(?:Вначале занятия|В начале (?:занятия|встречи)|Занятие началось)(?=\s|[.,:;!?]|$)/iu.test(piece))title='Начало занятия';
      else if(/^Затем\s+разминка(?=\s|[.,:;!?]|$)/iu.test(piece))title='Разминка';
      else if(/^Далее\s+обсуждение(?=\s|[.,:;!?]|$)/iu.test(piece))title='Обсуждение';
      else if(/^Практическое (?:задание|упражнение)(?=\s|[.,:;!?]|$)/iu.test(piece))title='Практическая часть';
      else if(/^Активно участвовали(?=\s|[.,:;!?]|$)/iu.test(piece))title='Наблюдения за участниками';
      else if(/^В конце занятия(?=\s|[.,:;!?]|$)/iu.test(piece))title='Завершение';
      else if(/^Группа прошла(?=\s|[.,:;!?]|$)/iu.test(piece))title='Итоги';
      else if(/^Затем(?=\s|[.,:;!?]|$)/iu.test(piece))title='Ход занятия';
      const parts=bodyParts(piece);
      // Short transitions contain no independent observation. Preserve their
      // words in the preceding step instead of creating a one-line timeline
      // entry such as "Далее обсуждение.".
      if(steps.length&&/^Далее\s+(?:обсуждение|беседа|рефлексия)[.!?]?$/iu.test(piece)){
        steps[steps.length-1].parts.push(...parts);
        continue;
      }
      if(steps.length&&steps[steps.length-1].title===title)steps[steps.length-1].parts.push(...parts);
      else steps.push({number:'',title,parts});
    }
    // Do not create a timeline unless multiple distinct, explicit steps exist.
    if(new Set(steps.map(step=>step.title)).size<3)return data;
    topic.body=match[1];
    data.sections.unshift(...steps);
    return data;
  }

  // Some psychologists write a narrative with paragraphs rather than labelled
  // "Тема:", "Цель:", etc. Build visual sections only from explicit wording:
  // no inferred observations, paraphrasing or additions to the original text.
  // This also handles older PostgreSQL reports whose blank lines were collapsed
  // by the line-oriented normalization used before the therapy-specific fix.
  function expandNarrativeProse(original,data){
    if(data.meta.length||data.sections.length)return data;
    const chunks=normalize(original).replace(/\[\[ARROW\]\]/g,' ')
      .split(/\n+/).map(chunk=>chunk.trim()).filter(Boolean);
    while(chunks.length&&/^отч[её]т\s+(?:по|о)\s+групповой\s+психотерапии[.!?]?$/i.test(chunks[0]))chunks.shift();
    if(!chunks.length||!/^Занятие\s+(?:было\s+)?посвящено\s+теме(?=\s|$)/i.test(chunks[0]))return data;
    const meta=[],sections=[],tail=[];
    const addMeta=(title,body)=>{if(body.trim())meta.push({title,body:cap(body)})};
    const addSection=(title,body)=>{
      const parts=bodyParts(body);if(parts.length)sections.push({number:'',title,parts});
    };
    const intro=chunks.shift();
    const goal=intro.match(/(?:^|\s)(Цель занятия\s*[—–:-]\s*[\s\S]*)$/i);
    addMeta('Тема групповой психотерапии',goal?intro.slice(0,goal.index).trim():intro);
    if(goal)addMeta('Цель групповой психотерапии',goal[1]);
    let hadStructure=false;
    for(const chunk of chunks){
      if(/^Структура занятия(?=\s|:|$)/i.test(chunk)){
        const practical=chunk.match(/(?:^|\s)(В практической части(?=\s|$)[\s\S]*)$/i);
        if(practical){
          addSection('Ход занятия',chunk.slice(0,practical.index).trim());
          addSection('Практическая часть',practical[1]);
        }else addSection('Ход занятия',chunk);
        hadStructure=true;continue;
      }
      if(/^В практической части(?=\s|$)/i.test(chunk)){
        addSection('Практическая часть',chunk);hadStructure=true;continue;
      }
      if(/^В целом группа(?=\s|$)/i.test(chunk)){
        addSection('Итоги',chunk);continue;
      }
      if(hadStructure){
        const conclusion=chunk.match(/(?:^|\s)(В целом группа(?=\s|$)[\s\S]*)$/i);
        if(conclusion){
          addSection('Наблюдения за участниками',chunk.slice(0,conclusion.index).trim());
          addSection('Итоги',conclusion[1]);continue;
        }
        // Multiple semicolon-separated participant observations.
        if((chunk.match(/;\s*[А-ЯЁ]/g)||[]).length>=2){
          addSection('Наблюдения за участниками',chunk);continue;
        }
      }
      tail.push(...plainParts(chunk));
    }
    // Stay on the existing generic formatter if the narrative has no
    // recognizable stages; arbitrary prose must not be assigned a category.
    return sections.length?{meta,sections,tail}:data;
  }

  // Group therapy notes may be fully narrative. Assign labels only when
  // the source uses a recognizable explicit transition. Preserve its wording,
  // punctuation and participant attribution without inventing observations.
  function narrativeKind(value){
    const text=String(value||'').trim();
    if(/^(?:Занятие началось|Занятие начиналось|В начале (?:занятия|встречи)|Сначала|Структура занятия|Ход занятия|В практической части|В основной части|Содержательная часть|Затем|Далее|После этого|После возвращения)/iu.test(text))return 'Ход занятия';
    if(/^(?:В ходе занятия (?:наиболее активн|участники|часть участников)|Во время занятия (?:участники|часть участников)|Наиболее активн|Активно участвовали|Наблюдения за участниками|По участникам|Наблюдения по участникам|Некоторые участники|Часть участников|Отмечались индивидуальные|В поведении участников)/iu.test(text))return 'Наблюдения за участниками';
    if(/^(?:Все молодцы(?=\s|[,.!?:;]|$)|В целом группа|По итогам занятия|Подводя итоги|Занятие прошло|В завершение занятия|В результате занятия)/iu.test(text))return 'Итоги';
    return '';
  }
  function narrativeSlices(value){
    const text=String(value||'').trim();
    if(!text)return [];
    // Split only at sentence boundaries, never at semicolons between children.
    return text.split(/(?<=[.!?])\s+(?=(?:Занятие началось|В начале (?:занятия|встречи)|Сначала|Содержательная часть|Затем|Далее|После этого|После возвращения|В соответствии с|Структура занятия|Ход занятия|В ходе занятия (?:наиболее активн|участники|часть участников)|Во время занятия (?:участники|часть участников)|Наиболее активн|Активно участвовали|Наблюдения за участниками|По участникам|Наблюдения по участникам|Некоторые участники|В целом группа|Все молодцы|По итогам занятия|Подводя итоги|Занятие прошло|В завершение занятия)(?=\s|[.,:;!?]|$))/iu)
      .map(chunk=>chunk.trim()).filter(Boolean);
  }
  function splitExplicitSectionTransitions(data){
    // A psychologist may add an unlabelled observations/conclusion paragraph
    // after an explicitly named stage. The original parser appends it to the
    // preceding stage, so split only at clear semantic paragraph boundaries.
    const output=[];
    for(const original of data.sections){
      const section={...original,parts:[]};
      output.push(section);
      let current=section;
      for(const part of original.parts||[]){
        if(part.type!=='p'){current.parts.push(part);continue}
        for(const sentence of narrativeSlices(part.text)){
          const title=narrativeKind(sentence);
          if((title==='Наблюдения за участниками'||title==='Итоги') &&
            title!==current.title && (current!==section||section.parts.length)){
            current={number:'',title,parts:[]};
            output.push(current);
          }
          current.parts.push({type:'p',text:sentence});
        }
      }
    }
    data.sections=output;
    return data;
  }
  function expandNarrativeCategories(data){
    const originalTail=data.tail||[],remaining=[],preface=[],additional=[];
    // Preserve prose that appeared before the first recognized narrative
    // stage. It must never be rendered after the conclusion.
    const hasExistingSections=data.sections.length>0;
    let current=null;
    const add=(title,body)=>{
      if(!current||current.title!==title){
        current={number:'',title,parts:[]};
        additional.push(current);
      }
      current.parts.push({type:'p',text:body});
    };
    for(const part of originalTail){
      if(part.type!=='p'){remaining.push(part);current=null;continue}
      const text=String(part.text||'').trim();
      if(/^отч[её]т\s+о\s+проведении\s+группов(?:ого|ой)\s+психотерапевтическ(?:ого|ой)\s+занятия(?=\s|[.,:;!?]|$)/iu.test(text)){
        data.meta.unshift({title:'Описание занятия',body:text});
        current=null;continue;
      }
      for(const sentence of narrativeSlices(text)){
        const title=narrativeKind(sentence);
        if(title){add(title,sentence);continue;}
        if(current){current.parts.push({type:'p',text:sentence});continue}
        const partToKeep={type:'p',text:sentence};
        if(!hasExistingSections&&!additional.length)preface.push(partToKeep);
        else remaining.push(partToKeep);
      }
    }
    if(additional.length){
      data.sections.push(...additional);
      data.preface=preface;
      data.tail=remaining;
    }
    return splitExplicitSectionTransitions(data);
  }

  function plainParts(v){
    const lines=normalize(v).replace(/\[\[ARROW\]\]/g,'\n• ').split('\n');
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

  // All author-written words must survive the pretty formatter, in order.
  // Generated visual headings may add labels, but they cannot stand in for
  // missing observations. A failed check always displays the exact source.
  function reportWords(value){
    return String(value||'').normalize('NFKC').toLocaleLowerCase('ru-RU')
      .match(/[\p{L}\p{N}]+/gu)||[];
  }
  function contentOfParts(parts){
    const values=[];
    for(const part of parts||[]){
      if(part.type==='list')values.push(...(part.items||[]));
      else if(part.type==='sub')values.push(part.title||'',part.text||'');
      else values.push(part.text||'');
    }
    return values.join(' ');
  }
  function losslessView(source,data){
    const words=reportWords(source);
    if(!words.length)return false;
    const presented=[
      ...(data.meta||[]).flatMap(item=>[item.title,item.body]),
      contentOfParts(data.preface),
      ...(data.sections||[]).flatMap(section=>[
        section.number?String(section.number):'',
        section.title,contentOfParts(section.parts)
      ]),
      contentOfParts(data.tail)
    ].join(' ');
    const shown=reportWords(presented);
    let cursor=0;
    for(const word of words){
      while(cursor<shown.length&&shown[cursor]!==word)cursor++;
      if(cursor===shown.length)return false;
      cursor++;
    }
    return true;
  }
  function showExactSource(container,source){
    const root=document.createElement('div');
    root.className='psych-report psych-report-source-only';
    const content=document.createElement('div');
    content.className='psych-source-content';
    content.textContent=source;
    root.appendChild(content);
    container.replaceChildren(root);
    return true;
  }
  function addOriginalText(root,source){
    const details=document.createElement('details');
    details.className='psych-source-details';
    const summary=document.createElement('summary');
    summary.textContent='Показать полный исходный текст';
    const content=document.createElement('div');
    content.className='psych-source-content';
    content.textContent=source;
    details.append(summary,content);
    root.appendChild(details);
  }
  function isRedundantDocumentTitle(part){return part&&part.type==='p'&&/^отч[её]т\s+(?:по|о)\s+групповой\s+психотерапии[.!?]?$/i.test(String(part.text||'').trim())}
  function render(container,v){if(!container)return false;const source=String(v||'');const data=parse(source);if(!losslessView(source,data))return showExactSource(container,source);const visibleTail=data.tail.filter(part=>!isRedundantDocumentTitle(part));if(!data.meta.length&&!data.sections.length){const fallback=plainParts(v);if(fallback.length<2){return showExactSource(container,source)}const formatted=document.createElement('div');formatted.className='psych-report psych-report-plain';appendParts(formatted,fallback);container.replaceChildren(formatted);return true}const root=document.createElement('div');root.className='psych-report';if(data.meta.length){const intro=document.createElement('section');intro.className='psych-intro';data.meta.forEach(item=>{const row=document.createElement('div');row.className='psych-intro-row';const l=document.createElement('div');l.className='psych-intro-label';l.textContent=item.title;const val=document.createElement('div');val.className='psych-intro-value';val.textContent=item.body;row.append(l,val);intro.appendChild(row)});root.appendChild(intro)}if(data.preface&&data.preface.length){const before=document.createElement('section');before.className='psych-preface';appendParts(before,data.preface.filter(part=>!isRedundantDocumentTitle(part)));root.appendChild(before)}if(data.sections.length){const flow=document.createElement('div');flow.className='psych-flow';data.sections.forEach((section,i)=>{const item=document.createElement('section');item.className='psych-step';const rail=document.createElement('div');rail.className='psych-step-rail';const n=document.createElement('div');n.className='psych-step-number';n.textContent=(section.number||String(i+1))+'.';rail.appendChild(n);const body=document.createElement('div');body.className='psych-step-body';const h=document.createElement('h3');h.className='psych-step-title';h.textContent=section.title;body.appendChild(h);appendParts(body,section.parts);item.append(rail,body);flow.appendChild(item)});root.appendChild(flow)}if(visibleTail.length){const tail=document.createElement('section');tail.className='psych-tail';appendParts(tail,visibleTail);root.appendChild(tail)}addOriginalText(root,source);container.replaceChildren(root);return true}
  function isPsych(){const title=document.getElementById('title');return document.body.dataset.screen==='screenReport'&&title&&/психотерап/i.test(title.textContent||'')}
  function tryFormat(){const box=document.getElementById('reportContent');if(!box||!isPsych()||box.querySelector('.psych-report')||box.querySelector('.report-loading'))return;const text=box.textContent||'';if(text.trim())render(box,text)}
  function start(){const box=document.getElementById('reportContent');if(!box)return;new MutationObserver(()=>setTimeout(tryFormat,0)).observe(box,{childList:true,subtree:true,characterData:true});document.getElementById('btnPsychology')?.addEventListener('click',()=>setTimeout(tryFormat,0));tryFormat()}
  window.MedsiPsychologyFormatter={parse,plainParts,losslessView,render,tryFormat};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
