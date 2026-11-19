/*
 * Правила распознавания для Медси Бота.
 * Файл не подключён к основной панели: его можно использовать в лаборатории и
 * позднее подключить к ней отдельно, передав безопасные действия интерфейса.
 */
(() => {
  'use strict';

  function normalize(text) {
    return ` ${String(text || '').toLocaleLowerCase('ru')
      .replace(/ё/g, 'е')
      .replace(/[^а-яa-z0-9]+/g, ' ')
      .trim()} `;
  }

  function isGreetingOnly(text) {
    const greeting = normalize(text).trim().replace(/^(?:медси бот|бот) /, '').replace(/ (?:медси бот|бот)$/, '');
    return /^(?:привет(?!стви)[а-я]*|здравств[а-я]*|здраст[а-я]*|здрасьт[а-я]*|здаров[а-я]*|здорово|салют[а-я]*|хай|хеллоу|хелло|hello|hi|ку)(?: (?:вам|тебе|всем))?$/.test(greeting)
      || /^(?:доброе|добрый|доброго|доброй) (?:утр[а-я]*|день|дня|ден[а-я]*|вечер[а-я]*|ноч[а-я]*|времен[а-я]* суток)$/.test(greeting);
  }

  function classify(text) {
    const query = normalize(text);
    const tokens = query.trim().split(/\s+/).filter(Boolean);
    const has = (...roots) => tokens.some(token => roots.some(root => token.startsWith(root)));
    const says = pattern => pattern.test(query);
    const question = has('как', 'когда', 'где', 'почему', 'зачем', 'можно', 'нужно', 'сколько', 'какой', 'какая', 'какие', 'что', 'чем');
    const child = has('ребен', 'дет', 'доч', 'сын', 'мальчик', 'девочк');
    const doctor = has('врач', 'доктор', 'лечащ', 'анастаси', 'антон', 'екатерин');
    const medicine = has('лекарств', 'таблет', 'препарат', 'медикамент', 'дозиров', 'рецепт');
    const treatment = has('лечен', 'лечи', 'лечу', 'анализ', 'процедур', 'диагноз', 'назначен', 'выписк', 'обследован', 'симптом');
    const therapy = has('психотерап', 'психолог') || has('терапи') && !medicine;
    const report = has('отчет', 'сводк', 'наблюден') || has('утренн', 'вечерн') && (
      has('покаж', 'отправ', 'скин', 'пришл', 'присл', 'посмотр', 'откры', 'когда', 'будет', 'готов', 'нов', 'почему', 'нет', 'задерж', 'опазд', 'приш', 'появ', 'обнов', 'где', 'жду', 'ждем')
      || says(/ (?:не было|не приш[а-я]*|не появ[а-я]*|не виж[а-я]*|до сих пор) /)
    );
    const deliveryAction = has('достав', 'переда', 'привез', 'привоз', 'принес', 'принос', 'заказ', 'курьер', 'посыл', 'гринвуд');
    const deliveryItem = has('еда', 'еду', 'еды', 'вкусн', 'сладост', 'фрукт', 'пицц', 'суши', 'напит', 'одежд', 'вещ', 'игрушк', 'книг', 'продукт', 'творческ');

    // В одной фразе может быть несколько тем. Сначала выбираем точный смысл,
    // затем широкие категории. Предлоги и окончания слов на выбор не влияют.
    if (has('телефон', 'номер', 'контакт', 'позвон', 'связат') && doctor) return 'doctors';

    const group = has('групп') || says(/ общ[а-я]* (?:занят|психотерап)/);
    const individual = has('индивидуал', 'личн') && therapy || says(/ (?:занят[а-я]* с психолог|мой психолог|моя психолог|свой психолог|психологом|психологу)/);
    if (group && (therapy || has('занят', 'отчет'))) return has('когда', 'время', 'расписан', 'начина', 'проход') || says(/ во сколько/) ? 'groupTherapyTime' : 'groupTherapy';
    if (individual) return 'individualTherapy';
    if (therapy) return 'therapy';

    if (has('спасибо', 'благодар') && !question && !has('покаж', 'отправ', 'скин', 'пришл', 'присл', 'посмотр')) return 'thanks';

    if (report) {
      const kind = has('утренн') && !has('вечерн') ? 'morning' : has('вечерн') && !has('утренн') ? 'evening' : '';
      const aboutContent = has('информац', 'напис', 'сказан', 'указан', 'данн', 'текст', 'содержан', 'описан', 'ошибк', 'неточн', 'неверн', 'неправил', 'неправд', 'исправ')
        || (medicine || treatment) && (has('почему', 'зачем') || says(/ (?:нет|нету) [а-я ]*(?:лечен|лекарств|препарат)/));
      const missing = !aboutContent && (has('задерж', 'опозд', 'опазд', 'пропал', 'стар') || says(/ (?:нет|нету|не было|не приш[а-я]*|не появ[а-я]*|не обнов[а-я]*|не виж[а-я]*|не получ[а-я]*|не готов[а-я]*|до сих пор) /)
        || has('где') && !has('посмотр', 'откры', 'найти'));
      const askingTime = has('когда', 'время', 'расписан', 'ждать') || says(/ во сколько/);
      const askingContent = aboutContent || has('почему', 'зачем', 'ошибк', 'неправд', 'неверн') && !missing;
      const requested = has('покаж', 'отправ', 'скин', 'присл', 'пришл', 'посмотр', 'откры', 'дай', 'дайте', 'получ', 'хочу', 'последн', 'актуальн', 'нов', 'готов', 'опублик');
      if (missing) return { key: 'reportDelay', kind };
      if (askingContent && (medicine || treatment)) return { key: 'medical', variant: medicine ? 'medicine' : '' };
      if (askingContent) return 'reportQuestion';
      if (askingTime && !has('покаж', 'отправ', 'скин', 'присл', 'пришл', 'посмотр', 'откры')) return 'reports';
      if (kind || requested) return { key: 'reportRequest', kind };
      return 'reports';
    }

    if (has('встрет', 'встреч', 'увид', 'видет', 'повида', 'навещ', 'навест', 'приеха', 'приед', 'приезд', 'прийти', 'приход', 'посет', 'свидан') && (!doctor || child)) {
      return has('когда', 'время', 'час', 'расписан') || says(/ (?:во сколько|до скольк|со скольк|в какие дни|в какой день|можно встрет|могу встрет|можно увид|могу увид|можно приех|могу приех)/) ? 'meetTime' : 'meetings';
    }
    if (has('звон', 'созвон', 'позвон', 'поговор') && child) return 'calls';
    if (has('режим', 'распоряд', 'расписан', 'подъем', 'завтрак', 'обед', 'полдник', 'ужин', 'отбой', 'прогулк', 'зарядк', 'йога', 'киносеанс') || says(/ сон час/)) return 'routine';

    const urgent = has('срочн', 'экстренн', 'неотложн', 'немедленн') || says(/ как можно скорее/);
    if (urgent && (medicine || treatment || doctor || has('плохо', 'состояни'))) return { key: 'urgent', variant: 'medical' };
    if (medicine && deliveryAction) return { key: 'delivery', variant: 'medicine' };
    if (deliveryAction && has('оплат', 'стоимост', 'цен', 'платеж', 'заплат')) return 'writeEducators';
    if (has('оплат', 'стоимост', 'цен', 'платеж', 'заплат', 'квитанц', 'счет') && !deliveryAction) return 'payment';
    if (medicine || treatment || doctor) return { key: 'medical', variant: medicine ? 'medicine' : '' };
    if (deliveryAction || deliveryItem) {
      const variant = has('адрес', 'куда', 'где', 'этаж', 'корпус') ? 'address'
        : has('ножниц', 'нож', 'лезви', 'остр', 'стекл', 'металл') ? 'restricted'
        : has('можно', 'разреш', 'допустим', 'привез', 'переда') && deliveryItem ? 'allowed' : '';
      return { key: 'delivery', variant };
    }

    if (urgent) return 'urgent';
    if (has('войти', 'вход', 'авторизац', 'подтвержден', 'смс') || says(/ не (?:могу|получается) зайти/)) return 'signIn';
    if (says(/ (?:не отвеч[а-я]*|нет ответ[а-я]*|долго молч[а-я]*|почему молч[а-я]*|когда ответ[а-я]*)/) && has('воспитател', 'чат', 'сообщен')) return 'educators';
    if (has('напис', 'связат', 'чат', 'сообщен', 'вопрос') && has('воспитател')) return 'writeEducators';
    if (has('воспитател') || says(/ написат[а-я]* вопрос/)) return 'educators';
    if (has('экран', 'приложен', 'установ', 'ярлык') && has('домой', 'рабоч', 'телефон', 'приложен')) return 'home';
    if (child && has('чувств', 'самочувств', 'дела', 'настроен', 'состояни')) return 'childStatus';
    if (has('спасибо', 'благодар', 'супер', 'отлично', 'здорово') && !question) return 'thanks';
    return null;
  }

  function analyze(text) {
    const query = normalize(text);
    const words = query.trim().split(/\s+/);
    const has = root => words.some(word => word.startsWith(root));
    const intent = classify(text);
    const medical = ['лекарств', 'препарат', 'лечен', 'лечи', 'дозиров'].some(has);
    const report = has('отчет') || has('утренн') || has('вечерн');
    const clearAction = ['покаж', 'отправ', 'пришл', 'скин', 'когда', 'почему', 'нет', 'нету', 'информац', 'напис', 'указан', 'посмотр'].some(has);
    if (report && medical && !clearAction) {
      return { intent: { key: 'clarifyReportMedical' }, confidence: 0.5 };
    }
    if (has('встреч') && has('врач') && !has('ребен') && !has('дет')) {
      return { intent: { key: 'clarifyDoctorMeeting' }, confidence: 0.5 };
    }
    if (!intent) return { intent: null, confidence: 0 };
    const key = typeof intent === 'string' ? intent : intent.key;
    const confidence = key === 'delivery' && !['достав', 'переда', 'привез', 'заказ', 'курьер'].some(has) ? 0.7 : 0.95;
    return { intent, confidence };
  }

  window.MedsiSmartBot = Object.freeze({ normalize, classify, analyze, isGreetingOnly });
})();
