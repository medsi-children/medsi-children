import {createHash} from 'node:crypto';

// Compatibility responses for the existing mobile interfaces.
// No Google Apps Script, Cloudflare or other upstream is contacted.
const digits=value=>String(value||'').replace(/\D/g,'').slice(-10);
const PHONE=/^\d{10}$/;

export function createLegacyBridge({sessions,reportReader,chatOperations,reportSubmission,
  parentRegistration,parentAccess}) {
  if([sessions,reportReader,chatOperations,reportSubmission,parentRegistration,parentAccess].some(x=>!x)){
    throw new Error('NEXT compatibility services incomplete.');
  }
  const verifyParent=async(phone,token)=>{
    const claims=await sessions.verifyWorker(String(token||''));
    if(!claims||claims.role!=='parent'||claims.phone10!==phone||claims.preview){
      throw new Error('Unauthorized.');
    }
    return claims;
  };
  const verifyTutor=token=>{
    if(!sessions.verifyTutor(String(token||'')))throw new Error('Unauthorized.');
  };
  return async function legacy(method,args=[]) {
    if(!Array.isArray(args)||args.length>8)throw new Error('Invalid legacy arguments.');
    switch(String(method||'')){
      case 'verifyTutorAccess':{
        return sessions.loginTutor(String(args[0]||''),String(args[1]||''));
      }
      case 'verifyTutorSession':{
        if(!sessions.verifyTutor(String(args[0]||'')))return {ok:false};
        return sessions.renewTutor(String(args[0]||''));
      }
      case 'getD1ChatSession':{
        const role=String(args[0]||'');
        if(role==='parent'){
          const phone=digits(args[1]);if(!PHONE.test(phone))throw new Error('Invalid phone.');
          const claims=await sessions.verifyWorker(String(args[2]||''));
          if(!claims||claims.role!=='parent'||claims.phone10!==phone)return {ok:false};
          // Reuse a validated signed token, preserving preview-only restrictions.
          return {ok:true,session:{token:String(args[2]),expiresAt:Number(claims.exp)}};
        }
        if(role==='educator'){
          verifyTutor(args[2]);return {ok:true,session:sessions.issueEducator()};
        }
        throw new Error('Invalid session role.');
      }
      case 'getParentBootstrap':{
        const phone=digits(args[0]);if(!PHONE.test(phone))throw new Error('Invalid phone.');
        const claims=await sessions.verifyWorker(String(args[1]||''));
        if(!claims||claims.role!=='parent'||claims.phone10!==phone)return {ok:false,code:'NOT_FOUND'};
        const profile=await reportReader.profile(phone);
        if(!profile.ok)return {ok:false,code:'NOT_FOUND'};
        const session={token:String(args[1]),expiresAt:Number(claims.exp)};
        return {ok:true,phone:'8'+phone,parentName:profile.parentName,
          childName:profile.childName,parentSession:session.token,d1Session:{ok:true,...session}};
      }
      case 'mirrorCloudflareParentRegistration':{
        const phone=digits(args[0]);
        if(!PHONE.test(phone))throw new Error('Invalid phone.');
        await verifyParent(phone,args[2]);
        // Registration is already persisted in the NEXT database. There is no longer an
        // outbox to Google Sheets, contacts sync, or Cloudflare mirror.
        return {ok:true,synced:true,source:'postgres'};
      }
      case 'markEducatorMessagesAsRead':{
        const phone=digits(args[0]);await verifyParent(phone,args[1]);
        return chatOperations.markRead('parent',phone);
      }
      case 'markReportAsRead':{
        const phone=digits(args[0]);await verifyParent(phone,args[3]);
        return reportReader.markRead(phone,String(args[1]||''),String(args[2]||''));
      }
      case 'listAvailableParentsForChat':{
        verifyTutor(args[0]);return chatOperations.listParents();
      }
      case 'listPendingParentReauthorizations':{
        verifyTutor(args[0]);return parentAccess.listPending();
      }
      case 'decideParentReauthorization':{
        verifyTutor(args[2]);
        return parentAccess.decide({requestId:String(args[0]||''),decision:String(args[1]||'')});
      }
      case 'getParentRegistrationStatus':
        return parentRegistration.status({phone:args[0],attemptId:args[1]});
      case 'appendReport':{
        // Some previously installed psychology clients use this call after a
        // transient response failure. Process it locally and idempotently;
        // never forward clinical text to Google Apps Script.
        const payload=args[0];
        verifyTutor(args[1]);
        if(!payload||typeof payload!=='object'||Array.isArray(payload)) {
          throw new Error('Invalid report submission.');
        }
        const kind=String(payload.reportType||'');
        const rawText=String(payload.text||'');
        const submissionId=String(payload.submissionId||'');
        if(!['morning','evening','psychology'].includes(kind)||
           !/^[A-Za-z0-9_-]{8,128}$/.test(submissionId)||
           !rawText.trim()||rawText.length>240000) {
          throw new Error('Invalid report submission.');
        }
        const authorId='educator_'+createHash('sha256')
          .update(String(args[1])).digest('hex').slice(0,20);
        const response=await reportSubmission.submit({
          kind,rawText,submissionId,authorId
        });
        return {ok:true,processing:false,status:'completed',result:response};
      }
      case 'getReportSubmissionStatus':{
        verifyTutor(args[1]);
        return reportSubmission.status(String(args[0]||''));
      }
      // Any old write flow not explicitly implemented must fail closed.
      default:
        throw new Error('Unsupported legacy operation.');
    }
  };
}
