import AdmZip from 'adm-zip';
import {DOMParser, XMLSerializer} from '@xmldom/xmldom';
import {posix} from 'node:path';

const SHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DATE = '(\\d{2}\\.\\d{2}\\.\\d{4})';
const TIME = '(?:[ \\t]+\\d{1,2}:\\d{2}(?::\\d{2})?)?';
const RANGE = new RegExp('^(\\s*)'+DATE+'('+TIME+')(?:(\\s*(?:[-–—−]|по)\\s*)(?:'+DATE+'('+TIME+'))?)?(\\s*)$', 'iu');

export function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(value+'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0,10) === value;
}

function toIso(date) {
  if (!date) return null;
  const iso = date.split('.').reverse().join('-');
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
    const [, column, row] = /^([A-Z]+)(\d+)$/.exec(labels[0].getAttribute('r')) || [];
    if (!column || column.length !== 1 || column === 'Z') throw new Error('Unsupported plan field position');
    const ref = String.fromCharCode(column.charCodeAt(0)+1)+row;
    return cells.find(cell => cell.getAttribute('r') === ref);
  }
  const dates = adjacent(/^Дата\s*,\s*время\s*:?$/iu);
  const patient = adjacent(/^Ф\.\s*И\.\s*О\.\s*пациента\s*,\s*возраст\s*:?$/iu);
  if (!dates || list(dates, 'f').length || !['s','inlineStr','str'].includes(dates.getAttribute('t'))) {
    throw new Error('Unsupported plan date cell');
  }
  const match = RANGE.exec(value(dates));
  if (!match) throw new Error('Unsupported plan date range');
  const admission = toIso(match[2]), discharge = toIso(match[5]);
  if (discharge && discharge < admission) throw new Error('Invalid plan date order');
  return {zip, document, path, dates, match, admission, discharge, patient:patient ? value(patient).trim() : ''};
}

export function readPlanDates(bytes) {
  const {admission, discharge, patient} = inspect(bytes);
  return {admission, discharge, patient};
}

export function updatePlanDischarge(bytes, date) {
  const plan = inspect(bytes);
  if (!validIsoDate(date) || date < plan.admission) throw new Error('Invalid discharge date');
  if (date === plan.discharge) return bytes;
  const [, prefix, start, startTime, separator, , endTime, suffix] = plan.match;
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
