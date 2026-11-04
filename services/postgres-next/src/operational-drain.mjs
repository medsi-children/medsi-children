import {generateManifest} from '../app/migration-audit.mjs';

export const DRAIN_STREAMS=Object.freeze([
  'chat_sessions','parent_auth_challenges','parent_deletion_queue',
  'parent_registration_attempts','parent_access_requests','push_outbox','background_jobs'
]);

// A quiescent capture is acceptable only when the operator has resolved all
// nonempty operational streams. An absent stream is never equivalent to empty.
export function captureDrainedOperationalManifests(capture,hmacKey){
  if(!capture||typeof capture!=='object'||Array.isArray(capture)||
     Object.keys(capture).length!==DRAIN_STREAMS.length){
    throw new Error('Explicit capture of every operational stream is required.');
  }
  return DRAIN_STREAMS.map(stream=>{
    if(!Object.hasOwn(capture,stream)||!Array.isArray(capture[stream])||capture[stream].length!==0){
      throw new Error('Operational stream is missing or requires a reviewed migration policy: '+stream);
    }
    return generateManifest(stream,[],hmacKey);
  });
}
