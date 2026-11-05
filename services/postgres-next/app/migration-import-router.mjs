import express from 'express';
import {timingSafeEqual,createHash} from 'node:crypto';
import {importFullCapture} from '../src/full-import.mjs';
import {generateManifest} from './migration-audit.mjs';
import {createSameBucketSourceReader} from '../src/chat-media-copy.mjs';

const MAX_BYTES=100*1024*1024;
const tokenMatches=(provided,expected)=>{
  if(typeof provided!=='string'||typeof expected!=='string')return false;
  const a=Buffer.from(provided),b=Buffer.from(expected);
  return a.length===b.length&&a.length>=32&&timingSafeEqual(a,b);
};

export function createMigrationImportRouter({sql,env=process.env,storage}){
  const router=express.Router();
  router.use((req,res,next)=>{
    res.setHeader('cache-control','no-store');
    const expected=env.MEDSI_MIGRATION_IMPORT_TOKEN;
    const hmacKey=env.MEDSI_MIGRATION_AUDIT_KEY;
    if(!expected||!hmacKey)return res.status(404).end();
    if(!tokenMatches(req.get('Authorization')?.replace(/^Bearer\s+/i,''),expected)){
      return res.status(404).end();
    }
    if(req.get('X-Medsi-Migration-Freeze')!=='confirmed'||
       req.get('X-Medsi-Migration-Import')!=='confirmed'){
      return res.status(400).json({ok:false,code:'MIGRATION_CONFIRMATION_REQUIRED'});
    }
    next();
  });
  router.post('/',express.json({limit:'32mb',strict:true}),async(req,res)=>{
    const hmacKey=env.MEDSI_MIGRATION_AUDIT_KEY;
    try{
      const body=req.body;
      if(!body||typeof body!=='object'||!body.streams||!Array.isArray(body.s3Objects)||
         !body.envelope||!storage?.configured||typeof sql!=='function'){
        return res.status(400).json({ok:false,code:'MIGRATION_PACKAGE_INVALID'});
      }
      const readSource=createSameBucketSourceReader(storage);
      const inventory=[];
      for(const item of body.s3Objects){
        if(!item||typeof item.file_id!=='string'||!Number.isSafeInteger(item.bytes)||
           item.bytes<1||item.bytes>MAX_BYTES||! /^[a-f0-9]{64}$/.test(item.sha256)){
          throw new Error('invalid package');
        }
        const {body:objectBody}=await readSource('s3',item.file_id,MAX_BYTES);
        const digest=createHash('sha256').update(objectBody).digest('hex');
        if(objectBody.length!==item.bytes||digest!==item.sha256)throw new Error('media mismatch');
        inventory.push({file_id:item.file_id,bytes:item.bytes,sha256:digest});
      }
      const s3Manifest=generateManifest('s3_objects',inventory,hmacKey);
      const result=await importFullCapture(sql,body.streams,body.envelope,s3Manifest,
        {hmacKey,explicitImport:true,freezeConfirmed:true});
      return res.json({ok:true,alreadyImported:result.alreadyImported,
        streams:result.streams,s3Objects:inventory.length});
    }catch(_){
      return res.status(409).json({ok:false,code:'MIGRATION_IMPORT_REJECTED'});
    }
  });
  return router;
}
