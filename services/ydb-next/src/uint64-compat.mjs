// PostgreSQL NEXT compatibility for existing NEXT numeric service contracts.
// Values are converted into BIGINT parameters by the PostgreSQL adapter.
// YDB-specific SDK/runtime is intentionally not imported on the Timeweb path.
export class Uint64 {
  constructor(value) {
    const n=BigInt(value);
    if(n<0n||n>18446744073709551615n)throw new Error('Invalid unsigned 64-bit value.');
    this.value=n;
  }
  toString(){return this.value.toString();}
}
