import {generateManifest, REQUIRED_STREAMS} from '../app/migration-audit.mjs';

export const POSTGRES_STREAMS=Object.freeze(REQUIRED_STREAMS.filter(stream=>stream!=='s3_objects'));

// Use one consistent, read-only snapshot. Raw rows stay in memory and only
// aggregate keyed digests leave this function.
export async function capturePostgresManifests(sql, hmacKey) {
  return sql.begin({isolation:'snapshotReadOnly'}, async tx=>{
    const manifests=[];
    for(const stream of POSTGRES_STREAMS){
      const [rows]=await tx`SELECT * FROM public.${tx.identifier(stream)}`;
      manifests.push(generateManifest(stream,rows,hmacKey));
    }
    return manifests;
  });
}
