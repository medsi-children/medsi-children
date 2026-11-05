import {D1_SOURCE_TABLES} from './cloudflare-capture.mjs';
import {normalizeRosterCapture} from './roster-capture.mjs';
import {normalizeD1ParentProfiles,captureD1ProfileLinks} from './d1-profile-capture.mjs';
import {normalizeReportBaseline} from './report-baseline.mjs';
import {normalizeD1Reports} from './d1-report-capture.mjs';
import {partitionReportOwnership} from './report-ownership-partition.mjs';
import {normalizeD1ChatMessages,deriveD1ChatRelatedStreams} from './d1-chat-capture.mjs';
import {prepareChatMediaImport} from './chat-media-copy.mjs';
import {prepareD1OperationalCapture} from './d1-operational-capture.mjs';
import {prepareLegacyIdentityCapture} from '../app/identity-continuity.mjs';
import {prepareLegacyPushCapture} from '../app/push-continuity.mjs';
import {POSTGRES_STREAMS} from './postgres-manifests.mjs';
import {generateManifest,signManifestEnvelope} from '../app/migration-audit.mjs';
const invalid=()=>{throw new Error('Source package incomplete or inconsistent.');};

// Assemble normalized source-specific captures. No network calls and no output
// of private rows. Only the final frozen package is eligible for SQL import.
export function buildCapturePackage({captureId,cloudflare,roster,reportBaseline,mediaMapping,
  historicalLinks=[],sourceVapidPublicKey,targetVapidPublicKey},
  {hmacKey,freezeConfirmed}={}){
  if(freezeConfirmed!==true)throw new Error('Frozen source package required.');
  const tables=cloudflare?.tables;
  if(!tables||Object.keys(tables).length!==D1_SOURCE_TABLES.length||
     D1_SOURCE_TABLES.some(name=>!Array.isArray(tables[name])))invalid();
  const normalizedRoster=normalizeRosterCapture(roster?.children,roster?.admissions);
  const parents=normalizeD1ParentProfiles(tables.chat_profiles,
    captureD1ProfileLinks(tables.chat_profiles),normalizedRoster.admissions);
  const baseline=normalizeReportBaseline(reportBaseline);
  if(tables.report_publication_state.length!==baseline.report_publication_head.length||
     tables.report_publication_state.some(row=>!baseline.report_publication_head.some(head=>
       head.kind===row.kind&&head.publication_id===row.publication_id&&head.revision===String(row.revision))))invalid();
  const ownership=partitionReportOwnership({current:tables.report_current,history:tables.report_snapshots,
    profiles:parents,historicalLinks},hmacKey);
  const reports=normalizeD1Reports(ownership.current,ownership.history,parents,historicalLinks);
  const media=prepareChatMediaImport(tables.chat_messages,mediaMapping);
  const operational=prepareD1OperationalCapture(tables,hmacKey);
  const identities=prepareLegacyIdentityCapture({authProfiles:tables.parent_auth_profiles,
    passkeys:tables.parent_passkeys.map(row=>{
      const bytes=row.public_key;
      if(!(bytes instanceof Uint8Array)&&(!Array.isArray(bytes)||
        bytes.some(value=>!Number.isInteger(value)||value<0||value>255)))invalid();
      return {...row,public_key_base64url:Buffer.from(bytes).toString('base64url')};
    })},{expectedProfiles:tables.parent_auth_profiles.length,expectedPasskeys:tables.parent_passkeys.length});
  const parentPhones=new Set(parents.map(row=>row.phone10));
  if(identities.profiles.length!==parentPhones.size||
     identities.profiles.some(row=>!parentPhones.has(row.phone10)))invalid();
  const subscriptions=prepareLegacyPushCapture(cloudflare.pushEntries,{sourceVapidPublicKey,
    targetVapidPublicKey,expectedCount:cloudflare.pushEntries?.length});
  const streams={...normalizedRoster,parent_profiles:parents,...baseline,...reports,
    chat_messages:normalizeD1ChatMessages(media.messages),chat_media:media.chatMedia,
    ...deriveD1ChatRelatedStreams(media.messages,tables.chat_pins),...operational,
    parent_auth_profiles:identities.profiles.map(row=>({phone10:row.phone10,user_handle:row.userHandle,
      generation_id:row.generationId,created_at:String(row.createdAt)})),
    parent_passkeys:identities.keys.map(row=>({credential_id:row.credentialId,user_handle:row.userHandle,
      public_key:row.publicKey,counter:String(row.counter),transports_json:row.transportsJson,
      device_type:row.deviceType,backed_up:row.backedUp,created_at:String(row.createdAt),revoked_at:String(row.revokedAt)})),
    push_subscriptions:subscriptions.map(row=>({subscription_id:row.subscriptionId,role:row.role,
      phone10:row.phone10,subscription_json:row.subscriptionJson,enabled:row.enabled,
      disabled_reason:row.disabledReason,updated_at:String(row.updatedAt)}))};
  streams.background_jobs.push(...ownership.background_jobs);
  if(new Set(streams.background_jobs.map(row=>row.job_id)).size!==streams.background_jobs.length||
     Object.keys(streams).length!==POSTGRES_STREAMS.length||POSTGRES_STREAMS.some(name=>!Object.hasOwn(streams,name)))invalid();
  const envelope=signManifestEnvelope(captureId,[...POSTGRES_STREAMS.map(name=>generateManifest(name,streams[name],hmacKey)),
    generateManifest('s3_objects',media.s3Objects,hmacKey)],hmacKey);
  return {streams,envelope,s3Objects:media.s3Objects,summary:{parents:parents.length,
    messages:streams.chat_messages.length,quarantinedReports:ownership.background_jobs.length,
    archivedReportReceipts:tables.report_submission_queue.length}};
}
