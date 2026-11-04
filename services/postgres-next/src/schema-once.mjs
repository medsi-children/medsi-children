import {spawn} from 'node:child_process';
import {installSchema} from './schema-cli.mjs';

const env=process.env;
if(env.MEDSI_NEXT_STAND==='1' && env.PGHOST==='192.168.0.4' &&
   env.PGDATABASE==='default_db' && env.PGUSER==='gen_user'){
  try{
    const result=await installSchema({...env,PG_SCHEMA_CONFIRM:'CREATE_SCHEMA_IN_EMPTY_DATABASE'});
    console.log('MEDSI_PG_SCHEMA_INSTALLED tables='+result.tables+' indexes='+result.indexes);
  }catch(_){
    console.error('MEDSI_PG_SCHEMA_NOT_INSTALLED');
  }
}else{
  console.error('MEDSI_PG_SCHEMA_TARGET_MISMATCH');
}
const app=spawn(process.execPath,['server.js'],{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.kill(signal));
app.once('exit',code=>{process.exitCode=code??1;});
