import test from 'node:test';
import assert from 'node:assert/strict';
import {installSchema} from '../src/schema-cli.mjs';
import {connectPostgresNext} from '../src/connection.mjs';
import {POSTGRES_STREAMS} from '../src/postgres-manifests.mjs';
import {generateManifest,signManifestEnvelope} from '../app/migration-audit.mjs';
import {importFullCapture} from '../src/full-import.mjs';

test('full capture: signed atomic import, exact retry and rejection of tampering',{
  skip:process.env.CI==='true'&&process.env.PG_TEST_INSECURE_LOCAL==='1'?false:'Disposable CI PostgreSQL only.'
},async()=>{
  await installSchema({...process.env,PG_SCHEMA_CONFIRM:'CREATE_SCHEMA_IN_EMPTY_DATABASE'});
  const conn=await connectPostgresNext(process.env);
  try{
    const key='synthetic-audit-key-'.repeat(4);
    const streams=Object.fromEntries(POSTGRES_STREAMS.map(name=>[name,[]]));
    streams.children.push({child_id:'fictional_child',registered_first_name:'Test',surname:'Synthetic',created_at:'1000'});
    const s3=generateManifest('s3_objects',[],key);
    const source=signManifestEnvelope('synthetic_capture_001',[
      ...POSTGRES_STREAMS.map(name=>generateManifest(name,streams[name],key)),s3
    ],key);
    const options={hmacKey:key,explicitImport:true,freezeConfirmed:true};
    await assert.rejects(()=>importFullCapture(conn.sql,streams,source,s3,{...options,freezeConfirmed:false}),/frozen/);
    await assert.rejects(()=>importFullCapture(conn.sql,{...streams,children:[]},source,s3,options),/mismatch/);
    await assert.rejects(()=>importFullCapture(conn.sql,streams,{...source,signature:'0'.repeat(64)},s3,options),/mismatch/);
    const [before]=await conn.sql`SELECT * FROM children`;
    assert.equal(before.length,0);
    // Simulate a transport failure after an INSERT; the real adapter must roll
    // back every user stream, not leave a partially imported destination.
    const faulty={begin:(opts,fn)=>conn.sql.begin(opts,tx=>{
      const proxy=async(strings,...values)=>{
        const result=await tx(strings,...values);
        if(strings[0].startsWith('INSERT'))throw new Error('Synthetic interruption');
        return result;
      };
      proxy.identifier=tx.identifier;
      return fn(proxy);
    })};
    await assert.rejects(()=>importFullCapture(faulty,streams,source,s3,options),/Synthetic interruption/);
    const [rolledBack]=await conn.sql`SELECT * FROM children`;
    assert.equal(rolledBack.length,0);
    assert.deepEqual(await importFullCapture(conn.sql,streams,source,s3,options),{alreadyImported:false,streams:25});
    assert.deepEqual(await importFullCapture(conn.sql,streams,source,s3,options),{alreadyImported:true,streams:25});
    await conn.sql`UPDATE children SET surname=${'Changed'} WHERE child_id=${'fictional_child'}`;
    await assert.rejects(()=>importFullCapture(conn.sql,streams,source,s3,options),/populated/);
  }finally{await conn.driver.close();}
});
