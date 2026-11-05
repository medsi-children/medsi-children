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
    next();
  });
  router.post('/inventory',express.json({limit:'256kb',strict:true}),async(req,res)=>{
    try{
      const ids=req.body?.fileIds;
      if(!Array.isArray(ids)||ids.length>256||new Set(ids).size!==ids.length||
         ids.some(id=>typeof id!=='string'))throw new Error();
      if(!storage?.configured)throw Object.assign(new Error(),{code:'S3_NOT_CONFIGURED'});
      const readSource=createSameBucketSourceReader(storage),objects=[];
      for(const file_id of ids){
        const {body}=await readSource('s3',file_id,MAX_BYTES);
        if(body.length<1)throw new Error();
        objects.push({file_id,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});
      }
      return res.json({ok:true,objects,vapidPublicKey:String(env.VAPID_PUBLIC_KEY||'')});
    }catch(error){
      const allowed=new Set(['S3_NOT_CONFIGURED','AccessDenied','NoSuchKey','NoSuchBucket','InvalidAccessKeyId','SignatureDoesNotMatch','CredentialsProviderError','RequestTimeout']);
      const reason=allowed.has(error?.name)?error.name:allowed.has(error?.code)?error.code:'UNAVAILABLE';
      return res.status(409).json({ok:false,code:'MIGRATION_INVENTORY_REJECTED',reason});
    }
  });
  router.use((req,res,next)=>{
    const baseline=req.get('X-Medsi-Migration-Mode')==='baseline'&&env.MEDSI_NEXT_STAND==='1';
    if((!baseline&&req.get('X-Medsi-Migration-Freeze')!=='confirmed')||
       req.get('X-Medsi-Migration-Import')!=='confirmed'){
      return res.status(400).json({ok:false,code:'MIGRATION_CONFIRMATION_REQUIRED'});
    }
    next();
  });
  router.post('/',express.json({limit:'32mb',strict:true}),async(req,res)=>{
    const hmacKey=env.MEDSI_MIGRATION_AUDIT_KEY;
    try{
      const body=req.body;
      const baseline=req.get('X-Medsi-Migration-Mode')==='baseline'&&env.MEDSI_NEXT_STAND==='1';
      if(!body||(!baseline&&body.preliminary===true)||typeof body!=='object'||!body.streams||!Array.isArray(body.s3Objects)||
         !body.envelope||!storage?.configured||typeof sql!=='function'){
        return res.status(400).json({ok:false,code:'MIGRATION_PACKAGE_INVALID'});
      }
      for(const row of body.streams.parent_passkeys||[]){
        const value=row.public_key;
        if(value?.type==='Buffer'&&Array.isArray(value.data)&&value.data.length>0&&value.data.length<4096&&
          value.data.every(b=>Number.isInteger(b)&&b>=0&&b<=255))row.public_key=Buffer.from(value.data);
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
        {hmacKey,explicitImport:true,freezeConfirmed:!baseline,baselineImport:baseline,previousEnvelope:baseline?undefined:body.previousEnvelope});
      return res.json({ok:true,alreadyImported:result.alreadyImported,
        streams:result.streams,s3Objects:inventory.length,mode:baseline?'baseline':'frozen'});
    }catch(_){
      return res.status(409).json({ok:false,code:'MIGRATION_IMPORT_REJECTED'});
    }
  });
  return router;
}
