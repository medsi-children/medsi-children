import AdmZip from 'adm-zip';
import {DOMParser, XMLSerializer} from '@xmldom/xmldom';
import {posix} from 'node:path';

const SHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DATE = '(\\d{1,2}\\.\\d{1,2}\\.\\d{4})';
const TIME = '(?:[ \\t]+\\d{1,2}:\\d{2}(?::\\d{2})?)?';
const RANGE = new RegExp('^(\\s*)'+DATE+'('+TIME+')(?:(\\s*(?:[-–—−]|по)\\s*)(?:'+DATE+'('+TIME+'))?)?(\\s*)$', 'iu');

export function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(value+'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0,10) === value;
}

function toIso(date) {
  if (!date) return null;
  const [day,month,year] = date.split('.');
  const iso = [year,month.padStart(2,'0'),day.padStart(2,'0')].join('-');
  if (!validIsoDate(iso)) throw new Error('Invalid plan date');
  return iso;
}

const list = (node, name, ns = SHEET) => Array.from(node.getElementsByTagNameNS(ns, name));
const cellText = node => list(node, 't').map(t => t.textContent).join('');

function readXml(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry || entry.header.size > 12 * 1024 * 1024) throw new Error('Missing or oversized XLSX entry');
  const xml = entry.getData().toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported XLSX XML');
  return new DOMParser().parseFromString(xml, 'application/xml');
}

const colNumber=column=>[...column].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
function colName(number){
  let result='';
  for(;number>0;number=Math.floor((number-1)/26))result=String.fromCharCode(65+(number-1)%26)+result;
  return result;
}
function cellAddress(ref){
  const match=/^([A-Z]{1,3})([1-9]\d*)$/.exec(ref);
  return match ? {column:colNumber(match[1]),row:Number(match[2])}:null;
}
function nativeDate(zip,workbook,cell,raw){
  const type=cell.getAttribute('t');
  if(type==='d'){
    const match=/^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z?)?$/.exec(raw);
    if(!match || !validIsoDate(match[1]))throw new Error('Invalid native Excel date');
    return match[1];
  }
  if(type && type!=='n')throw new Error('Unsupported plan date cell');
  if(!/^\d+(?:\.\d+)?$/.test(raw))throw new Error('Invalid native Excel date');
  if(!zip.getEntry('xl/styles.xml'))throw new Error('Numeric date without calendar style');
  const styles=readXml(zip,'xl/styles.xml');
  const xf=list(list(styles,'cellXfs')[0]||styles,'xf')[Number(cell.getAttribute('s')||0)];
  const format=Number(xf?.getAttribute('numFmtId')||0);
  const custom=list(styles,'numFmt').find(n=>Number(n.getAttribute('numFmtId'))===format)?.getAttribute('formatCode')||'';
  // Only accept explicit calendar formats. Never turn a general number into a date.
  const tokens=custom.replace(/"[^"]*"|\\.|_.|\*.|\[[^\]]*\]/g,'').toLowerCase();
  if(![14,15,16,17,22].includes(format) && !(format>=164 && /y/.test(tokens) && /m/.test(tokens) && /d/.test(tokens) && !tokens.includes(';')))
    throw new Error('Numeric date without calendar style');
  const number=Number(raw);
  const serial=Math.floor(number);
  const epoch1904=['1','true'].includes(list(workbook,'workbookPr')[0]?.getAttribute('date1904'));
  if(!Number.isFinite(number) || serial>2958465 || serial<(epoch1904?0:61))throw new Error('Invalid native Excel date');
  const date=new Date(Date.UTC(epoch1904?1904:1899,epoch1904?0:11,epoch1904?1:30)+serial*86400000);
  if(!Number.isFinite(+date))throw new Error('Invalid native Excel date');
  const iso=date.toISOString().slice(0,10);
  if(!validIsoDate(iso))throw new Error('Invalid native Excel date');
  return iso;
}

