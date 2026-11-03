// Isolated branch-only runtime. Never import the legacy server in this mode.
import {startIsolatedStand} from './stand-server.mjs';
try {
  await startIsolatedStand();
}catch(_error) {
  // Do not log secrets, connection strings or patient-related exception bodies.
  console.error('MEDSI_NEXT_STAND_START_FAILED: check YDB config and isolated environment.');
  process.exitCode=1;
}
