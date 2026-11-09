// Reusable deletion step for the EXISTING registered-parent deletion queue.
// A child has no independent patient/admission lifetime in the bot:
// its row disappears once no parent profile references it.
export async function purgeCurrentRegisteredChild(tx,childId,now=Date.now()){
  const id=String(childId||'');
  if(!id)return false;
  const [parents]=await tx`SELECT phone10 FROM parent_profiles WHERE child_id=${id}`;
  if(parents.length)return false;
  const [owners]=await tx`SELECT owner_key,record_json FROM report_ownership
    WHERE owner_key LIKE ${'CURRENT_BLOCK_%'}`;
  for(const owner of owners){
    let record;
    try{record=JSON.parse(owner.record_json)}catch{continue}
    if(String(record?.childId||'')!==id)continue;
    // A minimal non-identifying quarantine prevents the exact old source
    // block from being claimed by a new namesake on the same day.
    await tx`UPDATE report_ownership SET
      record_json=${JSON.stringify({blocked:true})},updated_at=${BigInt(now)}
      WHERE owner_key=${owner.owner_key}`;
  }
  await tx`DELETE FROM parent_current_reports WHERE child_id=${id}`;
  await tx`DELETE FROM parent_report_history WHERE child_id=${id}`;
  await tx`DELETE FROM parent_registration_attempts WHERE child_id=${id}`;
  await tx`DELETE FROM children WHERE child_id=${id}`;
  return true;
}
