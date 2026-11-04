import {readFileSync} from 'node:fs';

export const SCHEMA_SQL=readFileSync(new URL('../sql/001_initial.sql',import.meta.url),'utf8');
export const SCHEMA_TABLES=Object.freeze([...SCHEMA_SQL.matchAll(
  /CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z_0-9]*)\s*\(/gi)].map(match=>match[1]).sort());
export const SCHEMA_INDEXES=Object.freeze([...SCHEMA_SQL.matchAll(
  /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+([a-z_][a-z_0-9]*)\s+ON\s+/gi)].map(match=>match[1]).sort());

if(SCHEMA_TABLES.length!==27||new Set(SCHEMA_TABLES).size!==SCHEMA_TABLES.length||
   SCHEMA_INDEXES.length!==5||new Set(SCHEMA_INDEXES).size!==SCHEMA_INDEXES.length){
  throw new Error('PostgreSQL schema contract mismatch.');
}

export function schemaMatches(tableNames,indexNames=SCHEMA_INDEXES,unmanagedRelations=0){
  const tables=[...tableNames].map(String).sort();
  const indexes=new Set([...indexNames].map(String));
  return Number(unmanagedRelations)===0&&tables.length===SCHEMA_TABLES.length&&
    tables.every((name,index)=>name===SCHEMA_TABLES[index])&&
    SCHEMA_INDEXES.every(name=>indexes.has(name));
}
