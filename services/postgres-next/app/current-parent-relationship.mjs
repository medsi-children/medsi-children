// Default family relationship labels restored from the pre-PostgreSQL
// Apps Script name dictionary (medsi-contacts.js / parent-relationships.js).
// This is a display convenience, never evidence of legal parenthood.
// Unknown and overlapping names remain neutral; explicit staff choices win.
const FEMALE = new Set((
  'агния авелина александра алина алиса алла алёна александрина анастасия ангелина анна анфиса аня арина ася асья '+
  'валентина валерия валя варвара варя василиса вера вероника вика виктория галя галина дарина дарья даша '+
  'диана евгения ева екатерина елена елизавета жанна женя зариат зарият злата инна ира ирина карина катя кира '+
  'ксения ксеня ксюша лариса лена лера лида лидия лиза лилия лия люба любовь люда людмила маргарита марго марина '+
  'мария маша мила милана милена мира мирослава надежда надя настя наталия наталья наташа оксана олеся оля ольга '+
  'поля полина рита рузалия света светлана софия софья софа соня стефания стефани стеша тая таисия тася таня татьяна '+
  'саша ульяна хадижа хадиджа юлия юля яна ярослава яся'
).split(' '));
const MALE = new Set((
  'александр алексей алёша андрей анатолий антон артём борис боря вадим валерий василий вася '+
  'ваня виталий витя виктор влад владимир владислав володя вова всеволод вячеслав гамзат герман глеб григорий гриша '+
  'данил даниил данила данилла даня денис дима дмитрий егор евгений елисей иван игорь илья кирилл коля константин костя '+
  'лев лёва леонид лёня лёша лука макар макс максим марк матвей михаил миша мирон никита николай '+
  'олег павел паша роман рома руслан саадула савелий саша сёма семён сергей серёжа слава станислав стас стёпа степан '+
  'сева тимофей тимур тёма фёдор федя ян яков ярик ярослав женя валя'
).split(' '));
const norm=value=>String(value||'').normalize('NFC').trim().toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
const female=new Set([...FEMALE].map(norm));
const male=new Set([...MALE].map(norm));

export function inferParentRelationship(parentName){
  const first=norm(String(parentName||'').trim().split(/\s+/u)[0]);
  if(!first||!/^[а-я-]+$/u.test(first))return 'Родитель';
  const f=female.has(first),m=male.has(first);
  if(f===m)return 'Родитель';
  return f?'Мама':'Папа';
}

// Historical PostgreSQL registrations used the literal placeholder "Родитель".
// Resolve it for all current-facing endpoints without mutating clinical data.
// A staff-selected concrete relationship must never be inferred over.
export function effectiveParentRelationship(value,parentName){
  const stored=String(value||'').trim();
  return !stored||norm(stored)==='родитель'
    ?inferParentRelationship(parentName):stored;
}
