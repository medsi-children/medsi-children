import express from 'express';
import {createHash} from 'node:crypto';

// Mount ONLY inside the independent test application until approved cutover.
// app.use('/lab', createNextLabRouter(services)) is intentionally absent from
// production server.js, so no live users can accidentally reach this code.
export function createNextLabRouter({sessions,chatStore,chatOperations,reportReader,reports,dashboard,roster,reportEdits,nameVariants,passkeys,parentRegistration,parentAccess,parentDeletion,push}) {
  const services=[sessions,chatStore,chatOperations,reportReader,reports,dashboard,nameVariants,passkeys,parentRegistration,parentAccess,parentDeletion,push];
  if(services.some(x=>!x))throw new Error('NEXT requires all protected services before mounting.');
  const router=express.Router();
  router.use(express.json({limit:'1mb'}));
  router.use((req,res,next)=>{res.setHeader('cache-control','no-store');next()});

  const run=handler=>async (req,res)=>{
    try {
      const result=await handler(req,res);
      if(!res.headersSent&&result!==undefined)return res.json(result);
    }catch(error) {
      const safe=String(error?.message||'');
      if(safe==='Parent deletion temporarily disabled until migration audit.'){
        if(!res.headersSent)return res.status(423).json({
          ok:false,code:'PARENT_DELETION_DISABLED',
          message:'Удаление временно отключено до завершения проверки переноса данных.'
        });
        return;
      }
      // Never echo internal/PostgreSQL exception bodies or medical report contents.
      const known=/^(Invalid |Unsupported |Bad |Forbidden|Unauthorized|Only own |Reply target|Chat is closed|Message not found|Subscription belongs|Report blocked|Parent roster changed|Report ownership changed)/.test(safe);
      if(!res.headersSent)return res.status(known?400:503).json({
        ok:false,message:known?safe:'Операция временно недоступна. Повторите позже.'
      });
    }
  };
  const authenticate=async(req,res,role)=>{
    const token=String(req.get('X-Medsi-Chat-Session')||'');
    const auth=await sessions.verifyWorker(token);
    if(!auth||(role&&auth.role!==role)) {
      res.status(401).json({ok:false,message:'Требуется вход в систему.'});
      return null;
    }
    return auth;
  };
  const readParent=async(req,res)=>{
    const auth=await authenticate(req,res,'parent');
    return auth;
  };
  const educator=async(req,res)=>authenticate(req,res,'educator');
  const owner=async(req,res,rawPhone)=>{
    const auth=await authenticate(req,res);
    if(!auth)return null;
    const phone=String(rawPhone||'').replace(/\D/g,'').slice(-10);
    if(!/^\d{10}$/.test(phone)||(auth.role==='parent'&&phone!==auth.phone10)) {
      res.status(403).json({ok:false,message:'Недостаточно прав.'});return null;
    }
    return {auth,phone};
  };
  const rejectPreview=(auth,res)=>{
    if(auth?.preview){res.status(403).json({ok:false,message:'Предварительный просмотр только для чтения.'});return true}
    return false;
  };
  // Preserve the current parent-facing registration and login contract.
  // There are no new educator approval screens or manual admission selectors.
  const publicRequests=new Map();
  const publicLimit=(req,res,next)=>{
    const now=Date.now(),key=String(req.ip||req.socket?.remoteAddress||'unknown');
    if(publicRequests.size>5000){
      for(const [k,v] of publicRequests)if(v.expires<=now)publicRequests.delete(k);
      if(publicRequests.size>5000)publicRequests.clear();
    }
    const prior=publicRequests.get(key);
    const item=prior&&prior.expires>now?prior:{count:0,expires:now+60000};
    item.count++;publicRequests.set(key,item);
    if(item.count>45)return res.status(429).json({ok:false,message:'Слишком много запросов. Повторите позже.'});
    next();
  };
  router.use(['/parent-registration','/parent-auth/request',
    '/parent-auth/status','/parent-passkeys/authentication/options',
    '/parent-passkeys/authentication/verify'],publicLimit);

  router.post('/parent-registration',run(req=>parentRegistration.register(req.body||{})));
  router.get('/parent-registration/status',run(req=>parentRegistration.status(req.query||{})));
  router.post('/parent-auth/request',run(req=>parentAccess.request(req.body||{})));
  router.post('/parent-auth/status',run(req=>parentAccess.status(req.body||{})));
  router.post('/parent-delete',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return parentDeletion.enqueue(req.body||{});
  }));
  router.post('/admin/roster/remove-unlinked-child',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return parentDeletion.removeChildWithoutParents(req.body||{});
  }));
  router.get('/parent-delete/status',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return parentDeletion.status(req.query.operationId);
  }));
  router.get('/parent-delete/pending',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return parentDeletion.pending();
  }));
  router.post('/parent-delete/retry',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return parentDeletion.retry(req.body?.operationId);
  }));
  router.post('/parent-passkeys/authentication/options',run(async()=>{
    return passkeys.authenticationOptions();
  }));
  router.post('/parent-passkeys/authentication/verify',run(async(req)=>{
    return passkeys.authenticationVerify(req.body||{});
  }));
  router.post('/parent-passkeys/status',run(async(req,res)=>{
    const auth=await readParent(req,res);if(!auth)return;
    return passkeys.hasPasskey(auth.phone10);
  }));
  router.post('/parent-passkeys/registration/options',run(async(req,res)=>{
    const auth=await readParent(req,res);if(!auth)return;
    if(rejectPreview(auth,res))return;
    return passkeys.registrationOptions(auth.phone10);
  }));
  router.post('/parent-passkeys/registration/verify',run(async(req,res)=>{
    const auth=await readParent(req,res);if(!auth)return;
    if(rejectPreview(auth,res))return;
    return passkeys.registrationVerify(auth.phone10,req.body||{});
  }));
  router.post('/parent-session/renew',run(async(req,res)=>{
    const auth=await readParent(req,res);if(!auth)return;
    if(rejectPreview(auth,res))return;
    const session=await sessions.issueParent(auth.phone10);
    return {ok:true,parentSession:session.token,expiresAt:session.expiresAt};
  }));
  router.get('/admin/reports/dashboard',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return dashboard.readForEducator();
  }));
  router.get('/admin/roster',run(async(req,res)=>{
    if(!await educator(req,res))return;
    if(typeof roster?.list!=='function')throw new Error('Roster unavailable.');
    return roster.list();
  }));
  router.post('/admin/roster/edit',run(async(req,res)=>{
    if(!await educator(req,res))return;
    if(typeof roster?.update!=='function')throw new Error('Roster unavailable.');
    return roster.update(req.body||{});
  }));
  router.post('/admin/reports/raw',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return reports.submit({...req.body,rawText:req.body.text,authorId:'educator_edit',correctionOf:req.body.publicationId});
  }));
  router.post('/admin/reports/edit',run(async(req,res)=>{
    if(!await educator(req,res))return;
    if(!reportEdits?.update)throw new Error('Report edit service unavailable.');
    return reportEdits.update(req.body||{});
  }));
  router.get('/admin/name-variants',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return nameVariants.list();
  }));
  router.put('/admin/name-variants',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return nameVariants.replaceAll(req.body);
  }));
  router.post('/admin/name-variants',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return nameVariants.save(req.body);
  }));
  router.delete('/admin/name-variants/:baseKey',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return nameVariants.remove(req.params.baseKey);
  }));
  router.get('/parents',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return chatOperations.listParents();
  }));
  router.get('/chats',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return chatOperations.listChats(String(req.query.bucket||'all'));
  }));
  router.get('/threads/:phone',run(async(req,res)=>{
    if(!await owner(req,res,req.params.phone))return;
    return chatOperations.thread(req.params.phone,req.query.before,req.query.limit);
  }));
  router.post('/messages',run(async(req,res)=>{
    const authorized=await owner(req,res,req.body?.phone);
    if(!authorized)return;
    if(rejectPreview(authorized.auth,res))return;
    if(req.body?.side && req.body.side!==authorized.auth.role)return res.status(403).json({ok:false,message:'Недостаточно прав.'});
    const message={...req.body,phone10:authorized.phone,side:authorized.auth.role};
    const result=await chatStore.send(message);
    return {ok:true,duplicate:result.status==='duplicate',
      message:{messageKey:result.messageKey,phone:authorized.phone,side:authorized.auth.role,
        type:message.type||'text',text:message.text||'',fileId:message.fileId||'',
        reply:message.replyToKey?{messageKey:message.replyToKey}:null,
        timestamp:result.timestamp||Date.now()}};
  }));
  router.post('/read/:phone',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return chatOperations.markRead('educator',req.params.phone,false);
  }));
  router.post('/unread/:phone',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return chatOperations.markRead('educator',req.params.phone,true);
  }));
  router.post('/read-parent/:phone',run(async(req,res)=>{
    // Only the actual parent can acknowledge their own incoming messages.
    // Educator preview is read-only and staff cannot modify a parent's read state.
    const auth=await readParent(req,res);if(!auth)return;
    if(rejectPreview(auth,res))return;
    const phone=String(req.params.phone||'').replace(/\D/g,'').slice(-10);
    if(!/^\d{10}$/.test(phone)||auth.phone10!==phone){
      return res.status(403).json({ok:false,message:'Недостаточно прав.'});
    }
    return chatOperations.markRead('parent',phone);
  }));
  router.post('/pin/:phone',run(async(req,res)=>{
    if(!await educator(req,res))return;
    return chatOperations.pin(req.params.phone,String(req.body?.bucket||''));
  }));
  for(const kind of ['reaction','edit','delete']) {
    router.post('/'+kind+'/:messageKey',run(async(req,res)=>{
      const auth=await authenticate(req,res);if(!auth)return;
      if(rejectPreview(auth,res))return;
      return chatOperations.mutate(kind,req.params.messageKey,auth,req.body||{});
    }));
  }
  router.get('/profile',run(async(req,res)=>{
    const auth=await readParent(req,res);if(!auth)return;
    return reportReader.profile(auth.phone10);
  }));
  router.get('/report-current',run(async(req,res)=>{
    const auth=await readParent(req,res);if(!auth)return;
    return reportReader.current(auth.phone10);
  }));
  router.get('/report-history',run(async(req,res)=>{
    const auth=await readParent(req,res);if(!auth)return;
    return reportReader.history(auth.phone10);
  }));
  router.get('/parent-unread',run(async(req,res)=>{
    const auth=await readParent(req,res);if(!auth)return;
    const [chat,report]=await Promise.all([
      chatOperations.parentUnread(auth.phone10),reportReader.unread(auth.phone10)
    ]);
    return {ok:true,hasUnread:Boolean(chat.hasUnread),reportUnread:report.reportUnread||{}};
  }));
  router.post('/report-read',run(async(req,res)=>{
    const auth=await readParent(req,res);if(!auth)return;
    if(rejectPreview(auth,res))return;
    return reportReader.markRead(auth.phone10,String(req.body?.kind||''),String(req.body?.version||''));
  }));
  router.post('/parent-preview',run(async(req,res)=>{
    if(!await educator(req,res))return;
    const phone=String(req.body?.phone||'').replace(/\D/g,'').slice(-10);
    if(!/^\d{10}$/.test(phone))throw new Error('Invalid parent phone.');
    const profile=await reportReader.profile(phone);
    if(!profile.ok)return res.status(404).json(profile);
    const expiresAt=Date.now()+15*60*1000;
    const session=await sessions.issueParent(phone,expiresAt,{preview:true});
    return {ok:true,phone,parentName:profile.parentName,childName:profile.childName,
      parentSession:session.token,expiresAt};
  }));
  router.post('/report-submit',run(async(req,res)=>{
    const auth=await educator(req,res);if(!auth)return;
    const token=String(req.get('X-Medsi-Chat-Session')||'');
    const authorId='educator_'+createHash('sha256').update(token).digest('hex').slice(0,20);
    const {text,reportType,submissionId}=req.body||{};
    const result=await reports.submit({kind:reportType,rawText:text,submissionId,authorId});
    return {ok:true,accepted:true,submissionId,status:'completed',result};
  }));
  router.get('/report-submit/status',run(async(req,res)=>{
    if(!await educator(req,res))return;
    const submissionId=String(req.query.submissionId||'');
    const result=await reports.status(submissionId);
    return {ok:true,submissionId,...result};
  }));

  // Unimplemented operations MUST fail closed, never use foreign backends.
  router.use((_req,res)=>res.status(404).json({ok:false,message:'Маршрут новой системы пока не подключён.'}));
  return router;
}
