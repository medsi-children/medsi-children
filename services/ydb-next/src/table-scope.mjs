// A single YDB can host independent NEXT test/live directories.
// Never interpolate an operator-supplied identifier into YQL.
export const NEXT_YDB_SCOPES=Object.freeze(['medsi_next_test','medsi_next_live']);
export function validateTableScope(scope,{stand=false}={}) {
  if(!NEXT_YDB_SCOPES.includes(scope))throw new Error('Unrecognized YDB table scope.');
  if(stand&&scope!=='medsi_next_test')throw new Error('Isolated stand may only use YDB test tables.');
  return scope;
}

export function withTableScope(sql,scope,{stand=false}={}) {
  const path=validateTableScope(scope,{stand});
  if(typeof sql!=='function'||typeof sql.begin!=='function') {
    throw new Error('YDB scoped query client unavailable.');
  }
  const pragma='PRAGMA TablePathPrefix = "'+path+'";\n';
  const wrap=(tag)=>{
    const scoped=(parts,...values)=>{
      if(!Array.isArray(parts)||typeof parts[0]!=='string') {
        throw new Error('Only tagged YQL templates are supported.');
      }
      const statements=[pragma+parts[0],...parts.slice(1)];
      const raw=Array.isArray(parts.raw)?parts.raw:parts;
      Object.defineProperty(statements,'raw',{value:[pragma+raw[0],...raw.slice(1)]});
      return tag(statements,...values);
    };
    for(const name of ['identifier','unsafe']){
      if(typeof tag[name]==='function')scoped[name]=tag[name].bind(tag);
    }
    return scoped;
  };
  const scoped=wrap(sql);
  scoped.begin=(options,callback)=>{
    if(typeof callback!=='function')throw new Error('Scoped transaction callback required.');
    return sql.begin(options,(tx,...rest)=>callback(wrap(tx),...rest));
  };
  return scoped;
}
