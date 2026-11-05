(() => {
  'use strict';
  const normalize = value => String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]+/g, ' ').trim();
  const digits = value => String(value || '').replace(/\D/g, '').slice(-10);
  const displayPhone = value => digits(value) ? '8' + digits(value) : 'Не указан';
  const names = [
    [/^(?:маш|мари)(?:а|я|и|е|у|ю|ей|енька|еньки|еньке|еньку)?$/, 'мария'],
    [/^(?:ксюш|ксени)(?:а|я|и|е|у|ю|ей|енька|еньки)?$/, 'ксения'],
    [/^(?:миш|михаил)(?:а|у|е|ом)?$/, 'михаил'],
    [/^(?:даш|дари)(?:а|я|и|е|у|ю|ей)?$/, 'дарья'],
    [/^(?:пет|петр)(?:я|и|е|ю|а|у|ом)?$/, 'петр'],
    [/^(?:кат|екатерин)(?:я|и|е|ю|а|у|ой)?$/, 'екатерина'],
    [/^(?:ван|иван)(?:я|и|е|ю|а|у|ом)?$/, 'иван'],
    [/^(?:саш|александр)(?:а|я|и|е|у|ы|ой|ом)?$/, 'александр'],
    [/^(?:жен|евгени)(?:я|и|е|ю|й|ем)?$/, 'евгений'],
    [/^(?:леш|алексе)(?:а|и|е|у|й|я|ю|ем)?$/, 'алексей'],
    [/^(?:наст|анастаси)(?:я|и|е|ю|ей)?$/, 'анастасия'],
    [/^(?:дим|дмитри)(?:а|ы|е|у|ой|й|я|ю|и|ем)?$/, 'дмитрий'],
    [/^(?:сереж|серге)(?:а|и|е|у|й|я|ю|ем)?$/, 'сергей'],
    [/^(?:лиз|елизавет)(?:а|ы|е|у|ой)?$/, 'елизавета'],
    [/^(?:лен|елен)(?:а|ы|е|у|ой)?$/, 'елена'],
    [/^(?:ол|ольг)(?:я|и|е|ю|а|у|ой)?$/, 'ольга'],
    [/^(?:юл|юли)(?:я|и|е|ю|ей)?$/, 'юлия'],
    [/^(?:сон|софи|соф)(?:я|и|е|ю|ей)?$/, 'софия'],
    [/^(?:дан|даниил)(?:я|и|е|ю|а|у|ом)?$/, 'даниил'],
    [/^(?:вов|владимир)(?:а|ы|е|у|ой|ом)?$/, 'владимир'],
    [/^(?:андрюш|андре)(?:а|и|е|у|й|я|ю|ем)?$/, 'андрей'],
    [/^(?:тол|анатоли)(?:я|и|е|ю|й|ем)?$/, 'анатолий'],
    [/^(?:макс|максим)(?:а|у|е|ом)?$/, 'максим']
  ];
  function nameKey(token) {
    for (const [pattern, key] of names) if (pattern.test(token)) return key;
    return token.length > 3 ? token.replace(/(?:ого|ому|овой|ову|ым|ом|ой|ей|а|я|у|ю|ы|и|е)$/, '') : token;
  }
  const stop = /^(?:дай|дать|дайте|напиши|напишите|скажи|скажите|подскажи|подскажите|пришли|скинь|можешь|можете|могу|нужны|бы|хотел|хотелось|попросить|привет|здравствуйте|покажи|покажите|найди|найдите|найти|ищи|удали|удалить|удалите|убери|убрать|уберите|из|бота|системы|ребенок|ребенка|детей|родителя|родителей|родитель|мама|мамы|маме|маму|папа|папы|папе|папу|бабушка|бабушки|бабушке|бабушку|дедушка|дедушки|дедушке|дедушку|тетя|тети|тете|тетю|дядя|дяди|дяде|дядю|опекун|опекуна|опекуну|телефон|телефоны|номер|номера|контакт|контакты|для|у|по|с|мне|можно|пожалуйста|хочу|нужен|нужна|нужно|запись|про|как|позвонить|связаться|а)$/;
  function queryTokens(text) { return normalize(text).replace(/^(?:добрый день|доброе утро|добрый вечер|привет[а-я]*|здравств[а-я]*)\s*/, '').split(' ').filter(word => word && !stop.test(word)); }
  function matches(row, tokens, field = 'childName') {
    const phone = tokens.find(token => /^\d{10,11}$/.test(token));
    if (phone) return digits(row.phone) === digits(phone);
    const child = normalize(row[field]).split(' ');
    return tokens.length > 0 && tokens.every(token => child.some(word => token.length === 1 ? word.startsWith(token) : nameKey(word) === nameKey(token)));
  }
  function requestedRelationship(text) {
    const words = normalize(text).split(' ');
    const roles = [[/^мам(?:а|ы|е|у)$/, 'Мама'], [/^пап(?:а|ы|е|у)$/, 'Папа'], [/^бабушк(?:а|и|е|у)$/, 'Бабушка'], [/^дедушк(?:а|и|е|у)$/, 'Дедушка'], [/^тет(?:я|и|е|ю)$/, 'Тётя'], [/^дяд(?:я|и|е|ю)$/, 'Дядя'], [/^опекун(?:а|у)?$/, 'Опекун']];
    return roles.find(([pattern]) => words.some(word => pattern.test(word)))?.[1] || '';
  }
  function matchingContacts(rows, text, tokens = queryTokens(text)) {
    const role = requestedRelationship(text);
    return rows.filter(row => (!role || row.relationship === role) &&
      (matches(row, tokens) || (!/ребенк/.test(normalize(text)) && matches(row, tokens, 'parentName'))));
  }
  const rowLabel = row => `${row.childName || 'Без имени'} · ${row.relationship || 'Родитель'}: ${row.parentName || '—'} · ${displayPhone(row.phone)}`;
  const helpText = 'Помогу найти ребёнка и телефоны родителей, покажу непрочитанные чаты, открою нужный раздел или удалю выбранную запись после подтверждения.\n\nНапример: «дай телефон мамы Маши Д.», «есть новые сообщения?», «удали Машу Д.». Отчёты отправляю только после вашей проверки и подтверждения.';
  const fallbackTexts = [
    'Простите, я не очень понимаю, что от меня требуется. Попробуйте сформулировать задачу иначе.',
    'Не совсем понял запрос. Напишите, что нужно сделать, например: найти телефон, показать новые сообщения или подготовить отчёт.',
    'Пока не могу распознать эту задачу. Попробуйте описать её другими словами.'
  ];
  const sentenceCase = value => {
    const text = String(value || '').trim();
    return text ? text.charAt(0).toLocaleUpperCase('ru') + text.slice(1) : '';
  };

  function create(api) {
    let alive = true, version = 0, waiting = null, draft = null, writing = false, messageTarget = null;
    const result = (text, actions = [], mood = 'neutral', image = '') => ({text, actions, mood, image});
    const nav = (label, kind) => ({label, run: async () => { if (alive) api.navigate(kind); return null; }});
    const navigation = [];
    const check = (ticket, expires) => alive && ticket === version && Date.now() < expires;
    const expired = () => result('Этот выбор уже неактуален. Напишите запрос ещё раз.');
    function page(rows, title, format, offset = 0) {
      const shown = rows.slice(offset, offset + 10);
      const actions = offset + 10 < rows.length ? [{label:'Показать ещё', run: async () => alive ? page(rows, title, format, offset + 10) : null}] : [];
      return result(`${title}\n\n${shown.map(format).join('\n\n')}`, actions);
    }
    function confirmDelete(row) {
      const ticket = version, expires = Date.now() + 120000;
      waiting = null;
      return result(`Вы уверены, что хотите удалить эту запись из бота?\n\nРебёнок: ${row.childName}\n${row.relationship || 'Родитель'}: ${row.parentName || 'Не указан'}\nТелефон: ${displayPhone(row.phone)}\n\nБудут удалены запись и история сообщений этого контакта — как при удалении через корзину.`, [
        {label:'Да, удалить', run: async () => {
          if (!check(ticket, expires)) return expired();
          version++;
          writing = true;
          try { await api.deleteRecord({...row}); return result(`Запись удалена: ${row.childName} · ${row.parentName || displayPhone(row.phone)}.`); }
          catch (error) { return result(error.message === 'RECORD_CHANGED' ? 'Запись изменилась или уже удалена. Найдите ребёнка заново.' : 'Не удалось подтвердить удаление. Проверьте список детей перед повторной попыткой.', [], 'sad'); }
          finally { writing = false; }
        }},
        {label:'Отмена', run: async () => { if (!check(ticket, expires)) return expired(); version++; return result('Удаление отменено.'); }}
      ]);
    }
    async function lookup(text, intent) {
      const tokens = queryTokens(text);
      if (!tokens.length || tokens.every(token => token.length < 2)) {
        waiting = {intent, expires:Date.now() + 240000};
        return result(intent === 'delete' ? 'Кого удалить? Напишите имя ребёнка, лучше с фамилией или её первой буквой.' : 'Напишите имя ребёнка, например «Маша Д.».');
      }
      waiting = null;
      const rows = await api.parents();
      const found = matchingContacts(rows, text, tokens);
      if (!found.length) return result('Не нашёл такую запись. Попробуйте полное имя, фамилию или номер телефона.', [nav('Открыть телефоны', 'phones')]);
      if (intent === 'delete') {
        if (found.length === 1) return confirmDelete(found[0]);
        const ticket = version, expires = Date.now() + 120000;
        return result('Есть несколько подходящих записей. Какую удалить? Каждый контакт удаляется отдельно.', found.slice(0, 10).map(row => ({label:rowLabel(row),run:async()=>check(ticket,expires)?confirmDelete(row):expired()})).concat(found.length > 10 ? [{label:'Уточнить имя',run:async()=>result('Напишите полное имя ребёнка или номер контакта.')}] : []));
      }
      return page(found, 'Контакты:', rowLabel);
    }
    async function resolveMessageTarget(targetText, messageText = '') {
      const rows = await api.parents();
      const tokens = queryTokens(targetText);
      const found = matchingContacts(rows, targetText, tokens);
      if (!found.length) return result('Не нашёл ребёнка или контакт. Напишите имя ребёнка, например «Артём Д.»');
      if (found.length > 1) {
        return result('Нашёл несколько подходящих записей. Выберите нужного ребёнка:', found.slice(0, 10).map(row => ({
          label: rowLabel(row),
          run: async () => messageText ? composeParentMessage(row, messageText) : (messageTarget = row, waiting = {intent:'sendMessageText', expires:Date.now() + 240000}, result(`Что написать родителю ребёнка ${row.childName}?`))
        })));
      }
      return messageText ? composeParentMessage(found[0], messageText) : (messageTarget = found[0], waiting = {intent:'sendMessageText', expires:Date.now() + 240000}, result(`Что написать родителю ребёнка ${found[0].childName}?`));
    }
    async function resolveMessageWithoutSeparator(body) {
      const words = String(body || '').trim().split(/\s+/).filter(Boolean);
      if (words.length < 2) return resolveMessageTarget(words.join(' '));
      const rows = await api.parents();
      if (matchingContacts(rows, body).length) return resolveMessageTarget(body);
      for (let length = Math.min(4, words.length - 1); length >= 1; length--) {
        const target = words.slice(0, length).join(' ');
        const found = matchingContacts(rows, target);
        if (found.length === 1) return composeParentMessage(found[0], words.slice(length).join(' '));
      }
      return result('Не понял, где заканчивается имя ребёнка. Напишите, например: «напиши маме Артёма: Артём хочет доставку».');
    }
    function composeParentMessage(row, text) {
      const cleanText = sentenceCase(text);
      const ticket = version;
      messageTarget = row;
      waiting = {intent:'sendMessageConfirm', expires:Date.now() + 120000};
      return result(`Сообщение родителю ${row.childName}:\n\n${cleanText}\n\nОтправить его в чат?`, [
        {label:'Отправить сообщение', run:async () => {
          if (!alive || ticket !== version || Date.now() >= waiting.expires || messageTarget !== row) return expired();
          version++;
          writing = true;
          try { await api.sendParentMessage(row, cleanText); messageTarget = null; waiting = null; return result('Сообщение отправлено в чат.', [], 'happy'); }
          catch (_) { return result('Не удалось отправить сообщение. Откройте чат с родителями и попробуйте ещё раз.', [], 'sad'); }
          finally { writing = false; }
        }},
        {label:'Изменить текст', run:async () => { if (ticket !== version) return expired(); waiting = {intent:'sendMessageText', expires:Date.now() + 240000}; return result('Напишите новый текст сообщения.'); }},
        {label:'Отмена', run:async () => { version++; messageTarget = null; waiting = null; return result('Отправка отменена.'); }}
      ]);
    }
    const reportLabel = kind => ({morning:'Утренний отчёт',evening:'Вечерний отчёт',psychology:'Психотерапия'})[kind];
    const reportKind = value => /утрен|утро/.test(value) ? 'morning' : /вечер/.test(value) ? 'evening' : /психотерап|терапи|группов/.test(value) ? 'psychology' : '';
    function requestReport(kind) {
      waiting = {intent:'reportText',kind,expires:Date.now()+20*60000};
      return result(`${reportLabel(kind)}. Вставьте полный текст одним сообщением. Перед отправкой покажу его для проверки.`);
    }
    function chooseReport() {
      waiting = {intent:'reportType',expires:Date.now()+240000};
      const ticket = version, expires = waiting.expires;
      return result('Какой отчёт отправляем?', ['morning','evening','psychology'].map(kind => ({label:reportLabel(kind),run:async()=>check(ticket,expires)?requestReport(kind):expired()})));
    }
    function reviewReport(payload) {
      draft = payload;
      waiting = null;
      const ticket = version, expires = Date.now()+10*60000;
      return result(`${reportLabel(payload.kind)}\n\n${payload.text}\n\nПроверьте текст. Отправить этот отчёт родителям?`, [
        {label:'Отправить отчёт',run:async()=>{
          if(!check(ticket,expires)||draft!==payload)return expired();
          version++;
          writing = true;
          try {
            const sent = await api.submitReport(payload.kind,payload.text,payload.id);
            draft = null;
            return result(sent.accepted ? 'Готово. Отчёт сохранён, можно закрыть приложение.' : 'Отчёт отправлен.',[], 'happy');
          } catch (error) {
            if(error&&error.code==='REPORT_FORMAT_ERROR')return result(error.message,[
              {label:'Изменить текст',run:async()=>{if(!alive||draft!==payload)return expired();version++;draft=null;return requestReport(payload.kind);}}
            ],'sad');
            return result('Не удалось подтвердить отправку. Не создавайте новый отчёт повторно: можно проверить и повторить этот же запрос с защитой от дублей.',[
              {label:'Проверить этот запрос',run:async()=>alive&&draft===payload?reviewReport(payload):expired()}
            ],'sad');
          } finally { writing = false; }
        }},
        {label:'Изменить текст',run:async()=>{if(!check(ticket,expires))return expired();version++;draft=null;return requestReport(payload.kind);}},
        {label:'Отмена',run:async()=>{if(!check(ticket,expires))return expired();version++;draft=null;return result('Отправка отменена.');}}
      ]);
    }
    async function respond(text) {
      const value = normalize(text);
      if (/^(?:да|да удалить|подтверждаю)$/.test(value)) return result('Для действия нажмите кнопку под подтверждением. Одного сообщения «да» недостаточно.');
      version++;
      if (/^(?:отмена|отмени|не надо|нет|стоп)$/.test(value) || /(?:^| )не (?:надо |нужно |хочу )?(?:удал|убира|отправ)/.test(value)) { waiting = null; draft = null; messageTarget = null; return result('Хорошо, отменено.'); }
      if (/^(?:да|да удалить|подтверждаю)$/.test(value)) return result('Для действия нажмите кнопку под подтверждением. Одного сообщения «да» недостаточно.');
      if (waiting?.intent === 'sendMessageTarget' && Date.now() < waiting.expires && value) return resolveMessageTarget(text);
      if (waiting?.intent === 'sendMessageText' && Date.now() < waiting.expires && value) return composeParentMessage(messageTarget, text);
      if (waiting?.intent === 'sendMessageConfirm' && Date.now() < waiting.expires) return result('Сообщение уже подготовлено. Выберите «Отправить сообщение», «Изменить текст» или «Отмена».');
      if (/^(?:как дела|как ты|как поживаешь|как настроение|какое настроение|что нового|все хорошо|всё хорошо)$/.test(value)) {
        const smallTalk = [
          'Всё хорошо, спасибо! Системы работают, можно заняться вашими задачами.',
          'Настроение рабочее и отличное. Я готов помочь с делами.',
          'У меня всё в порядке: я на связи и готов помочь. Что нужно сделать?',
          'Похоже, сегодня спокойный день. Я на связи и готов помочь.'
        ];
        return result(smallTalk[Math.floor(Math.random() * smallTalk.length)], [], 'happy');
      }
      if (/(?:qr|кьюар|qr код|qr-код|код для подключ|подключ.*код)/i.test(String(text))) {
        return result('Вот QR-код для подключения Медси Бота родителями.', [], 'happy', '/tutors/medsi-bot-qr.svg');
      }
      if (/^(?:привет[а-я]*|здравств[а-я]*|доброе утро|добрый день|добрый вечер|здрасьте|здрасте|хай|салют)$/.test(value)) return result('Добрый день! С какой задачей помочь?', [], 'happy');
      if (/^(?:спасибо[а-я]*|благодарю|супер|отлично)$/.test(value)) return result('Всегда рад помочь.', [], 'happy');
      if (/^(?:написать|напиши|сообщить|сообщи)\s+родител(?:ю|ям)$/iu.test(String(text).trim())) {
        waiting = {intent:'sendMessageTarget', expires:Date.now() + 240000};
        return result('Кому написать? Укажите имя ребёнка, например «Артём Д.»');
      }
      const sendMatch = String(text).trim().match(/^(?:напиши|сообщи|передай|скажи)\s+(.+?)(?:\s+(?:что|такое|текст)\s+)(.+)$/iu);
      if (sendMatch) return resolveMessageTarget(sendMatch[1], sendMatch[2]);
      const sendWithoutText = String(text).trim().match(/^(?:напиши|сообщи|передай|скажи)\s+(.+)$/iu);
      if (sendWithoutText && !/^(?:что|текст|такое)\b/i.test(sendWithoutText[1])) return resolveMessageWithoutSeparator(sendWithoutText[1]);
      const kind = reportKind(value);
      const standaloneType = /^(?:нет |а |лучше |не утренний а |не вечерний а )?(?:утренн\w*|вечерн\w*|утро|вечер|психотерап\w*|группов\w* терап\w*|терап\w*)(?: отчет)?$/.test(value);
      if (waiting && Date.now() >= waiting.expires) waiting = null;
      if (standaloneType && (waiting?.intent?.startsWith('report') || draft)) {
        if (draft) { draft = {...draft,kind,id:api.newSubmissionId()}; return reviewReport(draft); }
        return requestReport(kind);
      }
      if (waiting?.intent === 'reportText' && (/[\n:]/.test(String(text)) || !/удал|телефон|контакт|номер|новые|непрочит|чаты|список детей|что ты умеешь|сколько|открой|открыть|отправь/.test(value))) {
        const reportText = String(text).trim();
        const currentKind = waiting.kind;
        return reviewReport({kind:currentKind,text:reportText,id:api.newSubmissionId()});
      }
      if (waiting?.intent === 'reportType' && kind) return requestReport(kind);
      if (kind && standaloneType) return requestReport(kind);
      if (/отчет|отчёт|психотерап|терапи|группов/.test(value) && !/^(?:открой|открыть)/.test(value)) {
        draft = null;
        if (!kind) return chooseReport();
        const separator = String(text).match(/(?:\n|:)/);
        if (separator && /^(?:(?:отправь|отправить|отправляем|отправьте) )?(?:утренний отчет|вечерний отчет|отчет по (?:психотерапии|групповой терапии|терапии)|психотерап\w*|группов\w* терап\w*|терап\w*)$/.test(normalize(String(text).slice(0,separator.index)))) {
          const body = String(text).slice(separator.index + separator[0].length).trim();
          if (body) return reviewReport({kind,text:body,id:api.newSubmissionId()});
        }
        return requestReport(kind);
      }
      draft = null;
      if (waiting?.intent?.startsWith('report')) waiting = null;
      if (/удал|убер|убрать/.test(value)) {
        if (/всех|все записи|всю базу/.test(value)) return result('Удаляю только одну выбранную запись за раз. Напишите имя ребёнка или номер контакта.');
        return lookup(text, 'delete');
      }
      if (/(?:непрочитан|новые сообщ|новое сообщ|новые чаты|что нового|кто.*написал|кто.*писал|есть.*сообщ|неотвеченн|новеньк|непрочит)/.test(value)) {
        waiting = null;
        const rows = await api.unread();
        if (!rows.length) return result('Непрочитанных чатов сейчас нет.', navigation);
        const response = page(rows, `Непрочитанных чатов: ${rows.length}`, row => `${row.childName || 'Без имени'} · ${row.parentName || 'Родитель'}\n${String(row.lastText || 'Новое сообщение').slice(0, 180)}`);
        response.actions.push(nav('Открыть чаты', 'chats'));
        return response;
      }
      if (/сколько.*(?:детей|ребят|родителей|контактов)/.test(value)) { waiting = null; const rows = await api.parents(); return result(`В списке ${rows.length} записей контактов. У ребёнка может быть несколько контактов.`, [nav('Открыть список', 'phones')]); }
      if (/^(?:возможности|что ты умеешь|помощь|что умеешь|что можешь)$/.test(value)) { waiting = null; return result(helpText, navigation); }
      if (/^(?:(?:покажи|дай|покажите|выведи) )?(?:список детей|все дети|список родителей|все родители|кто есть в боте)$/.test(value)) { waiting = null; const rows = await api.parents(); return rows.length ? page(rows, `Записей в списке: ${rows.length}`, rowLabel) : result('В списке пока нет записей.'); }
      if (/(?:откр|состав|подготов|отправ).*(?:утренн|вечерн|терап|психотерап)/.test(value)) {
        const kind = /утренн/.test(value) ? 'morning' : /вечерн/.test(value) ? 'evening' : 'psychology';
        waiting = null; return result('Открою форму. Текст и отправку вы подтверждаете сами.', [nav('Открыть форму', kind)]);
      }
      if (/^(?:открыть |открой )?(?:чаты|чат с родителями)$/.test(value)) { waiting = null; return result('Перейти к чатам с родителями?', [nav('Открыть чаты', 'chats')]); }
      if (/^(?:открыть |открой )?(?:телефоны|телефоны родителей)$/.test(value)) { waiting = null; return result('Открою список контактов.', [nav('Открыть телефоны', 'phones')]); }
      if (/телефон|номер|контакт|позвонить|связаться|найди|найдите|найти/.test(value)) return lookup(text, 'contact');
      if (waiting && ['delete','contact'].includes(waiting.intent) && Date.now() < waiting.expires) return lookup(text, waiting.intent);
      return result(fallbackTexts[Math.floor(Math.random() * fallbackTexts.length)]);
    }
    return {respond, canClose:()=>!writing, dispose() {alive = false; version++; waiting = null;}};
  }
  window.MedsiTutorAssistant = Object.freeze({create});
  window.MedsiAssistantOptions = {
    role:'educator',
    available: () => Boolean(window.MedsiTutorAdmin && document.getElementById('tutorAuthGate')?.classList.contains('hidden')),
    multiline:true,
    chatStyle:'.choices{grid-template-columns:1fr}.choices button{font-size:13px;line-height:1.4;min-height:44px;height:auto;white-space:normal;overflow-wrap:anywhere}',
    prompts:['QR-код', 'Написать родителю', 'Телефон родителя', 'Удалить ребёнка', 'Утренний отчёт', 'Вечерний отчёт', 'Психотерапия', 'Список детей', 'Телефоны родителей'],
    conversation: () => ({...create(window.MedsiTutorAdmin), role:'educator', greeting:'Добрый день, я Медси Бот, помогу с любыми задачами.'})
  };
})();