function inspect(bytes) {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Oversized XLSX');
  const zip = new AdmZip(bytes);
  const workbook = readXml(zip, 'xl/workbook.xml');
  const sheets = list(workbook, 'sheet').filter(s => s.getAttribute('name').trim() === 'ДЕТСКИЙ СТАЦИОНАР');
  if (sheets.length !== 1) throw new Error('Missing or ambiguous plan sheet');
  const id = sheets[0].getAttributeNS(REL, 'id');
  const relationships = readXml(zip, 'xl/_rels/workbook.xml.rels');
  const link = list(relationships, 'Relationship', PACKAGE).find(r => r.getAttribute('Id') === id);
  if (!link || link.getAttribute('TargetMode') === 'External') throw new Error('Missing sheet relationship');
  const target = link.getAttribute('Target');
  const path = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target));
  if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) throw new Error('Unsupported sheet path');
  const document = readXml(zip, path);
  const strings = zip.getEntry('xl/sharedStrings.xml')
    ? list(readXml(zip, 'xl/sharedStrings.xml'), 'si').map(cellText) : [];
  const cells = list(document, 'c');
  const value = cell => {
    const raw = list(cell, 'v')[0]?.textContent;
    if (cell.getAttribute('t') === 's') return strings[Number(raw)] || '';
    return cell.getAttribute('t') === 'inlineStr' ? cellText(cell) : raw || '';
  };
  function adjacent(pattern) {
    const labels = cells.filter(cell => pattern.test(value(cell).trim()));
    if (labels.length > 1) throw new Error('Ambiguous plan field');
    if (!labels.length) return null;
    const address=cellAddress(labels[0].getAttribute('r'));
    if(!address)throw new Error('Unsupported plan field position');
    const merges=list(document,'mergeCell').map(node=>node.getAttribute('ref').split(':').map(cellAddress))
      .filter(([start,end])=>start && end && address.column>=start.column && address.column<=end.column &&
        address.row>=start.row && address.row<=end.row);
    if(merges.length>1 || merges.some(([start])=>start.column!==address.column || start.row!==address.row))
      throw new Error('Ambiguous plan field');
    const column=(merges[0]?.[1]?.column||address.column)+1;
    if(column>16384)throw new Error('Unsupported plan field position');
    const ref=colName(column)+address.row;
    return cells.find(cell=>cell.getAttribute('r')===ref);
  }
  const dates = adjacent(/^Дата\s*,\s*время\s*:?$/iu);
  const patient = adjacent(/^Ф\.\s*И\.\s*О\.\s*пациента\s*,\s*возраст\s*:?$/iu);
  if (!dates) throw new Error('Missing plan date cell');
  if (list(dates,'f').length) throw new Error('Formula plan date cell');
  const raw=value(dates).trim();
  if(!raw)throw new Error('Empty plan date cell');
  const match=['s','inlineStr','str'].includes(dates.getAttribute('t')) ? RANGE.exec(value(dates)) : null;
  const textDate=['s','inlineStr','str'].includes(dates.getAttribute('t'));
  if(textDate && !match)throw new Error('Unsupported plan date range');
  const admission=match?toIso(match[2]):nativeDate(zip,workbook,dates,raw);
  const discharge=match?toIso(match[5]):null;
  if (discharge && discharge < admission) throw new Error('Invalid plan date order');
  return {zip, document, path, dates, match, admission, discharge, patient:patient ? value(patient).trim() : ''};
}

export function readPlanDates(bytes) {
  const {admission, discharge, patient} = inspect(bytes);
  return {admission, discharge, patient};
}

export function updatePlanDischarge(bytes, date, {allowNative=false}={}) {
  const plan = inspect(bytes);
  if (!validIsoDate(date) || date < plan.admission) throw new Error('Invalid discharge date');
  if (date === plan.discharge) return bytes;
  // Reading a native date is safe; do not replace its numeric/date representation with text.
  if(!plan.match&&!allowNative)throw new Error('Native plan date cell is read-only');
  const raw=list(plan.dates,'v')[0]?.textContent||'';
  if(!plan.match && !(/^\d+$/.test(raw)||/^\d{4}-\d{2}-\d{2}$/.test(raw)))
    throw new Error('Native date with time is not supported for writing');
  const [, prefix, start, startTime, separator, , endTime, suffix] = plan.match||
    ['', '',plan.admission.split('-').reverse().join('.'),'','–','','',''];
  const replacement = prefix+start+startTime+(separator || '–')+date.split('-').reverse().join('.')+(endTime || '')+suffix;
  // Own the replacement string in this cell. The original shared string may be used elsewhere.
  const inline = plan.document.createElementNS(SHEET, 'is');
  const t = plan.document.createElementNS(SHEET, 't');
  t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  t.appendChild(plan.document.createTextNode(replacement));
  inline.appendChild(t);
  const previous = list(plan.dates, 'v')[0] || list(plan.dates, 'is')[0];
  if (!previous) throw new Error('Missing plan date cell value');
  plan.dates.replaceChild(inline, previous);
  plan.dates.setAttribute('t', 'inlineStr');
  plan.zip.updateFile(plan.path, Buffer.from(new XMLSerializer().serializeToString(plan.document)));
  const updated = plan.zip.toBuffer();
  const check = readPlanDates(updated);
  if (check.admission !== plan.admission || check.discharge !== date || check.patient !== plan.patient)
    throw new Error('Plan date verification failed');
  return updated;
}
